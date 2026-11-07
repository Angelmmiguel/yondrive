/**
 * Looks for secrets where they must not be: in the bytes of every file under a
 * directory, in the server's logs and in what the browser sent.
 */
import type { Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The forms a string could be found in: as it is, percent-encoded, and in the
 * API's base64 at each of the three alignments it can have inside a longer
 * encoded value (and in its URL-safe alphabet). Only the characters a neighbour
 * cannot change are kept for the shifted ones.
 */
function needles(text: string): Buffer[] {
	const bytes = Buffer.from(text);
	const found = new Set<string>([text, encodeURIComponent(text)]);
	for (const lead of [0, 1, 2]) {
		const encoded = Buffer.concat([Buffer.alloc(lead), bytes])
			.toString('base64')
			.replace(/=+$/, '');
		const whole = (lead + bytes.length) % 3 === 0;
		const stable = encoded.slice(Math.ceil((lead * 8) / 6), whole ? undefined : -1);
		found.add(stable);
		found.add(stable.replaceAll('+', '-').replaceAll('/', '_'));
	}
	return [...found].filter((s) => s !== '').map((s) => Buffer.from(s));
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

/** Collects the address, headers and body of every request a page sends from now on. */
export function captureRequests(page: Page): string[] {
	const sent: string[] = [];
	page.on('request', (request) => {
		sent.push(
			`${request.method()} ${request.url()}\n${JSON.stringify(request.headers())}\n${request.postData() ?? ''}`
		);
	});
	return sent;
}
