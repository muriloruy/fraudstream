import { beforeAll, describe, expect, it } from 'vitest';
import { authorizationBody, authorize, createApiKey, waitForDecision } from './stack.js';

let apiKey: string;

beforeAll(async () => {
  apiKey = await createApiKey();
});

describe('card testing end to end (SPEC §13.4)', () => {
  it('declines the 3rd small transaction of a burst within 3 s of its POST', async () => {
    const account = `acc_e2e_${Date.now().toString(36)}`;
    const first = await authorize(apiKey, authorizationBody(account, '1.99'));
    const second = await authorize(apiKey, authorizationBody(account, '2.49'));
    expect((await waitForDecision(apiKey, first.transactionId)).status).toBe('APPROVED');
    expect((await waitForDecision(apiKey, second.transactionId)).status).toBe('APPROVED');

    const third = await authorize(apiKey, authorizationBody(account, '1.00'));
    const decided = await waitForDecision(apiKey, third.transactionId);
    expect(decided.status).toBe('DECLINED');
    expect(decided.decidedSeenAt - third.postedAt).toBeLessThan(3000);
  });

  it('approves an ordinary purchase', async () => {
    const tx = await authorize(
      apiKey,
      authorizationBody(`acc_e2e_ok_${Date.now().toString(36)}`, '89.90'),
    );
    expect((await waitForDecision(apiKey, tx.transactionId)).status).toBe('APPROVED');
  });
});
