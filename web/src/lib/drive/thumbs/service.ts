/**
 * Thumbnails as blobs: made once by the uploader, sealed through the Sealer and
 * stored beside the node, then read back into object URLs as rows come into view.
 */
import type { Api } from '$lib/api/client';
import { isApiError } from '$lib/api/types';
import type { Sealer } from '$lib/crypto/sealer';
import { newId } from '../ids';
import { Limiter } from '../retry';
import type { DriveNode, DriveTree } from '../tree';
import { digestHeader } from '../upload/engine';
import { renderThumbnail, thumbKindOf } from './generate';

export interface ThumbDeps {
	api: Pick<Api, 'getBlob' | 'putSmallBlob'>;
	sealer: Sealer;
	tree: Pick<DriveTree, 'nodeKey' | 'refresh'>;
	render?: typeof renderThumbnail;
	toUrl?: (blob: Blob) => string;
	revoke?: (url: string) => void;
}

export interface Thumbnails {
	/** Makes and stores the thumbnail of a file just uploaded. Never fails out loud. */
	make(node: DriveNode, file: Blob & { name: string; type: string; size: number }): Promise<void>;
	/** An object URL for a node's thumbnail, or null if it has none that opens. */
	urlFor(node: Pick<DriveNode, 'id' | 'thumbBlobId'>): Promise<string | null>;
	clear(): void;
}

export function createThumbnails(deps: ThumbDeps): Thumbnails {
	const { api, sealer, tree } = deps;
	const render = deps.render ?? renderThumbnail;
	const toUrl = deps.toUrl ?? ((blob) => URL.createObjectURL(blob));
	const revoke = deps.revoke ?? ((url) => URL.revokeObjectURL(url));
	const urls = new Map<string, Promise<string | null>>();
	const making = new Limiter(2);
	const reading = new Limiter(6);

	return {
		async make(node, file) {
			const kind = thumbKindOf(file);
			if (kind === null) return;
			await making
				.run(async () => {
					const image = await render(file, kind);
					if (image === null) return;
					const key = await tree.nodeKey(node.id);
					const blobId = newId();
					const sealed = sealer.sealThumbnail(key, node.id, blobId, image);
					await api.putSmallBlob(
						blobId,
						{ kind: 'thumb', suite: sealer.suite, node_id: node.id },
						sealed,
						digestHeader(sealed)
					);
					await tree.refresh(node.id);
				})
				.catch(() => {
					// A thumbnail is a nicety: the file itself is safely up.
				});
		},
		urlFor(node) {
			const blobId = node.thumbBlobId;
			if (blobId === null) return Promise.resolve(null);
			let url = urls.get(blobId);
			if (url === undefined) {
				url = reading.run(async () => {
					try {
						const stored = await api.getBlob(blobId);
						const key = await tree.nodeKey(node.id);
						const image = sealer.openThumbnail(key, node.id, blobId, stored);
						return toUrl(new Blob([image], { type: 'image/webp' }));
					} catch (e) {
						// Tampered with or gone, it just shows the icon; a lost session is someone else's.
						if (isApiError(e, 'unauthorized')) urls.delete(blobId);
						return null;
					}
				});
				urls.set(blobId, url);
			}
			return url;
		},
		clear() {
			for (const url of urls.values()) void url.then((u) => u && revoke(u));
			urls.clear();
		}
	};
}
