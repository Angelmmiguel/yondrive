import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentDeps, FileComments, Thread } from '$lib/comments/comments';
import { ContactKeysChangedError } from '$lib/sharing/contacts';
import { FileCommentsState } from './comments.svelte';
import { sharing } from './sharing.svelte';

const server = vi.hoisted(() => ({
	threads: [] as Thread[],
	fail: null as Error | null,
	calls: [] as string[]
}));

vi.mock('$lib/comments/comments', () => ({
	loadComments: async (): Promise<FileComments> => {
		if (server.fail) throw server.fail;
		return { threads: server.threads, refused: 1 };
	},
	startThread: async (_n: string, text: string) => {
		server.calls.push(`start ${text}`);
		return 'new';
	},
	reply: async (_n: string, thread: string, text: string) =>
		server.calls.push(`reply ${thread} ${text}`),
	editComment: async () => server.calls.push('edit'),
	deleteComment: async (_n: string, id: string) => server.calls.push(`delete ${id}`),
	resolveThread: async (_n: string, id: string, resolved: boolean) =>
		server.calls.push(`resolve ${id} ${resolved}`),
	moveAnchor: async (_n: string, id: string) => {
		if (id === 'bad') throw new Error('refused');
		server.calls.push(`move ${id}`);
	}
}));

const thread = (id: string, resolved = false) => ({ id, resolved }) as Thread;
const deps = {} as CommentDeps;

beforeEach(() => {
	server.threads = [];
	server.fail = null;
	server.calls = [];
});

describe('the comments of a file', () => {
	it('reads the threads and says which are open', async () => {
		server.threads = [thread('a'), thread('b', true)];
		const state = new FileCommentsState('n', () => deps);
		await state.load();
		expect(state.phase).toBe('ready');
		expect(state.refused).toBe(1);
		expect(state.open.map((t) => t.id)).toEqual(['a']);
	});

	it('reads them again after each change', async () => {
		const state = new FileCommentsState('n', () => deps);
		await state.start('hi', null);
		server.threads = [thread('new')];
		await state.reply('new', 'yes');
		await state.resolve('new', true);
		await state.remove('new');
		await state.edit({ id: 'new', threadId: 'new' }, 'x');
		expect(server.calls).toEqual([
			'start hi',
			'reply new yes',
			'resolve new true',
			'delete new',
			'edit'
		]);
		expect(state.threads.map((t) => t.id)).toEqual(['new']);
		expect(state.busy).toBe(false);
	});

	it('moves what anchors it can', async () => {
		const state = new FileCommentsState('n', () => deps);
		const anchor = { kind: 'cell' as const, sheet: 'S', row: 1, col: 1 };
		expect(await state.moveAnchors([])).toEqual([]);
		expect(
			await state.moveAnchors([
				{ threadId: 'ok', anchor },
				{ threadId: 'bad', anchor }
			])
		).toEqual([{ threadId: 'bad', anchor }]);
		expect(server.calls).toEqual(['move ok']);
	});

	it('takes a contact whose keys changed to the warning', async () => {
		const none = { x25519: new Uint8Array(0), ed25519: new Uint8Array(0) };
		server.fail = new ContactKeysChangedError('b'.repeat(32), 'bob', none, none);
		const state = new FileCommentsState('n', () => deps);
		await state.load();
		expect(state.phase).toBe('failed');
		expect(sharing.changed).toBe(server.fail);
		sharing.changed = null;
	});

	it('says when reading failed, and does nothing while locked', async () => {
		server.fail = new Error('network');
		const state = new FileCommentsState('n', () => deps);
		await state.load();
		expect(state.phase).toBe('failed');
		expect(state.error).toBe(server.fail);

		const locked = new FileCommentsState('n', () => null);
		await locked.load();
		expect(locked.phase).toBe('idle');
		await expect(locked.start('hi', null)).rejects.toThrow();
	});
});
