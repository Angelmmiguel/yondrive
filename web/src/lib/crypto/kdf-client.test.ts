import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from './encoding';
import { deriveRoot, type KdfParams } from './kdf';
import { deriveRootInWorker } from './kdf-client';
import type { KdfReply, KdfRequest } from './kdf.worker';

const params: KdfParams = {
	name: 'argon2id',
	m: 64,
	t: 1,
	p: 1,
	salt: encodeBase64(new Uint8Array(16))
};
const passphrase = 'correct horse battery';

/**
 * Stands in for the browser's Worker: runs the derivation inline and answers
 * through the same onmessage/onerror surface the client uses.
 */
class FakeWorker {
	static instances: FakeWorker[] = [];
	static reply: ((request: KdfRequest) => KdfReply | unknown) | 'crash' = (request) => ({
		root: deriveRoot(request.passphrase, request.params).buffer
	});

	readonly url: URL;
	readonly options: unknown;
	onmessage: ((event: MessageEvent) => void) | null = null;
	// Node has no ErrorEvent; the client only reads `message` off it.
	onerror: ((event: { message: string }) => void) | null = null;
	terminated = false;

	constructor(url: URL, options: unknown) {
		this.url = url;
		this.options = options;
		FakeWorker.instances.push(this);
	}

	postMessage(request: KdfRequest): void {
		queueMicrotask(() => {
			if (FakeWorker.reply === 'crash') {
				this.onerror?.({ message: 'script failed' });
				return;
			}
			const data = FakeWorker.reply(request);
			this.onmessage?.(new MessageEvent('message', { data }));
		});
	}

	terminate(): void {
		this.terminated = true;
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	FakeWorker.instances = [];
	FakeWorker.reply = (request) => ({ root: deriveRoot(request.passphrase, request.params).buffer });
});

describe('without Worker', () => {
	it('derives on the calling thread and matches deriveRoot', async () => {
		expect(typeof Worker).toBe('undefined');

		await expect(deriveRootInWorker(passphrase, params)).resolves.toEqual(
			deriveRoot(passphrase, params)
		);
	});

	it('surfaces derivation errors', async () => {
		await expect(deriveRootInWorker('short', params)).rejects.toThrow('12 characters');
	});
});

describe('with Worker', () => {
	it('sends the request to a one-shot module worker and terminates it', async () => {
		vi.stubGlobal('Worker', FakeWorker);

		await expect(deriveRootInWorker(passphrase, params)).resolves.toEqual(
			deriveRoot(passphrase, params)
		);

		expect(FakeWorker.instances).toHaveLength(1);
		const [worker] = FakeWorker.instances;
		expect(worker.url.pathname.endsWith('/kdf.worker.ts')).toBe(true);
		expect(worker.options).toEqual({ type: 'module' });
		expect(worker.terminated).toBe(true);
	});

	it('rejects with the worker error and still terminates it', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		FakeWorker.reply = () => ({ error: 'passphrase must be at least 12 characters' });

		await expect(deriveRootInWorker(passphrase, params)).rejects.toThrow('12 characters');
		expect(FakeWorker.instances[0].terminated).toBe(true);
	});

	it('rejects when the worker script fails to run', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		FakeWorker.reply = 'crash';

		await expect(deriveRootInWorker(passphrase, params)).rejects.toThrow('script failed');
		expect(FakeWorker.instances[0].terminated).toBe(true);
	});

	it.each([
		['a root of the wrong length', { root: new ArrayBuffer(16) }],
		['a root that is not a buffer', { root: 'abc' }],
		['an empty reply', {}],
		['no object', 42]
	])('rejects %s', async (_, reply) => {
		vi.stubGlobal('Worker', FakeWorker);
		FakeWorker.reply = () => reply;

		await expect(deriveRootInWorker(passphrase, params)).rejects.toThrow('unexpected reply');
		expect(FakeWorker.instances[0].terminated).toBe(true);
	});
});
