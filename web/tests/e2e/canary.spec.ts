/**
 * The zero knowledge canary: what a person types or uploads that only the device
 * may know must not reach the server, its database, its data directory or its logs.
 * It covers setup and sign-in, and then files: their names, tags and contents. In
 * mode `none` it checks the other side: the stored file is the file, and the app
 * says that it is not encrypted.
 */
import { expect, test } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { act, download, expectDriveReady, fileBox, newFolder, row, upload } from '../drive';
import { captureRequests, findIn, scanDir } from '../scan';
import { accountMenu, expectLocked, runWizard, signIn, submitUnlock } from '../flows';
import { startServer, type Mode, type Server } from '../server';

const CANARY_PASSPHRASE = 'canary zebra quartz meadow violet 7319';
const CANARY_NAME = 'Canary Displayname Xq7Zp2';
const USERNAME = 'canaryuser';

/** Every file the server keeps under blobs/. */
async function storedFiles(dataDir: string): Promise<Buffer[]> {
	const root = join(dataDir, 'blobs');
	const out: Buffer[] = [];
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) out.push(await readFile(join(entry.parentPath, entry.name)));
	}
	return out;
}

/** The whole phrase, and every two adjacent words in the forms they could be joined. */
function wordSecrets(words: string[]): Record<string, string> {
	const secrets: Record<string, string> = {};
	if (words.length === 0) return secrets;
	secrets.phrase = words.join(' ');
	secrets['phrase without spaces'] = words.join('');
	words.slice(1).forEach((word, i) => {
		secrets[`words ${i + 1}-${i + 2}`] = `${words[i]} ${word}`;
	});
	return secrets;
}

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe(`in mode ${mode}`, () => {
		let server: Server;

		test.beforeAll(async () => {
			server = await startServer({ mode });
		});

		test.afterAll(async () => {
			await server.stop();
		});

		test('the passphrase, the recovery words and the name stay on the device', async ({ page }) => {
			const sent = captureRequests(page);

			const words = await runWizard(page, server, {
				mode,
				username: USERNAME,
				passphrase: CANARY_PASSPHRASE,
				displayName: CANARY_NAME
			});
			await page.getByRole('button', { name: 'Go to sign in' }).click();
			await signIn(page, USERNAME, CANARY_PASSPHRASE);

			if (mode === 'e2e') {
				await accountMenu(page, 'Lock');
				await expectLocked(page);
				await submitUnlock(page, CANARY_PASSPHRASE);
				await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible({
					timeout: 30_000
				});
			}

			const secrets = {
				passphrase: CANARY_PASSPHRASE,
				name: CANARY_NAME,
				...wordSecrets(words)
			};

			// The name was really typed, and is really on the device.
			expect(await page.evaluate(() => localStorage.getItem('yondrive-display-name'))).toBe(
				CANARY_NAME
			);

			// Everything the browser sent. The scan sees what it should: the bodies
			// carry the username and an auth key, and the setup body was captured.
			const requests = sent.join('\n');
			expect(requests).toContain(USERNAME);
			expect(requests).toContain('auth_key');
			expect(requests).toContain('/api/v1/setup/complete');
			expect(findIn(Buffer.from(requests), secrets)).toEqual([]);

			// The data directory, the database and its write-ahead log. It can read
			// them: the username is there, in the clear, as the threat model says.
			expect(await scanDir(server.dataDir, { username: USERNAME })).not.toEqual([]);
			expect(await scanDir(server.dataDir, secrets)).toEqual([]);

			// What the server logged. It did log something, including the setup link.
			expect(server.logs()).toContain('listening');
			expect(findIn(Buffer.from(server.logs()), secrets)).toEqual([]);
		});

		test('file names, tags and contents stay on the device', async ({ page }) => {
			const sent = captureRequests(page);
			const box = await fileBox();
			try {
				await page.goto(server.url);
				await signIn(page, USERNAME, CANARY_PASSPHRASE);
				await expectDriveReady(page);

				const secretName = `canary-file-name-Qz81k3-${mode}.txt`;
				const secretContent = `canary file content Wm29x7 ${mode} `.repeat(50);
				const secretFolder = `canary-folder-Ty40p9-${mode}`;
				const secretTag = `CanaryTagHv73n2${mode}`;

				const file = await box.add(secretName, Buffer.from(secretContent));
				await upload(page, file);
				await newFolder(page, secretFolder);
				await act(page, secretName, 'Tags');
				const dialog = page.getByRole('dialog', { name: `Tags of ${secretName}` });
				await dialog.getByLabel('New tag').fill(secretTag);
				await dialog.getByRole('button', { name: 'Add' }).click();
				await expect(row(page, secretName)).toContainText(secretTag);
				await dialog.getByRole('button', { name: 'Done' }).click();

				// The tag's page: the address must not give the name away either.
				await page.getByRole('link', { name: new RegExp(`^${secretTag}`) }).click();
				await expect(page.getByRole('heading', { name: secretTag })).toBeVisible();

				// Reading it back goes through the same places.
				await page.goto(server.url);
				await expectDriveReady(page);
				expect((await download(page, secretName)).toString()).toBe(secretContent);

				const secrets = {
					'file name': secretName,
					'file content': secretContent.slice(0, 40),
					folder: secretFolder,
					tag: secretTag
				};
				const requests = Buffer.from(sent.join('\n'));
				const logs = Buffer.from(server.logs());
				expect(sent.join('\n')).toContain('/uploads');

				if (mode === 'e2e') {
					expect(findIn(requests, secrets)).toEqual([]);
					expect(await scanDir(server.dataDir, secrets)).toEqual([]);
					expect(findIn(logs, secrets)).toEqual([]);
					await expect(page.getByTestId('not-encrypted')).toHaveCount(0);
				} else {
					// No encryption, and it says so: the stored file is the very file.
					await expect(page.getByTestId('not-encrypted')).toBeVisible();
					const stored = await storedFiles(server.dataDir);
					expect(stored.some((bytes) => bytes.equals(file.bytes))).toBe(true);
					// What is readable on disk still never goes in the logs.
					expect(findIn(logs, secrets)).toEqual([]);
				}
			} finally {
				await box.remove();
			}
		});
	});
}
