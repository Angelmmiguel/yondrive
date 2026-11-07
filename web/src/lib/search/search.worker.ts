/**
 * The index off the main thread, so that loading and asking it never holds up a page.
 * It takes the index key once, by transfer. A lock ends this worker.
 */
import type { Suite } from '$lib/crypto/sealer';
import { createEngine } from './engine';

export type SearchRequest =
	| { seq: number; method: 'start'; suite: Suite; key: ArrayBuffer }
	| { seq: number; method: string; args: unknown[] };

export type SearchReply = { seq: number; value: unknown } | { seq: number; error: string };

let engine: ReturnType<typeof createEngine> | null = null;

self.onmessage = async (event: MessageEvent<SearchRequest>) => {
	const request = event.data;
	const { seq } = request;
	try {
		if (request.method === 'start') {
			const { suite, key } = request as Extract<SearchRequest, { key: ArrayBuffer }>;
			engine = createEngine(suite, new Uint8Array(key));
			self.postMessage({ seq, value: null } satisfies SearchReply);
			return;
		}
		const { method, args } = request as Extract<SearchRequest, { args: unknown[] }>;
		const call = engine?.[method as 'search'] as
			((...a: unknown[]) => Promise<unknown>) | undefined;
		if (call === undefined) throw new Error('no such method');
		const value = await call(...args);
		const transfer =
			method === 'flush' || method === 'compact'
				? ((value as { add: { bytes: Uint8Array<ArrayBuffer> }[] } | null)?.add ?? []).map(
						(one) => one.bytes.buffer
					)
				: [];
		self.postMessage({ seq, value } satisfies SearchReply, { transfer });
	} catch (e) {
		self.postMessage({
			seq,
			error: e instanceof Error ? e.message : String(e)
		} satisfies SearchReply);
	}
};
