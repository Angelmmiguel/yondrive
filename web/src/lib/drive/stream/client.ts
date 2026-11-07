/**
 * The page's side of streaming: registers the service worker, hands it what a
 * stream needs, and answers when it asks again after a restart. What it keeps here
 * is a recipe for the key, not the key: the worker holds that, in memory, until a
 * lock or a release.
 */
import type { Sealer } from '$lib/crypto/sealer';
import type { VerifiedVersion } from '../download/reader';
import { newId } from '../ids';
import { STREAM_PATH, type PageMessage, type StreamInfo, type WorkerMessage } from './host';

export interface StreamRequest {
	version: VerifiedVersion;
	nodeKey: Uint8Array;
	filename: string;
	mime: string | null;
}

export interface StreamClient {
	/** A URL the service worker answers, or null if this page cannot stream right now. */
	open(request: StreamRequest): Promise<string | null>;
	release(url: string): void;
	/** Tells the worker to forget every key, and forgets the recipes. */
	clear(): void;
	stop(): void;
}

/** Whether a page in this context can have a service worker at all. */
export function canStream(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.isSecureContext === true &&
		'serviceWorker' in navigator &&
		navigator.serviceWorker !== undefined
	);
}

const CONTROL_WAIT_MS = 3000;

/** The worker controlling this page, waiting briefly for the claim on a first visit. */
async function controller(container: ServiceWorkerContainer): Promise<ServiceWorker | null> {
	if (container.controller !== null) return container.controller;
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(container.controller), CONTROL_WAIT_MS);
		container.addEventListener(
			'controllerchange',
			() => {
				clearTimeout(timer);
				resolve(container.controller);
			},
			{ once: true }
		);
	});
}

export function createStreamClient(
	sealer: Sealer,
	onerror: (integrity: boolean) => void
): StreamClient {
	const known = new Map<string, StreamRequest>();

	function infoOf(id: string, request: StreamRequest): { info: StreamInfo; send: ArrayBuffer[] } {
		const { version, nodeKey, filename, mime } = request;
		const key = sealer.versionKey(nodeKey, version.ref).buffer;
		const hashes = version.hashes.slice().buffer;
		return {
			info: {
				id,
				suite: sealer.suite,
				ref: { ...version.ref },
				blobId: version.blobId,
				size: version.size,
				storedSize: version.storedSize,
				frameCount: version.frameCount,
				hashes,
				mime,
				filename,
				key
			},
			send: [key, hashes]
		};
	}

	function onmessage(event: MessageEvent<WorkerMessage>) {
		const message = event.data;
		if (message.type === 'stream-error') {
			if (known.has(message.id)) onerror(message.integrity);
			return;
		}
		if (message.type === 'stream-done') {
			known.delete(message.id);
			return;
		}
		if (message.type !== 'need-stream') return;
		const port = event.ports[0];
		const request = known.get(message.id);
		if (port === undefined) return;
		if (request === undefined) {
			port.postMessage(null);
			return;
		}
		try {
			const { info, send } = infoOf(message.id, request);
			port.postMessage(info, send);
		} catch {
			// Locked meanwhile: the key is zero, and this page has nothing to give.
			port.postMessage(null);
		}
	}

	const container = canStream() ? navigator.serviceWorker : null;
	container?.addEventListener('message', onmessage);

	const post = (message: PageMessage, transfer: ArrayBuffer[] = []) => {
		container?.controller?.postMessage(message, transfer);
	};

	return {
		async open(request) {
			if (container === null) return null;
			const worker = await controller(container);
			if (worker === null) return null;
			const id = newId();
			known.set(id, request);
			const { info, send } = infoOf(id, request);
			worker.postMessage({ type: 'register', info } satisfies PageMessage, send);
			return `${STREAM_PATH}${id}`;
		},
		release(url) {
			const id = url.slice(STREAM_PATH.length);
			known.delete(id);
			post({ type: 'release', id });
		},
		clear() {
			known.clear();
			post({ type: 'clear' });
		},
		stop() {
			known.clear();
			post({ type: 'clear' });
			container?.removeEventListener('message', onmessage);
		}
	};
}

/** Registers the worker where one can run. Failure just means the fallback. */
export function registerStreamWorker(): void {
	if (!canStream()) return;
	void navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}
