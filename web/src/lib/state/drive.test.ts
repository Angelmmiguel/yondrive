import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveState } from './drive.svelte';
import type { DriveNode } from '$lib/drive/tree';

const node = (over: Partial<DriveNode>): DriveNode => ({
	ownerId: 'u'.repeat(32),
	role: 'owner',
	keyGeneration: 1,
	id: over.name ?? 'n',
	parentId: 'root',
	kind: 'file',
	name: 'n',
	type: '',
	created: 0,
	modified: 0,
	size: 0,
	tags: [],
	favorite: false,
	currentVersion: 'v',
	thumbBlobId: null,
	commentSeq: 0,
	trashedAt: null,
	purgedAt: null,
	removeAt: null,
	updatedAt: 0,
	readable: true,
	raw: {},
	...over
});

const list = [
	node({ name: 'b.pdf', modified: 3 }),
	node({ name: 'a.jpg', modified: 1 }),
	node({ name: 'Folder', kind: 'folder', modified: 2 }),
	node({ name: 'c.zip', type: 'application/zip', modified: 5 }),
	node({ name: 'd.mp4', modified: 4 })
];

afterEach(() => vi.unstubAllGlobals());

describe('arranging a list', () => {
	it('sorts by the chosen key, folders first', () => {
		const state = new DriveState();
		state.setSort('name');
		expect(state.arrange(list).map((n) => n.name)).toEqual([
			'Folder',
			'a.jpg',
			'b.pdf',
			'c.zip',
			'd.mp4'
		]);
		state.setSort('modified');
		expect(state.arrange(list).map((n) => n.name)).toEqual([
			'Folder',
			'c.zip',
			'd.mp4',
			'b.pdf',
			'a.jpg'
		]);
	});

	it.each([
		['folders', ['Folder']],
		['documents', ['b.pdf']],
		['images', ['a.jpg']],
		['video', ['d.mp4']],
		['other', ['c.zip']]
	] as const)('filters to %s', (filter, names) => {
		const state = new DriveState();
		state.filter = filter;
		expect(state.arrange(list).map((n) => n.name)).toEqual(names);
	});
});

describe('the view', () => {
	it('remembers its choice, and only that', () => {
		const stored = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => stored.set(key, value)
		});
		const state = new DriveState();
		state.setView('grid');
		state.setSort('size');

		expect(state.viewMode).toBe('grid');
		expect(JSON.parse(stored.get('yondrive-drive-view') as string)).toEqual({
			mode: 'grid',
			sort: 'size'
		});
	});

	it('works with no storage', () => {
		vi.stubGlobal('localStorage', {
			setItem: () => {
				throw new Error('denied');
			}
		});
		expect(() => new DriveState().setView('grid')).not.toThrow();
	});
});

describe('before a session', () => {
	it('has nothing, and does nothing', async () => {
		const state = new DriveState();
		expect(state.rootId).toBeNull();
		expect(state.children('x')).toEqual([]);
		expect(state.favorites).toEqual([]);
		expect(state.recent(3)).toEqual([]);
		expect(state.tags).toEqual([]);
		expect(state.categories).toEqual({ images: 0, video: 0, documents: 0, other: 0 });
		await expect(state.run(async () => 1)).resolves.toBeUndefined();
		state.upload({ files: [], folders: [] });
		expect(() => state.stop()).not.toThrow();
	});
});
