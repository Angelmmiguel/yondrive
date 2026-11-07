import { expect, test } from '@playwright/test';
import {
	accountMenu,
	confirmRecoveryKey,
	expectHome,
	expectSignedOut,
	NEW_PASSPHRASE,
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

test('the recovery words replace a lost passphrase and themselves', async ({ page }) => {
	const words = await setUpServer(page, server);

	await page.getByRole('link', { name: 'Forgot your passphrase?' }).click();
	await expect(page.getByRole('heading', { name: 'Recover your account' })).toBeVisible();

	// Not a key at all.
	await page.getByLabel(/^Username/).fill('admin');
	await page.getByLabel(/^Recovery key/).fill('these are not the words');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('24 words');

	// A mistyped word fails its checksum.
	const typo = [...words];
	typo[0] = typo[0] === 'zoo' ? 'abandon' : 'zoo';
	await page.getByLabel(/^Recovery key/).fill(typo.join(' '));
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText(/mistyped|do not open/);

	await page.getByLabel(/^Recovery key/).fill(words.join(' '));
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('heading', { name: 'Set a new passphrase' })).toBeVisible();

	await page.getByLabel(/^New passphrase/).fill(NEW_PASSPHRASE);
	await page.getByLabel(/^Confirm new passphrase/).fill(NEW_PASSPHRASE);
	await page.getByRole('button', { name: 'Continue' }).click();

	await expect(page.getByRole('heading', { name: 'Save your new recovery key' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Finish' })).toBeDisabled();
	const newWords = await confirmRecoveryKey(page);
	expect(newWords).not.toEqual(words);
	await page.getByRole('button', { name: 'Finish' }).click();
	await expectHome(page);

	// A reload still opens: the session it left behind has both halves.
	await page.reload();
	await expectHome(page);

	await accountMenu(page, 'Sign out');
	await expectSignedOut(page);

	// The old passphrase is dead.
	await submitSignIn(page, 'admin', PASSPHRASE);
	await expect(page.getByRole('alert')).toContainText('Wrong username or passphrase.', {
		timeout: 30_000
	});

	// So are the old words.
	await page.getByRole('link', { name: 'Forgot your passphrase?' }).click();
	await expect(page.getByRole('heading', { name: 'Recover your account' })).toBeVisible();
	await page.getByLabel(/^Username/).fill('admin');
	await page.getByLabel(/^Recovery key/).fill(words.join(' '));
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('do not open');

	await page.getByRole('link', { name: 'Back to sign in' }).click();
	await expectSignedOut(page);
	await signIn(page, 'admin', NEW_PASSPHRASE);
});
