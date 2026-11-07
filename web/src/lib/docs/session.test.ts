import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/types';
import { ImageStore } from './images';
import { DocSession, imageKeys, type SessionDeps, type SessionFile } from './session';
import { conflictName, numbered } from './save';
import { Presence } from './presence';
import { sniffFormat } from './search-text';
import type { Block } from '$lib/formats/model';

function deps(over: Partial<SessionDeps> = {}) {
	const timers: (() => void)[] = [];
	const statuses: string[] = [];
	const saves: { file: SessionFile; bytes: Uint8Array }[] = [];
	let version = 1;
	const d: SessionDeps = {
		formats: { write: vi.fn(async (f) => new TextEncoder().encode(`bytes as ${f}`)) },
		save: vi.fn(async (file, bytes) => {
			saves.push({ file, bytes });
			return `v${++version}`;
		}),
		copy: vi.fn(async (file) => ({ id: 'copy', name: `${file.name} (copy)`, version: 'c1' })),
		rename: vi.fn(async () => true),
		create: vi.fn(async (_f, name) => ({ id: 'new', name, version: 'n1' })),
		blocks: () => [{ type: 'paragraph', style: 'normal', content: [] }],
		images: new ImageStore(),
		onstatus: (s) => statuses.push(s),
		onconflict: vi.fn(),
		onfile: vi.fn(),
		setTimeout: (fn) => timers.push(fn),
		clearTimeout: () => timers.splice(0),
		...over
	};
	return { d, timers, statuses, saves };
}

const file = { id: 'n1', name: 'Report.docx', version: 'v1' };

describe('a document session', () => {
	it('saves after a pause, not on every edit, over the version it saw', async () => {
		const { d, timers, saves, statuses } = deps();
		const s = new DocSession(d, file, { bytes: new Uint8Array(), format: 'docx' });
		s.changed();
		s.changed();
		s.changed();
		expect(timers.length).toBe(1);
		expect(s.dirty).toBe(true);
		timers.shift()!();
		await vi.waitFor(() => expect(s.status).toBe('saved'));
		expect(saves.map((x) => x.file.version)).toEqual(['v1']);
		s.changed();
		await s.flush();
		expect(saves.map((x) => x.file.version)).toEqual(['v1', 'v2']);
		expect(statuses).toContain('saving');
		await s.flush();
		expect(saves.length).toBe(2);
	});

	it('turns a save that meets a newer version into a copy, and goes on there', async () => {
		const { d } = deps({
			save: vi.fn(async () => Promise.reject(new ApiError(412, 'version_conflict')))
		});
		const s = new DocSession(d, file, { bytes: new Uint8Array(), format: 'docx' });
		s.changed();
		await s.flush();
		expect(d.copy).toHaveBeenCalledTimes(1);
		expect(d.onconflict).toHaveBeenCalledWith({
			id: 'copy',
			name: 'Report.docx (copy)',
			version: 'c1'
		});
		expect(s.file.id).toBe('copy');
		expect(s.status).toBe('saved');
	});

	it('says when a save fails, and keeps the edits waiting', async () => {
		const { d } = deps({
			save: vi.fn(async () => Promise.reject(new ApiError(507, 'quota_exceeded')))
		});
		const s = new DocSession(d, file, { bytes: new Uint8Array(), format: 'docx' });
		s.changed();
		await s.flush();
		expect(s.status).toBe('failed');
		expect(s.dirty).toBe(true);
	});

	it('converts .doc to .docx on its first save, renaming the file', async () => {
		const { d, saves } = deps();
		const s = new DocSession(
			d,
			{ id: 'n1', name: 'Old.doc', version: 'v1' },
			{ bytes: new Uint8Array(), format: 'doc' }
		);
		expect(s.saveFormat).toBe('docx');
		s.changed();
		await s.flush();
		expect(d.rename).toHaveBeenCalledWith(expect.objectContaining({ name: 'Old.doc' }), 'Old.docx');
		expect(saves[0].file.name).toBe('Old.docx');
		expect(new TextDecoder().decode(saves[0].bytes)).toBe('bytes as docx');
		expect(s.file.name).toBe('Old.docx');
	});

	it('converts to another format beside the file when it may not be renamed', async () => {
		const { d } = deps({ rename: vi.fn(async () => false) });
		const s = new DocSession(d, file, { bytes: new Uint8Array(), format: 'docx' });
		await s.convertTo('odt');
		expect(d.create).toHaveBeenCalledWith(file, 'Report.odt', expect.any(Uint8Array));
		expect(s.file).toEqual({ id: 'new', name: 'Report.odt', version: 'n1' });
	});

	it('names copies clearly', () => {
		expect(numbered('a.docx', 2)).toBe('a (2).docx');
		expect(conflictName('Plan.docx', 'bob', new Date(2026, 10, 7, 9, 5))).toBe(
			'Plan (conflicting copy from bob, 2026-11-07 09.05).docx'
		);
	});

	it('collects the images a document uses', () => {
		const blocks: Block[] = [
			{ type: 'paragraph', style: 'normal', content: [{ type: 'image', image: 'a', alt: '' }] },
			{
				type: 'table',
				rows: [
					{
						cells: [
							{
								content: [
									{
										type: 'paragraph',
										style: 'normal',
										content: [{ type: 'image', image: 'b', alt: '' }]
									}
								]
							}
						]
					}
				]
			}
		];
		expect([...imageKeys(blocks)]).toEqual(['a', 'b']);
	});
});

describe('presence', () => {
	it('beats while editing, asks while looking, and reports changes once', async () => {
		const seen: string[][] = [];
		const api = {
			putEditing: vi.fn(async () => ({
				editors: [{ user_id: 'u2', username: 'bob', since: '' }],
				ttl_seconds: 45
			})),
			getEditing: vi.fn(async () => ({ editors: [], ttl_seconds: 45 }))
		};
		let tick: () => void = () => {};
		const p = new Presence({
			api,
			onchange: (e) => seen.push(e.map((x) => x.username)),
			setInterval: (fn) => (tick = fn),
			clearInterval: () => {}
		});
		p.start('n1', true);
		await vi.waitFor(() => expect(seen).toEqual([['bob']]));
		tick();
		await Promise.resolve();
		expect(seen).toEqual([['bob']]);
		p.start('n1', false);
		await vi.waitFor(() => expect(api.getEditing).toHaveBeenCalled());
		p.stop();
		expect(seen.at(-1)).toEqual([]);
	});
});

describe('search text', () => {
	it('tells the format from the bytes', () => {
		const enc = new TextEncoder();
		expect(sniffFormat(enc.encode('{\\rtf1 x}'))).toBe('rtf');
		expect(sniffFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe('doc');
		expect(
			sniffFormat(enc.encode('PK\u0003\u0004....mimetypeapplication/vnd.oasis.opendocument.text'))
		).toBe('odt');
		expect(sniffFormat(enc.encode('PK\u0003\u0004'))).toBe('docx');
		expect(sniffFormat(enc.encode('plain'))).toBeNull();
	});
});
