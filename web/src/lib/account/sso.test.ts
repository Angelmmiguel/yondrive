import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, isApiError } from '$lib/api/types';
import { boot } from '$lib/app/boot';
import { failure } from '$lib/app/failure';
import { encodeBase64 } from '$lib/crypto/encoding';
import { deriveRoot, expandRoot, parseKdfParams } from '$lib/crypto/kdf';
import { sealerFor, SUITE_E2E } from '$lib/crypto/sealer';
import {
	fakeServer,
	memoryPin,
	memoryStorage,
	OTHER_PASSPHRASE,
	PASSPHRASE,
	testDeps,
	type FakeServer
} from '$lib/testing/account';
import { Session } from '$lib/state/session.svelte';
import type { Deps } from './deps';
import { changePassphrase, replaceRecoveryKey } from './change';
import { openRecovery, openRecoveryInSession } from './recover';
import {
	changeSettings,
	createDeviceToken,
	deleteUserAccount,
	unlinkUserIdentity
} from './security';
import { lock, signIn, unlock } from './session';
import {
	continueWithInvite,
	continueWithProvider,
	enrol,
	signInAgain,
	ssoErrorMessage,
	takeReturn
} from './sso';
import { WrongCredentialsError, WrongPassphraseError, WrongRecoveryKeyError } from './errors';

const e2e = sealerFor(SUITE_E2E);

beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));

/** The app at load, back from the provider. */
async function backFromProvider(server: FakeServer, overrides: Partial<Deps> = {}) {
	const deps = testDeps(server, { session: new Session(), pin: memoryPin(), ...overrides });
	await boot(deps);
	return deps;
}

async function enrolled(words = e2e.newRecoveryKey()) {
	const server = fakeServer('e2e');
	server.signInThroughProvider('alice');
	const deps = await backFromProvider(server);
	await enrol({ passphrase: PASSPHRASE, recoveryKey: words }, deps);
	return { server, deps, words };
}

/** What an auth key of this passphrase looks like, under the account's parameters. */
async function authKeyOf(server: FakeServer, passphrase: string, username = 'alice') {
	const kdf = parseKdfParams(server.users.get(username)?.kdf);
	return encodeBase64(expandRoot(deriveRoot(passphrase, kdf)).authKey);
}

describe('a first sign-in with keys', () => {
	it('asks to enrol before anything else, and derives nothing from the placeholders', async () => {
		const server = fakeServer('e2e');
		server.signInThroughProvider('alice');
		const derive = vi.fn(testDeps(server).deriveRoot);
		const deps = await backFromProvider(server, { deriveRoot: derive });
		expect(deps.session.status).toBe('enrolling');
		expect(deps.session.keys).toBeNull();
		expect(derive).not.toHaveBeenCalled();
	});

	it('makes the keys here, and sends the unlock auth key once, and no passphrase', async () => {
		const server = fakeServer('e2e');
		server.signInThroughProvider('alice');
		const deps = await backFromProvider(server);
		await enrol({ passphrase: PASSPHRASE, recoveryKey: e2e.newRecoveryKey() }, deps);

		expect(deps.session.status).toBe('unlocked');
		expect(deps.session.keys?.masterKey).toHaveLength(32);
		const body = JSON.stringify(server.bodies.at(-1));
		expect(body).not.toContain(PASSPHRASE);
		expect(server.users.get('alice')?.authKey).toBe(await authKeyOf(server, PASSPHRASE));
		expect(server.calls).not.toContain('login');
	});

	it('leaves things as they were when the server refuses, and a retry works', async () => {
		const server = fakeServer('e2e');
		server.signInThroughProvider('alice');
		const deps = await backFromProvider(server);
		const refuse = vi
			.spyOn(deps.api, 'enrolOidc')
			.mockRejectedValueOnce(new ApiError(0, 'network'));
		await expect(
			enrol({ passphrase: PASSPHRASE, recoveryKey: e2e.newRecoveryKey() }, deps)
		).rejects.toThrow();
		expect(deps.session.status).toBe('enrolling');
		refuse.mockRestore();
		await enrol({ passphrase: PASSPHRASE, recoveryKey: e2e.newRecoveryKey() }, deps);
		expect(deps.session.status).toBe('unlocked');
	});

	it('goes to unlock if another tab was quicker', async () => {
		const server = fakeServer('e2e');
		server.signInThroughProvider('alice');
		const deps = await backFromProvider(server);
		const other = await backFromProvider(server);
		await enrol({ passphrase: PASSPHRASE, recoveryKey: e2e.newRecoveryKey() }, other);
		await enrol({ passphrase: OTHER_PASSPHRASE, recoveryKey: e2e.newRecoveryKey() }, deps);
		expect(deps.session.status).toBe('locked');
		await unlock(PASSPHRASE, deps);
		expect(deps.session.status).toBe('unlocked');
	});
});

describe('an account with keys, from a provider', () => {
	it('locks and unlocks with its passphrase, and the server hears nothing of it', async () => {
		const { server, deps } = await enrolled();
		await lock(deps);
		expect(deps.session.status).toBe('locked');
		server.calls.length = 0;
		await unlock(PASSPHRASE, deps);
		expect(deps.session.status).toBe('unlocked');
		expect(server.calls).not.toContain('login');
		await lock(deps);
		await expect(unlock(OTHER_PASSPHRASE, deps)).rejects.toThrow(WrongPassphraseError);
	});

	it('comes back in a new tab locked, and its passphrase opens it', async () => {
		const { server } = await enrolled();
		vi.stubGlobal('sessionStorage', memoryStorage());
		const deps = await backFromProvider(server);
		expect(deps.session.status).toBe('locked');
		await unlock(PASSPHRASE, deps);
		expect(deps.session.status).toBe('unlocked');
	});

	it('sends the unlock auth key only as a current credential', async () => {
		const { server, deps } = await enrolled();
		const key = await authKeyOf(server, PASSPHRASE);
		await createDeviceToken({ name: 'phone', passphrase: PASSPHRASE }, deps);
		expect(server.bodies.at(-1)).toEqual({ name: 'phone', current_auth_key: key });
		await expect(
			createDeviceToken({ name: 'phone', passphrase: OTHER_PASSPHRASE }, deps)
		).rejects.toThrow(WrongPassphraseError);
	});

	it('changes its unlock passphrase and recovery key like anyone', async () => {
		const { server, deps } = await enrolled();
		await changePassphrase({ current: PASSPHRASE, next: OTHER_PASSPHRASE }, deps);
		await lock(deps);
		await unlock(OTHER_PASSPHRASE, deps);
		const before = server.users.get('alice')?.recoveryAuthKey;
		await replaceRecoveryKey(
			{ current: OTHER_PASSPHRASE, recoveryKey: e2e.newRecoveryKey() },
			deps
		);
		expect(server.users.get('alice')?.recoveryAuthKey).not.toBe(before);
	});

	it('is not signed in by its passphrase or its words, which learn nothing', async () => {
		const { server, deps, words } = await enrolled();
		await deps.api.logout();
		const fresh = testDeps(server);
		await expect(signIn({ username: 'alice', passphrase: PASSPHRASE }, fresh)).rejects.toThrow(
			WrongCredentialsError
		);
		await expect(
			openRecovery(
				{ username: 'alice', phrase: e2e.recoveryWords(words).join(' '), sealer: e2e },
				fresh
			)
		).rejects.toThrow(WrongRecoveryKeyError);
	});

	it('recovers in the session the provider gave: the words open it and replace themselves', async () => {
		const { server, words } = await enrolled();
		vi.stubGlobal('sessionStorage', memoryStorage());
		const deps = await backFromProvider(server);
		expect(deps.session.status).toBe('locked');
		const oldRecovery = server.users.get('alice')?.recoveryAuthKey;
		const recovery = await openRecoveryInSession(
			{ phrase: e2e.recoveryWords(words).join(' ') },
			deps
		);
		server.calls.length = 0;
		server.bodies.length = 0;
		await recovery.finish({ passphrase: OTHER_PASSPHRASE, recoveryKey: e2e.newRecoveryKey() });

		expect(deps.session.status).toBe('unlocked');
		expect(server.calls).not.toContain('login');
		expect(server.calls).not.toContain('logout');
		const rekey = server.bodies[server.calls.indexOf('rekey')] as { current_auth_key: string };
		expect(rekey.current_auth_key).toBe(oldRecovery);
		expect(server.users.get('alice')?.recoveryAuthKey).not.toBe(oldRecovery);

		await lock(deps);
		await unlock(OTHER_PASSPHRASE, deps);
		expect(deps.session.status).toBe('unlocked');
	});

	it('refuses words that do not open it, and giving up keeps the session', async () => {
		const { server, words } = await enrolled();
		const deps = await backFromProvider(server);
		await expect(
			openRecoveryInSession({ phrase: e2e.recoveryWords(e2e.newRecoveryKey()).join(' ') }, deps)
		).rejects.toThrow(WrongRecoveryKeyError);
		const recovery = await openRecoveryInSession(
			{ phrase: e2e.recoveryWords(words).join(' ') },
			deps
		);
		server.calls.length = 0;
		await recovery.abandon();
		expect(server.calls).not.toContain('logout');
	});
});

describe('an account with no keys, from a provider', () => {
	async function signedIn() {
		const server = fakeServer('none');
		server.signInThroughProvider('bob');
		const deps = await backFromProvider(server);
		return { server, deps };
	}

	it('is simply open, and never asked for a passphrase', async () => {
		const { deps } = await signedIn();
		expect(deps.session.status).toBe('unlocked');
		expect(deps.session.asksPassphrase).toBe(false);
	});

	it('sends an empty credential, derived from nothing', async () => {
		const { server, deps } = await signedIn();
		const derive = vi.spyOn(deps, 'deriveRoot');
		await createDeviceToken({ name: 'phone', passphrase: '' }, deps);
		expect(server.bodies.at(-1)).toEqual({ name: 'phone', current_auth_key: '' });
		await unlinkUserIdentity({ userId: 'x', passphrase: '' }, deps);
		await deleteUserAccount({ userId: 'x', passphrase: '' }, deps);
		await changeSettings({ request: { local_accounts: true }, passphrase: '' }, deps);
		expect(server.bodies.at(-1)).toEqual({ local_accounts: true, current_auth_key: '' });
		expect(derive).not.toHaveBeenCalled();
	});

	it('goes to sign in again when the sign-in is too old, and back to where it was', async () => {
		const { server, deps } = await signedIn();
		server.state.recentSignIn = false;
		let caught: unknown;
		await createDeviceToken({ name: 'phone', passphrase: '' }, deps).catch((e) => (caught = e));
		expect(isApiError(caught, 'reauth_required')).toBe(true);
		const storage = memoryStorage();
		vi.stubGlobal('sessionStorage', storage);
		vi.stubGlobal('location', { pathname: '/settings' });
		const said = failure(caught, deps);
		vi.unstubAllGlobals();
		vi.stubGlobal('sessionStorage', memoryStorage());
		expect(said).toMatch(/Sign in again/);
		expect(server.left).toEqual(['/api/v1/auth/oidc/start?fresh=true']);
		expect(takeReturn(storage)).toBe('/settings');
		expect(takeReturn(storage)).toBeNull();
	});
});

describe('around the provider', () => {
	it('leaves as a whole page, and an invite goes through its POST', async () => {
		const server = fakeServer('e2e');
		const deps = testDeps(server);
		continueWithProvider(deps);
		await continueWithInvite('invite-token', deps);
		expect(server.left).toEqual(['/api/v1/auth/oidc/start', 'https://id.example/authorize']);
		expect(server.bodies.at(-1)).toEqual({ invite_token: 'invite-token' });
		await expect(continueWithInvite('nope', deps)).rejects.toSatisfy((e) =>
			isApiError(e, 'invite_invalid')
		);
	});

	it('says something friendly for each code, and nothing of one it does not know', () => {
		for (const code of [
			'sso_state_invalid',
			'sso_denied',
			'sso_provider_error',
			'sso_token_invalid',
			'sso_identity_conflict',
			'sso_email_unverified',
			'sso_not_invited',
			'rate_limited',
			'user_disabled',
			'invite_invalid',
			'internal'
		]) {
			expect(ssoErrorMessage(code)).not.toContain(code);
			expect(ssoErrorMessage(code).length).toBeGreaterThan(10);
		}
		expect(ssoErrorMessage('<script>alert(1)</script>')).toBe(ssoErrorMessage('internal'));
		expect(ssoErrorMessage('constructor')).toBe(ssoErrorMessage('internal'));
	});

	it('only ever returns to a page of this app', () => {
		const storage = memoryStorage();
		const left: string[] = [];
		signInAgain({ leave: (url) => left.push(url) }, storage, '/admin');
		expect(takeReturn(storage)).toBe('/admin');
		storage.setItem('yondrive.return', '//evil.example');
		expect(takeReturn(storage)).toBeNull();
		storage.setItem('yondrive.return', 'https://evil.example');
		expect(takeReturn(storage)).toBeNull();
		expect(left).toHaveLength(1);
	});
});
