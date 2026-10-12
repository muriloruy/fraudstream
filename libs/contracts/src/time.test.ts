import { describe, expect, it } from 'vitest';
import { localHour, timeZoneOf } from './time.js';

describe('localHour', () => {
  it('converts UTC instants to the merchant country hour', () => {
    expect(localHour('BR', '2026-10-12T05:30:00.000Z')).toBe(2); // UTC-3
    expect(localHour('PT', '2026-10-12T05:30:00.000Z')).toBe(6); // UTC+1 in October
    expect(localHour('JP', '2026-10-12T20:00:00.000Z')).toBe(5);
  });

  it('falls back to UTC for countries without a mapping', () => {
    expect(timeZoneOf('KE')).toBe('UTC');
    expect(localHour('KE', '2026-10-12T23:59:00.000Z')).toBe(23);
  });
});
