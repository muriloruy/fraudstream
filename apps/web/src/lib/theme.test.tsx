import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeToggle } from '../app/theme-toggle';
import { colors, cssVariables, toTokensStudio } from '../styles/tokens';
import { applyTheme, storedTheme } from './theme';

describe('dark mode (class strategy)', () => {
  it('toggles the dark class and remembers the choice', async () => {
    applyTheme('light', false);
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(storedTheme()).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement).not.toHaveClass('dark');
  });
});

describe('design tokens', () => {
  it('produce a CSS variable per color for both themes', () => {
    expect(cssVariables('light')['--color-primary']).toBe(colors.light.primary);
    expect(cssVariables('dark')['--color-primary']).toBe(colors.dark.primary);
    expect(Object.keys(cssVariables('dark'))).toEqual(Object.keys(cssVariables('light')));
  });

  it('export Tokens Studio JSON for the Figma file', () => {
    expect(toTokensStudio().light.primary).toEqual({ value: '#4f46e5', type: 'color' });
  });
});
