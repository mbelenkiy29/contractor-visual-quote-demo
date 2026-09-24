import { expect, test } from '@playwright/test';

// A tiny fixed PNG; no live provider, DB, or Clerk session is involved.
const editedPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/redesigns/allowance', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ remaining: 3, limit: 3, resetsAt: '2027-01-01T00:00:00Z', exhaustedReason: null }),
  }));
});

async function reachUpload(page: import('@playwright/test').Page) {
  await page.goto('/widget/benchmark');
  await page.getByTestId('button-start-journey').click();
  await page.getByTestId('button-continue-room').click();
  await expect(page.getByTestId('button-review-photo')).toBeEnabled();
  await page.getByTestId('button-use-sample').click();
}

test('submits the photo and renders the deterministic redesign', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/redesigns', async route => {
    posts++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().postData() ?? '').toContain('benchmark-kitchen-sample.jpg');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ imageBase64: editedPng, mimeType: 'image/png' }) });
  });
  await reachUpload(page);
  await page.getByTestId('button-review-photo').click();
  await expect(page.getByText('A direction to react to.')).toBeVisible();
  await expect(page.locator('.visual-pane.redesign')).toHaveCSS('background-image', `url("data:image/png;base64,${editedPng}")`);
  expect(posts).toBe(1);
  await page.getByTestId('button-request-conversation').click();
  await expect(page.getByText('Where should they pick this up?')).toBeVisible();
});

test('surfaces provider errors and allows another attempt', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/redesigns', route => {
    posts++;
    return route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ error: 'The redesign took too long. Please try again with a smaller photo.' }) });
  });
  await reachUpload(page);
  await page.getByTestId('button-review-photo').click();
  await expect(page.getByRole('alert')).toContainText('The redesign took too long');
  await expect(page.getByTestId('button-review-photo')).toBeEnabled();
  expect(posts).toBe(1);
});