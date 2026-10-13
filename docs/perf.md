# Performance notes

Measurements and query plans behind the performance-sensitive choices (SPEC §5.8, §11). Load
and chaos results are added in M8.

## Alert queue (`GET /v1/alerts`, SPEC §5.7, M5)

The queue is ordered by `final_score DESC, created_at, alert_id` and paginated with a signed
keyset cursor. It is served by the partial index:

```sql
CREATE INDEX alerts_queue_idx ON alerts.alerts (final_score DESC, created_at, alert_id)
  WHERE status IN ('OPEN','IN_PROGRESS');
```

Measured on the compose stack (PostgreSQL 16) with 200,000 alerts, of which 40% are open,
`LIMIT 50`.

**First page.** An index-only scan of the partial index that stops after 50 rows:

```text
Limit (actual time=0.053..0.409 rows=50 loops=1)
  Buffers: shared hit=53
  ->  Index Only Scan using alerts_queue_idx on alerts (actual time=0.053..0.404 rows=50 loops=1)
        Heap Fetches: 50
Execution Time: 0.433 ms
```

**Page after a cursor at score 0.5.** The sort mixes directions (score descending, the
tie-breakers ascending), so "after the cursor" cannot be a single row comparison. It is spelled
out as an OR, which PostgreSQL can only apply as a filter. On its own, the scan starts at the
top of the index and discards every row before the cursor:

```text
Index Only Scan using alerts_queue_idx on alerts (actual time=23.676..23.704 rows=50 loops=1)
  Filter: ((final_score < 0.5) OR ((final_score = 0.5) AND (ROW(created_at, alert_id) > ROW(...))))
  Rows Removed by Filter: 40077
  Buffers: shared hit=40380
Execution Time: 23.786 ms
```

Adding the redundant bound `final_score <= 0.5` changes this. It is implied by the OR, but unlike
the OR it is an index condition, so the scan starts at the cursor:

```text
Index Only Scan using alerts_queue_idx on alerts (actual time=0.166..0.702 rows=50 loops=1)
  Index Cond: (final_score <= 0.5)
  Filter: ((final_score < 0.5) OR ((final_score = 0.5) AND (ROW(created_at, alert_id) > ROW(...))))
  Rows Removed by Filter: 6
  Buffers: shared hit=60
Execution Time: 0.802 ms
```

The cost of a page is now constant, no longer growing with depth: 0.8 ms instead of 24 ms at
40,000 rows deep. The integration test pages through 250 alerts while new ones are inserted
and checks that no alert is returned twice or skipped.

## Outbox relay polling (M3)

Idle relays used to back off to 2 s per poll. A decision crosses three relays, so the first
event after a quiet spell took up to about 3.7 s end to end. Relays now poll every 100 ms while
idle (ADR-004), and decisions take 170–260 ms on the compose stack.
