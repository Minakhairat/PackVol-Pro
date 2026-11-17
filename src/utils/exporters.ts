import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  LengthUnit,
  OptimizationResult,
  PackageSpec,
  Project,
  WeightUnit,
} from '../types/packvol';
import { formatDims, formatLength, formatVolume, formatWeight, fromKg, fromMm } from './units';

const PALETTE = ['#ea580c', '#2563eb', '#d97706', '#0d9488', '#dc2626', '#475569', '#059669', '#9333ea'];

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
  weightUnit: WeightUnit
): void {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary
  const summaryRows = [
    { Metric: 'Project Name', Value: project.name },
    { Metric: 'Loading Space', Value: project.space.name },
    { Metric: 'Space Internal Dimensions', Value: formatDims(project.space.internalLength, project.space.internalWidth, project.space.internalHeight, lengthUnit) },
    { Metric: 'Max Payload', Value: formatWeight(project.space.maxPayload, weightUnit) },
    { Metric: 'Optimization Mode', Value: result.mode },
    { Metric: 'Winning Strategy', Value: result.strategyName },
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
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Summary');

  // Sheet 2: Product Manifest
  const productRows = project.packages.map((p) => ({
    SKU: p.sku,
    Name: p.name,
    Category: p.category,
    [`Length (${lengthUnit})`]: fromMm(p.length, lengthUnit),
    [`Width (${lengthUnit})`]: fromMm(p.width, lengthUnit),
    [`Height (${lengthUnit})`]: fromMm(p.height, lengthUnit),
    [`Weight (${weightUnit})`]: fromKg(p.weight, weightUnit),
    Quantity: p.quantity,
    Stackable: p.stackable ? 'Yes' : 'No',
    Rotatable: p.rotatable ? 'Yes' : 'No',
    Fragile: p.fragile ? 'Yes' : 'No',
    ThisSideUp: p.thisSideUp ? 'Yes' : 'No',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(productRows), 'Products');

  // Sheet 3: Loading Sequence & Coordinates
  const seqRows = result.placedPackages.map((p) => ({
    Step: p.stepIndex,
    Container: p.containerIndex + 1,
    InstanceID: p.instanceId,
    SKU: p.sku,
    Name: p.name,
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
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(seqRows), 'Loading Sequence');

  // Sheet 4: Unloaded Details
  const unloadedRows = result.unloadedDetails.map((u) => ({
    SKU: u.sku,
    Name: u.name,
    Requested: u.requestedQty,
    Loaded: u.loadedQty,
    Unloaded: u.unloadedQty,
    ReasonCodes: u.reasons.join(', '),
    Details: u.detail,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(unloadedRows.length ? unloadedRows : [{ Status: 'All packages loaded successfully' }]), 'Unloaded');

  const safeName = project.name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
  XLSX.writeFile(wb, `PackVolPro_${safeName}.xlsx`);
}

export function exportToCsv(
  project: Project,
  result: OptimizationResult,
  lengthUnit: LengthUnit,
  weightUnit: WeightUnit
): void {
  const headers = [
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

  const rows = result.placedPackages.map((p) => [
    p.stepIndex,
    p.containerIndex + 1,
    p.instanceId,
    p.sku,
    `"${p.name.replace(/"/g, '""')}"`,
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
  ]);

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PackVolPro_${project.name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportToPdf(
  project: Project,
  result: OptimizationResult,
  lengthUnit: LengthUnit,
  weightUnit: WeightUnit,
  snapshotDataUrl?: string | null
): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // Header Bar
  doc.setFillColor(24, 24, 27);
  doc.rect(0, 0, 210, 24, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(15);
  doc.text('PackVol Pro — Cargo Loading Plan Report', 14, 11);
  doc.setFontSize(9);
  doc.setTextColor(212, 212, 216);
  doc.text(`Project: ${project.name}   |   Generated: ${new Date().toLocaleString()}`, 14, 18);

  let y = 32;

  // 3D Snapshot if available
  if (snapshotDataUrl) {
    try {
      doc.addImage(snapshotDataUrl, 'PNG', 14, y, 182, 82);
      y += 88;
    } catch {
      // ignore image encode error
    }
  }

  // Summary Table
  doc.setTextColor(24, 24, 27);
  doc.setFontSize(11);
  doc.text('Loading Space & Utilization Summary', 14, y);
  y += 3;

  autoTable(doc, {
    startY: y,
    head: [['Parameter', 'Value', 'Parameter', 'Value']],
    body: [
      [
        'Loading Space',
        project.space.name,
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
        result.strategyName,
        'Physics Verification',
        result.verification.isValid ? 'VERIFIED VALID' : 'VIOLATIONS DETECTED',
      ],
    ],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [234, 88, 12] },
  });

  // Loading Sequence Table (first 150 rows to keep PDF snappy, or all if <= 200)
  const finalY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  doc.setFontSize(11);
  doc.text('Loading Sequence & 3D Coordinates', 14, finalY);

  autoTable(doc, {
    startY: finalY + 3,
    head: [['Step', 'Unit', 'SKU', 'Product', `Pos (X,Y,Z ${lengthUnit})`, `Dims (${lengthUnit})`, 'Orient.', `Wt (${weightUnit})`]],
    body: result.placedPackages.slice(0, 250).map((p) => [
      p.stepIndex,
      `#${p.containerIndex + 1}`,
      p.sku,
      p.name.slice(0, 22),
      `${fromMm(p.x, lengthUnit)}, ${fromMm(p.y, lengthUnit)}, ${fromMm(p.z, lengthUnit)}`,
      `${fromMm(p.dx, lengthUnit)}×${fromMm(p.dz, lengthUnit)}×${fromMm(p.dy, lengthUnit)}`,
      p.orientationLabel,
      fromKg(p.weight, weightUnit),
    ]),
    styles: { fontSize: 7.5, cellPadding: 1.6 },
    headStyles: { fillColor: [39, 39, 42] },
  });

  if (result.unloadedDetails.length > 0) {
    const uY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
    doc.setFontSize(11);
    doc.text('Unloaded Cargo Diagnostics', 14, uY);
    autoTable(doc, {
      startY: uY + 3,
      head: [['SKU', 'Product', 'Req', 'Loaded', 'Unloaded', 'Reason']],
      body: result.unloadedDetails.map((u) => [
        u.sku,
        u.name,
        u.requestedQty,
        u.loadedQty,
        u.unloadedQty,
        u.detail,
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [220, 38, 38] },
    });
  }

  doc.save(`PackVolPro_Report_${project.name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40)}.pdf`);
}

export function exportProjectBackupJson(project: Project): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PackVolPro_Backup_${project.name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
