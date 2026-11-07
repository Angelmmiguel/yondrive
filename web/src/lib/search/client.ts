/** Reaches the index in its worker, or in place where the browser has none. */
import type { Suite } from '$lib/crypto/sealer';
import { createEngine, type IndexClient } from './engine';
import type { SearchReply, SearchRequest } from './search.worker';

/** `key` is the client's from here on. */
export function createIndexClient(suite: Suite, key: Uint8Array<ArrayBuffer>): IndexClient {
	if (typeof Worker === 'undefined') return createEngine(suite, key);
	const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
	let seq = 0;
	let stopped = false;
	const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();

	const failAll = (error: Error) => {
		for (const { reject } of pending.values()) reject(error);
		pending.clear();
	};
	worker.onmessage = (event: MessageEvent<SearchReply>) => {
		const reply = event.data;
		const waiting = pending.get(reply.seq);
		pending.delete(reply.seq);
		if (waiting === undefined) return;
		if ('error' in reply) waiting.reject(new Error(reply.error));
		else waiting.resolve(reply.value as never);
	};
	worker.onerror = (event) => {
		failAll(new Error(event.message || 'search worker failed'));
	};

	function send<T>(request: SearchRequest, transfer: Transferable[] = []): Promise<T> {
		if (stopped) return Promise.reject(new Error('stopped'));
		return new Promise<T>((resolve, reject) => {
			pending.set(request.seq, { resolve: resolve as (v: never) => void, reject });
			worker.postMessage(request, transfer);
		});
	}

	const call = <T>(method: string, args: unknown[], transfer?: Transferable[]) =>
		send<T>({ seq: ++seq, method, args }, transfer);

	void send({ seq: ++seq, method: 'start', suite, key: key.buffer }, [key.buffer]);

	return {
		load: (segments) =>
			call(
				'load',
				[segments],
				segments.map((one) => one.bytes.buffer)
			),
		beginReconcile: () => call('beginReconcile', []),
		reconcile: (docs) => call('reconcile', [docs]),
		endReconcile: () => call('endReconcile', []),
		upsert: (docs) => call('upsert', [docs]),
		setText: (id, version, text) => call('setText', [id, version, text]),
		search: (query) => call('search', [query]),
		flush: () => call('flush', []),
		compact: (limit) => call('compact', [limit]),
		stored: (token, sizes) => call('stored', [token, sizes]),
		abort: (token) => call('abort', [token]),
		stop() {
			stopped = true;
			worker.terminate();
			failAll(new Error('stopped'));
		}
	};
}
