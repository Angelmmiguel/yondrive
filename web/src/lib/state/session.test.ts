import { beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '$lib/api/types';
import { sealerFor, SUITE_E2E, type UserKeys } from '$lib/crypto/sealer';
import { Session } from './session.svelte';

const sealer = sealerFor(SUITE_E2E);
const account = { mode: 'e2e' } as unknown as Account;
let keys: UserKeys;
let session: Session;

beforeEach(() => {
	keys = sealer.createUser(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).keys;
	session = new Session();
});

const allZero = (b: Uint8Array) => b.every((x) => x === 0);

describe('session', () => {
	it('opens with the keys it is given', () => {
		session.open(sealer, account, keys);
		expect(session.status).toBe('unlocked');
		expect(session.keys).toBe(keys);
		expect(session.account).toBe(account);
	});

	it('zeroes the keys in place on lock and keeps the account', () => {
		session.open(sealer, account, keys);
		session.lock();
		expect(session.status).toBe('locked');
		expect(session.keys).toBeNull();
		expect(session.account).toBe(account);
		expect(allZero(keys.masterKey)).toBe(true);
		expect(allZero(keys.identity.x25519.privateKey)).toBe(true);
		expect(allZero(keys.identity.ed25519.privateKey)).toBe(true);
	});

	it('stays signed out when told to lock', () => {
		session.signedOut();
		session.lock();
		expect(session.status).toBe('signed-out');
	});

	it('forgets the account and the keys on signing out', () => {
		session.open(sealer, account, keys);
		session.signedOut();
		expect(session.status).toBe('signed-out');
		expect(session.account).toBeNull();
		expect(allZero(keys.masterKey)).toBe(true);
	});

	it('zeroes the keys when the mode is refused', () => {
		session.open(sealer, account, keys);
		session.refuse('account-has-keys');
		expect(session.refusal).toBe('account-has-keys');
		expect(allZero(keys.masterKey)).toBe(true);
	});

	it('zeroes the old keys when opened again', () => {
		session.open(sealer, account, keys);
		const other = sealer.createUser(new Uint8Array(32).fill(3), new Uint8Array(32).fill(4)).keys;
		session.open(sealer, account, other);
		expect(allZero(keys.masterKey)).toBe(true);
		expect(session.keys).toBe(other);
	});
});
