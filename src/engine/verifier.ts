import {
  LoadingDirection,
  LoadingSpace,
  OptimizationVerification,
  PackageSpec,
  PlacedPackage,
  VerificationCheck,
} from '../types/packvol';

const EPS = 0.05; // 0.05 mm numerical tolerance

function overlap1D(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

export function verifyPackingSolution(
  spaceOrSpaces: LoadingSpace | LoadingSpace[],
  specs: PackageSpec[],
  placed: PlacedPackage[],
  allowGlobalRotation: boolean,
  loadingDirection: LoadingDirection
): OptimizationVerification {
  const spacesList = Array.isArray(spaceOrSpaces)
    ? spaceOrSpaces.length > 0
      ? spaceOrSpaces
      : []
    : [spaceOrSpaces];
  const primarySpace = spacesList[0];
  const getSpace = (cIdx: number): LoadingSpace =>
    spacesList[cIdx] ?? spacesList[spacesList.length - 1];
  const getDir = (cIdx: number): LoadingDirection =>
    spacesList.length <= 1 ? loadingDirection : getSpace(cIdx).loadingDirection ?? loadingDirection;

  const specMap = new Map<string, PackageSpec>();
  for (const s of specs) specMap.set(s.id, s);

  const violations: string[] = [];
  const checks: VerificationCheck[] = [];

  // 1. Boundary Check
  let boundaryFailures = 0;
  for (const p of placed) {
    const sp = getSpace(p.containerIndex);
    if (
      p.x < -EPS ||
      p.y < -EPS ||
      p.z < -EPS ||
      p.x + p.dx > sp.internalLength + EPS ||
      p.y + p.dy > sp.internalHeight + EPS ||
      p.z + p.dz > sp.internalWidth + EPS
    ) {
      boundaryFailures++;
      if (violations.length < 10) {
        violations.push(`Package ${p.instanceId} (${p.sku}) exceeds container #${p.containerIndex + 1} internal boundaries.`);
      }
    }
  }
  checks.push({
    name: 'Internal Boundary Containment',
    passed: boundaryFailures === 0,
    details:
      boundaryFailures === 0
        ? `All ${placed.length} packages strictly inside ${primarySpace.internalLength}×${primarySpace.internalWidth}×${primarySpace.internalHeight} mm${spacesList.length > 1 ? ` (+${spacesList.length - 1} unit(s))` : ''}.`
        : `${boundaryFailures} package(s) protrude outside loading space boundaries.`,
  });

  // 2. Collision Detection (per container)
  const byContainer = new Map<number, PlacedPackage[]>();
  for (const p of placed) {
    const arr = byContainer.get(p.containerIndex) ?? [];
    arr.push(p);
    byContainer.set(p.containerIndex, arr);
  }

  let collisionCount = 0;
  for (const [, group] of byContainer) {
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        const ox = overlap1D(a.x, a.x + a.dx, b.x, b.x + b.dx);
        if (ox <= EPS) continue;
        const oy = overlap1D(a.y, a.y + a.dy, b.y, b.y + b.dy);
        if (oy <= EPS) continue;
        const oz = overlap1D(a.z, a.z + a.dz, b.z, b.z + b.dz);
        if (oz > EPS) {
          collisionCount++;
          if (violations.length < 10) {
            violations.push(`Collision between ${a.instanceId} and ${b.instanceId} in container #${a.containerIndex + 1}.`);
          }
        }
      }
    }
  }
  checks.push({
    name: 'Zero 3D Collision',
    passed: collisionCount === 0,
    details:
      collisionCount === 0
        ? 'No overlapping package bounding volumes detected.'
        : `${collisionCount} collision pair(s) detected.`,
  });

  // 3. Maximum Payload Check
  let payloadFailures = 0;
  for (const [cIdx, group] of byContainer) {
    const sp = getSpace(cIdx);
    const totalW = group.reduce((sum, p) => sum + p.weight, 0);
    if (totalW > sp.maxPayload + 0.01) {
      payloadFailures++;
      violations.push(
        `Container #${cIdx + 1} weight ${totalW.toFixed(1)} kg exceeds max payload ${sp.maxPayload} kg.`
      );
    }
  }
  checks.push({
    name: 'Maximum Payload Compliance',
    passed: payloadFailures === 0,
    details:
      payloadFailures === 0
        ? `All ${Math.max(spacesList.length, byContainer.size || 1)} space(s) within payload limits.`
        : `${payloadFailures} space(s) exceed maximum payload.`,
  });

  // 4. Door Clearance Check
  let doorFailures = 0;
  for (const p of placed) {
    const sp = getSpace(p.containerIndex);
    const dir = getDir(p.containerIndex);
    if (dir === 'rear') {
      if (p.dz > sp.doorWidth + EPS || p.dy > sp.doorHeight + EPS) {
        doorFailures++;
        if (violations.length < 10) {
          violations.push(`Package ${p.sku} (${p.dz}×${p.dy} mm) exceeds rear door (${sp.doorWidth}×${sp.doorHeight} mm).`);
        }
      }
    } else if (dir === 'side') {
      if (p.dx > sp.doorWidth + EPS || p.dy > sp.doorHeight + EPS) {
        doorFailures++;
        if (violations.length < 10) {
          violations.push(`Package ${p.sku} (${p.dx}×${p.dy} mm) exceeds side door (${sp.doorWidth}×${sp.doorHeight} mm).`);
        }
      }
    }
  }
  checks.push({
    name: 'Door Clearance Compliance',
    passed: doorFailures === 0,
    details:
      doorFailures === 0
        ? `All loaded packages clear ${loadingDirection} door opening.`
        : `${doorFailures} package(s) cannot pass through door dimensions.`,
  });

  // 5. Orientation & This-Side-Up Compliance
  let orientationFailures = 0;
  for (const p of placed) {
    const spec = specMap.get(p.packageId);
    if (!spec) continue;
    if (!allowGlobalRotation || !spec.rotatable) {
      const same =
        Math.abs(p.dx - spec.length) < EPS &&
        Math.abs(p.dy - spec.height) < EPS &&
        Math.abs(p.dz - spec.width) < EPS;
      if (!same) {
        orientationFailures++;
        if (violations.length < 10) {
          violations.push(`Non-rotatable package ${p.sku} was rotated.`);
        }
      }
    } else if (spec.thisSideUp) {
      if (Math.abs(p.dy - spec.height) > EPS) {
        orientationFailures++;
        if (violations.length < 10) {
          violations.push(`This-Side-Up package ${p.sku} was tilted vertically.`);
        }
      }
    }
  }
  checks.push({
    name: 'Orientation & This-Side-Up Rules',
    passed: orientationFailures === 0,
    details:
      orientationFailures === 0
        ? 'All rotation and upright constraints respected.'
        : `${orientationFailures} orientation violation(s) found.`,
  });

  // 6. Support, Stability, Non-Stackable, Fragile, Max Stack Weight & Max Layers
  let supportFailures = 0;
  let stackableFailures = 0;
  let fragileFailures = 0;
  let stackWeightFailures = 0;
  let stackLayerFailures = 0;

  for (const [, group] of byContainer) {
    // Track accumulated load on each lower package
    const loadOnBox = new Map<string, number>();
    const layersAboveBox = new Map<string, number>();

    // Sort bottom-to-top to compute transitive loads accurately
    const sorted = [...group].sort((a, b) => a.y - b.y);
    const directSupporters = new Map<string, PlacedPackage[]>();

    for (const p of sorted) {
      if (p.y <= EPS) {
        directSupporters.set(p.instanceId, []);
        continue;
      }
      const supporters: PlacedPackage[] = [];
      let supportedArea = 0;
      const baseArea = p.dx * p.dz;

      for (const b of sorted) {
        if (b.instanceId === p.instanceId) continue;
        if (Math.abs(b.y + b.dy - p.y) > 0.5) continue;
        const ox = overlap1D(p.x, p.x + p.dx, b.x, b.x + b.dx);
        const oz = overlap1D(p.z, p.z + p.dz, b.z, b.z + b.dz);
        if (ox > EPS && oz > EPS) {
          supportedArea += ox * oz;
          supporters.push(b);

          if (!b.stackable) {
            stackableFailures++;
            if (violations.length < 10) {
              violations.push(`Package ${p.sku} stacked on non-stackable ${b.sku}.`);
            }
          }
          if (b.fragile && !p.fragile) {
            fragileFailures++;
            if (violations.length < 10) {
              violations.push(`Non-fragile package ${p.sku} placed on fragile ${b.sku}.`);
            }
          }
        }
      }

      directSupporters.set(p.instanceId, supporters);
      const ratio = baseArea > 0 ? supportedArea / baseArea : 0;
      if (ratio < 0.65 - 0.001) {
        supportFailures++;
        if (violations.length < 10) {
          violations.push(`Package ${p.sku} has insufficient base support (${(ratio * 100).toFixed(1)}% < 65%).`);
        }
      }
    }

    // Propagate weights downward (top-to-bottom)
    const desc = [...sorted].sort((a, b) => b.y - a.y);
    for (const p of desc) {
      const sups = directSupporters.get(p.instanceId) ?? [];
      if (sups.length === 0) continue;

      const totalWeightAboveP = loadOnBox.get(p.instanceId) ?? 0;
      const totalTransmitted = p.weight + totalWeightAboveP;
      const layersAboveP = layersAboveBox.get(p.instanceId) ?? 0;

      // Distribute proportionally by contact area
      let totalArea = 0;
      const areas = sups.map((b) => {
        const a =
          overlap1D(p.x, p.x + p.dx, b.x, b.x + b.dx) *
          overlap1D(p.z, p.z + p.dz, b.z, b.z + b.dz);
        totalArea += a;
        return a;
      });

      sups.forEach((b, idx) => {
        const share = totalArea > 0 ? areas[idx] / totalArea : 1 / sups.length;
        loadOnBox.set(b.instanceId, (loadOnBox.get(b.instanceId) ?? 0) + totalTransmitted * share);
        layersAboveBox.set(b.instanceId, Math.max(layersAboveBox.get(b.instanceId) ?? 0, layersAboveP + 1));
      });
    }

    for (const b of sorted) {
      const spec = specMap.get(b.packageId);
      if (!spec) continue;
      if (spec.stackable && spec.maxStackWeight > 0) {
        const w = loadOnBox.get(b.instanceId) ?? 0;
        if (w > spec.maxStackWeight + 0.1) {
          stackWeightFailures++;
          if (violations.length < 10) {
            violations.push(`Stack load ${w.toFixed(1)} kg on ${b.sku} exceeds max ${spec.maxStackWeight} kg.`);
          }
        }
      }
      if (spec.stackable && spec.maxStackLayers > 0) {
        const layers = layersAboveBox.get(b.instanceId) ?? 0;
        if (layers > spec.maxStackLayers) {
          stackLayerFailures++;
          if (violations.length < 10) {
            violations.push(`Stack layers (${layers}) above ${b.sku} exceeds max ${spec.maxStackLayers}.`);
          }
        }
      }
    }
  }

  checks.push({
    name: 'Floor & Base Support Stability (>= 65%)',
    passed: supportFailures === 0,
    details:
      supportFailures === 0
        ? 'Every elevated package meets minimum supporting contact area.'
        : `${supportFailures} package(s) lack sufficient vertical support.`,
  });
  checks.push({
    name: 'Non-Stackable & Fragile Protection',
    passed: stackableFailures === 0 && fragileFailures === 0,
    details:
      stackableFailures === 0 && fragileFailures === 0
        ? 'No cargo placed on non-stackable items; fragile items protected.'
        : `${stackableFailures} non-stackable and ${fragileFailures} fragile violation(s).`,
  });
  checks.push({
    name: 'Max Stacking Weight & Layer Limits',
    passed: stackWeightFailures === 0 && stackLayerFailures === 0,
    details:
      stackWeightFailures === 0 && stackLayerFailures === 0
        ? 'All stacking weight and layer limits satisfied.'
        : `${stackWeightFailures} weight limit and ${stackLayerFailures} layer limit violation(s).`,
  });

  const isValid = checks.every((c) => c.passed);
  return { isValid, checks, violations };
}
