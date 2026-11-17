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
import { getAllowedOrientations } from './packer';
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
  for (const b of existingInContainer) {
    candidates.push({ x: b.x + b.dx, y: b.y, z: b.z });
    candidates.push({ x: b.x, y: b.y, z: b.z + b.dz });
    candidates.push({ x: b.x, y: b.y + b.dy, z: b.z });
    candidates.push({ x: b.x + b.dx, y: 0, z: 0 });
    candidates.push({ x: 0, y: 0, z: b.z + b.dz });
  }

  // Sort candidate anchor points deterministically by floor-first & loading direction
  candidates.sort((a, b) => {
    if (Math.abs(a.y - b.y) > 1) return a.y - b.y;
    if (loadingDirection === 'side') {
      return a.z - b.z || a.x - b.x;
    }
    return a.x - b.x || a.z - b.z;
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

  const seen = new Set<string>();
  for (const pt of candidates) {
    const key = `${Math.round(pt.x)}_${Math.round(pt.y)}_${Math.round(pt.z)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    for (const o of orientations) {
      const res = validateManualPlacement(
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
      );
      if (res.valid) {
        return { ...pt, dx: o.dx, dy: o.dy, dz: o.dz, label: o.label, validation: res };
      }
    }
  }

  return null;
}

export function buildResultFromManualPlacements(
  space: LoadingSpace,
  packages: PackageSpec[],
  rawPlaced: PlacedPackage[],
  allowRotation: boolean,
  loadingDirection: LoadingDirection
): OptimizationResult {
  const t0 = performance.now();

  // Re-index stepIndex cleanly per container
  const stepCounters = new Map<number, number>();
  const placed: PlacedPackage[] = rawPlaced.map((p) => {
    const step = (stepCounters.get(p.containerIndex) ?? 0) + 1;
    stepCounters.set(p.containerIndex, step);
    return { ...p, stepIndex: step };
  });

  const maxContIdx = placed.reduce((m, p) => Math.max(m, p.containerIndex), 0);
  const containersUsed = Math.max(1, maxContIdx + 1);
  const singleSpaceVol = space.internalLength * space.internalWidth * space.internalHeight;
  const totalSpaceVol = singleSpaceVol * containersUsed;

  const containerSummaries: ContainerSummary[] = [];
  for (let cIdx = 0; cIdx < containersUsed; cIdx++) {
    const group = placed.filter((p) => p.containerIndex === cIdx);
    const occVol = group.reduce((s, p) => s + p.dx * p.dy * p.dz, 0);
    const totalW = group.reduce((s, p) => s + p.weight, 0);

    let cog = { x: space.internalLength / 2, y: 0, z: space.internalWidth / 2 };
    let score = 100;
    if (totalW > 0) {
      const wx = group.reduce((s, p) => s + p.weight * (p.x + p.dx / 2), 0);
      const wy = group.reduce((s, p) => s + p.weight * (p.y + p.dy / 2), 0);
      const wz = group.reduce((s, p) => s + p.weight * (p.z + p.dz / 2), 0);
      const cx = wx / totalW;
      const cy = wy / totalW;
      const cz = wz / totalW;
      cog = { x: Math.round(cx), y: Math.round(cy), z: Math.round(cz) };
      const devX = Math.abs(cx - space.internalLength / 2) / (space.internalLength / 2);
      const devZ = Math.abs(cz - space.internalWidth / 2) / (space.internalWidth / 2);
      score = Math.max(0, Math.min(100, Math.round((1 - (devX * 0.55 + devZ * 0.45)) * 100)));
    }

    containerSummaries.push({
      containerIndex: cIdx,
      loadedCount: group.length,
      occupiedVolumeMm3: occVol,
      volumeUtilizationPct: singleSpaceVol > 0 ? Math.round((occVol / singleSpaceVol) * 10000) / 100 : 0,
      loadedWeightKg: Math.round(totalW * 100) / 100,
      weightUtilizationPct: space.maxPayload > 0 ? Math.round((totalW / space.maxPayload) * 10000) / 100 : 0,
      centerOfGravity: cog,
      balanceScore: score,
    });
  }

  const occupiedVol = placed.reduce((s, p) => s + p.dx * p.dy * p.dz, 0);
  const totalWeightKg = Math.round(placed.reduce((s, p) => s + p.weight, 0) * 100) / 100;
  const totalReq = packages.reduce((s, p) => s + Math.max(0, Math.floor(p.quantity)), 0);
  const totalPayloadCap = space.maxPayload * containersUsed;

  const verification = verifyPackingSolution(space, packages, placed, allowRotation, loadingDirection);

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
        detail: 'Remaining units pending manual placement.',
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
    containerSummaries.reduce((s, c) => s + c.balanceScore, 0) / Math.max(1, containersUsed)
  );

  const emptySpaces: EmptySpaceBox[] = [];

  return {
    id: `manual-${Date.now()}`,
    timestamp: Date.now(),
    mode: 'balanced',
    strategyName: 'Manual Interactive Placement',
    allowRotation,
    loadingDirection,
    totalRequiredPackages: totalReq,
    loadedPackagesCount: placed.length,
    unloadedPackagesCount: Math.max(0, totalReq - placed.length),
    containersUsed,
    estimatedTrips: containersUsed,
    spaceVolumeMm3: totalSpaceVol,
    occupiedVolumeMm3: occupiedVol,
    remainingVolumeMm3: Math.max(0, totalSpaceVol - occupiedVol),
    volumeUtilizationPct: volumePct,
    totalCargoWeightKg: totalWeightKg,
    remainingPayloadKg: Math.max(0, Math.round((totalPayloadCap - totalWeightKg) * 100) / 100),
    weightUtilizationPct: weightPct,
    centerOfGravity: containerSummaries[0]?.centerOfGravity ?? {
      x: space.internalLength / 2,
      y: 0,
      z: space.internalWidth / 2,
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
        strategyName: 'Manual Interactive Placement',
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
