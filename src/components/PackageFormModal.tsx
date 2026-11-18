import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Language, LengthUnit, PackageSpec, WeightUnit } from '../types/packvol';
import { fromKg, fromMm, toKg, toMm } from '../utils/units';
import { t } from '../i18n/translations';
import { DISTINCT_COLOR_PALETTE, getNextDistinctColor } from '../utils/colors';

interface PackageFormModalProps {
  initial?: PackageSpec | null;
  usedColors?: string[];
  lengthUnit: LengthUnit;
  weightUnit: WeightUnit;
  language: Language;
  onSave: (spec: PackageSpec) => void;
  onClose: () => void;
}

const COLOR_SWATCHES = DISTINCT_COLOR_PALETTE.slice(0, 12);

export const PackageFormModal: React.FC<PackageFormModalProps> = ({
  initial,
  usedColors = [],
  lengthUnit,
  weightUnit,
  language,
  onSave,
  onClose,
}) => {
  const [name, setName] = useState(
    language === 'ar' && initial?.nameAr ? initial.nameAr : initial?.name ?? ''
  );
  const [sku, setSku] = useState(initial?.sku ?? `PKG-${Math.floor(100 + Math.random() * 900)}`);
  const [lengthVal, setLengthVal] = useState(
    initial ? String(fromMm(initial.length, lengthUnit)) : String(fromMm(600, lengthUnit))
  );
  const [widthVal, setWidthVal] = useState(
    initial ? String(fromMm(initial.width, lengthUnit)) : String(fromMm(400, lengthUnit))
  );
  const [heightVal, setHeightVal] = useState(
    initial ? String(fromMm(initial.height, lengthUnit)) : String(fromMm(400, lengthUnit))
  );
  const [weightVal, setWeightVal] = useState(
    initial ? String(fromKg(initial.weight, weightUnit)) : String(fromKg(20, weightUnit))
  );
  const [quantity, setQuantity] = useState(String(initial?.quantity ?? 10));
  const [color, setColor] = useState(
    () => initial?.color ?? getNextDistinctColor(usedColors)
  );
  const [category, setCategory] = useState(
    language === 'ar' && initial?.categoryAr
      ? initial.categoryAr
      : initial?.category ?? (language === 'ar' ? 'عام' : 'General')
  );
  const [stackable, setStackable] = useState(initial?.stackable ?? true);
  const [rotatable, setRotatable] = useState(initial?.rotatable ?? true);
  const [fragile, setFragile] = useState(initial?.fragile ?? false);
  const [thisSideUp, setThisSideUp] = useState(initial?.thisSideUp ?? false);
  const [maxStackWeight, setMaxStackWeight] = useState(String(initial?.maxStackWeight ?? 0));
  const [maxStackLayers, setMaxStackLayers] = useState(String(initial?.maxStackLayers ?? 0));
  const [allowX, setAllowX] = useState(initial?.allowedAxes.x ?? true);
  const [allowY, setAllowY] = useState(initial?.allowedAxes.y ?? true);
  const [allowZ, setAllowZ] = useState(initial?.allowedAxes.z ?? true);
  const [priority, setPriority] = useState(String(initial?.priority ?? 5));
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const lMm = toMm(Number(lengthVal), lengthUnit);
    const wMm = toMm(Number(widthVal), lengthUnit);
    const hMm = toMm(Number(heightVal), lengthUnit);
    const wKg = toKg(Number(weightVal), weightUnit);
    const qty = Math.floor(Number(quantity));
    const prio = Math.min(10, Math.max(1, Math.floor(Number(priority) || 5)));

    if (!name.trim()) {
      setError(t(language, 'errNameReq'));
      return;
    }
    if (!sku.trim()) {
      setError(t(language, 'errSkuReq'));
      return;
    }
    if (lMm <= 0 || wMm <= 0 || hMm <= 0) {
      setError(t(language, 'errDimsPos'));
      return;
    }
    if (wKg <= 0) {
      setError(t(language, 'errWeightPos'));
      return;
    }
    if (qty <= 0) {
      setError(t(language, 'errQtyPos'));
      return;
    }

    const trimmedName = name.trim();
    const trimmedCategory = category.trim() || (language === 'ar' ? 'عام' : 'General');

    onSave({
      id: initial?.id ?? `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: language === 'ar' && initial?.name ? initial.name : trimmedName,
      nameAr: language === 'ar' ? trimmedName : initial?.nameAr,
      sku: sku.trim(),
      length: lMm,
      width: wMm,
      height: hMm,
      weight: wKg,
      quantity: qty,
      color,
      category: language === 'ar' && initial?.category ? initial.category : trimmedCategory,
      categoryAr: language === 'ar' ? trimmedCategory : initial?.categoryAr,
      stackable,
      rotatable,
      fragile,
      thisSideUp,
      maxStackWeight: Math.max(0, Number(maxStackWeight) || 0),
      maxStackLayers: Math.max(0, Math.floor(Number(maxStackLayers) || 0)),
      allowedAxes: {
        x: thisSideUp ? false : allowX,
        y: allowY,
        z: thisSideUp ? false : allowZ,
      },
      priority: prio,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2.5 sm:p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-xl bg-white border border-zinc-200 shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-3.5 bg-red-600 text-white">
          <h3 className="text-sm font-semibold">
            {initial ? `${t(language, 'edit')} · ${initial.sku}` : t(language, 'addPackage')}
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-red-100 hover:text-white hover:bg-red-700 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 sm:p-5 space-y-4 max-h-[85dvh] overflow-y-auto">
          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs font-medium text-red-700">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'productName')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={language === 'ar' ? 'مثال: صندوق صمام تصدير' : 'e.g. Export Valve Crate'}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:border-red-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'sku')}
              </label>
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-mono focus:outline-none focus:border-red-600"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'length')} ({lengthUnit})
              </label>
              <input
                type="number"
                step="any"
                min="0.01"
                value={lengthVal}
                onChange={(e) => setLengthVal(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-2.5 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-red-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'width')} ({lengthUnit})
              </label>
              <input
                type="number"
                step="any"
                min="0.01"
                value={widthVal}
                onChange={(e) => setWidthVal(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-2.5 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-red-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'height')} ({lengthUnit})
              </label>
              <input
                type="number"
                step="any"
                min="0.01"
                value={heightVal}
                onChange={(e) => setHeightVal(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-2.5 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-red-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'weight')} ({weightUnit})
              </label>
              <input
                type="number"
                step="any"
                min="0.01"
                value={weightVal}
                onChange={(e) => setWeightVal(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-2.5 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-red-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'quantity')}
              </label>
              <input
                type="number"
                min="1"
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-2.5 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-red-600"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'category')}
              </label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:border-red-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'priority')} (1–10)
              </label>
              <input
                type="number"
                min="1"
                max="10"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-red-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'color')}
              </label>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {COLOR_SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    style={{ backgroundColor: c }}
                    className={`w-6 h-6 rounded-md border-2 cursor-pointer ${
                      color === c ? 'border-zinc-900 scale-110' : 'border-transparent'
                    }`}
                  />
                ))}
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-7 h-7 rounded cursor-pointer border border-zinc-300"
                />
              </div>
            </div>
          </div>

          {/* Physical Rules */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-zinc-100">
            <label className="flex items-center gap-2 text-xs font-medium text-zinc-800 cursor-pointer p-2 rounded-md border border-zinc-200 hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={stackable}
                onChange={(e) => setStackable(e.target.checked)}
                className="accent-red-600 w-4 h-4"
              />
              <span>{t(language, 'stackable')}</span>
            </label>
            <label className="flex items-center gap-2 text-xs font-medium text-zinc-800 cursor-pointer p-2 rounded-md border border-zinc-200 hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={rotatable}
                onChange={(e) => setRotatable(e.target.checked)}
                className="accent-red-600 w-4 h-4"
              />
              <span>{t(language, 'rotatable')}</span>
            </label>
            <label className="flex items-center gap-2 text-xs font-medium text-zinc-800 cursor-pointer p-2 rounded-md border border-zinc-200 hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={fragile}
                onChange={(e) => setFragile(e.target.checked)}
                className="accent-red-600 w-4 h-4"
              />
              <span>{t(language, 'fragile')}</span>
            </label>
            <label className="flex items-center gap-2 text-xs font-medium text-zinc-800 cursor-pointer p-2 rounded-md border border-zinc-200 hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={thisSideUp}
                onChange={(e) => setThisSideUp(e.target.checked)}
                className="accent-red-600 w-4 h-4"
              />
              <span>{t(language, 'thisSideUp')}</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'maxStackWeight')} {t(language, 'unlimitedHint')}
              </label>
              <input
                type="number"
                min="0"
                step="any"
                disabled={!stackable}
                value={maxStackWeight}
                onChange={(e) => setMaxStackWeight(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-mono disabled:bg-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'maxStackLayers')} {t(language, 'unlimitedHint')}
              </label>
              <input
                type="number"
                min="0"
                step="1"
                disabled={!stackable}
                value={maxStackLayers}
                onChange={(e) => setMaxStackLayers(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-mono disabled:bg-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                {t(language, 'allowedAxes')}
              </label>
              <div className="flex items-center gap-3 pt-2">
                <label className="inline-flex items-center gap-1 text-xs font-mono">
                  <input
                    type="checkbox"
                    disabled={!rotatable || thisSideUp}
                    checked={!thisSideUp && allowX}
                    onChange={(e) => setAllowX(e.target.checked)}
                    className="accent-red-600"
                  />
                  X
                </label>
                <label className="inline-flex items-center gap-1 text-xs font-mono">
                  <input
                    type="checkbox"
                    disabled={!rotatable}
                    checked={allowY}
                    onChange={(e) => setAllowY(e.target.checked)}
                    className="accent-red-600"
                  />
                  Y
                </label>
                <label className="inline-flex items-center gap-1 text-xs font-mono">
                  <input
                    type="checkbox"
                    disabled={!rotatable || thisSideUp}
                    checked={!thisSideUp && allowZ}
                    onChange={(e) => setAllowZ(e.target.checked)}
                    className="accent-red-600"
                  />
                  Z
                </label>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-200">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 cursor-pointer"
            >
              {t(language, 'cancel')}
            </button>
            <button
              type="submit"
              className="rounded-lg bg-red-600 px-5 py-2 text-xs font-semibold text-white hover:bg-red-700 cursor-pointer"
            >
              {t(language, 'save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
