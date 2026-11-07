import { describe, expect, it, vi } from 'vitest';
import { sealerFor, SUITE_E2E } from '$lib/crypto/sealer';
import { Drive } from '$lib/drive/drive';
import { inlineFramePool } from '$lib/drive/frame-pool';
import { openNodes } from '$lib/drive/open-nodes';
import { memoryResumeStore } from '$lib/drive/upload/resume';
import { fakeDriveServer, fakeUser, USER_ID } from '$lib/testing/drive';
import { NotesState } from './notes.svelte';

async function wired() {
	const server = fakeDriveServer(SUITE_E2E);
	const sealer = sealerFor(SUITE_E2E);
	const keys = fakeUser(SUITE_E2E);
	const drive = new Drive({
		api: server.api,
		sealer,
		keys: () => keys,
		userId: () => USER_ID,
		open: async (key, parent, records) => openNodes(sealer, key, parent, records),
		pool: inlineFramePool(sealer),
		resume: memoryResumeStore(),
		streams: { open: async () => null, release: vi.fn(), clear: vi.fn(), stop: vi.fn() },
		saveUrl: vi.fn(),
		saveBlob: vi.fn(),
		sleep: async () => {}
	});
	drive.engine.frameSize = 1024;
	await drive.start();
	const state = new NotesState();
	state.attach(drive, sealer, keys.masterKey, USER_ID);
	drive.tree.onchange = () => state.treeChanged();
	state.start();
	return { drive, state };
}

describe('notes state', () => {
	it('makes the folder of notes on first use and lists what is made in it', async () => {
		const { state } = await wired();
		expect(state.rootId).toBeNull();
		const root = await state.ensureRoot();
		expect(root).not.toBeNull();
		const made = await state.newNote(null, 'Groceries', '- [ ] Milk\n- [x] Eggs\n');
		expect(made?.name).toBe('Groceries.md');
		await vi.waitFor(() => expect(state.items().map((i) => i.title)).toEqual(['Groceries']));
		await vi.waitFor(() => expect(state.items()[0].entry?.tasks).toHaveLength(2));
		expect(state.counts(state.items(), 0).tasks).toBe(1);
		state.detach();
		expect(state.items()).toEqual([]);
	});

	it('keeps the list’s choices', async () => {
		const { state } = await wired();
		state.toggleChip('tasks');
		state.toggleChip('linked');
		state.toggleChip('tasks');
		expect(state.chips).toEqual(['linked']);
		state.setView('list');
		state.setSort('title');
		expect([state.view, state.sort]).toEqual(['list', 'title']);
		state.detach();
		expect(state.chips).toEqual([]);
	});

	it('gives a reminder that is due, once', async () => {
		const { state } = await wired();
		await state.ensureRoot();
		await state.newNote(null, 'Call the plumber', '', { reminder: Date.now() - 1000 });
		await vi.waitFor(() => expect(state.items()).toHaveLength(1));
		state.start();
		await vi.waitFor(() => expect(state.alerts.map((a) => a.title)).toEqual(['Call the plumber']));
		state.start();
		expect(state.alerts).toHaveLength(1);
		state.dismissAlert(state.alerts[0].id);
		expect(state.alerts).toEqual([]);
		state.detach();
	});
});
