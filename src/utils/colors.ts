import { PackageSpec } from '../types/packvol';

export const DISTINCT_COLOR_PALETTE = [
  '#dc2626', // Red
  '#2563eb', // Blue
  '#d97706', // Amber
  '#0d9488', // Teal
  '#ea580c', // Orange
  '#7c3aed', // Violet
  '#059669', // Emerald
  '#475569', // Slate
  '#db2777', // Pink
  '#0284c7', // Sky
  '#65a30d', // Lime
  '#c026d3', // Fuchsia
  '#b45309', // Dark Amber
  '#1d4ed8', // Indigo Blue
  '#be123c', // Rose
  '#047857', // Dark Emerald
  '#4338ca', // Indigo
  '#ca8a04', // Gold
  '#0891b2', // Cyan
  '#9333ea', // Purple
  '#15803d', // Forest Green
  '#e11d48', // Crimson
  '#4f46e5', // Royal Indigo
  '#9a3412', // Rust
];

function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function normalizeColorHex(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  if (/^[0-9a-f]{6}$/.test(trimmed)) return `#${trimmed}`;
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }

  const namedMap: Record<string, string> = {
    red: '#dc2626',
    أحمر: '#dc2626',
    احمر: '#dc2626',
    blue: '#2563eb',
    أزرق: '#2563eb',
    ازرق: '#2563eb',
    green: '#059669',
    أخضر: '#059669',
    اخضر: '#059669',
    yellow: '#ca8a04',
    أصفر: '#ca8a04',
    اصفر: '#ca8a04',
    orange: '#ea580c',
    برتقالي: '#ea580c',
    amber: '#d97706',
    purple: '#7c3aed',
    violet: '#7c3aed',
    بنفسجي: '#7c3aed',
    pink: '#db2777',
    وردي: '#db2777',
    teal: '#0d9488',
    cyan: '#0891b2',
    سماوي: '#0891b2',
    gray: '#475569',
    grey: '#475569',
    slate: '#475569',
    رمادي: '#475569',
    brown: '#9a3412',
    بني: '#9a3412',
    black: '#18181b',
    أسود: '#18181b',
    اسود: '#18181b',
    white: '#e4e4e7',
    أبيض: '#e4e4e7',
    ابيض: '#e4e4e7',
  };

  return namedMap[trimmed] ?? null;
}

export function getNextDistinctColor(usedColors: Iterable<string>): string {
  const used = new Set<string>();
  for (const c of usedColors) {
    if (c) used.add(c.trim().toLowerCase());
  }

  for (const candidate of DISTINCT_COLOR_PALETTE) {
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // Deterministic golden-angle HSL expansion for > 24 distinct SKUs
  for (let i = 0; i < 360; i++) {
    const hue = Math.round((i * 137.508) % 360);
    const sat = i % 2 === 0 ? 74 : 64;
    const light = i % 3 === 0 ? 44 : i % 3 === 1 ? 52 : 38;
    const candidate = hslToHex(hue, sat, light);
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return DISTINCT_COLOR_PALETTE[used.size % DISTINCT_COLOR_PALETTE.length];
}

export function assignDistinctColors(
  specs: PackageSpec[],
  existingColors: Iterable<string> = []
): PackageSpec[] {
  const used = new Set<string>();
  for (const c of existingColors) {
    if (c) used.add(c.trim().toLowerCase());
  }

  return specs.map((spec) => {
    const nextColor = getNextDistinctColor(used);
    used.add(nextColor.toLowerCase());
    return { ...spec, color: nextColor };
  });
}
