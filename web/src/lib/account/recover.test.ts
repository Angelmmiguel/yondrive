import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidRecoveryPhraseError } from '$lib/crypto/recovery';
import { sealerFor, SUITE_E2E } from '$lib/crypto/sealer';
import {
	fakeServer,
	memoryStorage,
	OTHER_PASSPHRASE,
	PASSPHRASE,
	testDeps,
	TOTP_CODE
} from '$lib/testing/account';
import {
	describeError,
	RekeyMaybeAppliedError,
	WrongCredentialsError,
	WrongRecoveryKeyError
} from './errors';
import type { LoginStep } from './login';
import { openRecovery, type Recovery } from './recover';
import { newRecovery } from './recovery-key';
import { lock, signIn, unlock } from './session';
import { completeSetup } from './setup';

const sealer = sealerFor(SUITE_E2E);
const OTHER_WORDS = () => newRecovery(sealer).words.join(' ');

beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));

async function setUp() {
	const server = fakeServer('e2e');
	const deps = testDeps(server);
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
				mode: 'e2e'
			},
			admin: { username: 'admin', email: '', passphrase: PASSPHRASE, recoveryKey: pending.key }
		},
		deps
	);
	return { server, deps, phrase };
}

function done(step: LoginStep<Recovery>): Recovery {
	if (step.status !== 'done') throw new Error('expected no challenge');
	return step.value;
}

describe('recovery', () => {
	it('opens with the words and sets a new passphrase and recovery key', async () => {
		const { server, deps, phrase } = await setUp();
		const originalKek = server.users.get('admin')!.keys!.wrapped_master_key;

		const recovery = done(await openRecovery({ username: 'admin', phrase, sealer }, deps));
		const next = newRecovery(sealer);
		await recovery.finish({ passphrase: OTHER_PASSPHRASE, recoveryKey: next.key }).then(() => {});

		expect(deps.session.status).toBe('unlocked');
		expect(server.users.get('admin')!.keys!.wrapped_master_key).not.toBe(originalKek);
		expect(server.calls).toContain('rekey');

		// The old passphrase and the old words are dead; the new ones work.
		const fresh = testDeps(server);
		await expect(
			signIn({ username: 'admin', passphrase: PASSPHRASE }, fresh)
		).rejects.toBeInstanceOf(WrongCredentialsError);
		await expect(openRecovery({ username: 'admin', phrase, sealer }, fresh)).rejects.toBeInstanceOf(
			WrongRecoveryKeyError
		);
		await signIn({ username: 'admin', passphrase: OTHER_PASSPHRASE }, fresh);
		expect(fresh.session.status).toBe('unlocked');

		const again = testDeps(server);
		await done(
			await openRecovery({ username: 'admin', phrase: next.words.join(' '), sealer }, again)
		).abandon();
	});

	it('keeps the same master key, so that everything still opens', async () => {
		const { server, deps, phrase } = await setUp();
		await signIn({ username: 'admin', passphrase: PASSPHRASE }, deps);
		const before = deps.session.keys!.masterKey.slice();
		await lock(deps);

		const recovery = done(await openRecovery({ username: 'admin', phrase, sealer }, deps));
		await recovery.finish({ passphrase: OTHER_PASSPHRASE, recoveryKey: newRecovery(sealer).key });
		expect(deps.session.keys!.masterKey).toEqual(before);

		await lock(deps);
		await unlock(OTHER_PASSPHRASE, deps);
		expect(deps.session.keys!.masterKey).toEqual(before);
		expect(server.state.signedIn).not.toBeNull();
	});

	it('does not reach the server with words that are not a key', async () => {
		const { server, deps } = await setUp();
		server.calls.length = 0;
		await expect(
			openRecovery({ username: 'admin', phrase: 'not enough words', sealer }, deps)
		).rejects.toBeInstanceOf(InvalidRecoveryPhraseError);
		expect(server.calls).toEqual([]);
	});

	it('refuses a valid key of someone else', async () => {
		const { deps } = await setUp();
		await expect(
			openRecovery({ username: 'admin', phrase: OTHER_WORDS(), sealer }, deps)
		).rejects.toBeInstanceOf(WrongRecoveryKeyError);
	});

	it('takes the TOTP step like a sign-in', async () => {
		const { server, deps, phrase } = await setUp();
		server.users.get('admin')!.totp = true;
		const step = await openRecovery({ username: 'admin', phrase, sealer }, deps);
		if (step.status !== 'totp') throw new Error('expected a challenge');
		const recovery = done(await step.submit({ code: TOTP_CODE }));
		await recovery.finish({ passphrase: OTHER_PASSPHRASE, recoveryKey: newRecovery(sealer).key });
		expect(deps.session.status).toBe('unlocked');
	});

	it('stays open for another try when the rekey fails', async () => {
		const { server, deps, phrase } = await setUp();
		const recovery = done(await openRecovery({ username: 'admin', phrase, sealer }, deps));
		const rekey = server.api.rekey;
		server.api.rekey = async () => {
			throw new Error('down');
		};
		const next = newRecovery(sealer);
		await expect(
			recovery.finish({ passphrase: OTHER_PASSPHRASE, recoveryKey: next.key })
		).rejects.toThrow('down');
		expect(deps.session.status).not.toBe('unlocked');

		server.api.rekey = rekey;
		await recovery.finish({ passphrase: OTHER_PASSPHRASE, recoveryKey: next.key });
		expect(deps.session.status).toBe('unlocked');
	});

	it('says the change may have gone through when a retry is refused after a lost response', async () => {
		const { server, deps, phrase } = await setUp();
		const recovery = done(await openRecovery({ username: 'admin', phrase, sealer }, deps));
		const rekey = server.api.rekey;
		server.api.rekey = async (body) => {
			await rekey(body);
			throw new TypeError('lost');
		};
		const next = newRecovery(sealer);
		await expect(
			recovery.finish({ passphrase: OTHER_PASSPHRASE, recoveryKey: next.key })
		).rejects.toThrow('lost');

		server.api.rekey = rekey;
		const retry = recovery.finish({ passphrase: OTHER_PASSPHRASE, recoveryKey: next.key });
		await expect(retry).rejects.toBeInstanceOf(RekeyMaybeAppliedError);
		await retry.catch((e) =>
			expect(describeError(e)).toBe(
				'The change may already have gone through. Sign in with your new passphrase.'
			)
		);
	});

	it('zeroes everything and ends the login when abandoned', async () => {
		const { server, deps, phrase } = await setUp();
		const recovery = done(await openRecovery({ username: 'admin', phrase, sealer }, deps));
		await recovery.abandon();
		expect(server.state.signedIn).toBeNull();
		await expect(
			recovery.finish({ passphrase: OTHER_PASSPHRASE, recoveryKey: newRecovery(sealer).key })
		).rejects.toThrow('abandoned');
	});
});
