/**
 * Opening a page of a folder's children: each node key, then each node's metadata.
 * One bad node does not spoil the page: it comes back with what could not be
 * read left null, and the listing shows it as damaged. Pure, so that it runs the
 * same in the worker and, for a small page, right here.
 */
import { decodeBase64, type Bytes } from '$lib/crypto/encoding';
import type { Sealer } from '$lib/crypto/sealer';

/** The sealed parts of a node. */
export interface NodeRecord {
	id: string;
	wrapped_key: string;
	sealed_metadata: string;
}

export interface OpenedNode {
	id: string;
	key: Bytes | null;
	metadata: unknown;
}

export function openNodes(
	sealer: Sealer,
	parentKey: Uint8Array,
	parentId: string,
	records: readonly NodeRecord[]
): OpenedNode[] {
	return records.map((record) => {
		let key: Bytes;
		try {
			key = sealer.unwrapNodeKey(decodeBase64(record.wrapped_key), parentKey, parentId, record.id);
		} catch {
			return { id: record.id, key: null, metadata: null };
		}
		try {
			const sealed = decodeBase64(record.sealed_metadata);
			return { id: record.id, key, metadata: sealer.openMetadata(key, record.id, sealed) };
		} catch {
			return { id: record.id, key, metadata: null };
		}
	});
}
