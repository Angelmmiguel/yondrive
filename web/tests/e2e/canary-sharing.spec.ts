/**
 * The canary, for sharing: link keys, link passwords and the names of what is shared
 * never appear in what the browser sends, the server's data or its logs. In mode
 * `none` nothing is sealed, so names are on disk as the mode says, and the same flows
 * still keep a password out of everything, and a key does not exist.
 */
import { expect, test, type Page } from '@playwright/test';
import { act, clickName, fileBox, newFolder, openDrive, openFolder, row, upload } from '../drive';
import { captureRequests, findIn, scanDir } from '../scan';
import { startServer, type Mode, type Server } from '../server';
import {
	addUser,
	makeLink,
	openShared,
	person,
	refocus,
	shareDialog,
	shareWith,
	stranger
} from '../sharing';

const box = await fileBox();

test.afterAll(() => box.remove());

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe(`in mode ${mode}`, () => {
		let server: Server;

		test.beforeAll(async () => {
			server = await startServer({ mode });
		});

		test.afterAll(async () => {
			await server.stop();
		});

		test('link keys, link passwords and shared names stay on the device', async ({ browser }) => {
			test.setTimeout(240_000);
			const folderName = `canary-shared-folder-Vb62q8-${mode}`;
			const fileName = `canary-shared-file-Hj37s1-${mode}.txt`;
			const content = `canary shared content Lp94d6 ${mode} `.repeat(30);
			const password = `canary link password Nx58t2 ${mode}`;

			const alice = await (await browser.newContext({ acceptDownloads: true })).newPage();
			await openDrive(alice, server, mode);
			const bob = await addUser(browser, alice, server, 'bob', mode);

			const sent: string[][] = [];
			const watch = (page: Page) => sent.push(captureRequests(page));
			watch(alice);
			watch(bob);

			await newFolder(alice, folderName);
			await openFolder(alice, folderName);
			const file = await box.add(fileName, Buffer.from(content));
			await upload(alice, file);
			await alice
				.getByRole('navigation', { name: 'Breadcrumb' })
				.getByRole('link', { name: 'My files' })
				.click();

			// Shared with someone, who reads it.
			await shareWith(alice, folderName, 'bob', 'viewer');
			await expect(person(alice, 'bob')).toBeVisible();
			await shareDialog(alice, folderName).getByRole('button', { name: 'Done' }).click();
			await refocus(bob);
			await openShared(bob);
			await openFolder(bob, folderName);
			await clickName(bob, fileName);
			await expect(bob.getByTestId('viewer-text')).toContainText('canary shared content');
			await bob.getByRole('button', { name: 'Close', exact: true }).click();

			// Two links: one with its key in the address, one with a password.
			const open = await makeLink(alice, folderName);
			const locked = await makeLink(alice, folderName, { password });
			const fragment = new URL(open).hash.slice(1);
			expect(new URL(locked).hash).toBe('');
			if (mode === 'none') expect(fragment).toBe('');
			else expect(fragment).not.toBe('');

			const anyone = await stranger(browser);
			watch(anyone);
			await anyone.goto(open);
			await expect(anyone.getByRole('heading', { name: folderName })).toBeVisible({
				timeout: 30_000
			});

			// Once read, the key is out of everything the page keeps its address in.
			const page = await anyone.evaluate(() => ({
				href: location.href,
				title: document.title,
				state: JSON.stringify(history.state),
				referrer: document.referrer
			}));
			expect(new URL(page.href).hash).toBe('');
			expect(page.referrer).toBe('');
			const kept = Buffer.from([page.href, page.title, page.state].join('\n'));
			if (fragment !== '') expect(findIn(kept, { 'link key': fragment })).toEqual([]);

			// Whatever comes next gets no referrer, and going back finds no key in the history.
			const { pathname } = new URL(open);
			await anyone.evaluate(() => {
				const away = document.createElement('a');
				away.href = '/signin';
				away.setAttribute('data-sveltekit-reload', '');
				document.body.append(away);
				away.click();
			});
			await anyone.waitForURL('**/signin');
			expect(await anyone.evaluate(() => document.referrer)).toBe('');
			await anyone.goBack();
			expect(anyone.url()).toBe(`${server.url}${pathname}`);
			expect(sent.at(-1)?.join('\n')).not.toMatch(/"referer":"[^"]/);

			await anyone.goto(locked);
			await anyone.getByLabel(/^Password/).fill(password);
			await anyone.getByRole('button', { name: 'Open', exact: true }).click();
			const item = anyone.getByTestId('link-item').filter({ hasText: fileName });
			await item
				.getByRole('button', { name: new RegExp(`^${fileName}`) })
				.click({ timeout: 30_000 });
			await expect(anyone.getByTestId('viewer-text')).toContainText('canary shared content');

			// The rotation names everything again: nothing of that may go out either.
			await alice.goto(server.url);
			await expect(row(alice, folderName)).toBeVisible({ timeout: 30_000 });
			await act(alice, folderName, 'Share');
			const dialog = shareDialog(alice, folderName);
			await dialog.getByRole('button', { name: 'Revoke bob' }).click();
			await dialog.getByRole('button', { name: 'Revoke and replace keys' }).click();
			await expect(alice.getByText('no longer has access')).toBeVisible({ timeout: 30_000 });
			await dialog.getByRole('button', { name: 'Done' }).click();

			// The folder and the file in it, with the folder's two links sealed anew.
			const rotations = sent.flat().filter((one) => /^POST \S+\/rotate\n/.test(one));
			expect(rotations).toHaveLength(2);
			for (const body of rotations) expect(body).toContain('"wrapped_key"');
			expect(rotations[0]).toMatch(/"links":\[\{[^\]]*\},\{/);
			expect(findIn(Buffer.from(rotations.join('\n')), { password })).toEqual([]);
			if (fragment !== '') {
				expect(findIn(Buffer.from(rotations.join('\n')), { 'link key': fragment })).toEqual([]);
			}

			const requests = Buffer.from(sent.flat().join('\n'));
			const logs = Buffer.from(server.logs());
			const secrets: Record<string, string> = {
				password,
				...(fragment === '' ? {} : { 'link key': fragment })
			};
			const names = {
				'folder name': folderName,
				'file name': fileName,
				content: content.slice(0, 40)
			};

			// It looked at the real thing.
			expect(sent.flat().join('\n')).toContain('/api/v1/grants');
			expect(sent.flat().join('\n')).toContain('/unlock');
			expect(sent.flat().join('\n')).toContain('x-link-token');

			// Never, in any mode: in what was sent, on disk, or in the logs.
			expect(findIn(requests, secrets)).toEqual([]);
			expect(await scanDir(server.dataDir, secrets)).toEqual([]);
			expect(findIn(logs, { ...secrets, ...names })).toEqual([]);

			if (mode === 'e2e') {
				expect(findIn(requests, names)).toEqual([]);
				expect(await scanDir(server.dataDir, names)).toEqual([]);
				// A link's auth key is sent, and only ever a hash of it is kept.
				const unlock = sent.flat().find((one) => one.includes('/unlock'));
				const authKey = /"auth_key":"([^"]+)"/.exec(unlock ?? '')?.[1];
				expect(authKey).toBeDefined();
				expect(await scanDir(server.dataDir, { 'auth key': authKey as string })).toEqual([]);
			} else {
				// No encryption, and it says so: readable on disk, as the mode promises.
				const hits = await scanDir(server.dataDir, { 'file name': fileName });
				expect(hits).not.toEqual([]);
			}

			for (const page of [anyone, bob, alice]) await page.context().close();
		});
	});
}
