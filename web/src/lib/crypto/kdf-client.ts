/**
 * Main-thread side of the KDF worker. Argon2id at the production cost takes
 * seconds and would freeze the page, so it runs in a one-shot module worker
 * that is terminated as soon as it answers.
 */
import type { Bytes } from './encoding';
import { deriveLinkRoot, deriveRoot, type KdfParams } from './kdf';
import { KEY_LENGTH } from './random';
import type { KdfRequest } from './kdf.worker';

/**
 * Derives the root in a worker. Where `Worker` does not exist (node, tests)
 * it derives synchronously instead: the result is identical, only the thread
 * differs, and every test uses parameters small enough not to matter.
 */
export async function deriveRootInWorker(
	passphrase: string,
	params: KdfParams,
	link = false
): Promise<Bytes> {
	if (typeof Worker === 'undefined') {
		return link ? deriveLinkRoot(passphrase, params) : deriveRoot(passphrase, params);
	}
	const worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' });
	try {
		return await new Promise<Bytes>((resolve, reject) => {
			worker.onmessage = (event: MessageEvent<unknown>) => {
				try {
					resolve(rootFromReply(event.data));
				} catch (e) {
					reject(e instanceof Error ? e : new Error(String(e)));
				}
			};
			worker.onerror = (event) => {
				reject(new Error(event.message || 'kdf worker failed'));
			};
			// A plain copy: parameters read off reactive state are proxies, which
			// the structured clone refuses.
			const request: KdfRequest = { passphrase, params: { ...params }, link };
			worker.postMessage(request);
		});
	} finally {
		worker.terminate();
	}
}

function rootFromReply(data: unknown): Bytes {
	if (data === null || typeof data !== 'object') {
		throw new Error('kdf worker sent an unexpected reply');
	}
	const reply: Record<string, unknown> = { ...data };
	if (typeof reply.error === 'string') {
		throw new Error(reply.error);
	}
	if (!(reply.root instanceof ArrayBuffer) || reply.root.byteLength !== KEY_LENGTH) {
		throw new Error('kdf worker sent an unexpected reply');
	}
	return new Uint8Array(reply.root);
}
