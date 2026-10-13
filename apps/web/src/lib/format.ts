const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Amounts arrive as decimal strings; formatting is display-only (never arithmetic). */
export function formatMoney(
  amount: { value: string; currency: string } | null | undefined,
): string {
  if (!amount) return '—';
  if (amount.currency === 'BRL') return brl.format(Number(amount.value));
  return `${amount.value} ${amount.currency}`;
}

export const formatPercent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

export function formatAge(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${String(hours)}h` : `${String(Math.round(hours / 24))}d`;
}

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
