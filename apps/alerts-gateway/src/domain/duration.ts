/** Parses `90s`, `15m`, `7d`, `1h` into milliseconds (config values such as JWT_ACCESS_TTL). */
export function parseDurationMs(value: string): number {
  const match = /^(\d{1,6})([smhd])$/.exec(value.trim());
  if (!match?.[1] || !match[2]) throw new Error(`invalid duration "${value}" (use e.g. 15m, 7d)`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 's' | 'm' | 'h' | 'd'
  ];
  return Number(match[1]) * unit;
}
