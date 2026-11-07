import { expect, test } from '@playwright/test';
import {
	accountMenu,
	expectHome,
	expectSignedOut,
	PASSPHRASE,
	setUpServer,
	submitSignIn,
	totpCode
} from '../flows';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer({ mode: 'e2e' });
});

test.afterAll(async () => {
	await server.stop();
});

test('enrol, sign in with a code and a recovery code, and turn it off', async ({ page }) => {
	await setUpServer(page, server, { totp: true });

	// The wizard's switch lands the first sign-in on settings.
	await submitSignIn(page, 'admin', PASSPHRASE);
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText('You asked to set this up during setup.')).toBeVisible();

	const card = page.getByRole('region', { name: 'Two-factor sign-in' });
	await card.getByLabel(/^Passphrase/).fill(PASSPHRASE);
	await card.getByRole('button', { name: 'Set up' }).click();

	const address = card.locator('pre');
	await expect(address).toContainText('otpauth://', { timeout: 30_000 });
	const secret = (await card.locator('code').first().innerText()).trim();
	expect(secret).toMatch(/^[A-Z2-7]+=*$/);
	expect(await address.innerText()).toContain(secret.replace(/=+$/, ''));

	await card.getByLabel(/^Code from the app/).fill(totpCode(secret));
	await card.getByRole('button', { name: 'Turn on' }).click();
	await expect(card.getByText('Save these recovery codes')).toBeVisible();
	const codes = (await card.locator('pre').innerText()).trim().split('\n');
	expect(codes).toHaveLength(10);
	await card.getByRole('button', { name: 'I saved them' }).click();
	await expect(card.getByText('On', { exact: true })).toBeVisible();

	await accountMenu(page, 'Sign out');
	await expectSignedOut(page);

	// A code is asked for, a wrong one can be retried, and the KDF does not run again.
	await submitSignIn(page, 'admin', PASSPHRASE);
	await expect(page.getByRole('heading', { name: 'Two-factor sign-in' })).toBeVisible({
		timeout: 30_000
	});
	await page.getByLabel(/^Code/).fill('000000');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('not correct');

	// The step used to enrol is spent, so the next one, within the allowed skew.
	await page.getByLabel(/^Code/).fill(totpCode(secret, 1));
	await page.getByRole('button', { name: 'Continue' }).click();
	await expectHome(page);

	await accountMenu(page, 'Sign out');
	await expectSignedOut(page);

	await submitSignIn(page, 'admin', PASSPHRASE);
	await page.getByRole('button', { name: 'Use a recovery code' }).click({ timeout: 30_000 });
	await page.getByLabel(/^Recovery code/).fill(codes[0]);
	await page.getByRole('button', { name: 'Continue' }).click();
	await expectHome(page);

	await page.goto(`${server.url}/settings`);
	const again = page.getByRole('region', { name: 'Two-factor sign-in' });
	await expect(again.getByText('On', { exact: true })).toBeVisible();
	await again.getByLabel(/^Passphrase/).fill(PASSPHRASE);
	await again.getByRole('button', { name: 'Use a recovery code' }).click();
	await again.getByLabel(/^Recovery code/).fill(codes[1]);
	await again.getByRole('button', { name: 'Turn off' }).click();
	await expect(again.getByText('Off', { exact: true })).toBeVisible({ timeout: 30_000 });

	await accountMenu(page, 'Sign out');
	await submitSignIn(page, 'admin', PASSPHRASE);
	await expectHome(page);
});

test('the recovery words ask for the second factor and take a recovery code', async ({ page }) => {
	test.setTimeout(180_000);
	const own = await startServer({ mode: 'e2e' });
	try {
		const words = await setUpServer(page, own, { totp: true });
		await submitSignIn(page, 'admin', PASSPHRASE);
		await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
		const card = page.getByRole('region', { name: 'Two-factor sign-in' });
		await card.getByLabel(/^Passphrase/).fill(PASSPHRASE);
		await card.getByRole('button', { name: 'Set up' }).click();
		await expect(card.locator('pre')).toContainText('otpauth://', { timeout: 30_000 });
		const secret = (await card.locator('code').first().innerText()).trim();
		await card.getByLabel(/^Code from the app/).fill(totpCode(secret));
		await card.getByRole('button', { name: 'Turn on' }).click();
		await expect(card.getByText('Save these recovery codes')).toBeVisible();
		const codes = (await card.locator('pre').innerText()).trim().split('\n');
		await card.getByRole('button', { name: 'I saved them' }).click();
		await accountMenu(page, 'Sign out');
		await expectSignedOut(page);

		await page.getByRole('link', { name: 'Forgot your passphrase?' }).click();
		await expect(page.getByRole('heading', { name: 'Recover your account' })).toBeVisible();
		await page.getByLabel(/^Username/).fill('admin');
		await page.getByLabel(/^Recovery key/).fill(words.join(' '));
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page.getByRole('heading', { name: 'Two-factor sign-in' })).toBeVisible({
			timeout: 30_000
		});
		await page.getByRole('button', { name: 'Use a recovery code' }).click();
		await page.getByLabel(/^Recovery code/).fill(codes[0]);
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page.getByRole('heading', { name: 'Set a new passphrase' })).toBeVisible({
			timeout: 30_000
		});
	} finally {
		await own.stop();
	}
});
