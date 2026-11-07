import { expect, test } from '@playwright/test';
import {
	accountMenu,
	chooseMode,
	expectSignedOut,
	openWizard,
	setUpServer,
	signIn
} from '../flows';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer({ mode: 'none' });
});

test.afterAll(async () => {
	await server.stop();
});

test('without encryption the wizard skips the recovery step and explains the choice', async ({
	page
}) => {
	await openWizard(page, server);
	await page.getByRole('button', { name: 'Continue' }).click();
	await chooseMode(page, 'none');
	await expect(
		page.getByText(/anyone with access to the server or its disks can read them/).first()
	).toBeVisible();
	await expect(
		page.getByRole('navigation', { name: 'Setup steps' }).getByRole('button')
	).toHaveText([/Server/, /Encryption/, /Admin account/, /Sign-in methods/, /Review/]);
});

test('full setup without encryption, with no unlock, and a quiet indicator', async ({ page }) => {
	const words = await setUpServer(page, server, { mode: 'none' });
	expect(words).toEqual([]);

	await signIn(page);
	await expect(page.getByTestId('not-encrypted')).toContainText('Not encrypted');

	const me = await (await page.request.get(`${server.url}/api/v1/me`)).json();
	expect(me.mode).toBe('none');
	expect(me.keys).toBeUndefined();
	expect(await page.evaluate(() => localStorage.getItem('yondrive.mode'))).toBe('none');

	// A reload needs nothing, and there is no lock to choose.
	await page.reload();
	await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
	await page.getByTestId('account-menu').click();
	await expect(page.getByRole('menuitem', { name: 'Lock' })).toHaveCount(0);
	await page.keyboard.press('Escape');

	await accountMenu(page, 'Sign out');
	await expectSignedOut(page);

	await page.goto(`${server.url}/recover`);
	await expect(page.getByRole('heading', { name: /Forgot your password/ })).toBeVisible();
	await expect(page.getByText('An administrator can give you a reset link.')).toBeVisible();
});
