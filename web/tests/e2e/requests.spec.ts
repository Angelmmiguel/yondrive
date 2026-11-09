/**
 * File requests: someone with no account sends files into a folder through a link with a
 * password, and the owner's app adopts them when it opens. The canary checks that the
 * names, the sender's words and the contents never reach the server in end-to-end mode,
 * that the password never does in any mode, that neither the password nor the request's
 * public key reaches the logs (the server keeps a copy of that key by design), that a request key
 * other than the one in the address is refused, and that each limit stops an upload
 * with its own code.
 */
import { expect, test, type Page } from '@playwright/test';
import {
	act,
	clickName,
	fileBox,
	newFolder,
	openDrive,
	openFolder,
	reopenDrive,
	row
} from '../drive';
import { captureRequests, findIn, scanDir } from '../scan';
import { startServer, type Mode, type Server } from '../server';
import { makeRequest, shareDialog, stranger } from '../sharing';

const box = await fileBox();

test.afterAll(() => box.remove());

/** Opens a request as a stranger, through its password if it has one. */
async function openRequest(page: Page, url: string, password?: string): Promise<void> {
	await page.goto(url);
	if (password !== undefined) {
		await page.getByLabel(/^Password/).fill(password);
		await page.getByRole('button', { name: 'Open', exact: true }).click();
	}
	await expect(page.getByRole('heading', { name: 'Send files' })).toBeVisible({ timeout: 30_000 });
}

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe(`in mode ${mode}`, () => {
		let server: Server;
		// The owner, signed in once for every test here.
		let alice: Page;

		test.beforeAll(async ({ browser }) => {
			test.setTimeout(120_000);
			server = await startServer({ mode });
			alice = await (await browser.newContext()).newPage();
			await openDrive(alice, server, mode);
		});

		test.afterAll(async () => {
			await alice.context().close();
			await server.stop();
		});

		test('a stranger sends files that only the owner can read, and the owner adopts them', async ({
			browser
		}) => {
			test.setTimeout(240_000);
			const folderName = `canary-request-folder-Qz81k4-${mode}`;
			const fileName = `canary-request-file-Wm63p0-${mode}.txt`;
			const content = `canary request content Hd27v5 ${mode} `.repeat(30);
			const from = `canary sender Tb49c2 ${mode}`;
			const message = `canary message Ky15e8 ${mode}`;
			const password = `canary request password Rn72u3 ${mode}`;

			const sent: string[][] = [captureRequests(alice)];
			await newFolder(alice, folderName);
			const url = await makeRequest(alice, folderName, { password, files: 5 });
			const fragment = new URL(url).hash.slice(1);
			expect(new URL(url).pathname).toMatch(/^\/r\/[0-9a-f]{32}$/);
			// The folder says that it is taking files.
			await expect(row(alice, folderName)).toContainText('Requesting files');
			if (mode === 'none') expect(fragment).toBe('');
			else expect(fragment).not.toBe('');

			const anyone = await stranger(browser);
			sent.push(captureRequests(anyone));
			await openRequest(anyone, url, password);
			// Once read, the key is out of the address and the history.
			const kept = await anyone.evaluate(() => ({
				href: location.href,
				state: JSON.stringify(history.state)
			}));
			expect(new URL(kept.href).hash).toBe('');
			if (fragment !== '') {
				expect(findIn(Buffer.from(kept.href + kept.state), { key: fragment })).toEqual([]);
			}
			await expect(anyone.getByTestId('request-limits')).toContainText('5 more files');

			await anyone.getByLabel('Your name').fill(from);
			await anyone.getByLabel('Message').fill(message);
			const file = await box.add(fileName, Buffer.from(content));
			await anyone.getByTestId('request-input').setInputFiles(file.path);
			await expect(anyone.getByTestId('request-sent')).toBeVisible({ timeout: 60_000 });
			// The confirmation keeps nothing of what was sent on screen.
			await expect(anyone.getByTestId('request-item')).toHaveCount(0);
			expect(await anyone.locator('body').innerText()).not.toContain(fileName);
			await expect(anyone.getByTestId('request-limits')).toContainText('4 more files');

			// The owner opens the app, and the file is adopted into its folder.
			await alice.goto(server.url);
			await reopenDrive(alice);
			await expect(alice.getByText('arrived through one of your file requests')).toBeVisible({
				timeout: 30_000
			});
			await openFolder(alice, folderName);
			await expect(row(alice, fileName)).toBeVisible({ timeout: 30_000 });
			await clickName(alice, fileName);
			await expect(alice.getByTestId('viewer-text')).toContainText('canary request content');
			await alice.getByRole('button', { name: 'Close', exact: true }).click();

			const all = sent.flat().join('\n');
			expect(all).toContain('/public/requests/');
			expect(all).toContain('/unlock');
			expect(all).toMatch(/\/incoming\/[0-9a-f]{32}\/adopt/);
			const requests = Buffer.from(all);
			const logs = Buffer.from(server.logs());
			const secrets = { password };
			// The public key in the address is no secret from the server, which holds a copy to
			// show the sender; it only stays out of the logs.
			const key: Record<string, string> = fragment === '' ? {} : { 'request key': fragment };
			const names = { 'folder name': folderName, 'file name': fileName, from, message };
			const words = { ...names, content: content.slice(0, 40) };

			expect(findIn(requests, secrets)).toEqual([]);
			expect(await scanDir(server.dataDir, secrets)).toEqual([]);
			expect(findIn(logs, { ...secrets, ...key, ...words })).toEqual([]);
			if (mode === 'e2e') {
				expect(findIn(requests, words)).toEqual([]);
				expect(await scanDir(server.dataDir, words)).toEqual([]);
			} else {
				// No encryption, and it says so: readable on disk, as the mode promises.
				expect(await scanDir(server.dataDir, { 'file name': fileName })).not.toEqual([]);
			}

			await anyone.context().close();
		});

		test('each limit stops an upload with its own code', async ({ browser }) => {
			test.setTimeout(120_000);
			await alice.goto(server.url);
			await reopenDrive(alice);
			const folderName = `limits-${mode}`;
			await newFolder(alice, folderName);
			const url = await makeRequest(alice, folderName, {
				maxMb: '0.001',
				files: 3,
				totalMb: '0.0025'
			});
			const id = new URL(url).pathname.split('/')[2];

			// The page refuses what it can tell will not fit, before anything is sent.
			const anyone = await stranger(browser);
			await openRequest(anyone, url);
			const big = await box.add(`big-${mode}.bin`, Buffer.alloc(1001, 1));
			await anyone.getByTestId('request-input').setInputFiles(big.path);
			await expect(anyone.getByText('A file is larger than this request takes.')).toBeVisible();

			// And the server holds each limit on its own, with its stable code.
			const overhead = mode === 'e2e' ? 41 : 0;
			const codes = await anyone.evaluate(
				async ({ id, overhead, mode }) => {
					const base = `/api/v1/public/requests/${id}`;
					const opened = await (await fetch(base)).json();
					const start = async (size: number) => {
						const res = await fetch(`${base}/uploads`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json', 'X-Link-Token': opened.token },
							body: JSON.stringify({
								suite: mode === 'e2e' ? 'xchacha20poly1305-v1' : 'none',
								frame_count: 1,
								frame_size: 1024,
								stored_size: size + overhead
							})
						});
						return res.ok ? String(res.status) : (await res.json()).code;
					};
					return [
						await start(1001),
						await start(1000),
						await start(1000),
						await start(1000),
						await start(400),
						await start(1)
					];
				},
				{ id, overhead, mode }
			);
			expect(codes).toEqual([
				'request_file_too_large',
				'201',
				'201',
				'request_bytes_reached',
				'201',
				'request_files_reached'
			]);
			await anyone.context().close();
		});

		test('the request pane shows a new link once, and nothing in it overflows', async () => {
			test.setTimeout(120_000);
			await alice.goto(server.url);
			await reopenDrive(alice);
			const folderName = `layout-${mode}`;
			await newFolder(alice, folderName);
			await makeRequest(alice, folderName, { files: 2 });
			for (const width of [1280, 390]) {
				await alice.setViewportSize({ width, height: 900 });
				await act(alice, folderName, 'Share');
				const dialog = shareDialog(alice, folderName);
				await dialog.getByRole('tab', { name: 'Request files' }).click();
				await dialog.getByRole('button', { name: 'New request' }).click();
				await dialog.getByRole('button', { name: 'Create request link' }).click();
				const made = dialog.getByTestId('request-url');
				await expect(made).toBeVisible({ timeout: 30_000 });
				// One copy of the new link, the form put away, and every card within the dialog.
				const url = (await made.locator('pre, code').first().innerText()).trim();
				await expect(dialog.getByText(url, { exact: true })).toHaveCount(1);
				await expect(dialog.getByRole('button', { name: 'Create request link' })).toHaveCount(0);
				await expect(dialog.getByTestId('request').first()).toBeVisible();
				const overflowing = await dialog.evaluate((element) =>
					[
						element,
						...element.querySelectorAll('[data-testid="request"], [data-testid="request-url"]')
					]
						.filter((one) => one.scrollWidth > one.clientWidth + 1)
						.map((one) => one.getAttribute('data-testid') ?? one.tagName)
				);
				expect(overflowing).toEqual([]);
				const box = await dialog.boundingBox();
				expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
				await dialog.getByRole('button', { name: 'Done' }).click();
			}
			await alice.setViewportSize({ width: 1280, height: 720 });
		});

		if (mode === 'e2e') {
			test('a request key other than the one in the address is refused', async ({ browser }) => {
				test.setTimeout(120_000);
				await alice.goto(server.url);
				await reopenDrive(alice);
				const folderName = 'tamper';
				await newFolder(alice, folderName);
				const url = await makeRequest(alice, folderName);
				const [address, key] = url.split('#');
				const other = key.startsWith('A') ? `B${key.slice(1)}` : `A${key.slice(1)}`;

				// An address whose key was changed on the way.
				const anyone = await stranger(browser);
				await anyone.goto(`${address}#${other}`);
				await expect(anyone.getByTestId('request-ended')).toHaveAttribute('data-why', 'bad-key');

				// A server that names a key of its own: nothing is sealed to it.
				const swapped = await stranger(browser);
				const uploads: string[] = [];
				swapped.on('request', (request) => {
					if (request.url().includes('/uploads')) uploads.push(request.url());
				});
				await swapped.route('**/api/v1/public/requests/*', async (route) => {
					const response = await route.fetch();
					const body = await response.json();
					body.public_key = Buffer.alloc(32, 9).toString('base64');
					await route.fulfill({ response, json: body });
				});
				await swapped.goto(url);
				await expect(swapped.getByTestId('request-ended')).toHaveAttribute('data-why', 'bad-key');
				expect(uploads).toEqual([]);

				// And an address with no key at all.
				const keyless = await stranger(browser);
				await keyless.goto(address);
				await expect(keyless.getByTestId('request-ended')).toHaveAttribute('data-why', 'no-key');

				// A server that says it encrypts nothing, to a stranger with no pin to check it
				// against: the address carries a key, and that is the proof it is lying.
				const downgraded = await stranger(browser);
				const asked: string[] = [];
				downgraded.on('request', (request) => {
					if (request.url().includes('/public/requests/')) asked.push(request.url());
				});
				await downgraded.route('**/api/v1/health', async (route) => {
					const response = await route.fetch();
					const body = await response.json();
					await route.fulfill({ response, json: { ...body, mode: 'none' } });
				});
				await downgraded.route('**/api/v1/public/requests/**', async (route) => {
					const response = await route.fetch();
					const body = await response.json();
					await route.fulfill({ response, json: { ...body, suite: 'none', public_key: '' } });
				});
				await downgraded.goto(url);
				await expect(downgraded.getByTestId('request-ended')).toHaveAttribute(
					'data-why',
					'downgraded'
				);
				await expect(downgraded.getByText('Nothing was sent.')).toBeVisible();
				expect(asked).toEqual([]);
				await downgraded.context().close();
				for (const page of [anyone, swapped, keyless]) await page.context().close();
			});
		}
	});
}
