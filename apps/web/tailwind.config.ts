import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';
import { colors, cssVariables, fontFamily, fontSize, radius, spacing } from './src/styles/tokens';

/**
 * Maps the design tokens (src/styles/tokens.ts) onto Tailwind. Colors resolve through CSS
 * variables defined per theme below, so `dark` only swaps variable values.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      ...Object.fromEntries(
        Object.keys(colors.light).map((name) => [
          name,
          `rgb(var(--color-${name}) / <alpha-value>)`,
        ]),
      ),
    },
    spacing,
    fontSize: Object.fromEntries(
      Object.entries(fontSize).map(([k, [size, lineHeight]]) => [k, [size, { lineHeight }]]),
    ),
    borderRadius: radius,
    fontFamily: Object.fromEntries(Object.entries(fontFamily).map(([k, v]) => [k, [...v]])),
  },
  plugins: [
    plugin((api) => {
      api.addBase({ ':root': cssVariables('light'), '.dark': cssVariables('dark') });
    }),
  ],
};

export default config;
