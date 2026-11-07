import { expect, test } from '@playwright/test';
import { setUpServer, signIn } from '../flows';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer({ mode: 'e2e' });
});

test.afterAll(async () => {
	await server.stop();
});

test('end to end offers no password reset, and a link is refused', async ({ page }) => {
	await setUpServer(page, server);
	await signIn(page);
	await page.goto(`${server.url}/admin`);
	await expect(page.getByTestId('users')).toContainText('admin');
	await expect(page.getByRole('button', { name: 'Reset password' })).toHaveCount(0);

	await page.goto(`${server.url}/reset#anything`);
	await page.getByLabel(/^New passphrase/).fill('correct horse battery staple');
	await page.getByLabel(/^Confirm new passphrase/).fill('correct horse battery staple');
	await page.getByRole('button', { name: 'Set passphrase' }).click();
	await expect(page.getByRole('alert')).toContainText('cannot reset', { timeout: 30_000 });
});
