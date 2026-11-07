/**
 * Opens pages of nodes off the main thread (Spike C). It keeps nothing between
 * requests: the parent key arrives by transfer, is zeroed after the page, and the
 * keys it opened leave by transfer.
 */
import { zero } from '$lib/crypto/random';
import { sealerFor, type Suite } from '$lib/crypto/sealer';
import { openNodes, type NodeRecord, type OpenedNode } from '../open-nodes';

export interface OpenNodesRequest {
	seq: number;
	suite: Suite;
	parentKey: ArrayBuffer;
	parentId: string;
	records: NodeRecord[];
}

export type OpenNodesReply = { seq: number; opened: OpenedNode[] } | { seq: number; error: string };

self.onmessage = (event: MessageEvent<OpenNodesRequest>) => {
	const { seq, suite, parentId, records } = event.data;
	const parentKey = new Uint8Array(event.data.parentKey);
	let reply: OpenNodesReply;
	const transfer: ArrayBuffer[] = [];
	try {
		const opened = openNodes(sealerFor(suite), parentKey, parentId, records);
		for (const node of opened) if (node.key) transfer.push(node.key.buffer);
		reply = { seq, opened };
	} catch (e) {
		reply = { seq, error: e instanceof Error ? e.message : String(e) };
	} finally {
		zero(parentKey);
	}
	self.postMessage(reply, { transfer });
};
