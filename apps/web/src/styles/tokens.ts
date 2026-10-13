/**
 * Design tokens (SPEC §8.1): the single source for colors, spacing and type. They mirror the
 * Figma variables (collection "FraudStream", modes Light and Dark) and are exported for Tokens
 * Studio by `toTokensStudio()`. Tailwind reads them through tailwind.config.ts; colors become
 * CSS variables so dark mode is a class switch, with no runtime style injection (CSP).
 */

/** Semantic colors as RGB triplets, so Tailwind opacity modifiers keep working. */
export const colors = {
  light: {
    bg: '248 250 252', // slate-50
    surface: '255 255 255',
    'surface-muted': '241 245 249',
    border: '226 232 240',
    fg: '15 23 42',
    'fg-muted': '71 85 105',
    primary: '79 70 229', // indigo-600
    'primary-fg': '255 255 255',
    approve: '21 128 61', // green-700
    review: '180 83 9', // amber-700
    decline: '185 28 28', // red-700
    focus: '99 102 241',
    highlight: '254 249 195',
  },
  dark: {
    bg: '2 6 23', // slate-950
    surface: '15 23 42',
    'surface-muted': '30 41 59',
    border: '51 65 85',
    fg: '241 245 249',
    'fg-muted': '148 163 184',
    primary: '129 140 248', // indigo-400
    'primary-fg': '15 23 42',
    approve: '74 222 128',
    review: '251 191 36',
    decline: '248 113 113',
    focus: '165 180 252',
    highlight: '66 32 6',
  },
} as const;

export type ColorToken = keyof (typeof colors)['light'];

/** 4 px grid. */
export const spacing = {
  0: '0px',
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  8: '32px',
  10: '40px',
  12: '48px',
  16: '64px',
} as const;

/** Type scale: [font size, line height]. */
export const fontSize = {
  xs: ['12px', '16px'],
  sm: ['14px', '20px'],
  base: ['16px', '24px'],
  lg: ['18px', '28px'],
  xl: ['20px', '28px'],
  '2xl': ['24px', '32px'],
  '3xl': ['30px', '36px'],
} as const;

export const radius = { sm: '4px', md: '6px', lg: '8px', xl: '12px', full: '9999px' } as const;

export const fontFamily = {
  sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
  mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
} as const;

/** CSS custom properties for one theme: `--color-bg: 248 250 252`, ... */
export function cssVariables(theme: keyof typeof colors): Record<string, string> {
  const palette = theme === 'dark' ? colors.dark : colors.light;
  return Object.fromEntries(Object.entries(palette).map(([name, rgb]) => [`--color-${name}`, rgb]));
}

/** Tokens Studio (Figma) JSON: import with "Load from file" to sync the Figma variables. */
export function toTokensStudio() {
  const toHex = (rgb: string) =>
    `#${rgb
      .split(' ')
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')}`;
  const theme = (palette: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(palette).map(([k, v]) => [k, { value: toHex(v), type: 'color' }]),
    );
  return {
    light: theme(colors.light),
    dark: theme(colors.dark),
    spacing: Object.fromEntries(
      Object.entries(spacing).map(([k, v]) => [k, { value: v, type: 'spacing' }]),
    ),
    fontSizes: Object.fromEntries(
      Object.entries(fontSize).map(([k, [size]]) => [k, { value: size, type: 'fontSizes' }]),
    ),
  };
}
