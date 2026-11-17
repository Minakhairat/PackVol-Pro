import { LengthUnit, WeightUnit } from '../types/packvol';

const MM_PER_UNIT: Record<LengthUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
};

const KG_PER_UNIT: Record<WeightUnit, number> = {
  kg: 1,
  lb: 0.45359237,
};

export function fromMm(mm: number, unit: LengthUnit): number {
  const val = mm / MM_PER_UNIT[unit];
  if (unit === 'mm') return Math.round(val * 10) / 10;
  if (unit === 'cm') return Math.round(val * 100) / 100;
  if (unit === 'in') return Math.round(val * 100) / 100;
  return Math.round(val * 1000) / 1000;
}

export function toMm(value: number, unit: LengthUnit): number {
  return Math.round(value * MM_PER_UNIT[unit] * 100) / 100;
}

export function formatLength(mm: number, unit: LengthUnit, includeUnit = true): string {
  const val = fromMm(mm, unit);
  const formatted =
    unit === 'm'
      ? val.toFixed(2)
      : unit === 'mm'
        ? Math.round(val).toString()
        : Number(val.toFixed(1)).toString();
  return includeUnit ? `${formatted} ${unit}` : formatted;
}

export function formatDims(
  lMm: number,
  wMm: number,
  hMm: number,
  unit: LengthUnit
): string {
  return `${formatLength(lMm, unit, false)} × ${formatLength(wMm, unit, false)} × ${formatLength(hMm, unit, false)} ${unit}`;
}

export function mm3ToM3(mm3: number): number {
  return mm3 / 1_000_000_000;
}

export function formatVolume(mm3: number, unit: LengthUnit): string {
  const m3 = mm3ToM3(mm3);
  if (unit === 'in') {
    const ft3 = m3 * 35.3146667;
    return `${ft3.toFixed(2)} ft³`;
  }
  return `${m3.toFixed(2)} m³`;
}

export function fromKg(kg: number, unit: WeightUnit): number {
  const val = kg / KG_PER_UNIT[unit];
  return Math.round(val * 100) / 100;
}

export function toKg(value: number, unit: WeightUnit): number {
  return Math.round(value * KG_PER_UNIT[unit] * 1000) / 1000;
}

export function formatWeight(kg: number, unit: WeightUnit): string {
  const val = fromKg(kg, unit);
  return `${val.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}
