import type { SummaryGroup } from "@starter/shared";

/**
 * Series colours come from the theme tokens rather than literals, so the
 * charts follow the light/dark switch without a re-render. Recharts writes
 * these straight into SVG `fill`, where `var()` resolves normally.
 */
export const CHART_COLORS: string[] = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

/**
 * How far each group sharing a colour is pushed from it, in order of the
 * groups' size: the biggest keeps the colour itself, the next is tinted
 * towards white, the one after shaded towards black, and so on outwards.
 * Alternating sides keeps neighbouring rows the furthest apart.
 */
const SHADE_STEPS: readonly number[] = [0, 0.3, -0.3, 0.55, -0.5, 0.72, -0.65];

const HEX_COLOR = /^#([0-9a-f]{6})$/i;

const channel = (value: number): string =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");

/**
 * Mix a `#rrggbb` colour towards white (`amount` > 0) or black (`amount` < 0),
 * where ±1 is the full way. Anything that is not a six-digit hex is returned
 * as it came, so a theme token is never mangled.
 */
export const shadeHex = (color: string, amount: number): string => {
  const match = HEX_COLOR.exec(color);
  if (match === null || amount === 0) return color;
  const hex = match[1];
  const target = amount > 0 ? 255 : 0;
  const weight = Math.min(1, Math.abs(amount));
  const mixed = [0, 2, 4].map((offset) => {
    const base = Number.parseInt(hex.slice(offset, offset + 2), 16);
    return channel(base + (target - base) * weight);
  });
  return `#${mixed.join("")}`;
};

/**
 * One colour per group key.
 *
 * A group wears its own catalogue colour, and a group without one takes a
 * palette slot by position, as before. New here: groups that share a colour
 * — every task of one project inherits that project's colour, and two
 * projects may simply have picked the same one — are told apart by shade,
 * so a donut of five tasks under one client is five rings of one hue rather
 * than one indistinguishable block. The biggest group keeps the plain
 * colour, so the legend still matches the catalogue swatch somewhere.
 *
 * Computed over the whole list, so the table and the chart, which are
 * handed the same groups, agree on every colour whatever each one shows.
 */
export const groupColorMap = (
  groups: readonly SummaryGroup[],
): Map<string, string> => {
  const sharing = new Map<string, number>();
  for (const group of groups) {
    if (group.color === null) continue;
    const key = group.color.toLowerCase();
    sharing.set(key, (sharing.get(key) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const colors = new Map<string, string>();
  groups.forEach((group, index) => {
    if (group.color === null) {
      colors.set(group.key, CHART_COLORS[index % CHART_COLORS.length]);
      return;
    }
    const key = group.color.toLowerCase();
    if ((sharing.get(key) ?? 0) < 2) {
      colors.set(group.key, group.color);
      return;
    }
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const step = SHADE_STEPS[occurrence % SHADE_STEPS.length];
    colors.set(group.key, shadeHex(group.color, step));
  });
  return colors;
};
