/**
 * The zero knowledge canary for search and single sign-on. With keys, what is indexed
 * and what is searched for never reach the server in any form, on any request, on disk or
 * in its logs, and neither does what is cached on the device. And an unlock passphrase, or
 * the key derived from it, never goes near a sign-in. Mode `none` is the control: there
 * the same index does hold readable words, which shows that these scans can see them.
 */
import { expect, test, type Page } from '@playwright/test';
import { encodeBase64 } from '../../src/lib/crypto/encoding';
import { deriveRoot, expandRoot, parseKdfParams } from '../../src/lib/crypto/kdf';
import { fileBox, inPage, openDrive, row, act, upload, expectDriveReady } from '../drive';
import { accountMenu, expectHome, expectLocked, runWizard } from '../flows';
import { startProvider, type FakeProvider } from '../oidc-provider';
import { expectFound, expectIndexed, openSearch } from '../search';
import { captureRequests, findIn, scanDir } from '../scan';
import { startServer, type Mode, type Server } from '../server';
import { continueWithProvider, enrol, fillSignInStep, UNLOCK, unlockWith } from '../sso';

const box = await fileBox();

test.afterAll(() => box.remove());

const NAME_WORD = 'canaryname8841';
const TAG_WORD = 'canarytag7752';
const TEXT_WORD = 'canarytext6603';
const TYPED_WORD = 'canarytyped5514';

/** Every request a page sends, its binary bodies decoded as they went. */
function captureAll(page: Page): Buffer[] {
	const sent: Buffer[] = [];
	page.on('request', (request) => {
		sent.push(
			Buffer.concat([
				Buffer.from(`${request.method()} ${request.url()}\n${JSON.stringify(request.headers())}\n`),
				request.postDataBuffer() ?? Buffer.alloc(0)
			])
		);
	});
	return sent;
}

/** All the bytes this origin keeps of its search segments on the device. */
const cachedSegments = (page: Page): Promise<number[][]> =>
	page.evaluate(async () => {
		const out: number[][] = [];
		for (const { name } of await indexedDB.databases()) {
			if (!name?.startsWith('yondrive-search-')) continue;
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			// Opening a database that is gone makes it again, empty: leave that as nothing.
			if (!db.objectStoreNames.contains('segments')) {
				db.close();
				indexedDB.deleteDatabase(name);
				continue;
			}
			const values = await new Promise<Uint8Array[]>((resolve, reject) => {
				const request = db.transaction('segments').objectStore('segments').getAll();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			for (const value of values) out.push([...value]);
			db.close();
		}
		return out;
	});

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe(`what search knows in mode ${mode}`, () => {
		let server: Server;

		test.beforeAll(async () => {
			server = await startServer({ mode });
		});

		test.afterAll(async () => {
			await server.stop();
		});

		test('stays where it should', async ({ page }) => {
			test.setTimeout(180_000);
			const sent = captureAll(page);
			await openDrive(page, server, mode);
			const name = `${NAME_WORD}.txt`;
			await upload(page, await box.add(name, Buffer.from(`hello ${TEXT_WORD} world`)));

			await act(page, name, 'Tags');
			const dialog = page.getByRole('dialog', { name: `Tags of ${name}` });
			await dialog.getByLabel('New tag').fill(TAG_WORD);
			await dialog.getByRole('button', { name: 'Add' }).click();
			await expect(row(page, name)).toContainText(TAG_WORD);
			await dialog.getByRole('button', { name: 'Done' }).click();

			await expectFound(page, NAME_WORD, [name]);
			await expectFound(page, TAG_WORD, [name]);
			await expectFound(page, TEXT_WORD, [name]);
			await openSearch(page, TYPED_WORD);
			await expect(page.getByTestId('search-empty')).toBeVisible();
			await page.keyboard.press('Escape');

			await expectIndexed(page);
			await expect
				.poll(
					async () => {
						const { blobs } = await inPage<{ blobs: unknown[] }>(page, 'GET', '/me/index');
						return blobs.length;
					},
					{ timeout: 30_000 }
				)
				.toBeGreaterThan(0);
			await expect.poll(async () => (await cachedSegments(page)).length).toBeGreaterThan(0);

			const secrets = {
				name: NAME_WORD,
				tag: TAG_WORD,
				text: TEXT_WORD,
				typed: TYPED_WORD
			};
			const requests = Buffer.concat(sent);
			const device = Buffer.concat((await cachedSegments(page)).map((one) => Buffer.from(one)));
			expect(requests.includes('/api/v1/auth/login')).toBe(true);
			expect(server.logs()).toContain('listening');
			expect(findIn(Buffer.from(server.logs()), secrets)).toEqual([]);
			expect(findIn(requests, { typed: TYPED_WORD })).toEqual([]);
			expect(findIn(device, { typed: TYPED_WORD })).toEqual([]);

			if (mode === 'e2e') {
				expect(findIn(requests, secrets)).toEqual([]);
				expect(findIn(device, secrets)).toEqual([]);
				expect(await scanDir(server.dataDir, secrets)).toEqual([]);
			} else {
				// The control. Nothing is sealed here, so the same scans find the words.
				expect(findIn(device, { text: TEXT_WORD })).toEqual(['text']);
				expect(findIn(requests, { text: TEXT_WORD })).toEqual(['text']);
				expect(await scanDir(server.dataDir, { text: TEXT_WORD })).not.toEqual([]);
				expect(await scanDir(server.dataDir, { typed: TYPED_WORD })).toEqual([]);
			}
		});

		test('forgets the device copy on signing out from the unlock screen', async ({ page }) => {
			test.skip(mode === 'none', 'Without encryption there is nothing to lock.');
			test.setTimeout(60_000);
			await page.goto(server.url);
			await page.getByLabel(/^Username/).fill('admin');
			await page.getByLabel(/^Passphrase/).fill('correct horse battery staple');
			await page.getByRole('button', { name: 'Sign in', exact: true }).click();
			await expectDriveReady(page);
			await expect.poll(async () => (await cachedSegments(page)).length).toBeGreaterThan(0);
			await accountMenu(page, 'Lock');
			await expectLocked(page);
			await expect.poll(async () => (await cachedSegments(page)).length).toBeGreaterThan(0);
			await page.getByRole('button', { name: 'Sign out' }).click();
			await expect.poll(async () => (await cachedSegments(page)).length).toBe(0);
		});

		test('forgets the device copy on signing out', async ({ page }) => {
			test.setTimeout(60_000);
			await page.goto(server.url);
			await page.getByLabel(/^Username/).fill('admin');
			await page.getByLabel(/^Passphrase/).fill('correct horse battery staple');
			await page.getByRole('button', { name: 'Sign in', exact: true }).click();
			await expectDriveReady(page);
			await expect.poll(async () => (await cachedSegments(page)).length).toBeGreaterThan(0);
			await accountMenu(page, 'Sign out');
			await expect.poll(async () => (await cachedSegments(page)).length).toBe(0);
		});
	});
}

test.describe('an unlock passphrase', () => {
	let server: Server;
	let provider: FakeProvider;

	test.beforeAll(async () => {
		server = await startServer({ mode: 'e2e' });
		provider = await startProvider({
			sub: 'canary-sub',
			email: 'canary@example.com',
			email_verified: true,
			preferred_username: 'canaryuser'
		});
	});

	test.afterAll(async () => {
		await server.stop();
		await provider.stop();
	});

	test('and its key never go near a sign-in', async ({ browser }) => {
		test.setTimeout(240_000);
		const admin = await (await browser.newContext()).newPage();
		await runWizard(admin, server, { mode: 'e2e', signIn: fillSignInStep(provider) });
		await admin.context().close();

		const page = await (await browser.newContext()).newPage();
		const sent = captureRequests(page);
		await page.goto(`${server.url}/signin`);
		await continueWithProvider(page);
		const words = await enrol(page);
		await expectHome(page);

		await accountMenu(page, 'Lock');
		await expectLocked(page);
		await unlockWith(page);
		await expectHome(page);
		await accountMenu(page, 'Sign out');
		await continueWithProvider(page);
		await unlockWith(page);
		await expectHome(page);

		// What they would be sent as, worked out here from the account's own parameters.
		const account = await inPage<{ kdf: unknown }>(page, 'GET', '/me');
		const authKey = encodeBase64(
			expandRoot(deriveRoot(UNLOCK, parseKdfParams(account.kdf))).authKey
		);

		const all = sent.join('\n');
		expect(all).not.toContain('/auth/login');
		expect(all).not.toContain('/auth/kdf');
		const carrying = sent.filter((one) => one.includes(authKey));
		// Once as what the account will prove itself with, and at no sign-in, unlock or lock.
		expect(carrying.map((one) => one.split('\n')[0].replace(server.url, ''))).toEqual([
			'POST /api/v1/auth/oidc/enrol'
		]);

		const secrets = {
			passphrase: UNLOCK,
			words: words.join(' '),
			'auth key': authKey
		};
		const others = sent.filter((one) => !one.includes('/auth/oidc/enrol'));
		expect(findIn(Buffer.from(others.join('\n')), secrets)).toEqual([]);
		expect(findIn(Buffer.from(all), { passphrase: UNLOCK, words: words.join(' ') })).toEqual([]);
		expect(await scanDir(server.dataDir, secrets)).toEqual([]);
		expect(findIn(Buffer.from(server.logs()), secrets)).toEqual([]);
	});
});
