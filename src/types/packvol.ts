export type LengthUnit = 'mm' | 'cm' | 'm' | 'in';
export type WeightUnit = 'kg' | 'lb';
export type Language = 'en' | 'ar';

export type SpaceCategory = 'container' | 'truck' | 'pallet' | 'railway' | 'custom';
export type LoadingDirection = 'rear' | 'side' | 'top';

export type OptimizationMode =
  | 'max_volume'
  | 'max_count'
  | 'min_vehicles'
  | 'weight_balance'
  | 'balanced';

export interface LoadingSpace {
  id: string;
  name: string;
  nameAr?: string;
  category: SpaceCategory;
  /** Internal length in mm (X axis) */
  internalLength: number;
  /** Internal width in mm (Z axis) */
  internalWidth: number;
  /** Internal height in mm (Y axis) */
  internalHeight: number;
  /** Maximum payload capacity in kg */
  maxPayload: number;
  /** Optional tare weight in kg */
  tareWeight?: number;
  /** Door width in mm (used for rear/side clearance checks) */
  doorWidth: number;
  /** Door height in mm */
  doorHeight: number;
  /** Optional floor weight limit in kg/m² */
  floorWeightLimit?: number;
  /** Restrictions description or notes */
  restrictions?: string;
  /** Default loading direction */
  loadingDirection: LoadingDirection;
}

export interface AllowedAxes {
  /** Rotate around X axis (tilts length/height) */
  x: boolean;
  /** Rotate around Y axis (flat spin length/width) */
  y: boolean;
  /** Rotate around Z axis (tilts width/height) */
  z: boolean;
}

export interface PackageSpec {
  id: string;
  name: string;
  nameAr?: string;
  sku: string;
  /** Length in mm */
  length: number;
  /** Width in mm */
  width: number;
  /** Height in mm */
  height: number;
  /** Weight in kg */
  weight: number;
  quantity: number;
  color: string;
  category: string;
  categoryAr?: string;
  stackable: boolean;
  rotatable: boolean;
  fragile: boolean;
  thisSideUp: boolean;
  /** Maximum weight (kg) that can sit on top of this package; 0 = unlimited if stackable */
  maxStackWeight: number;
  /** Maximum layers allowed above this package; 0 = unlimited if stackable */
  maxStackLayers: number;
  allowedAxes: AllowedAxes;
  /** 1 (lowest) to 10 (highest priority) */
  priority: number;
}

export interface PlacedPackage {
  instanceId: string;
  packageId: string;
  sku: string;
  name: string;
  category: string;
  color: string;
  /** Container index (0-based) for multi-container solutions */
  containerIndex: number;
  /** Step index (1-based) in loading sequence */
  stepIndex: number;
  /** Min X corner in mm (0..internalLength) */
  x: number;
  /** Min Y corner in mm (0..internalHeight, vertical up) */
  y: number;
  /** Min Z corner in mm (0..internalWidth) */
  z: number;
  /** Oriented dimension along X (length) in mm */
  dx: number;
  /** Oriented dimension along Y (height) in mm */
  dy: number;
  /** Oriented dimension along Z (width) in mm */
  dz: number;
  weight: number;
  /** Human-readable orientation string e.g. "L×W×H" or "W×L×H" */
  orientationLabel: string;
  /** Vertical layer index (0 = on floor) */
  layerIndex: number;
  fragile: boolean;
  stackable: boolean;
  thisSideUp: boolean;
  /** Percentage of bottom face area supported by floor or boxes below (0..100) */
  supportedAreaPct: number;
}

export interface UnloadedPackageReason {
  packageId: string;
  sku: string;
  name: string;
  requestedQty: number;
  loadedQty: number;
  unloadedQty: number;
  reasons: UnloadedReasonCode[];
  detail: string;
}

export type UnloadedReasonCode =
  | 'EXCEEDS_SPACE_DIMS'
  | 'EXCEEDS_DOOR_CLEARANCE'
  | 'EXCEEDS_PAYLOAD'
  | 'INSUFFICIENT_SPACE'
  | 'STACKING_RESTRICTION'
  | 'ORIENTATION_LOCKED'
  | 'FLOOR_LOAD_EXCEEDED';

export interface EmptySpaceBox {
  containerIndex: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
}

export interface ContainerSummary {
  containerIndex: number;
  space?: LoadingSpace;
  loadedCount: number;
  occupiedVolumeMm3: number;
  volumeUtilizationPct: number;
  loadedWeightKg: number;
  weightUtilizationPct: number;
  centerOfGravity: { x: number; y: number; z: number };
  balanceScore: number;
}

export interface StrategyBenchmark {
  strategyId: string;
  strategyName: string;
  loadedCount: number;
  totalRequested: number;
  volumeUtilizationPct: number;
  weightUtilizationPct: number;
  containersUsed: number;
  balanceScore: number;
  valid: boolean;
  durationMs: number;
}

export interface VerificationCheck {
  id?: string;
  name: string;
  passed: boolean;
  details: string;
}

export interface OptimizationVerification {
  isValid: boolean;
  checks: VerificationCheck[];
  violations: string[];
}

export interface OptimizationWarning {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface OptimizationResult {
  id: string;
  timestamp: number;
  mode: OptimizationMode;
  strategyName: string;
  allowRotation: boolean;
  loadingDirection: LoadingDirection;
  totalRequiredPackages: number;
  loadedPackagesCount: number;
  unloadedPackagesCount: number;
  containersUsed: number;
  configuredContainersCount?: number;
  autoDeterminedContainers?: boolean;
  targetUtilizationPct?: number;
  preferKeepItemSameContainer?: boolean;
  estimatedTrips: number;
  spaceVolumeMm3: number;
  occupiedVolumeMm3: number;
  remainingVolumeMm3: number;
  volumeUtilizationPct: number;
  totalCargoWeightKg: number;
  remainingPayloadKg: number;
  weightUtilizationPct: number;
  centerOfGravity: { x: number; y: number; z: number };
  balanceScore: number;
  placedPackages: PlacedPackage[];
  emptySpaces: EmptySpaceBox[];
  containerSummaries: ContainerSummary[];
  unloadedDetails: UnloadedPackageReason[];
  warnings: OptimizationWarning[];
  strategyComparison: StrategyBenchmark[];
  verification: OptimizationVerification;
  durationMs: number;
}

export interface Project {
  id: string;
  name: string;
  nameAr?: string;
  description: string;
  descriptionAr?: string;
  space: LoadingSpace;
  spaces?: LoadingSpace[];
  packages: PackageSpec[];
  mode: OptimizationMode;
  allowRotation: boolean;
  loadingDirection: LoadingDirection;
  targetUtilizationPct?: number;
  preferKeepItemSameContainer?: boolean;
  lastResult: OptimizationResult | null;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  projectId: string;
  projectName: string;
  spaceName: string;
  mode: OptimizationMode;
  loadedCount: number;
  totalCount: number;
  volumeUtilizationPct: number;
  totalWeightKg: number;
  containersUsed: number;
  isValid: boolean;
  timestamp: number;
}

export interface AppSettings {
  language: Language;
  lengthUnit: LengthUnit;
  weightUnit: WeightUnit;
  lowPerfMode: boolean;
  showFloorGrid: boolean;
  showWalls: boolean;
  transparentWalls: boolean;
  showEmptySpaces: boolean;
  showPackageIds: boolean;
}

export interface ManualPlacementValidation {
  valid: boolean;
  reasonCode?: string;
  reasonEn: string;
  reasonAr: string;
  supportedAreaPct: number;
  layerIndex: number;
}
