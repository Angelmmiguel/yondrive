import { describe, expect, it } from 'vitest';
import { isApiError } from '$lib/api/types';
import { decodeBase64, encodeBase64 } from '$lib/crypto/encoding';
import { driveFixture, SUITES } from '$lib/testing/drive';
import { InvalidNameError } from './names';
import { SUITE_E2E, SUITE_NONE } from '$lib/crypto/sealer';

async function started(suite: (typeof SUITES)[number][1]) {
	const fixture = driveFixture(suite);
	await fixture.tree.start();
	return { ...fixture, root: fixture.tree.rootId as string };
}

describe.each(SUITES)('the tree in mode %s', (_, suite) => {
	it('makes a root once, and any later client uses the one it gets back', async () => {
		const { tree, server, root, sealer, keys } = await started(suite);
		expect(server.nodes.size).toBe(1);

		const { DriveTree } = await import('./tree');
		const { openNodes } = await import('./open-nodes');
		const other = new DriveTree({
			api: server.api,
			sealer,
			keys: () => keys,
			open: async (k, p, r) => openNodes(sealer, k, p, r)
		});
		await other.start();
		expect(other.rootId).toBe(root);
		expect(tree.rootId).toBe(root);
	});

	it('uses the root the server returns if another device won', async () => {
		const { server, tree, sealer, keys, root } = await started(suite);
		const { DriveTree } = await import('./tree');
		const { openNodes } = await import('./open-nodes');
		const raced = {
			...server.api,
			getRootNode: async () => {
				throw new (await import('$lib/api/types')).ApiError(404, 'not_found');
			}
		};
		const late = new DriveTree({
			api: raced,
			sealer,
			keys: () => keys,
			open: async (k, p, r) => openNodes(sealer, k, p, r)
		});
		await late.start();
		expect(late.rootId).toBe(root);
		expect(tree.rootId).toBe(root);
	});

	it('creates, lists, renames and tells apart', async () => {
		const { tree, server, root } = await started(suite);
		const a = await tree.createFolder(root, 'Alpha');
		await tree.createFolder(root, 'Beta');
		expect(
			tree
				.childrenOf(root)
				.map((n) => n.name)
				.sort()
		).toEqual(['Alpha', 'Beta']);

		await tree.rename(a.id, 'Gamma');
		const fresh = driveTreeFrom(tree);
		expect(fresh.nodes.get(a.id)?.name).toBe('Gamma');
		expect(server.nodes.get(a.id)?.sealed_metadata).toBeTruthy();
	});

	it('refuses a duplicate name in a folder, whatever its case, but not elsewhere', async () => {
		const { tree, root } = await started(suite);
		const folder = await tree.createFolder(root, 'Report');
		await expect(tree.createFolder(root, 'report')).rejects.toSatisfy((e) =>
			isApiError(e, 'name_conflict')
		);
		await expect(tree.createFolder(folder.id, 'Report')).resolves.toBeTruthy();
		const other = await tree.createFolder(root, 'Other');
		await expect(tree.rename(other.id, 'REPORT')).rejects.toSatisfy((e) =>
			isApiError(e, 'name_conflict')
		);
	});

	it('refuses names that could not be meant', async () => {
		const { tree, root } = await started(suite);
		for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b', 'x'.repeat(256)]) {
			await expect(tree.createFolder(root, name)).rejects.toThrow(InvalidNameError);
		}
	});

	it('moves a node so that a fresh client still opens it', async () => {
		const { tree, root, server, sealer, keys } = await started(suite);
		const target = await tree.createFolder(root, 'Target');
		const folder = await tree.createFolder(root, 'Moved');
		const inner = await tree.createFolder(folder.id, 'Inner');
		await tree.move(folder.id, target.id);

		expect(tree.childrenOf(root).map((n) => n.name)).toEqual(['Target']);
		expect(tree.childrenOf(target.id).map((n) => n.name)).toEqual(['Moved']);
		expect(tree.breadcrumbs(inner.id).map((n) => n.name)).toEqual(['', 'Target', 'Moved', 'Inner']);

		const { DriveTree } = await import('./tree');
		const { openNodes } = await import('./open-nodes');
		const fresh = new DriveTree({
			api: server.api,
			sealer,
			keys: () => keys,
			open: async (k, p, r) => openNodes(sealer, k, p, r)
		});
		await fresh.start();
		const reopened = await fresh.resolve(inner.id);
		expect(reopened.name).toBe('Inner');
		expect(reopened.readable).toBe(true);
	});

	it('refuses to move a folder into itself', async () => {
		const { tree, root } = await started(suite);
		const parent = await tree.createFolder(root, 'P');
		const child = await tree.createFolder(parent.id, 'C');
		await expect(tree.move(parent.id, child.id)).rejects.toSatisfy((e) =>
			isApiError(e, 'move_cycle')
		);
	});

	it('walks everything so that favorites and counts fill in', async () => {
		const { tree, root, server, sealer, keys } = await started(suite);
		const a = await tree.createFolder(root, 'A');
		const b = await tree.createFolder(a.id, 'B');
		await tree.patch(b.id, { favorite: true });

		const { DriveTree } = await import('./tree');
		const { openNodes } = await import('./open-nodes');
		const fresh = new DriveTree({
			api: server.api,
			sealer,
			keys: () => keys,
			open: async (k, p, r) => openNodes(sealer, k, p, r)
		});
		await fresh.start();
		await fresh.walk();
		expect(
			fresh
				.live()
				.map((n) => n.name)
				.sort()
		).toEqual(['A', 'B']);
		expect(
			fresh
				.live()
				.filter((n) => n.favorite)
				.map((n) => n.name)
		).toEqual(['B']);
	});

	it('trashes, lists, restores and purges with the time the server gives', async () => {
		const { tree, root } = await started(suite);
		const folder = await tree.createFolder(root, 'Old');
		const inner = await tree.createFolder(folder.id, 'Inner');
		await tree.loadFolder(folder.id);
		await tree.trash(folder.id);

		expect(tree.childrenOf(root)).toEqual([]);
		expect(tree.live().map((n) => n.id)).not.toContain(inner.id);
		const trash = await tree.listTrash();
		expect(trash.map((n) => n.name)).toEqual(['Old']);

		const purged = await tree.purge(folder.id);
		expect(purged.removeAt).toBeGreaterThan(purged.trashedAt as number);

		const back = await tree.restore(folder.id);
		expect(back.trashedAt).toBeNull();
		expect(back.removeAt).toBeNull();
		await tree.loadFolder(folder.id);
		expect(tree.childrenOf(root).map((n) => n.name)).toEqual(['Old']);
		expect(tree.childrenOf(folder.id).map((n) => n.name)).toEqual(['Inner']);
	});

	it('keeps metadata fields it does not know when it rewrites them', async () => {
		const { tree, root, server, sealer } = await started(suite);
		const folder = await tree.createFolder(root, 'Keep');
		const key = await tree.nodeKey(folder.id);
		const record = server.nodes.get(folder.id);
		if (record === undefined) throw new Error('no record');
		const fromTheFuture = { name: 'Keep', later: { colour: 'red' }, tags: [] };
		await server.api.updateNode(folder.id, {
			suite,
			sealed_metadata: encodeBase64(sealer.sealMetadata(key, folder.id, fromTheFuture))
		});
		await tree.refresh(folder.id);
		await tree.patch(folder.id, { favorite: true });

		const opened = sealer.openMetadata(
			key,
			folder.id,
			decodeBase64(server.nodes.get(folder.id)?.sealed_metadata as string)
		);
		expect(opened).toMatchObject({ later: { colour: 'red' }, favorite: true });
	});

	it('keeps tags on the root, by id, and survives a fresh start', async () => {
		const { tree, root, server, sealer, keys } = await started(suite);
		const tag = await tree.createTag('Finance');
		expect(await tree.createTag('finance')).toEqual(tag);
		const folder = await tree.createFolder(root, 'Q4');
		await tree.patch(folder.id, { tags: [tag.id] });

		const { DriveTree } = await import('./tree');
		const { openNodes } = await import('./open-nodes');
		const fresh = new DriveTree({
			api: server.api,
			sealer,
			keys: () => keys,
			open: async (k, p, r) => openNodes(sealer, k, p, r)
		});
		await fresh.start();
		await fresh.walk();
		expect(fresh.tags).toEqual([tag]);
		expect(fresh.nodes.get(folder.id)?.tags).toEqual([tag.id]);

		await fresh.deleteTag(tag.id);
		expect(fresh.tags).toEqual([]);
	});

	it('zeroes its keys when stopped', async () => {
		const { tree, root, keys, sealer } = await started(suite);
		const held = await tree.nodeKey(root);
		tree.stop();
		expect(held.every((byte) => byte === 0)).toBe(true);
		expect(tree.rootId).toBeNull();
		expect(sealer.suite === SUITE_NONE || keys.masterKey.length === 32).toBe(true);
	});

	it('reads a folder again and drops what has gone', async () => {
		const { tree, server, root } = await started(suite);
		const folder = await tree.createFolder(root, 'Going');
		server.nodes.delete(folder.id);
		await tree.loadFolder(root, true);
		expect(tree.nodes.has(folder.id)).toBe(false);
	});

	/** A tree whose folder listings are held, once answered, until let go. */
	async function heldListings() {
		const fixture = driveFixture(suite);
		const held: (() => void)[] = [];
		const { DriveTree } = await import('./tree');
		const { openNodes } = await import('./open-nodes');
		const tree = new DriveTree({
			api: {
				...fixture.server.api,
				listChildren: async (...args: Parameters<typeof fixture.server.api.listChildren>) => {
					const page = await fixture.server.api.listChildren(...args);
					await new Promise<void>((go) => held.push(go));
					return page;
				}
			},
			sealer: fixture.sealer,
			keys: () => fixture.keys,
			open: async (k, p, r) => openNodes(fixture.sealer, k, p, r)
		});
		await tree.start();
		const root = tree.rootId as string;
		const waitHeld = async () => {
			while (held.length === 0) await new Promise((r) => setTimeout(r, 0));
		};
		const release = () => held.splice(0).forEach((go) => go());
		return { tree, root, deps: { tree, engine: fixture.engine }, waitHeld, release };
	}

	it('keeps a file made while its folder is read, though the listing left before it', async () => {
		const { createWith } = await import('$lib/editing/save');
		const { tree, root, deps, waitHeld, release } = await heldListings();
		const reading = tree.loadFolder(root, true);
		await waitHeld();
		const made = await createWith(deps, root, 'Note.md', new TextEncoder().encode('hi'));
		release();
		await reading;
		expect(tree.childrenOf(root).map((n) => n.id)).toContain(made.id);
	});

	it('keeps a file committed while its folder is read, though the listing has it empty', async () => {
		const { saveVersion } = await import('$lib/editing/save');
		const { tree, root, deps, waitHeld, release } = await heldListings();
		const node = await tree.createFile(root, {
			name: 'Note.md',
			type: 'text/markdown',
			size: 2,
			modified: 0
		});
		const reading = tree.loadFolder(root, true);
		await waitHeld();
		await saveVersion(deps, node, new TextEncoder().encode('hi'), '');
		release();
		await reading;
		expect(tree.childrenOf(root).map((n) => n.id)).toContain(node.id);
		expect(tree.nodes.get(node.id)?.currentVersion).not.toBeNull();
	});

	it('keeps a rename made while its folder is read', async () => {
		const { tree, root, waitHeld, release } = await heldListings();
		const folder = await tree.createFolder(root, 'Before');
		const reading = tree.loadFolder(root, true);
		await waitHeld();
		await tree.rename(folder.id, 'After');
		release();
		await reading;
		expect(tree.nodes.get(folder.id)?.name).toBe('After');
	});
});

function driveTreeFrom<T>(tree: T): T {
	return tree;
}

describe('names on the wire', () => {
	it('never sends a name in end-to-end mode, and sends it readable in none', async () => {
		for (const suite of [SUITE_E2E, SUITE_NONE] as const) {
			const { tree, server, root } = await started(suite);
			const folder = await tree.createFolder(root, 'Secret plans');
			const stored = decodeBase64(server.nodes.get(folder.id)?.sealed_metadata as string);
			const text = new TextDecoder().decode(stored);
			expect(text.includes('Secret plans')).toBe(suite === SUITE_NONE);
		}
	});

	it('marks a node whose metadata was tampered with as unreadable, and goes on', async () => {
		const { tree, server, root } = await started(SUITE_E2E);
		const bad = await tree.createFolder(root, 'Bad');
		await tree.createFolder(root, 'Good');
		const record = server.nodes.get(bad.id);
		if (record === undefined) throw new Error('no record');
		const flipped = decodeBase64(record.sealed_metadata);
		flipped[flipped.length - 1] ^= 1;
		server.nodes.set(bad.id, { ...record, sealed_metadata: encodeBase64(flipped) });

		await tree.loadFolder(root, true);
		expect(tree.nodes.get(bad.id)?.readable).toBe(false);
		expect(tree.nodes.get(bad.id)?.name).toBe('Unreadable item');
		expect(tree.childrenOf(root).find((n) => n.name === 'Good')?.readable).toBe(true);
	});
});
