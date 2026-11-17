import React, { useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import {
  Language,
  LengthUnit,
  LoadingSpace,
  OptimizationResult,
  PlacedPackage,
} from '../types/packvol';
import { formatLength } from '../utils/units';
import { t } from '../i18n/translations';

interface Views2DProps {
  space: LoadingSpace;
  result: OptimizationResult;
  lengthUnit: LengthUnit;
  language: Language;
  containerIndex: number;
  selectedInstanceId?: string | null;
  onSelectPackage?: (pkg: PlacedPackage) => void;
}

export const Views2D: React.FC<Views2DProps> = ({
  space,
  result,
  lengthUnit,
  language,
  containerIndex,
  selectedInstanceId,
  onSelectPackage,
}) => {
  const [activeView, setActiveView] = useState<'all' | 'top' | 'front' | 'side'>('all');

  const boxes = useMemo(
    () => result.placedPackages.filter((p) => p.containerIndex === containerIndex),
    [result.placedPackages, containerIndex]
  );

  const renderSvgView = (
    title: string,
    wMm: number,
    hMm: number,
    axisXLabel: string,
    axisYLabel: string,
    mapRect: (b: PlacedPackage) => { x: number; y: number; w: number; h: number; depthOrder: number },
    cogPoint?: { x: number; y: number }
  ) => {
    const pad = 44;
    const drawW = 540;
    const scale = drawW / Math.max(1, wMm);
    const drawH = Math.max(140, Math.min(360, hMm * scale));
    const actualScale = Math.min(drawW / Math.max(1, wMm), drawH / Math.max(1, hMm));
    const rectW = wMm * actualScale;
    const rectH = hMm * actualScale;

    const sorted = [...boxes]
      .map((b) => ({ b, r: mapRect(b) }))
      .sort((a, b) => a.r.depthOrder - b.r.depthOrder);

    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-4 print-break-inside-avoid">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-zinc-900">{title}</h4>
          <span className="text-xs font-mono text-zinc-500 tabular-nums">
            {formatLength(wMm, lengthUnit)} × {formatLength(hMm, lengthUnit)}
          </span>
        </div>

        <svg
          viewBox={`0 0 ${rectW + pad * 2} ${rectH + pad * 2}`}
          className="w-full h-auto bg-zinc-50 border border-zinc-200 rounded"
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
            y={pad - 12}
            textAnchor="middle"
            fontSize="11"
            fill="#52525b"
            fontFamily="JetBrains Mono, monospace"
          >
            {axisXLabel}: {formatLength(wMm, lengthUnit)}
          </text>
          <text
            x={pad - 14}
            y={pad + rectH / 2}
            textAnchor="middle"
            fontSize="11"
            fill="#52525b"
            fontFamily="JetBrains Mono, monospace"
            transform={`rotate(-90, ${pad - 14}, ${pad + rectH / 2})`}
          >
            {axisYLabel}: {formatLength(hMm, lengthUnit)}
          </text>

          {/* Packages */}
          {sorted.map(({ b, r }) => {
            const sx = pad + r.x * actualScale;
            const sy = pad + r.y * actualScale;
            const sw = Math.max(2, r.w * actualScale);
            const sh = Math.max(2, r.h * actualScale);
            const isSel = selectedInstanceId === b.instanceId;

            return (
              <g
                key={`${title}-${b.instanceId}`}
                onClick={() => onSelectPackage?.(b)}
                className="cursor-pointer"
              >
                <rect
                  x={sx}
                  y={sy}
                  width={sw}
                  height={sh}
                  fill={b.color}
                  fillOpacity={isSel ? 0.95 : 0.78}
                  stroke={isSel ? '#000000' : '#ffffff'}
                  strokeWidth={isSel ? 2.5 : 1}
                />
                {sw > 22 && sh > 14 && (
                  <text
                    x={sx + sw / 2}
                    y={sy + sh / 2 + 3.5}
                    textAnchor="middle"
                    fontSize={Math.min(11, Math.max(8, Math.min(sw, sh) * 0.35))}
                    fontWeight="600"
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
                r={5}
                fill="#ef4444"
                stroke="#ffffff"
                strokeWidth={1.5}
              />
              <line
                x1={pad + cogPoint.x * actualScale - 9}
                y1={pad + cogPoint.y * actualScale}
                x2={pad + cogPoint.x * actualScale + 9}
                y2={pad + cogPoint.y * actualScale}
                stroke="#ef4444"
                strokeWidth={1.5}
              />
              <line
                x1={pad + cogPoint.x * actualScale}
                y1={pad + cogPoint.y * actualScale - 9}
                x2={pad + cogPoint.x * actualScale}
                y2={pad + cogPoint.y * actualScale + 9}
                stroke="#ef4444"
                strokeWidth={1.5}
              />
            </g>
          )}
        </svg>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div className="flex items-center gap-1 p-1 bg-zinc-200/80 rounded-lg">
          {(['all', 'top', 'front', 'side'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setActiveView(v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeView === v
                  ? 'bg-white text-zinc-900 shadow-sm'
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
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
        >
          <Printer className="w-3.5 h-3.5" />
          <span>{t(language, 'printViews')}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
            result.centerOfGravity
              ? { x: result.centerOfGravity.x, y: result.centerOfGravity.z }
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
