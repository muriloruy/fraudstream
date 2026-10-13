/**
 * `pnpm --filter @fraudstream/web lighthouse` — Lighthouse performance of the Alert Queue
 * (SPEC §8.3: ≥ 90) against the running stack, logged in as the demo analyst.
 *
 * Playwright logs in through the real UI in a persistent profile; Lighthouse then audits
 * /alerts in that same browser over the DevTools port, keeping the session cookie
 * (disableStorageReset). Desktop preset: the console is a desktop tool. Writes
 * apps/web/lighthouse/alerts.report.html and exits 1 below the threshold.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import { env } from './stack';

const BASE = process.env.WEB_URL ?? 'http://localhost:8081';
const PORT = Number(process.env.LIGHTHOUSE_PORT ?? 9333);
const MIN_SCORE = Number(process.env.LIGHTHOUSE_MIN_PERFORMANCE ?? 0.9);
const outDir = fileURLToPath(new URL('../lighthouse/', import.meta.url));

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'lh-')), {
  headless: true,
  args: [`--remote-debugging-port=${String(PORT)}`],
  ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
});
try {
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill('analyst@demo.local');
  await page.getByLabel('Password').fill(env('DEMO_ANALYST_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);

  const result = await lighthouse(
    `${BASE}/alerts`,
    {
      port: PORT,
      output: 'html',
      onlyCategories: ['performance'],
      disableStorageReset: true,
      logLevel: 'error',
    },
    desktopConfig,
  );
  if (!result) throw new Error('Lighthouse returned no result');
  // Guard against measuring the login page after a silent redirect.
  if (new URL(result.lhr.finalDisplayedUrl).pathname !== '/alerts') {
    throw new Error(`audited ${result.lhr.finalDisplayedUrl} instead of /alerts (not logged in?)`);
  }
  const score = result.lhr.categories.performance?.score ?? 0;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'alerts.report.html'), String(result.report));
  const audits = result.lhr.audits;
  console.log(
    `Lighthouse performance on /alerts: ${String(Math.round(score * 100))} ` +
      `(LCP ${audits['largest-contentful-paint']?.displayValue ?? '?'}, ` +
      `TBT ${audits['total-blocking-time']?.displayValue ?? '?'}, ` +
      `CLS ${audits['cumulative-layout-shift']?.displayValue ?? '?'})`,
  );
  if (score < MIN_SCORE) {
    console.error(`below the ${String(MIN_SCORE * 100)} threshold`);
    process.exitCode = 1;
  }
} finally {
  await context.close();
}
