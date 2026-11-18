import {
  ContainerSummary,
  EmptySpaceBox,
  LoadingDirection,
  LoadingSpace,
  OptimizationMode,
  OptimizationResult,
  OptimizationWarning,
  PackageSpec,
  PlacedPackage,
  StrategyBenchmark,
  UnloadedPackageReason,
  UnloadedReasonCode,
} from '../types/packvol';
import { verifyPackingSolution } from './verifier';

const EPS = 0.02; // 0.02 mm tolerance

export interface Orientation {
  dx: number; // X (length)
  dy: number; // Y (height)
  dz: number; // Z (width)
  label: string;
}

interface PackItem {
  spec: PackageSpec;
  unitIndex: number;
  volume: number;
  baseArea: number;
  orientations: Orientation[];
}

interface Point3D {
  x: number;
  y: number;
  z: number;
}

interface FreeBox {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
}

interface PlacedInternal extends PlacedPackage {
  currentLoadAbove: number;
  currentLayersAbove: number;
  supporters: { idx: number; share: number }[];
  spec: PackageSpec;
}

export interface OptimizeOptions {
  space: LoadingSpace;
  spaces?: LoadingSpace[];
  packages: PackageSpec[];
  mode: OptimizationMode;
  allowRotation: boolean;
  loadingDirection: LoadingDirection;
  targetUtilizationPct?: number;
  autoDetermineContainers?: boolean;
  preferKeepItemSameContainer?: boolean;
  onProgress?: (pct: number, stage: string) => void;
  shouldCancel?: () => boolean;
}

function overlap1D(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

export function getAllowedOrientations(
  spec: PackageSpec,
  allowGlobalRotation: boolean,
  space: LoadingSpace,
  loadingDirection: LoadingDirection
): Orientation[] {
  const { length: L, width: W, height: H } = spec;
  const candidates: Orientation[] = [{ dx: L, dy: H, dz: W, label: 'L×W×H' }];

  if (allowGlobalRotation && spec.rotatable) {
    const axes = spec.allowedAxes ?? { x: true, y: true, z: true };
    if (axes.y) {
      candidates.push({ dx: W, dy: H, dz: L, label: 'W×L×H' });
    }
    if (!spec.thisSideUp) {
      if (axes.x) {
        candidates.push({ dx: L, dy: W, dz: H, label: 'L×H×W' });
        if (axes.y) candidates.push({ dx: H, dy: W, dz: L, label: 'H×L×W' });
      }
      if (axes.z) {
        candidates.push({ dx: H, dy: L, dz: W, label: 'H×W×L' });
        if (axes.y) candidates.push({ dx: W, dy: L, dz: H, label: 'W×H×L' });
      }
    }
  }

  const seen = new Set<string>();
  const valid: Orientation[] = [];
  for (const o of candidates) {
    const key = `${o.dx.toFixed(2)}_${o.dy.toFixed(2)}_${o.dz.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (
      o.dx > space.internalLength + EPS ||
      o.dy > space.internalHeight + EPS ||
      o.dz > space.internalWidth + EPS
    ) {
      continue;
    }

    if (loadingDirection === 'rear') {
      if (o.dz > space.doorWidth + EPS || o.dy > space.doorHeight + EPS) continue;
    } else if (loadingDirection === 'side') {
      if (o.dx > space.doorWidth + EPS || o.dy > space.doorHeight + EPS) continue;
    }

    valid.push(o);
  }
  return valid;
}

class ContainerState {
  placed: PlacedInternal[] = [];
  extremePoints: Point3D[] = [{ x: 0, y: 0, z: 0 }];
  epKeys = new Set<string>(['0_0_0']);
  freeBoxes: FreeBox[] = [];
  totalWeight = 0;
  occupiedVolume = 0;
  weightedX = 0;
  weightedY = 0;
  weightedZ = 0;
  wallKeys = new Set<string>();
  minAllowedDim = 50;

  constructor(
    public space: LoadingSpace,
    public containerIndex: number,
    minAllowedDim = 50
  ) {
    this.minAllowedDim = Math.max(20, minAllowedDim);
    this.freeBoxes = [
      {
        x: 0,
        y: 0,
        z: 0,
        dx: space.internalLength,
        dy: space.internalHeight,
        dz: space.internalWidth,
      },
    ];
  }

  get spaceVolume(): number {
    return this.space.internalLength * this.space.internalWidth * this.space.internalHeight;
  }

  canPlaceAt(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    spec: PackageSpec
  ): { ok: boolean; supporters: { idx: number; share: number }[]; supportedAreaPct: number } {
    const { internalLength: L, internalWidth: W, internalHeight: H } = this.space;

    if (
      x < -EPS ||
      y < -EPS ||
      z < -EPS ||
      x + dx > L + EPS ||
      y + dy > H + EPS ||
      z + dz > W + EPS
    ) {
      return { ok: false, supporters: [], supportedAreaPct: 0 };
    }

    if (this.totalWeight + spec.weight > this.space.maxPayload + 0.01) {
      return { ok: false, supporters: [], supportedAreaPct: 0 };
    }

    if (y <= EPS && this.space.floorWeightLimit && this.space.floorWeightLimit > 0) {
      const footprintM2 = (dx / 1000) * (dz / 1000);
      if (footprintM2 > 0 && spec.weight / footprintM2 > this.space.floorWeightLimit + 0.1) {
        return { ok: false, supporters: [], supportedAreaPct: 0 };
      }
    }

    const directSupporters: { idx: number; area: number }[] = [];
    let supportedArea = 0;
    let minSupX = Infinity;
    let maxSupX = -Infinity;
    let minSupZ = Infinity;
    let maxSupZ = -Infinity;

    for (let i = 0; i < this.placed.length; i++) {
      const b = this.placed[i];

      if (y + dy <= b.y + EPS) continue;

      // Fast X separation reject before Y/Z overlap checks
      if (b.x >= x + dx - EPS || b.x + b.dx <= x + EPS) continue;
      if (b.z >= z + dz - EPS || b.z + b.dz <= z + EPS) continue;

      if (y >= b.y + b.dy - EPS) {
        if (y > EPS && Math.abs(b.y + b.dy - y) <= 0.5) {
          const ox = Math.min(x + dx, b.x + b.dx) - Math.max(x, b.x);
          const oz = Math.min(z + dz, b.z + b.dz) - Math.max(z, b.z);
          if (ox > EPS && oz > EPS) {
            if (!b.stackable) {
              return { ok: false, supporters: [], supportedAreaPct: 0 };
            }
            if (b.fragile && !spec.fragile) {
              return { ok: false, supporters: [], supportedAreaPct: 0 };
            }
            const area = ox * oz;
            supportedArea += area;
            directSupporters.push({ idx: i, area });
            minSupX = Math.min(minSupX, Math.max(x, b.x));
            maxSupX = Math.max(maxSupX, Math.min(x + dx, b.x + b.dx));
            minSupZ = Math.min(minSupZ, Math.max(z, b.z));
            maxSupZ = Math.max(maxSupZ, Math.min(z + dz, b.z + b.dz));
          }
        }
        continue;
      }

      // If we reach here, y < b.y + b.dy - EPS, y + dy > b.y + EPS, and X & Z overlap > EPS -> collision
      return { ok: false, supporters: [], supportedAreaPct: 0 };
    }

    if (y <= EPS) {
      return { ok: true, supporters: [], supportedAreaPct: 100 };
    }

    const baseArea = dx * dz;
    const supportedRatio = baseArea > 0 ? supportedArea / baseArea : 0;
    if (supportedRatio < 0.68) {
      return { ok: false, supporters: [], supportedAreaPct: supportedRatio * 100 };
    }

    const cx = x + dx / 2;
    const cz = z + dz / 2;
    if (
      cx < minSupX - dx * 0.08 ||
      cx > maxSupX + dx * 0.08 ||
      cz < minSupZ - dz * 0.08 ||
      cz > maxSupZ + dz * 0.08
    ) {
      return { ok: false, supporters: [], supportedAreaPct: supportedRatio * 100 };
    }

    const shares = directSupporters.map((s) => ({
      idx: s.idx,
      share: supportedArea > 0 ? s.area / supportedArea : 1 / directSupporters.length,
    }));

    if (!this.checkAncestorStackLimits(shares, spec.weight, 1)) {
      return { ok: false, supporters: [], supportedAreaPct: supportedRatio * 100 };
    }

    return {
      ok: true,
      supporters: shares,
      supportedAreaPct: Math.min(100, Math.round(supportedRatio * 1000) / 10),
    };
  }

  private checkAncestorStackLimits(
    supporters: { idx: number; share: number }[],
    addedWeight: number,
    addedLayers: number
  ): boolean {
    for (const s of supporters) {
      const b = this.placed[s.idx];
      const deltaW = addedWeight * s.share;
      if (b.spec.maxStackWeight > 0 && b.currentLoadAbove + deltaW > b.spec.maxStackWeight + 0.1) {
        return false;
      }
      if (b.spec.maxStackLayers > 0 && addedLayers > b.spec.maxStackLayers) {
        return false;
      }
      if (b.y <= EPS && this.space.floorWeightLimit && this.space.floorWeightLimit > 0) {
        const footM2 = (b.dx / 1000) * (b.dz / 1000);
        if (footM2 > 0 && (b.weight + b.currentLoadAbove + deltaW) / footM2 > this.space.floorWeightLimit + 0.1) {
          return false;
        }
      }
      if (b.supporters.length > 0) {
        if (!this.checkAncestorStackLimits(b.supporters, deltaW, addedLayers + 1)) {
          return false;
        }
      }
    }
    return true;
  }

  private propagateStackLoad(
    supporters: { idx: number; share: number }[],
    addedWeight: number,
    depth: number
  ): void {
    for (const s of supporters) {
      const b = this.placed[s.idx];
      const deltaW = addedWeight * s.share;
      b.currentLoadAbove += deltaW;
      b.currentLayersAbove = Math.max(b.currentLayersAbove, depth);
      if (b.supporters.length > 0) {
        this.propagateStackLoad(b.supporters, deltaW, depth + 1);
      }
    }
  }

  computeDropY(x: number, z: number, dx: number, dz: number): number {
    let maxY = 0;
    for (const b of this.placed) {
      if (overlap1D(x, x + dx, b.x, b.x + b.dx) > EPS && overlap1D(z, z + dz, b.z, b.z + b.dz) > EPS) {
        maxY = Math.max(maxY, b.y + b.dy);
      }
    }
    return Math.round(maxY * 100) / 100;
  }

  commitPlacement(
    x: number,
    y: number,
    z: number,
    o: Orientation,
    spec: PackageSpec,
    supporters: { idx: number; share: number }[],
    supportedAreaPct: number,
    loadingDirection: LoadingDirection = 'rear',
    instanceIdOverride?: string
  ): PlacedInternal {
    let maxSupLayer = -1;
    for (const s of supporters) {
      maxSupLayer = Math.max(maxSupLayer, this.placed[s.idx].layerIndex);
    }

    const placedBox: PlacedInternal = {
      instanceId:
        instanceIdOverride ?? `${spec.sku}-${this.containerIndex + 1}-${this.placed.length + 1}`,
      packageId: spec.id,
      sku: spec.sku,
      name: spec.name,
      category: spec.category,
      color: spec.color,
      containerIndex: this.containerIndex,
      stepIndex: this.placed.length + 1,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      z: Math.round(z * 100) / 100,
      dx: o.dx,
      dy: o.dy,
      dz: o.dz,
      weight: spec.weight,
      orientationLabel: o.label,
      layerIndex: y <= EPS ? 0 : maxSupLayer + 1,
      fragile: spec.fragile,
      stackable: spec.stackable,
      thisSideUp: spec.thisSideUp,
      supportedAreaPct,
      currentLoadAbove: 0,
      currentLayersAbove: 0,
      supporters,
      spec,
    };

    this.placed.push(placedBox);
    if (supporters.length > 0) {
      this.propagateStackLoad(supporters, spec.weight, 1);
    }

    this.totalWeight += spec.weight;
    this.occupiedVolume += o.dx * o.dy * o.dz;
    this.weightedX += spec.weight * (x + o.dx / 2);
    this.weightedY += spec.weight * (y + o.dy / 2);
    this.weightedZ += spec.weight * (z + o.dz / 2);
    const rx = Math.round(x / 5);
    const rdx = Math.round(o.dx / 5);
    const rz = Math.round(z / 5);
    const rdz = Math.round(o.dz / 5);
    this.wallKeys.add(`R:${rx}_${rdx}`);
    this.wallKeys.add(`S:${rz}_${rdz}`);

    this.updateExtremePoints(x, y, z, o.dx, o.dy, o.dz, loadingDirection);
    this.updateFreeBoxes(x, y, z, o.dx, o.dy, o.dz);
    return placedBox;
  }

  private addEP(pt: Point3D): void {
    const L = this.space.internalLength;
    const H = this.space.internalHeight;
    const W = this.space.internalWidth;
    const minD = this.minAllowedDim;

    if (pt.x < -EPS || pt.y < -EPS || pt.z < -EPS) return;
    const cx = Math.max(0, Math.round(pt.x * 100) / 100);
    const cy = Math.max(0, Math.round(pt.y * 100) / 100);
    const cz = Math.max(0, Math.round(pt.z * 100) / 100);

    // Prune dead points that cannot fit even the smallest package dimension
    if (L - cx < minD - EPS || H - cy < minD - EPS || W - cz < minD - EPS) return;

    const key = `${Math.round(cx)}_${Math.round(cy)}_${Math.round(cz)}`;
    if (!this.epKeys.has(key)) {
      this.epKeys.add(key);
      this.extremePoints.push({ x: cx, y: cy, z: cz });
    }
  }

  private updateExtremePoints(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    loadingDirection: LoadingDirection
  ): void {
    // Filter out points strictly inside newly placed box or completely occluded
    const nextEPs: Point3D[] = [];
    this.epKeys.clear();
    for (const p of this.extremePoints) {
      if (
        p.x >= x - EPS &&
        p.x < x + dx - EPS &&
        p.y >= y - EPS &&
        p.y < y + dy - EPS &&
        p.z >= z - EPS &&
        p.z < z + dz - EPS
      ) {
        continue;
      }
      const key = `${Math.round(p.x)}_${Math.round(p.y)}_${Math.round(p.z)}`;
      if (!this.epKeys.has(key)) {
        this.epKeys.add(key);
        nextEPs.push(p);
      }
    }
    this.extremePoints = nextEPs;

    // 1. Direct orthogonal corner points + wall projections
    this.addEP({ x: x + dx, y, z });
    this.addEP({ x, y, z: z + dz });
    this.addEP({ x, y: y + dy, z });
    this.addEP({ x: x + dx, y: 0, z });
    this.addEP({ x, y: 0, z: z + dz });
    this.addEP({ x: x + dx, y, z: 0 });
    this.addEP({ x: 0, y, z: z + dz });
    this.addEP({ x: x + dx, y: 0, z: 0 });
    this.addEP({ x: 0, y: 0, z: z + dz });
    this.addEP({ x: 0, y: y + dy, z });
    this.addEP({ x, y: y + dy, z: 0 });

    // 2. Bidirectional projections onto nearby box faces & elevated shelves
    for (let i = 0; i < this.placed.length - 1; i++) {
      const b = this.placed[i];

      // Projections along +X / -X
      if (b.x + b.dx <= x + EPS && b.z < z + dz && b.z + b.dz > z) {
        this.addEP({ x: x + dx, y, z: Math.max(z, b.z) });
        this.addEP({ x: b.x + b.dx, y: y + dy, z: Math.max(z, b.z) });
        if (b.y + b.dy <= y + EPS) {
          this.addEP({ x: x + dx, y: b.y + b.dy, z: Math.max(z, b.z) });
        }
      }
      if (x + dx <= b.x + EPS && b.y + b.dy > y && b.z < z + dz && b.z + b.dz > z) {
        this.addEP({ x: x + dx, y: b.y + b.dy, z: Math.max(z, b.z) });
        this.addEP({ x: b.x, y: y + dy, z: Math.max(z, b.z) });
      }

      // Projections along +Z / -Z
      if (b.z + b.dz <= z + EPS && b.x < x + dx && b.x + b.dx > x) {
        this.addEP({ x: Math.max(x, b.x), y, z: z + dz });
        this.addEP({ x: Math.max(x, b.x), y: y + dy, z: b.z + b.dz });
        if (b.y + b.dy <= y + EPS) {
          this.addEP({ x: Math.max(x, b.x), y: b.y + b.dy, z: z + dz });
        }
      }
      if (z + dz <= b.z + EPS && b.y + b.dy > y && b.x < x + dx && b.x + b.dx > x) {
        this.addEP({ x: Math.max(x, b.x), y: b.y + b.dy, z: z + dz });
        this.addEP({ x: Math.max(x, b.x), y: y + dy, z: b.z });
      }

      // Vertical projections onto Y shelves
      if (b.y + b.dy <= y + EPS && b.x < x + dx && b.x + b.dx > x && b.z < z + dz && b.z + b.dz > z) {
        this.addEP({ x: b.x + b.dx, y: b.y + b.dy, z });
        this.addEP({ x, y: b.y + b.dy, z: b.z + b.dz });
      }
      if (y + dy <= b.y + EPS && b.x < x + dx && b.x + b.dx > x && b.z < z + dz && b.z + b.dz > z) {
        this.addEP({ x, y: b.y + b.dy, z });
      }
    }

    // Sort EPs strictly inside-to-outside so scanning starts at inner frontier
    this.extremePoints.sort((a, b) => {
      if (loadingDirection === 'side') return a.z - b.z || a.y - b.y || a.x - b.x;
      if (loadingDirection === 'top') return a.y - b.y || a.x - b.x || a.z - b.z;
      return a.x - b.x || a.y - b.y || a.z - b.z;
    });

    if (this.extremePoints.length > 700) {
      // Keep frontier points + floor points so higher X floor points never get evicted
      const floorPts = this.extremePoints.filter((p) => p.y <= EPS);
      const elevPts = this.extremePoints.filter((p) => p.y > EPS);
      const keepFloor = floorPts.slice(0, 300);
      const keepElev = elevPts.slice(0, 700 - keepFloor.length);
      this.extremePoints = [...keepFloor, ...keepElev];
      this.extremePoints.sort((a, b) => {
        if (loadingDirection === 'side') return a.z - b.z || a.y - b.y || a.x - b.x;
        if (loadingDirection === 'top') return a.y - b.y || a.x - b.x || a.z - b.z;
        return a.x - b.x || a.y - b.y || a.z - b.z;
      });
      this.epKeys = new Set(
        this.extremePoints.map((p) => `${Math.round(p.x)}_${Math.round(p.y)}_${Math.round(p.z)}`)
      );
    }
  }

  private updateFreeBoxes(
    px: number,
    py: number,
    pz: number,
    pdx: number,
    pdy: number,
    pdz: number
  ): void {
    const minD = this.minAllowedDim;
    const next: FreeBox[] = [];
    for (const fb of this.freeBoxes) {
      const ox = overlap1D(px, px + pdx, fb.x, fb.x + fb.dx);
      const oy = overlap1D(py, py + pdy, fb.y, fb.y + fb.dy);
      const oz = overlap1D(pz, pz + pdz, fb.z, fb.z + fb.dz);

      if (ox <= EPS || oy <= EPS || oz <= EPS) {
        next.push(fb);
        continue;
      }

      if (px > fb.x + EPS) {
        next.push({ x: fb.x, y: fb.y, z: fb.z, dx: px - fb.x, dy: fb.dy, dz: fb.dz });
      }
      if (px + pdx < fb.x + fb.dx - EPS) {
        next.push({
          x: px + pdx,
          y: fb.y,
          z: fb.z,
          dx: fb.x + fb.dx - (px + pdx),
          dy: fb.dy,
          dz: fb.dz,
        });
      }
      if (pz > fb.z + EPS) {
        next.push({ x: fb.x, y: fb.y, z: fb.z, dx: fb.dx, dy: fb.dy, dz: pz - fb.z });
      }
      if (pz + pdz < fb.z + fb.dz - EPS) {
        next.push({
          x: fb.x,
          y: fb.y,
          z: pz + pdz,
          dx: fb.dx,
          dy: fb.dy,
          dz: fb.z + fb.dz - (pz + pdz),
        });
      }
      if (py > fb.y + EPS) {
        next.push({
          x: fb.x,
          y: fb.y,
          z: fb.z,
          dx: fb.dx,
          dy: py - fb.y,
          dz: fb.dz,
        });
      }
      if (py + pdy < fb.y + fb.dy - EPS) {
        next.push({
          x: fb.x,
          y: py + pdy,
          z: fb.z,
          dx: fb.dx,
          dy: fb.y + fb.dy - (py + pdy),
          dz: fb.dz,
        });
      }
    }

    const filtered = next.filter((b) => b.dx >= minD && b.dy >= minD && b.dz >= minD);
    filtered.sort((a, b) => b.dx * b.dy * b.dz - a.dx * a.dy * a.dz);
    const pruned: FreeBox[] = [];
    for (let i = 0; i < filtered.length && pruned.length < 120; i++) {
      const a = filtered[i];
      let contained = false;
      for (const b of pruned) {
        if (
          a.x >= b.x - EPS &&
          a.y >= b.y - EPS &&
          a.z >= b.z - EPS &&
          a.x + a.dx <= b.x + b.dx + EPS &&
          a.y + a.dy <= b.y + b.dy + EPS &&
          a.z + a.dz <= b.z + b.dz + EPS
        ) {
          contained = true;
          break;
        }
      }
      if (!contained) pruned.push(a);
    }
    this.freeBoxes = pruned;
  }
}

/* -------------------------------------------------------------------------- */
/*     High-Density 2D/3D Homogeneous & Hybrid Wall-Module Block Tiler         */
/* -------------------------------------------------------------------------- */

interface Rect2DPlacement {
  u: number;
  v: number;
  du: number;
  dv: number;
  orient: Orientation;
}

function pack2DGrid(u0: number, v0: number, U: number, V: number, du: number, dv: number, orient: Orientation): Rect2DPlacement[] {
  const nu = Math.floor((U + EPS) / du);
  const nv = Math.floor((V + EPS) / dv);
  const out: Rect2DPlacement[] = [];
  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) {
      out.push({ u: u0 + iu * du, v: v0 + iv * dv, du, dv, orient });
    }
  }
  return out;
}

function pack2DPinwheel(u0: number, v0: number, U: number, V: number, o1: Orientation, o2: Orientation, a: number, b: number): Rect2DPlacement[] {
  // o1 has (du=a, dv=b), o2 has (du=b, dv=a), placed inside a+b x a+b tile
  const tileSize = a + b;
  if (U + EPS < tileSize || V + EPS < tileSize) return [];
  const res: Rect2DPlacement[] = [];
  const nU = Math.floor((U + EPS) / tileSize);
  const nV = Math.floor((V + EPS) / tileSize);
  for (let iu = 0; iu < nU; iu++) {
    for (let iv = 0; iv < nV; iv++) {
      const pu = u0 + iu * tileSize;
      const pv = v0 + iv * tileSize;
      res.push({ u: pu, v: pv, du: a, dv: b, orient: o1 });
      res.push({ u: pu + a, v: pv, du: b, dv: a, orient: o2 });
      res.push({ u: pu + b, v: pv + a, du: a, dv: b, orient: o1 });
      res.push({ u: pu, v: pv + b, du: b, dv: a, orient: o2 });
    }
  }
  return res;
}

function solveBest2DRect(
  U: number,
  V: number,
  rects: { du: number; dv: number; orient: Orientation }[],
  depth = 0
): Rect2DPlacement[] {
  const usable = rects.filter((r) => r.du <= U + EPS && r.dv <= V + EPS);
  if (usable.length === 0) return [];

  let best: Rect2DPlacement[] = [];

  // 1. Pure grids
  for (const r of usable) {
    const g = pack2DGrid(0, 0, U, V, r.du, r.dv, r.orient);
    if (g.length > best.length) best = g;
  }

  if (depth >= 2 || usable.length === 1) return best;

  // 2. Pinwheel check if two perpendicular orientations share dimensions (a,b) and (b,a)
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const r1 = usable[i];
      const r2 = usable[j];
      if (Math.abs(r1.du - r2.dv) < EPS && Math.abs(r1.dv - r2.du) < EPS) {
        const tile = r1.du + r1.dv;
        if (U + EPS >= tile && V + EPS >= tile) {
          const pw = pack2DPinwheel(0, 0, U, V, r1.orient, r2.orient, r1.du, r1.dv);
          const usedU = Math.floor((U + EPS) / tile) * tile;
          const usedV = Math.floor((V + EPS) / tile) * tile;
          if (pw.length > best.length) best = pw;

          // Fill strips outside pinwheel block
          if (U - usedU > EPS) {
            const right = solveBest2DRect(U - usedU, V, usable, depth + 1);
            const combined = [...pw, ...right.map((p) => ({ ...p, u: p.u + usedU }))];
            if (combined.length > best.length) best = combined;
          }
          if (V - usedV > EPS) {
            const top = solveBest2DRect(usedU, V - usedV, usable, depth + 1);
            const right = U - usedU > EPS ? solveBest2DRect(U - usedU, V, usable, depth + 1) : [];
            const combined = [
              ...pw,
              ...top.map((p) => ({ ...p, v: p.v + usedV })),
              ...right.map((p) => ({ ...p, u: p.u + usedU })),
            ];
            if (combined.length > best.length) best = combined;
          }
        }
      }
    }
  }

  // 3. 2-Zone split along U and V for every primary orientation and integer count
  for (const r of usable) {
    const maxNu = Math.floor((U + EPS) / r.du);
    for (let ku = 1; ku <= maxNu; ku++) {
      const splitU = ku * r.du;
      const maxNv = Math.floor((V + EPS) / r.dv);

      // Full V height strip [0..splitU] x [0..V] + residual [splitU..U] x [0..V]
      const leftFull = pack2DGrid(0, 0, splitU, V, r.du, r.dv, r.orient);
      const remRight = solveBest2DRect(U - splitU, V, usable, depth + 1);
      if (leftFull.length + remRight.length > best.length) {
        best = [...leftFull, ...remRight.map((p) => ({ ...p, u: p.u + splitU }))];
      }

      // Also sub-split at corners when depth === 0 (finds L-shapes like 29+12+8+4 = 53!)
      if (depth === 0 && maxNv >= 1) {
        for (let kv = 1; kv <= maxNv; kv++) {
          const splitV = kv * r.dv;
          const corner = pack2DGrid(0, 0, splitU, splitV, r.du, r.dv, r.orient);

          // Split A: Top strip [0..U] x [splitV..V] + Right [splitU..U] x [0..splitV]
          const topA = solveBest2DRect(U, V - splitV, usable, depth + 1);
          const rightA = solveBest2DRect(U - splitU, splitV, usable, depth + 1);
          if (corner.length + topA.length + rightA.length > best.length) {
            best = [
              ...corner,
              ...topA.map((p) => ({ ...p, v: p.v + splitV })),
              ...rightA.map((p) => ({ ...p, u: p.u + splitU })),
            ];
          }

          // Split B: Right strip [splitU..U] x [0..V] + Top [0..splitU] x [splitV..V]
          const rightB = solveBest2DRect(U - splitU, V, usable, depth + 1);
          const topB = solveBest2DRect(splitU, V - splitV, usable, depth + 1);
          if (corner.length + rightB.length + topB.length > best.length) {
            best = [
              ...corner,
              ...rightB.map((p) => ({ ...p, u: p.u + splitU })),
              ...topB.map((p) => ({ ...p, v: p.v + splitV })),
            ];
          }
        }
      }
    }

    const maxNv = Math.floor((V + EPS) / r.dv);
    for (let kv = 1; kv <= maxNv; kv++) {
      const splitV = kv * r.dv;
      const botFull = pack2DGrid(0, 0, U, splitV, r.du, r.dv, r.orient);
      const remTop = solveBest2DRect(U, V - splitV, usable, depth + 1);
      if (botFull.length + remTop.length > best.length) {
        best = [...botFull, ...remTop.map((p) => ({ ...p, v: p.v + splitV }))];
      }
    }
  }

  return best;
}

interface CandidatePlacement3D {
  x: number;
  y: number;
  z: number;
  orient: Orientation;
}

function generateBlockLayoutsInBox(
  box: FreeBox,
  orientations: Orientation[],
  spec: PackageSpec,
  loadingDirection: LoadingDirection,
  preferredOrientation?: Orientation
): CandidatePlacement3D[][] {
  if (orientations.length === 0) return [];
  const results: CandidatePlacement3D[][] = [];

  const maxStackAllowed = !spec.stackable
    ? 1
    : spec.maxStackLayers > 0
      ? spec.maxStackLayers + 1
      : 999;

  // Helper: Multi-height Y-layer stack inside a given sub-cuboid (subL x subH x subW)
  const buildLayeredStack = (
    ox: number,
    oy: number,
    oz: number,
    subL: number,
    subH: number,
    subW: number
  ): CandidatePlacement3D[] => {
    const distinctHeights = Array.from(
      new Set(orientations.filter((o) => o.dy <= subH + EPS).map((o) => Math.round(o.dy * 100) / 100))
    ).sort((a, b) => a - b);

    const best2DForHeight = new Map<number, Rect2DPlacement[]>();
    for (const h of distinctHeights) {
      const matching = orientations
        .filter((o) => Math.abs(o.dy - h) < EPS && o.dx <= subL + EPS && o.dz <= subW + EPS)
        .map((o) => ({ du: o.dx, dv: o.dz, orient: o }));
      best2DForHeight.set(h, solveBest2DRect(subL, subW, matching));
    }

    let bestStack: CandidatePlacement3D[] = [];

    // Try 1-height uniform stacks and 2-height bottom+top layer stacks
    for (const h1 of distinctHeights) {
      const layer1 = best2DForHeight.get(h1) ?? [];
      if (layer1.length === 0) continue;
      const maxN1 = Math.min(maxStackAllowed, Math.floor((subH + EPS) / h1));

      for (let n1 = 1; n1 <= maxN1; n1++) {
        const remH = subH - n1 * h1;
        // Pure n1 layers of h1
        if (n1 === maxN1) {
          const stack: CandidatePlacement3D[] = [];
          for (let k = 0; k < n1; k++) {
            for (const r of layer1) {
              stack.push({ x: ox + r.u, y: oy + k * h1, z: oz + r.v, orient: r.orient });
            }
          }
          if (stack.length > bestStack.length) bestStack = stack;
        }

        // Add n2 layers of h2 on top (h2 != h1)
        for (const h2 of distinctHeights) {
          if (Math.abs(h2 - h1) < EPS || h2 > remH + EPS) continue;
          const layer2 = best2DForHeight.get(h2) ?? [];
          if (layer2.length === 0) continue;
          const maxN2 = Math.min(maxStackAllowed - n1, Math.floor((remH + EPS) / h2));
          if (maxN2 <= 0) continue;

          // Compute exact support bounding box from layer1 to ensure >= 68% support
          const l1MaxX = layer1.reduce((m, p) => Math.max(m, p.u + p.du), 0);
          const l1MaxZ = layer1.reduce((m, p) => Math.max(m, p.v + p.dv), 0);
          const supportedLayer2 = solveBest2DRect(
            Math.min(subL, l1MaxX),
            Math.min(subW, l1MaxZ),
            orientations
              .filter((o) => Math.abs(o.dy - h2) < EPS && o.dx <= subL + EPS && o.dz <= subW + EPS)
              .map((o) => ({ du: o.dx, dv: o.dz, orient: o }))
          );
          if (supportedLayer2.length === 0) continue;

          const stack: CandidatePlacement3D[] = [];
          for (let k = 0; k < n1; k++) {
            for (const r of layer1) {
              stack.push({ x: ox + r.u, y: oy + k * h1, z: oz + r.v, orient: r.orient });
            }
          }
          for (let k = 0; k < maxN2; k++) {
            for (const r of supportedLayer2) {
              stack.push({
                x: ox + r.u,
                y: oy + n1 * h1 + k * h2,
                z: oz + r.v,
                orient: r.orient,
              });
            }
          }
          if (stack.length > bestStack.length) bestStack = stack;
        }
      }
    }

    return bestStack;
  };

  // Strategy 1: Full-box layered stack
  const fullStack = buildLayeredStack(box.x, box.y, box.z, box.dx, box.dy, box.dz);
  if (fullStack.length > 0) results.push(fullStack);

  // Strategy 2: Inside-to-Outside Vertical Wall Modules along Primary Axis (for Rear / Side)
  if (loadingDirection !== 'top') {
    const primaryIsRear = loadingDirection === 'rear';
    const axisSpan = primaryIsRear ? box.dx : box.dz;
    const crossU = primaryIsRear ? box.dz : box.dx;
    const crossV = box.dy;

    const unitDepths = Array.from(
      new Set(orientations.map((o) => Math.round((primaryIsRear ? o.dx : o.dz) * 100) / 100))
    ).filter((d) => d <= axisSpan + EPS);

    // Build candidate wall-module depths (single depth + composite LCM depths up to 2400mm)
    const moduleDepths = new Set<number>(unitDepths);
    for (let i = 0; i < unitDepths.length; i++) {
      for (let j = i + 1; j < unitDepths.length; j++) {
        const a = unitDepths[i];
        const b = unitDepths[j];
        for (let ka = 1; ka <= 3; ka++) {
          const candidateA = Math.round(ka * a * 100) / 100;
          if (candidateA <= axisSpan + EPS && candidateA <= 2400) moduleDepths.add(candidateA);
          for (let kb = 1; kb <= 3; kb++) {
            const sum = Math.round((ka * a + kb * b) * 100) / 100;
            if (sum <= axisSpan + EPS && sum <= 2400) moduleDepths.add(sum);
          }
        }
      }
    }

    const sortedModDepths = Array.from(moduleDepths).sort((a, b) => a - b).slice(0, 12);

    for (const modD of sortedModDepths) {
      const countMod = Math.floor((axisSpan + EPS) / modD);
      if (countMod <= 0) continue;

      // Method 2a: Composite 3D wall module inside [modD x crossU x crossV]
      const oneModule3D = primaryIsRear
        ? buildLayeredStack(0, 0, 0, modD, box.dy, box.dz)
        : buildLayeredStack(0, 0, 0, box.dx, box.dy, modD);

      // Method 2b: Single 2D Cross-Section wall slice (Z x Y or X x Y) when modD matches an orientation depth
      const slice2DOrients = orientations
        .filter((o) => (primaryIsRear ? o.dx : o.dz) <= modD + EPS)
        .map((o) => ({
          du: primaryIsRear ? o.dz : o.dx,
          dv: o.dy,
          orient: o,
        }));
      const wall2D = solveBest2DRect(crossU, crossV, slice2DOrients);
      const wall2DAs3D: CandidatePlacement3D[] = wall2D.map((r) => ({
        x: primaryIsRear ? 0 : r.u,
        y: r.v,
        z: primaryIsRear ? r.u : 0,
        orient: r.orient,
      }));

      const chosenModule = oneModule3D.length >= wall2DAs3D.length ? oneModule3D : wall2DAs3D;
      if (chosenModule.length === 0) continue;

      const fullWallPlan: CandidatePlacement3D[] = [];
      for (let m = 0; m < countMod; m++) {
        const offset = m * modD;
        for (const p of chosenModule) {
          fullWallPlan.push({
            x: box.x + p.x + (primaryIsRear ? offset : 0),
            y: box.y + p.y,
            z: box.z + p.z + (primaryIsRear ? 0 : offset),
            orient: p.orient,
          });
        }
      }

      // Fill remaining leftover slice at the door end [countMod * modD .. axisSpan]
      const remDepth = axisSpan - countMod * modD;
      if (remDepth > 50) {
        const tailModule = primaryIsRear
          ? buildLayeredStack(countMod * modD, 0, 0, remDepth, box.dy, box.dz)
          : buildLayeredStack(0, 0, countMod * modD, box.dx, box.dy, remDepth);
        for (const p of tailModule) {
          fullWallPlan.push({
            x: box.x + p.x,
            y: box.y + p.y,
            z: box.z + p.z,
            orient: p.orient,
          });
        }
      }

      if (fullWallPlan.length > 0) results.push(fullWallPlan);
    }
  }

  // Sort results descending by unit count, tie-breaking by preferredOrientation & wall compactness
  results.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    if (preferredOrientation) {
      const prefA = a.filter((p) => p.orient.label === preferredOrientation.label).length;
      const prefB = b.filter((p) => p.orient.label === preferredOrientation.label).length;
      if (prefB !== prefA) return prefB - prefA;
    }
    return 0;
  });

  return results;
}

type StrategyId =
  | 'wall_tiling'
  | 'layer_module'
  | 'ep_lvb'
  | 'ep_laf'
  | 'top_cap_hybrid'
  | 'bfd'
  | 'ffd'
  | 'guillotine';

interface StrategyConfig {
  id: StrategyId;
  name: string;
}

const STRATEGIES: StrategyConfig[] = [
  { id: 'wall_tiling', name: 'Wall-Slice High-Density Tiling (Inside-Out)' },
  { id: 'layer_module', name: 'Composite Layer-Module Tiling' },
  { id: 'top_cap_hybrid', name: 'Heavy-Base + Fragile Top-Cap Hybrid' },
  { id: 'ep_lvb', name: 'Extreme Points · Largest Volume First' },
  { id: 'ep_laf', name: 'Extreme Points · Largest Base Area First' },
  { id: 'bfd', name: 'Best Fit Decreasing (Residual Minimize)' },
  { id: 'guillotine', name: 'Guillotine Space Splitting' },
  { id: 'ffd', name: 'First Fit Decreasing (Fast Directional)' },
];

function sortSpecsForStrategy(specs: PackageSpec[], strategy: StrategyId, mode: OptimizationMode): PackageSpec[] {
  const arr = [...specs].filter((s) => Math.floor(s.quantity) > 0 && s.length > 0 && s.width > 0 && s.height > 0);
  arr.sort((a, b) => {
    const volA = a.length * a.width * a.height;
    const volB = b.length * b.width * b.height;
    const areaA = a.length * a.width;
    const areaB = b.length * b.width;

    // In top_cap_hybrid / layer_module, stackable non-fragile base items MUST build support before fragile/non-stackables cover floor
    if (strategy === 'top_cap_hybrid') {
      const topOnlyA = !a.stackable || a.fragile ? 1 : 0;
      const topOnlyB = !b.stackable || b.fragile ? 1 : 0;
      if (topOnlyA !== topOnlyB) return topOnlyA - topOnlyB;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return volB - volA || areaB - areaA;
    }

    if (mode === 'max_count') {
      if (a.fragile !== b.fragile) return a.fragile ? 1 : -1;
      if (a.stackable !== b.stackable) return a.stackable ? -1 : 1;
      return volA - volB;
    }

    if (mode === 'weight_balance') {
      if (a.fragile !== b.fragile) return a.fragile ? 1 : -1;
      if (a.stackable !== b.stackable) return a.stackable ? -1 : 1;
      if (Math.abs(b.weight - a.weight) > 1) return b.weight - a.weight;
      return volB - volA;
    }

    if (strategy === 'layer_module' || strategy === 'guillotine') {
      // Pure geometric density ordering: stackable non-fragile heavy bases -> stackable -> fragile/non-stackable
      const topOnlyA = !a.stackable || a.fragile ? 1 : 0;
      const topOnlyB = !b.stackable || b.fragile ? 1 : 0;
      if (topOnlyA !== topOnlyB) return topOnlyA - topOnlyB;
      return volB - volA || areaB - areaA;
    }

    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.fragile !== b.fragile) return a.fragile ? 1 : -1;
    if (a.stackable !== b.stackable) return a.stackable ? -1 : 1;

    switch (strategy) {
      case 'ep_laf':
        return areaB - areaA || volB - volA;
      case 'wall_tiling':
        return volB - volA || areaB - areaA;
      case 'bfd':
      case 'ffd':
      case 'ep_lvb':
      default:
        return volB - volA || areaB - areaA;
    }
  });
  return arr;
}

function scoreCandidate(
  c: ContainerState,
  x: number,
  y: number,
  z: number,
  o: Orientation,
  spec: PackageSpec,
  strategy: StrategyId,
  mode: OptimizationMode,
  loadingDirection: LoadingDirection
): number {
  const { internalLength: L, internalWidth: W, internalHeight: H } = c.space;
  const minDim = c.minAllowedDim;

  // Base inside-to-outside directional progression
  let dirPenalty = x * 8.0 + y * 1.3 + z * 0.45 + (x + o.dx) * 0.6;
  let crossRemA = W - (z + o.dz);
  let crossRemB = H - (y + o.dy);
  let crossTileA = (W - z) % Math.max(1, o.dz);
  let crossTileB = (H - y) % Math.max(1, o.dy);

  if (loadingDirection === 'side') {
    dirPenalty = z * 8.0 + y * 1.3 + x * 0.45 + (z + o.dz) * 0.6;
    crossRemA = L - (x + o.dx);
    crossRemB = H - (y + o.dy);
    crossTileA = (L - x) % Math.max(1, o.dx);
    crossTileB = (H - y) % Math.max(1, o.dy);
  } else if (loadingDirection === 'top') {
    dirPenalty = y * 8.0 + x * 1.0 + z * 0.6 + (y + o.dy) * 0.5;
    crossRemA = L - (x + o.dx);
    crossRemB = W - (z + o.dz);
    crossTileA = (L - x) % Math.max(1, o.dx);
    crossTileB = (W - z) % Math.max(1, o.dz);
  }

  // Penalize creating dead residual strips (5mm < remainder < minCargoDim) along container width
  const deadStripPenalty =
    (crossRemA > 5 && crossRemA < minDim - EPS ? 480 : 0) +
    (crossRemB > 5 && crossRemB < minDim - EPS ? 320 : 0);

  // Narrower cross-section width preference for ep_laf / layer_module avoids premature wide Z-blocks (e.g. 1200+800 leaving 352mm strip)
  const narrowCrossBias =
    strategy === 'layer_module' || strategy === 'top_cap_hybrid'
      ? (loadingDirection === 'side' ? o.dx : o.dz) * 0.08
      : 0;

  // Tiling & flush alignment bonus: rewards cleanly completing cross-section width & ceiling height
  const flushBonus =
    (crossRemA < 5 ? -560 : crossRemA < 40 ? -180 : 0) +
    (crossRemB < 5 ? -460 : crossRemB < 40 ? -150 : 0) +
    (crossTileA < 25 ? -290 : 0) +
    (crossTileB < 25 ? -240 : 0) +
    deadStripPenalty +
    narrowCrossBias;

  // Reward placing non-stackable / fragile items high up on top of existing stacks instead of wasting floor space
  let topCapBonus = 0;
  if ((!spec.stackable || spec.fragile) && y > EPS) {
    topCapBonus = -780 + (crossRemB < 180 ? -250 : 0);
  }

  if (strategy === 'wall_tiling' || strategy === 'layer_module') {
    let wallDepthBonus = 0;
    if (loadingDirection === 'rear') {
      const k = `R:${Math.round(x / 5)}_${Math.round(o.dx / 5)}`;
      if (c.wallKeys.has(k)) wallDepthBonus = -380;
    } else if (loadingDirection === 'side') {
      const k = `S:${Math.round(z / 5)}_${Math.round(o.dz / 5)}`;
      if (c.wallKeys.has(k)) wallDepthBonus = -380;
    }
    return dirPenalty + flushBonus + wallDepthBonus + topCapBonus;
  }

  if (mode === 'weight_balance' || (mode === 'balanced' && strategy !== 'bfd')) {
    const newW = c.totalWeight + spec.weight;
    const newCogZ = (c.weightedZ + spec.weight * (z + o.dz / 2)) / Math.max(1, newW);
    const newCogX = (c.weightedX + spec.weight * (x + o.dx / 2)) / Math.max(1, newW);
    const lateralOffset =
      loadingDirection === 'side' ? Math.abs(newCogX - L / 2) / L : Math.abs(newCogZ - W / 2) / W;
    const cogWeight = mode === 'weight_balance' ? 2400 : 750;
    const heightWeight = spec.weight * (y / Math.max(1, H)) * (mode === 'weight_balance' ? 22 : 5);

    return dirPenalty + flushBonus * 0.7 + lateralOffset * cogWeight + heightWeight + topCapBonus;
  }

  return dirPenalty + flushBonus + topCapBonus;
}

function tryTryCommitBlockPlan(
  cont: ContainerState,
  plan: CandidatePlacement3D[],
  spec: PackageSpec,
  maxUnitsToPlace: number,
  maxAllowedVol: number,
  targetRatio: number,
  loadingDirection: LoadingDirection
): number {
  const unitVol = spec.length * spec.width * spec.height;
  // Sort plan bottom-to-top, inside-to-outside so supporters always exist before stacked units
  const ordered = [...plan].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  let placedNow = 0;

  for (const cand of ordered) {
    if (placedNow >= maxUnitsToPlace) break;
    if (cont.totalWeight + spec.weight > cont.space.maxPayload + 0.01) break;
    if (
      targetRatio < 0.9999 &&
      cont.placed.length > 0 &&
      cont.occupiedVolume + unitVol > maxAllowedVol + EPS
    ) {
      break;
    }
    const check = cont.canPlaceAt(
      cand.x,
      cand.y,
      cand.z,
      cand.orient.dx,
      cand.orient.dy,
      cand.orient.dz,
      spec
    );
    if (!check.ok) continue;

    cont.commitPlacement(
      cand.x,
      cand.y,
      cand.z,
      cand.orient,
      spec,
      check.supporters,
      check.supportedAreaPct,
      loadingDirection
    );
    placedNow++;
  }
  return placedNow;
}

function tryPickBestPlacementForSpec(
  cont: ContainerState,
  spec: PackageSpec,
  orientations: Orientation[],
  strategy: StrategyId,
  mode: OptimizationMode,
  dir: LoadingDirection
): {
  x: number;
  y: number;
  z: number;
  o: Orientation;
  supporters: { idx: number; share: number }[];
  supportedAreaPct: number;
  score: number;
} | null {
  if (orientations.length === 0) return null;

  // Build candidate points from EPs + freeBoxes corners (supported/dropped)
  const rawPts: Point3D[] =
    strategy === 'guillotine'
      ? [
          ...cont.freeBoxes.map((fb) => ({ x: fb.x, y: cont.computeDropY(fb.x, fb.z, orientations[0].dx, orientations[0].dz), z: fb.z })),
          ...cont.freeBoxes.map((fb) => ({ x: fb.x, y: fb.y, z: fb.z })),
          ...cont.extremePoints,
        ]
      : [
          ...cont.extremePoints,
          ...cont.freeBoxes.slice(0, 40).map((fb) => ({ x: fb.x, y: fb.y, z: fb.z })),
        ];

  rawPts.sort((a, b) => {
    if (dir === 'side') return a.z - b.z || a.y - b.y || a.x - b.x;
    if (dir === 'top') return a.y - b.y || a.x - b.x || a.z - b.z;
    return a.x - b.x || a.y - b.y || a.z - b.z;
  });

  const fastMode = strategy === 'ffd';
  const minDx = Math.min(...orientations.map((o) => o.dx));
  const minDy = Math.min(...orientations.map((o) => o.dy));
  const minDz = Math.min(...orientations.map((o) => o.dz));
  const { internalLength: L, internalHeight: H, internalWidth: W } = cont.space;

  const seen = new Set<string>();
  let bestScore = Infinity;
  let bestChoice: {
    x: number;
    y: number;
    z: number;
    o: Orientation;
    supporters: { idx: number; share: number }[];
    supportedAreaPct: number;
    score: number;
  } | null = null;

  for (let pIdx = 0; pIdx < rawPts.length; pIdx++) {
    const pt = rawPts[pIdx];
    const key = `${Math.round(pt.x)}_${Math.round(pt.y)}_${Math.round(pt.z)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (pt.x + minDx > L + EPS || pt.y + minDy > H + EPS || pt.z + minDz > W + EPS) {
      continue;
    }

    // Exact branch-and-bound cut along primary loading axis once bestChoice exists.
    // Minimum possible sum of negative bonuses (flush -1550, wall -380, topCap -1030) is -2960.
    if (bestChoice) {
      const axisPos = dir === 'side' ? pt.z : dir === 'top' ? pt.y : pt.x;
      if (axisPos * 8.0 - 3050 > bestScore) {
        break;
      }
    }

    for (const o of orientations) {
      if (pt.x + o.dx > L + EPS || pt.y + o.dy > H + EPS || pt.z + o.dz > W + EPS) {
        continue;
      }
      const check = cont.canPlaceAt(pt.x, pt.y, pt.z, o.dx, o.dy, o.dz, spec);
      if (!check.ok) continue;

      const sc = scoreCandidate(cont, pt.x, pt.y, pt.z, o, spec, strategy, mode, dir);
      if (sc < bestScore) {
        bestScore = sc;
        bestChoice = {
          x: pt.x,
          y: pt.y,
          z: pt.z,
          o,
          supporters: check.supporters,
          supportedAreaPct: check.supportedAreaPct,
          score: sc,
        };
      }
      if (fastMode) break;
    }

    if (fastMode && bestChoice) break;
  }

  return bestChoice;
}

type KeepSameContainerMode = 'none' | 'whole_first' | 'consolidate_strict';

export const MAX_AUTO_CONTAINERS = 200;

function packSingleStrategy(
  spaces: LoadingSpace[],
  specsList: PackageSpec[],
  strategy: StrategyId,
  mode: OptimizationMode,
  allowRotation: boolean,
  loadingDirection: LoadingDirection,
  targetUtilizationPct: number,
  autoDetermineContainers: boolean,
  shouldCancel?: () => boolean,
  keepSameMode: KeepSameContainerMode = 'none',
  onContainerStep?: (containerIdx: number) => void
): {
  containers: ContainerState[];
  unloadedCount: number;
  cancelled: boolean;
} {
  const sortedSpecs = sortSpecsForStrategy(specsList, strategy, mode);
  const canAutoSpawn = autoDetermineContainers || mode === 'min_vehicles';
  const maxContainers = canAutoSpawn ? Math.max(MAX_AUTO_CONTAINERS, spaces.length) : spaces.length;
  const targetRatio = Math.max(0.01, Math.min(1, targetUtilizationPct / 100));

  const remainingBySpec = new Map<string, number>();
  let totalRemaining = 0;
  for (const s of sortedSpecs) {
    const q = Math.max(0, Math.floor(s.quantity));
    if (q > 0) {
      remainingBySpec.set(s.id, q);
      totalRemaining += q;
    }
  }

  let minAllowedDim = Infinity;
  for (const s of sortedSpecs) {
    minAllowedDim = Math.min(minAllowedDim, s.length, s.width, s.height);
  }
  minAllowedDim = Number.isFinite(minAllowedDim) ? Math.max(20, minAllowedDim) : 50;

  const containers: ContainerState[] = spaces.map((sp, i) => new ContainerState(sp, i, minAllowedDim));

  const orientCache = new Map<string, Orientation[]>();
  const getOrientationsForContainer = (spec: PackageSpec, cont: ContainerState): Orientation[] => {
    const dir = spaces.length <= 1 ? loadingDirection : cont.space.loadingDirection ?? loadingDirection;
    const key = `${spec.id}__${cont.space.internalLength}x${cont.space.internalWidth}x${cont.space.internalHeight}__${cont.space.doorWidth}x${cont.space.doorHeight}__${dir}`;
    let cached = orientCache.get(key);
    if (!cached) {
      cached = getAllowedOrientations(spec, allowRotation, cont.space, dir);
      orientCache.set(key, cached);
    }
    return cached;
  };

  let cIdx = 0;
  while (totalRemaining > 0 && cIdx < maxContainers) {
    if (shouldCancel && shouldCancel()) {
      return { containers, unloadedCount: totalRemaining, cancelled: true };
    }
    onContainerStep?.(cIdx);

    if (cIdx >= containers.length) {
      const templateSpace = { ...(spaces[spaces.length - 1] ?? spaces[0]) };
      containers.push(new ContainerState(templateSpace, cIdx, minAllowedDim));
    }

    const cont = containers[cIdx];
    const dir = spaces.length <= 1 ? loadingDirection : cont.space.loadingDirection ?? loadingDirection;
    const maxAllowedVol = cont.spaceVolume * targetRatio;
    const blockedInContainer = new Set<string>();
    const placedInContBySpec = new Map<string, number>();

    const canRemainingFitWholeInCont = (s: PackageSpec): boolean => {
      const rem = remainingBySpec.get(s.id) ?? 0;
      if (rem <= 0) return false;
      const unitVol = s.length * s.width * s.height;
      if (cont.occupiedVolume + rem * unitVol > maxAllowedVol + EPS) return false;
      if (cont.totalWeight + rem * s.weight > cont.space.maxPayload + 0.01) return false;
      return getOrientationsForContainer(s, cont).length > 0;
    };

    const canRemainingFitWholeInFreshCont = (s: PackageSpec): boolean => {
      const rem = remainingBySpec.get(s.id) ?? 0;
      if (rem <= 0) return false;
      const unitVol = s.length * s.width * s.height;
      if (rem * unitVol > cont.spaceVolume * targetRatio + EPS) return false;
      if (rem * s.weight > cont.space.maxPayload + 0.01) return false;
      return true;
    };

    // Phase 1 (Container Empty): Use exact 3D Wall/Layer Block Tiling for bulk/stackable lead SKUs!
    if (
      strategy === 'wall_tiling' &&
      cont.placed.length === 0 &&
      mode !== 'weight_balance'
    ) {
      let leadSpec: PackageSpec | undefined;
      if (keepSameMode !== 'none') {
        const wholeBulkCandidates = sortedSpecs
          .filter((s) => {
            const rem = remainingBySpec.get(s.id) ?? 0;
            return (
              rem >= 6 &&
              s.stackable &&
              !s.fragile &&
              canRemainingFitWholeInCont(s)
            );
          })
          .sort((a, b) => {
            const totA = (remainingBySpec.get(a.id) ?? 0) * a.length * a.width * a.height;
            const totB = (remainingBySpec.get(b.id) ?? 0) * b.length * b.width * b.height;
            return totB - totA;
          });
        leadSpec = wholeBulkCandidates[0];
      }
      if (!leadSpec) {
        leadSpec = sortedSpecs.find((s) => {
          const rem = remainingBySpec.get(s.id) ?? 0;
          return rem >= 6 && s.stackable && !s.fragile && cont.totalWeight + s.weight <= cont.space.maxPayload + 0.01;
        });
      }
      if (leadSpec) {
        const rem = remainingBySpec.get(leadSpec.id) ?? 0;
        const orients = getOrientationsForContainer(leadSpec, cont);
        if (orients.length > 0) {
          const fullBox: FreeBox = {
            x: 0,
            y: 0,
            z: 0,
            dx: cont.space.internalLength,
            dy: cont.space.internalHeight,
            dz: cont.space.internalWidth,
          };
          const plans = generateBlockLayoutsInBox(fullBox, orients, leadSpec, dir);
          const chosenPlan = plans[0];

          if (chosenPlan && chosenPlan.length >= 6) {
            const placedCnt = tryTryCommitBlockPlan(
              cont,
              chosenPlan,
              leadSpec,
              rem,
              maxAllowedVol,
              targetRatio,
              dir
            );
            if (placedCnt > 0) {
              remainingBySpec.set(leadSpec.id, rem - placedCnt);
              placedInContBySpec.set(leadSpec.id, placedCnt);
              totalRemaining -= placedCnt;
            }
          }
        }
      }
    }

    // Phase 2: Sequential SKU-by-SKU high-density packing INSIDE THIS CONTAINER before opening the next!
    let ops = 0;
    while (totalRemaining > 0) {
      if (shouldCancel && ops % 40 === 0 && shouldCancel()) {
        return { containers, unloadedCount: totalRemaining, cancelled: true };
      }
      ops++;

      let placedInStep = false;
      let candidateOrder = sortedSpecs;

      if (keepSameMode !== 'none') {
        const unblocked = sortedSpecs.filter(
          (s) => (remainingBySpec.get(s.id) ?? 0) > 0 && !blockedInContainer.has(s.id)
        );
        if (unblocked.length === 0) break;

        // Priority 1: Finish any SKU already started inside THIS container before opening another SKU
        const startedInCont = unblocked.filter((s) => (placedInContBySpec.get(s.id) ?? 0) > 0);
        if (startedInCont.length > 0) {
          candidateOrder = startedInCont;
        } else {
          // Priority 2: Choose SKUs whose ENTIRE remaining qty fits inside THIS container cleanly
          const wholeFitInCont = unblocked.filter((s) => canRemainingFitWholeInCont(s));
          if (wholeFitInCont.length > 0) {
            // Sort largest total remaining SKU volume first (best-fit whole-item consolidation)
            candidateOrder = [...wholeFitInCont].sort((a, b) => {
              const totA = (remainingBySpec.get(a.id) ?? 0) * a.length * a.width * a.height;
              const totB = (remainingBySpec.get(b.id) ?? 0) * b.length * b.width * b.height;
              return totB - totA;
            });
          } else if (
            keepSameMode === 'consolidate_strict' &&
            cont.placed.length > 0 &&
            (canAutoSpawn || cIdx < maxContainers - 1) &&
            unblocked.some((s) => canRemainingFitWholeInFreshCont(s))
          ) {
            // Stop filling leftover partial room if an unsplit whole SKU can start cleanly in the next container
            break;
          } else {
            candidateOrder = unblocked;
          }
        }
      }

      if (strategy === 'bfd' || strategy === 'layer_module') {
        // Competitive Multi-SKU frontier selection: compare ALL unblocked SKUs and pick best wall/pocket fit!
        type WinnerCandidate = {
          spec: PackageSpec;
          choice: NonNullable<ReturnType<typeof tryPickBestPlacementForSpec>>;
          effectiveScore: number;
        };

        const useTwoStageFrontier = candidateOrder.length > 18 && totalRemaining > 1200;
        const primarySlice = useTwoStageFrontier ? candidateOrder.slice(0, 18) : candidateOrder;
        const evaluateSlice = (slice: PackageSpec[]): WinnerCandidate | null => {
          let bestLocal: WinnerCandidate | null = null;
          for (const spec of slice) {
            const rem = remainingBySpec.get(spec.id) ?? 0;
            if (rem <= 0 || blockedInContainer.has(spec.id)) continue;

            if (cont.totalWeight + spec.weight > cont.space.maxPayload + 0.01) {
              blockedInContainer.add(spec.id);
              continue;
            }

            const unitVol = spec.length * spec.width * spec.height;
            if (
              targetRatio < 0.9999 &&
              cont.placed.length > 0 &&
              cont.occupiedVolume + unitVol > maxAllowedVol + EPS
            ) {
              blockedInContainer.add(spec.id);
              continue;
            }

            const orients = getOrientationsForContainer(spec, cont);
            if (orients.length === 0) {
              blockedInContainer.add(spec.id);
              continue;
            }

            const best = tryPickBestPlacementForSpec(cont, spec, orients, strategy, mode, dir);
            if (!best) {
              blockedInContainer.add(spec.id);
              continue;
            }

            const fragilePenalty = (!spec.stackable || spec.fragile) && best.y <= EPS ? 4500 : 0;
            const volTieBreak = -(unitVol / 1e7) * (strategy === 'layer_module' ? 40 : 120);
            const sameContBonus =
              keepSameMode !== 'none' &&
              ((placedInContBySpec.get(spec.id) ?? 0) > 0 || canRemainingFitWholeInCont(spec))
                ? -1200
                : 0;
            const eff = best.score + fragilePenalty + volTieBreak + sameContBonus;
            if (!bestLocal || eff < bestLocal.effectiveScore) {
              bestLocal = { spec, choice: best, effectiveScore: eff };
            }
          }
          return bestLocal;
        };

        const winnerChoice =
          evaluateSlice(primarySlice) ??
          (useTwoStageFrontier ? evaluateSlice(candidateOrder.slice(18)) : null);

        if (winnerChoice) {
          const { spec, choice } = winnerChoice;
          cont.commitPlacement(
            choice.x,
            choice.y,
            choice.z,
            choice.o,
            spec,
            choice.supporters,
            choice.supportedAreaPct,
            dir
          );
          remainingBySpec.set(spec.id, (remainingBySpec.get(spec.id) ?? 1) - 1);
          placedInContBySpec.set(spec.id, (placedInContBySpec.get(spec.id) ?? 0) + 1);
          totalRemaining--;
          placedInStep = true;
        }
      } else {
        for (const spec of candidateOrder) {
          const rem = remainingBySpec.get(spec.id) ?? 0;
          if (rem <= 0 || blockedInContainer.has(spec.id)) continue;

          if (cont.totalWeight + spec.weight > cont.space.maxPayload + 0.01) {
            blockedInContainer.add(spec.id);
            continue;
          }

          const unitVol = spec.length * spec.width * spec.height;
          if (
            targetRatio < 0.9999 &&
            cont.placed.length > 0 &&
            cont.occupiedVolume + unitVol > maxAllowedVol + EPS
          ) {
            blockedInContainer.add(spec.id);
            continue;
          }

          const orients = getOrientationsForContainer(spec, cont);
          if (orients.length === 0) {
            blockedInContainer.add(spec.id);
            continue;
          }

          const best = tryPickBestPlacementForSpec(cont, spec, orients, strategy, mode, dir);
          if (!best) {
            blockedInContainer.add(spec.id);
            continue;
          }

          cont.commitPlacement(
            best.x,
            best.y,
            best.z,
            best.o,
            spec,
            best.supporters,
            best.supportedAreaPct,
            dir
          );
          remainingBySpec.set(spec.id, rem - 1);
          placedInContBySpec.set(spec.id, (placedInContBySpec.get(spec.id) ?? 0) + 1);
          totalRemaining--;
          placedInStep = true;
          break;
        }
      }

      if (!placedInStep) break;
    }

    cIdx++;
  }

  return { containers, unloadedCount: totalRemaining, cancelled: false };
}

/* -------------------------------------------------------------------------- */
/*     Shared Single-Container Batch Solver for Manual "Load Entire Item"     */
/* -------------------------------------------------------------------------- */

export function packRemainingManualBatchInContainer(
  space: LoadingSpace,
  existingInContainer: PlacedPackage[],
  containerIndex: number,
  targetSpec: PackageSpec,
  remainingQty: number,
  preferredOrientation: Orientation,
  allowGlobalRotation: boolean,
  loadingDirection: LoadingDirection,
  specsMap: Map<string, PackageSpec>
): PlacedPackage[] {
  const count = Math.max(0, Math.floor(remainingQty));
  if (count <= 0) return [];

  const orients = getAllowedOrientations(targetSpec, allowGlobalRotation, space, loadingDirection);
  if (orients.length === 0) return [];

  const rehydrate = (): ContainerState => {
    const c = new ContainerState(
      space,
      containerIndex,
      Math.min(targetSpec.length, targetSpec.width, targetSpec.height)
    );
    const orderedExisting = [...existingInContainer].sort(
      (a, b) => a.y - b.y || a.stepIndex - b.stepIndex
    );
    for (const box of orderedExisting) {
      const sp = specsMap.get(box.packageId) ?? {
        ...targetSpec,
        id: box.packageId,
        sku: box.sku,
        name: box.name,
        category: box.category,
        color: box.color,
        weight: box.weight,
        fragile: box.fragile,
        stackable: box.stackable,
        thisSideUp: box.thisSideUp,
      };
      const chk = c.canPlaceAt(box.x, box.y, box.z, box.dx, box.dy, box.dz, sp);
      c.commitPlacement(
        box.x,
        box.y,
        box.z,
        { dx: box.dx, dy: box.dy, dz: box.dz, label: box.orientationLabel },
        sp,
        chk.ok ? chk.supporters : [],
        box.supportedAreaPct,
        loadingDirection,
        box.instanceId
      );
    }
    return c;
  };

  let bestNewBoxes: PlacedInternal[] = [];

  // Candidate Approach 1: Block tiling in remaining free boxes (especially empty or front-open)
  {
    const c = rehydrate();
    // Test largest free boxes for block placement, sorted largest volume first
    const candidateRegions: FreeBox[] =
      c.placed.length === 0
        ? [
            {
              x: 0,
              y: 0,
              z: 0,
              dx: space.internalLength,
              dy: space.internalHeight,
              dz: space.internalWidth,
            },
          ]
        : [...c.freeBoxes].sort((a, b) => b.dx * b.dy * b.dz - a.dx * a.dy * a.dz).slice(0, 6);

    for (const reg of candidateRegions) {
      const remLeft = count - (c.placed.length - existingInContainer.length);
      if (remLeft <= 0) break;
      const baseReg: FreeBox = {
        ...reg,
        y: reg.y <= EPS ? 0 : c.computeDropY(reg.x, reg.z, targetSpec.length, targetSpec.width),
      };
      baseReg.dy = Math.max(0, space.internalHeight - baseReg.y);
      const plans = generateBlockLayoutsInBox(baseReg, orients, targetSpec, loadingDirection, preferredOrientation);
      if (plans[0] && plans[0].length > 0) {
        tryTryCommitBlockPlan(c, plans[0], targetSpec, remLeft, c.spaceVolume, 1, loadingDirection);
      }
    }

    // Finish any residual gaps via greedy extreme-point placement
    while (c.placed.length - existingInContainer.length < count) {
      if (c.totalWeight + targetSpec.weight > c.space.maxPayload + 0.01) break;
      const best = tryPickBestPlacementForSpec(c, targetSpec, orients, 'wall_tiling', 'max_volume', loadingDirection);
      if (!best) break;
      c.commitPlacement(
        best.x,
        best.y,
        best.z,
        best.o,
        targetSpec,
        best.supporters,
        best.supportedAreaPct,
        loadingDirection
      );
    }
    bestNewBoxes = c.placed.slice(existingInContainer.length);
  }

  // Candidate Approach 2: Pure Extreme Points + Preferred Orientation Sweep
  if (bestNewBoxes.length < count) {
    const c2 = rehydrate();
    const prefFirst = [
      preferredOrientation,
      ...orients.filter(
        (o) =>
          Math.abs(o.dx - preferredOrientation.dx) > EPS ||
          Math.abs(o.dy - preferredOrientation.dy) > EPS ||
          Math.abs(o.dz - preferredOrientation.dz) > EPS
      ),
    ];
    while (c2.placed.length - existingInContainer.length < count) {
      if (c2.totalWeight + targetSpec.weight > c2.space.maxPayload + 0.01) break;
      const best = tryPickBestPlacementForSpec(c2, targetSpec, prefFirst, 'bfd', 'max_volume', loadingDirection);
      if (!best) break;
      c2.commitPlacement(
        best.x,
        best.y,
        best.z,
        best.o,
        targetSpec,
        best.supporters,
        best.supportedAreaPct,
        loadingDirection
      );
    }
    const altBoxes = c2.placed.slice(existingInContainer.length);
    if (altBoxes.length > bestNewBoxes.length) {
      bestNewBoxes = altBoxes;
    }
  }

  const baseTime = Date.now();
  const rawNew: PlacedPackage[] = bestNewBoxes.map((p, idx) => {
    const { currentLoadAbove: _a, currentLayersAbove: _b, supporters: _c, spec: _d, ...clean } = p;
    return {
      ...clean,
      instanceId: `man-${targetSpec.sku}-${baseTime}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
    };
  });

  // Topologically reorder newly added boxes inside-to-outside
  const orderedNew = reorderLoadingSequence(rawNew, loadingDirection);
  const startStep = existingInContainer.length + 1;
  return orderedNew.map((b, idx) => ({ ...b, stepIndex: startStep + idx }));
}

function reorderLoadingSequence(
  placed: PlacedPackage[],
  loadingDirection: LoadingDirection
): PlacedPackage[] {
  const byContainer = new Map<number, PlacedPackage[]>();
  for (const p of placed) {
    const arr = byContainer.get(p.containerIndex) ?? [];
    arr.push(p);
    byContainer.set(p.containerIndex, arr);
  }

  const compareInsideOut = (a: PlacedPackage, b: PlacedPackage): number => {
    if (loadingDirection === 'rear') {
      if (Math.abs(a.x - b.x) > 10) return a.x - b.x;
      if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
      return a.z - b.z;
    }
    if (loadingDirection === 'side') {
      if (Math.abs(a.z - b.z) > 10) return a.z - b.z;
      if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
      return a.x - b.x;
    }
    if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
    if (Math.abs(a.x - b.x) > 10) return a.x - b.x;
    return a.z - b.z;
  };

  const result: PlacedPackage[] = [];
  const sortedContIndices = Array.from(byContainer.keys()).sort((a, b) => a - b);

  for (const cIdx of sortedContIndices) {
    const group = byContainer.get(cIdx) ?? [];
    const n = group.length;
    const supportersOf: number[][] = Array.from({ length: n }, () => []);

    for (let i = 0; i < n; i++) {
      const top = group[i];
      if (top.y <= EPS) continue;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const bot = group[j];
        if (Math.abs(bot.y + bot.dy - top.y) <= 0.5) {
          if (
            overlap1D(top.x, top.x + top.dx, bot.x, bot.x + bot.dx) > EPS &&
            overlap1D(top.z, top.z + top.dz, bot.z, bot.z + bot.dz) > EPS
          ) {
            supportersOf[i].push(j);
          }
        }
      }
    }

    const done = new Array<boolean>(n).fill(false);
    let step = 1;
    for (let k = 0; k < n; k++) {
      let bestIdx = -1;
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        const ready = supportersOf[i].every((supIdx) => done[supIdx]);
        if (!ready) continue;
        if (bestIdx === -1 || compareInsideOut(group[i], group[bestIdx]) < 0) {
          bestIdx = i;
        }
      }
      if (bestIdx === -1) {
        for (let i = 0; i < n; i++) {
          if (!done[i] && (bestIdx === -1 || compareInsideOut(group[i], group[bestIdx]) < 0)) {
            bestIdx = i;
          }
        }
      }
      if (bestIdx !== -1) {
        done[bestIdx] = true;
        result.push({ ...group[bestIdx], stepIndex: step++ });
      }
    }
  }

  return result;
}

function computeBalanceScore(cont: ContainerState): { cog: { x: number; y: number; z: number }; score: number } {
  if (cont.totalWeight <= 0) {
    return {
      cog: {
        x: cont.space.internalLength / 2,
        y: 0,
        z: cont.space.internalWidth / 2,
      },
      score: 100,
    };
  }
  const cx = cont.weightedX / cont.totalWeight;
  const cy = cont.weightedY / cont.totalWeight;
  const cz = cont.weightedZ / cont.totalWeight;

  const devX = Math.abs(cx - cont.space.internalLength / 2) / (cont.space.internalLength / 2);
  const devZ = Math.abs(cz - cont.space.internalWidth / 2) / (cont.space.internalWidth / 2);
  const score = Math.max(0, Math.min(100, Math.round((1 - (devX * 0.55 + devZ * 0.45)) * 100)));
  return {
    cog: {
      x: Math.round(cx),
      y: Math.round(cy),
      z: Math.round(cz),
    },
    score,
  };
}

function diagnoseUnloaded(
  specs: PackageSpec[],
  placed: PlacedPackage[],
  spacesList: LoadingSpace[],
  allowRotation: boolean,
  loadingDirection: LoadingDirection
): { details: UnloadedPackageReason[]; warnings: OptimizationWarning[] } {
  const space = spacesList[0];
  const totalPayloadCap = spacesList.reduce((s, sp) => s + sp.maxPayload, 0);
  const loadedBySpec = new Map<string, number>();
  for (const p of placed) {
    loadedBySpec.set(p.packageId, (loadedBySpec.get(p.packageId) ?? 0) + 1);
  }
  const totalLoadedWeight = placed.reduce((s, p) => s + p.weight, 0);

  const details: UnloadedPackageReason[] = [];
  const warnings: OptimizationWarning[] = [];

  for (const spec of specs) {
    const req = Math.max(0, Math.floor(spec.quantity));
    const loaded = loadedBySpec.get(spec.id) ?? 0;
    const unloaded = req - loaded;
    if (unloaded <= 0) continue;

    const reasons: UnloadedReasonCode[] = [];
    const notes: string[] = [];

    const fitsInAny = spacesList.some(
      (sp) => getAllowedOrientations(spec, allowRotation, sp, loadingDirection).length > 0
    );
    const fitsRawInAny = spacesList.some(
      (sp) =>
        spec.length <= sp.internalLength + EPS &&
        spec.width <= sp.internalWidth + EPS &&
        spec.height <= sp.internalHeight + EPS
    );

    if (!fitsInAny) {
      if (!fitsRawInAny && (!allowRotation || !spec.rotatable)) {
        reasons.push('EXCEEDS_SPACE_DIMS', 'ORIENTATION_LOCKED');
        notes.push('Exceeds internal container dimensions with rotation disabled.');
      } else if (
        (loadingDirection === 'rear' &&
          spacesList.every((sp) => spec.width > sp.doorWidth || spec.height > sp.doorHeight)) ||
        (loadingDirection === 'side' &&
          spacesList.every((sp) => spec.length > sp.doorWidth || spec.height > sp.doorHeight))
      ) {
        reasons.push('EXCEEDS_DOOR_CLEARANCE');
        notes.push(`Exceeds ${loadingDirection} door opening (${space.doorWidth}×${space.doorHeight} mm).`);
      } else {
        reasons.push('EXCEEDS_SPACE_DIMS');
        notes.push('Package dimensions exceed internal space dimensions in all allowed orientations.');
      }
    }

    const maxSinglePayload = Math.max(...spacesList.map((sp) => sp.maxPayload));
    if (spec.weight > maxSinglePayload) {
      reasons.push('EXCEEDS_PAYLOAD');
      notes.push(`Single unit weight (${spec.weight} kg) exceeds container max payload (${maxSinglePayload} kg).`);
    } else if (totalLoadedWeight + spec.weight > totalPayloadCap) {
      reasons.push('EXCEEDS_PAYLOAD');
      notes.push(`Remaining payload (${Math.max(0, totalPayloadCap - totalLoadedWeight).toFixed(1)} kg) insufficient for ${spec.weight} kg unit.`);
    }

    if (
      spacesList.every(
        (sp) =>
          sp.floorWeightLimit &&
          sp.floorWeightLimit > 0 &&
          spec.weight / ((spec.length / 1000) * (spec.width / 1000)) > sp.floorWeightLimit
      )
    ) {
      reasons.push('FLOOR_LOAD_EXCEEDED');
      notes.push(`Floor pressure exceeds ${space.floorWeightLimit} kg/m² limit.`);
    }

    if (reasons.length === 0) {
      if (!spec.stackable || spec.fragile) {
        reasons.push('STACKING_RESTRICTION', 'INSUFFICIENT_SPACE');
        notes.push('Remaining free space or non-stackable/fragile placement constraints prevented additional units.');
      } else {
        reasons.push('INSUFFICIENT_SPACE');
        notes.push('Available internal volume or valid supported positions exhausted.');
      }
    }

    details.push({
      packageId: spec.id,
      sku: spec.sku,
      name: spec.name,
      requestedQty: req,
      loadedQty: loaded,
      unloadedQty: unloaded,
      reasons,
      detail: notes.join(' '),
    });
  }

  if (details.length > 0) {
    const totalUnloaded = details.reduce((s, d) => s + d.unloadedQty, 0);
    warnings.push({
      severity: 'warning',
      code: 'UNLOADED_CARGO',
      message: `${totalUnloaded} package(s) across ${details.length} SKU(s) could not be loaded under current space and physical constraints.`,
    });
  }

  if (details.some((d) => d.reasons.includes('EXCEEDS_DOOR_CLEARANCE'))) {
    warnings.push({
      severity: 'error',
      code: 'DOOR_CLEARANCE',
      message: 'One or more packages exceed the configured door clearance dimensions.',
    });
  }

  if (details.some((d) => d.reasons.includes('EXCEEDS_PAYLOAD'))) {
    warnings.push({
      severity: 'warning',
      code: 'PAYLOAD_LIMIT',
      message: 'Cargo loading stopped early to respect maximum payload capacity.',
    });
  }

  return { details, warnings };
}

export function runOptimization(options: OptimizeOptions): OptimizationResult {
  const startTime = performance.now();
  const {
    space,
    packages,
    mode,
    allowRotation,
    loadingDirection,
    targetUtilizationPct,
    autoDetermineContainers = false,
    preferKeepItemSameContainer = false,
    onProgress,
    shouldCancel,
  } = options;
  const effectiveTargetPct = Math.max(1, Math.min(100, targetUtilizationPct ?? 100));
  const rawConfiguredSpaces = options.spaces && options.spaces.length > 0 ? options.spaces : [space];
  const configuredSpaces = autoDetermineContainers ? [{ ...rawConfiguredSpaces[0] }] : rawConfiguredSpaces;
  const primarySpace = configuredSpaces[0];

  const totalRequiredPackages = packages.reduce(
    (s, p) => s + (p.length > 0 && p.width > 0 && p.height > 0 ? Math.max(0, Math.floor(p.quantity)) : 0),
    0
  );
  const totalCargoVolMm3 = packages.reduce(
    (s, p) =>
      s +
      (p.length > 0 && p.width > 0 && p.height > 0
        ? p.length * p.width * p.height * Math.max(0, Math.floor(p.quantity))
        : 0),
    0
  );
  const primaryVolMm3 = Math.max(
    1,
    primarySpace.internalLength * primarySpace.internalWidth * primarySpace.internalHeight
  );
  const estContainers = Math.max(
    configuredSpaces.length,
    Math.min(MAX_AUTO_CONTAINERS, Math.ceil(totalCargoVolMm3 / (primaryVolMm3 * 0.72)))
  );
  const isVeryLargeFleet = estContainers >= 80 || totalRequiredPackages >= 6000;
  const isMediumLargeFleet = estContainers >= 30 || totalRequiredPackages >= 1500;

  const activeStrategies = isVeryLargeFleet
    ? STRATEGIES.slice(0, 2)
    : isMediumLargeFleet
      ? STRATEGIES.slice(0, 4)
      : STRATEGIES;

  const candidateRuns: { strat: StrategyConfig; keepMode: KeepSameContainerMode; recordBenchmark: boolean }[] =
    preferKeepItemSameContainer
      ? [
          ...activeStrategies.map((strat) => ({
            strat,
            keepMode: 'whole_first' as KeepSameContainerMode,
            recordBenchmark: true,
          })),
          ...(isMediumLargeFleet
            ? [
                {
                  strat: activeStrategies[0],
                  keepMode: 'consolidate_strict' as KeepSameContainerMode,
                  recordBenchmark: false,
                },
              ]
            : [
                {
                  strat: activeStrategies[0],
                  keepMode: 'consolidate_strict' as KeepSameContainerMode,
                  recordBenchmark: false,
                },
                {
                  strat: activeStrategies[1] ?? activeStrategies[0],
                  keepMode: 'consolidate_strict' as KeepSameContainerMode,
                  recordBenchmark: false,
                },
                {
                  strat: activeStrategies[5] ?? activeStrategies[0],
                  keepMode: 'consolidate_strict' as KeepSameContainerMode,
                  recordBenchmark: false,
                },
              ]),
        ]
      : activeStrategies.map((strat) => ({
          strat,
          keepMode: 'none' as KeepSameContainerMode,
          recordBenchmark: true,
        }));

  const benchmarks: StrategyBenchmark[] = [];
  let winner: {
    strategy: StrategyConfig;
    containers: ContainerState[];
    placed: PlacedPackage[];
    emptySpaces: EmptySpaceBox[];
    volumePct: number;
    weightPct: number;
    balanceScore: number;
    score: number;
    valid: boolean;
  } | null = null;

  for (let i = 0; i < candidateRuns.length; i++) {
    if (shouldCancel && shouldCancel()) break;
    const { strat, keepMode, recordBenchmark } = candidateRuns[i];
    const basePct = (i / candidateRuns.length) * 85;
    const spanPct = (1 / candidateRuns.length) * 85;
    onProgress?.(Math.round(basePct + spanPct * 0.1), strat.name);

    const t0 = performance.now();
    const run = packSingleStrategy(
      configuredSpaces,
      packages,
      strat.id,
      mode,
      allowRotation,
      loadingDirection,
      effectiveTargetPct,
      autoDetermineContainers,
      shouldCancel,
      keepMode,
      (cIdx) => {
        if (estContainers >= 8 && (cIdx === 0 || cIdx % 4 === 0)) {
          const frac = Math.min(0.95, (cIdx + 1) / Math.max(1, estContainers));
          onProgress?.(Math.round(basePct + spanPct * frac), strat.name);
        }
      }
    );
    if (run.cancelled) break;

    const rawPlaced: PlacedPackage[] = [];
    const emptySpaces: EmptySpaceBox[] = [];
    for (const c of run.containers) {
      for (const p of c.placed) {
        const { currentLoadAbove: _a, currentLayersAbove: _b, supporters: _c, spec: _d, ...clean } = p;
        rawPlaced.push(clean);
      }
      for (const fb of c.freeBoxes) {
        emptySpaces.push({ containerIndex: c.containerIndex, ...fb });
      }
    }

    const orderedPlaced = reorderLoadingSequence(rawPlaced, loadingDirection);
    const containerSpacesList = run.containers.map((c) => c.space);
    const verification = verifyPackingSolution(
      containerSpacesList,
      packages,
      orderedPlaced,
      allowRotation,
      loadingDirection
    );

    const usedContainers = run.containers.filter((c) => c.placed.length > 0);
    const containersUsed = usedContainers.length;
    const metricContainers = usedContainers.length > 0 ? usedContainers : run.containers.slice(0, 1);

    const totalSpaceVol = metricContainers.reduce((s, c) => s + c.spaceVolume, 0);
    const totalPayloadCap = metricContainers.reduce((s, c) => s + c.space.maxPayload, 0);
    const occupiedVol = metricContainers.reduce((s, c) => s + c.occupiedVolume, 0);
    const totalWeight = metricContainers.reduce((s, c) => s + c.totalWeight, 0);
    const volumePct = totalSpaceVol > 0 ? Math.round((occupiedVol / totalSpaceVol) * 10000) / 100 : 0;
    const weightPct =
      totalPayloadCap > 0 ? Math.round((totalWeight / totalPayloadCap) * 10000) / 100 : 0;
    const avgBalance = Math.round(
      metricContainers.reduce((s, c) => s + computeBalanceScore(c).score, 0) /
        Math.max(1, metricContainers.length)
    );

    const dt = Math.round(performance.now() - t0);
    if (recordBenchmark) {
      benchmarks.push({
        strategyId: strat.id,
        strategyName: strat.name,
        loadedCount: orderedPlaced.length,
        totalRequested: totalRequiredPackages,
        volumeUtilizationPct: volumePct,
        weightUtilizationPct: weightPct,
        containersUsed,
        balanceScore: avgBalance,
        valid: verification.isValid,
        durationMs: dt,
      });
    }

    const loadedRatio = orderedPlaced.length / Math.max(1, totalRequiredPackages);
    const allLoadedBonus = orderedPlaced.length === totalRequiredPackages ? 500_000 : 0;
    // Reward front-loading earlier containers maximally up to targetUtilizationPct so trailing containers stay empty/minimal
    const compactionBonus = run.containers.reduce((s, c, idx) => {
      const fillPct = c.spaceVolume > 0 ? (c.occupiedVolume / c.spaceVolume) * 100 : 0;
      return s + fillPct * (run.containers.length - idx) * 20;
    }, 0);

    // Count how many times individual SKUs were split across multiple containers
    let skuSplitCount = 0;
    if (preferKeepItemSameContainer) {
      const contsPerSku = new Map<string, Set<number>>();
      for (const p of orderedPlaced) {
        let set = contsPerSku.get(p.packageId);
        if (!set) {
          set = new Set<number>();
          contsPerSku.set(p.packageId, set);
        }
        set.add(p.containerIndex);
      }
      for (const set of contsPerSku.values()) {
        if (set.size > 1) skuSplitCount += set.size - 1;
      }
    }
    const splitPenalty = preferKeepItemSameContainer
      ? skuSplitCount * (mode === 'min_vehicles' ? 40_000 : 180_000)
      : 0;

    let objScore = 0;
    if (!verification.isValid) {
      objScore = -1e9;
    } else {
      switch (mode) {
        case 'max_volume':
          objScore =
            allLoadedBonus +
            occupiedVol / 1e6 +
            volumePct * 1200 +
            compactionBonus +
            loadedRatio * 50_000 -
            containersUsed * 30_000 -
            splitPenalty;
          break;
        case 'max_count':
          objScore =
            orderedPlaced.length * 10_000 +
            volumePct * 100 +
            compactionBonus * 0.5 -
            containersUsed * 15_000 -
            splitPenalty;
          break;
        case 'min_vehicles':
          objScore =
            allLoadedBonus +
            loadedRatio * 200_000 -
            containersUsed * 60_000 +
            volumePct * 200 +
            compactionBonus -
            splitPenalty;
          break;
        case 'weight_balance':
          objScore =
            allLoadedBonus +
            loadedRatio * 100_000 +
            avgBalance * 600 +
            volumePct * 250 +
            compactionBonus * 0.4 -
            containersUsed * 30_000 -
            splitPenalty;
          break;
        case 'balanced':
        default:
          objScore =
            allLoadedBonus +
            loadedRatio * 150_000 +
            volumePct * 500 +
            avgBalance * 80 +
            compactionBonus -
            containersUsed * 30_000 -
            splitPenalty;
          break;
      }
    }

    if (!winner || objScore > winner.score) {
      winner = {
        strategy: strat,
        containers: run.containers,
        placed: orderedPlaced,
        emptySpaces,
        volumePct,
        weightPct,
        balanceScore: avgBalance,
        score: objScore,
        valid: verification.isValid,
      };
    }
  }

  onProgress?.(95, 'Verifying physical constraints...');

  let finalContainers =
    winner?.containers ?? configuredSpaces.map((sp, i) => new ContainerState(sp, i));
  if (autoDetermineContainers) {
    const nonEmpty = finalContainers.filter((c) => c.placed.length > 0);
    finalContainers = nonEmpty.length > 0 ? nonEmpty : finalContainers.slice(0, 1);
  }

  const finalPlaced = winner?.placed ?? [];
  const finalEmptySpaces = winner?.emptySpaces ?? [];
  const finalSpacesList = finalContainers.map((c) => c.space);
  const verification = verifyPackingSolution(
    finalSpacesList,
    packages,
    finalPlaced,
    allowRotation,
    loadingDirection
  );

  const usedContainers = finalContainers.filter((c) => c.placed.length > 0);
  const containersUsed = usedContainers.length;
  const metricContainers = usedContainers.length > 0 ? usedContainers : finalContainers.slice(0, 1);

  const totalSpaceVol = metricContainers.reduce((s, c) => s + c.spaceVolume, 0);
  const occupiedVol = metricContainers.reduce((s, c) => s + c.occupiedVolume, 0);
  const totalCargoWeightKg =
    Math.round(metricContainers.reduce((s, c) => s + c.totalWeight, 0) * 100) / 100;
  const totalPayloadCap = metricContainers.reduce((s, c) => s + c.space.maxPayload, 0);

  const containerSummaries: ContainerSummary[] = finalContainers.map((c) => {
    const bal = computeBalanceScore(c);
    const cVol = c.spaceVolume;
    return {
      containerIndex: c.containerIndex,
      space: c.space,
      loadedCount: c.placed.length,
      occupiedVolumeMm3: c.occupiedVolume,
      volumeUtilizationPct: cVol > 0 ? Math.round((c.occupiedVolume / cVol) * 10000) / 100 : 0,
      loadedWeightKg: Math.round(c.totalWeight * 100) / 100,
      weightUtilizationPct:
        c.space.maxPayload > 0 ? Math.round((c.totalWeight / c.space.maxPayload) * 10000) / 100 : 0,
      centerOfGravity: bal.cog,
      balanceScore: bal.score,
    };
  });

  const firstBal = containerSummaries[0] ?? {
    centerOfGravity: { x: primarySpace.internalLength / 2, y: 0, z: primarySpace.internalWidth / 2 },
    balanceScore: 100,
  };

  const { details: unloadedDetails, warnings } = diagnoseUnloaded(
    packages,
    finalPlaced,
    finalSpacesList,
    allowRotation,
    loadingDirection
  );

  if (!verification.isValid) {
    warnings.unshift({
      severity: 'error',
      code: 'PHYSICS_VERIFICATION_FAILED',
      message: verification.violations[0] ?? 'Physical constraint verification failed.',
    });
  }

  let estimatedTrips = Math.max(1, containersUsed);
  if (
    mode !== 'min_vehicles' &&
    !autoDetermineContainers &&
    finalPlaced.length > 0 &&
    finalPlaced.length < totalRequiredPackages
  ) {
    const estByCount = Math.ceil(totalRequiredPackages / Math.max(1, finalPlaced.length));
    estimatedTrips = Math.max(1, estByCount);
  }

  onProgress?.(100, 'Complete');

  return {
    id: `opt-${Date.now()}`,
    timestamp: Date.now(),
    mode,
    strategyName: winner?.strategy.name ?? STRATEGIES[0].name,
    allowRotation,
    loadingDirection,
    totalRequiredPackages,
    loadedPackagesCount: finalPlaced.length,
    unloadedPackagesCount: totalRequiredPackages - finalPlaced.length,
    containersUsed,
    configuredContainersCount: finalContainers.length,
    autoDeterminedContainers: autoDetermineContainers,
    targetUtilizationPct: effectiveTargetPct,
    preferKeepItemSameContainer,
    estimatedTrips,
    spaceVolumeMm3: totalSpaceVol,
    occupiedVolumeMm3: occupiedVol,
    remainingVolumeMm3: Math.max(0, totalSpaceVol - occupiedVol),
    volumeUtilizationPct: totalSpaceVol > 0 ? Math.round((occupiedVol / totalSpaceVol) * 10000) / 100 : 0,
    totalCargoWeightKg,
    remainingPayloadKg: Math.max(0, Math.round((totalPayloadCap - totalCargoWeightKg) * 100) / 100),
    weightUtilizationPct:
      totalPayloadCap > 0 ? Math.round((totalCargoWeightKg / totalPayloadCap) * 10000) / 100 : 0,
    centerOfGravity: firstBal.centerOfGravity,
    balanceScore: winner?.balanceScore ?? firstBal.balanceScore,
    placedPackages: finalPlaced,
    emptySpaces: finalEmptySpaces,
    containerSummaries,
    unloadedDetails,
    warnings,
    strategyComparison: benchmarks,
    verification,
    durationMs: Math.round(performance.now() - startTime),
  };
}
