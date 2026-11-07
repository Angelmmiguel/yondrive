/**
 * The backup and restore drill, through the app: a server with a file, a note
 * and a share, `yondrive backup` while it serves, `yondrive restore` into a new
 * directory (and not over one that has something in it), and a second server on
 * the restored directory where everyone finds everything again. In end-to-end
 * mode the restored directory holds none of the canaries; without encryption
 * it holds the very file. cmd/yondrive/drill_test.go covers versions, links and
 * tokens at the API.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, expectDriveReady, fileBox, newFolder, openDrive, row, upload } from '../drive';
import { ADMIN, PASSPHRASE, signIn } from '../flows';
import { card, openNotes } from '../notes';
import { scanDir } from '../scan';
import { runYondrive, startServer, type Mode, type Server } from '../server';
import { addUser, openShared, shareDialog, shareWith } from '../sharing';

/** Every file under a data directory's blobs/. */
async function storedFiles(dataDir: string): Promise<Buffer[]> {
	const out: Buffer[] = [];
	for (const entry of await readdir(join(dataDir, 'blobs'), {
		recursive: true,
		withFileTypes: true
	})) {
		if (entry.isFile()) out.push(await readFile(join(entry.parentPath, entry.name)));
	}
	return out;
}

/** Signs in on a server in a browser of its own. */
async function signedIn(browser: Browser, server: Server, username: string): Promise<Page> {
	const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
	await page.goto(server.url);
	await signIn(page, username, PASSPHRASE);
	await expectDriveReady(page);
	return page;
}

for (const mode of ['e2e', 'none'] as Mode[]) {
	test(`a backup taken while serving restores everything in mode ${mode}`, async ({ browser }) => {
		test.setTimeout(240_000);
		const box = await fileBox();
		const work = await mkdtemp(join(tmpdir(), 'yondrive-e2e-drill-'));
		const servers: Server[] = [];
		try {
			const source = await startServer({ mode });
			servers.push(source);
			const admin = await (await browser.newContext({ acceptDownloads: true })).newPage();
			await openDrive(admin, source, mode);

			const canaries = {
				'file name': `drill-file-Rk52v8-${mode}.txt`,
				'file content': `drill content Jd71q4 ${mode} `,
				folder: `drill-folder-Ux39m6-${mode}`,
				note: `Drill note Pc84w1 ${mode}`
			};
			const file = await box.add(
				canaries['file name'],
				Buffer.from(canaries['file content'].repeat(100))
			);
			await upload(admin, file);
			await newFolder(admin, canaries.folder);

			await addUser(browser, admin, source, 'bob', mode);
			await shareWith(admin, canaries.folder, 'bob');
			await shareDialog(admin, canaries.folder).getByRole('button', { name: 'Done' }).click();

			await openNotes(admin);
			await admin.getByLabel('Quick note').fill(canaries.note);
			await admin.getByLabel('Quick note').press('Enter');
			await expect(card(admin, canaries.note)).toBeVisible();

			// Backed up while the server runs, then restored into a new directory.
			const backup = join(work, 'backup');
			const restored = join(work, 'restored');
			const backedUp = await runYondrive(['backup', '--data', source.dataDir, backup]);
			expect(backedUp.code, backedUp.stderr).toBe(0);
			const first = await runYondrive(['restore', '--data', restored, backup]);
			expect(first.code, first.stderr).toBe(0);
			const again = await runYondrive(['restore', '--data', restored, backup]);
			expect(again.code).not.toBe(0);
			expect(again.stderr).toContain('not empty');

			if (mode === 'e2e') {
				expect(await scanDir(restored, canaries)).toEqual([]);
			} else {
				expect((await storedFiles(restored)).some((bytes) => bytes.equals(file.bytes))).toBe(true);
			}

			const target = await startServer({ mode, dataDir: restored });
			servers.push(target);
			const admin2 = await signedIn(browser, target, ADMIN);
			expect((await download(admin2, file.name)).equals(file.bytes)).toBe(true);
			await expect(row(admin2, canaries.folder)).toBeVisible();
			await openNotes(admin2);
			await expect(card(admin2, canaries.note)).toBeVisible({ timeout: 30_000 });

			const bob = await signedIn(browser, target, 'bob');
			await openShared(bob);
			await expect(row(bob, canaries.folder)).toBeVisible();
		} finally {
			for (const server of servers) await server.stop();
			await box.remove();
			await rm(work, { recursive: true, force: true });
		}
	});
}
