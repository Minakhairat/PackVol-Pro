import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  BookmarkPlus,
  CheckCircle2,
  Copy,
  Crosshair,
  Download,
  Edit3,
  FileSpreadsheet,
  FileText,
  Hand,
  Layers,
  Library,
  MousePointerClick,
  Play,
  Plus,
  RotateCw,
  Trash2,
  Undo2,
  Upload,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import {
  AppSettings,
  LoadingDirection,
  LoadingSpace,
  OptimizationMode,
  OptimizationResult,
  PackageSpec,
  PlacedPackage,
  Project,
} from '../types/packvol';
import { formatDims, formatLength, formatVolume, formatWeight, fromMm, toMm } from '../utils/units';
import {
  t,
  translateStrategyName,
  translateVerificationName,
} from '../i18n/translations';
import { SpaceConfigPanel } from './SpaceConfigPanel';
import { PackageFormModal } from './PackageFormModal';
import { Viewport3D, Viewport3DHandle } from './Viewport3D';
import { Views2D } from './Views2D';
import {
  exportToCsv,
  exportToExcel,
  exportToPdf,
  parseImportedPackagesFile,
} from '../utils/exporters';
import { getAllowedOrientations, runOptimization } from '../engine/packer';
import {
  buildResultFromManualPlacements,
  computeDropY,
  findNextValidSpot,
  validateManualPlacement,
} from '../engine/manualPacker';

interface WorkspaceViewProps {
  project: Project;
  library: PackageSpec[];
  settings: AppSettings;
  onUpdateProject: (
    updatedOrUpdater: Project | ((prev: Project) => Project),
    recordHistory?: boolean
  ) => void;
  onUpdateSettings: (updated: AppSettings) => void;
  onSaveToLibrary: (pkg: PackageSpec) => void;
}

export const WorkspaceView: React.FC<WorkspaceViewProps> = ({
  project,
  library,
  settings,
  onUpdateProject,
  onUpdateSettings,
  onSaveToLibrary,
}) => {
  const { language, lengthUnit, weightUnit } = settings;

  const viewportRef = useRef<Viewport3DHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  // Undo stack for package manifest edits
  const [undoStack, setUndoStack] = useState<PackageSpec[][]>([]);

  // Mode: Automatic Optimization vs Interactive Manual Loading
  const [workspaceMode, setWorkspaceMode] = useState<'auto' | 'manual'>('auto');
  const [manualTool, setManualTool] = useState<'place' | 'select'>('place');
  const [manualPkgId, setManualPkgId] = useState<string | null>(null);
  const [manualOrientIdx, setManualOrientIdx] = useState(0);
  const [manualCoords, setManualCoords] = useState<{ x: number; y: number; z: number }>({
    x: 0,
    y: 0,
    z: 0,
  });
  const [manualFeedback, setManualFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [manualUndoStack, setManualUndoStack] = useState<PlacedPackage[][]>([]);

  // UI state
  const [editingPkg, setEditingPkg] = useState<PackageSpec | null>(null);
  const [showPkgModal, setShowPkgModal] = useState(false);
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  const [mobileSection, setMobileSection] = useState<'setup' | '3d' | 'results'>('3d');
  const [resultTab, setResultTab] = useState<'summary' | 'views2d' | 'sequence' | 'strategies'>('summary');
  const [mobileFullscreen3D, setMobileFullscreen3D] = useState(false);

  // Optimization worker state
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optProgress, setOptProgress] = useState(0);
  const [optStage, setOptStage] = useState('');
  const [optError, setOptError] = useState<string | null>(null);

  // 3D Inspection state
  const [activeContainerIdx, setActiveContainerIdx] = useState(0);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set());
  const [maxVisibleLayer, setMaxVisibleLayer] = useState<number | null>(null);
  const [activeStepLimit, setActiveStepLimit] = useState<number | null>(null);
  const [isPlayingSequence, setIsPlayingSequence] = useState(false);

  const result = project.lastResult;

  // Reset inspection controls when switching project
  useEffect(() => {
    setActiveContainerIdx(0);
    setSelectedInstanceId(null);
    setMaxVisibleLayer(null);
    setActiveStepLimit(null);
    setIsPlayingSequence(false);
    setManualFeedback(null);
    setManualUndoStack([]);
  }, [project.id]);

  // Sequence playback timer
  useEffect(() => {
    if (!isPlayingSequence || !result) return;
    const containerCount = result.placedPackages.filter(
      (p) => p.containerIndex === activeContainerIdx
    ).length;
    if (containerCount === 0) {
      setIsPlayingSequence(false);
      return;
    }

    const timer = window.setInterval(() => {
      setActiveStepLimit((prev) => {
        const cur = prev === null ? 0 : prev;
        if (cur >= containerCount) {
          setIsPlayingSequence(false);
          return null;
        }
        return cur + 1;
      });
    }, 320);

    return () => window.clearInterval(timer);
  }, [isPlayingSequence, result, activeContainerIdx]);

  // Cleanup worker on unmount
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const pushManifestChange = (nextPackages: PackageSpec[]) => {
    setUndoStack((prev) => [...prev.slice(-14), project.packages]);
    onUpdateProject((prev) => ({
      ...prev,
      packages: nextPackages,
      updatedAt: Date.now(),
    }));
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prevList = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    onUpdateProject((prev) => ({
      ...prev,
      packages: prevList,
      updatedAt: Date.now(),
    }));
  };

  const handleUpdateSpace = (
    space: LoadingSpace,
    loadingDirection?: LoadingDirection,
    resetResult = false
  ) => {
    onUpdateProject((prev) => ({
      ...prev,
      space,
      loadingDirection: loadingDirection ?? prev.loadingDirection,
      lastResult: resetResult ? null : prev.lastResult,
      updatedAt: Date.now(),
    }));
    if (resetResult) {
      setActiveContainerIdx(0);
      setSelectedInstanceId(null);
      setMaxVisibleLayer(null);
      setActiveStepLimit(null);
      setManualUndoStack([]);
      setManualFeedback(null);
    }
  };

  const handleSavePackage = (spec: PackageSpec) => {
    const exists = project.packages.some((p) => p.id === spec.id);
    const next = exists
      ? project.packages.map((p) => (p.id === spec.id ? spec : p))
      : [...project.packages, spec];
    pushManifestChange(next);
    setShowPkgModal(false);
    setEditingPkg(null);
  };

  const handleDeletePackage = (id: string) => {
    pushManifestChange(project.packages.filter((p) => p.id !== id));
  };

  const handleDuplicatePackage = (pkg: PackageSpec) => {
    const copy: PackageSpec = {
      ...pkg,
      id: `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      sku: `${pkg.sku}-COPY`,
    };
    pushManifestChange([...project.packages, copy]);
  };

  const handleAddFromLibrary = (libPkg: PackageSpec) => {
    const copy: PackageSpec = {
      ...libPkg,
      id: `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    };
    pushManifestChange([...project.packages, copy]);
    setShowLibraryPicker(false);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await parseImportedPackagesFile(file);
      if (imported.length > 0) {
        pushManifestChange([...project.packages, ...imported]);
      }
    } catch (err) {
      setOptError(err instanceof Error ? err.message : 'Failed to parse Excel/CSV file.');
    } finally {
      e.target.value = '';
    }
  };

  const handleRunOptimization = () => {
    if (project.packages.length === 0) {
      setOptError(t(language, 'errAddPkgFirst'));
      return;
    }
    setWorkspaceMode('auto');
    setOptError(null);
    setIsOptimizing(true);
    setOptProgress(5);
    setOptStage(
      language === 'ar' ? 'تهيئة محرك التحسين ثلاثي الأبعاد...' : 'Initializing 3D packing engine...'
    );

    const jobId = `job-${Date.now()}`;
    activeJobIdRef.current = jobId;

    try {
      const worker = new Worker(new URL('../engine/packer.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current?.terminate();
      workerRef.current = worker;

      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.jobId !== activeJobIdRef.current) return;

        if (msg.type === 'progress') {
          setOptProgress(msg.pct);
          setOptStage(
            language === 'ar' ? translateStrategyName('ar', msg.stage) : msg.stage
          );
        } else if (msg.type === 'result') {
          setIsOptimizing(false);
          setOptProgress(100);
          setActiveContainerIdx(0);
          setSelectedInstanceId(null);
          setActiveStepLimit(null);
          onUpdateProject(
            (prev) => ({
              ...prev,
              lastResult: msg.result as OptimizationResult,
              updatedAt: Date.now(),
            }),
            true
          );
          if (window.innerWidth < 768) {
            setMobileSection('3d');
          }
          worker.terminate();
          workerRef.current = null;
        } else if (msg.type === 'cancelled') {
          setIsOptimizing(false);
          worker.terminate();
          workerRef.current = null;
        } else if (msg.type === 'error') {
          setIsOptimizing(false);
          setOptError(msg.error);
          worker.terminate();
          workerRef.current = null;
        }
      };

      worker.onerror = () => {
        worker.terminate();
        workerRef.current = null;
        const res = runOptimization({
          space: project.space,
          packages: project.packages,
          mode: project.mode,
          allowRotation: project.allowRotation,
          loadingDirection: project.loadingDirection,
        });
        setIsOptimizing(false);
        setActiveContainerIdx(0);
        setSelectedInstanceId(null);
        onUpdateProject((prev) => ({ ...prev, lastResult: res, updatedAt: Date.now() }), true);
      };

      worker.postMessage({
        type: 'optimize',
        jobId,
        payload: {
          space: project.space,
          packages: project.packages,
          mode: project.mode,
          allowRotation: project.allowRotation,
          loadingDirection: project.loadingDirection,
        },
      });
    } catch {
      const res = runOptimization({
        space: project.space,
        packages: project.packages,
        mode: project.mode,
        allowRotation: project.allowRotation,
        loadingDirection: project.loadingDirection,
      });
      setIsOptimizing(false);
      setActiveContainerIdx(0);
      setSelectedInstanceId(null);
      onUpdateProject((prev) => ({ ...prev, lastResult: res, updatedAt: Date.now() }), true);
    }
  };

  const handleCancelOptimization = () => {
    if (workerRef.current && activeJobIdRef.current) {
      workerRef.current.postMessage({ type: 'cancel', jobId: activeJobIdRef.current });
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setIsOptimizing(false);
  };

  /* -------------------- Interactive Manual Loading Helpers -------------------- */

  const placedCountByPkgId = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of result?.placedPackages ?? []) {
      map.set(b.packageId, (map.get(b.packageId) ?? 0) + 1);
    }
    return map;
  }, [result?.placedPackages]);

  const specsMap = useMemo(() => {
    const m = new Map<string, PackageSpec>();
    for (const s of project.packages) m.set(s.id, s);
    return m;
  }, [project.packages]);

  const manualActiveSpec = useMemo(() => {
    if (project.packages.length === 0) return null;
    const explicit = project.packages.find((p) => p.id === manualPkgId);
    if (explicit) return explicit;
    const firstRemaining = project.packages.find(
      (p) => p.quantity - (placedCountByPkgId.get(p.id) ?? 0) > 0
    );
    return firstRemaining ?? project.packages[0];
  }, [project.packages, manualPkgId, placedCountByPkgId]);

  const manualAllowedOrientations = useMemo(() => {
    if (!manualActiveSpec) return [];
    const list = getAllowedOrientations(
      manualActiveSpec,
      project.allowRotation,
      project.space,
      project.loadingDirection
    );
    if (list.length > 0) return list;
    return [
      {
        dx: manualActiveSpec.length,
        dy: manualActiveSpec.height,
        dz: manualActiveSpec.width,
        label: 'L×W×H',
      },
    ];
  }, [manualActiveSpec, project.allowRotation, project.space, project.loadingDirection]);

  const manualActiveOrientation = useMemo(() => {
    if (manualAllowedOrientations.length === 0) return null;
    return manualAllowedOrientations[manualOrientIdx % manualAllowedOrientations.length];
  }, [manualAllowedOrientations, manualOrientIdx]);

  const activeContainerPlaced = useMemo(
    () => (result?.placedPackages ?? []).filter((p) => p.containerIndex === activeContainerIdx),
    [result?.placedPackages, activeContainerIdx]
  );

  const selectedPlacedPkg = useMemo(
    () => activeContainerPlaced.find((p) => p.instanceId === selectedInstanceId) ?? null,
    [activeContainerPlaced, selectedInstanceId]
  );

  const commitManualPlacements = (nextPlaced: PlacedPackage[]) => {
    const prevPlaced = result?.placedPackages ?? [];
    setManualUndoStack((s) => [...s.slice(-24), prevPlaced]);
    const built = buildResultFromManualPlacements(
      project.space,
      project.packages,
      nextPlaced,
      project.allowRotation,
      project.loadingDirection
    );
    onUpdateProject((prev) => ({
      ...prev,
      lastResult: built,
      updatedAt: Date.now(),
    }));
  };

  const handleManualPlaceAt = (x: number, y: number, z: number) => {
    if (!manualActiveSpec || !manualActiveOrientation) return;
    const placedSoFar = placedCountByPkgId.get(manualActiveSpec.id) ?? 0;
    const rem = manualActiveSpec.quantity - placedSoFar;
    if (rem <= 0) {
      setManualFeedback({ ok: false, msg: t(language, 'noRemainingUnits') });
      return;
    }

    const val = validateManualPlacement(
      project.space,
      activeContainerPlaced,
      manualActiveSpec,
      manualActiveOrientation.dx,
      manualActiveOrientation.dy,
      manualActiveOrientation.dz,
      x,
      y,
      z,
      project.allowRotation,
      project.loadingDirection,
      specsMap
    );

    if (!val.valid) {
      setManualFeedback({
        ok: false,
        msg: language === 'ar' ? val.reasonAr : val.reasonEn,
      });
      return;
    }

    const newBox: PlacedPackage = {
      instanceId: `man-${manualActiveSpec.sku}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      packageId: manualActiveSpec.id,
      sku: manualActiveSpec.sku,
      name:
        language === 'ar' && manualActiveSpec.nameAr
          ? manualActiveSpec.nameAr
          : manualActiveSpec.name,
      category:
        language === 'ar' && manualActiveSpec.categoryAr
          ? manualActiveSpec.categoryAr
          : manualActiveSpec.category,
      color: manualActiveSpec.color,
      containerIndex: activeContainerIdx,
      stepIndex: activeContainerPlaced.length + 1,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      z: Math.round(z * 100) / 100,
      dx: manualActiveOrientation.dx,
      dy: manualActiveOrientation.dy,
      dz: manualActiveOrientation.dz,
      weight: manualActiveSpec.weight,
      orientationLabel: manualActiveOrientation.label,
      layerIndex: val.layerIndex,
      fragile: manualActiveSpec.fragile,
      stackable: manualActiveSpec.stackable,
      thisSideUp: manualActiveSpec.thisSideUp,
      supportedAreaPct: val.supportedAreaPct,
    };

    const nextPlaced = [...(result?.placedPackages ?? []), newBox];
    commitManualPlacements(nextPlaced);
    setSelectedInstanceId(newBox.instanceId);
    setManualCoords({ x: newBox.x, y: newBox.y, z: newBox.z });
    setManualFeedback({
      ok: true,
      msg:
        language === 'ar'
          ? `تم وضع ${newBox.sku} في (${fromMm(newBox.x, lengthUnit)}, ${fromMm(newBox.y, lengthUnit)}, ${fromMm(newBox.z, lengthUnit)}) ${lengthUnit}`
          : `Placed ${newBox.sku} at (${fromMm(newBox.x, lengthUnit)}, ${fromMm(newBox.y, lengthUnit)}, ${fromMm(newBox.z, lengthUnit)}) ${lengthUnit}`,
    });

    // Automatically advance to next package with remaining qty if this SKU just finished
    if (rem - 1 <= 0) {
      const nextAvailable = project.packages.find(
        (p) =>
          p.id !== manualActiveSpec.id &&
          p.quantity - (placedCountByPkgId.get(p.id) ?? 0) > 0
      );
      if (nextAvailable) {
        setManualPkgId(nextAvailable.id);
        setManualOrientIdx(0);
      }
    }
  };

  const handleAutoPlaceNext = () => {
    if (!manualActiveSpec || !manualActiveOrientation) return;
    const placedSoFar = placedCountByPkgId.get(manualActiveSpec.id) ?? 0;
    if (manualActiveSpec.quantity - placedSoFar <= 0) {
      setManualFeedback({ ok: false, msg: t(language, 'noRemainingUnits') });
      return;
    }

    const spot = findNextValidSpot(
      project.space,
      activeContainerPlaced,
      manualActiveSpec,
      manualActiveOrientation.dx,
      manualActiveOrientation.dy,
      manualActiveOrientation.dz,
      manualActiveOrientation.label,
      project.allowRotation,
      project.loadingDirection,
      specsMap
    );

    if (!spot) {
      setManualFeedback({
        ok: false,
        msg:
          language === 'ar'
            ? 'لا يوجد موضع متاح صالح فيزيائياً لهذه العبوة في الحاوية الحالية.'
            : 'No physically valid spot remaining for this package in current container.',
      });
      return;
    }

    const newBox: PlacedPackage = {
      instanceId: `man-${manualActiveSpec.sku}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      packageId: manualActiveSpec.id,
      sku: manualActiveSpec.sku,
      name:
        language === 'ar' && manualActiveSpec.nameAr
          ? manualActiveSpec.nameAr
          : manualActiveSpec.name,
      category:
        language === 'ar' && manualActiveSpec.categoryAr
          ? manualActiveSpec.categoryAr
          : manualActiveSpec.category,
      color: manualActiveSpec.color,
      containerIndex: activeContainerIdx,
      stepIndex: activeContainerPlaced.length + 1,
      x: spot.x,
      y: spot.y,
      z: spot.z,
      dx: spot.dx,
      dy: spot.dy,
      dz: spot.dz,
      weight: manualActiveSpec.weight,
      orientationLabel: spot.label,
      layerIndex: spot.validation.layerIndex,
      fragile: manualActiveSpec.fragile,
      stackable: manualActiveSpec.stackable,
      thisSideUp: manualActiveSpec.thisSideUp,
      supportedAreaPct: spot.validation.supportedAreaPct,
    };

    const nextPlaced = [...(result?.placedPackages ?? []), newBox];
    commitManualPlacements(nextPlaced);
    setSelectedInstanceId(newBox.instanceId);
    setManualCoords({ x: spot.x, y: spot.y, z: spot.z });
    setManualFeedback({
      ok: true,
      msg:
        language === 'ar'
          ? `تم تثبيت ${newBox.sku} في أقرب موضع متاح.`
          : `Snapped & placed ${newBox.sku} at next valid spot.`,
    });
  };

  const handleManualMoveSelected = (deltaX: number, deltaZ: number, drop = false, rotate = false) => {
    if (!selectedPlacedPkg) return;
    const spec = specsMap.get(selectedPlacedPkg.packageId);
    if (!spec) return;

    let nextDx = selectedPlacedPkg.dx;
    let nextDy = selectedPlacedPkg.dy;
    let nextDz = selectedPlacedPkg.dz;
    let nextLabel = selectedPlacedPkg.orientationLabel;

    if (rotate) {
      const allowed = getAllowedOrientations(
        spec,
        project.allowRotation,
        project.space,
        project.loadingDirection
      );
      if (allowed.length <= 1) {
        setManualFeedback({
          ok: false,
          msg:
            language === 'ar'
              ? 'هذه العبوة مقفلة الاتجاه ولا يمكن تدويرها.'
              : 'Package rotation is disabled for this item.',
        });
        return;
      }
      const curIdx = allowed.findIndex(
        (o) =>
          Math.abs(o.dx - selectedPlacedPkg.dx) < 0.1 &&
          Math.abs(o.dy - selectedPlacedPkg.dy) < 0.1 &&
          Math.abs(o.dz - selectedPlacedPkg.dz) < 0.1
      );
      const nextO = allowed[(curIdx + 1) % allowed.length];
      nextDx = nextO.dx;
      nextDy = nextO.dy;
      nextDz = nextO.dz;
      nextLabel = nextO.label;
    }

    const nextX = Math.max(0, Math.min(project.space.internalLength - nextDx, selectedPlacedPkg.x + deltaX));
    const nextZ = Math.max(0, Math.min(project.space.internalWidth - nextDz, selectedPlacedPkg.z + deltaZ));
    const nextY = drop
      ? computeDropY(activeContainerPlaced, nextX, nextZ, nextDx, nextDz, selectedPlacedPkg.instanceId)
      : selectedPlacedPkg.y;

    const val = validateManualPlacement(
      project.space,
      activeContainerPlaced,
      spec,
      nextDx,
      nextDy,
      nextDz,
      nextX,
      nextY,
      nextZ,
      project.allowRotation,
      project.loadingDirection,
      specsMap,
      selectedPlacedPkg.instanceId
    );

    if (!val.valid) {
      setManualFeedback({
        ok: false,
        msg: language === 'ar' ? val.reasonAr : val.reasonEn,
      });
      return;
    }

    const updatedBox: PlacedPackage = {
      ...selectedPlacedPkg,
      x: Math.round(nextX * 100) / 100,
      y: Math.round(nextY * 100) / 100,
      z: Math.round(nextZ * 100) / 100,
      dx: nextDx,
      dy: nextDy,
      dz: nextDz,
      orientationLabel: nextLabel,
      layerIndex: val.layerIndex,
      supportedAreaPct: val.supportedAreaPct,
    };

    const nextPlaced = (result?.placedPackages ?? []).map((p) =>
      p.instanceId === selectedPlacedPkg.instanceId ? updatedBox : p
    );
    commitManualPlacements(nextPlaced);
    setManualFeedback({
      ok: true,
      msg: language === 'ar' ? 'تم تحديث موضع العبوة بنجاح.' : 'Package position updated.',
    });
  };

  const handleRemoveSelectedPlaced = () => {
    if (!selectedPlacedPkg) return;
    const nextPlaced = (result?.placedPackages ?? []).filter(
      (p) => p.instanceId !== selectedPlacedPkg.instanceId
    );
    commitManualPlacements(nextPlaced);
    setSelectedInstanceId(null);
  };

  const handleUndoManual = () => {
    if (manualUndoStack.length === 0) return;
    const prevPlaced = manualUndoStack[manualUndoStack.length - 1];
    setManualUndoStack((s) => s.slice(0, -1));
    const built = buildResultFromManualPlacements(
      project.space,
      project.packages,
      prevPlaced,
      project.allowRotation,
      project.loadingDirection
    );
    onUpdateProject((prev) => ({
      ...prev,
      lastResult: built,
      updatedAt: Date.now(),
    }));
  };

  const handleClearContainerManual = () => {
    const nextPlaced = (result?.placedPackages ?? []).filter(
      (p) => p.containerIndex !== activeContainerIdx
    );
    commitManualPlacements(nextPlaced);
    setSelectedInstanceId(null);
  };

  const handleExportPng = () => {
    const dataUrl = viewportRef.current?.captureSnapshot();
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `PackVolPro_3D_${project.name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 32)}.png`;
    a.click();
  };

  const handleExportPdf = () => {
    if (!result) return;
    const snapshot = viewportRef.current?.captureSnapshot();
    exportToPdf(project, result, lengthUnit, weightUnit, snapshot);
  };

  // Distinct categories & max layer in active container
  const categoriesInResult = useMemo(() => {
    if (!result) return [];
    return Array.from(new Set(result.placedPackages.map((p) => p.category)));
  }, [result]);

  const maxLayerInContainer = useMemo(() => {
    if (!result) return 0;
    return result.placedPackages
      .filter((p) => p.containerIndex === activeContainerIdx)
      .reduce((m, p) => Math.max(m, p.layerIndex), 0);
  }, [result, activeContainerIdx]);

  const activeContainerSequence = useMemo(() => {
    if (!result) return [];
    return result.placedPackages.filter((p) => p.containerIndex === activeContainerIdx);
  }, [result, activeContainerIdx]);

  const totalManifestQty = project.packages.reduce((s, p) => s + p.quantity, 0);
  const totalManifestWeight = project.packages.reduce((s, p) => s + p.weight * p.quantity, 0);
  const displayProjectName = language === 'ar' && project.nameAr ? project.nameAr : project.name;

  return (
    <div className="space-y-4">
      {/* Top Project Action Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-white border border-zinc-200 rounded-xl p-3.5">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <input
            type="text"
            value={displayProjectName}
            onChange={(e) =>
              onUpdateProject((prev) => ({
                ...prev,
                name: language === 'ar' ? prev.name : e.target.value,
                nameAr: language === 'ar' ? e.target.value : prev.nameAr,
                updatedAt: Date.now(),
              }))
            }
            className="text-base font-bold text-zinc-900 bg-transparent border-b border-transparent hover:border-zinc-300 focus:border-orange-500 focus:outline-none truncate min-w-0 flex-1"
          />
          <span className="hidden sm:inline text-xs font-mono text-zinc-500 tabular-nums shrink-0">
            {totalManifestQty} {t(language, 'pkgsShort')} ·{' '}
            {formatWeight(totalManifestWeight, weightUnit)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* Auto vs Manual Loading Switcher */}
          <div className="inline-flex rounded-lg bg-zinc-100 p-1 border border-zinc-200">
            <button
              type="button"
              onClick={() => setWorkspaceMode('auto')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                workspaceMode === 'auto'
                  ? 'bg-zinc-900 text-white shadow-sm'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>{t(language, 'autoModeBtn')}</span>
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceMode('manual')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                workspaceMode === 'manual'
                  ? 'bg-orange-600 text-white shadow-sm'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              <Hand className="w-3.5 h-3.5" />
              <span>{t(language, 'manualModeBtn')}</span>
            </button>
          </div>

          {result && (
            <>
              <button
                onClick={handleExportPdf}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5 text-red-600" />
                <span>PDF</span>
              </button>
              <button
                onClick={() => exportToExcel(project, result, lengthUnit, weightUnit)}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 cursor-pointer"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                <span>Excel</span>
              </button>
              <button
                onClick={() => exportToCsv(project, result, lengthUnit, weightUnit)}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-zinc-600" />
                <span>CSV</span>
              </button>
            </>
          )}

          {isOptimizing ? (
            <button
              onClick={handleCancelOptimization}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              <span>
                {t(language, 'cancelOpt')} ({optProgress}%)
              </span>
            </button>
          ) : (
            <button
              onClick={handleRunOptimization}
              className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Play className="w-4 h-4 fill-current" />
              <span>{t(language, 'optimizeNow')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Progress / Error banners */}
      {isOptimizing && (
        <div className="bg-zinc-900 text-white rounded-lg px-4 py-2.5 flex items-center justify-between gap-4">
          <div className="text-xs font-medium truncate">{optStage}</div>
          <div className="flex items-center gap-3 w-48 shrink-0">
            <div className="flex-1 h-2 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-orange-500 transition-all duration-150"
                style={{ width: `${optProgress}%` }}
              />
            </div>
            <span className="text-xs font-mono tabular-nums">{optProgress}%</span>
          </div>
        </div>
      )}

      {optError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2.5 flex items-center justify-between text-xs font-medium text-red-700">
          <span>{optError}</span>
          <button onClick={() => setOptError(null)} className="p-1 hover:bg-red-100 rounded cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Mobile Section Switcher */}
      <div className="grid grid-cols-3 gap-1 p-1 bg-zinc-200 rounded-lg md:hidden">
        {(['setup', '3d', 'results'] as const).map((sec) => (
          <button
            key={sec}
            onClick={() => setMobileSection(sec)}
            className={`py-2 text-xs font-semibold rounded-md cursor-pointer ${
              mobileSection === sec ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600'
            }`}
          >
            {sec === 'setup'
              ? t(language, 'setupCargoTab')
              : sec === '3d'
                ? t(language, 'viewer3DTab')
                : t(language, 'results2DTab')}
          </button>
        ))}
      </div>

      {/* Main Split Workspace: Left Config Rail + Right 3D Viewport */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left Rail: Space Config + Manual Studio (when active) + Opt Mode + Cargo Manifest */}
        <div
          className={`lg:col-span-5 xl:col-span-4 space-y-4 ${
            mobileSection === 'setup' ? 'block' : 'hidden md:block'
          }`}
        >
          {/* Loading Space Card */}
          <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-bold text-zinc-900">{t(language, 'loadingSpace')}</h2>
            <SpaceConfigPanel
              space={project.space}
              loadingDirection={project.loadingDirection}
              lengthUnit={lengthUnit}
              weightUnit={weightUnit}
              language={language}
              onUpdateSpace={handleUpdateSpace}
            />
          </div>

          {/* Interactive Manual Loading Panel */}
          {workspaceMode === 'manual' && (
            <div className="rounded-xl border-2 border-orange-500/80 bg-white p-4 space-y-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Hand className="w-4 h-4 text-orange-600" />
                  <h2 className="text-sm font-bold text-zinc-900">{t(language, 'manualTitle')}</h2>
                </div>
                <div className="flex items-center gap-1">
                  {manualUndoStack.length > 0 && (
                    <button
                      onClick={handleUndoManual}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-800 cursor-pointer"
                    >
                      <Undo2 className="w-3 h-3" />
                      <span>{t(language, 'undo')}</span>
                    </button>
                  )}
                  <button
                    onClick={handleClearContainerManual}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium bg-red-50 hover:bg-red-100 text-red-700 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>{t(language, 'clearLoad')}</span>
                  </button>
                </div>
              </div>

              <p className="text-[11px] text-zinc-600 leading-relaxed">
                {t(language, 'manualHint')}
              </p>

              {/* Tool Switcher: Place Box vs Select/Move Box */}
              <div className="grid grid-cols-2 gap-1 p-1 bg-zinc-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setManualTool('place')}
                  className={`inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-semibold cursor-pointer ${
                    manualTool === 'place'
                      ? 'bg-orange-600 text-white shadow-sm'
                      : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  <Crosshair className="w-3.5 h-3.5" />
                  <span>{language === 'ar' ? 'وضع عبوة (3D)' : 'Place in 3D'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setManualTool('select')}
                  className={`inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-semibold cursor-pointer ${
                    manualTool === 'select'
                      ? 'bg-zinc-900 text-white shadow-sm'
                      : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  <MousePointerClick className="w-3.5 h-3.5" />
                  <span>{language === 'ar' ? 'تحديد وتحريك' : 'Select & Move'}</span>
                </button>
              </div>

              {/* Package Picker */}
              <div>
                <div className="text-xs font-semibold text-zinc-700 mb-1.5">
                  {t(language, 'selectPackageToPlace')}
                </div>
                {project.packages.length === 0 ? (
                  <div className="text-xs text-zinc-500 py-2">{t(language, 'emptyManifest')}</div>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pe-1">
                    {project.packages.map((pkg) => {
                      const used = placedCountByPkgId.get(pkg.id) ?? 0;
                      const rem = Math.max(0, pkg.quantity - used);
                      const isSel = manualActiveSpec?.id === pkg.id;
                      const pkgName = language === 'ar' && pkg.nameAr ? pkg.nameAr : pkg.name;
                      return (
                        <button
                          key={pkg.id}
                          type="button"
                          onClick={() => {
                            setManualPkgId(pkg.id);
                            setManualOrientIdx(0);
                            setManualTool('place');
                            setManualFeedback(null);
                          }}
                          className={`w-full text-start p-2 rounded-lg border flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                            isSel
                              ? 'border-orange-600 bg-orange-50'
                              : 'border-zinc-200 hover:bg-zinc-50'
                          } ${rem === 0 ? 'opacity-55' : ''}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="w-3 h-3 rounded-sm shrink-0 border border-black/20"
                              style={{ backgroundColor: pkg.color }}
                            />
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-zinc-900 truncate">
                                {pkgName}
                              </div>
                              <div className="text-[10px] font-mono text-zinc-500 tabular-nums">
                                {formatDims(pkg.length, pkg.width, pkg.height, lengthUnit)} ·{' '}
                                {formatWeight(pkg.weight, weightUnit)}
                              </div>
                            </div>
                          </div>
                          <span
                            className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded shrink-0 ${
                              rem > 0
                                ? 'bg-zinc-900 text-white'
                                : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {rem}/{pkg.quantity}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Active Orientation & Quick Placement Controls */}
              {manualActiveSpec && manualActiveOrientation && (
                <div className="pt-2 border-t border-zinc-200 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-mono text-zinc-700">
                      <span className="font-semibold">{t(language, 'orientation')}:</span>{' '}
                      {manualActiveOrientation.label} (
                      {formatDims(
                        manualActiveOrientation.dx,
                        manualActiveOrientation.dz,
                        manualActiveOrientation.dy,
                        lengthUnit
                      )}
                      )
                    </div>
                    <button
                      type="button"
                      disabled={manualAllowedOrientations.length <= 1}
                      onClick={() =>
                        setManualOrientIdx((i) => (i + 1) % manualAllowedOrientations.length)
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-45 cursor-pointer"
                    >
                      <RotateCw className="w-3 h-3" />
                      <span>{t(language, 'rotateOrientation')}</span>
                    </button>
                  </div>

                  {/* Exact Coordinate Inputs + Place */}
                  <div>
                    <label className="block text-[11px] font-medium text-zinc-600 mb-1">
                      {t(language, 'manualCoords')} ({lengthUnit})
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      <input
                        type="number"
                        step="any"
                        value={fromMm(manualCoords.x, lengthUnit)}
                        onChange={(e) =>
                          setManualCoords((c) => ({
                            ...c,
                            x: Math.max(0, toMm(Number(e.target.value) || 0, lengthUnit)),
                          }))
                        }
                        placeholder="X"
                        className="rounded border border-zinc-300 px-2 py-1 text-xs font-mono tabular-nums"
                      />
                      <input
                        type="number"
                        step="any"
                        value={fromMm(manualCoords.y, lengthUnit)}
                        onChange={(e) =>
                          setManualCoords((c) => ({
                            ...c,
                            y: Math.max(0, toMm(Number(e.target.value) || 0, lengthUnit)),
                          }))
                        }
                        placeholder="Y"
                        className="rounded border border-zinc-300 px-2 py-1 text-xs font-mono tabular-nums"
                      />
                      <input
                        type="number"
                        step="any"
                        value={fromMm(manualCoords.z, lengthUnit)}
                        onChange={(e) =>
                          setManualCoords((c) => ({
                            ...c,
                            z: Math.max(0, toMm(Number(e.target.value) || 0, lengthUnit)),
                          }))
                        }
                        placeholder="Z"
                        className="rounded border border-zinc-300 px-2 py-1 text-xs font-mono tabular-nums"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        handleManualPlaceAt(manualCoords.x, manualCoords.y, manualCoords.z)
                      }
                      className="rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 px-3 py-2 text-xs font-semibold text-zinc-900 cursor-pointer"
                    >
                      {t(language, 'placeAtCoords')}
                    </button>
                    <button
                      type="button"
                      onClick={handleAutoPlaceNext}
                      className="rounded-lg bg-orange-600 hover:bg-orange-500 px-3 py-2 text-xs font-semibold text-white cursor-pointer"
                    >
                      {t(language, 'autoPlaceNext')}
                    </button>
                  </div>
                </div>
              )}

              {/* Selected Placed Box Controls */}
              {selectedPlacedPkg && (
                <div className="pt-2.5 border-t border-zinc-200 space-y-2 bg-zinc-50 -mx-4 px-4 pb-1 rounded-b-xl">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-zinc-900">
                      #{selectedPlacedPkg.stepIndex} · {selectedPlacedPkg.sku}
                    </span>
                    <button
                      type="button"
                      onClick={handleRemoveSelectedPlaced}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:text-red-700 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t(language, 'removeSelected')}</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-4 gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleManualMoveSelected(-50, 0)}
                      className="inline-flex items-center justify-center gap-1 rounded border border-zinc-300 bg-white py-1.5 text-[11px] font-mono hover:bg-zinc-100 cursor-pointer"
                    >
                      <ArrowLeft className="w-3 h-3" /> X-
                    </button>
                    <button
                      type="button"
                      onClick={() => handleManualMoveSelected(50, 0)}
                      className="inline-flex items-center justify-center gap-1 rounded border border-zinc-300 bg-white py-1.5 text-[11px] font-mono hover:bg-zinc-100 cursor-pointer"
                    >
                      X+ <ArrowRight className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleManualMoveSelected(0, -50)}
                      className="inline-flex items-center justify-center gap-1 rounded border border-zinc-300 bg-white py-1.5 text-[11px] font-mono hover:bg-zinc-100 cursor-pointer"
                    >
                      <ArrowUp className="w-3 h-3" /> Z-
                    </button>
                    <button
                      type="button"
                      onClick={() => handleManualMoveSelected(0, 50)}
                      className="inline-flex items-center justify-center gap-1 rounded border border-zinc-300 bg-white py-1.5 text-[11px] font-mono hover:bg-zinc-100 cursor-pointer"
                    >
                      <ArrowDown className="w-3 h-3" /> Z+
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleManualMoveSelected(0, 0, false, true)}
                      className="inline-flex items-center justify-center gap-1 rounded border border-zinc-300 bg-white py-1.5 text-[11px] font-semibold hover:bg-zinc-100 cursor-pointer"
                    >
                      <RotateCw className="w-3 h-3" />
                      <span>{t(language, 'rotateSelected')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleManualMoveSelected(0, 0, true, false)}
                      className="inline-flex items-center justify-center gap-1 rounded border border-zinc-300 bg-white py-1.5 text-[11px] font-semibold hover:bg-zinc-100 cursor-pointer"
                    >
                      <ArrowDownToLine className="w-3 h-3" />
                      <span>{t(language, 'dropToFloor')}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Live Manual Feedback Banner */}
              {manualFeedback && (
                <div
                  className={`rounded-md px-3 py-2 text-[11px] font-medium border ${
                    manualFeedback.ok
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-red-50 border-red-200 text-red-800'
                  }`}
                >
                  {manualFeedback.msg}
                </div>
              )}
            </div>
          )}

          {/* Optimization Settings Card */}
          <div className="rounded-xl border border-zinc-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-bold text-zinc-900">{t(language, 'optimizationMode')}</h2>
            <select
              value={project.mode}
              onChange={(e) =>
                onUpdateProject((prev) => ({
                  ...prev,
                  mode: e.target.value as OptimizationMode,
                  updatedAt: Date.now(),
                }))
              }
              className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-xs font-medium text-zinc-900 focus:outline-none focus:border-orange-500"
            >
              <option value="balanced">{t(language, 'modeBalanced')}</option>
              <option value="max_volume">{t(language, 'modeMaxVolume')}</option>
              <option value="max_count">{t(language, 'modeMaxCount')}</option>
              <option value="min_vehicles">{t(language, 'modeMinVehicles')}</option>
              <option value="weight_balance">{t(language, 'modeWeightBalance')}</option>
            </select>

            <label className="flex items-center justify-between text-xs font-medium text-zinc-800 cursor-pointer pt-1">
              <span>{t(language, 'allowGlobalRotation')}</span>
              <input
                type="checkbox"
                checked={project.allowRotation}
                onChange={(e) =>
                  onUpdateProject((prev) => ({
                    ...prev,
                    allowRotation: e.target.checked,
                    updatedAt: Date.now(),
                  }))
                }
                className="accent-orange-600 w-4 h-4"
              />
            </label>
          </div>

          {/* Cargo Manifest Card */}
          <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
            <div className="p-4 border-b border-zinc-200 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-zinc-900">
                  {t(language, 'packagesList')} ({project.packages.length})
                </h2>
                {undoStack.length > 0 && (
                  <button
                    onClick={handleUndo}
                    className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 cursor-pointer"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    <span>{t(language, 'undo')}</span>
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => {
                    setEditingPkg(null);
                    setShowPkgModal(true);
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{t(language, 'addPackage')}</span>
                </button>
                <button
                  onClick={() => setShowLibraryPicker(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 cursor-pointer"
                >
                  <Library className="w-3.5 h-3.5" />
                  <span>{t(language, 'pickFromLibrary')}</span>
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>CSV / XLSX</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleImportFile}
                  className="hidden"
                />
              </div>
            </div>

            {project.packages.length === 0 ? (
              <div className="p-6 text-center text-xs text-zinc-500">
                {t(language, 'emptyManifest')}
              </div>
            ) : (
              <div className="divide-y divide-zinc-100 max-h-[380px] overflow-y-auto">
                {project.packages.map((pkg) => (
                  <div key={pkg.id} className="p-3 hover:bg-zinc-50 flex items-start gap-2.5">
                    <span
                      className="w-3.5 h-3.5 rounded-sm shrink-0 mt-1 border border-black/15"
                      style={{ backgroundColor: pkg.color }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-zinc-900 truncate">
                          {language === 'ar' && pkg.nameAr ? pkg.nameAr : pkg.name}
                        </span>
                        <span className="text-[11px] font-mono text-zinc-500 shrink-0">
                          {pkg.sku}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] font-mono text-zinc-600 tabular-nums">
                        {formatDims(pkg.length, pkg.width, pkg.height, lengthUnit)} ·{' '}
                        {formatWeight(pkg.weight, weightUnit)}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
                        <span>
                          {pkg.stackable ? t(language, 'stackLabel') : t(language, 'noStackLabel')}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {pkg.rotatable ? t(language, 'rotateLabel') : t(language, 'fixedLabel')}
                        </span>
                        {pkg.fragile && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-red-600 font-medium">
                              {t(language, 'fragileLabel')}
                            </span>
                          </>
                        )}
                        {pkg.thisSideUp && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-amber-700 font-medium">
                              {t(language, 'uprightLabel')}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <div className="flex items-center border border-zinc-300 rounded-md overflow-hidden bg-white">
                        <button
                          onClick={() => {
                            const nextQ = Math.max(1, pkg.quantity - 1);
                            pushManifestChange(
                              project.packages.map((p) =>
                                p.id === pkg.id ? { ...p, quantity: nextQ } : p
                              )
                            );
                          }}
                          className="px-2 py-0.5 text-xs font-bold text-zinc-700 hover:bg-zinc-100 cursor-pointer"
                        >
                          -
                        </button>
                        <input
                          type="number"
                          min="1"
                          value={pkg.quantity}
                          onChange={(e) => {
                            const nextQ = Math.max(1, Math.floor(Number(e.target.value) || 1));
                            pushManifestChange(
                              project.packages.map((p) =>
                                p.id === pkg.id ? { ...p, quantity: nextQ } : p
                              )
                            );
                          }}
                          className="w-11 text-center text-xs font-mono tabular-nums py-0.5 focus:outline-none"
                        />
                        <button
                          onClick={() =>
                            pushManifestChange(
                              project.packages.map((p) =>
                                p.id === pkg.id ? { ...p, quantity: p.quantity + 1 } : p
                              )
                            )
                          }
                          className="px-2 py-0.5 text-xs font-bold text-zinc-700 hover:bg-zinc-100 cursor-pointer"
                        >
                          +
                        </button>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            setEditingPkg(pkg);
                            setShowPkgModal(true);
                          }}
                          title={t(language, 'edit')}
                          className="p-1 text-zinc-500 hover:text-zinc-900 cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDuplicatePackage(pkg)}
                          title={t(language, 'duplicate')}
                          className="p-1 text-zinc-500 hover:text-zinc-900 cursor-pointer"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onSaveToLibrary(pkg)}
                          title={t(language, 'saveToLibrary')}
                          className="p-1 text-zinc-500 hover:text-orange-600 cursor-pointer"
                        >
                          <BookmarkPlus className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeletePackage(pkg.id)}
                          title={t(language, 'delete')}
                          className="p-1 text-red-500 hover:text-red-700 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Area: 3D Viewport + Filter Toolbar + Results */}
        <div
          className={`lg:col-span-7 xl:col-span-8 space-y-4 ${
            mobileSection === 'setup' ? 'hidden md:block' : 'block'
          }`}
        >
          {/* 3D Viewport Container */}
          <div
            className={`${
              mobileSection === '3d' ? 'block' : 'hidden md:block'
            } ${
              mobileFullscreen3D
                ? 'fixed inset-0 z-50 bg-zinc-900 p-2'
                : 'h-[480px] xl:h-[580px]'
            }`}
          >
            {mobileFullscreen3D && (
              <button
                onClick={() => setMobileFullscreen3D(false)}
                className="fixed top-4 right-4 z-50 rounded-lg bg-zinc-900 text-white px-3 py-1.5 text-xs font-semibold border border-zinc-700 shadow-lg"
              >
                {t(language, 'close')}
              </button>
            )}
            <Viewport3D
              ref={viewportRef}
              space={project.space}
              loadingDirection={project.loadingDirection}
              placedPackages={result?.placedPackages ?? []}
              emptySpaces={result?.emptySpaces ?? []}
              containerIndex={activeContainerIdx}
              lengthUnit={lengthUnit}
              weightUnit={weightUnit}
              language={language}
              lowPerfMode={settings.lowPerfMode}
              selectedInstanceId={selectedInstanceId}
              onSelectPackage={(pkg) => setSelectedInstanceId(pkg?.instanceId ?? null)}
              hiddenCategories={hiddenCategories}
              maxVisibleLayer={maxVisibleLayer}
              activeStepLimit={activeStepLimit}
              onStepLimitChange={(s) => {
                setIsPlayingSequence(false);
                setActiveStepLimit(s);
              }}
              isPlayingSequence={isPlayingSequence}
              onTogglePlaySequence={() => {
                if (!isPlayingSequence && activeStepLimit === null) {
                  setActiveStepLimit(0);
                }
                setIsPlayingSequence((p) => !p);
              }}
              showWalls={settings.showWalls}
              onToggleWalls={() =>
                onUpdateSettings({ ...settings, showWalls: !settings.showWalls })
              }
              transparentWalls={settings.transparentWalls}
              onToggleTransparentWalls={() =>
                onUpdateSettings({ ...settings, transparentWalls: !settings.transparentWalls })
              }
              showFloorGrid={settings.showFloorGrid}
              onToggleFloorGrid={() =>
                onUpdateSettings({ ...settings, showFloorGrid: !settings.showFloorGrid })
              }
              showEmptySpaces={settings.showEmptySpaces}
              onToggleEmptySpaces={() =>
                onUpdateSettings({ ...settings, showEmptySpaces: !settings.showEmptySpaces })
              }
              showPackageIds={settings.showPackageIds}
              onTogglePackageIds={() =>
                onUpdateSettings({ ...settings, showPackageIds: !settings.showPackageIds })
              }
              onExportPng={handleExportPng}
              onExpandMobile={() => setMobileFullscreen3D(true)}
              manualMode={workspaceMode === 'manual'}
              manualTool={manualTool}
              manualActiveSpec={manualActiveSpec}
              manualActiveOrientation={manualActiveOrientation}
              allowGlobalRotation={project.allowRotation}
              specsList={project.packages}
              onManualPlace={handleManualPlaceAt}
            />
          </div>

          {/* Container Selector + Category & Layer Filter Strip */}
          {result && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-2.5">
              {/* Multi-container tabs */}
              {result.containersUsed > 1 && (
                <div className="flex items-center gap-1 overflow-x-auto">
                  {result.containerSummaries.map((cs) => (
                    <button
                      key={cs.containerIndex}
                      onClick={() => setActiveContainerIdx(cs.containerIndex)}
                      className={`px-2.5 py-1 rounded-md text-xs font-mono font-semibold cursor-pointer whitespace-nowrap ${
                        activeContainerIdx === cs.containerIndex
                          ? 'bg-orange-600 text-white'
                          : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                      }`}
                    >
                      #{cs.containerIndex + 1} ({cs.volumeUtilizationPct}%)
                    </button>
                  ))}
                </div>
              )}

              {/* Category toggles */}
              <div className="flex flex-wrap items-center gap-1.5">
                {categoriesInResult.map((cat) => {
                  const hidden = hiddenCategories.has(cat);
                  return (
                    <button
                      key={cat}
                      onClick={() => {
                        const next = new Set(hiddenCategories);
                        if (hidden) next.delete(cat);
                        else next.add(cat);
                        setHiddenCategories(next);
                      }}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium border cursor-pointer transition-colors ${
                        hidden
                          ? 'border-zinc-200 bg-zinc-100 text-zinc-400 line-through'
                          : 'border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50'
                      }`}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>

              {/* Layer Filter */}
              <div className="flex items-center gap-2 text-xs">
                <Layers className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-zinc-600 font-medium">{t(language, 'layerFilter')}:</span>
                <select
                  value={maxVisibleLayer === null ? 'all' : String(maxVisibleLayer)}
                  onChange={(e) =>
                    setMaxVisibleLayer(e.target.value === 'all' ? null : Number(e.target.value))
                  }
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-mono"
                >
                  <option value="all">{t(language, 'allLayers')}</option>
                  {Array.from({ length: maxLayerInContainer + 1 }, (_, i) => (
                    <option key={i} value={i}>
                      0 .. {i}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Results, 2D Views, Loading Sequence & Strategy Comparison */}
          <div
            className={`${
              mobileSection === 'results' ? 'block' : 'hidden md:block'
            } rounded-xl border border-zinc-200 bg-white overflow-hidden`}
          >
            {!result ? (
              <div className="p-8 text-center space-y-3">
                <p className="text-sm text-zinc-600 max-w-md mx-auto">
                  {t(language, 'noResultsYet')}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    onClick={handleRunOptimization}
                    className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>{t(language, 'optimizeNow')}</span>
                  </button>
                  <button
                    onClick={() => setWorkspaceMode('manual')}
                    className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
                  >
                    <Hand className="w-3.5 h-3.5 text-orange-600" />
                    <span>{t(language, 'manualModeBtn')}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {/* Sub-tabs */}
                <div className="flex items-center gap-1 px-4 pt-3 border-b border-zinc-200 overflow-x-auto">
                  {(
                    [
                      ['summary', t(language, 'resultsSummary')],
                      ['views2d', t(language, 'views2D')],
                      ['sequence', t(language, 'loadingSequence')],
                      ['strategies', t(language, 'strategyComparison')],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setResultTab(id)}
                      className={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                        resultTab === id
                          ? 'border-orange-600 text-orange-600'
                          : 'border-transparent text-zinc-600 hover:text-zinc-900'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="p-4">
                  {resultTab === 'summary' && (
                    <div className="space-y-5">
                      {/* Physics Verification Banner */}
                      <div
                        className={`flex items-center justify-between gap-3 rounded-lg px-4 py-3 border ${
                          result.verification.isValid
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                            : 'bg-red-50 border-red-200 text-red-900'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          {result.verification.isValid ? (
                            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                          ) : (
                            <XCircle className="w-5 h-5 text-red-600 shrink-0" />
                          )}
                          <div>
                            <div className="text-xs font-bold">
                              {result.verification.isValid
                                ? t(language, 'verifiedValid')
                                : t(language, 'verifiedInvalid')}
                            </div>
                            <div className="text-[11px] opacity-80">
                              {translateStrategyName(language, result.strategyName)} ·{' '}
                              {t(language, 'solvedIn')} {result.durationMs} ms
                            </div>
                          </div>
                        </div>
                        <span className="text-xs font-mono font-semibold tabular-nums">
                          {result.verification.checks.filter((c) => c.passed).length}/
                          {result.verification.checks.length} {t(language, 'checksLabel')}
                        </span>
                      </div>

                      {/* Warnings */}
                      {result.warnings.length > 0 && (
                        <div className="space-y-2">
                          {result.warnings.map((w, idx) => (
                            <div
                              key={idx}
                              className={`flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-xs border ${
                                w.severity === 'error'
                                  ? 'bg-red-50 border-red-200 text-red-800'
                                  : 'bg-amber-50 border-amber-200 text-amber-900'
                              }`}
                            >
                              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                              <span>{w.message}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Core Metrics Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="rounded-lg border border-zinc-200 p-3">
                          <div className="text-[11px] text-zinc-500">{t(language, 'volumeUtil')}</div>
                          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-orange-600">
                            {result.volumeUtilizationPct}%
                          </div>
                          <div className="text-[11px] font-mono text-zinc-500 mt-0.5">
                            {formatVolume(result.occupiedVolumeMm3, lengthUnit)} /{' '}
                            {formatVolume(result.spaceVolumeMm3, lengthUnit)}
                          </div>
                        </div>

                        <div className="rounded-lg border border-zinc-200 p-3">
                          <div className="text-[11px] text-zinc-500">{t(language, 'loadedPackages')}</div>
                          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-zinc-900">
                            {result.loadedPackagesCount} / {result.totalRequiredPackages}
                          </div>
                          <div className="text-[11px] font-mono text-zinc-500 mt-0.5">
                            {result.unloadedPackagesCount} {t(language, 'unloadedPackages')}
                          </div>
                        </div>

                        <div className="rounded-lg border border-zinc-200 p-3">
                          <div className="text-[11px] text-zinc-500">{t(language, 'weightUtil')}</div>
                          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-zinc-900">
                            {result.weightUtilizationPct}%
                          </div>
                          <div className="text-[11px] font-mono text-zinc-500 mt-0.5">
                            {formatWeight(result.totalCargoWeightKg, weightUnit)} ·{' '}
                            {t(language, 'remShort')}{' '}
                            {formatWeight(result.remainingPayloadKg, weightUnit)}
                          </div>
                        </div>

                        <div className="rounded-lg border border-zinc-200 p-3">
                          <div className="text-[11px] text-zinc-500">{t(language, 'balanceScore')}</div>
                          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-zinc-900">
                            {result.balanceScore}/100
                          </div>
                          <div className="text-[11px] font-mono text-zinc-500 mt-0.5">
                            {result.containersUsed} {t(language, 'spaceUnit')} ·{' '}
                            {result.estimatedTrips} {t(language, 'tripUnit')}
                          </div>
                        </div>
                      </div>

                      {/* Additional Details Grid */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="rounded-lg border border-zinc-200 p-3.5 space-y-2">
                          <h4 className="text-xs font-bold text-zinc-900">
                            {t(language, 'verificationStatus')}
                          </h4>
                          <div className="divide-y divide-zinc-100">
                            {result.verification.checks.map((chk) => (
                              <div key={chk.name} className="py-1.5 flex items-start justify-between gap-2 text-xs">
                                <div>
                                  <div className="font-medium text-zinc-800">
                                    {translateVerificationName(language, chk.name)}
                                  </div>
                                  <div className="text-[11px] text-zinc-500">{chk.details}</div>
                                </div>
                                <span
                                  className={`font-mono text-[11px] font-bold shrink-0 ${
                                    chk.passed ? 'text-emerald-700' : 'text-red-600'
                                  }`}
                                >
                                  {chk.passed ? t(language, 'passLabel') : t(language, 'failLabel')}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="rounded-lg border border-zinc-200 p-3.5 space-y-2">
                          <h4 className="text-xs font-bold text-zinc-900">
                            {t(language, 'centerOfGravity')}
                          </h4>
                          <div className="space-y-1.5 text-xs font-mono text-zinc-700 tabular-nums">
                            <div className="flex justify-between">
                              <span>{t(language, 'spaceVolume')}:</span>
                              <span>{formatVolume(result.spaceVolumeMm3, lengthUnit)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>{t(language, 'occupiedVolume')}:</span>
                              <span>{formatVolume(result.occupiedVolumeMm3, lengthUnit)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>{t(language, 'remainingVolume')}:</span>
                              <span>{formatVolume(result.remainingVolumeMm3, lengthUnit)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>{t(language, 'totalCargoWeight')}:</span>
                              <span>{formatWeight(result.totalCargoWeightKg, weightUnit)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>{t(language, 'remainingPayload')}:</span>
                              <span>{formatWeight(result.remainingPayloadKg, weightUnit)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>{t(language, 'centerOfGravity')} (X, Y, Z):</span>
                              <span>
                                ({formatLength(result.centerOfGravity.x, lengthUnit, false)},{' '}
                                {formatLength(result.centerOfGravity.y, lengthUnit, false)},{' '}
                                {formatLength(result.centerOfGravity.z, lengthUnit, false)}) {lengthUnit}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Unloaded Package Diagnostics */}
                      {result.unloadedDetails.length > 0 && (
                        <div className="rounded-lg border border-red-200 bg-red-50/60 p-3.5 space-y-2">
                          <h4 className="text-xs font-bold text-red-900">
                            {t(language, 'unloadedDetailsTitle')}
                          </h4>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs text-start">
                              <thead>
                                <tr className="border-b border-red-200 text-red-900">
                                  <th className="py-1.5 text-start font-semibold">{t(language, 'sku')}</th>
                                  <th className="py-1.5 text-start font-semibold">{t(language, 'productName')}</th>
                                  <th className="py-1.5 text-end font-semibold">{t(language, 'reqCol')}</th>
                                  <th className="py-1.5 text-end font-semibold">{t(language, 'loadedCol')}</th>
                                  <th className="py-1.5 text-end font-semibold">{t(language, 'unloadedCol')}</th>
                                  <th className="py-1.5 text-start font-semibold ps-3">{t(language, 'reasonCol')}</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-red-100">
                                {result.unloadedDetails.map((u) => (
                                  <tr key={u.packageId}>
                                    <td className="py-1.5 font-mono">{u.sku}</td>
                                    <td className="py-1.5 font-medium">{u.name}</td>
                                    <td className="py-1.5 text-end font-mono tabular-nums">{u.requestedQty}</td>
                                    <td className="py-1.5 text-end font-mono tabular-nums">{u.loadedQty}</td>
                                    <td className="py-1.5 text-end font-mono tabular-nums font-bold text-red-700">
                                      {u.unloadedQty}
                                    </td>
                                    <td className="py-1.5 ps-3 text-red-800">{u.detail}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {resultTab === 'views2d' && (
                    <Views2D
                      space={project.space}
                      result={result}
                      lengthUnit={lengthUnit}
                      language={language}
                      containerIndex={activeContainerIdx}
                      selectedInstanceId={selectedInstanceId}
                      onSelectPackage={(pkg) => setSelectedInstanceId(pkg.instanceId)}
                    />
                  )}

                  {resultTab === 'sequence' && (
                    <div className="overflow-x-auto max-h-[420px]">
                      <table className="w-full text-xs text-start">
                        <thead className="sticky top-0 bg-zinc-50 border-b border-zinc-200 text-zinc-600">
                          <tr>
                            <th className="py-2 px-2 text-start font-semibold">{t(language, 'step')}</th>
                            <th className="py-2 px-2 text-start font-semibold">{t(language, 'sku')}</th>
                            <th className="py-2 px-2 text-start font-semibold">{t(language, 'productName')}</th>
                            <th className="py-2 px-2 text-start font-semibold">{t(language, 'position')}</th>
                            <th className="py-2 px-2 text-start font-semibold">{t(language, 'dimensions')}</th>
                            <th className="py-2 px-2 text-start font-semibold">{t(language, 'orientation')}</th>
                            <th className="py-2 px-2 text-end font-semibold">{t(language, 'weight')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                          {activeContainerSequence.map((p: PlacedPackage) => {
                            const isSel = selectedInstanceId === p.instanceId;
                            return (
                              <tr
                                key={p.instanceId}
                                onClick={() => {
                                  setSelectedInstanceId(p.instanceId);
                                  setActiveStepLimit(p.stepIndex);
                                  setIsPlayingSequence(false);
                                }}
                                className={`cursor-pointer transition-colors ${
                                  isSel ? 'bg-orange-50 font-semibold' : 'hover:bg-zinc-50'
                                }`}
                              >
                                <td className="py-2 px-2 font-mono tabular-nums text-orange-600 font-bold">
                                  #{p.stepIndex}
                                </td>
                                <td className="py-2 px-2 font-mono text-zinc-700">{p.sku}</td>
                                <td className="py-2 px-2 text-zinc-900">
                                  <span
                                    className="inline-block w-2.5 h-2.5 rounded-sm me-1.5 align-middle"
                                    style={{ backgroundColor: p.color }}
                                  />
                                  {p.name}
                                </td>
                                <td className="py-2 px-2 font-mono tabular-nums text-zinc-600">
                                  ({fromMm(p.x, lengthUnit)}, {fromMm(p.y, lengthUnit)}, {fromMm(p.z, lengthUnit)}) {lengthUnit}
                                </td>
                                <td className="py-2 px-2 font-mono tabular-nums text-zinc-600">
                                  {formatDims(p.dx, p.dz, p.dy, lengthUnit)}
                                </td>
                                <td className="py-2 px-2 font-mono text-zinc-600">{p.orientationLabel}</td>
                                <td className="py-2 px-2 text-end font-mono tabular-nums text-zinc-800">
                                  {formatWeight(p.weight, weightUnit)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {resultTab === 'strategies' && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-start">
                        <thead className="border-b border-zinc-200 text-zinc-600 bg-zinc-50">
                          <tr>
                            <th className="py-2 px-2 text-start font-semibold">{t(language, 'strategyCol')}</th>
                            <th className="py-2 px-2 text-end font-semibold">{t(language, 'loadedCol')}</th>
                            <th className="py-2 px-2 text-end font-semibold">{t(language, 'volCol')}</th>
                            <th className="py-2 px-2 text-end font-semibold">{t(language, 'weightUtil')}</th>
                            <th className="py-2 px-2 text-end font-semibold">{t(language, 'balanceCol')}</th>
                            <th className="py-2 px-2 text-end font-semibold">{t(language, 'spacesCol')}</th>
                            <th className="py-2 px-2 text-end font-semibold">{t(language, 'timeCol')}</th>
                            <th className="py-2 px-2 text-end font-semibold">{t(language, 'validCol')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                          {result.strategyComparison.map((st) => {
                            const isWinner = st.strategyName === result.strategyName;
                            return (
                              <tr
                                key={st.strategyId}
                                className={isWinner ? 'bg-orange-50/70 font-semibold' : ''}
                              >
                                <td className="py-2 px-2 text-zinc-900">
                                  {translateStrategyName(language, st.strategyName)}
                                  {isWinner && (
                                    <span className="ms-2 text-[10px] font-mono text-orange-600">
                                      {t(language, 'selectedBadge')}
                                    </span>
                                  )}
                                </td>
                                <td className="py-2 px-2 text-end font-mono tabular-nums">
                                  {st.loadedCount}/{st.totalRequested}
                                </td>
                                <td className="py-2 px-2 text-end font-mono tabular-nums text-orange-600">
                                  {st.volumeUtilizationPct}%
                                </td>
                                <td className="py-2 px-2 text-end font-mono tabular-nums">
                                  {st.weightUtilizationPct}%
                                </td>
                                <td className="py-2 px-2 text-end font-mono tabular-nums">
                                  {st.balanceScore}/100
                                </td>
                                <td className="py-2 px-2 text-end font-mono tabular-nums">
                                  {st.containersUsed}
                                </td>
                                <td className="py-2 px-2 text-end font-mono tabular-nums text-zinc-500">
                                  {st.durationMs} ms
                                </td>
                                <td className="py-2 px-2 text-end font-mono">
                                  <span className={st.valid ? 'text-emerald-700' : 'text-red-600'}>
                                    {st.valid ? t(language, 'passLabel') : t(language, 'failLabel')}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Add / Edit Package Modal */}
      {showPkgModal && (
        <PackageFormModal
          initial={editingPkg}
          lengthUnit={lengthUnit}
          weightUnit={weightUnit}
          language={language}
          onSave={handleSavePackage}
          onClose={() => {
            setShowPkgModal(false);
            setEditingPkg(null);
          }}
        />
      )}

      {/* Pick From Product Library Modal */}
      {showLibraryPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white border border-zinc-200 shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-zinc-900 text-white">
              <h3 className="text-sm font-semibold">{t(language, 'library')}</h3>
              <button
                onClick={() => setShowLibraryPicker(false)}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="divide-y divide-zinc-100 max-h-[65vh] overflow-y-auto">
              {library.map((item) => (
                <div
                  key={item.id}
                  className="p-3.5 flex items-center justify-between gap-3 hover:bg-zinc-50"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className="w-3.5 h-3.5 rounded-sm shrink-0"
                      style={{ backgroundColor: item.color }}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-zinc-900 truncate">
                        {language === 'ar' && item.nameAr ? item.nameAr : item.name}
                      </div>
                      <div className="text-[11px] font-mono text-zinc-500">
                        {item.sku} · {formatDims(item.length, item.width, item.height, lengthUnit)} ·{' '}
                        {formatWeight(item.weight, weightUnit)}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleAddFromLibrary(item)}
                    className="rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 shrink-0 cursor-pointer"
                  >
                    + {t(language, 'addPackage')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
