import { expect, test } from '@playwright/test';
import { authorize, createApiKey, env } from './stack';

/**
 * SPEC §13.4 / M6: login → an alert appears via SSE → resolve → the status updates.
 * The alert is produced by the real pipeline: a card-testing burst is declined.
 */
test('analyst triages a live alert end to end', async ({ page }) => {
  const apiKey = await createApiKey();
  const account = `acc_web_${Date.now().toString(36)}`;

  await page.goto('/alerts');
  await expect(page).toHaveURL(/\/login$/); // no session yet
  await page.getByLabel('Email').fill('analyst@demo.local');
  await page.getByLabel('Password').fill(env('DEMO_ANALYST_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();

  // Three small amounts within seconds: R006 card testing → DECLINE → alert, pushed via SSE.
  for (const amount of ['1.99', '2.49', '1.00']) await authorize(apiKey, account, amount);
  const row = page.getByTestId('alert-row').filter({ hasText: account });
  await expect(row).toBeVisible({ timeout: 15_000 }); // no reload: it arrived on the stream
  await expect(row).toContainText('DECLINE');

  await row.getByRole('link', { name: /Open alert/ }).click();
  await expect(page.getByRole('heading', { name: `Alert for ${account}` })).toBeVisible();
  await expect(page.getByText('411111******1111')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm fraud' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm fraud' });
  await dialog.getByLabel('Note').fill('Card testing burst: three micro-payments within seconds.');
  await dialog.getByRole('button', { name: 'Confirm fraud' }).click();
  await expect(page.getByTestId('alert-status')).toHaveText('CONFIRMED FRAUD');

  // The resolution is the server's state, not only the optimistic one, and the session survives a reload.
  await page.reload();
  await expect(page.getByTestId('alert-status')).toHaveText('CONFIRMED FRAUD');
  const stored = await page.evaluate(() =>
    [localStorage, sessionStorage]
      .flatMap((s) => Array.from({ length: s.length }, (_, i) => s.getItem(s.key(i) ?? '') ?? ''))
      .join(';'),
  );
  expect(stored).not.toMatch(/eyJ/); // no JWT in web storage
});
