import { expect, test } from '@playwright/test';
import {
	accountMenu,
	expectHome,
	expectLocked,
	PASSPHRASE,
	setUpServer,
	signIn,
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

test('lock drops the keys and both halves, unlock brings them back, tabs follow', async ({
	page,
	context
}) => {
	await setUpServer(page, server);
	await signIn(page);
	expect(await page.evaluate(() => sessionStorage.getItem('yondrive.master'))).not.toBeNull();
	expect((await page.request.get(`${server.url}/api/v1/session/key`)).status()).toBe(200);

	await accountMenu(page, 'Lock');
	await expectLocked(page);
	expect(await page.evaluate(() => sessionStorage.getItem('yondrive.master'))).toBeNull();
	await expect
		.poll(async () => (await page.request.get(`${server.url}/api/v1/session/key`)).status())
		.toBe(404);
	// The session goes on: only the keys are gone.
	expect((await page.request.get(`${server.url}/api/v1/me`)).status()).toBe(200);

	// Anywhere in the app now means Unlock.
	await page.goto(`${server.url}/settings`);
	await expectLocked(page);

	await submitUnlock(page, 'not the right passphrase');
	await expect(page.getByRole('alert')).toContainText('not correct', { timeout: 30_000 });
	await expectLocked(page);

	await submitUnlock(page, PASSPHRASE);
	await expectHome(page);
	expect(await page.evaluate(() => sessionStorage.getItem('yondrive.master'))).not.toBeNull();

	// A second tab starts locked, unlocks, and follows the first one's lock.
	const other = await context.newPage();
	await other.goto(server.url);
	await expectLocked(other);
	await submitUnlock(other, PASSPHRASE);
	await expectHome(other);

	await accountMenu(page, 'Lock');
	await expectLocked(page);
	await expectLocked(other);
	expect(await other.evaluate(() => sessionStorage.getItem('yondrive.master'))).toBeNull();

	// And its sign-out, from the unlock screen.
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	await expect(other.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
