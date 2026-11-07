import { expect, test } from '@playwright/test';
import { expectHome, expectLocked, setUpServer, signIn } from '../flows';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer({ mode: 'e2e' });
});

test.afterAll(async () => {
	await server.stop();
});

test('a reload resumes without the passphrase, and only with both halves', async ({ page }) => {
	await setUpServer(page, server);
	await signIn(page);

	const stored = await page.evaluate(() => sessionStorage.getItem('yondrive.master'));
	expect(stored).not.toBeNull();

	await page.reload();
	await expectHome(page);
	await page.goto(`${server.url}/settings`);
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

	// Without the server's half, as after a restart of the server.
	const deleted = await page.evaluate(async () => {
		const res = await fetch('/api/v1/session/key', { method: 'DELETE' });
		return res.status;
	});
	expect(deleted).toBe(204);
	await page.reload();
	await expectLocked(page);
	expect(await page.evaluate(() => sessionStorage.getItem('yondrive.master'))).toBeNull();
});
