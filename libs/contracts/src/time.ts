import type { CountryCode } from './primitives.js';

/**
 * Representative IANA time zone per country, used to reason about the merchant's local time
 * (night-time rules, hour-of-day profiles). Countries spanning several zones use their most
 * populous one; unknown countries fall back to UTC. A documented approximation (SPEC §6.4).
 */
const TIME_ZONES: Partial<Record<CountryCode, string>> = {
  BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',
  CO: 'America/Bogota',
  MX: 'America/Mexico_City',
  PE: 'America/Lima',
  UY: 'America/Montevideo',
  US: 'America/New_York',
  CA: 'America/Toronto',
  PT: 'Europe/Lisbon',
  ES: 'Europe/Madrid',
  FR: 'Europe/Paris',
  DE: 'Europe/Berlin',
  IT: 'Europe/Rome',
  GB: 'Europe/London',
  NL: 'Europe/Amsterdam',
  CH: 'Europe/Zurich',
  JP: 'Asia/Tokyo',
  CN: 'Asia/Shanghai',
  IN: 'Asia/Kolkata',
  AU: 'Australia/Sydney',
};

export function timeZoneOf(country: string): string {
  return TIME_ZONES[country as CountryCode] ?? 'UTC';
}

/** Hour of day (0-23) at `instant` in the country's representative time zone. */
export function localHour(country: string, instant: Date | string): number {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZoneOf(country),
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return Number(hour);
}
