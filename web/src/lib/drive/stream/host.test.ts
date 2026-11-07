import { describe, expect, it, vi } from 'vitest';
import { contentHashOf } from '$lib/crypto/content';
import type { Bytes } from '$lib/crypto/encoding';
import { sealerFor, SUITE_E2E, SUITE_NONE, type Suite } from '$lib/crypto/sealer';
import { TAB_CHANNEL as ACCOUNT_CHANNEL } from '$lib/account/deps';
import { patterned, SUITES } from '$lib/testing/drive';
import {
	responseHeaders,
	StreamHost,
	TAB_CHANNEL,
	type StreamInfo,
	type WorkerMessage
} from './host';
import { fetchStoredBytes } from './worker-glue';

const FRAME = 1024;
const nodeKey = new Uint8Array(32).fill(9);

function storedVersion(suite: Suite, plaintext: Uint8Array) {
	const sealer = sealerFor(suite);
	const key = suite === SUITE_E2E ? nodeKey : new Uint8Array(0);
	const ref = { nodeId: 'n1', versionId: 'v1', frameSize: FRAME };
	const cipher = sealer.openVersion(key, ref);
	const frameCount = Math.max(1, Math.ceil(plaintext.length / FRAME));
	const parts: Uint8Array[] = [];
	const hashes = new Uint8Array(frameCount * 32);
	for (let i = 0; i < frameCount; i++) {
		const frame = cipher.sealFrame(
			{ index: i, final: i === frameCount - 1 },
			plaintext.subarray(i * FRAME, (i + 1) * FRAME)
		);
		parts.push(frame.data);
		hashes.set(frame.sha256, i * 32);
	}
	const stored = new Uint8Array(parts.reduce((total, p) => total + p.length, 0));
	let at = 0;
	for (const part of parts) {
		stored.set(part, at);
		at += part.length;
	}
	expect(contentHashOf(hashes).length).toBe(32);
	const info = (id: string, mime: string | null = null): StreamInfo => ({
		id,
		suite,
		ref,
		blobId: 'b1',
		size: plaintext.length,
		storedSize: stored.length,
		frameCount,
		hashes: hashes.slice().buffer,
		mime,
		filename: 'nämé.bin',
		key: sealer.versionKey(key, ref).buffer
	});
	return { stored, info };
}

function hostOver(
	stored: Uint8Array,
	ask: (id: string) => Promise<StreamInfo | null> = async () => null
) {
	const fetched: [number, number][] = [];
	const reports: WorkerMessage[] = [];
	const host = new StreamHost({
		fetchBytes: async (_blobId, start, end) => {
			fetched.push([start, end]);
			return stored.slice(start, end + 1) as Bytes;
		},
		askPages: ask,
		report: (message) => reports.push(message)
	});
	return { host, fetched, reports };
}

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe.each(SUITES)('the stream host in mode %s', (_, suite) => {
	const plaintext = patterned(FRAME * 3 + 10);
	const overhead = sealerFor(suite).frameOverhead;

	it('answers a whole request with every byte', async () => {
		const { stored, info } = storedVersion(suite, plaintext);
		const { host } = hostOver(stored);
		host.register(info('s1'));
		const res = await host.respond('s1', null);

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Length')).toBe(String(plaintext.length));
		expect(await bytesOf(res)).toEqual(plaintext);
	});

	it.each([
		['first bytes', 'bytes=0-9', 0, 9],
		['across a frame boundary', `bytes=${FRAME - 5}-${FRAME + 5}`, FRAME - 5, FRAME + 5],
		['the last bytes', 'bytes=-5', FRAME * 3 + 5, FRAME * 3 + 9],
		['a whole middle frame', `bytes=${FRAME}-${FRAME * 2 - 1}`, FRAME, FRAME * 2 - 1],
		['an open end', `bytes=${FRAME * 3}-`, FRAME * 3, FRAME * 3 + 9]
	])('answers %s', async (_label, range, start, end) => {
		const { stored, info } = storedVersion(suite, plaintext);
		const { host } = hostOver(stored);
		host.register(info('s1'));
		const res = await host.respond('s1', range);

		expect(res.status).toBe(206);
		expect(res.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/${plaintext.length}`);
		expect(res.headers.get('Accept-Ranges')).toBe('bytes');
		expect(await bytesOf(res)).toEqual(plaintext.subarray(start, end + 1));
	});

	it('fetches whole frames, and only those a range touches', async () => {
		const { stored, info } = storedVersion(suite, plaintext);
		const { host, fetched } = hostOver(stored);
		host.register(info('s1'));
		await bytesOf(await host.respond('s1', `bytes=${FRAME + 1}-${FRAME + 2}`));

		const stride = FRAME + overhead;
		expect(fetched).toEqual([[stride, stride * 2 - 1]]);
	});

	it('does not read ahead of what is asked for', async () => {
		const { stored, info } = storedVersion(suite, plaintext);
		const { host, fetched } = hostOver(stored);
		host.register(info('s1'));
		await host.respond('s1', null);
		expect(fetched).toEqual([]);
	});

	it('answers 416 outside the file', async () => {
		const { stored, info } = storedVersion(suite, plaintext);
		const { host } = hostOver(stored);
		host.register(info('s1'));
		const res = await host.respond('s1', `bytes=${plaintext.length}-`);
		expect(res.status).toBe(416);
		expect(res.headers.get('Content-Range')).toBe(`bytes */${plaintext.length}`);
	});

	it('serves an empty file', async () => {
		const { stored, info } = storedVersion(suite, new Uint8Array(0));
		const { host } = hostOver(stored);
		host.register(info('s1'));
		const res = await host.respond('s1', null);
		expect(res.status).toBe(200);
		expect((await bytesOf(res)).length).toBe(0);
	});

	it('asks the pages again after a restart', async () => {
		const { stored, info } = storedVersion(suite, plaintext);
		const ask = vi.fn(async (id: string) => info(id));
		const { host } = hostOver(stored, ask);
		const [a, b] = await Promise.all([
			host.respond('s1', 'bytes=0-1'),
			host.respond('s1', 'bytes=2-3')
		]);

		expect(ask).toHaveBeenCalledTimes(1);
		expect(await bytesOf(a)).toEqual(plaintext.subarray(0, 2));
		expect(await bytesOf(b)).toEqual(plaintext.subarray(2, 4));
	});

	it('answers 404 when no page has the stream, as after a lock', async () => {
		const { stored } = storedVersion(suite, plaintext);
		const { host } = hostOver(stored);
		expect((await host.respond('nope', null)).status).toBe(404);
	});

	it('releases a download once it has been read, and says so', async () => {
		const { stored, info } = storedVersion(suite, plaintext);
		const { host, reports } = hostOver(stored);
		host.register(info('s1'));
		await bytesOf(await host.respond('s1', null));
		expect(host.size).toBe(0);
		expect(reports).toEqual([{ type: 'stream-done', id: 's1' }]);
	});

	it('keeps a media stream for the next range', async () => {
		const { stored, info } = storedVersion(suite, plaintext);
		const { host } = hostOver(stored);
		host.register(info('s1', 'video/mp4'));
		await bytesOf(await host.respond('s1', null));
		expect(host.size).toBe(1);
	});

	it('errors the stream on a flipped byte, releases nothing of that frame and reports it', async () => {
		const { stored, info } = storedVersion(suite, plaintext);
		const flipped = stored.slice();
		flipped[FRAME + overhead + 1] ^= 1;
		const { host, reports } = hostOver(flipped);
		host.register(info('s1'));
		const res = await host.respond('s1', null);
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();

		const first = await reader.read();
		expect(first.value).toEqual(plaintext.subarray(0, FRAME));
		await expect(reader.read()).rejects.toThrow();
		expect(reports).toEqual([{ type: 'stream-error', id: 's1', integrity: true }]);
	});
});

it('stops serving on clear: the key goes at once', async () => {
	const { stored, info } = storedVersion(SUITE_E2E, patterned(FRAME * 2));
	const { host, reports } = hostOver(stored);
	host.register(info('s1'));
	const res = await host.respond('s1', null);
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	await reader.read();
	host.clear();

	await expect(reader.read()).rejects.toThrow();
	expect(host.size).toBe(0);
	expect(reports[0]).toMatchObject({ type: 'stream-error', integrity: false });
	expect((await host.respond('s1', null)).status).toBe(404);
});

it('zeroes the key it was given when released', () => {
	const { stored, info } = storedVersion(SUITE_E2E, patterned(10));
	const { host } = hostOver(stored);
	const given = info('s1');
	const view = new Uint8Array(given.key);
	host.register(given);
	expect(view.some((b) => b !== 0)).toBe(true);
	host.release('s1');
	expect(view.every((b) => b === 0)).toBe(true);
});

describe('response headers', () => {
	it('is only ever bytes for a download, with the name encoded', () => {
		const headers = responseHeaders({ mime: null, filename: 'a b"ñ.svg' });
		expect(headers.get('Content-Type')).toBe('application/octet-stream');
		expect(headers.get('Content-Disposition')).toBe(
			`attachment; filename*=UTF-8''a%20b%22%C3%B1.svg`
		);
		expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
	});

	it('encodes what RFC 8187 does not let through as it is', () => {
		const headers = responseHeaders({ mime: null, filename: "it's (a)*!.txt" });
		expect(headers.get('Content-Disposition')).toBe(
			`attachment; filename*=UTF-8''it%27s%20%28a%29%2A!.txt`
		);
	});

	it.each(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'video/mp4;x=<script>', ''])(
		'does not serve %s as itself',
		(mime) => {
			const headers = responseHeaders({ mime, filename: 'x' });
			expect(headers.get('Content-Type')).toBe('application/octet-stream');
			expect(headers.get('Content-Disposition')).toMatch(/^attachment/);
		}
	);

	it('serves media as media, inline', () => {
		const headers = responseHeaders({ mime: 'video/mp4', filename: 'x' });
		expect(headers.get('Content-Type')).toBe('video/mp4');
		expect(headers.get('Content-Disposition')).toMatch(/^inline/);
	});
});

describe('fetchStoredBytes', () => {
	it('asks for the range', async () => {
		const fetcher = vi.fn(async () => new Response(new Uint8Array([1]), { status: 206 }));
		await fetchStoredBytes('b1', 3, 9, undefined, fetcher as unknown as typeof fetch);
		const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(new Headers(init.headers).get('Range')).toBe('bytes=3-9');
	});

	it('gives up on a refusal at once', async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
		await expect(
			fetchStoredBytes('b1', 0, 1, undefined, fetcher as unknown as typeof fetch)
		).rejects.toThrow('403');
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});

it('listens on the channel the account layer announces locks on', () => {
	expect(TAB_CHANNEL).toBe(ACCOUNT_CHANNEL);
});

it('has an empty key in suite none', () => {
	const ref = { nodeId: 'n', versionId: 'v', frameSize: FRAME };
	expect(sealerFor(SUITE_NONE).versionKey(new Uint8Array(0), ref).length).toBe(0);
});
