/**
 * OpenModal — the "Scan a project" folder picker.
 *
 * Regression: the local "Choose folder" affordance was a `<label for=…>`
 * with no click handler, relying on label→input association that the
 * remix/ui VDOM didn't wire up — clicking it opened nothing. Replaced with
 * a real <button> → chooseFolder() dispatcher that prefers File System
 * Access (returns a handle → Recents + save-back) and falls back to a
 * hidden <input webkitdirectory> when FSA is missing or blocked (embedded
 * webviews that advertise support but never open a picker).
 *
 * These tests prove the picker actually OPENS. Playwright surfaces a
 * `filechooser` event whenever an <input type=file> is activated — the
 * load-bearing proof that the click reached a working picker. We force both
 * fallback scenarios deterministically via addInitScript so the test
 * doesn't depend on headless Chromium's (unstable) FSA behavior.
 */
import { expect, test, waitForReady } from './fixtures.js';

/** Open the modal via its documented public trigger (the header Open button
 *  dispatches this same event). Avoids coupling to header layout. */
async function openModal(page: import('@playwright/test').Page) {
  await page.goto('/');
  await waitForReady(page);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('factstack:open', { detail: { mode: 'local' } })),
  );
  /* Readiness = the Local-mode "Choose folder" button is on screen. Using
     the button (not the "Scan a project" heading text, which also appears
     in the page's empty-state CTA → strict-mode collision) keeps this
     unambiguous and is the element every test below needs anyway. */
  await expect(page.getByRole('button', { name: /choose folder/i })).toBeVisible();
}

test.describe('OpenModal — Choose folder', () => {
  test('renders a real, enabled button (not a dead label)', async ({ page }) => {
    await openModal(page);
    const btn = page.getByRole('button', { name: /choose folder/i });
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test('opens the file chooser when File System Access is unavailable', async ({ page }) => {
    /* Simulate a browser with no FSA at all → chooseFolder() routes
       straight to the hidden <input webkitdirectory>. */
    await page.addInitScript(() => {
      try { delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker; } catch { /* noop */ }
    });
    await openModal(page);
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 });
    await page.getByRole('button', { name: /choose folder/i }).click();
    const chooser = await chooserPromise; // throws if the picker never opened
    expect(chooser).toBeTruthy();
  });

  test('falls back to the file chooser when FSA throws (embedded webview)', async ({ page }) => {
    /* Simulate the reported failure: showDirectoryPicker exists (env shows
       it green) but rejects with a non-Abort error. chooseFolder → FSA →
       catch → fsaFailed=true → input.click() → filechooser fires. */
    await page.addInitScript(() => {
      (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = () =>
        Promise.reject(Object.assign(new Error('blocked'), { name: 'SecurityError' }));
    });
    await openModal(page);
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 });
    await page.getByRole('button', { name: /choose folder/i }).click();
    const chooser = await chooserPromise;
    expect(chooser).toBeTruthy();
  });

  test('user Cancel (AbortError) returns to idle without an error banner', async ({ page }) => {
    /* AbortError = the user clicked Cancel in the native dialog. Must NOT
       surface as an error, and must NOT fall through to the file input. */
    await page.addInitScript(() => {
      (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = () =>
        Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' }));
    });
    await openModal(page);
    await page.getByRole('button', { name: /choose folder/i }).click();
    // No error banner appears (role=alert is how OpenModal renders errors).
    await expect(page.getByRole('alert')).toHaveCount(0);
    // The button is still there, ready for another attempt.
    await expect(page.getByRole('button', { name: /choose folder/i })).toBeEnabled();
  });
});
