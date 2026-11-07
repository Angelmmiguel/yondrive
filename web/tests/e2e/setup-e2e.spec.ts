import { expect, test } from '@playwright/test';
import {
	chooseMode,
	confirmRecoveryKey,
	expectHome,
	fillAdmin,
	openWizard,
	PASSPHRASE,
	runWizard,
	signIn
} from '../flows';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer({ mode: 'e2e' });
});

test.afterAll(async () => {
	await server.stop();
});

test('the server step shows the data directory read-only and warns about http', async ({
	page
}) => {
	await openWizard(page, server);

	const dir = page.getByLabel(/^Data directory/);
	await expect(dir).toHaveValue(server.dataDir);
	await expect(dir).toHaveJSProperty('readOnly', true);
	await expect(page.getByText(/bytes free|KB free|MB free|GB free|TB free/)).toBeVisible();

	const url = page.getByLabel(/^Public URL/);
	await url.fill('https://drive.example.com');
	await expect(page.getByText('This address is plain HTTP')).toHaveCount(0);
	await url.fill('http://drive.example.com');
	await expect(page.getByText('This address is plain HTTP')).toBeVisible();

	await url.fill('ftp://nope');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('not usable');
});

test('the wizard has no step or copy from the old design', async ({ page }) => {
	await openWizard(page, server);
	const nav = page.getByRole('navigation', { name: 'Setup steps' });
	await expect(nav.getByRole('button')).toHaveText([
		/Server/,
		/Encryption/,
		/Admin account/,
		/Recovery key/,
		/Sign-in methods/,
		/Review/
	]);
	await expect(page.getByText(/email me|recovery codes/i)).toHaveCount(0);

	await page.getByRole('button', { name: 'Continue' }).click();
	const none = page.getByRole('radio', { name: /No encryption/ });
	await expect(none).toContainText('same features');
	await expect(none).toContainText('all still running on the device');
	await expect(none).toContainText('anyone with access to the server or its disks');
	await expect(page.getByRole('radio', { name: /End-to-end/ })).toContainText('Recommended');
	await expect(page.getByText(/server-side|Faster|so the server can/)).toHaveCount(0);
});

test('a reload of the recovery step makes a new key and asks again', async ({ page }) => {
	await openWizard(page, server);
	await page.getByRole('button', { name: 'Continue' }).click();
	await chooseMode(page, 'e2e');
	await page.getByRole('button', { name: 'Continue' }).click();
	await fillAdmin(page);
	await page.getByRole('button', { name: 'Continue' }).click();
	const first = await page.getByTestId('recovery-words').innerText();
	await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
	await confirmRecoveryKey(page);
	await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();

	await page.reload();
	// The link left the address bar when it was read, so a reload needs it again.
	await expect(page.getByRole('heading', { name: /waiting to be set up/ })).toBeVisible();
	await expect(page.getByText('reloading this page needs the link again')).toBeVisible();
	await page.goto(`${server.url}/setup#${await server.setupToken()}`);
	await expect(page.getByRole('heading', { name: 'Set up your server' })).toBeVisible();
	await page.getByRole('button', { name: 'Continue' }).click();
	await chooseMode(page, 'e2e');
	await page.getByRole('button', { name: 'Continue' }).click();
	await fillAdmin(page);
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByTestId('recovery-words')).toBeVisible();
	expect(await page.getByTestId('recovery-words').innerText()).not.toBe(first);
	await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
});

test('wrong words do not continue, and nothing is stored until Finish', async ({ page }) => {
	await openWizard(page, server);
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();
	await fillAdmin(page);
	await page.getByRole('button', { name: 'Continue' }).click();
	for (const input of await page.getByLabel(/^Word \d+/).all()) await input.fill('wrong');
	await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
	await expect(page.getByText('Type the three words back to continue.')).toBeVisible();

	const health = await (await page.request.get(`${server.url}/api/v1/health`)).json();
	expect(health.setup).toBe(false);
});

test('full setup end to end, then sign in', async ({ page }) => {
	const words = await runWizard(page, server, { mode: 'e2e', email: 'admin@example.com' });
	expect(words).toHaveLength(24);

	const health = await (await page.request.get(`${server.url}/api/v1/health`)).json();
	expect(health).toMatchObject({ setup: true, mode: 'e2e' });
	expect(await page.evaluate(() => localStorage.getItem('yondrive.mode'))).toBe(
		'xchacha20poly1305-v1'
	);

	await page.getByRole('button', { name: 'Go to sign in' }).click();
	await signIn(page, 'admin', PASSPHRASE);
	await expectHome(page);
	await expect(page.getByTestId('not-encrypted')).toHaveCount(0);
	await expect(page.getByText('Nothing here yet')).toBeVisible();

	const me = await (await page.request.get(`${server.url}/api/v1/me`)).json();
	expect(me.keys.wrapped_master_key).toBeTruthy();
	expect(me.user.role).toBe('admin');
});
