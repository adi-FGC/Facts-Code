/**
 * The token panel's model picker: an editable combobox, not a native
 * <select>. The select's OS-drawn option list followed the system theme, so
 * with the app in dark mode on a light OS it came up white under the app's
 * near-white text. These pin the widget's keyboard contract and that the
 * page's color-scheme follows the chosen theme (for any native control left).
 */
import { expect, test, waitForReady } from './fixtures.js';

const NAME = 'Model to price this project against';

test.describe('model combobox', () => {
  test('types to filter, arrows through matches and Enter chooses one', async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);
    const box = page.getByRole('combobox', { name: NAME });
    await expect(box).toHaveValue('Opus 5.5 — $4/M');

    await box.click();
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    // Opening selects the shown label, so typing replaces it.
    await box.pressSequentially('sol');
    const options = page.getByRole('listbox', { name: 'Models' }).getByRole('option');
    await expect(options).toHaveText([/GPT-6\.1 Sol/, /GPT-6 Sol/]);
    await expect(page.getByRole('status').filter({ hasText: /models?$/ })).toHaveText('2 models');

    await box.press('ArrowDown');
    await expect(box).toHaveAttribute('aria-activedescendant', /gpt-6-sol$/);
    await box.press('Enter');
    await expect(box).toHaveValue('GPT-6 Sol — $2/M');
    await expect(box).toHaveAttribute('aria-expanded', 'false');
    await expect(box).toBeFocused();
    await expect(page.getByText('OpenAI GPT-6 Sol', { exact: true })).toBeVisible();
  });

  test('Escape and a click elsewhere close it and keep the chosen model', async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);
    const box = page.getByRole('combobox', { name: NAME });

    await box.press('ArrowDown');
    await box.pressSequentially('zzz');
    await expect(page.getByText('No model matches “zzz”.')).toBeVisible();
    await box.press('Escape');
    await expect(box).toHaveValue('Opus 5.5 — $4/M');
    await expect(page.getByRole('listbox', { name: 'Models' })).toHaveCount(0);

    await box.press('ArrowDown');
    await expect(page.getByRole('listbox', { name: 'Models' })).toBeVisible();
    await page.locator('main h1').click();
    await expect(page.getByRole('listbox', { name: 'Models' })).toHaveCount(0);
    await expect(box).toHaveValue('Opus 5.5 — $4/M');
  });

  test('a mouse pick works and lists every vendor group', async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);
    const box = page.getByRole('combobox', { name: NAME });
    await page.getByRole('button', { name: 'Show all models' }).click();
    const list = page.getByRole('listbox', { name: 'Models' });
    await expect(list.getByRole('group', { name: 'Anthropic' })).toBeVisible();
    await list.getByRole('option', { name: /Sonnet 5\.5/ }).click();
    await expect(box).toHaveValue('Sonnet 5.5 — $2/M');
  });

  /* After "?" loaded live prices, the box kept the baked rate while
     the rate card and chart beside it showed the live one. */
  test('shows the live rate once live prices are loaded', async ({ page }) => {
    await page.route('https://raw.githubusercontent.com/BerriAI/litellm/**', (r) =>
      r.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        contentType: 'text/plain',
        body: JSON.stringify({
          'claude-opus-5-5': { input_cost_per_token: 0.000005, output_cost_per_token: 0.00002 },
        }),
      }),
    );
    await page.goto('/');
    await waitForReady(page);
    const box = page.getByRole('combobox', { name: NAME });
    await expect(box).toHaveValue('Opus 5.5 — $4/M');

    await page
      .getByRole('button', { name: 'Where these prices come from, and fetch live prices' })
      .click();
    await expect(page.getByText(/^Updated 1 of \d+ models/)).toBeVisible();
    await expect(box).toHaveValue('Opus 5.5 — $5/M');
    await box.click();
    await expect(
      page.getByRole('listbox', { name: 'Models' }).getByRole('option', { name: /Opus 5\.5/ }),
    ).toContainText('$5/M');
  });

  /* The Claude Code /code-review row is measured on Opus 5.5 only.
     Under another model it still showed the Opus token floor and "Read once,
     by one reviewer"; only its price said "not measured". */
  test('a review row measured on another model shows no figure for it', async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);
    const row = page.locator('div').filter({ hasText: /^Claude Code \/code-review/ });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Read once, by one reviewer.');

    const box = page.getByRole('combobox', { name: NAME });
    await box.click();
    await box.pressSequentially('sonnet 5.5');
    await box.press('Enter');
    await expect(box).toHaveValue(/^Sonnet 5\.5 — /);

    await expect(row).toContainText('Not measured on Sonnet 5.5, so no figure is shown for it.');
    await expect(row).not.toContainText('Read once, by one reviewer');
    await expect(row.locator('[title="not measured on Sonnet 5.5"]')).toHaveText(
      '—not measured on Sonnet 5.5',
    );
    await expect(row).not.toContainText('$');
  });

  for (const [os, theme] of [
    ['light', 'dark'],
    ['dark', 'light'],
  ] as const) {
    test(`a chosen ${theme} theme pins color-scheme on a ${os} OS`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: os });
      await page.addInitScript((t) => localStorage.setItem('facts-theme', t), theme);
      await page.goto('/');
      await waitForReady(page);
      expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
      ).toBe(theme);
    });
  }
});
