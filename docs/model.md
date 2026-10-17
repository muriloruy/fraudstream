# Anomaly model and detection quality

How the `anomaly-scorer` scores transactions (SPEC §6.5) and how detection quality is measured (SPEC §9). Evaluation tables are added per model version in M7 (`pnpm eval`).

## Model `ewma-1.0`

Per account, exponentially weighted mean and variance with **α = 0.1** (`ANOMALY_ALPHA`) of:

- `ln(amount)`,
- `ln(seconds since the previous transaction)` (at least 1 s),

plus a 24-bucket histogram of the merchant's **local** hour (time zone of the merchant country, `localHour()` in `libs/contracts`).

For each transaction, **against the baseline before it**:

| Feature              | Definition                                                             |
| -------------------- | ---------------------------------------------------------------------- |
| `amountZ`            | `(ln(amount) − mean) / sqrt(var + 1e-6)`                               |
| `interArrivalZ`      | same on `ln(seconds since last)`; 0 for an account's first transaction |
| `hourOfDayDeviation` | `1 − hist[hour] / max(hist)` (0 during cold start)                     |
| `newMerchant`        | first time this account pays this merchant                             |

```
raw          = 0.5·max(0, amountZ) + 0.2·max(0, −interArrivalZ) + 0.2·hourOfDayDeviation + 0.1·newMerchant
anomalyScore = 1 / (1 + e^−(raw − 2))
```

So a purchase about 4σ above the account's usual ticket, on its own, sits at 0.5; unusual timing, a burst of transactions or a new merchant push it higher. Features and score are published rounded to 4 decimals.

The baseline is updated **after** scoring, in the same DB transaction as the inbox entry and the outbox event, under `SELECT ... FOR UPDATE` on the account's row. Keying every topic by `accountId` means one consumer owns an account at a time, so that lock is practically never contended.

## Cold start

With fewer than **10** transactions (`MIN_BASELINE`), the account's own statistics are not trusted: z-scores use population defaults by risk tier (from `accounts.profiles.v1`; MEDIUM until the profile arrives) and the hour deviation is 0. The real `baselineSampleSize` is published, so `decision-engine` gives the anomaly score less weight (0.15 instead of 0.4, SPEC §6.6).

| Tier   | Typical ticket (`e^mean`) | var of ln(amount) | Typical interval | var of ln(interval) |
| ------ | ------------------------- | ----------------- | ---------------- | ------------------- |
| LOW    | 80.00                     | 0.6               | 2 days           | 1.5                 |
| MEDIUM | 150.00                    | 0.8               | 1 day            | 1.5                 |
| HIGH   | 300.00                    | 1.2               | 12 hours         | 2.0                 |

A new account's first transaction becomes its starting mean; variances start from the tier defaults. These values are a starting point, to be tuned with the simulator in M7.

## Analyst feedback

When an analyst confirms fraud (`fraud.analyst-feedback.v1`, `CONFIRMED_FRAUD`), the scorer removes that transaction from the baseline **exactly**: every contribution stores the baseline before it (`anomaly.contributions`, last 50 per account), so the scorer restarts from the state before the fraudulent transaction and re-applies the later ones. EWMA statistics cannot be "subtracted", which is why the prior state is stored.

- `LEGITIMATE` changes nothing: the transaction was already part of the baseline, which is correct.
- Fraud confirmed after more than 50 newer transactions is not reverted (logged); its weight has decayed to `0.9^50 ≈ 0.5%` by then anyway.
- Alternative considered: skip baseline updates while an alert is open. Rejected because the scorer would need alert state, and REVIEW decisions arrive after scoring, so the transaction would already be included.

## Parameters

| Parameter            | Value                 | Where                |
| -------------------- | --------------------- | -------------------- |
| α                    | 0.1                   | `ANOMALY_ALPHA`      |
| ε                    | 1e-6                  | `domain/ewma.ts`     |
| Cold-start threshold | 10 transactions       | `MIN_BASELINE`       |
| Feature weights      | 0.5 / 0.2 / 0.2 / 0.1 | `domain/scoring.ts`  |
| Logistic centre      | raw = 2               | `domain/ewma.ts`     |
| Contributions kept   | 50 per account        | `KEEP_CONTRIBUTIONS` |

## Evaluation

`pnpm eval` joins `simulator_output/ground_truth.csv` (written by `pnpm sim:run`) with `decision.decisions`, read through the read-only `reconciler` role, and appends one table per run below (SPEC §9.1).

- A transaction is **flagged** when the decision is REVIEW or DECLINE.
- **Recall** of a scenario = flagged / decided transactions of that scenario.
- **Precision** of a fraud scenario = its flagged transactions against every flagged normal one, i.e. the precision of a stream where this scenario is the only fraud. The `all fraud` row is the detector's actual precision on the run.
- **FP rate** = flagged / decided normal transactions (target ≤ 3%, SPEC §9.2). The legitimate home purchase that precedes an `impossible_travel` attack is labeled normal.
- Transactions in the ground truth **without a decision yet** are listed separately and left out of the rates, never counted as negatives.
- Each table records the model version, the ruleset version (`rules.yaml`) and the decision `config_version`. Seed (history) decisions are not in the ground truth, so they never count.

The script exits 1 when a SPEC §9.2 target is missed. Use `--no-write` to only print, and `--title` to name the run.
