import { runOptimization } from './packer';
import { LoadingSpace, PackageSpec } from '../types/packvol';

export interface TestCaseResult {
  id: number;
  name: string;
  passed: boolean;
  details: string;
  durationMs: number;
}

const baseSpace: LoadingSpace = {
  id: 'test-space',
  name: 'Test 20ft Container',
  category: 'container',
  internalLength: 5898,
  internalWidth: 2352,
  internalHeight: 2393,
  maxPayload: 20000,
  doorWidth: 2340,
  doorHeight: 2280,
  loadingDirection: 'rear',
};

function makePkg(overrides: Partial<PackageSpec>): PackageSpec {
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'Test Box',
    sku: overrides.sku ?? 'TST-001',
    length: overrides.length ?? 1000,
    width: overrides.width ?? 800,
    height: overrides.height ?? 600,
    weight: overrides.weight ?? 50,
    quantity: overrides.quantity ?? 1,
    color: '#ea580c',
    category: 'Test',
    stackable: overrides.stackable ?? true,
    rotatable: overrides.rotatable ?? true,
    fragile: overrides.fragile ?? false,
    thisSideUp: overrides.thisSideUp ?? false,
    maxStackWeight: overrides.maxStackWeight ?? 0,
    maxStackLayers: overrides.maxStackLayers ?? 0,
    allowedAxes: overrides.allowedAxes ?? { x: true, y: true, z: true },
    priority: overrides.priority ?? 5,
  };
}

export function runAllVerificationTests(): TestCaseResult[] {
  const results: TestCaseResult[] = [];

  const runCase = (id: number, name: string, fn: () => { passed: boolean; details: string }) => {
    const t0 = performance.now();
    try {
      const out = fn();
      results.push({ id, name, passed: out.passed, details: out.details, durationMs: Math.round(performance.now() - t0) });
    } catch (e) {
      results.push({
        id,
        name,
        passed: false,
        details: e instanceof Error ? e.message : 'Exception thrown',
        durationMs: Math.round(performance.now() - t0),
      });
    }
  };

  // 1. One package inside one container
  runCase(1, 'Single package inside one container', () => {
    const res = runOptimization({
      space: baseSpace,
      packages: [makePkg({ quantity: 1 })],
      mode: 'max_volume',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const passed = res.loadedPackagesCount === 1 && res.verification.isValid;
    return { passed, details: `Loaded ${res.loadedPackagesCount}/1, valid=${res.verification.isValid}` };
  });

  // 2. Multiple identical packages
  runCase(2, 'Multiple identical packages (24 units)', () => {
    const res = runOptimization({
      space: baseSpace,
      packages: [makePkg({ length: 1000, width: 800, height: 600, quantity: 24 })],
      mode: 'max_volume',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const passed = res.loadedPackagesCount === 24 && res.verification.isValid;
    return { passed, details: `Loaded ${res.loadedPackagesCount}/24, volUtil=${res.volumeUtilizationPct}%` };
  });

  // 3. Different package dimensions
  runCase(3, 'Mixed heterogeneous package dimensions', () => {
    const res = runOptimization({
      space: baseSpace,
      packages: [
        makePkg({ id: 'a', sku: 'A', length: 1200, width: 800, height: 900, quantity: 6 }),
        makePkg({ id: 'b', sku: 'B', length: 600, width: 400, height: 400, quantity: 25 }),
        makePkg({ id: 'c', sku: 'C', length: 800, width: 600, height: 500, quantity: 10 }),
      ],
      mode: 'balanced',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const passed = res.loadedPackagesCount === 41 && res.verification.isValid;
    return { passed, details: `Loaded ${res.loadedPackagesCount}/41 across 3 SKUs, valid=${res.verification.isValid}` };
  });

  // 4. Rotatable vs non-rotatable packages
  runCase(4, 'Rotatable vs non-rotatable orientation lock', () => {
    const tightSpace: LoadingSpace = {
      ...baseSpace,
      internalLength: 1000,
      internalWidth: 1200,
      internalHeight: 1000,
      doorWidth: 1200,
      doorHeight: 1000,
    };
    const pkg = makePkg({ length: 1200, width: 800, height: 600, rotatable: false, quantity: 1 });
    const resLocked = runOptimization({
      space: tightSpace,
      packages: [pkg],
      mode: 'max_volume',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const resRot = runOptimization({
      space: tightSpace,
      packages: [{ ...pkg, rotatable: true }],
      mode: 'max_volume',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const passed = resLocked.loadedPackagesCount === 0 && resRot.loadedPackagesCount === 1 && resRot.verification.isValid;
    return {
      passed,
      details: `Locked loaded=${resLocked.loadedPackagesCount} (expected 0), Rotatable loaded=${resRot.loadedPackagesCount} (expected 1)`,
    };
  });

  // 5. Fragile packages
  runCase(5, 'Fragile package protection (no heavy cargo stacked above)', () => {
    const smallSpace: LoadingSpace = {
      ...baseSpace,
      internalLength: 1000,
      internalWidth: 1000,
      internalHeight: 2000,
      doorWidth: 1000,
      doorHeight: 2000,
    };
    const res = runOptimization({
      space: smallSpace,
      packages: [
        makePkg({ id: 'frag', sku: 'FRG', length: 1000, width: 1000, height: 800, weight: 20, fragile: true, quantity: 1 }),
        makePkg({ id: 'hvy', sku: 'HVY', length: 1000, width: 1000, height: 800, weight: 200, fragile: false, quantity: 1 }),
      ],
      mode: 'balanced',
      allowRotation: false,
      loadingDirection: 'rear',
    });
    const fragBox = res.placedPackages.find((p) => p.sku === 'FRG');
    const hvyBox = res.placedPackages.find((p) => p.sku === 'HVY');
    const passed = !!fragBox && !!hvyBox && fragBox.y > hvyBox.y && res.verification.isValid;
    return { passed, details: `Heavy Y=${hvyBox?.y}mm, Fragile Y=${fragBox?.y}mm, valid=${res.verification.isValid}` };
  });

  // 6. Non-stackable packages
  runCase(6, 'Non-stackable package enforcement', () => {
    const colSpace: LoadingSpace = {
      ...baseSpace,
      internalLength: 1000,
      internalWidth: 1000,
      internalHeight: 2000,
      doorWidth: 1000,
      doorHeight: 2000,
    };
    const res = runOptimization({
      space: colSpace,
      packages: [makePkg({ length: 1000, width: 1000, height: 800, stackable: false, quantity: 2 })],
      mode: 'max_count',
      allowRotation: false,
      loadingDirection: 'rear',
    });
    const passed = res.loadedPackagesCount === 1 && res.verification.isValid;
    return { passed, details: `Loaded ${res.loadedPackagesCount}/2 (second blocked above non-stackable)` };
  });

  // 7. Maximum payload restrictions
  runCase(7, 'Maximum payload limit enforcement', () => {
    const weightSpace: LoadingSpace = { ...baseSpace, maxPayload: 1000 };
    const res = runOptimization({
      space: weightSpace,
      packages: [makePkg({ length: 600, width: 600, height: 600, weight: 300, quantity: 5 })],
      mode: 'max_volume',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const passed = res.loadedPackagesCount === 3 && res.totalCargoWeightKg <= 1000 && res.verification.isValid;
    return { passed, details: `Loaded ${res.loadedPackagesCount}/5 (${res.totalCargoWeightKg} kg <= 1000 kg)` };
  });

  // 8. Maximum stacking weight
  runCase(8, 'Maximum stacking weight limit enforcement', () => {
    const colSpace: LoadingSpace = {
      ...baseSpace,
      internalLength: 1000,
      internalWidth: 1000,
      internalHeight: 3000,
      doorWidth: 1000,
      doorHeight: 3000,
    };
    const res = runOptimization({
      space: colSpace,
      packages: [
        makePkg({
          length: 1000,
          width: 1000,
          height: 600,
          weight: 100,
          maxStackWeight: 150,
          quantity: 4,
        }),
      ],
      mode: 'max_count',
      allowRotation: false,
      loadingDirection: 'rear',
    });
    // Floor box can only hold 150 kg above it -> 1 box (100 kg) on top, 2nd box (200 kg total) rejected!
    const passed = res.loadedPackagesCount === 2 && res.verification.isValid;
    return { passed, details: `Loaded ${res.loadedPackagesCount}/4 respecting 150kg maxStackWeight` };
  });

  // 9. Insufficient loading space
  runCase(9, 'Insufficient loading space diagnostics', () => {
    const tinySpace: LoadingSpace = {
      ...baseSpace,
      internalLength: 1000,
      internalWidth: 1000,
      internalHeight: 1000,
      doorWidth: 1000,
      doorHeight: 1000,
    };
    const res = runOptimization({
      space: tinySpace,
      packages: [makePkg({ length: 600, width: 600, height: 600, quantity: 5 })],
      mode: 'max_volume',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const passed = res.loadedPackagesCount === 1 && res.unloadedPackagesCount === 4 && res.unloadedDetails.length === 1;
    return { passed, details: `Loaded 1, Unloaded ${res.unloadedPackagesCount} with reason code ${res.unloadedDetails[0]?.reasons.join(',')}` };
  });

  // 10. Multiple containers required
  runCase(10, 'Minimum vehicles / multi-container packing', () => {
    const smallSpace: LoadingSpace = {
      ...baseSpace,
      internalLength: 1200,
      internalWidth: 1000,
      internalHeight: 1000,
      doorWidth: 1000,
      doorHeight: 1000,
    };
    const res = runOptimization({
      space: smallSpace,
      packages: [makePkg({ length: 1000, width: 800, height: 800, quantity: 3 })],
      mode: 'min_vehicles',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const passed = res.loadedPackagesCount === 3 && res.containersUsed === 3 && res.verification.isValid;
    return { passed, details: `Packed 3/3 packages into ${res.containersUsed} containers` };
  });

  // 11. Door clearance
  runCase(11, 'Door clearance rejection check', () => {
    const narrowDoorSpace: LoadingSpace = {
      ...baseSpace,
      internalWidth: 2350,
      internalHeight: 2400,
      doorWidth: 1500,
      doorHeight: 1800,
    };
    const res = runOptimization({
      space: narrowDoorSpace,
      packages: [makePkg({ length: 2000, width: 1900, height: 1900, quantity: 1 })],
      mode: 'max_volume',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const passed =
      res.loadedPackagesCount === 0 &&
      res.unloadedDetails[0]?.reasons.includes('EXCEEDS_DOOR_CLEARANCE') === true;
    return { passed, details: `Rejected door-oversized cargo cleanly` };
  });

  // 12. Package collision detection
  runCase(12, 'Zero collision across dense 80-box load', () => {
    const res = runOptimization({
      space: baseSpace,
      packages: [makePkg({ length: 600, width: 400, height: 400, weight: 15, quantity: 80 })],
      mode: 'max_volume',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const collisionCheck = res.verification.checks.find((c) => c.name.includes('Collision'));
    const passed = res.loadedPackagesCount === 80 && !!collisionCheck?.passed;
    return { passed, details: `${res.loadedPackagesCount}/80 placed, ${collisionCheck?.details}` };
  });

  // 13. Full support and stability checks
  runCase(13, 'Base support & stability verification', () => {
    const res = runOptimization({
      space: baseSpace,
      packages: [
        makePkg({ id: 'base', sku: 'BASE', length: 1200, width: 800, height: 500, quantity: 8 }),
        makePkg({ id: 'top', sku: 'TOP', length: 600, width: 400, height: 400, quantity: 24 }),
      ],
      mode: 'balanced',
      allowRotation: true,
      loadingDirection: 'rear',
    });
    const supportCheck = res.verification.checks.find((c) => c.name.includes('Stability'));
    const passed = !!supportCheck?.passed && res.verification.isValid;
    return { passed, details: `${supportCheck?.details}` };
  });

  return results;
}
