/**
 * Public links, in a browser that has no account and has never seen this server: what
 * opens, what does not and how it says so, in both modes. Everything that leaves that
 * browser is captured, so that a key in an address can be seen not to leave.
 */
import { expect, test, type Browser, type Page, type Request } from '@playwright/test';
import { fileBox, newFolder, openDrive, openFolder, row, saved, upload } from '../drive';
import { startServer, type Mode, type Server } from '../server';
import { makeLink, nodeIdOf, stranger } from '../sharing';

const box = await fileBox();

test.afterAll(() => box.remove());

const PASSWORD = 'open sesame with enough letters';

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`in mode ${mode}`, () => {
		let server: Server;
		let alice: Page;
		const folder = `Shared Out ${mode}`;
		const text = `the text under the link, ${mode}`;
		const fileName = `note-${mode}.txt`;
		const single = `single-${mode}.txt`;

		test.beforeAll(async ({ browser }) => {
			test.setTimeout(180_000);
			server = await startServer({ mode });
			alice = await (await browser.newContext({ acceptDownloads: true })).newPage();
			await openDrive(alice, server, mode);
			await upload(alice, await box.add(single, Buffer.from(`one file, ${mode}`)));
			await newFolder(alice, folder);
			await openFolder(alice, folder);
			await newFolder(alice, 'Deeper');
			await upload(alice, await box.add(fileName, Buffer.from(text)));
			await alice
				.getByRole('navigation', { name: 'Breadcrumb' })
				.getByRole('link', { name: 'My files' })
				.click();
		});

		test.afterAll(async () => {
			await alice.context().close();
			await server.stop();
		});

		async function visit(browser: Browser, url: string) {
			const page = await stranger(browser);
			const sent: Request[] = [];
			page.on('request', (request) => sent.push(request));
			await page.goto(url);
			return { page, sent };
		}

		test('opens a folder with no account, and the key never leaves the browser', async ({
			browser
		}) => {
			const url = await makeLink(alice, folder);
			const fragment = new URL(url).hash.slice(1);
			if (mode === 'e2e') expect(fragment).toMatch(/^[A-Za-z0-9_-]{43}$/);
			else expect(fragment).toBe('');

			const { page, sent } = await visit(browser, url);
			await expect(page.getByRole('heading', { name: folder })).toBeVisible({ timeout: 30_000 });
			// Taken out of the address as soon as it was read.
			expect(page.url()).toBe(new URL(url).origin + new URL(url).pathname);
			expect(page.url()).not.toContain('#');

			const item = page.getByTestId('link-item').filter({ hasText: fileName });
			await expect(item).toBeVisible();
			await expect(page.getByTestId('link-item').filter({ hasText: 'Deeper' })).toBeVisible();

			await item.getByRole('button', { name: new RegExp(`^${fileName}`) }).click();
			await expect(page.getByTestId('viewer-text')).toHaveText(text);
			await page.getByRole('button', { name: 'Close', exact: true }).click();

			const started = page.waitForEvent('download');
			await item.getByRole('button', { name: `Download ${fileName}` }).click();
			const bytes = await saved(await started);
			expect(bytes.toString()).toBe(text);

			await page
				.getByTestId('link-item')
				.filter({ hasText: 'Deeper' })
				.getByRole('button', { name: /^Deeper/ })
				.click();
			await expect(page.getByRole('heading', { name: 'Deeper' })).toBeVisible();
			await page.getByRole('button', { name: folder }).click();
			await expect(page.getByRole('heading', { name: folder })).toBeVisible();

			const all = sent.map(
				(request) =>
					`${request.url()} ${JSON.stringify(request.headers())} ${request.postData() ?? ''}`
			);
			if (fragment !== '') expect(all.join('\n')).not.toContain(fragment);
			// It reads with a token in a header, and never asks who is here.
			const apiCalls = sent.filter((request) => request.url().includes('/api/v1/'));
			expect(
				apiCalls.some((r) => r.url().includes('/blobs/') && 'x-link-token' in r.headers())
			).toBe(true);
			expect(apiCalls.filter((r) => /\/api\/v1\/(me|session)/.test(r.url()))).toEqual([]);

			// Nothing of who shared it, and no app around it.
			const shown = await page.locator('body').innerText();
			expect(shown).not.toContain('admin');
			await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
			await expect(page.getByTestId('account-menu')).toHaveCount(0);

			const response = await page.request.get(new URL(url).origin + new URL(url).pathname);
			expect(response.headers()['referrer-policy']).toBe('no-referrer');
			expect(response.headers()['content-security-policy']).toContain("connect-src 'self'");
			await page.context().close();
		});

		test('a single file shows with its download', async ({ browser }) => {
			const url = await makeLink(alice, single);
			const { page } = await visit(browser, url);
			await expect(page.getByRole('heading', { name: single })).toBeVisible({ timeout: 30_000 });
			const card = page.getByTestId('link-file');
			await card.getByRole('button', { name: 'Open' }).click();
			await expect(page.getByTestId('viewer-text')).toHaveText(`one file, ${mode}`);
			await page.getByRole('button', { name: 'Close', exact: true }).click();
			const started = page.waitForEvent('download');
			await card.getByRole('button', { name: 'Download' }).click();
			expect((await saved(await started)).toString()).toBe(`one file, ${mode}`);
			await page.context().close();
		});

		test('a password opens it, a wrong one does not, and the address has no key', async ({
			browser
		}) => {
			const url = await makeLink(alice, folder, { password: PASSWORD });
			expect(new URL(url).hash).toBe('');

			const { page, sent } = await visit(browser, url);
			await expect(page.getByRole('heading', { name: 'This link has a password' })).toBeVisible({
				timeout: 30_000
			});
			await expect(page.getByText(fileName)).toHaveCount(0);

			await page.getByLabel(/^Password/).fill('this one is not the password');
			await page.getByRole('button', { name: 'Open', exact: true }).click();
			await expect(page.getByText('That password is not right.')).toBeVisible({ timeout: 30_000 });
			await expect(page.getByText(fileName)).toHaveCount(0);

			await page.getByLabel(/^Password/).fill(PASSWORD);
			await page.getByRole('button', { name: 'Open', exact: true }).click();
			await expect(page.getByRole('heading', { name: folder })).toBeVisible({ timeout: 30_000 });
			const item = page.getByTestId('link-item').filter({ hasText: fileName });
			await item.getByRole('button', { name: new RegExp(`^${fileName}`) }).click();
			await expect(page.getByTestId('viewer-text')).toHaveText(text);

			const all = sent.map(
				(request) =>
					`${request.url()} ${JSON.stringify(request.headers())} ${request.postData() ?? ''}`
			);
			expect(all.join('\n')).not.toContain(PASSWORD);
			await page.context().close();
		});

		test('a revoked link says so, in a friendly way', async ({ browser }) => {
			const url = await makeLink(alice, single);
			await alice
				.getByRole('navigation', { name: 'Main' })
				.getByRole('link', { name: 'Shared by me' })
				.click();
			const entry = alice
				.getByTestId('by-me-link')
				.filter({ hasText: single })
				.and(alice.locator('[data-status="live"]'));
			await expect(entry.first()).toBeVisible();
			// All of them, so that this one is sure to be among the revoked.
			while ((await entry.count()) > 0) {
				const before = await entry.count();
				await entry
					.first()
					.getByRole('button', { name: `Revoke the link to ${single}` })
					.click();
				await expect(entry).toHaveCount(before - 1);
			}

			const { page } = await visit(browser, url);
			await expect(page.getByTestId('link-ended')).toHaveAttribute('data-why', 'revoked', {
				timeout: 30_000
			});
			await expect(
				page.getByRole('heading', { name: 'This link has been turned off' })
			).toBeVisible();
			await page.context().close();
			await alice
				.getByRole('navigation', { name: 'Main' })
				.getByRole('link', { name: 'My files' })
				.click();
			await expect(row(alice, folder)).toBeVisible();
		});

		test('an expired link says so', async ({ browser }) => {
			// The server takes only an expiry in the future, so this one is soon.
			await alice.route('**/api/v1/links', async (route) => {
				if (route.request().method() !== 'POST') return route.continue();
				const body = route.request().postDataJSON();
				body.expires_at = new Date(Date.now() + 1500).toISOString();
				await route.continue({ postData: JSON.stringify(body) });
			});
			const url = await makeLink(alice, folder);
			await alice.unroute('**/api/v1/links');
			await new Promise((r) => setTimeout(r, 2500));

			const { page } = await visit(browser, url);
			await expect(page.getByTestId('link-ended')).toHaveAttribute('data-why', 'expired', {
				timeout: 30_000
			});
			await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
			await page.context().close();
		});

		test('a download limit counts, and then ends the link', async ({ browser }) => {
			await openFolder(alice, folder);
			const url = await makeLink(alice, fileName, { limit: 1 });
			await alice
				.getByRole('navigation', { name: 'Breadcrumb' })
				.getByRole('link', { name: 'My files' })
				.click();

			const first = await visit(browser, url);
			await expect(first.page.getByTestId('downloads-left')).toContainText('1 download left', {
				timeout: 30_000
			});
			const started = first.page.waitForEvent('download');
			await first.page.getByTestId('link-file').getByRole('button', { name: 'Download' }).click();
			expect((await saved(await started)).toString()).toBe(text);
			await expect(first.page.getByTestId('downloads-left')).toContainText('0 downloads left');
			await first.page.context().close();

			const second = await visit(browser, url);
			await expect(second.page.getByTestId('link-ended')).toHaveAttribute('data-why', 'limit', {
				timeout: 30_000
			});
			await second.page.context().close();
		});

		test('an address with nothing behind it says so', async ({ browser }) => {
			const { page } = await visit(browser, `${server.url}/s/${'a'.repeat(32)}`);
			await expect(page.getByTestId('link-ended')).toHaveAttribute('data-why', 'gone', {
				timeout: 30_000
			});
			await page.context().close();
		});

		if (mode === 'e2e') {
			test('an address missing its key, or with the wrong one, opens nothing', async ({
				browser
			}) => {
				const url = await makeLink(alice, folder);
				const bare = url.split('#')[0];
				const missing = await visit(browser, bare);
				await expect(missing.page.getByTestId('link-ended')).toHaveAttribute('data-why', 'no-key', {
					timeout: 30_000
				});
				await missing.page.context().close();

				const wrong = await visit(browser, `${bare}#${'A'.repeat(42)}Q`);
				await expect(wrong.page.getByTestId('link-ended')).toHaveAttribute('data-why', 'bad-key', {
					timeout: 30_000
				});
				await wrong.page.context().close();
			});

			test('a link goes on working through a rotation', async ({ browser }) => {
				const id = await nodeIdOf(alice, folder);
				const url = await makeLink(alice, folder);
				const { rotate } = await import('../sharing-rotate');
				await rotate(alice, browser, server, folder, id);

				const { page } = await visit(browser, url);
				const item = page.getByTestId('link-item').filter({ hasText: fileName });
				await expect(item).toBeVisible({ timeout: 30_000 });
				await item.getByRole('button', { name: new RegExp(`^${fileName}`) }).click();
				await expect(page.getByTestId('viewer-text')).toHaveText(text);
				await page.context().close();
			});
		}
	});
}
