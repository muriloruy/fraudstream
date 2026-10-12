/** In-process retry delays for transient errors (SPEC §4.6): 100 ms, 400 ms, 1.6 s. */
export const IN_PROCESS_DELAYS_MS: readonly number[] = [100, 400, 1600];

/** After this many rounds through the retry topic a message goes to the DLQ (SPEC §4.6). */
export const MAX_RETRY_ROUNDS = 5;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt`, retrying while `shouldRetry(error)` with the given delays. Returns the result
 * or throws the last error.
 */
export async function retryInProcess<T>(
  attempt: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  delaysMs: readonly number[] = IN_PROCESS_DELAYS_MS,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      const delay = delaysMs.at(i);
      if (delay === undefined || !shouldRetry(error)) throw error;
      await sleep(delay);
    }
  }
}

/** Delay before retry round `round` (1-based): base, 2x, 4x, ... */
export function retryRoundDelayMs(round: number, baseMs: number): number {
  return baseMs * 2 ** Math.max(0, round - 1);
}
