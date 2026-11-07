/**
 * What only exists with keys: a server handing out a false key, a forged signature
 * on a grant, and the number two people compare.
 */
import { expect, test, type Page, type Request } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { newFolder, openDrive, row } from '../drive';
import { startServer, type Server } from '../server';
import { addUser, openShared, person, refocus, shareDialog, shareWith } from '../sharing';
import { act } from '../drive';

test.describe.serial('with keys', () => {
	let server: Server;
	let alice: Page;
	let bob: Page;

	test.beforeAll(async ({ browser }) => {
		test.setTimeout(180_000);
		server = await startServer({ mode: 'e2e' });
		alice = await (await browser.newContext()).newPage();
		await openDrive(alice, server, 'e2e');
		bob = await addUser(browser, alice, server, 'bob', 'e2e');
		await newFolder(alice, 'First');
		await newFolder(alice, 'Second');
	});

	test.afterAll(async () => {
		await bob.context().close();
		await alice.context().close();
		await server.stop();
	});

	test('a safety number is the same on both sides', async () => {
		await shareWith(alice, 'First', 'bob', 'viewer');
		const dialog = shareDialog(alice, 'First');
		await person(alice, 'bob').getByRole('button', { name: 'Safety number' }).click();
		const screen = alice.getByRole('dialog', { name: 'Safety number with bob' });
		const hers = (await screen.getByTestId('safety-number').locator('li').allTextContents()).join(
			' '
		);
		expect(hers).toMatch(/^(\d{5} ){11}\d{5}$/);
		await screen.getByRole('checkbox').check();
		await screen.getByRole('button', { name: 'Done' }).click();
		await dialog.getByRole('button', { name: 'Done' }).click();

		await refocus(bob);
		await openShared(bob);
		await expect(row(bob, 'First')).toBeVisible();
		await bob.getByTestId('share-from').getByRole('button', { name: 'Safety number' }).click();
		const his = bob.getByRole('dialog', { name: 'Safety number with admin' });
		expect((await his.getByTestId('safety-number').locator('li').allTextContents()).join(' ')).toBe(
			hers
		);
		await his.getByRole('button', { name: 'Done' }).click();
	});

	test('a swapped public key stops everything, and nothing is shared', async () => {
		const grants: string[] = [];
		alice.on('request', (request) => {
			if (request.method() === 'POST' && request.url().endsWith('/api/v1/grants')) {
				grants.push(request.url());
			}
		});
		await alice.route('**/api/v1/users/lookup*', async (route) => {
			const response = await route.fetch();
			const found = await response.json();
			found.public_keys.x25519 = randomBytes(32).toString('base64');
			await route.fulfill({ response, json: found });
		});

		await shareWith(alice, 'Second', 'bob', 'viewer');
		const warning = alice.getByRole('dialog', { name: 'The keys of bob have changed' });
		await expect(warning).toBeVisible();
		await expect(warning.getByTestId('safety-number-new')).toBeVisible();
		// It cannot be waved away: Escape does nothing, and it takes an answer.
		await alice.keyboard.press('Escape');
		await expect(warning).toBeVisible();
		await warning.getByRole('button', { name: 'Keep the old keys' }).click();
		await expect(warning).toHaveCount(0);
		expect(grants).toEqual([]);
		await expect(person(alice, 'bob')).toHaveCount(0);

		// Trying again runs into it again, until the keys are what they were.
		const dialog = shareDialog(alice, 'Second');
		await dialog.getByRole('button', { name: 'Share', exact: true }).click();
		await expect(warning).toBeVisible();
		await warning.getByRole('button', { name: 'Keep the old keys' }).click();
		expect(grants).toEqual([]);

		await alice.unroute('**/api/v1/users/lookup*');
		await dialog.getByRole('button', { name: 'Share', exact: true }).click();
		await expect(person(alice, 'bob')).toBeVisible();
		await expect(warning).toHaveCount(0);
		expect(grants).toHaveLength(1);
		await dialog.getByRole('button', { name: 'Done' }).click();
	});

	test('another account answering to a known name stops everything', async () => {
		await newFolder(alice, 'Third');
		const grants: string[] = [];
		const watch = (request: Request) => {
			if (request.method() === 'POST' && request.url().endsWith('/api/v1/grants')) {
				grants.push(request.url());
			}
		};
		alice.on('request', watch);
		await alice.route('**/api/v1/users/lookup*', async (route) => {
			const response = await route.fetch();
			const found = await response.json();
			found.id = 'f'.repeat(32);
			found.public_keys.x25519 = randomBytes(32).toString('base64');
			found.public_keys.ed25519 = randomBytes(32).toString('base64');
			await route.fulfill({ response, json: found });
		});

		await shareWith(alice, 'Third', 'bob', 'viewer');
		const warning = alice.getByRole('dialog', {
			name: 'A different account is using the name bob'
		});
		await expect(warning).toBeVisible();
		await expect(warning.getByTestId('safety-number-new')).toBeVisible();
		await alice.keyboard.press('Escape');
		await expect(warning).toBeVisible();
		await warning.getByRole('button', { name: 'Keep what this device knows' }).click();
		await expect(warning).toHaveCount(0);
		expect(grants).toEqual([]);
		await expect(person(alice, 'bob')).toHaveCount(0);

		// What is pinned has not moved: the real account still goes through.
		await alice.unroute('**/api/v1/users/lookup*');
		const dialog = shareDialog(alice, 'Third');
		await dialog.getByRole('button', { name: 'Share', exact: true }).click();
		await expect(person(alice, 'bob')).toBeVisible();
		expect(grants).toHaveLength(1);
		alice.off('request', watch);
		await dialog.getByRole('button', { name: 'Done' }).click();
	});

	test('a grant with a tampered signature is refused, and not opened', async () => {
		await bob.route('**/api/v1/shared-with-me*', async (route) => {
			const response = await route.fetch();
			const page = await response.json();
			for (const item of page.items) {
				const signature = Buffer.from(item.grant.signature, 'base64');
				signature[0] ^= 1;
				item.grant.signature = signature.toString('base64');
			}
			await route.fulfill({ response, json: page });
		});
		await bob.goto(`${server.url}/shared`);
		await expect(bob.getByTestId('unverified-share').first()).toContainText(
			'signature does not check out',
			{ timeout: 30_000 }
		);
		await expect(row(bob, 'First')).toHaveCount(0);
		await bob.unroute('**/api/v1/shared-with-me*');
	});

	test('a role changed by the server breaks the signature', async () => {
		await bob.route('**/api/v1/shared-with-me*', async (route) => {
			const response = await route.fetch();
			const page = await response.json();
			for (const item of page.items) item.grant.role = 'editor';
			await route.fulfill({ response, json: page });
		});
		await bob.goto(`${server.url}/shared`);
		await expect(bob.getByTestId('unverified-share').first()).toBeVisible({ timeout: 30_000 });
		await expect(row(bob, 'First')).toHaveCount(0);
		await bob.unroute('**/api/v1/shared-with-me*');
	});

	test('a granter whose keys changed raises the warning for whoever holds the grant', async () => {
		await bob.route('**/api/v1/users/*/keys', async (route) => {
			const response = await route.fetch();
			const found = await response.json();
			found.public_keys.ed25519 = randomBytes(32).toString('base64');
			await route.fulfill({ response, json: found });
		});
		await bob.goto(`${server.url}/shared`);
		const warning = bob.getByRole('dialog', { name: 'The keys of admin have changed' });
		await expect(warning).toBeVisible({ timeout: 30_000 });
		await warning.getByRole('button', { name: 'Keep the old keys' }).click();
		await expect(bob.getByTestId('unverified-share').first()).toContainText('have changed');
		await bob.unroute('**/api/v1/users/*/keys');

		await bob.goto(`${server.url}/shared`);
		await expect(row(bob, 'First')).toBeVisible({ timeout: 30_000 });
	});

	test('a grant from another account with a known name is not believed', async () => {
		const other = 'f'.repeat(32);
		await bob.route('**/api/v1/shared-with-me*', async (route) => {
			const response = await route.fetch();
			const page = await response.json();
			for (const item of page.items) {
				item.grant.granter_id = other;
				item.node.owner_id = other;
			}
			await route.fulfill({ response, json: page });
		});
		await bob.route(`**/api/v1/users/${other}/keys`, (route) =>
			route.fulfill({
				json: {
					user_id: other,
					username: 'admin',
					public_keys: {
						x25519: randomBytes(32).toString('base64'),
						ed25519: randomBytes(32).toString('base64')
					}
				}
			})
		);

		await bob.goto(`${server.url}/shared`);
		const warning = bob.getByRole('dialog', {
			name: 'A different account is using the name admin'
		});
		await expect(warning).toBeVisible({ timeout: 30_000 });
		await warning.getByRole('button', { name: 'Keep what this device knows' }).click();
		await expect(bob.getByTestId('unverified-share').first()).toContainText('have changed');
		await expect(row(bob, 'First')).toHaveCount(0);

		await bob.unroute('**/api/v1/shared-with-me*');
		await bob.unroute(`**/api/v1/users/${other}/keys`);
		await bob.goto(`${server.url}/shared`);
		await expect(row(bob, 'First')).toBeVisible({ timeout: 30_000 });
	});

	test('revoking one person leaves the other with a new, signed key', async ({ browser }) => {
		const carol = await addUser(browser, alice, server, 'carol', 'e2e');
		await shareWith(alice, 'First', 'carol', 'viewer');
		await expect(person(alice, 'carol')).toBeVisible();
		await shareDialog(alice, 'First').getByRole('button', { name: 'Done' }).click();

		await act(alice, 'First', 'Share');
		const dialog = shareDialog(alice, 'First');
		await dialog.getByRole('button', { name: 'Revoke bob' }).click();
		await dialog.getByRole('button', { name: 'Revoke and replace keys' }).click();
		await expect(alice.getByText('no longer has access')).toBeVisible({ timeout: 30_000 });
		await dialog.getByRole('button', { name: 'Done' }).click();

		await carol.goto(`${server.url}/shared`);
		await expect(row(carol, 'First')).toBeVisible({ timeout: 30_000 });
		await expect(carol.getByTestId('unverified-share')).toHaveCount(0);
		await carol.context().close();
	});
});
