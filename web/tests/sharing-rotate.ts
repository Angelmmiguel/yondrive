/** A rotation, from sharing with someone and revoking them through the app. */
import { expect, type Browser, type Page } from '@playwright/test';
import { act } from './drive';
import type { Server } from './server';
import { addUser, getNode, person, shareDialog, shareWith } from './sharing';

export async function rotate(
	owner: Page,
	browser: Browser,
	server: Server,
	name: string,
	id: string
): Promise<void> {
	const before = (await getNode(owner, id)).key_generation;
	const guest = await addUser(browser, owner, server, `guest${before}`, server.mode);
	await guest.context().close();
	await shareWith(owner, name, `guest${before}`, 'viewer');
	await expect(person(owner, `guest${before}`)).toBeVisible();
	await shareDialog(owner, name).getByRole('button', { name: 'Done' }).click();
	await act(owner, name, 'Share');
	const dialog = shareDialog(owner, name);
	await dialog.getByRole('button', { name: `Revoke guest${before}` }).click();
	await dialog.getByRole('button', { name: 'Revoke and replace keys' }).click();
	await expect(owner.getByText('no longer has access')).toBeVisible({ timeout: 30_000 });
	await dialog.getByRole('button', { name: 'Done' }).click();
	expect((await getNode(owner, id)).key_generation).toBe(before + 1);
}
