import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type IncomingItem } from '$lib/api/types';
import type { IncomingDeps } from '$lib/sharing/incoming';
import { IncomingState } from './incoming.svelte';

const outcome = vi.hoisted(() => ({
	items: [] as IncomingItem[],
	refuse: new Map<string, Error>()
}));

vi.mock('$lib/sharing/incoming', async (original) => {
	const real = await original<typeof import('$lib/sharing/incoming')>();
	return {
		...real,
		listIncoming: async () => outcome.items,
		adoptIncoming: async (item: IncomingItem) => {
			const refusal = outcome.refuse.get(item.id);
			if (refusal !== undefined) throw refusal;
			return { id: item.id };
		}
	};
});

const { UnreadableIncomingError } = await import('$lib/sharing/incoming');

const item = (id: string, folder = 'f') => ({ id, folder_id: folder }) as IncomingItem;

function deps(): IncomingDeps & { deleted: string[] } {
	const deleted: string[] = [];
	return {
		deleted,
		api: {
			listIncoming: vi.fn(),
			adoptIncoming: vi.fn(),
			deleteIncoming: vi.fn(async (id: string) => {
				deleted.push(id);
			})
		},
		sealer: {} as never,
		keys: () => ({}) as never,
		tree: {} as never
	};
}

beforeEach(() => {
	outcome.items = [];
	outcome.refuse.clear();
});

describe('incoming state', () => {
	it('adopts what arrived, counts it, and keeps what would not go in', async () => {
		const state = new IncomingState();
		state.attach(deps());
		outcome.items = [item('a', 'one'), item('b', 'two'), item('c')];
		outcome.refuse.set('b', new UnreadableIncomingError());
		outcome.refuse.set('c', new ApiError(0, 'network'));

		expect(await state.run()).toBe(1);
		expect(state.adopted).toBe(1);
		expect(state.folders).toEqual(['one']);
		expect(state.waiting.map((w) => [w.item.id, w.why])).toEqual([
			['b', 'unreadable'],
			['c', 'failed']
		]);
		expect(state.running).toBe(false);

		state.seen();
		expect(state.adopted).toBe(0);
		expect(state.folders).toEqual([]);
	});

	it('runs once at a time', async () => {
		const state = new IncomingState();
		state.attach(deps());
		outcome.items = [item('a')];
		const [first, second] = await Promise.all([state.run(), state.run()]);
		expect(first + second).toBe(2);
		expect(state.adopted).toBe(1);
	});

	it('tries one again, and throws one away', async () => {
		const state = new IncomingState();
		const d = deps();
		state.attach(d);
		outcome.items = [item('a'), item('b')];
		outcome.refuse.set('a', new ApiError(0, 'network'));
		outcome.refuse.set('b', new ApiError(0, 'network'));
		await state.run();
		expect(state.waiting).toHaveLength(2);

		outcome.refuse.delete('a');
		expect(await state.retry('a')).toBe(true);
		expect(await state.retry('b')).toBe(false);
		expect(state.waiting.map((w) => w.item.id)).toEqual(['b']);
		expect(await state.retry('nothing')).toBe(false);

		await state.remove('b');
		expect(d.deleted).toEqual(['b']);
		expect(state.waiting).toEqual([]);
	});

	it('lets a signed-out session through, rather than keeping every item as failed', async () => {
		const state = new IncomingState();
		state.attach(deps());
		outcome.items = [item('a'), item('b')];
		outcome.refuse.set('a', new ApiError(401, 'unauthorized'));
		await expect(state.run()).rejects.toMatchObject({ code: 'unauthorized' });
		expect(state.waiting).toEqual([]);
		expect(state.running).toBe(false);
	});

	it('does nothing detached, and forgets everything on detach', async () => {
		const state = new IncomingState();
		expect(await state.run()).toBe(0);
		await state.remove('a');
		state.attach(deps());
		outcome.items = [item('a')];
		await state.run();
		state.detach();
		expect(state.adopted).toBe(0);
		expect(state.waiting).toEqual([]);
	});
});
