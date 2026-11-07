import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sealerFor, SUITE_E2E, SUITE_NONE } from '$lib/crypto/sealer';
import { PassphraseTooShortError } from '$lib/crypto/kdf';
import {
	fakeServer,
	losingRekeyResponse,
	memoryStorage,
	OTHER_PASSPHRASE,
	PASSPHRASE,
	testDeps
} from '$lib/testing/account';
import type { Mode } from '$lib/api/types';
import { changePassphrase, replaceRecoveryKey, resetPassword } from './change';
import {
	LockedError,
	WrongCredentialsError,
	WrongPassphraseError,
	WrongRecoveryKeyError
} from './errors';
import { openRecovery } from './recover';
import { newRecovery } from './recovery-key';
import { lock, signIn } from './session';
import { completeSetup } from './setup';

const suites = { e2e: SUITE_E2E, none: SUITE_NONE } as const;

beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));

async function setUp(mode: Mode) {
	const server = fakeServer(mode);
	const deps = testDeps(server);
	const sealer = sealerFor(suites[mode]);
	const pending = newRecovery(sealer);
	const phrase = pending.words.join(' ');
	await completeSetup(
		{
			token: 'setup-token',
			settings: {
				name: 'nas',
				public_url: 'http://nas',
				default_quota_bytes: 0,
				language: 'en',
				time_zone: 'UTC',
				mode
			},
			admin: { username: 'admin', email: '', passphrase: PASSPHRASE, recoveryKey: pending.key }
		},
		deps
	);
	await signIn({ username: 'admin', passphrase: PASSPHRASE }, deps);
	return { server, deps, sealer, phrase };
}

describe.each(['e2e', 'none'] as const)('changing the passphrase in mode %s', (mode) => {
	it('replaces it, keeps the session and the keys', async () => {
		const { server, deps } = await setUp(mode);
		const keysBefore = deps.session.keys;

		await changePassphrase({ current: PASSPHRASE, next: OTHER_PASSPHRASE }, deps);

		expect(deps.session.keys).toBe(keysBefore);
		const fresh = testDeps(server);
		await expect(
			signIn({ username: 'admin', passphrase: PASSPHRASE }, fresh)
		).rejects.toBeInstanceOf(WrongCredentialsError);
		await signIn({ username: 'admin', passphrase: OTHER_PASSPHRASE }, fresh);
		expect(fresh.session.status).toBe('unlocked');
		expect(fresh.session.keys?.masterKey).toEqual(keysBefore?.masterKey);
	});

	it('names a wrong current passphrase', async () => {
		const { deps } = await setUp(mode);
		await expect(
			changePassphrase({ current: 'not the passphrase', next: OTHER_PASSPHRASE }, deps)
		).rejects.toBeInstanceOf(WrongPassphraseError);
	});

	it('refuses a short new one', async () => {
		const { server, deps } = await setUp(mode);
		server.calls.length = 0;
		await expect(
			changePassphrase({ current: PASSPHRASE, next: 'short' }, deps)
		).rejects.toBeInstanceOf(PassphraseTooShortError);
		expect(server.calls).not.toContain('rekey');
	});
});

it('fails with the lock when one arrives during the KDF, and sends nothing', async () => {
	const { server, deps } = await setUp('e2e');
	const derive = deps.deriveRoot;
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	deps.deriveRoot = async (passphrase, params) => {
		await held;
		return derive(passphrase, params);
	};
	server.calls.length = 0;

	const changing = changePassphrase({ current: PASSPHRASE, next: OTHER_PASSPHRASE }, deps);
	await lock(deps);
	release();

	await expect(changing).rejects.toBeInstanceOf(LockedError);
	expect(server.calls).not.toContain('rekey');
});

it('refuses to change anything while locked', async () => {
	const { deps } = await setUp('e2e');
	await lock(deps);
	await expect(
		changePassphrase({ current: PASSPHRASE, next: OTHER_PASSPHRASE }, deps)
	).rejects.toBeInstanceOf(LockedError);
});

describe('replacing the recovery key', () => {
	it('retires the old words and makes the new ones work', async () => {
		const { server, deps, sealer, phrase } = await setUp('e2e');
		const next = newRecovery(sealer);
		const words = next.words.join(' ');

		await replaceRecoveryKey({ current: PASSPHRASE, recoveryKey: next.key }, deps);

		const fresh = testDeps(server);
		await expect(openRecovery({ username: 'admin', phrase, sealer }, fresh)).rejects.toBeInstanceOf(
			WrongRecoveryKeyError
		);
		const step = await openRecovery({ username: 'admin', phrase: words, sealer }, fresh);
		expect(step.status).toBe('done');
	});

	it('leaves the passphrase alone', async () => {
		const { server, deps, sealer } = await setUp('e2e');
		await replaceRecoveryKey({ current: PASSPHRASE, recoveryKey: newRecovery(sealer).key }, deps);
		const fresh = testDeps(server);
		await signIn({ username: 'admin', passphrase: PASSPHRASE }, fresh);
		expect(fresh.session.status).toBe('unlocked');
	});

	it('needs the current passphrase', async () => {
		const { deps, sealer } = await setUp('e2e');
		await expect(
			replaceRecoveryKey(
				{ current: 'not the passphrase', recoveryKey: newRecovery(sealer).key },
				deps
			)
		).rejects.toBeInstanceOf(WrongPassphraseError);
	});
});

describe('password reset', () => {
	it('sets a new password in a mode without keys', async () => {
		const { server, deps } = await setUp('none');
		await resetPassword({ token: 'reset-token', passphrase: OTHER_PASSPHRASE }, deps);
		const fresh = testDeps(server);
		await signIn({ username: 'admin', passphrase: OTHER_PASSPHRASE }, fresh);
		expect(fresh.session.status).toBe('unlocked');
	});

	it('passes on the refusal of a server with keys', async () => {
		const { deps } = await setUp('e2e');
		await expect(
			resetPassword({ token: 'reset-token', passphrase: OTHER_PASSPHRASE }, deps)
		).rejects.toMatchObject({ code: 'wrong_mode' });
	});

	it('passes on a dead link', async () => {
		const { deps } = await setUp('none');
		await expect(
			resetPassword({ token: 'dead', passphrase: OTHER_PASSPHRASE }, deps)
		).rejects.toMatchObject({ code: 'reset_invalid' });
	});
});

describe('after a rekey whose response was lost', () => {
	it('still confirms with the passphrase the server now holds', async () => {
		const { server, deps } = await setUp('none');
		const lossy = { ...deps, api: losingRekeyResponse(server) };

		await expect(
			changePassphrase({ current: PASSPHRASE, next: OTHER_PASSPHRASE }, lossy)
		).rejects.toBeInstanceOf(TypeError);
		expect(deps.session.account?.kdf).not.toEqual(server.users.get('admin')?.kdf);

		await changePassphrase({ current: OTHER_PASSPHRASE, next: PASSPHRASE }, deps);
		await signIn({ username: 'admin', passphrase: PASSPHRASE }, testDeps(server));
	});
});
