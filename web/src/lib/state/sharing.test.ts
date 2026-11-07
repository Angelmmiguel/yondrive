import { describe, expect, it, vi } from 'vitest';
import type { PublicKeys } from '$lib/crypto/keys';
import { ContactKeysChangedError } from '$lib/sharing/contacts';
import type { Sharing } from '$lib/sharing/sharing';
import { SharingState } from './sharing.svelte';

const keys = {} as PublicKeys;

function core(over: Partial<Sharing> = {}) {
	return {
		refreshShared: vi.fn(async () => []),
		refreshMade: vi.fn(async () => {}),
		notifications: vi.fn(async () => ({
			list: [{ grant_id: 'g1', node_id: 'n', granter_id: 'u', created_at: '' }],
			more: false
		})),
		markRead: vi.fn(async () => {}),
		shared: [],
		made: [],
		links: [],
		peopleOf: () => ['bob'],
		...over
	} as unknown as Sharing;
}

describe('sharing state', () => {
	it('reads what is shared and what is unread, and lets it go', async () => {
		const state = new SharingState();
		state.attach(core());
		await state.sync();
		expect(state.sharedLoaded).toBe(true);
		expect(state.unread).toHaveLength(1);
		expect(state.peopleOf([])).toEqual(['bob']);

		state.detach();
		expect(state.unread).toEqual([]);
		expect(state.peopleOf([])).toEqual([]);
	});

	it('marks one or all as read, here first', async () => {
		const state = new SharingState();
		const attached = core();
		state.attach(attached);
		await state.sync();

		await state.markRead('g1');
		expect(state.unread).toEqual([]);
		expect(attached.markRead).toHaveBeenCalledWith(['g1']);

		await state.sync();
		await state.markAllRead();
		expect(state.unread).toEqual([]);
		expect(attached.markRead).toHaveBeenCalledWith();
	});

	it('takes a changed key to the warning, and nothing else', () => {
		const state = new SharingState();
		expect(state.warn(new Error('other'))).toBe(false);
		const changed = new ContactKeysChangedError('u', 'bob', keys, keys);
		expect(state.warn(changed)).toBe(true);
		expect(state.changed).toBe(changed);
	});

	it('raises the warning for a share whose granter has changed keys', async () => {
		const state = new SharingState();
		const changed = new ContactKeysChangedError('u', 'bob', keys, keys);
		state.attach(core({ shared: [{ changed }] as never }));
		await state.sync();
		expect(state.changed).toBe(changed);
	});

	it('keeps what a rotation could not re-key after it has ended, until dismissed', async () => {
		const state = new SharingState();
		state.attach(
			core({
				revoke: async (_g, _n, onProgress) => {
					onProgress?.({ done: 3, total: 3, topId: 'n', unreadable: 2 });
				}
			} as Partial<Sharing>)
		);

		expect(await state.revoke('g', 'n')).toBe(2);
		expect(state.rotation).toBeNull();
		expect(state.unrekeyedCount).toBe(2);

		// A resumed job in the same session adds to it, and the same job replaces its own.
		state.track({ done: 1, total: 1, topId: 'm', unreadable: 1 });
		state.track({ done: 1, total: 1, topId: 'n', unreadable: 2 });
		state.track(null);
		expect(state.unrekeyedCount).toBe(3);

		state.dismissUnrekeyed();
		expect(state.unrekeyedCount).toBe(0);
	});

	it('shows a rotation while it runs, and ends it however it goes', async () => {
		const state = new SharingState();
		const seen: unknown[] = [];
		state.attach(
			core({
				revoke: async (_g, _n, onProgress) => {
					seen.push(state.rotation);
					onProgress?.({ done: 1, total: 2 });
					seen.push(state.rotation);
					throw new Error('stopped');
				}
			} as Partial<Sharing>)
		);

		await expect(state.revoke('g', 'n')).rejects.toThrow('stopped');
		expect(seen).toEqual([
			{ done: 0, total: 1 },
			{ done: 1, total: 2 }
		]);
		expect(state.rotation).toBeNull();
	});
});
