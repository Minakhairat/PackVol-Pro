import React, { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, FileText, PackageCheck } from 'lucide-react';
import {
  Language,
  LengthUnit,
  OptimizationResult,
  Project,
  WeightUnit,
} from '../types/packvol';
import { formatDims, formatVolume, formatWeight } from '../utils/units';
import {
  buildCompactReportRows,
  exportCompactSummaryCsv,
  exportCompactSummaryExcel,
  exportCompactSummaryPdf,
} from '../utils/exporters';
import { t } from '../i18n/translations';

interface CompactReportPanelProps {
  project: Project;
  result: OptimizationResult;
  lengthUnit: LengthUnit;
  weightUnit: WeightUnit;
  language: Language;
  activeContainerIdx?: number;
}

export const CompactReportPanel: React.FC<CompactReportPanelProps> = ({
  project,
  result,
  lengthUnit,
  weightUnit,
  language,
  activeContainerIdx = 0,
}) => {
  const [scope, setScope] = useState<'all' | 'container'>('all');

  const hasMultipleContainers = result.containersUsed > 1;
  const containerFilter =
    hasMultipleContainers && scope === 'container' ? activeContainerIdx : null;

  const rows = useMemo(
    () => buildCompactReportRows(project, result, language, containerFilter),
    [project, result, language, containerFilter]
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          requested: acc.requested + r.requestedQty,
          loaded: acc.loaded + r.loadedQty,
          unloaded: acc.unloaded + r.unloadedQty,
          weightKg: acc.weightKg + r.totalWeightKg,
          volumeMm3: acc.volumeMm3 + r.totalVolumeMm3,
        }),
        { requested: 0, loaded: 0, unloaded: 0, weightKg: 0, volumeMm3: 0 }
      ),
    [rows]
  );

  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      {/* Header & Export Actions */}
      <div className="p-3.5 sm:p-4 border-b border-zinc-200 bg-zinc-50/70 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <PackageCheck className="w-4 h-4 text-red-600 shrink-0" />
            <h2 className="text-sm sm:text-base font-bold text-zinc-900">
              {t(language, 'compactReport')}
            </h2>
          </div>
          <p className="text-[11px] sm:text-xs text-zinc-500 mt-0.5">
            {t(language, 'compactReportDesc')}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 no-print">
          {hasMultipleContainers && (
            <div className="grid grid-cols-2 sm:inline-flex items-center gap-1 p-1 bg-white border border-zinc-200 rounded-lg">
              <button
                type="button"
                onClick={() => setScope('all')}
                className={`px-2.5 py-1.5 sm:py-1 rounded-md text-[11px] font-semibold cursor-pointer transition-colors ${
                  scope === 'all'
                    ? 'bg-red-600 text-white'
                    : 'text-zinc-600 hover:text-zinc-900'
                }`}
              >
                {t(language, 'allContainersScope')}
              </button>
              <button
                type="button"
                onClick={() => setScope('container')}
                className={`px-2.5 py-1.5 sm:py-1 rounded-md text-[11px] font-semibold cursor-pointer transition-colors ${
                  scope === 'container'
                    ? 'bg-red-600 text-white'
                    : 'text-zinc-600 hover:text-zinc-900'
                }`}
              >
                {t(language, 'selectedContainerScope')} #{activeContainerIdx + 1}
              </button>
            </div>
          )}

          <div className="grid grid-cols-3 sm:flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                void exportCompactSummaryPdf(
                  project,
                  result,
                  lengthUnit,
                  weightUnit,
                  language,
                  containerFilter
                )
              }
              className="inline-flex items-center justify-center gap-1.5 rounded-lg sm:rounded-md bg-red-600 px-2.5 sm:px-3 py-2 sm:py-1.5 text-[11px] sm:text-xs font-semibold text-white hover:bg-red-700 cursor-pointer shadow-xs"
            >
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{t(language, 'exportCompactPdf')}</span>
            </button>
            <button
              type="button"
              onClick={() =>
                exportCompactSummaryExcel(
                  project,
                  result,
                  lengthUnit,
                  weightUnit,
                  language,
                  containerFilter
                )
              }
              className="inline-flex items-center justify-center gap-1.5 rounded-lg sm:rounded-md border border-zinc-300 bg-white px-2.5 sm:px-3 py-2 sm:py-1.5 text-[11px] sm:text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span className="truncate">{t(language, 'exportCompactExcel')}</span>
            </button>
            <button
              type="button"
              onClick={() =>
                exportCompactSummaryCsv(
                  project,
                  result,
                  lengthUnit,
                  weightUnit,
                  language,
                  containerFilter
                )
              }
              className="inline-flex items-center justify-center gap-1.5 rounded-lg sm:rounded-md border border-zinc-300 bg-white px-2.5 sm:px-3 py-2 sm:py-1.5 text-[11px] sm:text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-red-600 shrink-0" />
              <span className="truncate">{t(language, 'exportCompactCsv')}</span>
            </button>
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="p-6 text-center text-xs text-zinc-500">
          {t(language, 'noItemsInContainer')}
        </div>
      ) : (
        <>
          {/* Mobile Compact Cards (Android & iOS) */}
          <div className="md:hidden p-3 space-y-2.5">
            {rows.map((r) => (
              <div
                key={r.packageId}
                className="rounded-xl border border-zinc-200 bg-white p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-3 h-3 rounded-sm shrink-0 border border-black/10"
                        style={{ backgroundColor: r.color }}
                      />
                      <h3 className="text-sm font-bold text-zinc-900 truncate">{r.name}</h3>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                      <span className="font-mono bg-zinc-100 text-zinc-700 px-1.5 py-0.5 rounded">
                        {r.sku}
                      </span>
                      <span className="font-mono tabular-nums">
                        {formatDims(r.lengthMm, r.widthMm, r.heightMm, lengthUnit)}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 rounded-lg bg-red-50 border border-red-200 px-2.5 py-1 text-center">
                    <div className="text-[10px] font-medium text-red-700">
                      {t(language, 'loadedCol')}
                    </div>
                    <div className="text-base font-bold font-mono tabular-nums text-red-600 leading-tight">
                      {r.loadedQty}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 rounded-lg bg-zinc-50 border border-zinc-100 px-2.5 py-2 text-[11px]">
                  <div>
                    <div className="text-[10px] text-zinc-500">{t(language, 'reqCol')}</div>
                    <div className="font-mono font-semibold text-zinc-800 tabular-nums">
                      {r.requestedQty}
                      {containerFilter === null && r.unloadedQty > 0 && (
                        <span className="text-red-600 ms-1">(-{r.unloadedQty})</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">{t(language, 'totalWeightCol')}</div>
                    <div className="font-mono font-semibold text-zinc-900 tabular-nums">
                      {formatWeight(r.totalWeightKg, weightUnit)}
                    </div>
                  </div>
                  <div className="text-end">
                    <div className="text-[10px] text-zinc-500">{t(language, 'totalVolumeCol')}</div>
                    <div className="font-mono font-semibold text-zinc-900 tabular-nums">
                      {formatVolume(r.totalVolumeMm3, lengthUnit)}
                    </div>
                  </div>
                </div>

                {hasMultipleContainers && containerFilter === null && r.containerBreakdown.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 pt-0.5">
                    {r.containerBreakdown.map((cb) => (
                      <span
                        key={cb.containerIndex}
                        className="px-2 py-0.5 rounded bg-zinc-100 text-zinc-700 font-mono text-[10px] font-semibold"
                      >
                        #{cb.containerIndex + 1}: {cb.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Mobile Grand Total Bar */}
            <div className="rounded-xl border border-red-200 bg-red-50/70 p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-bold text-red-900">{t(language, 'totalsRowLabel')}</span>
              <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums font-bold text-red-700">
                <span>
                  {totals.loaded} {t(language, 'pkgsShort')}
                </span>
                <span>{formatWeight(totals.weightKg, weightUnit)}</span>
                <span>{formatVolume(totals.volumeMm3, lengthUnit)}</span>
              </div>
            </div>
          </div>

          {/* Desktop / Tablet One-Row-Per-Item Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs text-start">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
                <tr>
                  <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'sku')}</th>
                  <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'productName')}</th>
                  <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'dimensions')}</th>
                  <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'unitWeightCol')}</th>
                  <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'reqCol')}</th>
                  <th className="py-2.5 px-3 text-end font-semibold text-red-700 bg-red-50/50">
                    {t(language, 'loadedCol')}
                  </th>
                  {containerFilter === null && (
                    <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'unloadedCol')}</th>
                  )}
                  {hasMultipleContainers && containerFilter === null && (
                    <th className="py-2.5 px-3 text-start font-semibold">
                      {t(language, 'containersDistCol')}
                    </th>
                  )}
                  <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'totalWeightCol')}</th>
                  <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'totalVolumeCol')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {rows.map((r) => (
                  <tr key={r.packageId} className="hover:bg-zinc-50">
                    <td className="py-2.5 px-3 font-mono text-zinc-700">{r.sku}</td>
                    <td className="py-2.5 px-3 font-semibold text-zinc-900">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm me-2 align-middle"
                        style={{ backgroundColor: r.color }}
                      />
                      {r.name}
                    </td>
                    <td className="py-2.5 px-3 font-mono tabular-nums text-zinc-600">
                      {formatDims(r.lengthMm, r.widthMm, r.heightMm, lengthUnit)}
                    </td>
                    <td className="py-2.5 px-3 text-end font-mono tabular-nums text-zinc-600">
                      {formatWeight(r.unitWeightKg, weightUnit)}
                    </td>
                    <td className="py-2.5 px-3 text-end font-mono tabular-nums text-zinc-700">
                      {r.requestedQty}
                    </td>
                    <td className="py-2.5 px-3 text-end font-mono tabular-nums font-bold text-red-600 bg-red-50/40">
                      {r.loadedQty}
                    </td>
                    {containerFilter === null && (
                      <td className="py-2.5 px-3 text-end font-mono tabular-nums">
                        <span className={r.unloadedQty > 0 ? 'font-bold text-red-600' : 'text-zinc-400'}>
                          {r.unloadedQty}
                        </span>
                      </td>
                    )}
                    {hasMultipleContainers && containerFilter === null && (
                      <td className="py-2.5 px-3 font-mono text-[11px] text-zinc-600">
                        {r.containerBreakdown.length > 0
                          ? r.containerBreakdown.map((cb) => `#${cb.containerIndex + 1} (${cb.count})`).join(' · ')
                          : '—'}
                      </td>
                    )}
                    <td className="py-2.5 px-3 text-end font-mono tabular-nums font-semibold text-zinc-900">
                      {formatWeight(r.totalWeightKg, weightUnit)}
                    </td>
                    <td className="py-2.5 px-3 text-end font-mono tabular-nums text-zinc-700">
                      {formatVolume(r.totalVolumeMm3, lengthUnit)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-red-50/80 border-t-2 border-red-200 font-bold text-red-900">
                <tr>
                  <td className="py-2.5 px-3 font-mono">{rows.length}</td>
                  <td className="py-2.5 px-3" colSpan={3}>
                    {t(language, 'totalsRowLabel')}
                  </td>
                  <td className="py-2.5 px-3 text-end font-mono tabular-nums">{totals.requested}</td>
                  <td className="py-2.5 px-3 text-end font-mono tabular-nums text-red-700">
                    {totals.loaded}
                  </td>
                  {containerFilter === null && (
                    <td className="py-2.5 px-3 text-end font-mono tabular-nums">{totals.unloaded}</td>
                  )}
                  {hasMultipleContainers && containerFilter === null && (
                    <td className="py-2.5 px-3 font-mono text-[11px]">
                      {result.containersUsed} {t(language, 'spaceUnit')}
                    </td>
                  )}
                  <td className="py-2.5 px-3 text-end font-mono tabular-nums">
                    {formatWeight(totals.weightKg, weightUnit)}
                  </td>
                  <td className="py-2.5 px-3 text-end font-mono tabular-nums">
                    {formatVolume(totals.volumeMm3, lengthUnit)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
