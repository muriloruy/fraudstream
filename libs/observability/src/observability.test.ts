import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Counter, createLogger, createMetricsRegistry } from './index.js';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, destination };
}

describe('createLogger', () => {
  it('redacts card data and credentials (SPEC §7)', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'test', level: 'debug', destination });
    logger.debug(
      {
        body: { card: { pan: '4111111111111111', cvv: '123' }, accountId: 'acc_1' },
        req: { headers: { authorization: 'Bearer abc', 'x-api-key': 'secret-key' } },
        password: 'hunter2',
      },
      'request',
    );
    const line = lines.join('');
    expect(line).not.toContain('4111111111111111');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('secret-key');
    expect(line).not.toContain('Bearer abc');
    expect(line).toContain('acc_1');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({ service: 'test', level: 'debug', password: '[Redacted]' });
  });
});

describe('createMetricsRegistry', () => {
  it('labels metrics with the service', async () => {
    const registry = createMetricsRegistry('svc', false);
    new Counter({ name: 'things_total', help: 'things', registers: [registry] }).inc();
    expect(await registry.metrics()).toContain('things_total{service="svc"} 1');
  });
});
