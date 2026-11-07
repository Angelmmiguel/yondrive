import { expect, test } from '@playwright/test';
import {
	accountMenu,
	expectHome,
	expectSignedOut,
	PASSPHRASE,
	setUpServer,
	signIn,
	submitSignIn
} from '../flows';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer({ mode: 'e2e' });
});

test.afterAll(async () => {
	await server.stop();
});

test('signing in, a wrong passphrase, an unknown user, and signing out', async ({ page }) => {
	await setUpServer(page, server);

	await submitSignIn(page, 'admin', 'not the right passphrase');
	await expect(page.getByRole('alert')).toContainText('Wrong username or passphrase.', {
		timeout: 30_000
	});
	const wrongPassphrase = await page.getByRole('alert').innerText();

	await submitSignIn(page, 'nobody-here', PASSPHRASE);
	await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({
		timeout: 30_000
	});
	await expect(page.getByRole('alert')).toHaveText(wrongPassphrase);

	// Too short to be one, and refused without troubling the server.
	await page.getByLabel(/^Passphrase/).fill('short');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({
		timeout: 30_000
	});

	await signIn(page, ' ADMIN ', PASSPHRASE);
	await expectHome(page);

	await page.goto(`${server.url}/signin`);
	await expectHome(page);

	await accountMenu(page, 'Sign out');
	await expectSignedOut(page);
	expect((await page.request.get(`${server.url}/api/v1/me`)).status()).toBe(401);

	await page.goto(`${server.url}/settings`);
	await expectSignedOut(page);
});
