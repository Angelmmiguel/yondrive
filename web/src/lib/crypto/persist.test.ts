import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/types';
import { encodeBase64, type Bytes } from './encoding';
import { generateMasterKey } from './keys';
import {
	clearPersistedMasterKey,
	persistMasterKey,
	resumeMasterKey,
	STORAGE_KEY,
	type SessionKeyApi
} from './persist';

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
	const items = new Map<string, string>();
	return {
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => void items.set(key, value),
		removeItem: (key) => void items.delete(key)
	};
}

let storage: ReturnType<typeof fakeStorage>;
let serverKey: Bytes | null;
let api: {
	putSessionKey: ReturnType<typeof vi.fn>;
	getSessionKey: ReturnType<typeof vi.fn>;
} & SessionKeyApi;

beforeEach(() => {
	storage = fakeStorage();
	vi.stubGlobal('sessionStorage', storage);
	serverKey = null;
	api = {
		// The caller zeroes its buffer afterwards, so a fake server must copy.
		putSessionKey: vi.fn(async (key: Uint8Array) => {
			serverKey = Uint8Array.from(key);
		}),
		getSessionKey: vi.fn(async () => serverKey)
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('persistMasterKey', () => {
	it('hands the server a 32-byte key and stores only ciphertext', async () => {
		const master = generateMasterKey();

		await persistMasterKey(master, api);

		expect(api.putSessionKey).toHaveBeenCalledTimes(1);
		expect(serverKey).toHaveLength(32);
		const stored = storage.getItem(STORAGE_KEY);
		expect(stored).not.toBeNull();
		expect(stored).not.toContain(encodeBase64(master));
		expect(Buffer.from(String(stored), 'base64')).toHaveLength(32 + 41);
	});

	it('zeroes the session key it sent', async () => {
		await persistMasterKey(generateMasterKey(), api);

		expect(api.putSessionKey.mock.calls[0]?.[0]).toEqual(new Uint8Array(32));
	});

	it('stores nothing if the server refuses the key', async () => {
		api.putSessionKey.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(persistMasterKey(generateMasterKey(), api)).rejects.toThrow(ApiError);
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});
});

describe('resumeMasterKey', () => {
	it('round-trips through the server half', async () => {
		const master = generateMasterKey();
		await persistMasterKey(master, api);

		await expect(resumeMasterKey(api)).resolves.toEqual(master);
		expect(api.getSessionKey).toHaveBeenCalledTimes(1);
		expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
	});

	it('is null without asking the server when nothing is stored', async () => {
		await expect(resumeMasterKey(api)).resolves.toBeNull();
		expect(api.getSessionKey).not.toHaveBeenCalled();
	});

	it('clears the blob when the session is gone', async () => {
		await persistMasterKey(generateMasterKey(), api);
		api.getSessionKey.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(resumeMasterKey(api)).resolves.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('clears the blob when the server holds no key', async () => {
		await persistMasterKey(generateMasterKey(), api);
		serverKey = null;

		await expect(resumeMasterKey(api)).resolves.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('clears a blob that does not open', async () => {
		await persistMasterKey(generateMasterKey(), api);
		const stored = Buffer.from(String(storage.getItem(STORAGE_KEY)), 'base64');
		stored[stored.length - 1] ^= 0x01;
		storage.setItem(STORAGE_KEY, stored.toString('base64'));

		await expect(resumeMasterKey(api)).resolves.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('clears a blob that is not even base64', async () => {
		serverKey = new Uint8Array(32).fill(1);
		storage.setItem(STORAGE_KEY, 'garbage!');

		await expect(resumeMasterKey(api)).resolves.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('propagates other failures and keeps the blob', async () => {
		await persistMasterKey(generateMasterKey(), api);
		api.getSessionKey.mockRejectedValue(new TypeError('fetch failed'));

		await expect(resumeMasterKey(api)).rejects.toThrow(TypeError);
		expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
	});
});

describe('clearPersistedMasterKey', () => {
	it('removes the blob', async () => {
		await persistMasterKey(generateMasterKey(), api);

		clearPersistedMasterKey();

		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});
});
