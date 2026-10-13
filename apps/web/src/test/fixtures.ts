import type { AlertDetail, AlertListItem, Summary } from '../lib/types';

let n = 0;
const uuid = () => {
  n++;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
};

export function alertItem(overrides: Partial<AlertListItem> = {}): AlertListItem {
  return {
    alertId: uuid(),
    transactionId: uuid(),
    accountId: 'acc_000123',
    decision: 'REVIEW',
    finalScore: '0.6960',
    reasons: ['R001 velocity_1m'],
    status: 'OPEN',
    assignedTo: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    resolvedAt: null,
    amount: { value: '1250.90', currency: 'BRL' },
    merchantName: 'Loja Exemplo',
    country: 'BR',
    firedRules: ['R001'],
    ...overrides,
  };
}

export function alertDetail(overrides: Partial<AlertDetail> = {}): AlertDetail {
  const { amount: _a, merchantName: _m, country: _c, firedRules: _f, ...base } = alertItem();
  return {
    ...base,
    snapshot: {
      transaction: {
        amount: { value: '1250.90', currency: 'BRL' },
        merchant: {
          id: 'mer_771',
          name: 'Loja Exemplo',
          mcc: '5732',
          country: 'BR',
          city: 'São Paulo',
        },
        maskedPan: '411111******1111',
        deviceIdHash: 'sha256:abc',
        channel: 'ECOMMERCE',
        entryMode: 'CARD_NOT_PRESENT',
        geo: { lat: -23.55, lon: -46.63 },
        requestedAt: new Date().toISOString(),
      },
      decision: {
        decision: 'REVIEW',
        finalScore: 0.696,
        components: { ruleScore: 0.62, anomalyScore: 0.81 },
        reasons: ['R001 velocity_1m'],
        partial: false,
        decidedAt: new Date().toISOString(),
        latencyMs: 184,
        breakdown: {
          firedRules: [{ ruleId: 'R001', name: 'velocity_1m', points: 30 }],
          hardDecline: false,
          anomaly: {
            features: {
              amountZ: 4.2,
              interArrivalZ: -1.1,
              newMerchant: true,
              hourOfDayDeviation: 0.3,
            },
            baselineSampleSize: 42,
            modelVersion: 'ewma-1.0',
          },
          weights: { rules: 0.6, anomaly: 0.4 },
          thresholds: { approveBelow: 0.4, declineFrom: 0.75 },
          configVersion: 'fusion-abc',
        },
      },
    },
    ...overrides,
  };
}

export const summary = (overrides: Partial<Summary> = {}): Summary => ({
  windowSeconds: 60,
  decisions: 120,
  transactionsPerSecond: 2,
  rates: { approve: 0.9, review: 0.08, decline: 0.02 },
  p95LatencyMs: 230,
  ...overrides,
});
