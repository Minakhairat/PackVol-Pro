import React, { useMemo, useState } from 'react';
import { Printer, X } from 'lucide-react';
import {
  Language,
  LengthUnit,
  LoadingSpace,
  OptimizationResult,
  PlacedPackage,
} from '../types/packvol';
import { formatDims, formatLength } from '../utils/units';
import { safeFilePart } from '../utils/exporters';
import { t } from '../i18n/translations';

interface Views2DProps {
  space: LoadingSpace;
  result: OptimizationResult;
  lengthUnit: LengthUnit;
  language: Language;
  containerIndex: number;
  projectName?: string;
  selectedInstanceId?: string | null;
  onSelectPackage?: (pkg: PlacedPackage) => void;
}

export const Views2D: React.FC<Views2DProps> = ({
  space,
  result,
  lengthUnit,
  language,
  containerIndex,
  projectName,
  selectedInstanceId,
  onSelectPackage,
}) => {
  const [activeView, setActiveView] = useState<'all' | 'top' | 'front' | 'side'>('all');
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);

  const boxes = useMemo(
    () => result.placedPackages.filter((p) => p.containerIndex === containerIndex),
    [result.placedPackages, containerIndex]
  );

  const effectiveSelectedId =
    selectedInstanceId !== undefined ? selectedInstanceId : internalSelectedId;

  const selectedBox = useMemo(
    () => boxes.find((b) => b.instanceId === effectiveSelectedId) ?? null,
    [boxes, effectiveSelectedId]
  );

  const containerSummary = result.containerSummaries[containerIndex];
  const cogForContainer =
    containerSummary?.centerOfGravity ??
    (containerIndex === 0 ? result.centerOfGravity : undefined);

  const handleTapBox = (pkg: PlacedPackage) => {
    setInternalSelectedId(pkg.instanceId);
    onSelectPackage?.(pkg);
  };

  const renderSvgView = (
    title: string,
    wMm: number,
    hMm: number,
    axisXLabel: string,
    axisYLabel: string,
    mapRect: (b: PlacedPackage) => { x: number; y: number; w: number; h: number; depthOrder: number },
    cogPoint?: { x: number; y: number }
  ) => {
    const pad = 52;
    const drawW = 540;
    const scale = drawW / Math.max(1, wMm);
    const drawH = Math.max(150, Math.min(360, hMm * scale));
    const actualScale = Math.min(drawW / Math.max(1, wMm), drawH / Math.max(1, hMm));
    const rectW = wMm * actualScale;
    const rectH = hMm * actualScale;

    const sorted = [...boxes]
      .map((b) => ({ b, r: mapRect(b) }))
      .sort((a, b) => a.r.depthOrder - b.r.depthOrder);

    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-3 sm:p-4 print-break-inside-avoid">
        <div className="flex flex-wrap items-center justify-between gap-1.5 mb-2.5 sm:mb-3">
          <h4 className="text-xs sm:text-sm font-semibold text-zinc-900">{title}</h4>
          <span className="text-[11px] sm:text-xs font-mono text-zinc-500 tabular-nums">
            {formatLength(wMm, lengthUnit)} × {formatLength(hMm, lengthUnit)}
          </span>
        </div>

        <div className="w-full overflow-hidden rounded border border-zinc-200 bg-zinc-50">
          <svg
            viewBox={`0 0 ${rectW + pad * 2} ${rectH + pad * 2}`}
            className="w-full h-auto block touch-manipulation"
            role="img"
            aria-label={title}
          >
            {/* Container boundary */}
            <rect
              x={pad}
              y={pad}
              width={rectW}
              height={rectH}
              fill="#ffffff"
              stroke="#18181b"
              strokeWidth={2}
            />

            {/* Dimension labels */}
            <text
              x={pad + rectW / 2}
              y={pad - 16}
              textAnchor="middle"
              fontSize="13"
              fontWeight="600"
              fill="#52525b"
              fontFamily="JetBrains Mono, monospace"
            >
              {axisXLabel}: {formatLength(wMm, lengthUnit)}
            </text>
            <text
              x={pad - 18}
              y={pad + rectH / 2}
              textAnchor="middle"
              fontSize="13"
              fontWeight="600"
              fill="#52525b"
              fontFamily="JetBrains Mono, monospace"
              transform={`rotate(-90, ${pad - 18}, ${pad + rectH / 2})`}
            >
              {axisYLabel}: {formatLength(hMm, lengthUnit)}
            </text>

            {/* Packages */}
            {sorted.map(({ b, r }) => {
              const sx = pad + r.x * actualScale;
              const sy = pad + r.y * actualScale;
              const sw = Math.max(2, r.w * actualScale);
              const sh = Math.max(2, r.h * actualScale);
              const isSel = effectiveSelectedId === b.instanceId;

              return (
                <g
                  key={`${title}-${b.instanceId}`}
                  onClick={() => handleTapBox(b)}
                  className="cursor-pointer"
                >
                  <rect
                    x={sx}
                    y={sy}
                    width={sw}
                    height={sh}
                    fill={b.color}
                    fillOpacity={isSel ? 0.96 : 0.8}
                    stroke={isSel ? '#dc2626' : '#ffffff'}
                    strokeWidth={isSel ? 2.8 : 1}
                  />
                  {sw > 22 && sh > 14 && (
                    <text
                      x={sx + sw / 2}
                      y={sy + sh / 2 + 4}
                      textAnchor="middle"
                      fontSize={Math.min(12, Math.max(9, Math.min(sw, sh) * 0.35))}
                      fontWeight="700"
                      fill="#ffffff"
                      fontFamily="JetBrains Mono, monospace"
                      pointerEvents="none"
                    >
                      #{b.stepIndex}
                    </text>
                  )}
                  <title>
                    #{b.stepIndex} {b.sku} ({b.name})
                  </title>
                </g>
              );
            })}

            {/* Center of Gravity Crosshair */}
            {cogPoint && (
              <g pointerEvents="none">
                <circle
                  cx={pad + cogPoint.x * actualScale}
                  cy={pad + cogPoint.y * actualScale}
                  r={5.5}
                  fill="#ef4444"
                  stroke="#ffffff"
                  strokeWidth={1.5}
                />
                <line
                  x1={pad + cogPoint.x * actualScale - 10}
                  y1={pad + cogPoint.y * actualScale}
                  x2={pad + cogPoint.x * actualScale + 10}
                  y2={pad + cogPoint.y * actualScale}
                  stroke="#ef4444"
                  strokeWidth={1.8}
                />
                <line
                  x1={pad + cogPoint.x * actualScale}
                  y1={pad + cogPoint.y * actualScale - 10}
                  x2={pad + cogPoint.x * actualScale}
                  y2={pad + cogPoint.y * actualScale + 10}
                  stroke="#ef4444"
                  strokeWidth={1.8}
                />
              </g>
            )}
          </svg>
        </div>
      </div>
    );
  };

  const spaceDisplay = language === 'ar' && space.nameAr ? space.nameAr : space.name;

  const handlePrint = () => {
    const prevTitle = document.title;
    if (projectName?.trim()) {
      document.title = safeFilePart(projectName);
    }
    const restore = () => {
      document.title = prevTitle;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
    setTimeout(restore, 1500);
  };

  return (
    <div className="space-y-3 sm:space-y-4">
      {projectName && (
        <div className="hidden print:flex items-center justify-between border-b-2 border-red-600 pb-2 mb-3">
          <div>
            <div className="text-base font-bold text-zinc-900">{projectName}</div>
            <div className="text-xs text-zinc-600">
              #{containerIndex + 1} · {spaceDisplay}
            </div>
          </div>
          <div className="text-xs font-mono text-zinc-500">
            {formatDims(space.internalLength, space.internalWidth, space.internalHeight, lengthUnit)}
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 no-print">
        <div className="grid grid-cols-2 sm:inline-flex items-center gap-1 p-1 bg-zinc-100 border border-zinc-200 rounded-lg w-full sm:w-auto">
          {(['all', 'top', 'front', 'side'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setActiveView(v)}
              className={`px-2.5 sm:px-3 py-2 sm:py-1.5 text-[11px] sm:text-xs font-semibold rounded-md transition-colors cursor-pointer text-center truncate ${
                activeView === v
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              {v === 'all'
                ? language === 'ar'
                  ? 'جميع المساقط'
                  : 'All Views'
                : v === 'top'
                  ? t(language, 'topView')
                  : v === 'front'
                    ? t(language, 'frontView')
                    : t(language, 'sideView')}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={handlePrint}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-2 sm:py-1.5 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer w-full sm:w-auto"
        >
          <Printer className="w-3.5 h-3.5 text-red-600" />
          <span>{t(language, 'printViews')}</span>
        </button>
      </div>

      {selectedBox && (
        <div className="rounded-lg border border-red-200 bg-red-50/70 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs no-print">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span
              className="w-3 h-3 rounded-sm shrink-0"
              style={{ backgroundColor: selectedBox.color }}
            />
            <span className="font-mono font-bold text-red-700">
              #{selectedBox.stepIndex} · {selectedBox.sku}
            </span>
            <span className="font-semibold text-zinc-900 truncate">{selectedBox.name}</span>
            <span className="font-mono text-zinc-600 tabular-nums">
              {formatDims(selectedBox.dx, selectedBox.dz, selectedBox.dy, lengthUnit)}
            </span>
          </div>
          {!onSelectPackage && (
            <button
              type="button"
              onClick={() => setInternalSelectedId(null)}
              className="p-1 text-zinc-500 hover:text-zinc-900 cursor-pointer"
              aria-label="Clear selection"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        {(activeView === 'all' || activeView === 'top') &&
          renderSvgView(
            t(language, 'topView'),
            space.internalLength,
            space.internalWidth,
            language === 'ar' ? 'الطول (X)' : 'L (X)',
            language === 'ar' ? 'العرض (Z)' : 'W (Z)',
            (b) => ({
              x: b.x,
              y: b.z,
              w: b.dx,
              h: b.dz,
              depthOrder: b.y,
            }),
            cogForContainer
              ? { x: cogForContainer.x, y: cogForContainer.z }
              : undefined
          )}

        {(activeView === 'all' || activeView === 'side') &&
          renderSvgView(
            t(language, 'sideView'),
            space.internalLength,
            space.internalHeight,
            language === 'ar' ? 'الطول (X)' : 'L (X)',
            language === 'ar' ? 'الارتفاع (Y)' : 'H (Y)',
            (b) => ({
              x: b.x,
              y: space.internalHeight - (b.y + b.dy),
              w: b.dx,
              h: b.dy,
              depthOrder: b.z,
            })
          )}

        {(activeView === 'all' || activeView === 'front') &&
          renderSvgView(
            t(language, 'frontView'),
            space.internalWidth,
            space.internalHeight,
            language === 'ar' ? 'العرض (Z)' : 'W (Z)',
            language === 'ar' ? 'الارتفاع (Y)' : 'H (Y)',
            (b) => ({
              x: b.z,
              y: space.internalHeight - (b.y + b.dy),
              w: b.dz,
              h: b.dy,
              depthOrder: b.x,
            })
          )}
      </div>
    </div>
  );
};
