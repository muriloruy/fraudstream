export interface Job {
  name: string;
  intervalMs: number;
  run(): Promise<unknown>;
}

/**
 * Runs jobs on fixed intervals without overlap: the next run is scheduled only after the
 * previous one settles. Failures are reported and the job keeps its schedule.
 */
export class JobRunner {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly jobs: readonly Job[],
    private readonly onError: (job: Job, error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    for (const job of this.jobs) this.schedule(job);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.running]);
  }

  private schedule(job: Job): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      const run = job.run().catch((error: unknown) => {
        this.onError(job, error);
      });
      this.running.add(run);
      void run.finally(() => {
        this.running.delete(run);
        this.schedule(job);
      });
    }, job.intervalMs);
    timer.unref();
    this.timers.set(job.name, timer);
  }
}
