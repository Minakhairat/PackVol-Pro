import {
  ContainerSummary,
  EmptySpaceBox,
  LoadingDirection,
  LoadingSpace,
  ManualPlacementValidation,
  OptimizationResult,
  OptimizationWarning,
  PackageSpec,
  PlacedPackage,
  UnloadedPackageReason,
  UnloadedReasonCode,
} from '../types/packvol';
import { getAllowedOrientations, packRemainingManualBatchInContainer } from './packer';
import { verifyPackingSolution } from './verifier';

const EPS = 0.02;

function overlap1D(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

export function computeDropY(
  existingInContainer: PlacedPackage[],
  x: number,
  z: number,
  dx: number,
  dz: number,
  excludeInstanceId?: string
): number {
  let maxY = 0;
  for (const b of existingInContainer) {
    if (excludeInstanceId && b.instanceId === excludeInstanceId) continue;
    const ox = overlap1D(x, x + dx, b.x, b.x + b.dx);
    const oz = overlap1D(z, z + dz, b.z, b.z + b.dz);
    if (ox > EPS && oz > EPS) {
      maxY = Math.max(maxY, b.y + b.dy);
    }
  }
  return Math.round(maxY * 100) / 100;
}

export function snapManualCoords(
  space: LoadingSpace,
  existingInContainer: PlacedPackage[],
  dx: number,
  dy: number,
  dz: number,
  rawX: number,
  rawY: number,
  rawZ: number,
  excludeInstanceId?: string
): { x: number; y: number; z: number } {
  const maxX = Math.max(0, space.internalLength - dx);
  const maxZ = Math.max(0, space.internalWidth - dz);

  let x = Math.max(0, Math.min(maxX, rawX));
  let z = Math.max(0, Math.min(maxZ, rawZ));
  const y = Math.max(0, Math.min(Math.max(0, space.internalHeight - dy), rawY));

  const snapThreshold = 45; // mm magnet threshold

  // Snap to container walls
  if (x < snapThreshold) x = 0;
  else if (Math.abs(maxX - x) < snapThreshold) x = maxX;

  if (z < snapThreshold) z = 0;
  else if (Math.abs(maxZ - z) < snapThreshold) z = maxZ;

  // Snap to nearby existing boxes around the target elevation
  let bestSnapX = x;
  let bestDistX = snapThreshold;
  let bestSnapZ = z;
  let bestDistZ = snapThreshold;

  for (const b of existingInContainer) {
    if (excludeInstanceId && b.instanceId === excludeInstanceId) continue;
    const yOverlaps = overlap1D(y, y + dy, b.y, b.y + b.dy) > EPS || Math.abs(b.y + b.dy - y) <= 1;
    if (!yOverlaps) continue;

    // X edge alignment when Z spans overlap or are adjacent
    if (overlap1D(z, z + dz, b.z - 50, b.z + b.dz + 50) > 0) {
      for (const candX of [b.x + b.dx, b.x - dx, b.x]) {
        if (candX >= -EPS && candX <= maxX + EPS) {
          const d = Math.abs(candX - x);
          if (d < bestDistX) {
            bestDistX = d;
            bestSnapX = Math.max(0, Math.min(maxX, candX));
          }
        }
      }
    }

    // Z edge alignment when X spans overlap or are adjacent
    if (overlap1D(x, x + dx, b.x - 50, b.x + b.dx + 50) > 0) {
      for (const candZ of [b.z + b.dz, b.z - dz, b.z]) {
        if (candZ >= -EPS && candZ <= maxZ + EPS) {
          const d = Math.abs(candZ - z);
          if (d < bestDistZ) {
            bestDistZ = d;
            bestSnapZ = Math.max(0, Math.min(maxZ, candZ));
          }
        }
      }
    }
  }

  x = Math.round(bestSnapX / 5) * 5;
  z = Math.round(bestSnapZ / 5) * 5;

  return {
    x: Math.max(0, Math.min(maxX, x)),
    y: Math.round(y * 100) / 100,
    z: Math.max(0, Math.min(maxZ, z)),
  };
}

export function validateManualPlacement(
  space: LoadingSpace,
  existingInContainer: PlacedPackage[],
  spec: PackageSpec,
  dx: number,
  dy: number,
  dz: number,
  x: number,
  y: number,
  z: number,
  allowGlobalRotation: boolean,
  loadingDirection: LoadingDirection,
  specsMap?: Map<string, PackageSpec>,
  excludeInstanceId?: string
): ManualPlacementValidation {
  const { internalLength: L, internalWidth: W, internalHeight: H } = space;

  // 1. Internal boundaries
  if (
    x < -EPS ||
    y < -EPS ||
    z < -EPS ||
    x + dx > L + EPS ||
    y + dy > H + EPS ||
    z + dz > W + EPS
  ) {
    return {
      valid: false,
      reasonCode: 'OUT_OF_BOUNDS',
      reasonEn: 'Package extends outside container internal boundaries.',
      reasonAr: 'العبوة تتجاوز الحدود الداخلية لمساحة التحميل.',
      supportedAreaPct: 0,
      layerIndex: 0,
    };
  }

  // 2. Door clearance
  if (loadingDirection === 'rear' && (dz > space.doorWidth + EPS || dy > space.doorHeight + EPS)) {
    return {
      valid: false,
      reasonCode: 'DOOR_CLEARANCE',
      reasonEn: `Exceeds rear door clearance (${space.doorWidth}×${space.doorHeight} mm).`,
      reasonAr: `أبعاد العبوة تتجاوز فتحة الباب الخلفي (${space.doorWidth}×${space.doorHeight} مم).`,
      supportedAreaPct: 0,
      layerIndex: 0,
    };
  }
  if (loadingDirection === 'side' && (dx > space.doorWidth + EPS || dy > space.doorHeight + EPS)) {
    return {
      valid: false,
      reasonCode: 'DOOR_CLEARANCE',
      reasonEn: `Exceeds side door clearance (${space.doorWidth}×${space.doorHeight} mm).`,
      reasonAr: `أبعاد العبوة تتجاوز فتحة الباب الجانبي (${space.doorWidth}×${space.doorHeight} مم).`,
      supportedAreaPct: 0,
      layerIndex: 0,
    };
  }

  // 3. Rotation / This-Side-Up compliance
  const allowed = getAllowedOrientations(spec, allowGlobalRotation, space, loadingDirection);
  const orientationOk = allowed.some(
    (o) =>
      Math.abs(o.dx - dx) < EPS &&
      Math.abs(o.dy - dy) < EPS &&
      Math.abs(o.dz - dz) < EPS
  );
  if (!orientationOk) {
    return {
      valid: false,
      reasonCode: 'ORIENTATION_LOCKED',
      reasonEn: 'Selected orientation violates rotation or This-Side-Up rules.',
      reasonAr: 'الاتجاه المختار يخالف قواعد التدوير أو قاعدة (هذا الجانب للأعلى).',
      supportedAreaPct: 0,
      layerIndex: 0,
    };
  }

  const filtered = excludeInstanceId
    ? existingInContainer.filter((b) => b.instanceId !== excludeInstanceId)
    : existingInContainer;

  // 4. Payload capacity check
  const currentWeight = filtered.reduce((s, b) => s + b.weight, 0);
  if (currentWeight + spec.weight > space.maxPayload + 0.01) {
    return {
      valid: false,
      reasonCode: 'PAYLOAD_EXCEEDED',
      reasonEn: `Exceeds maximum payload (${space.maxPayload} kg).`,
      reasonAr: `يتجاوز أقصى حمولة مسموحة (${space.maxPayload} كجم).`,
      supportedAreaPct: 0,
      layerIndex: 0,
    };
  }

  // 5. Floor weight limit if on floor
  if (y <= EPS && space.floorWeightLimit && space.floorWeightLimit > 0) {
    const footM2 = (dx / 1000) * (dz / 1000);
    if (footM2 > 0 && spec.weight / footM2 > space.floorWeightLimit + 0.1) {
      return {
        valid: false,
        reasonCode: 'FLOOR_LIMIT',
        reasonEn: `Floor pressure exceeds ${space.floorWeightLimit} kg/m² limit.`,
        reasonAr: `ضغط الأرضية يتجاوز الحد المسموح (${space.floorWeightLimit} كجم/م²).`,
        supportedAreaPct: 0,
        layerIndex: 0,
      };
    }
  }

  // 6. 3D Collision & direct supporter analysis
  const directSupporters: { box: PlacedPackage; area: number }[] = [];
  let supportedArea = 0;
  let minSupX = Infinity;
  let maxSupX = -Infinity;
  let minSupZ = Infinity;
  let maxSupZ = -Infinity;
  let maxSupLayer = -1;

  for (const b of filtered) {
    if (y >= b.y + b.dy - EPS) {
      if (y > EPS && Math.abs(b.y + b.dy - y) <= 0.5) {
        const ox = overlap1D(x, x + dx, b.x, b.x + b.dx);
        const oz = overlap1D(z, z + dz, b.z, b.z + b.dz);
        if (ox > EPS && oz > EPS) {
          if (!b.stackable) {
            return {
              valid: false,
              reasonCode: 'NON_STACKABLE',
              reasonEn: `Cannot stack on non-stackable package (${b.sku}).`,
              reasonAr: `لا يمكن التكديس فوق العبوة (${b.sku}) لأنها غير قابلة للتكديس.`,
              supportedAreaPct: 0,
              layerIndex: 0,
            };
          }
          if (b.fragile && !spec.fragile) {
            return {
              valid: false,
              reasonCode: 'FRAGILE_BELOW',
              reasonEn: `Cannot place heavy/non-fragile cargo on fragile (${b.sku}).`,
              reasonAr: `لا يمكن وضع حمولة غير هشة فوق عبوة قابلة للكسر (${b.sku}).`,
              supportedAreaPct: 0,
              layerIndex: 0,
            };
          }
          supportedArea += ox * oz;
          directSupporters.push({ box: b, area: ox * oz });
          maxSupLayer = Math.max(maxSupLayer, b.layerIndex);
          minSupX = Math.min(minSupX, Math.max(x, b.x));
          maxSupX = Math.max(maxSupX, Math.min(x + dx, b.x + b.dx));
          minSupZ = Math.min(minSupZ, Math.max(z, b.z));
          maxSupZ = Math.max(maxSupZ, Math.min(z + dz, b.z + b.dz));
        }
      }
      continue;
    }

    if (y + dy <= b.y + EPS) continue;

    const ox = overlap1D(x, x + dx, b.x, b.x + b.dx);
    if (ox <= EPS) continue;
    const oz = overlap1D(z, z + dz, b.z, b.z + b.dz);
    if (oz > EPS) {
      return {
        valid: false,
        reasonCode: 'COLLISION',
        reasonEn: `Collides with placed package ${b.sku} (#${b.stepIndex}).`,
        reasonAr: `يوجد تصادم مع العبوة المحملة ${b.sku} (#${b.stepIndex}).`,
        supportedAreaPct: 0,
        layerIndex: 0,
      };
    }
  }

  if (y <= EPS) {
    return {
      valid: true,
      reasonEn: 'Valid floor placement',
      reasonAr: 'موضع صحيح على الأرضية',
      supportedAreaPct: 100,
      layerIndex: 0,
    };
  }

  const baseArea = dx * dz;
  const supportedRatio = baseArea > 0 ? supportedArea / baseArea : 0;
  const supportedPct = Math.min(100, Math.round(supportedRatio * 1000) / 10);

  if (supportedRatio < 0.68) {
    return {
      valid: false,
      reasonCode: 'LOW_SUPPORT',
      reasonEn: `Insufficient base support (${supportedPct}% < 68% required).`,
      reasonAr: `دعم القاعدة غير كافٍ (${supportedPct}% أقل من الحد الأدنى 68%).`,
      supportedAreaPct: supportedPct,
      layerIndex: maxSupLayer + 1,
    };
  }

  const cx = x + dx / 2;
  const cz = z + dz / 2;
  if (
    cx < minSupX - dx * 0.08 ||
    cx > maxSupX + dx * 0.08 ||
    cz < minSupZ - dz * 0.08 ||
    cz > maxSupZ + dz * 0.08
  ) {
    return {
      valid: false,
      reasonCode: 'COG_OVERHANG',
      reasonEn: 'Center of gravity overhangs beyond supporting boxes.',
      reasonAr: 'مركز ثقل العبوة بارز خارج نطاق الدعم السُفلي.',
      supportedAreaPct: supportedPct,
      layerIndex: maxSupLayer + 1,
    };
  }

  // 7. Transitive stacking weight & layers verification using full candidate solution check
  if (specsMap) {
    const candidateBox: PlacedPackage = {
      instanceId: excludeInstanceId ?? `__candidate_${Date.now()}`,
      packageId: spec.id,
      sku: spec.sku,
      name: spec.name,
      category: spec.category,
      color: spec.color,
      containerIndex: existingInContainer[0]?.containerIndex ?? 0,
      stepIndex: filtered.length + 1,
      x,
      y,
      z,
      dx,
      dy,
      dz,
      weight: spec.weight,
      orientationLabel: `${dx}×${dz}×${dy}`,
      layerIndex: maxSupLayer + 1,
      fragile: spec.fragile,
      stackable: spec.stackable,
      thisSideUp: spec.thisSideUp,
      supportedAreaPct: supportedPct,
    };
    const simulated = [...filtered, candidateBox];
    const check = verifyPackingSolution(
      space,
      Array.from(specsMap.values()),
      simulated,
      allowGlobalRotation,
      loadingDirection
    );
    if (!check.isValid) {
      const firstFail = check.violations[0] ?? 'Stacking weight or layer limit exceeded.';
      return {
        valid: false,
        reasonCode: 'STACK_LIMIT',
        reasonEn: firstFail,
        reasonAr: `تجاوز حد وزن التكديس أو أقصى عدد طبقات فوق العبوات السفلية.`,
        supportedAreaPct: supportedPct,
        layerIndex: maxSupLayer + 1,
      };
    }
  }

  return {
    valid: true,
    reasonEn: `Valid stacked placement (${supportedPct}% support)`,
    reasonAr: `موضع تكديس صحيح (دعم ${supportedPct}%)`,
    supportedAreaPct: supportedPct,
    layerIndex: maxSupLayer + 1,
  };
}

export function findNextValidSpot(
  space: LoadingSpace,
  existingInContainer: PlacedPackage[],
  spec: PackageSpec,
  preferredDx: number,
  preferredDy: number,
  preferredDz: number,
  preferredLabel: string,
  allowGlobalRotation: boolean,
  loadingDirection: LoadingDirection,
  specsMap?: Map<string, PackageSpec>
): { x: number; y: number; z: number; dx: number; dy: number; dz: number; label: string; validation: ManualPlacementValidation } | null {
  const candidates: { x: number; y: number; z: number }[] = [{ x: 0, y: 0, z: 0 }];
  for (let i = 0; i < existingInContainer.length; i++) {
    const b = existingInContainer[i];
    candidates.push({ x: b.x + b.dx, y: b.y, z: b.z });
    candidates.push({ x: b.x, y: b.y, z: b.z + b.dz });
    candidates.push({ x: b.x, y: b.y + b.dy, z: b.z });
    candidates.push({ x: b.x + b.dx, y: 0, z: b.z });
    candidates.push({ x: b.x, y: 0, z: b.z + b.dz });
    candidates.push({ x: b.x + b.dx, y: 0, z: 0 });
    candidates.push({ x: 0, y: 0, z: b.z + b.dz });
    candidates.push({ x: 0, y: b.y + b.dy, z: b.z });
    candidates.push({ x: b.x, y: b.y + b.dy, z: 0 });

    // Cross projections onto adjacent box faces for tight gaps
    for (let j = 0; j < i; j++) {
      const a = existingInContainer[j];
      if (a.z < b.z + b.dz && a.z + a.dz > b.z) {
        candidates.push({ x: b.x + b.dx, y: a.y + a.dy, z: Math.max(a.z, b.z) });
        candidates.push({ x: a.x + a.dx, y: b.y + b.dy, z: Math.max(a.z, b.z) });
      }
      if (a.x < b.x + b.dx && a.x + a.dx > b.x) {
        candidates.push({ x: Math.max(a.x, b.x), y: a.y + a.dy, z: b.z + b.dz });
        candidates.push({ x: Math.max(a.x, b.x), y: b.y + b.dy, z: a.z + a.dz });
      }
    }
  }

  candidates.sort((a, b) => {
    if (loadingDirection === 'side') {
      if (Math.abs(a.z - b.z) > 1) return a.z - b.z;
      if (Math.abs(a.y - b.y) > 1) return a.y - b.y;
      return a.x - b.x;
    }
    if (loadingDirection === 'top') {
      if (Math.abs(a.y - b.y) > 1) return a.y - b.y;
      if (Math.abs(a.x - b.x) > 1) return a.x - b.x;
      return a.z - b.z;
    }
    if (Math.abs(a.x - b.x) > 1) return a.x - b.x;
    if (Math.abs(a.y - b.y) > 1) return a.y - b.y;
    return a.z - b.z;
  });

  const allowed = getAllowedOrientations(spec, allowGlobalRotation, space, loadingDirection);
  const orientations = [
    { dx: preferredDx, dy: preferredDy, dz: preferredDz, label: preferredLabel },
    ...allowed.filter(
      (o) =>
        Math.abs(o.dx - preferredDx) > EPS ||
        Math.abs(o.dy - preferredDy) > EPS ||
        Math.abs(o.dz - preferredDz) > EPS
    ),
  ];

  const { internalLength: L, internalWidth: W, internalHeight: H } = space;
  const seen = new Set<string>();
  let bestScore = Infinity;
  let bestSpot: {
    x: number;
    y: number;
    z: number;
    dx: number;
    dy: number;
    dz: number;
    label: string;
    validation: ManualPlacementValidation;
  } | null = null;

  for (const pt of candidates) {
    if (pt.x < -EPS || pt.y < -EPS || pt.z < -EPS) continue;
    const key = `${Math.round(pt.x)}_${Math.round(pt.y)}_${Math.round(pt.z)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (bestSpot) {
      const axisPos =
        loadingDirection === 'side' ? pt.z : loadingDirection === 'top' ? pt.y : pt.x;
      if (axisPos * 8.0 - 2000 > bestScore) break;
    }

    for (let oIdx = 0; oIdx < orientations.length; oIdx++) {
      const o = orientations[oIdx];
      if (pt.x + o.dx > L + EPS || pt.y + o.dy > H + EPS || pt.z + o.dz > W + EPS) continue;

      const fastRes = validateManualPlacement(
        space,
        existingInContainer,
        spec,
        o.dx,
        o.dy,
        o.dz,
        pt.x,
        pt.y,
        pt.z,
        allowGlobalRotation,
        loadingDirection,
        undefined
      );
      if (!fastRes.valid) continue;

      const res =
        specsMap && pt.y > EPS
          ? validateManualPlacement(
              space,
              existingInContainer,
              spec,
              o.dx,
              o.dy,
              o.dz,
              pt.x,
              pt.y,
              pt.z,
              allowGlobalRotation,
              loadingDirection,
              specsMap
            )
          : fastRes;

      if (!res.valid) continue;

      let dirPenalty = pt.x * 8.0 + pt.y * 1.3 + pt.z * 0.45 + (pt.x + o.dx) * 0.6;
      let remA = W - (pt.z + o.dz);
      let remB = H - (pt.y + o.dy);
      let tileA = (W - pt.z) % Math.max(1, o.dz);
      let tileB = (H - pt.y) % Math.max(1, o.dy);

      if (loadingDirection === 'side') {
        dirPenalty = pt.z * 8.0 + pt.y * 1.3 + pt.x * 0.45 + (pt.z + o.dz) * 0.6;
        remA = L - (pt.x + o.dx);
        remB = H - (pt.y + o.dy);
        tileA = (L - pt.x) % Math.max(1, o.dx);
        tileB = (H - pt.y) % Math.max(1, o.dy);
      } else if (loadingDirection === 'top') {
        dirPenalty = pt.y * 8.0 + pt.x * 1.0 + pt.z * 0.6 + (pt.y + o.dy) * 0.5;
        remA = L - (pt.x + o.dx);
        remB = W - (pt.z + o.dz);
        tileA = (L - pt.x) % Math.max(1, o.dx);
        tileB = (W - pt.z) % Math.max(1, o.dz);
      }

      const flushBonus =
        (remA < 5 ? -500 : remA < 40 ? -180 : remA * 0.05) +
        (remB < 5 ? -420 : remB < 40 ? -150 : remB * 0.05) +
        (tileA < 25 ? -260 : 0) +
        (tileB < 25 ? -220 : 0);
      const prefTieBonus = oIdx === 0 ? -5 : 0;
      const sc = dirPenalty + flushBonus + prefTieBonus;

      if (sc < bestScore) {
        bestScore = sc;
        bestSpot = { ...pt, dx: o.dx, dy: o.dy, dz: o.dz, label: o.label, validation: res };
      }
    }
  }

  return bestSpot;
}

export function placeAllManualUnitsForSpec(
  space: LoadingSpace,
  existingInContainer: PlacedPackage[],
  containerIndex: number,
  spec: PackageSpec,
  remainingQty: number,
  preferredOrientation: { dx: number; dy: number; dz: number; label: string },
  allowGlobalRotation: boolean,
  loadingDirection: LoadingDirection,
  specsMap: Map<string, PackageSpec>,
  displayName: string,
  displayCategory: string
): { newBoxes: PlacedPackage[]; placedCount: number } {
  const placedRaw = packRemainingManualBatchInContainer(
    space,
    existingInContainer,
    containerIndex,
    spec,
    remainingQty,
    preferredOrientation,
    allowGlobalRotation,
    loadingDirection,
    specsMap
  );

  const newBoxes = placedRaw.map((b) => ({
    ...b,
    name: displayName,
    category: displayCategory,
  }));

  return { newBoxes, placedCount: newBoxes.length };
}

export function settleFloatingPackages(
  space: LoadingSpace,
  existingInContainer: PlacedPackage[]
): PlacedPackage[] {
  const sorted = [...existingInContainer].sort((a, b) => a.y - b.y || a.stepIndex - b.stepIndex);
  const settled: PlacedPackage[] = [];
  for (const box of sorted) {
    const newY = computeDropY(settled, box.x, box.z, box.dx, box.dz, box.instanceId);
    let layerIndex = 0;
    let supportedArea = 0;
    if (newY > EPS) {
      let maxSupLayer = 0;
      for (const sup of settled) {
        if (Math.abs(sup.y + sup.dy - newY) <= 0.5) {
          const ox = overlap1D(box.x, box.x + box.dx, sup.x, sup.x + sup.dx);
          const oz = overlap1D(box.z, box.z + box.dz, sup.z, sup.z + sup.dz);
          if (ox > EPS && oz > EPS) {
            supportedArea += ox * oz;
            maxSupLayer = Math.max(maxSupLayer, sup.layerIndex);
          }
        }
      }
      layerIndex = maxSupLayer + 1;
    }
    const baseArea = box.dx * box.dz;
    const supportedAreaPct =
      newY <= EPS ? 100 : Math.min(100, Math.round((supportedArea / Math.max(1, baseArea)) * 1000) / 10);

    settled.push({
      ...box,
      y: Math.min(newY, Math.max(0, space.internalHeight - box.dy)),
      layerIndex,
      supportedAreaPct,
    });
  }
  return settled;
}

export function buildResultFromManualPlacements(
  spaceOrSpaces: LoadingSpace | LoadingSpace[],
  packages: PackageSpec[],
  rawPlaced: PlacedPackage[],
  allowRotation: boolean,
  loadingDirection: LoadingDirection,
  meta?: { mode?: OptimizationResult['mode']; strategyName?: string }
): OptimizationResult {
  const t0 = performance.now();
  const spacesList = Array.isArray(spaceOrSpaces)
    ? spaceOrSpaces.length > 0
      ? spaceOrSpaces
      : []
    : [spaceOrSpaces];
  const primarySpace = spacesList[0];
  const getSpace = (cIdx: number): LoadingSpace =>
    spacesList[cIdx] ?? spacesList[spacesList.length - 1];

  // Re-index stepIndex cleanly per container
  const stepCounters = new Map<number, number>();
  const placed: PlacedPackage[] = rawPlaced.map((p) => {
    const step = (stepCounters.get(p.containerIndex) ?? 0) + 1;
    stepCounters.set(p.containerIndex, step);
    return { ...p, stepIndex: step };
  });

  const maxContIdx = placed.reduce((m, p) => Math.max(m, p.containerIndex), 0);
  const configuredCount = Math.max(spacesList.length, placed.length > 0 ? maxContIdx + 1 : 0);

  const effectiveSpaces: LoadingSpace[] = [];
  const containerSummaries: ContainerSummary[] = [];

  for (let cIdx = 0; cIdx < configuredCount; cIdx++) {
    const sp = getSpace(cIdx);
    effectiveSpaces.push(sp);
    const singleSpaceVol = sp.internalLength * sp.internalWidth * sp.internalHeight;

    const group = placed.filter((p) => p.containerIndex === cIdx);
    const occVol = group.reduce((s, p) => s + p.dx * p.dy * p.dz, 0);
    const totalW = group.reduce((s, p) => s + p.weight, 0);

    let cog = { x: sp.internalLength / 2, y: 0, z: sp.internalWidth / 2 };
    let score = 100;
    if (totalW > 0) {
      const wx = group.reduce((s, p) => s + p.weight * (p.x + p.dx / 2), 0);
      const wy = group.reduce((s, p) => s + p.weight * (p.y + p.dy / 2), 0);
      const wz = group.reduce((s, p) => s + p.weight * (p.z + p.dz / 2), 0);
      const cx = wx / totalW;
      const cy = wy / totalW;
      const cz = wz / totalW;
      cog = { x: Math.round(cx), y: Math.round(cy), z: Math.round(cz) };
      const devX = Math.abs(cx - sp.internalLength / 2) / (sp.internalLength / 2);
      const devZ = Math.abs(cz - sp.internalWidth / 2) / (sp.internalWidth / 2);
      score = Math.max(0, Math.min(100, Math.round((1 - (devX * 0.55 + devZ * 0.45)) * 100)));
    }

    containerSummaries.push({
      containerIndex: cIdx,
      space: sp,
      loadedCount: group.length,
      occupiedVolumeMm3: occVol,
      volumeUtilizationPct: singleSpaceVol > 0 ? Math.round((occVol / singleSpaceVol) * 10000) / 100 : 0,
      loadedWeightKg: Math.round(totalW * 100) / 100,
      weightUtilizationPct: sp.maxPayload > 0 ? Math.round((totalW / sp.maxPayload) * 10000) / 100 : 0,
      centerOfGravity: cog,
      balanceScore: score,
    });
  }

  const usedSummaries = containerSummaries.filter((cs) => cs.loadedCount > 0);
  const containersUsed = usedSummaries.length;
  const metricSummaries = usedSummaries.length > 0 ? usedSummaries : containerSummaries.slice(0, 1);

  const totalSpaceVol = metricSummaries.reduce(
    (s, cs) =>
      s +
      (cs.space
        ? cs.space.internalLength * cs.space.internalWidth * cs.space.internalHeight
        : 0),
    0
  );
  const totalPayloadCap = metricSummaries.reduce((s, cs) => s + (cs.space?.maxPayload ?? 0), 0);

  const occupiedVol = placed.reduce((s, p) => s + p.dx * p.dy * p.dz, 0);
  const totalWeightKg = Math.round(placed.reduce((s, p) => s + p.weight, 0) * 100) / 100;
  const totalReq = packages.reduce((s, p) => s + Math.max(0, Math.floor(p.quantity)), 0);

  const verification = verifyPackingSolution(effectiveSpaces, packages, placed, allowRotation, loadingDirection);

  const loadedBySpec = new Map<string, number>();
  for (const p of placed) {
    loadedBySpec.set(p.packageId, (loadedBySpec.get(p.packageId) ?? 0) + 1);
  }

  const unloadedDetails: UnloadedPackageReason[] = [];
  for (const spec of packages) {
    const req = Math.max(0, Math.floor(spec.quantity));
    const loaded = loadedBySpec.get(spec.id) ?? 0;
    const rem = req - loaded;
    if (rem > 0) {
      const reasons: UnloadedReasonCode[] = ['INSUFFICIENT_SPACE'];
      unloadedDetails.push({
        packageId: spec.id,
        sku: spec.sku,
        name: spec.name,
        requestedQty: req,
        loadedQty: loaded,
        unloadedQty: rem,
        reasons,
        detail: 'Remaining units pending placement.',
      });
    }
  }

  const warnings: OptimizationWarning[] = [];
  if (!verification.isValid) {
    warnings.push({
      severity: 'error',
      code: 'PHYSICS_VERIFICATION_FAILED',
      message: verification.violations[0] ?? 'Physical constraint check failed.',
    });
  }

  const volumePct = totalSpaceVol > 0 ? Math.round((occupiedVol / totalSpaceVol) * 10000) / 100 : 0;
  const weightPct =
    totalPayloadCap > 0 ? Math.round((totalWeightKg / totalPayloadCap) * 10000) / 100 : 0;
  const avgBalance = Math.round(
    metricSummaries.reduce((s, c) => s + c.balanceScore, 0) / Math.max(1, metricSummaries.length)
  );

  const emptySpaces: EmptySpaceBox[] = [];
  const strategyName = meta?.strategyName ?? 'Manual Interactive Placement';

  return {
    id: `manual-${Date.now()}`,
    timestamp: Date.now(),
    mode: meta?.mode ?? 'balanced',
    strategyName,
    allowRotation,
    loadingDirection,
    totalRequiredPackages: totalReq,
    loadedPackagesCount: placed.length,
    unloadedPackagesCount: Math.max(0, totalReq - placed.length),
    containersUsed,
    configuredContainersCount: configuredCount,
    estimatedTrips: Math.max(1, containersUsed),
    spaceVolumeMm3: totalSpaceVol,
    occupiedVolumeMm3: occupiedVol,
    remainingVolumeMm3: Math.max(0, totalSpaceVol - occupiedVol),
    volumeUtilizationPct: volumePct,
    totalCargoWeightKg: totalWeightKg,
    remainingPayloadKg: Math.max(0, Math.round((totalPayloadCap - totalWeightKg) * 100) / 100),
    weightUtilizationPct: weightPct,
    centerOfGravity: containerSummaries[0]?.centerOfGravity ?? {
      x: primarySpace.internalLength / 2,
      y: 0,
      z: primarySpace.internalWidth / 2,
    },
    balanceScore: avgBalance,
    placedPackages: placed,
    emptySpaces,
    containerSummaries,
    unloadedDetails,
    warnings,
    strategyComparison: [
      {
        strategyId: 'manual',
        strategyName,
        loadedCount: placed.length,
        totalRequested: totalReq,
        volumeUtilizationPct: volumePct,
        weightUtilizationPct: weightPct,
        containersUsed,
        balanceScore: avgBalance,
        valid: verification.isValid,
        durationMs: Math.round(performance.now() - t0),
      },
    ],
    verification,
    durationMs: Math.max(1, Math.round(performance.now() - t0)),
  };
}
