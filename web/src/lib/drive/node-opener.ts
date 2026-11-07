/**
 * How the tree opens nodes: small pages right here, larger ones in a worker so that
 * a folder of thousands does not freeze the page. Where there is no `Worker` it
 * all runs here, with the same result.
 */
import type { Sealer } from '$lib/crypto/sealer';
import { openNodes, type NodeRecord, type OpenedNode } from './open-nodes';
import type { OpenNodesReply, OpenNodesRequest } from './workers/nodes.worker';

export type NodeOpener = (
	parentKey: Uint8Array,
	parentId: string,
	records: readonly NodeRecord[]
) => Promise<OpenedNode[]>;

/** Below this a page takes about a millisecond (Spike C): a worker would only add latency. */
const WORKER_THRESHOLD = 64;

export interface WorkerNodeOpener {
	open: NodeOpener;
	/** Ends the worker and fails what it had in hand. */
	stop(): void;
}

export function createNodeOpener(sealer: Sealer): WorkerNodeOpener {
	let worker: Worker | null = null;
	let seq = 0;
	const pending = new Map<
		number,
		{ resolve: (o: OpenedNode[]) => void; reject: (e: Error) => void }
	>();

	function failAll(error: Error) {
		for (const { reject } of pending.values()) reject(error);
		pending.clear();
	}

	function start(): Worker {
		if (worker !== null) return worker;
		const created = new Worker(new URL('./workers/nodes.worker.ts', import.meta.url), {
			type: 'module'
		});
		created.onmessage = (event: MessageEvent<OpenNodesReply>) => {
			const reply = event.data;
			const waiting = pending.get(reply.seq);
			pending.delete(reply.seq);
			if (waiting === undefined) return;
			if ('error' in reply) waiting.reject(new Error(reply.error));
			else waiting.resolve(reply.opened);
		};
		created.onerror = (event) => {
			failAll(new Error(event.message || 'node worker failed'));
			created.terminate();
			worker = null;
		};
		worker = created;
		return created;
	}

	return {
		async open(parentKey, parentId, records) {
			if (typeof Worker === 'undefined' || records.length < WORKER_THRESHOLD) {
				return openNodes(sealer, parentKey, parentId, records);
			}
			const key = parentKey.slice();
			const id = ++seq;
			return new Promise<OpenedNode[]>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				const request: OpenNodesRequest = {
					seq: id,
					suite: sealer.suite,
					parentKey: key.buffer,
					parentId,
					records: records.map((r) => ({
						id: r.id,
						wrapped_key: r.wrapped_key,
						sealed_metadata: r.sealed_metadata
					}))
				};
				start().postMessage(request, [key.buffer]);
			});
		},
		stop() {
			worker?.terminate();
			worker = null;
			failAll(new Error('stopped'));
		}
	};
}
