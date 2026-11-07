import { expect, test } from '@playwright/test';
import {
	accountMenu,
	confirmRecoveryKey,
	createInvite,
	expectHome,
	PASSPHRASE,
	register,
	setUpServer,
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

test('an admin invites a second user, who registers and signs in', async ({ page, browser }) => {
	await setUpServer(page, server);
	await signIn(page);
	const link = await createInvite(page);
	expect(link).toContain('/invite#');

	const context = await browser.newContext();
	const guest = await context.newPage();
	const words = await register(guest, link, 'bob');
	expect(words).toHaveLength(24);
	await guest.getByRole('link', { name: 'Go to sign in' }).click();
	await signIn(guest, 'bob');
	await expectHome(guest);

	// It works once.
	const again = await browser.newContext();
	const third = await again.newPage();
	await third.goto(link);
	await third.getByLabel(/^Username/).fill('carol');
	await third.getByLabel(/^Passphrase/).fill(PASSPHRASE);
	await third.getByLabel(/^Confirm passphrase/).fill(PASSPHRASE);
	await third.getByRole('button', { name: 'Continue' }).click();
	await confirmRecoveryKey(third);
	await third.getByRole('button', { name: 'Create account' }).click();
	await expect(third.getByRole('alert')).toContainText('not valid', { timeout: 30_000 });

	// The admin sees the user, and the used invite. Plain revoke works too.
	await page.goto(`${server.url}/admin`);
	await expect(page.getByTestId('users')).toContainText('bob');
	await page.getByRole('tab', { name: 'Invites' }).click();
	await expect(page.getByText('Used')).toBeVisible();

	await page.getByRole('button', { name: 'Create invite' }).click();
	await expect(page.getByText('Open', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Revoke' }).first().click();
	await expect(page.getByText('Open', { exact: true })).toHaveCount(0);

	// An admin invite asks for the passphrase.
	await page.getByLabel(/^Role/).selectOption('admin');
	await expect(page.getByRole('button', { name: 'Create invite' })).toBeDisabled();
	await page.getByLabel(/^Your passphrase/).fill('not the right passphrase');
	await page.getByRole('button', { name: 'Create invite' }).click();
	await expect(page.getByRole('alert')).toContainText('not correct', { timeout: 30_000 });
	await page.getByLabel(/^Your passphrase/).fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Create invite' }).click();
	await expect(page.getByTestId('invite-link')).toBeVisible({ timeout: 30_000 });

	// Disable and delete the second user.
	await page.getByRole('tab', { name: 'Users' }).click();
	const bob = page.getByTestId('users').locator('li', { hasText: 'bob' });
	await bob.getByRole('button', { name: 'Disable' }).click();
	await expect(bob.getByText('Disabled')).toBeVisible();
	await guest.goto(server.url);
	await expect(guest.getByRole('heading', { name: 'Sign in' })).toBeVisible();

	await bob.getByRole('button', { name: 'Delete' }).click();
	await page
		.getByRole('dialog')
		.getByLabel(/passphrase/i)
		.fill(PASSPHRASE);
	await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByTestId('users')).not.toContainText('bob');

	await accountMenu(page, 'Sign out');
	await context.close();
	await again.close();
});
