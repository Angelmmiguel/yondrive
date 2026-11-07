/** What the sharing specs do through the app, with two people at two browsers. */
import { expect, type Browser, type Page } from '@playwright/test';
import { act, expectDriveReady, inPage, reopenDrive, row } from './drive';
import { createInvite, register, signIn } from './flows';
import type { Mode, Server } from './server';

/** Someone at their own browser, signed in, with a drive that is ready. */
export async function addUser(
	browser: Browser,
	admin: Page,
	server: Server,
	username: string,
	mode: Mode
): Promise<Page> {
	const link = await createInvite(admin);
	await admin.goto(server.url);
	await reopenDrive(admin);
	const context = await browser.newContext({ acceptDownloads: true });
	const page = await context.newPage();
	await register(page, link, username, undefined, mode === 'e2e');
	await page.getByRole('link', { name: 'Go to sign in' }).click();
	await signIn(page, username);
	await expectDriveReady(page);
	return page;
}

/** Reads the journal now, as a person coming back to the tab does. */
export async function refocus(page: Page): Promise<void> {
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

export const shareDialog = (page: Page, name: string) =>
	page.getByRole('dialog', { name: `Share ${name}` });

/** Shares a node from its row, leaving the dialog open. */
export async function shareWith(
	page: Page,
	name: string,
	username: string,
	role: 'viewer' | 'editor' = 'viewer'
): Promise<void> {
	await act(page, name, 'Share');
	const dialog = shareDialog(page, name);
	await dialog.getByLabel('Username').fill(username);
	await dialog.getByLabel('Role', { exact: true }).selectOption(role);
	await dialog.getByRole('button', { name: 'Share', exact: true }).click();
}

export const person = (page: Page, username: string) =>
	page.getByTestId('person').filter({ hasText: username });

/** Goes to Shared with me through the sidebar. */
export async function openShared(page: Page): Promise<void> {
	await page
		.getByRole('navigation', { name: 'Main' })
		.getByRole('link', { name: /^Shared with me/ })
		.click();
	await expect(page.getByRole('heading', { name: 'Shared with me' })).toBeVisible();
}

/** The id of a node a row shows, from its folder link or by asking the tree of the owner. */
export async function nodeIdOf(page: Page, name: string): Promise<string> {
	const href = await row(page, name).getByRole('link').first().getAttribute('href');
	const id = href?.split('/').pop();
	if (id === undefined) throw new Error(`${name} is not a folder link`);
	return id;
}

export interface WireNode {
	id: string;
	owner_id: string;
	parent_id?: string;
	key_generation: number;
	wrapped_key: string;
	sealed_metadata: string;
	role?: string;
	current_version?: string;
	thumb_blob_id?: string;
}

export const getNode = (page: Page, id: string) => inPage<WireNode>(page, 'GET', `/nodes/${id}`);

export async function childrenOf(page: Page, id: string): Promise<WireNode[]> {
	const { nodes } = await inPage<{ nodes: WireNode[] }>(page, 'GET', `/nodes/${id}/children`);
	return nodes;
}

/** The status a request gets from inside the page, as the app's own would. */
export function statusOf(page: Page, method: string, path: string, body?: unknown) {
	return page.evaluate(
		async ({ method, path, body }) => {
			const res = await fetch(`/api/v1${path}`, {
				method,
				headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			return res.status;
		},
		{ method, path, body }
	);
}

/** Makes a public link from a row, and returns its address. */
export async function makeLink(
	page: Page,
	name: string,
	options: { password?: string; limit?: number } = {}
): Promise<string> {
	await act(page, name, 'Share');
	const dialog = shareDialog(page, name);
	await dialog.getByRole('tab', { name: 'Public link' }).click();
	if (options.password !== undefined) {
		await dialog.getByLabel('Link password').fill(options.password);
	}
	if (options.limit !== undefined) {
		await dialog.getByLabel('Downloads').fill(String(options.limit));
	}
	await dialog.getByRole('button', { name: 'Create link' }).click();
	const code = dialog.getByTestId('link-url').locator('pre, code').first();
	await expect(code).toBeVisible({ timeout: 30_000 });
	const url = (await code.innerText()).trim();
	await dialog.getByRole('button', { name: 'Done' }).click();
	await expect(dialog).toHaveCount(0);
	return url;
}

/** Someone with no account: a fresh browser that has never seen this server. */
export async function stranger(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ acceptDownloads: true });
	return context.newPage();
}
