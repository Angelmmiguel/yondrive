import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from './encoding';
import { deriveRoot, type KdfParams } from './kdf';
import type { KdfRequest } from './kdf.worker';

const params: KdfParams = {
	name: 'argon2id',
	m: 8192,
	t: 1,
	p: 1,
	salt: encodeBase64(new Uint8Array(16))
};

/** The worker global the script installs its handler on. */
const scope = {
	onmessage: null as ((event: MessageEvent<KdfRequest>) => void) | null,
	postMessage: vi.fn<(message: unknown, options: { transfer: ArrayBuffer[] }) => void>()
};

beforeAll(async () => {
	vi.stubGlobal('self', scope);
	await import('./kdf.worker');
});

afterAll(() => {
	vi.unstubAllGlobals();
});

function post(request: KdfRequest): [unknown, { transfer: ArrayBuffer[] }] {
	scope.postMessage.mockClear();
	if (scope.onmessage === null) throw new Error('the worker installed no handler');
	scope.onmessage(new MessageEvent('message', { data: request }));
	expect(scope.postMessage).toHaveBeenCalledTimes(1);
	return scope.postMessage.mock.calls[0];
}

describe('kdf worker', () => {
	it('answers with the root, transferred', () => {
		const [reply, options] = post({ passphrase: 'correct horse battery', params });

		expect(reply).toEqual({ root: expect.any(ArrayBuffer) });
		if (reply === null || typeof reply !== 'object' || !('root' in reply)) {
			throw new Error('unreachable');
		}
		if (!(reply.root instanceof ArrayBuffer)) throw new Error('unreachable');
		expect(new Uint8Array(reply.root)).toEqual(deriveRoot('correct horse battery', params));
		expect(options.transfer).toEqual([reply.root]);
	});

	it('refuses parameters below the bounds', () => {
		const [reply] = post({ passphrase: 'correct horse battery', params: { ...params, m: 64 } });

		expect(reply).toEqual({ error: expect.stringContaining('invalid kdf parameters') });
	});

	it('answers with the error message when derivation fails', () => {
		const [reply, options] = post({ passphrase: 'short', params });

		expect(reply).toEqual({ error: 'passphrase must be at least 12 characters' });
		expect(options.transfer).toEqual([]);
	});
});
