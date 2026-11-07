import { describe, expect, it, vi } from 'vitest';
import { sealerFor, SUITE_E2E } from '$lib/crypto/sealer';
import type { Drive } from '$lib/drive/drive';
import { memorySegmentCache } from '$lib/search/cache';
import { createEngine } from '$lib/search/engine';
import { SearchState } from './search.svelte';

const sealer = sealerFor(SUITE_E2E);

function wired() {
	const cache = memorySegmentCache();
	const index = createEngine(SUITE_E2E, new Uint8Array(32).fill(1));
	const stop = vi.spyOn(index, 'stop');
	const state = new SearchState({
		cache: () => cache,
		index: () => index,
		apiOf: () =>
			({
				listIndexBlobs: async () => ({ blobs: [] }),
				getBlob: async () => new Uint8Array(0),
				putSmallBlob: async () => ({}),
				deleteSmallBlob: async () => {}
			}) as never
	});
	const core = {
		walkEverything: async () => {},
		sharedTops: () => [],
		tree: { nodes: new Map(), rootId: null, tags: [] }
	} as unknown as Drive;
	return { state, core, index, cache, stop };
}

const doc = {
	id: 'a',
	parent: null,
	name: 'walrus.txt',
	kind: 'file' as const,
	type: 'text/plain',
	modified: 1,
	size: 1,
	shared: false,
	tagIds: [],
	tagNames: [],
	version: 'v',
	text: false
};

describe('search state', () => {
	it('asks the index and keeps the answer, and the latest question wins', async () => {
		const { state, core, index } = wired();
		state.attach(core, sealer, new Uint8Array(32), 'u');
		await index.upsert([doc]);
		state.text = 'walrus';
		await state.askNow();
		expect(state.hits.map((hit) => hit.name)).toEqual(['walrus.txt']);
		expect(state.answered).toBe(true);

		const slow = state.askNow();
		state.text = 'nothing';
		await state.askNow();
		await slow;
		expect(state.hits).toEqual([]);
	});

	it('forgets the question when the palette closes', async () => {
		const { state, core, index } = wired();
		state.attach(core, sealer, new Uint8Array(32), 'u');
		await index.upsert([doc]);
		state.show('wal');
		expect(state.open).toBe(true);
		await state.askNow();
		state.hide();
		expect(state.text).toBe('');
		expect(state.hits).toEqual([]);
		expect(state.open).toBe(false);
	});

	it('ends the index on a lock, and forgets the device copy only on signing out', async () => {
		const { state, core, cache, stop } = wired();
		await cache.put('s', new Uint8Array(1));
		state.attach(core, sealer, new Uint8Array(32), 'u');
		state.detach();
		expect(stop).toHaveBeenCalled();
		expect(cache.items.size).toBe(1);

		state.attach(core, sealer, new Uint8Array(32), 'u');
		state.detach(true);
		await vi.waitFor(() => expect(cache.items.size).toBe(0));
	});
});
