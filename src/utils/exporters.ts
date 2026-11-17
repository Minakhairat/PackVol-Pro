import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import {
  Language,
  LengthUnit,
  OptimizationResult,
  PackageSpec,
  Project,
  WeightUnit,
} from '../types/packvol';
import { formatDims, formatLength, formatVolume, formatWeight, fromKg, fromMm } from './units';
import { translateStrategyName } from '../i18n/translations';

const PALETTE = ['#dc2626', '#2563eb', '#d97706', '#0d9488', '#ea580c', '#475569', '#059669', '#9333ea'];

function safeFilePart(raw: string): string {
  const cleaned = raw.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim();
  return cleaned.slice(0, 48) || 'PackVolPro';
}

function resolveDisplayProjectName(project: Project, language: Language): string {
  return language === 'ar' && project.nameAr ? project.nameAr : project.name;
}

function resolveDisplaySpaceName(project: Project, language: Language): string {
  return language === 'ar' && project.space.nameAr ? project.space.nameAr : project.space.name;
}

function resolvePkgName(
  pkgId: string,
  fallbackName: string,
  specs: PackageSpec[],
  language: Language
): string {
  const spec = specs.find((s) => s.id === pkgId);
  if (language === 'ar' && spec?.nameAr) return spec.nameAr;
  return spec?.name || fallbackName;
}

export async function parseImportedPackagesFile(file: File): Promise<PackageSpec[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

  const pick = (row: Record<string, unknown>, keys: string[], fallback: unknown = '') => {
    for (const k of Object.keys(row)) {
      const norm = k.trim().toLowerCase();
      if (keys.some((target) => norm.includes(target))) {
        return row[k];
      }
    }
    return fallback;
  };

  const boolVal = (val: unknown, def: boolean): boolean => {
    if (typeof val === 'boolean') return val;
    const s = String(val).trim().toLowerCase();
    if (!s) return def;
    return ['true', 'yes', '1', 'y', 'نعم'].includes(s);
  };

  const specs: PackageSpec[] = [];
  rows.forEach((row, idx) => {
    const name = String(pick(row, ['name', 'product', 'الاسم', 'المنتج'], `Imported Package ${idx + 1}`)).trim();
    const sku = String(pick(row, ['sku', 'code', 'رمز'], `IMP-${100 + idx}`)).trim();
    const length = Math.max(10, Number(pick(row, ['length', 'len', 'طول'], 600)) || 600);
    const width = Math.max(10, Number(pick(row, ['width', 'wid', 'عرض'], 400)) || 400);
    const height = Math.max(10, Number(pick(row, ['height', 'hei', 'ارتفاع'], 400)) || 400);
    const weight = Math.max(0.1, Number(pick(row, ['weight', 'wt', 'وزن'], 15)) || 15);
    const quantity = Math.max(1, Math.floor(Number(pick(row, ['qty', 'quantity', 'الكمية'], 1)) || 1));
    const category = String(pick(row, ['category', 'cat', 'فئة'], 'General')).trim() || 'General';
    const stackable = boolVal(pick(row, ['stackable', 'تكديس'], true), true);
    const rotatable = boolVal(pick(row, ['rotatable', 'تدوير'], true), true);
    const fragile = boolVal(pick(row, ['fragile', 'كسر'], false), false);
    const thisSideUp = boolVal(pick(row, ['this side up', 'upright', 'أعلى'], false), false);

    specs.push({
      id: `imp-${Date.now()}-${idx}`,
      name,
      sku,
      length,
      width,
      height,
      weight,
      quantity,
      color: PALETTE[idx % PALETTE.length],
      category,
      stackable,
      rotatable,
      fragile,
      thisSideUp,
      maxStackWeight: Number(pick(row, ['maxstackweight', 'stackweight'], 0)) || 0,
      maxStackLayers: Number(pick(row, ['maxstacklayers', 'layers'], 0)) || 0,
      allowedAxes: { x: !thisSideUp, y: true, z: !thisSideUp },
      priority: Math.min(10, Math.max(1, Number(pick(row, ['priority', 'أولوية'], 5)) || 5)),
    });
  });

  return specs;
}

export function exportToExcel(
  project: Project,
  result: OptimizationResult,
  lengthUnit: LengthUnit,
  weightUnit: WeightUnit,
  language: Language = 'en'
): void {
  const wb = XLSX.utils.book_new();
  const isAr = language === 'ar';
  if (isAr) {
    wb.Workbook = { Views: [{ RTL: true }] };
  }

  const projName = resolveDisplayProjectName(project, language);
  const spaceName = resolveDisplaySpaceName(project, language);
  const stratName = translateStrategyName(language, result.strategyName);

  // Sheet 1: Summary
  const summaryRows = isAr
    ? [
        { البيان: 'اسم المشروع', القيمة: projName },
        { البيان: 'مساحة التحميل الرئيسية', القيمة: spaceName },
        {
          البيان: 'الأبعاد الداخلية',
          القيمة: formatDims(project.space.internalLength, project.space.internalWidth, project.space.internalHeight, lengthUnit),
        },
        { البيان: 'أقصى حمولة', القيمة: formatWeight(project.space.maxPayload, weightUnit) },
        { البيان: 'وضع التحسين', القيمة: result.mode },
        { البيان: 'الخوارزمية الفائزة', القيمة: stratName },
        { البيان: 'إجمالي العبوات المطلوبة', القيمة: result.totalRequiredPackages },
        { البيان: 'العبوات المحملة', القيمة: result.loadedPackagesCount },
        { البيان: 'العبوات غير المحملة', القيمة: result.unloadedPackagesCount },
        { البيان: 'عدد الحاويات / المساحات', القيمة: result.containersUsed },
        { البيان: 'عدد الرحلات المقدر', القيمة: result.estimatedTrips },
        { البيان: 'نسبة استغلال الحجم (%)', القيمة: result.volumeUtilizationPct },
        { البيان: 'نسبة استغلال الوزن (%)', القيمة: result.weightUtilizationPct },
        { البيان: 'الحجم المشغول', القيمة: formatVolume(result.occupiedVolumeMm3, lengthUnit) },
        { البيان: 'الحجم الفارغ المتبقي', القيمة: formatVolume(result.remainingVolumeMm3, lengthUnit) },
        { البيان: 'إجمالي وزن الشحنة', القيمة: formatWeight(result.totalCargoWeightKg, weightUnit) },
        { البيان: 'توازن الوزن (/100)', القيمة: result.balanceScore },
        { البيان: 'التحقق الفيزيائي', القيمة: result.verification.isValid ? 'ناجح' : 'فشل' },
      ]
    : [
        { Metric: 'Project Name', Value: projName },
        { Metric: 'Primary Loading Space', Value: spaceName },
        {
          Metric: 'Space Internal Dimensions',
          Value: formatDims(project.space.internalLength, project.space.internalWidth, project.space.internalHeight, lengthUnit),
        },
        { Metric: 'Max Payload', Value: formatWeight(project.space.maxPayload, weightUnit) },
        { Metric: 'Optimization Mode', Value: result.mode },
        { Metric: 'Winning Strategy', Value: stratName },
        { Metric: 'Total Required Packages', Value: result.totalRequiredPackages },
        { Metric: 'Loaded Packages', Value: result.loadedPackagesCount },
        { Metric: 'Unloaded Packages', Value: result.unloadedPackagesCount },
        { Metric: 'Containers / Spaces Used', Value: result.containersUsed },
        { Metric: 'Estimated Trips', Value: result.estimatedTrips },
        { Metric: 'Volume Utilization (%)', Value: result.volumeUtilizationPct },
        { Metric: 'Weight Utilization (%)', Value: result.weightUtilizationPct },
        { Metric: 'Occupied Volume', Value: formatVolume(result.occupiedVolumeMm3, lengthUnit) },
        { Metric: 'Remaining Volume', Value: formatVolume(result.remainingVolumeMm3, lengthUnit) },
        { Metric: 'Total Cargo Weight', Value: formatWeight(result.totalCargoWeightKg, weightUnit) },
        { Metric: 'Balance Score (/100)', Value: result.balanceScore },
        { Metric: 'Physics Verification', Value: result.verification.isValid ? 'PASSED' : 'FAILED' },
      ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), isAr ? 'الملخص' : 'Summary');

  // Sheet 2: Containers Breakdown (especially useful for multi-container plans)
  const containerRows = result.containerSummaries.map((cs) => {
    const sp = cs.space ?? project.space;
    const spLabel = isAr && sp.nameAr ? sp.nameAr : sp.name;
    return isAr
      ? {
          الحاوية: `#${cs.containerIndex + 1}`,
          النوع: spLabel,
          الأبعاد: formatDims(sp.internalLength, sp.internalWidth, sp.internalHeight, lengthUnit),
          'عدد العبوات': cs.loadedCount,
          'استغلال الحجم (%)': cs.volumeUtilizationPct,
          'الوزن المحمل': formatWeight(cs.loadedWeightKg, weightUnit),
          'استغلال الوزن (%)': cs.weightUtilizationPct,
          'توازن الوزن': `${cs.balanceScore}/100`,
        }
      : {
          Container: `#${cs.containerIndex + 1}`,
          Type: spLabel,
          Dimensions: formatDims(sp.internalLength, sp.internalWidth, sp.internalHeight, lengthUnit),
          'Loaded Count': cs.loadedCount,
          'Volume Util (%)': cs.volumeUtilizationPct,
          'Loaded Weight': formatWeight(cs.loadedWeightKg, weightUnit),
          'Weight Util (%)': cs.weightUtilizationPct,
          Balance: `${cs.balanceScore}/100`,
        };
  });
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(containerRows),
    isAr ? 'الحاويات' : 'Containers'
  );

  // Sheet 3: Product Manifest
  const productRows = project.packages.map((p) => {
    const pName = isAr && p.nameAr ? p.nameAr : p.name;
    const pCat = isAr && p.categoryAr ? p.categoryAr : p.category;
    return isAr
      ? {
          'رمز المنتج SKU': p.sku,
          'اسم المنتج': pName,
          الفئة: pCat,
          [`الطول (${lengthUnit})`]: fromMm(p.length, lengthUnit),
          [`العرض (${lengthUnit})`]: fromMm(p.width, lengthUnit),
          [`الارتفاع (${lengthUnit})`]: fromMm(p.height, lengthUnit),
          [`الوزن (${weightUnit})`]: fromKg(p.weight, weightUnit),
          الكمية: p.quantity,
          'قابل للتكديس': p.stackable ? 'نعم' : 'لا',
          'قابل للتدوير': p.rotatable ? 'نعم' : 'لا',
          'قابل للكسر': p.fragile ? 'نعم' : 'لا',
          'للأعلى فقط': p.thisSideUp ? 'نعم' : 'لا',
        }
      : {
          SKU: p.sku,
          Name: pName,
          Category: pCat,
          [`Length (${lengthUnit})`]: fromMm(p.length, lengthUnit),
          [`Width (${lengthUnit})`]: fromMm(p.width, lengthUnit),
          [`Height (${lengthUnit})`]: fromMm(p.height, lengthUnit),
          [`Weight (${weightUnit})`]: fromKg(p.weight, weightUnit),
          Quantity: p.quantity,
          Stackable: p.stackable ? 'Yes' : 'No',
          Rotatable: p.rotatable ? 'Yes' : 'No',
          Fragile: p.fragile ? 'Yes' : 'No',
          ThisSideUp: p.thisSideUp ? 'Yes' : 'No',
        };
  });
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(productRows),
    isAr ? 'قائمة العبوات' : 'Products'
  );

  // Sheet 4: Loading Sequence & Coordinates
  const seqRows = result.placedPackages.map((p) => {
    const pName = resolvePkgName(p.packageId, p.name, project.packages, language);
    return isAr
      ? {
          الخطوة: p.stepIndex,
          الحاوية: p.containerIndex + 1,
          'المعرّف': p.instanceId,
          SKU: p.sku,
          'اسم المنتج': pName,
          [`X (${lengthUnit})`]: fromMm(p.x, lengthUnit),
          [`Y (${lengthUnit})`]: fromMm(p.y, lengthUnit),
          [`Z (${lengthUnit})`]: fromMm(p.z, lengthUnit),
          [`طول X (${lengthUnit})`]: fromMm(p.dx, lengthUnit),
          [`ارتفاع Y (${lengthUnit})`]: fromMm(p.dy, lengthUnit),
          [`عرض Z (${lengthUnit})`]: fromMm(p.dz, lengthUnit),
          الاتجاه: p.orientationLabel,
          الطبقة: p.layerIndex + 1,
          [`الوزن (${weightUnit})`]: fromKg(p.weight, weightUnit),
          'نسبة الدعم': `${p.supportedAreaPct}%`,
        }
      : {
          Step: p.stepIndex,
          Container: p.containerIndex + 1,
          InstanceID: p.instanceId,
          SKU: p.sku,
          Name: pName,
          [`X (${lengthUnit})`]: fromMm(p.x, lengthUnit),
          [`Y (${lengthUnit})`]: fromMm(p.y, lengthUnit),
          [`Z (${lengthUnit})`]: fromMm(p.z, lengthUnit),
          [`dX (${lengthUnit})`]: fromMm(p.dx, lengthUnit),
          [`dY (${lengthUnit})`]: fromMm(p.dy, lengthUnit),
          [`dZ (${lengthUnit})`]: fromMm(p.dz, lengthUnit),
          Orientation: p.orientationLabel,
          Layer: p.layerIndex + 1,
          [`Weight (${weightUnit})`]: fromKg(p.weight, weightUnit),
          SupportPct: `${p.supportedAreaPct}%`,
        };
  });
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(seqRows),
    isAr ? 'تسلسل التحميل' : 'Loading Sequence'
  );

  // Sheet 5: Unloaded Details
  const unloadedRows = result.unloadedDetails.map((u) => {
    const uName = resolvePkgName(u.packageId, u.name, project.packages, language);
    return isAr
      ? {
          SKU: u.sku,
          المنتج: uName,
          المطلوب: u.requestedQty,
          المحمل: u.loadedQty,
          'غير المحمل': u.unloadedQty,
          الأكواد: u.reasons.join(', '),
          التفاصيل: u.detail,
        }
      : {
          SKU: u.sku,
          Name: uName,
          Requested: u.requestedQty,
          Loaded: u.loadedQty,
          Unloaded: u.unloadedQty,
          ReasonCodes: u.reasons.join(', '),
          Details: u.detail,
        };
  });
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      unloadedRows.length
        ? unloadedRows
        : [isAr ? { الحالة: 'تم تحميل جميع العبوات بنجاح' } : { Status: 'All packages loaded successfully' }]
    ),
    isAr ? 'غير محمل' : 'Unloaded'
  );

  XLSX.writeFile(wb, `PackVolPro_${safeFilePart(projName)}.xlsx`);
}

export function exportToCsv(
  project: Project,
  result: OptimizationResult,
  lengthUnit: LengthUnit,
  weightUnit: WeightUnit,
  language: Language = 'en'
): void {
  const isAr = language === 'ar';
  const projName = resolveDisplayProjectName(project, language);

  const headers = isAr
    ? [
        'الخطوة',
        'الحاوية',
        'المعرّف',
        'SKU',
        'اسم_المنتج',
        `X_${lengthUnit}`,
        `Y_${lengthUnit}`,
        `Z_${lengthUnit}`,
        `الطولX_${lengthUnit}`,
        `الارتفاعY_${lengthUnit}`,
        `العرضZ_${lengthUnit}`,
        'الاتجاه',
        `الوزن_${weightUnit}`,
        'الطبقة',
        'نسبة_الدعم_%',
      ]
    : [
        'Step',
        'Container',
        'InstanceID',
        'SKU',
        'Name',
        `X_${lengthUnit}`,
        `Y_${lengthUnit}`,
        `Z_${lengthUnit}`,
        `LengthX_${lengthUnit}`,
        `HeightY_${lengthUnit}`,
        `WidthZ_${lengthUnit}`,
        'Orientation',
        `Weight_${weightUnit}`,
        'Layer',
        'SupportPct',
      ];

  const rows = result.placedPackages.map((p) => {
    const pName = resolvePkgName(p.packageId, p.name, project.packages, language);
    return [
      p.stepIndex,
      p.containerIndex + 1,
      p.instanceId,
      p.sku,
      `"${pName.replace(/"/g, '""')}"`,
      fromMm(p.x, lengthUnit),
      fromMm(p.y, lengthUnit),
      fromMm(p.z, lengthUnit),
      fromMm(p.dx, lengthUnit),
      fromMm(p.dy, lengthUnit),
      fromMm(p.dz, lengthUnit),
      p.orientationLabel,
      fromKg(p.weight, weightUnit),
      p.layerIndex + 1,
      p.supportedAreaPct,
    ];
  });

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  // Prepend UTF-8 BOM (\uFEFF) so Microsoft Excel renders Arabic text cleanly without garbling
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PackVolPro_${safeFilePart(projName)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------------------------------- */
/* High-DPI Canvas-to-PDF Renderer (Guarantees crisp Arabic shaping & RTL)    */
/* -------------------------------------------------------------------------- */

const A4_W_PX = 1240; // ~150 DPI A4 width
const A4_H_PX = 1754; // ~150 DPI A4 height
const MARGIN = 60;
const CONTENT_W = A4_W_PX - MARGIN * 2;
const FONT_STACK = '"IBM Plex Sans Arabic", "Noto Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif';
const MONO_STACK = '"JetBrains Mono", "IBM Plex Sans Arabic", Consolas, monospace';

function loadImageElement(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function createPdfPageCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = A4_W_PX;
  canvas.height = A4_H_PX;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, A4_W_PX, A4_H_PX);
  return { canvas, ctx };
}

function drawTruncatedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number
): void {
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, y);
    return;
  }
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(trimmed + '…').width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  ctx.fillText(trimmed + '…', x, y);
}

export async function exportToPdf(
  project: Project,
  result: OptimizationResult,
  lengthUnit: LengthUnit,
  weightUnit: WeightUnit,
  snapshotDataUrl?: string | null,
  language: Language = 'en'
): Promise<void> {
  try {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  } catch {
    // ignore font readiness failures
  }

  const isAr = language === 'ar';
  const projName = resolveDisplayProjectName(project, language);
  const spaceName = resolveDisplaySpaceName(project, language);
  const stratName = translateStrategyName(language, result.strategyName);
  const dateStr = new Date().toLocaleString(isAr ? 'ar-EG' : undefined);

  const pages: HTMLCanvasElement[] = [];
  let page = createPdfPageCanvas();
  let ctx = page.ctx;
  pages.push(page.canvas);

  const newPage = () => {
    page = createPdfPageCanvas();
    ctx = page.ctx;
    pages.push(page.canvas);
    return 72;
  };

  // Top Header Bar (White & Red industrial style)
  ctx.fillStyle = '#dc2626';
  ctx.fillRect(0, 0, A4_W_PX, 118);
  ctx.fillStyle = '#991b1b';
  ctx.fillRect(0, 112, A4_W_PX, 6);

  ctx.textBaseline = 'middle';
  ctx.direction = isAr ? 'rtl' : 'ltr';
  ctx.textAlign = isAr ? 'right' : 'left';
  const titleX = isAr ? A4_W_PX - MARGIN : MARGIN;

  ctx.fillStyle = '#ffffff';
  ctx.font = `700 30px ${FONT_STACK}`;
  drawTruncatedText(
    ctx,
    isAr ? 'باك فول برو — تقرير خطة التحميل ثلاثية الأبعاد' : 'PackVol Pro — Cargo Loading Plan Report',
    titleX,
    44,
    CONTENT_W
  );

  ctx.fillStyle = '#fee2e2';
  ctx.font = `500 18px ${FONT_STACK}`;
  drawTruncatedText(
    ctx,
    isAr ? `المشروع: ${projName}   |   التاريخ: ${dateStr}` : `Project: ${projName}   |   Generated: ${dateStr}`,
    titleX,
    84,
    CONTENT_W
  );

  let y = 148;

  // Optional 3D Snapshot
  if (snapshotDataUrl) {
    const img = await loadImageElement(snapshotDataUrl);
    if (img) {
      const boxW = CONTENT_W;
      const boxH = 440;
      ctx.strokeStyle = '#e4e4e7';
      ctx.lineWidth = 2;
      ctx.strokeRect(MARGIN, y, boxW, boxH);
      ctx.drawImage(img, MARGIN + 2, y + 2, boxW - 4, boxH - 4);
      y += boxH + 28;
    }
  }

  // Section Title Helper
  const drawSectionTitle = (title: string, atY: number): number => {
    ctx.direction = isAr ? 'rtl' : 'ltr';
    ctx.textAlign = isAr ? 'right' : 'left';
    ctx.fillStyle = '#18181b';
    ctx.font = `700 22px ${FONT_STACK}`;
    ctx.fillText(title, isAr ? A4_W_PX - MARGIN : MARGIN, atY);
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(isAr ? A4_W_PX - MARGIN - 80 : MARGIN, atY + 16, 80, 4);
    return atY + 38;
  };

  // Summary Table
  y = drawSectionTitle(
    isAr ? 'ملخص مساحة التحميل والكفاءة' : 'Loading Space & Utilization Summary',
    y
  );

  const summaryRows: [string, string, string, string][] = isAr
    ? [
        [
          'مساحة التحميل',
          spaceName,
          'الأبعاد الداخلية',
          formatDims(project.space.internalLength, project.space.internalWidth, project.space.internalHeight, lengthUnit),
        ],
        [
          'المحمّل / المطلوب',
          `${result.loadedPackagesCount} / ${result.totalRequiredPackages}`,
          'استغلال الحجم',
          `${result.volumeUtilizationPct}% (${formatVolume(result.occupiedVolumeMm3, lengthUnit)})`,
        ],
        [
          'إجمالي الوزن',
          formatWeight(result.totalCargoWeightKg, weightUnit),
          'استغلال الوزن',
          `${result.weightUtilizationPct}% (حد ${formatWeight(project.space.maxPayload, weightUnit)})`,
        ],
        [
          'الحاويات / الرحلات',
          `${result.containersUsed} حاوية · ${result.estimatedTrips} رحلة`,
          'مركز الثقل',
          `X:${formatLength(result.centerOfGravity.x, lengthUnit)} Z:${formatLength(result.centerOfGravity.z, lengthUnit)}`,
        ],
        [
          'الخوارزمية',
          stratName,
          'التحقق الفيزيائي',
          result.verification.isValid ? 'تم التحقق بنجاح ✓' : 'توجد مخالفات ✗',
        ],
      ]
    : [
        [
          'Loading Space',
          spaceName,
          'Internal Dims',
          formatDims(project.space.internalLength, project.space.internalWidth, project.space.internalHeight, lengthUnit),
        ],
        [
          'Loaded / Required',
          `${result.loadedPackagesCount} / ${result.totalRequiredPackages}`,
          'Volume Utilization',
          `${result.volumeUtilizationPct}% (${formatVolume(result.occupiedVolumeMm3, lengthUnit)})`,
        ],
        [
          'Total Cargo Weight',
          formatWeight(result.totalCargoWeightKg, weightUnit),
          'Weight Utilization',
          `${result.weightUtilizationPct}% (Max ${formatWeight(project.space.maxPayload, weightUnit)})`,
        ],
        [
          'Spaces / Trips',
          `${result.containersUsed} space(s) · ${result.estimatedTrips} trip(s)`,
          'Center of Gravity',
          `X:${formatLength(result.centerOfGravity.x, lengthUnit)} Z:${formatLength(result.centerOfGravity.z, lengthUnit)}`,
        ],
        [
          'Algorithm Strategy',
          stratName,
          'Physics Verification',
          result.verification.isValid ? 'VERIFIED VALID' : 'VIOLATIONS DETECTED',
        ],
      ];

  const rowH = 44;
  const colW = CONTENT_W / 4;
  summaryRows.forEach((row, rIdx) => {
    const ry = y + rIdx * rowH;
    const cols = isAr ? [row[2], row[3], row[0], row[1]] : row;
    cols.forEach((cell, cIdx) => {
      const cx = MARGIN + cIdx * colW;
      const isLabel = isAr ? cIdx === 0 || cIdx === 2 : cIdx === 0 || cIdx === 2;
      ctx.fillStyle = isLabel ? '#fef2f2' : rIdx % 2 === 0 ? '#ffffff' : '#fafafa';
      ctx.fillRect(cx, ry, colW, rowH);
      ctx.strokeStyle = '#e4e4e7';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx, ry, colW, rowH);

      ctx.direction = isAr ? 'rtl' : 'ltr';
      ctx.textAlign = isAr ? 'right' : 'left';
      ctx.fillStyle = isLabel ? '#991b1b' : '#18181b';
      ctx.font = `${isLabel ? '700' : '500'} 15px ${FONT_STACK}`;
      const padX = isAr ? cx + colW - 12 : cx + 12;
      drawTruncatedText(ctx, cell, padX, ry + rowH / 2, colW - 24);
    });
  });
  y += summaryRows.length * rowH + 34;

  // Multi-Container Breakdown if > 1 container
  if (result.containerSummaries.length > 1) {
    if (y + 180 > A4_H_PX - 80) y = newPage();
    y = drawSectionTitle(
      isAr ? 'ملخص الحاويات والوحدات' : 'Container Fleet Breakdown',
      y
    );
    const cCols = isAr
      ? [
          { label: 'التوازن', w: 0.14 },
          { label: 'الوزن', w: 0.2 },
          { label: 'الحجم %', w: 0.14 },
          { label: 'العبوات', w: 0.12 },
          { label: 'الأبعاد', w: 0.2 },
          { label: 'الحاوية', w: 0.2 },
        ]
      : [
          { label: 'Container', w: 0.2 },
          { label: 'Dimensions', w: 0.2 },
          { label: 'Loaded', w: 0.12 },
          { label: 'Vol %', w: 0.14 },
          { label: 'Weight', w: 0.2 },
          { label: 'Balance', w: 0.14 },
        ];

    const drawContRow = (vals: string[], ry: number, isHeader: boolean, zebra: boolean) => {
      let cx = MARGIN;
      const rh = 38;
      vals.forEach((v, i) => {
        const w = cCols[i].w * CONTENT_W;
        ctx.fillStyle = isHeader ? '#dc2626' : zebra ? '#fafafa' : '#ffffff';
        ctx.fillRect(cx, ry, w, rh);
        ctx.strokeStyle = '#e4e4e7';
        ctx.strokeRect(cx, ry, w, rh);
        ctx.direction = isAr ? 'rtl' : 'ltr';
        ctx.textAlign = isAr ? 'right' : 'left';
        ctx.fillStyle = isHeader ? '#ffffff' : '#18181b';
        ctx.font = `${isHeader ? '700' : '500'} 14px ${FONT_STACK}`;
        drawTruncatedText(ctx, v, isAr ? cx + w - 10 : cx + 10, ry + rh / 2, w - 20);
        cx += w;
      });
      return ry + rh;
    };

    y = drawContRow(
      cCols.map((c) => c.label),
      y,
      true,
      false
    );
    result.containerSummaries.forEach((cs, idx) => {
      if (y + 42 > A4_H_PX - 70) {
        y = newPage();
        y = drawContRow(
          cCols.map((c) => c.label),
          y,
          true,
          false
        );
      }
      const sp = cs.space ?? project.space;
      const spName = isAr && sp.nameAr ? sp.nameAr : sp.name;
      const dims = formatDims(sp.internalLength, sp.internalWidth, sp.internalHeight, lengthUnit);
      const vals = isAr
        ? [
            `${cs.balanceScore}/100`,
            formatWeight(cs.loadedWeightKg, weightUnit),
            `${cs.volumeUtilizationPct}%`,
            String(cs.loadedCount),
            dims,
            `#${cs.containerIndex + 1} · ${spName}`,
          ]
        : [
            `#${cs.containerIndex + 1} · ${spName}`,
            dims,
            String(cs.loadedCount),
            `${cs.volumeUtilizationPct}%`,
            formatWeight(cs.loadedWeightKg, weightUnit),
            `${cs.balanceScore}/100`,
          ];
      y = drawContRow(vals, y, false, idx % 2 === 1);
    });
    y += 30;
  }

  // Loading Sequence Table
  if (y + 180 > A4_H_PX - 80) y = newPage();
  y = drawSectionTitle(
    isAr ? 'تسلسل التحميل والإحداثيات ثلاثية الأبعاد' : 'Loading Sequence & 3D Coordinates',
    y
  );

  const seqCols = isAr
    ? [
        { label: `الوزن (${weightUnit})`, w: 0.1 },
        { label: 'الاتجاه', w: 0.1 },
        { label: `الأبعاد (${lengthUnit})`, w: 0.17 },
        { label: `الموضع X,Y,Z (${lengthUnit})`, w: 0.2 },
        { label: 'المنتج', w: 0.21 },
        { label: 'SKU', w: 0.1 },
        { label: 'حاوية', w: 0.06 },
        { label: 'خطوة', w: 0.06 },
      ]
    : [
        { label: 'Step', w: 0.06 },
        { label: 'Unit', w: 0.06 },
        { label: 'SKU', w: 0.11 },
        { label: 'Product', w: 0.22 },
        { label: `Pos (X,Y,Z ${lengthUnit})`, w: 0.19 },
        { label: `Dims (${lengthUnit})`, w: 0.16 },
        { label: 'Orient.', w: 0.1 },
        { label: `Wt (${weightUnit})`, w: 0.1 },
      ];

  const drawSeqHeader = (atY: number) => {
    let cx = MARGIN;
    const rh = 38;
    seqCols.forEach((col) => {
      const w = col.w * CONTENT_W;
      ctx.fillStyle = '#18181b';
      ctx.fillRect(cx, atY, w, rh);
      ctx.strokeStyle = '#3f3f46';
      ctx.strokeRect(cx, atY, w, rh);
      ctx.direction = isAr ? 'rtl' : 'ltr';
      ctx.textAlign = isAr ? 'right' : 'left';
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 13.5px ${FONT_STACK}`;
      drawTruncatedText(ctx, col.label, isAr ? cx + w - 8 : cx + 8, atY + rh / 2, w - 16);
      cx += w;
    });
    return atY + rh;
  };

  y = drawSeqHeader(y);
  const maxRows = Math.min(result.placedPackages.length, 300);
  for (let i = 0; i < maxRows; i++) {
    const p = result.placedPackages[i];
    if (y + 36 > A4_H_PX - 70) {
      y = newPage();
      y = drawSeqHeader(y);
    }
    const pName = resolvePkgName(p.packageId, p.name, project.packages, language);
    const posStr = `${fromMm(p.x, lengthUnit)}, ${fromMm(p.y, lengthUnit)}, ${fromMm(p.z, lengthUnit)}`;
    const dimStr = `${fromMm(p.dx, lengthUnit)}×${fromMm(p.dz, lengthUnit)}×${fromMm(p.dy, lengthUnit)}`;
    const wtStr = String(fromKg(p.weight, weightUnit));
    const vals = isAr
      ? [wtStr, p.orientationLabel, dimStr, posStr, pName, p.sku, `#${p.containerIndex + 1}`, `#${p.stepIndex}`]
      : [`#${p.stepIndex}`, `#${p.containerIndex + 1}`, p.sku, pName, posStr, dimStr, p.orientationLabel, wtStr];

    let cx = MARGIN;
    const rh = 34;
    vals.forEach((v, cIdx) => {
      const w = seqCols[cIdx].w * CONTENT_W;
      ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#fafafa';
      ctx.fillRect(cx, y, w, rh);
      ctx.strokeStyle = '#e4e4e7';
      ctx.strokeRect(cx, y, w, rh);
      ctx.direction = isAr ? 'rtl' : 'ltr';
      ctx.textAlign = isAr ? 'right' : 'left';
      ctx.fillStyle = '#18181b';
      const isMono = isAr ? cIdx !== 4 : cIdx !== 3;
      ctx.font = `500 13px ${isMono ? MONO_STACK : FONT_STACK}`;
      drawTruncatedText(ctx, v, isAr ? cx + w - 8 : cx + 8, y + rh / 2, w - 16);
      cx += w;
    });
    y += rh;
  }

  // Unloaded Diagnostics if any
  if (result.unloadedDetails.length > 0) {
    y += 30;
    if (y + 160 > A4_H_PX - 70) y = newPage();
    y = drawSectionTitle(
      isAr ? 'تشخيص العبوات غير المحملة' : 'Unloaded Cargo Diagnostics',
      y
    );

    const uCols = isAr
      ? [
          { label: 'السبب', w: 0.36 },
          { label: 'غير محمل', w: 0.11 },
          { label: 'محمل', w: 0.1 },
          { label: 'مطلوب', w: 0.1 },
          { label: 'المنتج', w: 0.21 },
          { label: 'SKU', w: 0.12 },
        ]
      : [
          { label: 'SKU', w: 0.12 },
          { label: 'Product', w: 0.21 },
          { label: 'Req', w: 0.1 },
          { label: 'Loaded', w: 0.1 },
          { label: 'Unloaded', w: 0.11 },
          { label: 'Reason', w: 0.36 },
        ];

    const drawUnloadedHeader = (atY: number) => {
      let cx = MARGIN;
      const rh = 38;
      uCols.forEach((col) => {
        const w = col.w * CONTENT_W;
        ctx.fillStyle = '#dc2626';
        ctx.fillRect(cx, atY, w, rh);
        ctx.strokeStyle = '#b91c1c';
        ctx.strokeRect(cx, atY, w, rh);
        ctx.direction = isAr ? 'rtl' : 'ltr';
        ctx.textAlign = isAr ? 'right' : 'left';
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 14px ${FONT_STACK}`;
        drawTruncatedText(ctx, col.label, isAr ? cx + w - 8 : cx + 8, atY + rh / 2, w - 16);
        cx += w;
      });
      return atY + rh;
    };

    y = drawUnloadedHeader(y);
    result.unloadedDetails.forEach((u, idx) => {
      if (y + 38 > A4_H_PX - 70) {
        y = newPage();
        y = drawUnloadedHeader(y);
      }
      const uName = resolvePkgName(u.packageId, u.name, project.packages, language);
      const vals = isAr
        ? [u.detail, String(u.unloadedQty), String(u.loadedQty), String(u.requestedQty), uName, u.sku]
        : [u.sku, uName, String(u.requestedQty), String(u.loadedQty), String(u.unloadedQty), u.detail];
      let cx = MARGIN;
      const rh = 36;
      vals.forEach((v, cIdx) => {
        const w = uCols[cIdx].w * CONTENT_W;
        ctx.fillStyle = idx % 2 === 0 ? '#ffffff' : '#fef2f2';
        ctx.fillRect(cx, y, w, rh);
        ctx.strokeStyle = '#fecaca';
        ctx.strokeRect(cx, y, w, rh);
        ctx.direction = isAr ? 'rtl' : 'ltr';
        ctx.textAlign = isAr ? 'right' : 'left';
        ctx.fillStyle = '#18181b';
        ctx.font = `500 13.5px ${FONT_STACK}`;
        drawTruncatedText(ctx, v, isAr ? cx + w - 8 : cx + 8, y + rh / 2, w - 16);
        cx += w;
      });
      y += rh;
    });
  }

  // Stamp clean page footers on all pages
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  pages.forEach((pgCanvas, idx) => {
    const pgCtx = pgCanvas.getContext('2d')!;
    pgCtx.direction = isAr ? 'rtl' : 'ltr';
    pgCtx.textAlign = 'center';
    pgCtx.fillStyle = '#71717a';
    pgCtx.font = `500 13px ${FONT_STACK}`;
    pgCtx.fillText(
      isAr
        ? `باك فول برو · صفحة ${idx + 1} من ${pages.length}`
        : `PackVol Pro · Page ${idx + 1} of ${pages.length}`,
      A4_W_PX / 2,
      A4_H_PX - 30
    );

    if (idx > 0) doc.addPage();
    doc.addImage(pgCanvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297, undefined, 'FAST');
  });

  doc.save(`PackVolPro_Report_${safeFilePart(projName)}.pdf`);
}

export function exportProjectBackupJson(project: Project): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PackVolPro_Backup_${safeFilePart(project.name)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
