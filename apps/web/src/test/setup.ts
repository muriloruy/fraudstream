import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

/** Browser APIs used by Radix and the layout that jsdom does not implement. */
const noop = () => undefined;
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => false,
    }),
  });
}
if (typeof window.ResizeObserver !== 'function') {
  Object.defineProperty(window, 'ResizeObserver', {
    value: class {
      observe = noop;
      unobserve = noop;
      disconnect = noop;
    },
  });
}
for (const [name, impl] of [
  ['scrollIntoView', noop],
  ['hasPointerCapture', () => false],
  ['releasePointerCapture', noop],
] as const) {
  if (!(name in Element.prototype)) Object.defineProperty(Element.prototype, name, { value: impl });
}
