import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  Camera,
  Eye,
  EyeOff,
  Grid3X3,
  Layers,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Box as BoxIcon,
  SkipBack,
  SkipForward,
  ChevronDown,
  ChevronUp,
  Trash2,
} from 'lucide-react';
import {
  EmptySpaceBox,
  Language,
  LengthUnit,
  LoadingDirection,
  LoadingSpace,
  ManualPlacementValidation,
  PackageSpec,
  PlacedPackage,
  WeightUnit,
} from '../types/packvol';
import { formatDims, formatLength, formatWeight } from '../utils/units';
import { t } from '../i18n/translations';
import { computeDropY, snapManualCoords, validateManualPlacement } from '../engine/manualPacker';

export type CameraPreset = 'isometric' | 'front' | 'rear' | 'side' | 'top';

export interface Viewport3DHandle {
  captureSnapshot: () => string | null;
  setCameraPreset: (preset: CameraPreset) => void;
}

interface Viewport3DProps {
  space: LoadingSpace;
  loadingDirection: LoadingDirection;
  placedPackages: PlacedPackage[];
  emptySpaces: EmptySpaceBox[];
  containerIndex: number;
  lengthUnit: LengthUnit;
  weightUnit: WeightUnit;
  language: Language;
  lowPerfMode: boolean;
  selectedInstanceId: string | null;
  onSelectPackage: (pkg: PlacedPackage | null) => void;
  hiddenCategories: Set<string>;
  maxVisibleLayer: number | null; // null = all
  activeStepLimit: number | null; // null = all
  onStepLimitChange: (step: number | null) => void;
  isPlayingSequence: boolean;
  onTogglePlaySequence: () => void;
  showWalls: boolean;
  onToggleWalls: () => void;
  transparentWalls: boolean;
  onToggleTransparentWalls: () => void;
  showFloorGrid: boolean;
  onToggleFloorGrid: () => void;
  showEmptySpaces: boolean;
  onToggleEmptySpaces: () => void;
  showPackageIds: boolean;
  onTogglePackageIds: () => void;
  onExportPng?: () => void;
  onExpandMobile?: () => void;
  manualMode?: boolean;
  manualTool?: 'place' | 'select';
  manualActiveSpec?: PackageSpec | null;
  manualActiveOrientation?: { dx: number; dy: number; dz: number; label: string } | null;
  allowGlobalRotation?: boolean;
  specsList?: PackageSpec[];
  onManualPlace?: (x: number, y: number, z: number) => void;
  onRemoveSelected?: (instanceId: string) => void;
}

const SCALE = 0.001; // 1 unit = 1 meter (mm * 0.001)

const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();

function detectSoftwareGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function createFloorTexture(lengthM: number, widthM: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#d4cbb8';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle plank lines along container length
  ctx.strokeStyle = 'rgba(110, 95, 75, 0.25)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 16; i++) {
    const y = (i / 16) * 512;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }
  // Subtle cross seams
  ctx.strokeStyle = 'rgba(110, 95, 75, 0.14)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const x = (i / 8) * 512;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 512);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(Math.max(1, Math.round(lengthM / 2)), Math.max(1, Math.round(widthM / 2)));
  return tex;
}

function createStepLabelTexture(label: string, fragile: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
  ctx.fillRect(4, 4, 120, 56);
  ctx.strokeStyle = fragile ? '#b91c1c' : '#dc2626';
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, 120, 56);

  ctx.fillStyle = '#18181b';
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 64, 34);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const Viewport3D = forwardRef<Viewport3DHandle, Viewport3DProps>(
  (
    {
      space,
      loadingDirection,
      placedPackages,
      emptySpaces,
      containerIndex,
      lengthUnit,
      weightUnit,
      language,
      lowPerfMode,
      selectedInstanceId,
      onSelectPackage,
      hiddenCategories,
      maxVisibleLayer,
      activeStepLimit,
      onStepLimitChange,
      isPlayingSequence,
      onTogglePlaySequence,
      showWalls,
      onToggleWalls,
      transparentWalls,
      onToggleTransparentWalls,
      showFloorGrid,
      onToggleFloorGrid,
      showEmptySpaces,
      onToggleEmptySpaces,
      showPackageIds,
      onTogglePackageIds,
      onExportPng,
      onExpandMobile,
      manualMode = false,
      manualTool = 'place',
      manualActiveSpec = null,
      manualActiveOrientation = null,
      allowGlobalRotation = true,
      specsList = [],
      onManualPlace,
      onRemoveSelected,
    },
    ref
  ) => {
    const mountRef = useRef<HTMLDivElement>(null);
    const [contextLost, setContextLost] = useState(false);
    const [webglError, setWebglError] = useState<string | null>(null);
    const [hudCollapsed, setHudCollapsed] = useState(false);
    const [activePreset, setActivePreset] = useState<CameraPreset>('isometric');
    const [hoverPreview, setHoverPreview] = useState<{
      x: number;
      y: number;
      z: number;
      validation: ManualPlacementValidation;
    } | null>(null);

    // Refs for mutable Three.js objects so React updates don't tear down WebGL
    const engineRef = useRef<{
      scene: THREE.Scene;
      camera: THREE.PerspectiveCamera;
      renderer: THREE.WebGLRenderer;
      controls: OrbitControls;
      containerGroup: THREE.Group;
      cargoGroup: THREE.Group;
      emptyGroup: THREE.Group;
      gridGroup: THREE.Group;
      ghostGroup: THREE.Group;
      floorHitMesh: THREE.Mesh | null;
      selectableMeshes: THREE.Object3D[];
      instancedMesh: THREE.InstancedMesh | null;
      instancedPackages: PlacedPackage[];
      cameraGoal: { pos: THREE.Vector3; target: THREE.Vector3; active: boolean };
      requestRender: () => void;
      isSoftwareGl: boolean;
      labelTextureCache: Map<string, THREE.CanvasTexture>;
    } | null>(null);

    const containerBoxes = React.useMemo(
      () =>
        placedPackages
          .filter((p) => p.containerIndex === containerIndex)
          .sort((a, b) => a.stepIndex - b.stepIndex),
      [placedPackages, containerIndex]
    );

    const steppedBoxes = React.useMemo(() => {
      if (activeStepLimit === null) return containerBoxes;
      const limit = Math.max(0, Math.min(containerBoxes.length, activeStepLimit));
      return containerBoxes.slice(0, limit);
    }, [containerBoxes, activeStepLimit]);

    const visibleBoxes = React.useMemo(() => {
      return steppedBoxes.filter((p) => {
        if (hiddenCategories.has(p.category)) return false;
        if (maxVisibleLayer !== null && p.layerIndex > maxVisibleLayer) return false;
        return true;
      });
    }, [steppedBoxes, hiddenCategories, maxVisibleLayer]);

    const selectedPkg = React.useMemo(
      () => containerBoxes.find((p) => p.instanceId === selectedInstanceId) ?? null,
      [containerBoxes, selectedInstanceId]
    );

    const specsMap = React.useMemo(() => {
      const m = new Map<string, PackageSpec>();
      for (const s of specsList) m.set(s.id, s);
      return m;
    }, [specsList]);

    const onSelectRef = useRef(onSelectPackage);
    onSelectRef.current = onSelectPackage;

    const manualStateRef = useRef({
      manualMode,
      manualTool,
      manualActiveSpec,
      manualActiveOrientation,
      allowGlobalRotation,
      space,
      loadingDirection,
      containerBoxes,
      specsMap,
      onManualPlace,
    });
    manualStateRef.current = {
      manualMode,
      manualTool,
      manualActiveSpec,
      manualActiveOrientation,
      allowGlobalRotation,
      space,
      loadingDirection,
      containerBoxes,
      specsMap,
      onManualPlace,
    };

    const lastGhostRef = useRef<{
      x: number;
      y: number;
      z: number;
      validation: ManualPlacementValidation;
    } | null>(null);

    const computeCameraGoalForPreset = (preset: CameraPreset, sp: LoadingSpace) => {
      const L = sp.internalLength * SCALE;
      const H = sp.internalHeight * SCALE;
      const W = sp.internalWidth * SCALE;
      const diag = Math.sqrt(L * L + H * H + W * W);
      const dist = Math.max(3.2, diag * 1.15);
      const center = new THREE.Vector3(0, H * 0.45, 0);

      switch (preset) {
        case 'front':
          return { pos: new THREE.Vector3(-dist * 0.95, H * 0.6, 0), target: center };
        case 'rear':
          return { pos: new THREE.Vector3(dist * 0.95, H * 0.6, 0), target: center };
        case 'side':
          return { pos: new THREE.Vector3(0, H * 0.65, dist * 0.95), target: center };
        case 'top':
          return { pos: new THREE.Vector3(0, dist * 1.1, 0.01), target: center };
        case 'isometric':
        default:
          return {
            pos: new THREE.Vector3(dist * 0.68, dist * 0.48, dist * 0.72),
            target: center,
          };
      }
    };

    useImperativeHandle(ref, () => ({
      captureSnapshot: () => {
        const eng = engineRef.current;
        if (!eng) return null;
        eng.controls.update();
        eng.renderer.render(eng.scene, eng.camera);
        return eng.renderer.domElement.toDataURL('image/png');
      },
      setCameraPreset: (preset: CameraPreset) => {
        setActivePreset(preset);
        const eng = engineRef.current;
        if (!eng) return;
        const goal = computeCameraGoalForPreset(preset, space);
        eng.cameraGoal.pos.copy(goal.pos);
        eng.cameraGoal.target.copy(goal.target);
        eng.cameraGoal.active = true;
        eng.requestRender();
      },
    }));

    // Initialize WebGL Scene once
    useEffect(() => {
      const containerEl = mountRef.current;
      if (!containerEl) return;

      const isSoftwareGl = detectSoftwareGl();
      const width = containerEl.clientWidth || 800;
      const height = containerEl.clientHeight || 500;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#eef0f3');
      scene.fog = new THREE.Fog('#eef0f3', 28, 75);

      const camera = new THREE.PerspectiveCamera(44, width / height, 0.05, 160);

      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: !isSoftwareGl,
          powerPreference: 'high-performance',
        });
      } catch (err) {
        setWebglError(err instanceof Error ? err.message : 'WebGL initialization failed.');
        return;
      }

      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.shadowMap.enabled = !isSoftwareGl;
      renderer.shadowMap.type = THREE.PCFShadowMap;

      containerEl.innerHTML = '';
      containerEl.appendChild(renderer.domElement);

      const pmrem = new THREE.PMREMGenerator(renderer);
      const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envTex;
      pmrem.dispose();

      // Balanced 3-point + hemisphere studio rig
      const hemi = new THREE.HemisphereLight('#f8fafc', '#94a3b8', 0.85);
      scene.add(hemi);

      const keyLight = new THREE.DirectionalLight('#fff7ed', 1.45);
      keyLight.position.set(14, 22, 16);
      keyLight.castShadow = !isSoftwareGl;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.near = 1;
      keyLight.shadow.camera.far = 65;
      keyLight.shadow.camera.left = -16;
      keyLight.shadow.camera.right = 16;
      keyLight.shadow.camera.top = 16;
      keyLight.shadow.camera.bottom = -16;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
      scene.add(keyLight);

      const fillLight = new THREE.DirectionalLight('#e0f2fe', 0.55);
      fillLight.position.set(-14, 10, -12);
      scene.add(fillLight);

      // Ground studio plane
      const groundGeo = new THREE.PlaneGeometry(120, 120);
      const groundMat = new THREE.MeshStandardMaterial({
        color: '#e4e4e7',
        roughness: 0.92,
        metalness: 0.02,
      });
      const ground = new THREE.Mesh(groundGeo, groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.025;
      ground.receiveShadow = true;
      scene.add(ground);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = !isSoftwareGl;
      controls.dampingFactor = 0.07;
      controls.minDistance = 1.2;
      controls.maxDistance = 42;
      controls.maxPolarAngle = Math.PI / 2 - 0.02;
      controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
      };

      const containerGroup = new THREE.Group();
      const cargoGroup = new THREE.Group();
      const emptyGroup = new THREE.Group();
      const gridGroup = new THREE.Group();
      const ghostGroup = new THREE.Group();
      scene.add(gridGroup, containerGroup, cargoGroup, emptyGroup, ghostGroup);

      const cameraGoal = {
        pos: new THREE.Vector3(10, 6, 10),
        target: new THREE.Vector3(0, 1.2, 0),
        active: false,
      };

      // Coalesced on-demand render loop with software-WebGL pacing
      let frameId = 0;
      let renderBusy = false;
      let renderDirty = false;
      let lastTime = performance.now();
      let disposed = false;

      function afterDraw(cb: () => void) {
        if (disposed) return;
        const gl = renderer.getContext() as WebGL2RenderingContext;
        const sync = gl.fenceSync?.(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!sync) {
          frameId = window.setTimeout(cb, 80);
          return;
        }
        gl.flush();
        const poll = () => {
          if (disposed) return;
          const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (state === gl.UNSIGNALED) {
            frameId = window.setTimeout(poll, 5);
          } else {
            gl.deleteSync(sync);
            frameId = window.setTimeout(cb, 80);
          }
        };
        frameId = window.setTimeout(poll, 5);
      }

      function requestRender() {
        if (disposed) return;
        if (renderBusy) {
          renderDirty = true;
          return;
        }
        renderBusy = true;
        frameId = requestAnimationFrame(() => {
          if (disposed) return;
          renderDirty = false;
          const now = performance.now();
          const dt = Math.min(0.1, (now - lastTime) / 1000);
          lastTime = now;

          if (cameraGoal.active) {
            const lambda = 7;
            camera.position.x = THREE.MathUtils.damp(camera.position.x, cameraGoal.pos.x, lambda, dt);
            camera.position.y = THREE.MathUtils.damp(camera.position.y, cameraGoal.pos.y, lambda, dt);
            camera.position.z = THREE.MathUtils.damp(camera.position.z, cameraGoal.pos.z, lambda, dt);
            controls.target.x = THREE.MathUtils.damp(controls.target.x, cameraGoal.target.x, lambda, dt);
            controls.target.y = THREE.MathUtils.damp(controls.target.y, cameraGoal.target.y, lambda, dt);
            controls.target.z = THREE.MathUtils.damp(controls.target.z, cameraGoal.target.z, lambda, dt);

            if (
              camera.position.distanceTo(cameraGoal.pos) < 0.03 &&
              controls.target.distanceTo(cameraGoal.target) < 0.02
            ) {
              camera.position.copy(cameraGoal.pos);
              controls.target.copy(cameraGoal.target);
              cameraGoal.active = false;
            } else {
              renderDirty = true;
            }
          }

          controls.update();
          renderer.render(scene, camera);

          const done = () => {
            renderBusy = false;
            if (renderDirty && !disposed) requestRender();
          };
          if (isSoftwareGl) afterDraw(done);
          else done();
        });
      }

      controls.addEventListener('start', () => {
        cameraGoal.active = false;
      });
      controls.addEventListener('change', requestRender);

      // Raycasting selection & Manual Placement Hover/Click
      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let downX = 0;
      let downY = 0;

      const updateGhostVisual = (
        eng: NonNullable<typeof engineRef.current>,
        preview: { x: number; y: number; z: number; validation: ManualPlacementValidation } | null,
        dx: number,
        dy: number,
        dz: number,
        sp: LoadingSpace
      ) => {
        while (eng.ghostGroup.children.length > 0) {
          const c = eng.ghostGroup.children[0];
          eng.ghostGroup.remove(c);
          c.traverse((obj) => {
            if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
            const mat = (obj as THREE.Mesh).material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else if (mat) mat.dispose();
          });
        }
        if (!preview) {
          eng.requestRender();
          return;
        }
        const halfL = (sp.internalLength * SCALE) / 2;
        const halfW = (sp.internalWidth * SCALE) / 2;
        const sx = Math.max(0.01, dx * SCALE);
        const sy = Math.max(0.01, dy * SCALE);
        const sz = Math.max(0.01, dz * SCALE);
        const colorHex = preview.validation.valid ? '#16a34a' : '#dc2626';
        const geo = new THREE.BoxGeometry(sx, sy, sz);
        const mat = new THREE.MeshBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity: 0.36,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(
          preview.x * SCALE + sx / 2 - halfL,
          preview.y * SCALE + sy / 2,
          preview.z * SCALE + sz / 2 - halfW
        );
        const edgeMat = new THREE.LineBasicMaterial({ color: colorHex });
        mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
        eng.ghostGroup.add(mesh);
        eng.requestRender();
      };

      const computeManualHoverAtPointer = (
        clientX: number,
        clientY: number,
        eng: NonNullable<typeof engineRef.current>
      ) => {
        const ms = manualStateRef.current;
        if (!ms.manualMode || ms.manualTool !== 'place' || !ms.manualActiveSpec || !ms.manualActiveOrientation) {
          if (lastGhostRef.current) {
            lastGhostRef.current = null;
            setHoverPreview(null);
            updateGhostVisual(eng, null, 0, 0, 0, ms.space);
          }
          return null;
        }

        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);

        const targets: THREE.Object3D[] = [...eng.selectableMeshes];
        if (eng.instancedMesh) targets.push(eng.instancedMesh);
        if (eng.floorHitMesh) targets.push(eng.floorHitMesh);

        const hits = raycaster.intersectObjects(targets, false);
        if (hits.length === 0) {
          if (lastGhostRef.current) {
            lastGhostRef.current = null;
            setHoverPreview(null);
            updateGhostVisual(eng, null, 0, 0, 0, ms.space);
          }
          return null;
        }

        const hit = hits[0];
        const halfL = (ms.space.internalLength * SCALE) / 2;
        const halfW = (ms.space.internalWidth * SCALE) / 2;
        const { dx, dy, dz } = ms.manualActiveOrientation;

        let rawX = (hit.point.x + halfL) / SCALE - dx / 2;
        let rawZ = (hit.point.z + halfW) / SCALE - dz / 2;
        let rawY = 0;

        let hitPkg: PlacedPackage | null = null;
        if (hit.object === eng.instancedMesh && hit.instanceId !== undefined) {
          hitPkg = eng.instancedPackages[hit.instanceId] ?? null;
        } else if (hit.object.userData.pkg) {
          hitPkg = hit.object.userData.pkg as PlacedPackage;
        }

        if (hitPkg && hit.face) {
          const n = hit.face.normal;
          if (n.y > 0.6) {
            rawY = hitPkg.y + hitPkg.dy;
          } else if (Math.abs(n.x) > 0.6) {
            rawX = n.x > 0 ? hitPkg.x + hitPkg.dx : hitPkg.x - dx;
            rawY = computeDropY(ms.containerBoxes, rawX, rawZ, dx, dz);
          } else if (Math.abs(n.z) > 0.6) {
            rawZ = n.z > 0 ? hitPkg.z + hitPkg.dz : hitPkg.z - dz;
            rawY = computeDropY(ms.containerBoxes, rawX, rawZ, dx, dz);
          } else {
            rawY = computeDropY(ms.containerBoxes, rawX, rawZ, dx, dz);
          }
        } else {
          rawY = 0;
        }

        const snapped = snapManualCoords(
          ms.space,
          ms.containerBoxes,
          dx,
          dy,
          dz,
          rawX,
          rawY,
          rawZ
        );
        const validation = validateManualPlacement(
          ms.space,
          ms.containerBoxes,
          ms.manualActiveSpec,
          dx,
          dy,
          dz,
          snapped.x,
          snapped.y,
          snapped.z,
          ms.allowGlobalRotation,
          ms.loadingDirection,
          ms.specsMap
        );

        const nextPreview = { ...snapped, validation };
        lastGhostRef.current = nextPreview;
        setHoverPreview(nextPreview);
        updateGhostVisual(eng, nextPreview, dx, dy, dz, ms.space);
        return nextPreview;
      };

      const onPointerMove = (e: PointerEvent) => {
        const eng = engineRef.current;
        if (!eng) return;
        const ms = manualStateRef.current;
        if (!ms.manualMode || ms.manualTool !== 'place') {
          if (lastGhostRef.current) {
            lastGhostRef.current = null;
            setHoverPreview(null);
            updateGhostVisual(eng, null, 0, 0, 0, ms.space);
          }
          return;
        }
        computeManualHoverAtPointer(e.clientX, e.clientY, eng);
      };

      const onPointerDown = (e: PointerEvent) => {
        downX = e.clientX;
        downY = e.clientY;
      };

      const onPointerUp = (e: PointerEvent) => {
        const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
        if (dist > 6) return;
        const eng = engineRef.current;
        if (!eng) return;

        const ms = manualStateRef.current;
        if (ms.manualMode && ms.manualTool === 'place' && ms.manualActiveSpec && ms.manualActiveOrientation) {
          const preview = computeManualHoverAtPointer(e.clientX, e.clientY, eng);
          if (preview && preview.validation.valid && ms.onManualPlace) {
            ms.onManualPlace(preview.x, preview.y, preview.z);
          }
          return;
        }

        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);

        if (eng.instancedMesh) {
          const hits = raycaster.intersectObject(eng.instancedMesh, false);
          if (hits.length > 0 && hits[0].instanceId !== undefined) {
            const pkg = eng.instancedPackages[hits[0].instanceId] ?? null;
            onSelectRef.current(pkg);
            return;
          }
        }

        const hits = raycaster.intersectObjects(eng.selectableMeshes, false);
        if (hits.length > 0) {
          const pkg = (hits[0].object.userData.pkg as PlacedPackage) ?? null;
          onSelectRef.current(pkg);
        } else {
          onSelectRef.current(null);
        }
      };

      renderer.domElement.addEventListener('pointermove', onPointerMove);
      renderer.domElement.addEventListener('pointerdown', onPointerDown);
      renderer.domElement.addEventListener('pointerup', onPointerUp);

      const handleContextLost = (ev: Event) => {
        ev.preventDefault();
        setContextLost(true);
      };
      const handleContextRestored = () => {
        setContextLost(false);
        requestRender();
      };
      renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);

      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentRect.width;
          const h = entry.contentRect.height;
          if (w > 0 && h > 0) {
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
            requestRender();
          }
        }
      });
      resizeObserver.observe(containerEl);

      engineRef.current = {
        scene,
        camera,
        renderer,
        controls,
        containerGroup,
        cargoGroup,
        emptyGroup,
        gridGroup,
        ghostGroup,
        floorHitMesh: null,
        selectableMeshes: [],
        instancedMesh: null,
        instancedPackages: [],
        cameraGoal,
        requestRender,
        isSoftwareGl,
        labelTextureCache: new Map(),
      };

      if (!isSoftwareGl) {
        renderer.compile(scene, camera);
      }

      return () => {
        disposed = true;
        cancelAnimationFrame(frameId);
        clearTimeout(frameId);
        resizeObserver.disconnect();
        renderer.domElement.removeEventListener('pointermove', onPointerMove);
        renderer.domElement.removeEventListener('pointerdown', onPointerDown);
        renderer.domElement.removeEventListener('pointerup', onPointerUp);
        renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
        renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored);
        controls.dispose();
        envTex.dispose();
        groundGeo.dispose();
        groundMat.dispose();
        engineRef.current?.labelTextureCache.forEach((tex) => tex.dispose());
        renderer.dispose();
        engineRef.current = null;
      };
    }, []);

    // Rebuild Container Shell & Floor Grid when space or display toggles change
    useEffect(() => {
      const eng = engineRef.current;
      if (!eng) return;

      const clearGroup = (grp: THREE.Group) => {
        while (grp.children.length > 0) {
          const child = grp.children[0];
          grp.remove(child);
          child.traverse((obj) => {
            if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
            const mat = (obj as THREE.Mesh).material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else if (mat) mat.dispose();
          });
        }
      };

      clearGroup(eng.containerGroup);
      clearGroup(eng.gridGroup);

      const L = space.internalLength * SCALE;
      const W = space.internalWidth * SCALE;
      const H = space.internalHeight * SCALE;

      // Floor Grid
      if (showFloorGrid) {
        const gridSize = Math.max(L, W) * 2.2;
        const divisions = Math.max(10, Math.round(gridSize * 2));
        const grid = new THREE.GridHelper(gridSize, divisions, '#a1a1aa', '#d4d4d8');
        grid.position.y = -0.015;
        eng.gridGroup.add(grid);
      }

      // Container / Pallet Base Floor
      const floorTex = createFloorTexture(L, W);
      floorTex.anisotropy = eng.renderer.capabilities.getMaxAnisotropy();
      const floorMat = new THREE.MeshStandardMaterial({
        map: floorTex,
        roughness: 0.78,
        metalness: 0.06,
      });

      if (space.category === 'pallet') {
        // Composite wood pallet base below Y=0
        const deck = new THREE.Mesh(new THREE.BoxGeometry(L, 0.025, W), floorMat);
        deck.position.set(0, -0.0125, 0);
        deck.receiveShadow = true;
        eng.containerGroup.add(deck);

        const blockMat = new THREE.MeshStandardMaterial({ color: '#9a7b56', roughness: 0.85, metalness: 0.05 });
        for (const bx of [-L / 2 + 0.07, 0, L / 2 - 0.07]) {
          for (const bz of [-W / 2 + 0.07, 0, W / 2 - 0.07]) {
            const block = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.12), blockMat);
            block.position.set(bx, -0.07, bz);
            block.castShadow = true;
            eng.containerGroup.add(block);
          }
        }
      } else {
        const floor = new THREE.Mesh(new THREE.BoxGeometry(L, 0.03, W), floorMat);
        floor.position.set(0, -0.015, 0);
        floor.receiveShadow = true;
        eng.containerGroup.add(floor);
      }

      // Invisible Floor Raycast Plane at Y=0 for manual placement
      const hitPlaneGeo = new THREE.PlaneGeometry(L, W);
      const hitPlaneMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
      const floorHitMesh = new THREE.Mesh(hitPlaneGeo, hitPlaneMat);
      floorHitMesh.rotation.x = -Math.PI / 2;
      floorHitMesh.position.set(0, 0.001, 0);
      eng.containerGroup.add(floorHitMesh);
      eng.floorHitMesh = floorHitMesh;

      // Steel Structural Frame Posts + Wireframe Envelope
      const frameGeo = new THREE.BoxGeometry(L, H, W);
      const edgesGeo = new THREE.EdgesGeometry(frameGeo);
      frameGeo.dispose();
      const frameLines = new THREE.LineSegments(
        edgesGeo,
        new THREE.LineBasicMaterial({ color: '#27272a' })
      );
      frameLines.position.set(0, H / 2, 0);
      eng.containerGroup.add(frameLines);

      // Corner steel posts for industrial silhouette
      if (space.category !== 'pallet') {
        const postMat = new THREE.MeshStandardMaterial({
          color: '#3f3f46',
          roughness: 0.38,
          metalness: 0.78,
        });
        const postThickness = 0.045;
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const post = new THREE.Mesh(
              new THREE.BoxGeometry(postThickness, H, postThickness),
              postMat
            );
            post.position.set(sx * (L / 2 + postThickness / 2), H / 2, sz * (W / 2 + postThickness / 2));
            post.castShadow = true;
            eng.containerGroup.add(post);
          }
        }

        // Door clearance frame highlight at rear (+X) or side (+Z)
        const dw = space.doorWidth * SCALE;
        const dh = space.doorHeight * SCALE;
        const doorMat = new THREE.LineBasicMaterial({ color: '#dc2626' });
        if (loadingDirection === 'rear') {
          const dGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(dw, dh));
          const doorOutline = new THREE.LineSegments(dGeo, doorMat);
          doorOutline.rotation.y = Math.PI / 2;
          doorOutline.position.set(L / 2 + 0.01, dh / 2, 0);
          eng.containerGroup.add(doorOutline);
        } else if (loadingDirection === 'side') {
          const dGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(dw, dh));
          const doorOutline = new THREE.LineSegments(dGeo, doorMat);
          doorOutline.position.set(0, dh / 2, W / 2 + 0.01);
          eng.containerGroup.add(doorOutline);
        }
      }

      // Walls (Back, Left, Right, Roof)
      if (showWalls && space.category !== 'pallet') {
        const wallMat = new THREE.MeshStandardMaterial({
          color: transparentWalls ? '#94a3b8' : '#52525b',
          roughness: 0.45,
          metalness: 0.35,
          transparent: transparentWalls,
          opacity: transparentWalls ? 0.16 : 0.92,
          depthWrite: !transparentWalls,
          side: THREE.DoubleSide,
        });

        // Back wall (-X)
        const backWall = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat);
        backWall.rotation.y = Math.PI / 2;
        backWall.position.set(-L / 2, H / 2, 0);
        eng.containerGroup.add(backWall);

        // Left wall (-Z)
        const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(L, H), wallMat);
        leftWall.position.set(0, H / 2, -W / 2);
        eng.containerGroup.add(leftWall);

        // Right wall (+Z) - only if transparent or rear loading
        if (transparentWalls || loadingDirection !== 'side') {
          const rightWall = new THREE.Mesh(new THREE.PlaneGeometry(L, H), wallMat);
          rightWall.position.set(0, H / 2, W / 2);
          eng.containerGroup.add(rightWall);
        }

        // Roof (+Y)
        const roof = new THREE.Mesh(new THREE.PlaneGeometry(L, W), wallMat);
        roof.rotation.x = Math.PI / 2;
        roof.position.set(0, H, 0);
        eng.containerGroup.add(roof);
      }

      // Snap initial camera to frame the container
      const goal = computeCameraGoalForPreset(activePreset, space);
      eng.camera.position.copy(goal.pos);
      eng.controls.target.copy(goal.target);
      eng.controls.update();
      eng.requestRender();
    }, [space, loadingDirection, showWalls, transparentWalls, showFloorGrid]);

    // Rebuild Cargo & Empty Spaces when packages, selection, filters, or perf mode change
    useEffect(() => {
      const eng = engineRef.current;
      if (!eng) return;

      while (eng.cargoGroup.children.length > 0) {
        const child = eng.cargoGroup.children[0];
        eng.cargoGroup.remove(child);
        child.traverse((obj) => {
          if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
          const mat = (obj as THREE.Mesh).material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat) mat.dispose();
        });
      }
      while (eng.emptyGroup.children.length > 0) {
        const child = eng.emptyGroup.children[0];
        eng.emptyGroup.remove(child);
        child.traverse((obj) => {
          if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
          const mat = (obj as THREE.Mesh).material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat) mat.dispose();
        });
      }

      eng.selectableMeshes = [];
      eng.instancedMesh = null;
      eng.instancedPackages = [];

      const halfL = (space.internalLength * SCALE) / 2;
      const halfW = (space.internalWidth * SCALE) / 2;
      const gap = 0.003; // 3mm visual seam so adjacent boxes read crisply

      const useInstanced = lowPerfMode || visibleBoxes.length > 260;

      if (useInstanced && visibleBoxes.length > 0) {
        const unitGeo = new THREE.BoxGeometry(1, 1, 1);
        const instMat = new THREE.MeshStandardMaterial({
          roughness: 0.65,
          metalness: 0.05,
        });
        const inst = new THREE.InstancedMesh(unitGeo, instMat, visibleBoxes.length);
        inst.castShadow = !eng.isSoftwareGl;
        inst.receiveShadow = true;

        visibleBoxes.forEach((p, idx) => {
          const sx = Math.max(0.01, p.dx * SCALE - gap);
          const sy = Math.max(0.01, p.dy * SCALE - gap);
          const sz = Math.max(0.01, p.dz * SCALE - gap);

          const cx = p.x * SCALE + (p.dx * SCALE) / 2 - halfL;
          const cy = p.y * SCALE + (p.dy * SCALE) / 2;
          const cz = p.z * SCALE + (p.dz * SCALE) / 2 - halfW;

          _vec3A.set(cx, cy, cz);
          _quat.identity();
          _scale.set(sx, sy, sz);
          _mat4.compose(_vec3A, _quat, _scale);
          inst.setMatrixAt(idx, _mat4);

          if (p.instanceId === selectedInstanceId) {
            _color.set('#ffffff');
          } else {
            _color.set(p.color);
          }
          inst.setColorAt(idx, _color);
        });

        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        inst.computeBoundingSphere();

        eng.cargoGroup.add(inst);
        eng.instancedMesh = inst;
        eng.instancedPackages = visibleBoxes;
      } else {
        const materialPool = new Map<string, THREE.MeshStandardMaterial>();
        const edgeMatNormal = new THREE.LineBasicMaterial({ color: '#18181b', transparent: true, opacity: 0.45 });
        const edgeMatSelected = new THREE.LineBasicMaterial({ color: '#ffffff' });

        const latestSteppedId =
          activeStepLimit !== null && steppedBoxes.length > 0
            ? steppedBoxes[steppedBoxes.length - 1].instanceId
            : null;

        for (const p of visibleBoxes) {
          const sx = Math.max(0.01, p.dx * SCALE - gap);
          const sy = Math.max(0.01, p.dy * SCALE - gap);
          const sz = Math.max(0.01, p.dz * SCALE - gap);

          const isSelected = p.instanceId === selectedInstanceId;
          const isActiveStep = latestSteppedId !== null && p.instanceId === latestSteppedId;

          const geo = new THREE.BoxGeometry(sx, sy, sz);
          const matKey = `${p.color}_${isSelected}_${isActiveStep}`;
          let mat = materialPool.get(matKey);
          if (!mat) {
            mat = new THREE.MeshStandardMaterial({
              color: p.color,
              roughness: p.fragile ? 0.45 : 0.72,
              metalness: 0.04,
              emissive: isSelected ? new THREE.Color('#dc2626') : isActiveStep ? new THREE.Color('#f59e0b') : new THREE.Color('#000000'),
              emissiveIntensity: isSelected ? 0.35 : isActiveStep ? 0.22 : 0,
            });
            materialPool.set(matKey, mat);
          }

          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(
            p.x * SCALE + (p.dx * SCALE) / 2 - halfL,
            p.y * SCALE + (p.dy * SCALE) / 2,
            p.z * SCALE + (p.dz * SCALE) / 2 - halfW
          );
          mesh.castShadow = !eng.isSoftwareGl;
          mesh.receiveShadow = true;
          mesh.userData.pkg = p;

          const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo),
            isSelected || isActiveStep ? edgeMatSelected : edgeMatNormal
          );
          mesh.add(edges);

          if (showPackageIds && visibleBoxes.length <= 120) {
            const lbl = `#${p.stepIndex}`;
            let tex = eng.labelTextureCache.get(`${lbl}_${p.fragile}`);
            if (!tex) {
              tex = createStepLabelTexture(lbl, p.fragile);
              eng.labelTextureCache.set(`${lbl}_${p.fragile}`, tex);
            }
            const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
            const sprite = new THREE.Sprite(spriteMat);
            const badgeSize = Math.min(0.28, Math.max(0.12, Math.min(sx, sz) * 0.45));
            sprite.scale.set(badgeSize * 1.6, badgeSize * 0.8, 1);
            sprite.position.set(0, sy / 2 + 0.03, 0);
            mesh.add(sprite);
          }

          eng.cargoGroup.add(mesh);
          eng.selectableMeshes.push(mesh);
        }
      }

      // Highlight selected box overlay even in instanced mode
      if (selectedPkg) {
        const sx = selectedPkg.dx * SCALE;
        const sy = selectedPkg.dy * SCALE;
        const sz = selectedPkg.dz * SCALE;
        const selGeo = new THREE.BoxGeometry(sx + 0.015, sy + 0.015, sz + 0.015);
        const selEdges = new THREE.LineSegments(
          new THREE.EdgesGeometry(selGeo),
          new THREE.LineBasicMaterial({ color: '#dc2626' })
        );
        selGeo.dispose();
        selEdges.position.set(
          selectedPkg.x * SCALE + sx / 2 - halfL,
          selectedPkg.y * SCALE + sy / 2,
          selectedPkg.z * SCALE + sz / 2 - halfW
        );
        eng.cargoGroup.add(selEdges);
      }

      // Render Empty Space wireframes when enabled
      if (showEmptySpaces) {
        const contEmpty = emptySpaces.filter((e) => e.containerIndex === containerIndex).slice(0, 24);
        const emptyMat = new THREE.MeshBasicMaterial({
          color: '#0ea5e9',
          transparent: true,
          opacity: 0.1,
          depthWrite: false,
        });
        const emptyEdgeMat = new THREE.LineBasicMaterial({
          color: '#0284c7',
          transparent: true,
          opacity: 0.45,
        });

        for (const eb of contEmpty) {
          const sx = eb.dx * SCALE;
          const sy = eb.dy * SCALE;
          const sz = eb.dz * SCALE;
          const geo = new THREE.BoxGeometry(sx, sy, sz);
          const mesh = new THREE.Mesh(geo, emptyMat);
          mesh.position.set(
            eb.x * SCALE + sx / 2 - halfL,
            eb.y * SCALE + sy / 2,
            eb.z * SCALE + sz / 2 - halfW
          );
          mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), emptyEdgeMat));
          eng.emptyGroup.add(mesh);
        }
      }

      eng.requestRender();
    }, [
      space,
      steppedBoxes,
      visibleBoxes,
      emptySpaces,
      containerIndex,
      lowPerfMode,
      selectedInstanceId,
      selectedPkg,
      showEmptySpaces,
      showPackageIds,
      activeStepLimit,
    ]);

    useEffect(() => {
      if (!manualMode || manualTool !== 'place' || !manualActiveSpec) {
        setHoverPreview(null);
        lastGhostRef.current = null;
        const eng = engineRef.current;
        if (eng) {
          while (eng.ghostGroup.children.length > 0) {
            const c = eng.ghostGroup.children[0];
            eng.ghostGroup.remove(c);
            c.traverse((obj) => {
              if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
              const mat = (obj as THREE.Mesh).material;
              if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
              else if (mat) mat.dispose();
            });
          }
          eng.requestRender();
        }
      }
    }, [manualMode, manualTool, manualActiveSpec]);

    const totalSteps = containerBoxes.length;
    const currentStep =
      activeStepLimit === null ? totalSteps : Math.max(0, Math.min(totalSteps, activeStepLimit));

    const triggerPreset = (p: CameraPreset) => {
      setActivePreset(p);
      const eng = engineRef.current;
      if (!eng) return;
      const goal = computeCameraGoalForPreset(p, space);
      eng.cameraGoal.pos.copy(goal.pos);
      eng.cameraGoal.target.copy(goal.target);
      eng.cameraGoal.active = true;
      eng.requestRender();
    };

    const presetLabel = (p: CameraPreset) => {
      switch (p) {
        case 'isometric':
          return t(language, 'presetIsometric');
        case 'front':
          return t(language, 'presetFront');
        case 'rear':
          return t(language, 'presetRear');
        case 'side':
          return t(language, 'presetSide');
        case 'top':
          return t(language, 'presetTop');
      }
    };

    const spaceDisplayName = language === 'ar' && space.nameAr ? space.nameAr : space.name;

    return (
      <div
        className={`relative w-full h-full min-h-[280px] sm:min-h-[360px] bg-[#eef0f3] rounded-xl overflow-hidden border border-zinc-200 select-none ${
          manualMode && manualTool === 'place' && manualActiveSpec ? 'cursor-crosshair' : ''
        }`}
      >
        {/* WebGL Canvas Mount */}
        <div ref={mountRef} className="w-full h-full touch-none" />

        {(contextLost || webglError) && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/85 text-white p-6 text-center z-20">
            <div>
              <p className="text-sm font-semibold">
                {webglError
                  ? language === 'ar'
                    ? 'عارض WebGL ثلاثي الأبعاد غير متاح'
                    : '3D WebGL Renderer Unavailable'
                  : language === 'ar'
                    ? 'تم إيقاف سياق WebGL مؤقتاً'
                    : 'WebGL context paused'}
              </p>
              <p className="text-xs text-zinc-300 mt-1">
                {webglError ??
                  (language === 'ar' ? 'جاري استعادة العرض ثلاثي الأبعاد...' : 'Restoring 3D cargo viewport...')}
              </p>
            </div>
          </div>
        )}

        {/* Top-Left Minimal Spec Readout (White & Red theme) */}
        <div className="absolute top-3 left-3 z-10 pointer-events-none flex flex-col gap-1.5 max-w-[calc(100%-96px)] sm:max-w-[290px]">
          <div className="bg-white/95 text-zinc-900 px-3 py-1.5 rounded-lg border border-zinc-200 shadow-sm pointer-events-auto">
            <div className="text-xs font-bold tracking-tight text-zinc-900 truncate">{spaceDisplayName}</div>
            <div className="text-[11px] font-mono text-zinc-600 tabular-nums mt-0.5">
              {formatDims(space.internalLength, space.internalWidth, space.internalHeight, lengthUnit)}
              {' · '}
              <span className="text-red-600 font-semibold">
                {visibleBoxes.length}/{containerBoxes.length}
              </span>{' '}
              {t(language, 'pkgsShort')}
            </div>
          </div>

          {manualMode && manualTool === 'place' && manualActiveSpec && hoverPreview && (
            <div
              className={`px-3 py-2 rounded-lg border shadow-md max-w-[300px] ${
                hoverPreview.validation.valid
                  ? 'bg-emerald-50/95 border-emerald-500 text-emerald-950'
                  : 'bg-red-50/95 border-red-500 text-red-950'
              }`}
            >
              <div className="text-[11px] font-bold">
                {hoverPreview.validation.valid
                  ? t(language, 'validPlacement')
                  : language === 'ar'
                    ? hoverPreview.validation.reasonAr
                    : hoverPreview.validation.reasonEn}
              </div>
              <div className="text-[10px] font-mono opacity-80 tabular-nums mt-0.5">
                X: {formatLength(hoverPreview.x, lengthUnit, false)} · Y:{' '}
                {formatLength(hoverPreview.y, lengthUnit, false)} · Z:{' '}
                {formatLength(hoverPreview.z, lengthUnit, false)} {lengthUnit}
              </div>
            </div>
          )}

          {selectedPkg && (
            <div className="bg-white/95 text-zinc-900 px-3 py-2 rounded-lg border-2 border-red-600 shadow-lg max-w-[min(270px,calc(100vw-84px))] max-h-[46%] overflow-y-auto pointer-events-auto">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-red-600 font-mono">
                  #{selectedPkg.stepIndex} · {selectedPkg.sku}
                </span>
                <button
                  onClick={() => onSelectPackage(null)}
                  className="text-[11px] text-zinc-400 hover:text-zinc-900 cursor-pointer"
                >
                  ✕
                </button>
              </div>
              <div className="text-xs font-semibold text-zinc-900 mt-0.5 truncate">
                {(() => {
                  const spec = specsMap.get(selectedPkg.packageId);
                  return language === 'ar' && spec?.nameAr ? spec.nameAr : selectedPkg.name;
                })()}
              </div>
              <div className="mt-1.5 space-y-0.5 text-[11px] font-mono text-zinc-600 tabular-nums">
                <div>
                  {t(language, 'dimensions')}: {formatDims(selectedPkg.dx, selectedPkg.dz, selectedPkg.dy, lengthUnit)}
                </div>
                <div>
                  {t(language, 'weight')}: {formatWeight(selectedPkg.weight, weightUnit)}
                </div>
                <div>
                  {t(language, 'posLabel')}: {formatLength(selectedPkg.x, lengthUnit, false)},{' '}
                  {formatLength(selectedPkg.y, lengthUnit, false)},{' '}
                  {formatLength(selectedPkg.z, lengthUnit, false)} {lengthUnit}
                </div>
                <div>
                  {t(language, 'orientLabel')}: {selectedPkg.orientationLabel} · {t(language, 'supLabel')}:{' '}
                  {selectedPkg.supportedAreaPct}%
                </div>
              </div>
              {onRemoveSelected && (
                <button
                  type="button"
                  onClick={() => onRemoveSelected(selectedPkg.instanceId)}
                  className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white px-2.5 py-1.5 text-[11px] font-semibold transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{t(language, 'unloadPackage')}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Top-Right Compact Snapshot & Mobile Expand */}
        <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5">
          {onExportPng && (
            <button
              onClick={onExportPng}
              title={t(language, 'exportPng')}
              className="p-2 rounded-lg bg-white/95 text-zinc-800 hover:bg-red-50 hover:text-red-600 border border-zinc-200 shadow-sm cursor-pointer transition-colors"
            >
              <Camera className="w-4 h-4" />
            </button>
          )}
          {onExpandMobile && (
            <button
              onClick={onExpandMobile}
              title={t(language, 'fullscreen')}
              className="md:hidden p-2 rounded-lg bg-white/95 text-zinc-800 hover:bg-red-50 hover:text-red-600 border border-zinc-200 shadow-sm cursor-pointer transition-colors"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Collapsible Bottom Control Dock (Zero Viewport Occlusion) */}
        <div className="absolute bottom-2.5 sm:bottom-3 left-1/2 -translate-x-1/2 z-10 w-[calc(100%-16px)] sm:w-[calc(100%-24px)] max-w-[820px] flex flex-col items-center">
          <button
            onClick={() => setHudCollapsed((v) => !v)}
            className="mb-1 inline-flex items-center gap-1 px-3 py-1 rounded-t-md bg-white/95 text-zinc-700 text-[11px] font-semibold border border-b-0 border-zinc-200 hover:text-red-600 shadow-sm cursor-pointer"
          >
            {hudCollapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            <span>{hudCollapsed ? t(language, 'showControls') : t(language, 'hideControls')}</span>
          </button>

          {!hudCollapsed && (
            <div className="w-full bg-white/95 text-zinc-900 rounded-xl border border-zinc-200 p-2 sm:p-2.5 shadow-xl space-y-1.5 sm:space-y-2">
              {/* Row 1: Camera Presets + View Toggles */}
              <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center justify-between gap-1.5 sm:gap-2">
                <div className="flex items-center gap-1 overflow-x-auto pb-0.5 sm:pb-0 touch-manipulation">
                  {(['isometric', 'front', 'rear', 'side', 'top'] as CameraPreset[]).map((preset) => (
                    <button
                      key={preset}
                      onClick={() => triggerPreset(preset)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                        activePreset === preset
                          ? 'bg-red-600 text-white'
                          : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                      }`}
                    >
                      {presetLabel(preset)}
                    </button>
                  ))}
                  <button
                    onClick={() => triggerPreset('isometric')}
                    title={t(language, 'resetView')}
                    className="p-1.5 rounded-md bg-zinc-100 text-zinc-700 hover:bg-zinc-200 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-1 overflow-x-auto">
                  <button
                    onClick={onToggleWalls}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer whitespace-nowrap border ${
                      showWalls
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-zinc-100 text-zinc-500 border-transparent'
                    }`}
                  >
                    {showWalls ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    <span>{t(language, 'wallsToggle')}</span>
                  </button>
                  <button
                    onClick={onToggleTransparentWalls}
                    className={`px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer whitespace-nowrap border ${
                      transparentWalls
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-zinc-100 text-zinc-500 border-transparent'
                    }`}
                  >
                    {t(language, 'transparentToggle')}
                  </button>
                  <button
                    onClick={onToggleFloorGrid}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer whitespace-nowrap border ${
                      showFloorGrid
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-zinc-100 text-zinc-500 border-transparent'
                    }`}
                  >
                    <Grid3X3 className="w-3 h-3" />
                    <span>{t(language, 'gridToggle')}</span>
                  </button>
                  <button
                    onClick={onToggleEmptySpaces}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer whitespace-nowrap border ${
                      showEmptySpaces
                        ? 'bg-sky-50 text-sky-700 border-sky-200'
                        : 'bg-zinc-100 text-zinc-500 border-transparent'
                    }`}
                  >
                    <BoxIcon className="w-3 h-3" />
                    <span>{t(language, 'emptySpacesToggle')}</span>
                  </button>
                  <button
                    onClick={onTogglePackageIds}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer whitespace-nowrap border ${
                      showPackageIds
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-zinc-100 text-zinc-500 border-transparent'
                    }`}
                  >
                    <Layers className="w-3 h-3" />
                    <span>{t(language, 'labelsToggle')}</span>
                  </button>
                </div>
              </div>

              {/* Row 2: Step-by-Step Loading Sequence Scrubber */}
              {totalSteps > 0 && (
                <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 sm:gap-2 pt-1.5 border-t border-zinc-200">
                  <button
                    onClick={onTogglePlaySequence}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-red-600 hover:bg-red-700 text-white text-[11px] font-semibold cursor-pointer whitespace-nowrap"
                  >
                    {isPlayingSequence ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                    <span>{isPlayingSequence ? t(language, 'pauseSequence') : t(language, 'playSequence')}</span>
                  </button>
                  <button
                    onClick={() => onStepLimitChange(Math.max(1, currentStep - 1))}
                    className="p-1.5 rounded-md bg-zinc-100 hover:bg-zinc-200 text-zinc-700 cursor-pointer"
                  >
                    <SkipBack className="w-3.5 h-3.5" />
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={totalSteps}
                    value={currentStep}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      onStepLimitChange(val >= totalSteps ? null : val);
                    }}
                    className="flex-1 min-w-[90px] accent-red-600 h-1.5 cursor-pointer"
                  />
                  <button
                    onClick={() => {
                      const next = currentStep + 1;
                      onStepLimitChange(next >= totalSteps ? null : next);
                    }}
                    className="p-1.5 rounded-md bg-zinc-100 hover:bg-zinc-200 text-zinc-700 cursor-pointer"
                  >
                    <SkipForward className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[11px] font-mono text-zinc-700 tabular-nums whitespace-nowrap min-w-[56px] sm:min-w-[68px] text-end">
                    {currentStep} / {totalSteps}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
);
