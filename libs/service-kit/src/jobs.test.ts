import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRunner } from './jobs.js';

describe('JobRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs jobs on their interval, never overlapping, and survives failures', async () => {
    vi.useFakeTimers();
    let runs = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const errors: unknown[] = [];
    const runner = new JobRunner(
      [
        {
          name: 'slow',
          intervalMs: 100,
          run: async () => {
            runs++;
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise((r) => setTimeout(r, 250));
            concurrent--;
            if (runs === 2) throw new Error('boom');
          },
        },
      ],
      (_job, error) => errors.push(error),
    );
    runner.start();
    await vi.advanceTimersByTimeAsync(2000);
    const stopped = runner.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    expect(runs).toBeGreaterThanOrEqual(4);
    expect(maxConcurrent).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
