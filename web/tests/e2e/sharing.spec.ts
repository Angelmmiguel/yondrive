/**
 * Two people share in both modes: the same flows, whether or not anything is sealed.
 * The server enforces roles, so what is tried here is also tried against the API.
 */
import { expect, test, type Page } from '@playwright/test';
import {
	act,
	clickName,
	fileBox,
	inPage,
	newFolder,
	openDrive,
	openFolder,
	row,
	upload
} from '../drive';
import { PASSPHRASE } from '../flows';
import { startServer, type Mode, type Server } from '../server';
import {
	addUser,
	childrenOf,
	getNode,
	nodeIdOf,
	openShared,
	person,
	refocus,
	shareDialog,
	shareWith,
	statusOf,
	type WireNode
} from '../sharing';
import { decodeBase64 } from '../../src/lib/crypto/encoding';
import { deriveRoot, expandRoot, parseKdfParams } from '../../src/lib/crypto/kdf';
import { openIdentity, unwrapMasterKey } from '../../src/lib/crypto/keys';
import { openNodeKeyFrom, unwrapNodeKey } from '../../src/lib/crypto/node';
import { openMetadata } from '../../src/lib/crypto/metadata';

const box = await fileBox();

test.afterAll(() => box.remove());

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`in mode ${mode}`, () => {
		let server: Server;
		let alice: Page;
		let bob: Page;
		let folderId = '';
		const folder = `Project ${mode}`;
		const inner = `Inner ${mode}`;
		const secret = `what is in the shared file, ${mode}`;
		const fileName = `plan-${mode}.txt`;

		test.beforeAll(async ({ browser }) => {
			test.setTimeout(180_000);
			server = await startServer({ mode });
			alice = await (await browser.newContext({ acceptDownloads: true })).newPage();
			await openDrive(alice, server, mode);
			bob = await addUser(browser, alice, server, 'bob', mode);
			await newFolder(alice, folder);
			folderId = await nodeIdOf(alice, folder);
			await openFolder(alice, folder);
			await newFolder(alice, inner);
			await upload(alice, await box.add(fileName, Buffer.from(secret)));
		});

		test.afterAll(async () => {
			await bob.context().close();
			await alice.context().close();
			await server.stop();
		});

		test('sharing as a viewer: it arrives, verified, and reads', async () => {
			await alice
				.getByRole('navigation', { name: 'Breadcrumb' })
				.getByRole('link', { name: 'My files' })
				.click();
			await shareWith(alice, folder, 'bob', 'viewer');
			const dialog = shareDialog(alice, folder);
			await expect(person(dialog.page(), 'bob')).toBeVisible();
			await dialog.getByRole('button', { name: 'Done' }).click();
			// The row shows who has it.
			await expect(row(alice, folder).getByRole('img', { name: 'bob' })).toBeVisible();

			await refocus(bob);
			await expect(bob.getByTestId('notifications')).toHaveAccessibleName('Notifications, 1 new');
			const sidebar = bob.getByRole('navigation', { name: 'Main' });
			await expect(sidebar.getByRole('link', { name: /^Shared with me/ })).toContainText('1');

			await bob.getByTestId('notifications').click();
			await expect(bob.getByRole('menuitem', { name: `admin shared ${folder}` })).toBeVisible();
			await bob.keyboard.press('Escape');

			await openShared(bob);
			await expect(row(bob, folder)).toBeVisible();
			await expect(bob.getByTestId('share-from')).toContainText('you can view');
			await expect(bob.getByTestId('unverified-share')).toHaveCount(0);
			// Opening the page reads what was unread.
			await expect(bob.getByTestId('notifications')).toHaveAccessibleName('Notifications');

			await openFolder(bob, folder);
			await expect(bob.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
				'Shared with me'
			);
			await expect(row(bob, inner)).toBeVisible();
			await clickName(bob, fileName);
			await expect(bob.getByTestId('viewer-text')).toHaveText(secret);
			await bob.getByRole('button', { name: 'Close', exact: true }).click();
		});

		test('a viewer is offered nothing that writes, and the server refuses it too', async () => {
			await expect(bob.getByRole('button', { name: 'New folder here' })).toHaveCount(0);
			await expect(bob.getByRole('button', { name: 'Upload', exact: true })).toHaveCount(0);
			await expect(bob.getByRole('button', { name: `Favorite ${fileName}` })).toHaveCount(0);

			await bob.getByRole('button', { name: `Actions for ${fileName}` }).click();
			const items = await bob.getByRole('menuitem').allTextContents();
			expect(items.map((item) => item.trim())).toEqual(['Open', 'Download', 'Versions']);
			await bob.keyboard.press('Escape');

			// Hiding a button is manners; this is the rule.
			const [child] = await childrenOf(bob, folderId);
			expect(
				await statusOf(bob, 'PATCH', `/nodes/${child.id}`, {
					suite: mode === 'e2e' ? 'xchacha20poly1305-v1' : 'none',
					sealed_metadata: 'AAAA'
				})
			).toBe(403);
			expect(await statusOf(bob, 'POST', `/nodes/${child.id}/trash`)).toBe(403);
		});

		test('an editor adds to the folder, and cannot take it from where it lives', async () => {
			await alice.getByRole('button', { name: `Actions for ${folder}` }).click();
			await alice.getByRole('menuitem', { name: 'Share' }).click();
			const dialog = shareDialog(alice, folder);
			await person(alice, 'bob').getByLabel('Role of bob').selectOption('editor');
			await expect(person(alice, 'bob').getByLabel('Role of bob')).toHaveValue('editor');
			await dialog.getByRole('button', { name: 'Done' }).click();

			await refocus(bob);
			await expect(bob.getByRole('button', { name: 'New folder here' })).toBeVisible();
			const theirs = await box.add(`from-bob-${mode}.txt`, Buffer.from(`bob wrote this, ${mode}`));
			await upload(bob, theirs);

			// Inside, a rename works. The top of the share only the owner can move.
			await act(bob, theirs.name, 'Rename');
			const rename = bob.getByRole('dialog', { name: 'Rename' });
			await rename.getByLabel('Name').fill(`renamed-${theirs.name}`);
			await rename.getByRole('button', { name: 'Rename' }).click();
			await expect(row(bob, `renamed-${theirs.name}`)).toBeVisible();

			await openShared(bob);
			await bob.getByRole('button', { name: `Actions for ${folder}` }).click();
			await expect(bob.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
			await expect(bob.getByRole('menuitem', { name: 'Move to trash' })).toHaveCount(0);
			await bob.keyboard.press('Escape');
			expect(await statusOf(bob, 'POST', `/nodes/${folderId}/trash`)).toBe(403);

			// The owner reads what the editor signed.
			await alice.goto(`${server.url}/files/${folderId}`);
			await expect(row(alice, `renamed-${theirs.name}`)).toBeVisible({ timeout: 30_000 });
			await clickName(alice, `renamed-${theirs.name}`);
			await expect(alice.getByTestId('viewer-text')).toHaveText(`bob wrote this, ${mode}`);
			await alice.getByRole('button', { name: 'Close', exact: true }).click();
		});

		test('revoking rotates from the top down, and what stays still reads', async () => {
			// What Bob holds right now, for the end of this test.
			const heldGrant = await inPage<{
				items: { grant: { sealed_key: string }; node: WireNode }[];
			}>(bob, 'GET', '/shared-with-me');
			const before = await childrenOf(alice, folderId);

			await alice
				.getByRole('navigation', { name: 'Breadcrumb' })
				.getByRole('link', { name: 'My files' })
				.click();
			await act(alice, folder, 'Share');
			const dialog = shareDialog(alice, folder);
			await dialog.getByRole('button', { name: 'Revoke bob' }).click();
			await expect(dialog.getByText('may still be with them')).toBeVisible();
			await dialog.getByRole('button', { name: 'Revoke and replace keys' }).click();
			await expect(alice.getByText('no longer has access')).toBeVisible({ timeout: 30_000 });
			await expect(person(alice, 'bob')).toHaveCount(0);
			await dialog.getByRole('button', { name: 'Done' }).click();
			await expect(row(alice, folder).getByText('Only you')).toBeVisible();

			// Every node has moved on, the shared one and all under it.
			expect((await getNode(alice, folderId)).key_generation).toBe(2);
			for (const child of await childrenOf(alice, folderId)) {
				expect(child.key_generation, child.id).toBe(2);
			}

			// Bob's access is over, on his screen and at the API.
			await refocus(bob);
			await expect(row(bob, folder)).toHaveCount(0);
			expect(await statusOf(bob, 'GET', `/nodes/${folderId}`)).toBe(404);

			// The owner still reads what was there, down the key chain.
			await alice.goto(`${server.url}/files/${folderId}`);
			await expect(row(alice, fileName)).toBeVisible({ timeout: 30_000 });
			await clickName(alice, fileName);
			await expect(alice.getByTestId('viewer-text')).toHaveText(secret);
			await alice.getByRole('button', { name: 'Close', exact: true }).click();

			// A new file, under the new key, is out of reach of the key Bob may have kept.
			const after = await box.add(`after-${mode}.txt`, Buffer.from(`after revoking, ${mode}`));
			await upload(alice, after);
			if (mode === 'e2e') {
				const kept = await keptKey(bob, heldGrant.items[0].grant.sealed_key, folderId);
				const old = before[0];
				expect(unwrapNodeKey(decodeBase64(old.wrapped_key), kept, folderId, old.id)).toHaveLength(
					32
				);
				const current = await childrenOf(alice, folderId);
				const fresh = current.find((node) => !before.some((n) => n.id === node.id));
				expect(fresh).toBeDefined();
				expect(() =>
					unwrapNodeKey(
						decodeBase64((fresh as WireNode).wrapped_key),
						kept,
						folderId,
						(fresh as WireNode).id
					)
				).toThrow();
				const top = await getNode(alice, folderId);
				expect(() => openMetadata(kept, folderId, decodeBase64(top.sealed_metadata))).toThrow();
			}
		});

		test('a grant from someone who does not own the node is refused', async () => {
			await alice
				.getByRole('navigation', { name: 'Breadcrumb' })
				.getByRole('link', { name: 'My files' })
				.click();
			await shareWith(alice, folder, 'bob', 'viewer');
			await expect(person(alice, 'bob')).toBeVisible();
			await shareDialog(alice, folder).getByRole('button', { name: 'Done' }).click();

			await bob.route('**/api/v1/shared-with-me*', async (route) => {
				const response = await route.fetch();
				const page = await response.json();
				for (const item of page.items) item.grant.granter_id = item.node.id;
				await route.fulfill({ response, json: page });
			});
			await bob.goto(`${server.url}/shared`);
			const warning = bob.getByTestId('unverified-share');
			await expect(warning).toBeVisible({ timeout: 30_000 });
			await expect(warning).toContainText('does not own');
			await expect(row(bob, folder)).toHaveCount(0);

			await bob.goto(`${server.url}/files/${folderId}`);
			await expect(bob.getByText('could not be verified')).toBeVisible({ timeout: 30_000 });
			await bob.unroute('**/api/v1/shared-with-me*');
		});

		test('someone can give up what was shared with them', async () => {
			await bob.goto(`${server.url}/shared`);
			await expect(row(bob, folder)).toBeVisible({ timeout: 30_000 });
			await act(bob, folder, 'Remove from shared');
			await expect(row(bob, folder)).toHaveCount(0);
			expect(await statusOf(bob, 'GET', `/nodes/${folderId}`)).toBe(404);
		});
	});
}

/**
 * The node key someone could have kept from their grant: derived the way their own
 * device does, from the passphrase and what the server holds for them.
 */
async function keptKey(page: Page, sealedKey: string, nodeId: string) {
	const me = await inPage<{
		kdf: unknown;
		keys: {
			wrapped_master_key: string;
			sealed_x25519: string;
			sealed_ed25519: string;
			public_keys: { x25519: string; ed25519: string };
		};
	}>(page, 'GET', '/me');
	const { kek } = expandRoot(deriveRoot(PASSPHRASE, parseKdfParams(me.kdf)));
	const master = unwrapMasterKey(decodeBase64(me.keys.wrapped_master_key), kek, 'passphrase');
	const identity = openIdentity(
		{
			publicKeys: {
				x25519: decodeBase64(me.keys.public_keys.x25519),
				ed25519: decodeBase64(me.keys.public_keys.ed25519)
			},
			sealedX25519: decodeBase64(me.keys.sealed_x25519),
			sealedEd25519: decodeBase64(me.keys.sealed_ed25519)
		},
		master
	);
	return openNodeKeyFrom(decodeBase64(sealedKey), identity.x25519, nodeId);
}
