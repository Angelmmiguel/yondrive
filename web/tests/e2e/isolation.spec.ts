import { expect, test } from '@playwright/test';
import { createInvite, expectHome, NEW_PASSPHRASE, register, setUpServer, signIn } from '../flows';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer({ mode: 'e2e' });
});

test.afterAll(async () => {
	await server.stop();
});

test('two users hold separate keys and cannot reach each other or the admin area', async ({
	page,
	browser
}) => {
	await setUpServer(page, server);
	await signIn(page);
	const link = await createInvite(page);

	const context = await browser.newContext();
	const guest = await context.newPage();
	const bobWords = await register(guest, link, 'bob', NEW_PASSPHRASE);
	await guest.getByRole('link', { name: 'Go to sign in' }).click();
	await signIn(guest, 'bob', NEW_PASSPHRASE);

	const admin = await (await page.request.get(`${server.url}/api/v1/me`)).json();
	const bob = await (await guest.request.get(`${server.url}/api/v1/me`)).json();
	expect(bob.user.username).toBe('bob');
	expect(bob.user.role).toBe('user');
	expect(bob.keys.public_keys.x25519).not.toBe(admin.keys.public_keys.x25519);
	expect(bob.keys.wrapped_master_key).not.toBe(admin.keys.wrapped_master_key);
	expect(bob.kdf.salt).not.toBe(admin.kdf.salt);

	// The admin area is closed to him, on screen and at the API.
	await guest.goto(`${server.url}/admin`);
	await expectHome(guest);
	await expect(guest.getByRole('link', { name: 'Administration' })).toHaveCount(0);
	expect((await guest.request.get(`${server.url}/api/v1/admin/users`)).status()).toBe(403);
	expect((await guest.request.get(`${server.url}/api/v1/admin/settings`)).status()).toBe(403);

	// His public keys are all another user can read of him.
	const seen = await (
		await page.request.get(`${server.url}/api/v1/users/${bob.user.id}/keys`)
	).json();
	expect(Object.keys(seen).sort()).toEqual(['public_keys', 'user_id', 'username']);

	// The admin's own listing holds no blob of his.
	const listed = await (await page.request.get(`${server.url}/api/v1/admin/users`)).text();
	expect(listed).not.toContain(bob.keys.wrapped_master_key);
	expect(listed).not.toContain(bob.keys.sealed_x25519);

	// One user's recovery words do not open the other.
	await context.clearCookies();
	await guest.goto(`${server.url}/recover`);
	await guest.getByLabel(/^Username/).fill('admin');
	await guest.getByLabel(/^Recovery key/).fill(bobWords.join(' '));
	await guest.getByRole('button', { name: 'Continue' }).click();
	await expect(guest.getByRole('alert')).toContainText('do not open');

	await context.close();
});
