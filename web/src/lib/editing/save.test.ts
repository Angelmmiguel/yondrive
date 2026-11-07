import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/types';
import type { DriveNode } from '$lib/drive/tree';
import { saveVersion, type SaveDeps } from './save';

/** The server: one current version per node, and commits that may lose their answer. */
const server = vi.hoisted(() => ({
	current: 'v1',
	loseNextAnswer: false,
	expectedSeen: [] as string[],
	committed: [] as string[]
}));

vi.mock('$lib/drive/upload/engine', () => ({
	beginUpload: async (_f: File, a: { expected: string; versionId: string }) => ({
		uploadId: `u-${a.versionId}`,
		...a
	}),
	sendUpload: async (_f: File, r: { expected: string; versionId: string }) => {
		server.expectedSeen.push(r.expected);
		if (r.expected !== server.current) throw new ApiError(409, 'version_conflict');
		server.current = r.versionId;
		server.committed.push(r.versionId);
		if (server.loseNextAnswer) {
			server.loseNextAnswer = false;
			throw new TypeError('Failed to fetch');
		}
		return { id: r.versionId };
	},
	abandonUpload: async () => {}
}));

function deps(): SaveDeps {
	const node = () => ({ id: 'n1', name: 'a.docx', currentVersion: server.current }) as DriveNode;
	return {
		tree: {
			nodeKey: async () => new Uint8Array(32),
			generationOf: () => 1,
			refresh: async () => node(),
			patch: async () => node(),
			createFile: async () => node(),
			findByName: () => undefined
		} as unknown as SaveDeps['tree'],
		engine: {} as SaveDeps['engine']
	};
}

describe('saving a version', () => {
	beforeEach(() => {
		server.current = 'v1';
		server.loseNextAnswer = false;
		server.expectedSeen = [];
		server.committed = [];
	});

	it('takes a save whose answer was lost as its own, not as someone else’s', async () => {
		server.loseNextAnswer = true;
		const bytes = new Uint8Array([1]);
		await expect(saveVersion(deps(), { id: 'n1', name: 'a.docx' }, bytes, 'v1')).rejects.toThrow(
			TypeError
		);
		const landed = server.current;
		expect(landed).not.toBe('v1');
		// The editor still thinks v1 is current, and saves again on top of it.
		const saved = await saveVersion(deps(), { id: 'n1', name: 'a.docx' }, bytes, 'v1');
		expect(server.expectedSeen).toEqual(['v1', 'v1', landed]);
		expect(saved.version).toBe(server.current);
		expect(server.current).not.toBe(landed);
	});

	it('bases the next save on the version it committed, not on a later one', async () => {
		const d = deps();
		const refresh = d.tree.refresh;
		// Someone else commits just after this save, before its refresh answers.
		d.tree.refresh = async (id: string) => {
			server.current = 'theirs';
			return refresh(id);
		};
		const saved = await saveVersion(d, { id: 'n1', name: 'a.docx' }, new Uint8Array([1]), 'v1');
		expect(saved.version).toBe(server.committed[0]);
		// So the next save from this editor meets their version, and is refused.
		await expect(
			saveVersion(deps(), { id: 'n1', name: 'a.docx' }, new Uint8Array([2]), saved.version)
		).rejects.toMatchObject({ code: 'version_conflict' });
	});

	it('still refuses a version someone else saved', async () => {
		server.current = 'theirs';
		await expect(
			saveVersion(deps(), { id: 'n1', name: 'a.docx' }, new Uint8Array([1]), 'v1')
		).rejects.toMatchObject({ code: 'version_conflict' });
	});
});
