/**
 * Looks for secrets where they must not be: in the bytes of every file under a
 * directory, in the server's logs and in what the browser sent.
 */
import type { Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The forms a string could be found in: as it is, and in the API's encoding. */
function needles(text: string): Buffer[] {
	return [Buffer.from(text), Buffer.from(Buffer.from(text).toString('base64'))];
}

/** Which of `secrets` appear in `haystack`, named by their keys. */
export function findIn(haystack: Buffer, secrets: Record<string, string>): string[] {
	return Object.entries(secrets)
		.filter(([, text]) => needles(text).some((needle) => haystack.includes(needle)))
		.map(([name]) => name);
}

/** `file: name` for each secret found in any file under `dir`, the write-ahead log included. */
export async function scanDir(dir: string, secrets: Record<string, string>): Promise<string[]> {
	const hits: string[] = [];
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		for (const name of findIn(await readFile(path), secrets)) hits.push(`${entry.name}: ${name}`);
	}
	return hits;
}

/** Collects the address and body of every request a page sends from now on. */
export function captureRequests(page: Page): string[] {
	const sent: string[] = [];
	page.on('request', (request) => {
		sent.push(`${request.method()} ${request.url()}\n${request.postData() ?? ''}`);
	});
	return sent;
}
