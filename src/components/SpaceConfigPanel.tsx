import React from 'react';
import {
  Language,
  LengthUnit,
  LoadingDirection,
  LoadingSpace,
  SpaceCategory,
  WeightUnit,
} from '../types/packvol';
import { SPACE_TEMPLATES } from '../data/presets';
import { fromKg, fromMm, toKg, toMm } from '../utils/units';
import { t } from '../i18n/translations';

interface SpaceConfigPanelProps {
  space: LoadingSpace;
  loadingDirection: LoadingDirection;
  lengthUnit: LengthUnit;
  weightUnit: WeightUnit;
  language: Language;
  onUpdateSpace: (space: LoadingSpace, loadingDirection?: LoadingDirection, resetResult?: boolean) => void;
}

export const SpaceConfigPanel: React.FC<SpaceConfigPanelProps> = ({
  space,
  loadingDirection,
  lengthUnit,
  weightUnit,
  language,
  onUpdateSpace,
}) => {
  const categories: { id: SpaceCategory; label: string }[] = [
    { id: 'container', label: t(language, 'catContainers') },
    { id: 'truck', label: t(language, 'catTrucks') },
    { id: 'pallet', label: t(language, 'catPallets') },
    { id: 'railway', label: t(language, 'catRail') },
    { id: 'custom', label: t(language, 'catCustom') },
  ];

  const handleSelectTemplate = (tplId: string) => {
    const found = SPACE_TEMPLATES.find((s) => s.id === tplId);
    if (found) {
      onUpdateSpace({ ...found }, found.loadingDirection, true);
    }
  };

  const updateLengthField = (
    field: 'internalLength' | 'internalWidth' | 'internalHeight' | 'doorWidth' | 'doorHeight',
    displayVal: string
  ) => {
    const num = Number(displayVal);
    if (!Number.isFinite(num) || num < 0) return;
    onUpdateSpace({
      ...space,
      [field]: Math.max(10, toMm(num, lengthUnit)),
    });
  };

  const updateWeightField = (field: 'maxPayload' | 'tareWeight', displayVal: string) => {
    const num = Number(displayVal);
    if (!Number.isFinite(num) || num < 0) return;
    onUpdateSpace({
      ...space,
      [field]: toKg(num, weightUnit),
    });
  };

  const templatesForCat = SPACE_TEMPLATES.filter((s) => s.category === space.category);

  return (
    <div className="space-y-3">
      {/* Category filter buttons */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-1 p-1 bg-zinc-100 rounded-lg">
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => {
              const first = SPACE_TEMPLATES.find((s) => s.category === cat.id);
              if (first) {
                onUpdateSpace({ ...first }, first.loadingDirection, true);
              }
            }}
            className={`py-2 sm:py-1.5 px-1.5 text-[11px] font-medium rounded-md transition-colors cursor-pointer truncate ${
              space.category === cat.id
                ? 'bg-red-600 text-white shadow-sm font-semibold'
                : 'text-zinc-600 hover:text-zinc-900'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Template Dropdown */}
      <div>
        <label className="block text-xs font-medium text-zinc-600 mb-1">
          {t(language, 'spaceTemplates')}
        </label>
        <select
          value={templatesForCat.some((s) => s.id === space.id) ? space.id : templatesForCat[0]?.id ?? ''}
          onChange={(e) => handleSelectTemplate(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-xs font-medium text-zinc-900 focus:outline-none focus:border-red-600"
        >
          {templatesForCat.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {language === 'ar' && tpl.nameAr ? tpl.nameAr : tpl.name}
            </option>
          ))}
        </select>
      </div>

      {/* Internal Dimensions */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div>
          <label className="block text-[11px] font-medium text-zinc-600 mb-1">
            {t(language, 'internalLength')} ({lengthUnit})
          </label>
          <input
            type="number"
            step="any"
            value={fromMm(space.internalLength, lengthUnit)}
            onChange={(e) => updateLengthField('internalLength', e.target.value)}
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-mono tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-zinc-600 mb-1">
            {t(language, 'internalWidth')} ({lengthUnit})
          </label>
          <input
            type="number"
            step="any"
            value={fromMm(space.internalWidth, lengthUnit)}
            onChange={(e) => updateLengthField('internalWidth', e.target.value)}
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-mono tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-zinc-600 mb-1">
            {t(language, 'internalHeight')} ({lengthUnit})
          </label>
          <input
            type="number"
            step="any"
            value={fromMm(space.internalHeight, lengthUnit)}
            onChange={(e) => updateLengthField('internalHeight', e.target.value)}
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-mono tabular-nums"
          />
        </div>
      </div>

      {/* Payload, Tare & Floor limit */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div>
          <label className="block text-[11px] font-medium text-zinc-600 mb-1">
            {t(language, 'maxPayload')} ({weightUnit})
          </label>
          <input
            type="number"
            step="any"
            value={fromKg(space.maxPayload, weightUnit)}
            onChange={(e) => updateWeightField('maxPayload', e.target.value)}
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-mono tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-zinc-600 mb-1">
            {t(language, 'tareWeight')} ({weightUnit})
          </label>
          <input
            type="number"
            step="any"
            value={fromKg(space.tareWeight ?? 0, weightUnit)}
            onChange={(e) => updateWeightField('tareWeight', e.target.value)}
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-mono tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-zinc-600 mb-1">
            {t(language, 'floorWeightLimit')}
          </label>
          <input
            type="number"
            step="any"
            value={space.floorWeightLimit ?? 0}
            onChange={(e) =>
              onUpdateSpace({ ...space, floorWeightLimit: Math.max(0, Number(e.target.value) || 0) })
            }
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-mono tabular-nums"
          />
        </div>
      </div>

      {/* Door Clearance & Loading Direction */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div>
          <label className="block text-[11px] font-medium text-zinc-600 mb-1">
            {t(language, 'doorWidth')} ({lengthUnit})
          </label>
          <input
            type="number"
            step="any"
            value={fromMm(space.doorWidth, lengthUnit)}
            onChange={(e) => updateLengthField('doorWidth', e.target.value)}
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-mono tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-zinc-600 mb-1">
            {t(language, 'doorHeight')} ({lengthUnit})
          </label>
          <input
            type="number"
            step="any"
            value={fromMm(space.doorHeight, lengthUnit)}
            onChange={(e) => updateLengthField('doorHeight', e.target.value)}
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-mono tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-zinc-600 mb-1">
            {t(language, 'loadingDirection')}
          </label>
          <select
            value={loadingDirection}
            onChange={(e) => {
              const nextDir = e.target.value as LoadingDirection;
              onUpdateSpace({ ...space, loadingDirection: nextDir }, nextDir);
            }}
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs font-medium"
          >
            <option value="rear">{t(language, 'rearLoading')}</option>
            <option value="side">{t(language, 'sideLoading')}</option>
            <option value="top">{t(language, 'topLoading')}</option>
          </select>
        </div>
      </div>
    </div>
  );
};
