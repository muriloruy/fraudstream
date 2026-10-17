# simulator

Labeled payment traffic for demos, load and the detection evaluation (SPEC §6.9).

```bash
pnpm sim:seed --accounts 10000                              # profiles + 30 days of history
pnpm sim:run --tps 100 --duration 5m --fraud-rate 0.02      # live traffic over HTTP
pnpm sim:run --tps 50 --duration 2m --scenario card_testing  # one fraud scenario only
```

| Option         | Command   | Default                             |                                                     |
| -------------- | --------- | ----------------------------------- | --------------------------------------------------- |
| `--accounts`   | seed, run | `10000`                             | population size; use the same value in seed and run |
| `--seed`       | seed, run | `42`                                | PRNG seed: same seed and size = same accounts       |
| `--days`       | seed      | `30`                                | history length                                      |
| `--tps`        | run       | `100`                               | target rate; request `i` is sent at `i / tps` s     |
| `--duration`   | run       | `1m`                                | `30s`, `5m`, `1h`                                   |
| `--fraud-rate` | run       | `0.02`                              | share of transactions that are fraud                |
| `--scenario`   | run       | all four fraud scenarios            | inject only one; `normal` = no fraud                |
| `--out`        | run       | `simulator_output/ground_truth.csv` | ground truth, overwritten per run                   |

Environment (from the repository `.env`): `KAFKA_BROKERS` and `HASH_PEPPER` for the seed,
`SIM_API_URL` (default `http://localhost:3000`) and `SIM_API_KEY` for the run. Without
`SIM_API_KEY`, the run registers a fresh key through `DATABASE_URL_PAYMENTS`.

## How it works

- **Population.** `buildWorld(seed, accounts)` derives every account from the seed: home city
  (8 Brazilian cities), risk tier and credit limit, lognormal amount parameters, a daily
  purchase rate, 4-8 favorite local merchants, one device and one card.
- **Cards.** PANs are built only inside published test ranges (`411111`, `401288`, `555555`,
  `510510`) with a valid Luhn check digit. Never real card numbers.
- **History.** The API stamps `requestedAt` itself, so past traffic cannot go through it.
  `sim:seed` publishes `TransactionAuthorizationRequested` events directly, with
  `producer: "simulator-seed"`, in time order per account (keyed by account, so one partition
  keeps that order). fraud-rules and anomaly-scorer build their 30-day baselines from them.
  Wait for consumer lag 0 before `sim:run`.
- **Live run.** The plan is a dense sequence of `tps × duration` transactions. Attacks are
  placed on the slots that match their timing, compressed when the run is shorter than the
  attack, and every other slot is normal traffic. Each request has its own `Idempotency-Key`.
  After each `202`, the transaction id and its label are appended to the ground truth.
- **Scenarios.**
  - `normal`: lognormal amounts, home city, mostly favorite merchants, own device.
  - `card_testing`: one card, 5-10 purchases of R$ 1-4, 5-30 s apart.
  - `account_takeover`: 2-4 purchases of 8-20× the usual amount at new merchants, new device.
  - `impossible_travel`: a normal purchase at home, then a card-present purchase in Lisbon
    30 minutes later (only the Lisbon one is fraud).
  - `merchant_compromise`: 8-20 accounts at one merchant with 4-10× their usual amounts.

The local compose stack raises the API rate limit to 60,000 requests per minute per key
(`RATE_LIMIT_PER_MINUTE`) so the simulator is not throttled. The code default stays 100.
