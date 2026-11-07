/** What the Drive specs do through the app, the way a person would. */
import { expect, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PASSPHRASE, setUpServer, signIn, submitUnlock } from './flows';
import type { Mode, Server } from './server';

const FRAME = 4 * 1024 * 1024;

/** Sets up a server and signs in, up to a drive that is ready to use. */
export async function openDrive(page: Page, server: Server, mode: Mode): Promise<void> {
	await setUpServer(page, server, { mode });
	await signIn(page);
	await expectDriveReady(page);
}

export async function expectDriveReady(page: Page): Promise<void> {
	await expect(page.getByTestId('storage')).toBeVisible({ timeout: 30_000 });
}

/**
 * After a page load: sessionStorage is per tab and the server keeps one half of the
 * session key, so a tab may have to ask for the passphrase, in a mode that has one.
 */
export async function reopenDrive(page: Page): Promise<void> {
	const unlock = page.getByRole('heading', { name: 'Unlock' });
	const ready = page.getByTestId('storage');
	await expect(unlock.or(ready)).toBeVisible({ timeout: 30_000 });
	if (await unlock.isVisible()) await submitUnlock(page, PASSPHRASE);
	await expectDriveReady(page);
}

/** A file on disk, so that a second pick of it is the same file. */
export interface LocalFile {
	path: string;
	name: string;
	bytes: Buffer;
}

/** A throwaway directory of files for a spec. */
export async function fileBox() {
	const dir = await mkdtemp(join(tmpdir(), 'yondrive-e2e-files-'));
	return {
		dir,
		async add(name: string, bytes: Buffer): Promise<LocalFile> {
			const path = join(dir, name);
			await writeFile(path, bytes);
			return { path, name, bytes };
		},
		remove: () => rm(dir, { recursive: true, force: true })
	};
}

/** Bytes nothing could compress or guess, a few frames of them. */
export const multiFrame = (frames = 2.25): Buffer => randomBytes(Math.floor(FRAME * frames));

export const row = (page: Page, name: string): Locator =>
	page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });

/** The file names listed in the row of the upload panel, by its status. */
export const uploadRow = (page: Page, name: string): Locator =>
	page.getByTestId('upload-panel').locator('li').filter({ hasText: name });

export async function pickFiles(page: Page, files: LocalFile[]): Promise<void> {
	await page.getByTestId('upload-input').setInputFiles(files.map((file) => file.path));
}

/** Uploads files and waits until each is done and showing. */
export async function upload(page: Page, ...files: LocalFile[]): Promise<void> {
	await pickFiles(page, files);
	for (const file of files) {
		await expect(uploadRow(page, file.name)).toHaveAttribute('data-status', 'done', {
			timeout: 60_000
		});
		await expect(row(page, file.name)).toBeVisible();
	}
	await clearUploads(page);
}

/** Takes finished uploads off the panel, which floats over the end of the list. */
export async function clearUploads(page: Page): Promise<void> {
	// A finished queue folds into a pill after a few seconds, also while a toast covers
	// the button and the click is waiting: open it again, and try again.
	const pill = page.getByTestId('upload-pill');
	await expect(async () => {
		if (await pill.isVisible()) await pill.click({ timeout: 1000 });
		await page
			.getByTestId('upload-panel')
			.getByRole('button', { name: 'Clear', exact: true })
			.click({ timeout: 2000 });
	}).toPass({ timeout: 30_000 });
}

/** A click on a node's name, which opens it or downloads it. */
export const clickName = (page: Page, name: string) =>
	row(page, name)
		.getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
		.click();

/** Picks from a node's menu. */
export async function act(page: Page, name: string, item: string): Promise<void> {
	await page.getByRole('button', { name: `Actions for ${name}` }).click();
	await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Downloads through a node's menu and returns the bytes that arrived. */
export async function download(page: Page, name: string): Promise<Buffer> {
	const started = page.waitForEvent('download');
	await act(page, name, 'Download');
	return saved(await started);
}

export async function saved(download: {
	path(): Promise<string>;
	failure(): Promise<string | null>;
}): Promise<Buffer> {
	expect(await download.failure()).toBeNull();
	return readFile(await download.path());
}

export async function newFolder(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'New', exact: true }).click();
	await page.getByRole('menuitem', { name: 'New folder' }).click();
	const dialog = page.getByRole('dialog', { name: 'New folder' });
	await dialog.getByLabel('Name').fill(name);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(row(page, name)).toBeVisible();
}

export const openFolder = async (page: Page, name: string) => {
	await page.getByRole('link', { name: new RegExp(`^${name}`) }).click();
	await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
};

/** Goes to My files through the sidebar. */
export const myFiles = (page: Page) =>
	page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My files' }).click();

/** Runs a request from inside the page, as the app's own would be. */
export function inPage<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
	return page.evaluate(
		async ({ method, path, body }) => {
			const res = await fetch(`/api/v1${path}`, {
				method,
				headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
			const text = await res.text();
			return text === '' ? null : JSON.parse(text);
		},
		{ method, path, body }
	);
}
