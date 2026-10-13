import { Card } from '../../../components/ui/card';

export function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-3" aria-label={label}>
      <h2 className="text-xs font-medium uppercase text-fg-muted">{label}</h2>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-fg" data-testid={`kpi-${label}`}>
        {value}
      </p>
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </Card>
  );
}
