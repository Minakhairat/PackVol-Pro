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

interface Orientation {
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
  /** Cached cumulative weight currently sitting directly/indirectly on top of this box */
  currentLoadAbove: number;
  /** Cached max layers above this box */
  currentLayersAbove: number;
  /** Direct supporters with proportional area shares */
  supporters: { idx: number; share: number }[];
  spec: PackageSpec;
}

export interface OptimizeOptions {
  space: LoadingSpace;
  packages: PackageSpec[];
  mode: OptimizationMode;
  allowRotation: boolean;
  loadingDirection: LoadingDirection;
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

  // Filter out duplicates and orientations that exceed space or door dimensions
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
  freeBoxes: FreeBox[] = [];
  totalWeight = 0;
  occupiedVolume = 0;
  weightedX = 0;
  weightedY = 0;
  weightedZ = 0;

  constructor(public space: LoadingSpace, public containerIndex: number) {
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

    // 1. Bounds
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

    // 2. Payload
    if (this.totalWeight + spec.weight > this.space.maxPayload + 0.01) {
      return { ok: false, supporters: [], supportedAreaPct: 0 };
    }

    // 3. Floor pressure limit check (kg/m^2) if box sits on floor
    if (y <= EPS && this.space.floorWeightLimit && this.space.floorWeightLimit > 0) {
      const footprintM2 = (dx / 1000) * (dz / 1000);
      if (footprintM2 > 0 && spec.weight / footprintM2 > this.space.floorWeightLimit + 0.1) {
        return { ok: false, supporters: [], supportedAreaPct: 0 };
      }
    }

    // 4. Collision + Support gathering
    const directSupporters: { idx: number; area: number }[] = [];
    let supportedArea = 0;
    let minSupX = Infinity;
    let maxSupX = -Infinity;
    let minSupZ = Infinity;
    let maxSupZ = -Infinity;

    for (let i = 0; i < this.placed.length; i++) {
      const b = this.placed[i];

      // Quick Y separation check
      if (y >= b.y + b.dy - EPS) {
        // Check if b directly supports candidate
        if (y > EPS && Math.abs(b.y + b.dy - y) <= 0.5) {
          const ox = overlap1D(x, x + dx, b.x, b.x + b.dx);
          if (ox > EPS) {
            const oz = overlap1D(z, z + dz, b.z, b.z + b.dz);
            if (oz > EPS) {
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
        }
        continue;
      }

      if (y + dy <= b.y + EPS) continue;

      // Full 3D AABB collision check
      const ox = overlap1D(x, x + dx, b.x, b.x + b.dx);
      if (ox <= EPS) continue;
      const oz = overlap1D(z, z + dz, b.z, b.z + b.dz);
      if (oz > EPS) {
        return { ok: false, supporters: [], supportedAreaPct: 0 };
      }
    }

    if (y <= EPS) {
      return { ok: true, supporters: [], supportedAreaPct: 100 };
    }

    const baseArea = dx * dz;
    const supportedRatio = baseArea > 0 ? supportedArea / baseArea : 0;
    if (supportedRatio < 0.68) {
      return { ok: false, supporters: [], supportedAreaPct: supportedRatio * 100 };
    }

    // Center of gravity overhang check (CoG must sit inside supported bounding span)
    const cx = x + dx / 2;
    const cz = z + dz / 2;
    if (cx < minSupX - dx * 0.08 || cx > maxSupX + dx * 0.08 || cz < minSupZ - dz * 0.08 || cz > maxSupZ + dz * 0.08) {
      return { ok: false, supporters: [], supportedAreaPct: supportedRatio * 100 };
    }

    // Check transitive stack weight and stack layer limits on all ancestors
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
      // Floor pressure limit under ground-level boxes
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

  commitPlacement(
    x: number,
    y: number,
    z: number,
    o: Orientation,
    item: PackItem,
    supporters: { idx: number; share: number }[],
    supportedAreaPct: number
  ): void {
    let maxSupLayer = -1;
    for (const s of supporters) {
      maxSupLayer = Math.max(maxSupLayer, this.placed[s.idx].layerIndex);
    }

    const placedBox: PlacedInternal = {
      instanceId: `${item.spec.sku}-${this.containerIndex + 1}-${this.placed.length + 1}`,
      packageId: item.spec.id,
      sku: item.spec.sku,
      name: item.spec.name,
      category: item.spec.category,
      color: item.spec.color,
      containerIndex: this.containerIndex,
      stepIndex: this.placed.length + 1,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      z: Math.round(z * 100) / 100,
      dx: o.dx,
      dy: o.dy,
      dz: o.dz,
      weight: item.spec.weight,
      orientationLabel: o.label,
      layerIndex: y <= EPS ? 0 : maxSupLayer + 1,
      fragile: item.spec.fragile,
      stackable: item.spec.stackable,
      thisSideUp: item.spec.thisSideUp,
      supportedAreaPct,
      currentLoadAbove: 0,
      currentLayersAbove: 0,
      supporters,
      spec: item.spec,
    };

    this.placed.push(placedBox);
    if (supporters.length > 0) {
      this.propagateStackLoad(supporters, item.spec.weight, 1);
    }

    this.totalWeight += item.spec.weight;
    this.occupiedVolume += o.dx * o.dy * o.dz;
    this.weightedX += item.spec.weight * (x + o.dx / 2);
    this.weightedY += item.spec.weight * (y + o.dy / 2);
    this.weightedZ += item.spec.weight * (z + o.dz / 2);

    this.updateExtremePoints(x, y, z, o.dx, o.dy, o.dz);
    this.updateFreeBoxes(x, y, z, o.dx, o.dy, o.dz);
  }

  private updateExtremePoints(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    const newPts: Point3D[] = [
      { x: x + dx, y, z },
      { x, y, z: z + dz },
      { x, y: y + dy, z },
    ];

    // Projection points onto floor or nearby box edges for tight packing
    for (const b of this.placed) {
      if (b.x + b.dx <= x + EPS && b.z < z + dz && b.z + b.dz > z) {
        newPts.push({ x: x + dx, y, z: Math.max(z, b.z) });
      }
      if (b.z + b.dz <= z + EPS && b.x < x + dx && b.x + b.dx > x) {
        newPts.push({ x: Math.max(x, b.x), y, z: z + dz });
      }
    }

    const L = this.space.internalLength;
    const H = this.space.internalHeight;
    const W = this.space.internalWidth;

    const existing = new Set(
      this.extremePoints.map((p) => `${Math.round(p.x)}_${Math.round(p.y)}_${Math.round(p.z)}`)
    );

    // Filter out points strictly inside the newly placed box
    this.extremePoints = this.extremePoints.filter(
      (p) =>
        !(
          p.x >= x - EPS &&
          p.x < x + dx - EPS &&
          p.y >= y - EPS &&
          p.y < y + dy - EPS &&
          p.z >= z - EPS &&
          p.z < z + dz - EPS
        )
    );

    for (const pt of newPts) {
      if (pt.x > L - 1 || pt.y > H - 1 || pt.z > W - 1) continue;
      const key = `${Math.round(pt.x)}_${Math.round(pt.y)}_${Math.round(pt.z)}`;
      if (!existing.has(key)) {
        existing.add(key);
        this.extremePoints.push(pt);
      }
    }

    // Cap EP list if very large to keep O(N) snappy on 1000+ boxes
    if (this.extremePoints.length > 350) {
      this.extremePoints.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
      this.extremePoints.length = 350;
    }
  }

  private updateFreeBoxes(px: number, py: number, pz: number, pdx: number, pdy: number, pdz: number): void {
    const next: FreeBox[] = [];
    for (const fb of this.freeBoxes) {
      const ox = overlap1D(px, px + pdx, fb.x, fb.x + fb.dx);
      const oy = overlap1D(py, py + pdy, fb.y, fb.y + fb.dy);
      const oz = overlap1D(pz, pz + pdz, fb.z, fb.z + fb.dz);

      if (ox <= EPS || oy <= EPS || oz <= EPS) {
        next.push(fb);
        continue;
      }

      // Guillotine split of overlapping free box into up to 6 sub-boxes
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

    // Prune tiny boxes and strictly contained duplicates
    const filtered = next.filter((b) => b.dx >= 50 && b.dy >= 50 && b.dz >= 50);
    filtered.sort((a, b) => b.dx * b.dy * b.dz - a.dx * a.dy * a.dz);
    const pruned: FreeBox[] = [];
    for (let i = 0; i < filtered.length && pruned.length < 180; i++) {
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

type StrategyId = 'ep_lvb' | 'ep_laf' | 'bfd' | 'ffd' | 'layer_shelf' | 'guillotine';

interface StrategyConfig {
  id: StrategyId;
  name: string;
}

const STRATEGIES: StrategyConfig[] = [
  { id: 'ep_lvb', name: 'Extreme Points · Largest Volume First' },
  { id: 'ep_laf', name: 'Extreme Points · Largest Base Area First' },
  { id: 'bfd', name: 'Best Fit Decreasing (Residual Minimize)' },
  { id: 'ffd', name: 'First Fit Decreasing (Fast Directional)' },
  { id: 'layer_shelf', name: 'Layer-Based Shelf Packing' },
  { id: 'guillotine', name: 'Guillotine Space Splitting' },
];

function sortItemsForStrategy(items: PackItem[], strategy: StrategyId, mode: OptimizationMode): PackItem[] {
  const arr = [...items];
  arr.sort((a, b) => {
    // Priority always matters first if explicitly high/low difference, then stackability/fragile
    if (a.spec.priority !== b.spec.priority) return b.spec.priority - a.spec.priority;
    if (a.spec.fragile !== b.spec.fragile) return a.spec.fragile ? 1 : -1;
    if (a.spec.stackable !== b.spec.stackable) return a.spec.stackable ? -1 : 1;

    if (mode === 'max_count') {
      // Smaller volume first to maximize package count
      return a.volume - b.volume;
    }
    if (mode === 'weight_balance') {
      // Heavy items first so they anchor the floor
      if (Math.abs(b.spec.weight - a.spec.weight) > 1) return b.spec.weight - a.spec.weight;
    }

    switch (strategy) {
      case 'ep_laf':
        return b.baseArea - a.baseArea || b.volume - a.volume;
      case 'layer_shelf':
        return b.spec.height - a.spec.height || b.baseArea - a.baseArea;
      case 'bfd':
      case 'ffd':
      case 'guillotine':
      case 'ep_lvb':
      default:
        return b.volume - a.volume || b.baseArea - a.baseArea;
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
  item: PackItem,
  strategy: StrategyId,
  mode: OptimizationMode,
  loadingDirection: LoadingDirection
): number {
  const { internalLength: L, internalWidth: W, internalHeight: H } = c.space;

  // Lower score is better
  let dirPenalty = x * 1.1 + z * 0.4 + y * 2.4;
  if (loadingDirection === 'side') {
    dirPenalty = z * 1.1 + x * 0.4 + y * 2.4;
  } else if (loadingDirection === 'top') {
    dirPenalty = y * 3.0 + x * 0.6 + z * 0.6;
  }

  // Residual wall/gap fit bonus
  const remX = L - (x + o.dx);
  const remZ = W - (z + o.dz);
  const remY = H - (y + o.dy);
  const fitTightness =
    (remX < 5 ? -400 : remX * 0.08) +
    (remZ < 5 ? -400 : remZ * 0.08) +
    (remY < 5 ? -200 : remY * 0.05);

  if (mode === 'weight_balance' || mode === 'balanced') {
    const newW = c.totalWeight + item.spec.weight;
    const newCogX = (c.weightedX + item.spec.weight * (x + o.dx / 2)) / Math.max(1, newW);
    const newCogZ = (c.weightedZ + item.spec.weight * (z + o.dz / 2)) / Math.max(1, newW);
    const cogOffset = Math.abs(newCogX - L / 2) / L + Math.abs(newCogZ - W / 2) / W;
    const cogWeight = mode === 'weight_balance' ? 6000 : 1800;
    const heightWeight = item.spec.weight * (y / Math.max(1, H)) * (mode === 'weight_balance' ? 35 : 10);

    if (strategy === 'bfd') {
      return dirPenalty * 0.6 + fitTightness + cogOffset * cogWeight + heightWeight;
    }
    return dirPenalty + cogOffset * cogWeight + heightWeight;
  }

  if (strategy === 'bfd') {
    return dirPenalty * 0.7 + fitTightness;
  }
  if (strategy === 'layer_shelf') {
    return y * 5.0 + x * 1.0 + z * 0.5;
  }
  return dirPenalty;
}

function packSingleStrategy(
  space: LoadingSpace,
  baseItems: PackItem[],
  strategy: StrategyId,
  mode: OptimizationMode,
  loadingDirection: LoadingDirection,
  shouldCancel?: () => boolean
): {
  containers: ContainerState[];
  unloadedItems: PackItem[];
  cancelled: boolean;
} {
  const ordered = sortItemsForStrategy(baseItems, strategy, mode);
  const multiContainer = mode === 'min_vehicles';
  const maxContainers = multiContainer ? 40 : 1;

  const containers: ContainerState[] = [new ContainerState(space, 0)];
  const unloadedItems: PackItem[] = [];

  for (let idx = 0; idx < ordered.length; idx++) {
    if (shouldCancel && idx % 25 === 0 && shouldCancel()) {
      return { containers, unloadedItems, cancelled: true };
    }

    const item = ordered[idx];
    if (item.orientations.length === 0) {
      unloadedItems.push(item);
      continue;
    }

    let placed = false;

    for (let cIdx = 0; cIdx < containers.length; cIdx++) {
      const cont = containers[cIdx];
      if (cont.totalWeight + item.spec.weight > space.maxPayload + 0.01) continue;

      const candidatePoints: Point3D[] =
        strategy === 'guillotine'
          ? cont.freeBoxes.map((fb) => ({ x: fb.x, y: fb.y, z: fb.z }))
          : cont.extremePoints;

      let bestScore = Infinity;
      let bestChoice: {
        x: number;
        y: number;
        z: number;
        o: Orientation;
        supporters: { idx: number; share: number }[];
        supportedAreaPct: number;
      } | null = null;

      // For FFD or large item sets (>400), take first valid fast candidate after directional sort
      const fastMode = strategy === 'ffd' || ordered.length > 450;
      const pts = fastMode
        ? [...candidatePoints].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z)
        : candidatePoints;

      for (let pIdx = 0; pIdx < pts.length; pIdx++) {
        const pt = pts[pIdx];
        for (const o of item.orientations) {
          const check = cont.canPlaceAt(pt.x, pt.y, pt.z, o.dx, o.dy, o.dz, item.spec);
          if (!check.ok) continue;

          if (fastMode && mode !== 'weight_balance') {
            bestChoice = {
              x: pt.x,
              y: pt.y,
              z: pt.z,
              o,
              supporters: check.supporters,
              supportedAreaPct: check.supportedAreaPct,
            };
            break;
          }

          const sc = scoreCandidate(cont, pt.x, pt.y, pt.z, o, item, strategy, mode, loadingDirection);
          if (sc < bestScore) {
            bestScore = sc;
            bestChoice = {
              x: pt.x,
              y: pt.y,
              z: pt.z,
              o,
              supporters: check.supporters,
              supportedAreaPct: check.supportedAreaPct,
            };
          }
        }
        if (fastMode && bestChoice && mode !== 'weight_balance') break;
      }

      if (bestChoice) {
        cont.commitPlacement(
          bestChoice.x,
          bestChoice.y,
          bestChoice.z,
          bestChoice.o,
          item,
          bestChoice.supporters,
          bestChoice.supportedAreaPct
        );
        placed = true;
        break;
      }
    }

    if (!placed && multiContainer && containers.length < maxContainers) {
      const nextCont = new ContainerState(space, containers.length);
      for (const o of item.orientations) {
        const check = nextCont.canPlaceAt(0, 0, 0, o.dx, o.dy, o.dz, item.spec);
        if (check.ok) {
          nextCont.commitPlacement(0, 0, 0, o, item, check.supporters, check.supportedAreaPct);
          containers.push(nextCont);
          placed = true;
          break;
        }
      }
    }

    if (!placed) {
      unloadedItems.push(item);
    }
  }

  return { containers, unloadedItems, cancelled: false };
}

function reorderLoadingSequence(
  placed: PlacedPackage[],
  loadingDirection: LoadingDirection
): PlacedPackage[] {
  const copy = [...placed];
  copy.sort((a, b) => {
    if (a.containerIndex !== b.containerIndex) return a.containerIndex - b.containerIndex;
    if (loadingDirection === 'rear') {
      // Load back-to-front (smaller X first), bottom-to-top (smaller Y), left-to-right (smaller Z)
      if (Math.abs(a.x - b.x) > 10) return a.x - b.x;
      if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
      return a.z - b.z;
    }
    if (loadingDirection === 'side') {
      if (Math.abs(a.z - b.z) > 10) return a.z - b.z;
      if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
      return a.x - b.x;
    }
    // Top loading: bottom-to-top first
    if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
    if (Math.abs(a.x - b.x) > 10) return a.x - b.x;
    return a.z - b.z;
  });
  return copy.map((p, i) => ({ ...p, stepIndex: i + 1 }));
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
  space: LoadingSpace,
  allowRotation: boolean,
  loadingDirection: LoadingDirection
): { details: UnloadedPackageReason[]; warnings: OptimizationWarning[] } {
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

    // Check dimension containment regardless of door/rotation
    const fitsRaw =
      spec.length <= space.internalLength + EPS &&
      spec.width <= space.internalWidth + EPS &&
      spec.height <= space.internalHeight + EPS;

    const orientations = getAllowedOrientations(spec, allowRotation, space, loadingDirection);

    if (orientations.length === 0) {
      if (!fitsRaw && (!allowRotation || !spec.rotatable)) {
        reasons.push('EXCEEDS_SPACE_DIMS', 'ORIENTATION_LOCKED');
        notes.push('Exceeds internal container dimensions with rotation disabled.');
      } else if (
        (loadingDirection === 'rear' && (spec.width > space.doorWidth || spec.height > space.doorHeight)) ||
        (loadingDirection === 'side' && (spec.length > space.doorWidth || spec.height > space.doorHeight))
      ) {
        reasons.push('EXCEEDS_DOOR_CLEARANCE');
        notes.push(`Exceeds ${loadingDirection} door opening (${space.doorWidth}×${space.doorHeight} mm).`);
      } else {
        reasons.push('EXCEEDS_SPACE_DIMS');
        notes.push('Package dimensions exceed internal space dimensions in all allowed orientations.');
      }
    }

    if (spec.weight > space.maxPayload) {
      reasons.push('EXCEEDS_PAYLOAD');
      notes.push(`Single unit weight (${spec.weight} kg) exceeds container max payload (${space.maxPayload} kg).`);
    } else if (totalLoadedWeight + spec.weight > space.maxPayload) {
      reasons.push('EXCEEDS_PAYLOAD');
      notes.push(`Remaining payload (${Math.max(0, space.maxPayload - totalLoadedWeight).toFixed(1)} kg) insufficient for ${spec.weight} kg unit.`);
    }

    if (
      space.floorWeightLimit &&
      space.floorWeightLimit > 0 &&
      spec.weight / ((spec.length / 1000) * (spec.width / 1000)) > space.floorWeightLimit
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
  const { space, packages, mode, allowRotation, loadingDirection, onProgress, shouldCancel } = options;

  const items: PackItem[] = [];
  for (const spec of packages) {
    const qty = Math.max(0, Math.floor(spec.quantity));
    if (qty <= 0 || spec.length <= 0 || spec.width <= 0 || spec.height <= 0) continue;
    const orientations = getAllowedOrientations(spec, allowRotation, space, loadingDirection);
    const volume = spec.length * spec.width * spec.height;
    const baseArea = spec.length * spec.width;
    for (let q = 0; q < qty; q++) {
      items.push({ spec, unitIndex: q, volume, baseArea, orientations });
    }
  }

  const singleSpaceVol = space.internalLength * space.internalWidth * space.internalHeight;
  const totalRequiredPackages = items.length;

  // Evaluate strategies (limit full multi-strategy sweep if >1200 items to keep UX crisp)
  const activeStrategies =
    items.length > 1200 ? STRATEGIES.slice(0, 3) : STRATEGIES;

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

  for (let i = 0; i < activeStrategies.length; i++) {
    if (shouldCancel && shouldCancel()) break;
    const strat = activeStrategies[i];
    onProgress?.(Math.round(((i + 0.3) / activeStrategies.length) * 85), strat.name);

    const t0 = performance.now();
    const run = packSingleStrategy(space, items, strat.id, mode, loadingDirection, shouldCancel);
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
    const verification = verifyPackingSolution(space, packages, orderedPlaced, allowRotation, loadingDirection);

    const containersUsed = run.containers.length;
    const totalSpaceVol = singleSpaceVol * containersUsed;
    const occupiedVol = run.containers.reduce((s, c) => s + c.occupiedVolume, 0);
    const totalWeight = run.containers.reduce((s, c) => s + c.totalWeight, 0);
    const volumePct = totalSpaceVol > 0 ? Math.round((occupiedVol / totalSpaceVol) * 10000) / 100 : 0;
    const weightPct =
      space.maxPayload * containersUsed > 0
        ? Math.round((totalWeight / (space.maxPayload * containersUsed)) * 10000) / 100
        : 0;
    const avgBalance = Math.round(
      run.containers.reduce((s, c) => s + computeBalanceScore(c).score, 0) / Math.max(1, containersUsed)
    );

    const dt = Math.round(performance.now() - t0);
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

    // Objective function to pick winning strategy
    let objScore = 0;
    if (!verification.isValid) {
      objScore = -1e9;
    } else {
      switch (mode) {
        case 'max_volume':
          objScore = volumePct * 100 + orderedPlaced.length * 0.1;
          break;
        case 'max_count':
          objScore = orderedPlaced.length * 1000 + volumePct;
          break;
        case 'min_vehicles':
          objScore = orderedPlaced.length * 10000 - containersUsed * 500 + volumePct;
          break;
        case 'weight_balance':
          objScore = orderedPlaced.length * 50 + avgBalance * 10 + volumePct;
          break;
        case 'balanced':
        default:
          objScore = volumePct * 40 + (orderedPlaced.length / Math.max(1, totalRequiredPackages)) * 4000 + avgBalance * 15;
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

  const finalContainers = winner?.containers ?? [new ContainerState(space, 0)];
  const finalPlaced = winner?.placed ?? [];
  const finalEmptySpaces = winner?.emptySpaces ?? [];
  const verification = verifyPackingSolution(space, packages, finalPlaced, allowRotation, loadingDirection);

  const containersUsed = finalContainers.length;
  const totalSpaceVol = singleSpaceVol * containersUsed;
  const occupiedVol = finalContainers.reduce((s, c) => s + c.occupiedVolume, 0);
  const totalCargoWeightKg = Math.round(finalContainers.reduce((s, c) => s + c.totalWeight, 0) * 100) / 100;
  const totalPayloadCap = space.maxPayload * containersUsed;

  const containerSummaries: ContainerSummary[] = finalContainers.map((c) => {
    const bal = computeBalanceScore(c);
    return {
      containerIndex: c.containerIndex,
      loadedCount: c.placed.length,
      occupiedVolumeMm3: c.occupiedVolume,
      volumeUtilizationPct: singleSpaceVol > 0 ? Math.round((c.occupiedVolume / singleSpaceVol) * 10000) / 100 : 0,
      loadedWeightKg: Math.round(c.totalWeight * 100) / 100,
      weightUtilizationPct:
        space.maxPayload > 0 ? Math.round((c.totalWeight / space.maxPayload) * 10000) / 100 : 0,
      centerOfGravity: bal.cog,
      balanceScore: bal.score,
    };
  });

  const firstBal = containerSummaries[0] ?? {
    centerOfGravity: { x: space.internalLength / 2, y: 0, z: space.internalWidth / 2 },
    balanceScore: 100,
  };

  const { details: unloadedDetails, warnings } = diagnoseUnloaded(
    packages,
    finalPlaced,
    space,
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

  // Estimate total trips needed if single-container mode left items unloaded
  let estimatedTrips = containersUsed;
  if (mode !== 'min_vehicles' && finalPlaced.length > 0 && finalPlaced.length < totalRequiredPackages) {
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
