import { expect, test, type Page } from '@playwright/test';
import { captureRequests } from '../scan';
import {
	expectLocked,
	PASSPHRASE,
	setUpServer,
	signIn,
	submitSignIn,
	submitUnlock
} from '../flows';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer({ mode: 'e2e' });
});

test.afterAll(async () => {
	await server.stop();
});

/** Plays a hostile server: passes every answer of a route through `change`. */
async function tamper(
	page: Page,
	path: string,
	change: (body: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
	await page.route(`**/api/v1/${path}`, async (route) => {
		const response = await route.fetch();
		if (!response.ok()) return route.fulfill({ response });
		await route.fulfill({ response, json: change(await response.json()) });
	});
}

const claimNone = (body: Record<string, unknown>) => ({ ...body, mode: 'none' });

async function expectAlert(page: Page, text: string | RegExp): Promise<void> {
	await expect(page.getByRole('heading', { name: 'Stopped for your safety' })).toBeVisible({
		timeout: 30_000
	});
	await expect(page.getByRole('alert')).toContainText(text);
	await expect(page.getByRole('heading', { name: 'My files' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
}

test('the guard stops every way of claiming the other mode', async ({ page, browser }) => {
	await setUpServer(page, server);
	await signIn(page);

	// A device that pinned end-to-end, told otherwise at load. No way past it.
	await tamper(page, 'health', claimNone);
	await page.reload();
	await expectAlert(page, 'different encryption mode');
	await page.goto(`${server.url}/settings`);
	await expectAlert(page, 'different encryption mode');
	await page.unroute('**/api/v1/health');

	// A new device: an account with keys cannot be in a mode without any.
	const fresh = await browser.newContext();
	const newDevice = await fresh.newPage();
	await tamper(newDevice, 'auth/login', claimNone);
	await newDevice.goto(server.url);
	await submitSignIn(newDevice, 'admin', PASSPHRASE);
	await expectAlert(newDevice, 'holds encryption keys');
	await expect
		.poll(async () => (await newDevice.request.get(`${server.url}/api/v1/me`)).status())
		.toBe(401);
	await fresh.close();

	// The same, on unlock, for a server turning hostile mid-session.
	const third = await browser.newContext();
	const device = await third.newPage();
	await device.goto(server.url);
	await signIn(device);
	await device.evaluate(() => fetch('/api/v1/session/key', { method: 'DELETE' }));
	await device.reload();
	await expectLocked(device);
	await tamper(device, 'me', claimNone);
	await submitUnlock(device, PASSPHRASE);
	await expectAlert(device, 'holds encryption keys');
	await third.close();

	// A device that pinned end-to-end, with the keys hidden as well.
	await page.goto(server.url);
	const fourth = await browser.newContext();
	const pinned = await fourth.newPage();
	await pinned.addInitScript(() => localStorage.setItem('yondrive.mode', 'xchacha20poly1305-v1'));
	await tamper(pinned, 'auth/login', (body) => ({ ...claimNone(body), keys: undefined }));
	await pinned.goto(server.url);
	const sent = captureRequests(pinned);
	await submitSignIn(pinned, 'admin', PASSPHRASE);
	await expectAlert(pinned, 'different encryption mode');
	expect(sent.join('\n')).not.toContain(PASSPHRASE);
	await fourth.close();

	// A device that pinned none, on a server in end-to-end mode.
	const fifth = await browser.newContext();
	const other = await fifth.newPage();
	await other.addInitScript(() => localStorage.setItem('yondrive.mode', 'none'));
	await other.goto(server.url);
	await expectAlert(other, 'different encryption mode');
	await fifth.close();

	// A mode nobody has heard of.
	const sixth = await browser.newContext();
	const unknown = await sixth.newPage();
	await tamper(unknown, 'health', (body) => ({ ...body, mode: 'rot13' }));
	await unknown.goto(server.url);
	await expectAlert(unknown, 'does not know');
	await sixth.close();
});
