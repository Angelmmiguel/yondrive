import { expect, test } from '@playwright/test';
import {
	accountMenu,
	confirmRecoveryKey,
	expectHome,
	expectLocked,
	expectSignedOut,
	NEW_PASSPHRASE,
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

test('change passphrase, new recovery key, device tokens and the theme', async ({ page }) => {
	const oldWords = await setUpServer(page, server);
	await signIn(page);
	await page.goto(`${server.url}/settings`);

	// Change passphrase, wrong current one first.
	const passphrase = page.getByRole('region', { name: 'Passphrase' });
	await passphrase.getByLabel(/^Current passphrase/).fill('not the right passphrase');
	await passphrase.getByLabel(/^New passphrase/).fill(NEW_PASSPHRASE);
	await passphrase.getByLabel(/^Confirm new passphrase/).fill(NEW_PASSPHRASE);
	await passphrase.getByRole('button', { name: 'Change passphrase' }).click();
	await expect(passphrase.getByRole('alert')).toContainText('not correct', { timeout: 30_000 });
	await passphrase.getByLabel(/^Current passphrase/).fill(PASSPHRASE);
	await passphrase.getByRole('button', { name: 'Change passphrase' }).click();
	await expect(page.getByText('Passphrase changed.')).toBeVisible({ timeout: 30_000 });

	// A new recovery key, typed back before the old one dies.
	const recovery = page.getByRole('region', { name: 'Recovery key' });
	await recovery.getByRole('button', { name: 'Make a new recovery key' }).click();
	await expect(recovery.getByRole('button', { name: 'Replace recovery key' })).toBeDisabled();
	const newWords = await confirmRecoveryKey(page);
	await recovery.getByLabel(/^Current passphrase/).fill(NEW_PASSPHRASE);
	await recovery.getByRole('button', { name: 'Replace recovery key' }).click();
	await expect(page.getByText('New recovery key saved.')).toBeVisible({ timeout: 30_000 });

	// Device tokens.
	await page.getByRole('tab', { name: 'Devices' }).click();
	await page.getByLabel(/^Device name/).fill('my phone');
	await page.getByLabel(/^Passphrase/).fill(NEW_PASSPHRASE);
	await page.getByRole('button', { name: 'Create token' }).click();
	await expect(page.getByText('Copy this token now')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole('listitem').filter({ hasText: 'my phone' })).toBeVisible();
	await page.getByRole('button', { name: 'Revoke' }).click();
	await expect(page.getByRole('listitem').filter({ hasText: 'my phone' })).toHaveCount(0);

	// Theme.
	await page.getByRole('tab', { name: 'Appearance' }).click();
	await page.getByRole('radio', { name: 'Dark' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

	await accountMenu(page, 'Sign out');
	await expectSignedOut(page);

	await submitSignIn(page, 'admin', PASSPHRASE);
	await expect(page.getByRole('alert')).toContainText('Wrong username or passphrase.', {
		timeout: 30_000
	});
	await page.getByRole('link', { name: 'Forgot your passphrase?' }).click();
	await expect(page.getByRole('heading', { name: 'Recover your account' })).toBeVisible();
	await page.getByLabel(/^Username/).fill('admin');
	await page.getByLabel(/^Recovery key/).fill(oldWords.join(' '));
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('do not open');

	await page.getByLabel(/^Recovery key/).fill(newWords.join(' '));
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('heading', { name: 'Set a new passphrase' })).toBeVisible();
	// Leaving recovery half way leaves a session with no keys: the passphrase opens it.
	await page.goto(server.url);
	await expectLocked(page);
	await submitUnlock(page, NEW_PASSPHRASE);
	await expectHome(page);
});
