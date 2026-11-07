/** What the document specs do in the editor, the way a person would. */
import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clickName, reopenDrive, saved } from './drive';
import type { Server } from './server';
import { decodeXml } from '../src/lib/formats/xml';
import { entryData, readZip } from '../src/lib/formats/zip';

export const fixture = (name: string) =>
	readFile(new URL(`./fixtures/${name}`, import.meta.url)).then((b) => Buffer.from(b));

export const editor = (page: Page) => page.getByRole('textbox', { name: 'Document' });
export const saveStatus = (page: Page) => page.getByTestId('save-status');

/** Opens a file from the list on screen in the editor, and waits until it can be typed in. */
export async function openDoc(page: Page, name: string): Promise<void> {
	await clickName(page, name);
	await expect(editor(page)).toBeVisible({ timeout: 30_000 });
}

/** Saves now rather than when typing pauses, and waits until it is saved. */
export async function saveNow(page: Page): Promise<void> {
	await editor(page).press('Control+s');
	await expect(saveStatus(page)).toHaveText('Saved', { timeout: 30_000 });
}

/** Puts the caret right after `text` in the document, and types there. */
export async function typeAfter(page: Page, text: string, typed: string): Promise<void> {
	await editor(page).evaluate((el, text) => {
		(el as HTMLElement).focus();
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const at = (n.textContent ?? '').indexOf(text);
			if (at < 0) continue;
			const range = document.createRange();
			range.setStart(n, at + text.length);
			range.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			return;
		}
		throw new Error(`not in the document: ${text}`);
	}, text);
	// The editor takes the selection from the page on its next turn.
	await page.waitForTimeout(50);
	await page.keyboard.type(typed);
}

/** A fresh page load, back to Home, as after closing the tab. */
export async function reloadHome(page: Page, server: Server): Promise<void> {
	await page.goto(server.url);
	await reopenDrive(page);
}

/** The file as the editor's Download menu gives it. */
export async function downloadAs(page: Page, item: RegExp): Promise<Buffer> {
	const started = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download', exact: true }).click();
	await page.getByRole('menuitem', { name: item }).click();
	return saved(await started);
}

/** Each entry of a package: its local record, and its text if it is XML. */
export async function parts(buf: Buffer): Promise<Map<string, { local: Buffer; text: string }>> {
	const zip = readZip(new Uint8Array(buf));
	const out = new Map<string, { local: Buffer; text: string }>();
	for (const e of zip.entries) {
		const text = e.name.endsWith('.xml') ? decodeXml(await entryData(e)) : '';
		out.set(e.name, { local: Buffer.from(e.local), text });
	}
	return out;
}

/** What differs between two texts: the part of each between their common start and end. */
export function changedWindow(a: string, b: string): { before: string; after: string } {
	let s = 0;
	while (s < a.length && s < b.length && a[s] === b[s]) s++;
	let e = 0;
	while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
	return { before: a.slice(s, a.length - e), after: b.slice(s, b.length - e) };
}

/** The id of the document on screen, from the address. */
export const docId = (page: Page) => new URL(page.url()).pathname.split('/').pop() as string;
