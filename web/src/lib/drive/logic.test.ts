import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Change } from '$lib/api/types';
import { changedNodes, ChangeFeed, revokedNotRotated } from './journal';
import { categoryOf, extensionOf, fileKindOf, inferType } from './kinds';
import { parseMetadata, parseRootMetadata, rawMetadata, nextTone } from './metadata';
import { cleanName } from './names';
import { isRetryable, Limiter, withRetry } from './retry';
import { sortNodes } from './sort';
import { framesOf, OPEN_RANGE_CAP, parseRange } from './download/ranges';
import {
	chooseFrameSize,
	FileTooLargeError,
	frameBounds,
	plaintextSize,
	planFrames,
	storedRange
} from './upload/plan';
import { describeDriveError, TooLargeForMemoryError } from './errors';
import { SealError } from '$lib/crypto/aead';
import { ZeroKeyError } from '$lib/crypto/random';
import { isDownloadOnly, safeImageType, viewerFor } from './viewers/kinds';
import { fitWithin, thumbKindOf } from './thumbs/generate';
import { newId } from './ids';

const MiB = 1024 * 1024;

describe('newId', () => {
	it('is the form the API takes, and different each time', () => {
		expect(newId()).toMatch(/^[0-9a-f]{32}$/);
		expect(newId()).not.toBe(newId());
	});
});

describe('frame planning', () => {
	it.each([
		[0, 1, 41],
		[1, 1, 42],
		[4 * MiB, 1, 4 * MiB + 41],
		[4 * MiB + 1, 2, 4 * MiB + 1 + 82],
		[10 * MiB, 3, 10 * MiB + 123]
	])('cuts %i bytes into %i frames', (size, frames, stored) => {
		const plan = planFrames(size, 41);
		expect(plan.frameSize).toBe(4 * MiB);
		expect(plan.frameCount).toBe(frames);
		expect(plan.storedSize).toBe(stored);
		expect(planFrames(size, 0).storedSize).toBe(size);
	});

	it('covers every byte exactly once and marks only the last as final', () => {
		const plan = planFrames(10 * MiB, 41);
		const bounds = [0, 1, 2].map((i) => frameBounds(plan, i));
		expect(bounds.map((b) => b.final)).toEqual([false, false, true]);
		expect(bounds[0]).toMatchObject({ start: 0, end: 4 * MiB });
		expect(bounds[1].start).toBe(4 * MiB);
		expect(bounds[2]).toMatchObject({ start: 8 * MiB, end: 10 * MiB });
	});

	it('gives an empty file one empty frame', () => {
		expect(frameBounds(planFrames(0, 41), 0)).toEqual({ start: 0, end: 0, final: true });
	});

	it('grows the frame to stay within the count the server takes', () => {
		expect(chooseFrameSize(4 * MiB * (1 << 20))).toBe(4 * MiB);
		expect(chooseFrameSize(4 * MiB * (1 << 20) + 1)).toBe(5 * MiB);
		expect(() => chooseFrameSize(16 * MiB * (1 << 20) + 1)).toThrow(FileTooLargeError);
	});

	it('finds a frame in the stored file', () => {
		expect(storedRange(1024, 41, 1024 * 2 + 41 * 3 + 10, 1)).toEqual({ start: 1065, end: 2129 });
		expect(storedRange(1024, 41, 1024 * 2 + 41 * 3 + 10, 2)).toEqual({ start: 2130, end: 2180 });
		expect(storedRange(1024, 0, 0, 0)).toBeNull();
	});

	it('works the plaintext size back from the stored one', () => {
		expect(plaintextSize(10 * MiB + 123, 3, 41)).toBe(10 * MiB);
	});
});

describe('ranges', () => {
	it.each([
		[null, 100, { kind: 'full' }],
		['bytes=0-9', 100, { kind: 'partial', start: 0, end: 9 }],
		['bytes=90-200', 100, { kind: 'partial', start: 90, end: 99 }],
		['bytes=-10', 100, { kind: 'partial', start: 90, end: 99 }],
		['bytes=-1000', 100, { kind: 'partial', start: 0, end: 99 }],
		['bytes=100-', 100, { kind: 'invalid' }],
		['bytes=5-2', 100, { kind: 'invalid' }],
		['bytes=-0', 100, { kind: 'invalid' }],
		['bytes=0-1,4-5', 100, { kind: 'full' }],
		['items=0-1', 100, { kind: 'full' }]
	])('reads %s of %i', (header, size, expected) => {
		expect(parseRange(header, size)).toEqual(expected);
	});

	it('caps an open-ended range, so that a media element does not decrypt everything', () => {
		const size = 1024 * MiB;
		expect(parseRange('bytes=0-', size)).toEqual({
			kind: 'partial',
			start: 0,
			end: OPEN_RANGE_CAP - 1
		});
		expect(parseRange(`bytes=${size - 5}-`, size)).toEqual({
			kind: 'partial',
			start: size - 5,
			end: size - 1
		});
	});

	it('does not cap a range that says where it ends', () => {
		expect(parseRange('bytes=0-99999999', 1024 * MiB)).toMatchObject({ end: 99999999 });
	});

	it('maps a range to frames', () => {
		expect(framesOf(0, 9, 1024)).toEqual({ first: 0, last: 0, skip: 0, keep: 10 });
		expect(framesOf(1020, 1030, 1024)).toEqual({ first: 0, last: 1, skip: 1020, keep: 7 });
		expect(framesOf(2048, 2048, 1024)).toEqual({ first: 2, last: 2, skip: 0, keep: 1 });
	});
});

describe('sorting', () => {
	const node = (id: string, name: string, kind: 'file' | 'folder', modified = 0, size = 0) => ({
		id,
		name,
		kind,
		modified,
		size
	});
	const list = [
		node('1', 'b.txt', 'file', 5, 10),
		node('2', 'file10', 'file', 1, 30),
		node('3', 'Zed', 'folder', 9),
		node('4', 'file9', 'file', 3, 20),
		node('5', 'alpha', 'folder', 1),
		node('6', 'A.TXT', 'file', 2, 40)
	];

	it('puts folders first and orders names as people read them', () => {
		expect(sortNodes(list, 'name').map((n) => n.name)).toEqual([
			'alpha',
			'Zed',
			'A.TXT',
			'b.txt',
			'file9',
			'file10'
		]);
	});

	it('sorts by date and size, newest and largest first by default', () => {
		expect(sortNodes(list, 'modified').map((n) => n.id)).toEqual(['3', '5', '1', '4', '6', '2']);
		expect(sortNodes(list, 'size').map((n) => n.id)).toEqual(['5', '3', '6', '2', '4', '1']);
		expect(sortNodes(list, 'size', 'asc').map((n) => n.id)).toEqual(['5', '3', '1', '4', '2', '6']);
	});

	it('does not change its input, and settles ties the same way every time', () => {
		const same = [node('b', 'x', 'file'), node('a', 'x', 'file')];
		expect(sortNodes(same, 'name').map((n) => n.id)).toEqual(['a', 'b']);
		expect(same[0].id).toBe('b');
	});
});

describe('metadata', () => {
	it('reads what is there', () => {
		const parsed = parseMetadata({
			name: 'a',
			type: 'text/plain',
			created: 1,
			modified: 2,
			size: 3,
			tags: ['t'],
			favorite: true
		});
		expect(parsed).toEqual({
			name: 'a',
			type: 'text/plain',
			created: 1,
			modified: 2,
			size: 3,
			tags: ['t'],
			favorite: true
		});
	});

	it.each([[null], [7], ['x'], [[]], [{ name: 1, tags: 'no', size: -1, favorite: 'yes' }]])(
		'reads %j as empty rather than trusting it',
		(value) => {
			expect(parseMetadata(value)).toEqual({
				name: '',
				type: '',
				created: 0,
				modified: 0,
				size: 0,
				tags: [],
				favorite: false
			});
		}
	);

	it('keeps tags on the root only when they make sense', () => {
		expect(
			parseRootMetadata({
				tags: [
					{ id: '1', name: 'A', tone: 'blue' },
					{ id: '2', name: 'B', tone: 'chartreuse' },
					{ id: 3, name: 'C' },
					{ id: '4', name: '' },
					'x'
				]
			}).tags
		).toEqual([
			{ id: '1', name: 'A', tone: 'blue' },
			{ id: '2', name: 'B', tone: 'grey' }
		]);
		expect(parseRootMetadata(null).tags).toEqual([]);
	});

	it('copies an object and nothing else', () => {
		expect(rawMetadata([1])).toEqual({});
		const raw = { a: 1 };
		expect(rawMetadata(raw)).not.toBe(raw);
	});

	it('goes round the tones', () => {
		expect(nextTone([])).toBe('blue');
		expect(nextTone(new Array(5).fill({}))).toBe('blue');
	});
});

describe('names', () => {
	it('trims and accepts', () => {
		expect(cleanName('  a b.txt ')).toBe('a b.txt');
	});
});

describe('kinds', () => {
	it('infers a type from the name when the browser gives none', () => {
		expect(inferType('a.PDF', '')).toBe('application/pdf');
		expect(inferType('a.pdf', 'application/octet-stream')).toBe('application/pdf');
		expect(inferType('a', '')).toBe('application/octet-stream');
		expect(inferType('a.png', 'image/x-mine')).toBe('image/x-mine');
		expect(extensionOf('.hidden')).toBe('');
	});

	it.each([
		['folder', 'folder', 'folder', 'other'],
		['a.jpg', '', 'image', 'images'],
		['a.mp4', '', 'video', 'video'],
		['a.pdf', '', 'pdf', 'documents'],
		['a.md', '', 'note', 'documents'],
		['a.xlsx', '', 'sheet', 'documents'],
		['a.txt', '', 'doc', 'documents'],
		['a.zip', 'application/zip', 'other', 'other']
	])('draws %s', (name, type, kind, category) => {
		const node = { kind: name === 'folder' ? ('folder' as const) : ('file' as const), name, type };
		expect(fileKindOf(node)).toBe(kind);
		expect(categoryOf(node)).toBe(category);
	});
});

describe('viewers', () => {
	it.each([
		['a.jpg', '', 'image'],
		['a.png', 'image/png', 'image'],
		['a.pdf', '', 'pdf'],
		['a.txt', '', 'text'],
		['a.json', '', 'text'],
		['a.go', '', 'text'],
		['a.mp3', '', 'audio'],
		['a.webm', '', 'video'],
		['a.heic', '', null],
		['a.zip', 'application/zip', null]
	])('opens %s %s in %s', (name, type, viewer) => {
		expect(viewerFor({ name, type })).toBe(viewer);
	});

	it.each([
		['a.svg', ''],
		['a.SVG', 'image/png'],
		['a.png', 'image/svg+xml'],
		['a.html', ''],
		['a.htm', 'text/plain'],
		['a.txt', 'text/html'],
		['a', 'application/xhtml+xml'],
		['a.xhtml', ''],
		['a.mhtml', ''],
		['a.txt', 'TEXT/HTML']
	])('never opens %s %s, only downloads it', (name, type) => {
		expect(isDownloadOnly({ name, type })).toBe(true);
		expect(viewerFor({ name, type })).toBeNull();
	});

	it('builds an image blob only with a safe type', () => {
		expect(safeImageType({ name: 'a.png', type: '' })).toBe('image/png');
		expect(safeImageType({ name: 'a.png', type: 'text/html' })).toBe('application/octet-stream');
	});
});

describe('thumbnails', () => {
	it.each([
		['a.jpg', '', 1, 'image'],
		['a.png', 'image/png', 1, 'image'],
		['a.mp4', '', 1, 'video'],
		['a.heic', '', 1, null],
		['a.svg', '', 1, null],
		['a.txt', '', 1, null],
		['a.jpg', '', 1024 * MiB, null]
	])('for %s %s of %i: %s', (name, type, size, kind) => {
		expect(thumbKindOf({ name, type, size })).toBe(kind);
	});

	it('scales down and never up', () => {
		expect(fitWithin(3200, 1600)).toEqual({ width: 320, height: 160 });
		expect(fitWithin(100, 50)).toEqual({ width: 100, height: 50 });
		expect(fitWithin(10000, 1)).toEqual({ width: 320, height: 1 });
	});
});

describe('retry', () => {
	it('tries again on the network and on the server, not on a refusal', () => {
		expect(isRetryable(new ApiError(0, 'network'))).toBe(true);
		expect(isRetryable(new ApiError(503, 'unknown'))).toBe(true);
		expect(isRetryable(new ApiError(429, 'rate_limited'))).toBe(true);
		expect(isRetryable(new ApiError(413, 'quota_exceeded'))).toBe(false);
		expect(isRetryable(new Error('x'))).toBe(false);
	});

	it('gives up after its attempts, waiting longer each time', async () => {
		const sleep = vi.fn(async () => {});
		const attempt = vi.fn(async () => {
			throw new ApiError(0, 'network');
		});
		await expect(withRetry(attempt, { attempts: 3, baseMs: 10, sleep })).rejects.toBeInstanceOf(
			ApiError
		);
		expect(attempt).toHaveBeenCalledTimes(3);
		expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([10, 20]);
	});

	it('stops at once on a refusal', async () => {
		const attempt = vi.fn(async () => {
			throw new ApiError(413, 'quota_exceeded');
		});
		await expect(withRetry(attempt, { sleep: async () => {} })).rejects.toBeTruthy();
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it('stops at once when cancelled', async () => {
		const controller = new AbortController();
		const attempt = vi.fn(async () => {
			controller.abort(new Error('cancelled'));
			throw new ApiError(0, 'network');
		});
		await expect(withRetry(attempt, { signal: controller.signal })).rejects.toThrow('cancelled');
		expect(attempt).toHaveBeenCalledTimes(1);
	});
});

describe('Limiter', () => {
	it('never runs more than its limit', async () => {
		const limiter = new Limiter(2);
		let active = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 8 }, () =>
				limiter.run(async () => {
					active += 1;
					peak = Math.max(peak, active);
					await new Promise((r) => setTimeout(r, 1));
					active -= 1;
				})
			)
		);
		expect(peak).toBe(2);
	});

	it('goes on after a failure', async () => {
		const limiter = new Limiter(1);
		await expect(limiter.run(() => Promise.reject(new Error('no')))).rejects.toThrow('no');
		await expect(limiter.run(async () => 1)).resolves.toBe(1);
	});
});

describe('the journal', () => {
	const change = (seq: number, node_id: string): Change => ({
		seq,
		node_id,
		op: 'updated',
		at: '2026-01-01T00:00:00Z'
	});

	it('skips to the end and then reads only what is new, across pages', async () => {
		const log = Array.from({ length: 2500 }, (_, i) => change(i + 1, `n${i}`));
		const api = {
			listChanges: vi.fn(async ({ cursor, limit = 200 }: { cursor?: string; limit?: number }) => {
				const from = cursor === undefined ? 0 : Number(cursor);
				const changes = log.slice(from, from + limit);
				return { changes, next_cursor: String(from + changes.length) };
			})
		};
		const feed = new ChangeFeed(api as never);
		await feed.catchUp();
		expect(await feed.next()).toEqual([]);

		log.push(change(2501, 'new'));
		expect((await feed.next()).map((c) => c.node_id)).toEqual(['new']);
		expect(await feed.next()).toEqual([]);
	});

	it('finds what was revoked and has not been rotated since', () => {
		const at = (seq: number, node_id: string, op: Change['op']): Change => ({
			...change(seq, node_id),
			op
		});
		expect(
			revokedNotRotated([
				at(1, 'done', 'revoked'),
				at(2, 'done', 'rotated'),
				at(3, 'open', 'revoked'),
				at(4, 'again', 'rotated'),
				at(5, 'again', 'revoked'),
				at(6, 'other', 'updated')
			])
		).toEqual(['open', 'again']);
	});

	it('names each node once, in order', () => {
		expect(changedNodes([change(1, 'a'), change(2, 'b'), change(3, 'a')])).toEqual(['a', 'b']);
	});
});

describe('errors', () => {
	it('says something useful about what drive can run into', () => {
		expect(describeDriveError(new ApiError(409, 'name_conflict'))).toMatch(
			/already in this folder/
		);
		expect(describeDriveError(new ApiError(413, 'quota_exceeded'))).toMatch(/not enough room/);
		expect(describeDriveError(new SealError('auth'))).toMatch(/integrity/);
		expect(describeDriveError(new ZeroKeyError())).toMatch(/locked/);
		expect(describeDriveError(new TooLargeForMemoryError(1024 * MiB))).toMatch(/1024 MB/);
		expect(describeDriveError(new ApiError(0, 'network'))).toMatch(/cannot be reached/);
	});
});
