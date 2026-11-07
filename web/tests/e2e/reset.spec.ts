import { expect, test } from '@playwright/test';
import {
	accountMenu,
	createInvite,
	expectSignedOut,
	NEW_PASSPHRASE,
	PASSPHRASE,
	register,
	setUpServer,
	signIn,
	submitSignIn
} from '../flows';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer({ mode: 'none' });
});

test.afterAll(async () => {
	await server.stop();
});

test('an admin resets a password without encryption, confirming with a passphrase', async ({
	page,
	browser
}) => {
	await setUpServer(page, server, { mode: 'none' });
	await signIn(page);
	const link = await createInvite(page);

	const context = await browser.newContext();
	const guest = await context.newPage();
	await register(guest, link, 'bob', PASSPHRASE, false);
	await guest.getByRole('link', { name: 'Go to sign in' }).click();
	await signIn(guest, 'bob');

	await page.goto(`${server.url}/admin`);
	const bob = page.getByTestId('users').locator('li', { hasText: 'bob' });
	await bob.getByRole('button', { name: 'Reset password' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel(/^Your passphrase/).fill('not the right passphrase');
	await dialog.getByRole('button', { name: 'Issue link' }).click();
	await expect(dialog.getByRole('alert')).toContainText('not correct', { timeout: 30_000 });
	await dialog.getByLabel(/^Your passphrase/).fill(PASSPHRASE);
	await dialog.getByRole('button', { name: 'Issue link' }).click();
	const code = dialog.locator('pre');
	await expect(code).toBeVisible({ timeout: 30_000 });
	const resetLink = (await code.innerText()).trim();
	expect(resetLink).toContain('/reset#');
	await dialog.getByRole('button', { name: 'Done' }).click();

	await guest.goto(resetLink);
	await guest.getByLabel(/^New passphrase/).fill(NEW_PASSPHRASE);
	await guest.getByLabel(/^Confirm new passphrase/).fill(NEW_PASSPHRASE);
	await guest.getByRole('button', { name: 'Set passphrase' }).click();
	await expect(guest.getByRole('heading', { name: 'Your passphrase is set' })).toBeVisible({
		timeout: 30_000
	});

	// Every session of the user ended with it.
	expect((await guest.request.get(`${server.url}/api/v1/me`)).status()).toBe(401);

	await guest.getByRole('link', { name: 'Go to sign in' }).click();
	await submitSignIn(guest, 'bob', PASSPHRASE);
	await expect(guest.getByRole('alert')).toContainText('Wrong username or passphrase.', {
		timeout: 30_000
	});
	await signIn(guest, 'bob', NEW_PASSPHRASE);

	// The link is spent.
	const third = await (await browser.newContext()).newPage();
	await third.goto(resetLink);
	await third.getByLabel(/^New passphrase/).fill(PASSPHRASE);
	await third.getByLabel(/^Confirm new passphrase/).fill(PASSPHRASE);
	await third.getByRole('button', { name: 'Set passphrase' }).click();
	await expect(third.getByRole('alert')).toContainText('not valid', { timeout: 30_000 });

	await accountMenu(page, 'Sign out');
	await expectSignedOut(page);
	await context.close();
});
