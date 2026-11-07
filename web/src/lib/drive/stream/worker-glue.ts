/** What the service worker needs from its surroundings, apart from `StreamHost`. */
import type { Bytes } from '$lib/crypto/encoding';
import { sleepFor } from '../retry';
import type { StreamInfo, WorkerMessage } from './host';

const ATTEMPTS = 4;
const ASK_TIMEOUT_MS = 5000;

/** The stored bytes of a range, trying again if the connection drops. */
export async function fetchStoredBytes(
	blobId: string,
	start: number,
	end: number,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch
): Promise<Bytes> {
	for (let tried = 1; ; tried++) {
		try {
			const res = await fetcher(`/api/v1/blobs/${encodeURIComponent(blobId)}`, {
				headers: { Range: `bytes=${start}-${end}` },
				credentials: 'same-origin',
				signal
			});
			if (res.status >= 500) throw new TypeError('server error');
			if (!res.ok) throw new Error(`blob answered ${res.status}`);
			return new Uint8Array(await res.arrayBuffer());
		} catch (e) {
			if (!(e instanceof TypeError) || tried >= ATTEMPTS || signal?.aborted) throw e;
			await sleepFor(300 * 2 ** tried, signal);
		}
	}
}

/** The part of a service worker's global scope this needs. */
interface PagesScope {
	clients: {
		matchAll(options: {
			type: 'window';
			includeUncontrolled: boolean;
		}): Promise<readonly { postMessage(message: unknown, transfer: Transferable[]): void }[]>;
	};
}

/** Asks every open page for a stream. The first to have it answers with the key. */
export function createAskPages(sw: PagesScope) {
	return async (id: string): Promise<StreamInfo | null> => {
		const pages = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
		if (pages.length === 0) return null;
		return new Promise((resolve) => {
			let waiting = pages.length;
			const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
			for (const page of pages) {
				const channel = new MessageChannel();
				channel.port1.onmessage = (event: MessageEvent<StreamInfo | null>) => {
					waiting -= 1;
					if (event.data !== null) {
						clearTimeout(timer);
						resolve(event.data);
					} else if (waiting === 0) {
						clearTimeout(timer);
						resolve(null);
					}
				};
				const message: WorkerMessage = { type: 'need-stream', id };
				page.postMessage(message, [channel.port2]);
			}
		});
	};
}
