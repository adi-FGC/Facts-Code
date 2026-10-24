/**
 * Scan sessions for local folders (D-10 / D-11), through the folder-input
 * path: File System Access is removed so the hidden <input webkitdirectory>
 * takes the pick, which Playwright can feed a real directory on disk.
 *
 *   - the "Save and resume" box is off by default, saves nothing while off,
 *     and is remembered once ticked;
 *   - an unchanged folder restores its saved scan;
 *   - an edited file is reported, and the folder is scanned from scratch.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForReady } from './fixtures.js';

const SAVE_BOX = /Save and resume this scan in this browser only/;

function makeRepo(): string {
  const root = join(mkdtempSync(join(tmpdir(), 'factstack-e2e-')), 'proj');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# proj\n');
  writeFileSync(join(root, 'package.json'), '{"name":"proj","version":"1.0.0"}\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'b.ts'), "import { a } from './a';\nexport const b = a + 1;\n");
  return root;
}

async function openLocal(page: Page): Promise<Locator> {
  await page.addInitScript(() => {
    try {
      delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    } catch {
      /* noop */
    }
  });
  await page.goto('/');
  await waitForReady(page);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('factstack:open', { detail: { mode: 'local' } })),
  );
  const dialog = page.getByRole('dialog', { name: 'Open project for analysis' });
  await expect(dialog.getByRole('button', { name: /choose folder/i })).toBeVisible();
  return dialog;
}

async function scanFolder(page: Page, dialog: Locator, root: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: /choose folder/i }).click();
  await (await chooser).setFiles(root);
  await expect(dialog.getByText('Scan complete')).toBeVisible({ timeout: 30_000 });
}

/** Sessions in the scan store, without creating the database when absent
 *  (a bare indexedDB.open would, at a version with no stores). */
const countSessions = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'factstack-scans')) return 0;
    return new Promise<number>((resolve) => {
      const req = indexedDB.open('factstack-scans');
      req.onerror = () => resolve(-1);
      req.onsuccess = () => {
        const db = req.result;
        const c = db.transaction('sessions').objectStore('sessions').count();
        c.onsuccess = () => {
          db.close();
          resolve(c.result);
        };
        c.onerror = () => resolve(-1);
      };
    });
  });

test('a local folder is saved only when asked, restores unchanged, and reports edits', async ({
  page,
}) => {
  const root = makeRepo();
  try {
    // Off by default: a scan stores no session.
    const first = await openLocal(page);
    await expect(first.getByRole('checkbox', { name: SAVE_BOX })).not.toBeChecked();
    await scanFolder(page, first, root);
    expect(await countSessions(page)).toBe(0);

    // Ticked: the scan is saved, and the choice is remembered across reloads.
    const second = await openLocal(page);
    await second.getByRole('checkbox', { name: SAVE_BOX }).check();
    await scanFolder(page, second, root);
    await expect(second.getByText(/Restored from this browser/)).toHaveCount(0);
    expect(await countSessions(page)).toBe(1);

    const third = await openLocal(page);
    await expect(third.getByRole('checkbox', { name: SAVE_BOX })).toBeChecked();
    await scanFolder(page, third, root);
    await expect(
      third.getByText(/Restored from this browser.s saved scan of this folder/),
    ).toBeVisible();

    // An edit: reported, scanned from scratch, and the one session is replaced.
    appendFileSync(join(root, 'src', 'a.ts'), 'export const a2 = 2;\n');
    const fourth = await openLocal(page);
    await scanFolder(page, fourth, root);
    await expect(
      fourth
        .getByRole('status')
        .filter({ hasText: /changed since the scan saved in this browser/ }),
    ).toBeVisible();
    await expect(fourth.getByText(/Restored from this browser/)).toHaveCount(0);
    expect(await countSessions(page)).toBe(1);
  } finally {
    rmSync(dirname(root), { recursive: true, force: true });
  }
});
