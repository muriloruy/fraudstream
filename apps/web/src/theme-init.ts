// Runs before the app renders, as an external module (no inline script, CSP), so the first
// paint already has the right theme.
import { applyTheme, preferredTheme } from './lib/theme';

applyTheme(preferredTheme(), false);
