import { describe, expect, it, vi } from 'vitest';
import { utf8 } from '$lib/crypto/encoding';
import { driveFixture, SUITES } from '$lib/testing/drive';
import { createThumbnails } from './service';

const photo = (name = 'a.jpg') => Object.assign(new Blob(['pixels']), { name });

describe.each(SUITES)('thumbnails in mode %s', (_, suite) => {
	async function fixture() {
		const f = driveFixture(suite);
		await f.tree.start();
		const node = await f.tree.createFile(f.tree.rootId as string, {
			name: 'a.jpg',
			type: 'image/jpeg',
			size: 6,
			modified: 0
		});
		const urls: Blob[] = [];
		const revoke = vi.fn();
		const thumbs = createThumbnails({
			api: f.server.api,
			sealer: f.sealer,
			tree: f.tree,
			render: async () => utf8('thumb') as Uint8Array<ArrayBuffer>,
			toUrl: (blob) => {
				urls.push(blob);
				return `blob:${urls.length}`;
			},
			revoke
		});
		return { ...f, node, thumbs, urls, revoke };
	}

	it('seals it, stores it on the node and opens it back', async () => {
		const { thumbs, node, tree, urls, server, sealer } = await fixture();
		await thumbs.make(node, photo());
		const stored = tree.nodes.get(node.id);
		expect(stored?.thumbBlobId).toBeTruthy();

		const onDisk = server.blobs.get(stored?.thumbBlobId as string) as Uint8Array;
		expect(new TextDecoder().decode(onDisk) === 'thumb').toBe(!sealer.encrypted);

		const url = await thumbs.urlFor(stored as never);
		expect(url).toBe('blob:1');
		expect(await urls[0].text()).toBe('thumb');
		expect(await thumbs.urlFor(stored as never)).toBe('blob:1');
	});

	it('makes none for a format it cannot decode', async () => {
		const { thumbs, tree, node } = await fixture();
		const heic = { ...node, name: 'b.heic' };
		const file = Object.assign(new Blob(['x']), { name: 'b.heic' });
		await thumbs.make(heic, file);
		expect(tree.nodes.get(node.id)?.thumbBlobId).toBeNull();
	});

	it('does not fail out loud when it cannot store one', async () => {
		const { thumbs, server, node, tree } = await fixture();
		server.api.putSmallBlob = (async () => {
			throw new Error('no');
		}) as never;
		await expect(thumbs.make(node, photo())).resolves.toBeUndefined();
		expect(tree.nodes.get(node.id)?.thumbBlobId).toBeNull();
	});

	it('forgets its urls when cleared', async () => {
		const { thumbs, node, tree, revoke } = await fixture();
		await thumbs.make(node, photo());
		await thumbs.urlFor(tree.nodes.get(node.id) as never);
		thumbs.clear();
		await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:1'));
	});
});

it('shows the icon for a thumbnail that was tampered with', async () => {
	const f = driveFixture();
	await f.tree.start();
	const node = await f.tree.createFile(f.tree.rootId as string, {
		name: 'a.jpg',
		type: '',
		size: 1,
		modified: 0
	});
	const thumbs = createThumbnails({
		api: f.server.api,
		sealer: f.sealer,
		tree: f.tree,
		render: async () => utf8('thumb') as Uint8Array<ArrayBuffer>,
		toUrl: () => 'blob:x'
	});
	await thumbs.make(node, Object.assign(new Blob(['p']), { name: 'a.jpg' }));
	f.server.state.tamperBlob = (_id, part) => {
		const flipped = part.slice();
		flipped[5] ^= 1;
		return flipped;
	};
	expect(await thumbs.urlFor(f.tree.nodes.get(node.id) as never)).toBeNull();
});
