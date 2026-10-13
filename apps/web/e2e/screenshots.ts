/**
 * `pnpm --filter @fraudstream/web screenshots` — implementation screenshots for
 * docs/frontend.md (SPEC §8.1), light and dark, against the running stack with some traffic.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { authorize, createApiKey, env } from './stack';

const BASE = process.env.WEB_URL ?? 'http://localhost:8081';
const outDir = fileURLToPath(new URL('../../../docs/frontend/', import.meta.url));
mkdirSync(outDir, { recursive: true });

// Traffic so every screen has content: ordinary purchases and a card-testing burst.
const apiKey = await createApiKey();
const suffix = Date.now().toString(36);
const burst = `acc_demo_${suffix}`;
for (const [account, amount] of [
  [`acc_ok_${suffix}`, '89.90'],
  [`acc_ok_${suffix}`, '120.00'],
  [burst, '1.99'],
  [burst, '2.49'],
  [burst, '1.00'],
] as const) {
  await authorize(apiKey, account, amount);
}
await new Promise((r) => setTimeout(r, 4000));

const browser = await chromium.launch({
  ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
});
try {
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme,
    });
    const page = await context.newPage();
    const shot = async (name: string, p: Page = page) => {
      await p.waitForLoadState('load'); // never 'networkidle': the SSE stream stays open
      await p.waitForTimeout(500);
      await p.screenshot({ path: `${outDir}${name}-${theme}.png` });
    };
    await page.goto(`${BASE}/login`);
    await shot('login');
    await page.getByLabel('Email').fill('analyst@demo.local');
    await page.getByLabel('Password').fill(env('DEMO_ANALYST_PASSWORD'));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`${BASE}/`);
    await page.waitForTimeout(6000); // a few metrics.tick for the chart
    await shot('live-monitor');
    await page.goto(`${BASE}/alerts`);
    await page.getByTestId('alert-row').first().waitFor();
    await shot('alert-queue');
    await page
      .getByTestId('alert-row')
      .filter({ hasText: burst })
      .getByRole('link', { name: /Open alert/ })
      .click();
    await page.getByTestId('alert-status').waitFor();
    await shot('alert-detail');
    await page.goto(`${BASE}/accounts/${burst}`);
    await page.getByTestId('timeline-row').first().waitFor();
    await shot('account-timeline');
    await context.close();
  }
  console.log(`screenshots written to ${outDir}`);
} finally {
  await browser.close();
}
