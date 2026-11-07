import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sealerFor, SUITE_E2E, SUITE_NONE } from '$lib/crypto/sealer';
import { encodeBase64, decodeBase64 } from '$lib/crypto/encoding';
import { STORAGE_KEY } from '$lib/crypto/persist';
import { ZeroKeyError } from '$lib/crypto/random';
import { InvalidKdfParamsError, PassphraseTooShortError } from '$lib/crypto/kdf';
import {
	fakeServer,
	memoryPin,
	memoryStorage,
	memoryTabs,
	OTHER_PASSPHRASE,
	PASSPHRASE,
	testDeps,
	TOTP_CODE,
	type FakeServer
} from '$lib/testing/account';
import type { Deps } from './deps';
import { ModeRefusedError, WrongCredentialsError, WrongPassphraseError } from './errors';
import { newRecovery } from './recovery-key';
import { completeSetup } from './setup';
import { followOtherTabs, lock, resume, signIn, signOut, unlock } from './session';
import type { Mode } from '$lib/api/types';

const suites = { e2e: SUITE_E2E, none: SUITE_NONE } as const;
let storage: Storage;

beforeEach(() => {
	storage = memoryStorage();
	vi.stubGlobal('sessionStorage', storage);
});

async function serverWithUser(mode: Mode): Promise<{ server: FakeServer; deps: Deps }> {
	const server = fakeServer(mode);
	const deps = testDeps(server);
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
			admin: {
				username: 'admin',
				email: '',
				passphrase: PASSPHRASE,
				recoveryKey: newRecovery(sealerFor(suites[mode])).key
			}
		},
		deps
	);
	return { server, deps };
}

const signedIn = async (deps: Deps) => {
	const step = await signIn({ username: 'admin', passphrase: PASSPHRASE }, deps);
	expect(step.status).toBe('done');
};

describe.each(['e2e', 'none'] as const)('in mode %s', (mode) => {
	const encrypted = sealerFor(suites[mode]).encrypted;

	it('signs in, fetching the parameters and sending the auth key', async () => {
		const { server, deps } = await serverWithUser(mode);
		server.calls.length = 0;

		await signedIn(deps);

		expect(server.calls.slice(0, 2)).toEqual(['getKdf', 'login']);
		expect(deps.session.status).toBe('unlocked');
		expect(deps.session.sealer?.encrypted).toBe(encrypted);
		expect(deps.session.keys?.masterKey.length).toBe(encrypted ? 32 : 0);
	});

	it('refuses a wrong passphrase with the error of a wrong username', async () => {
		const { deps } = await serverWithUser(mode);
		await expect(
			signIn({ username: 'admin', passphrase: OTHER_PASSPHRASE }, deps)
		).rejects.toBeInstanceOf(WrongCredentialsError);
		await expect(
			signIn({ username: 'nobody', passphrase: PASSPHRASE }, deps)
		).rejects.toBeInstanceOf(WrongCredentialsError);
		expect(deps.session.status).not.toBe('unlocked');
	});

	it('asks for a code, keeps a wrong one retryable, and takes the right one', async () => {
		const { server, deps } = await serverWithUser(mode);
		server.users.get('admin')!.totp = true;
		const derive = vi.spyOn(deps, 'deriveRoot');

		const step = await signIn({ username: 'admin', passphrase: PASSPHRASE }, deps);
		if (step.status !== 'totp') throw new Error('expected a challenge');
		await expect(step.submit({ code: '000000' })).rejects.toMatchObject({ code: 'totp_invalid' });
		expect(deps.session.status).not.toBe('unlocked');

		const next = await step.submit({ code: TOTP_CODE });
		expect(next.status).toBe('done');
		expect(deps.session.status).toBe('unlocked');
		expect(derive).toHaveBeenCalledTimes(1);
	});

	it('takes a TOTP recovery code in place of a code', async () => {
		const { server, deps } = await serverWithUser(mode);
		server.users.get('admin')!.totp = true;
		const step = await signIn({ username: 'admin', passphrase: PASSPHRASE }, deps);
		if (step.status !== 'totp') throw new Error('expected a challenge');
		await step.submit({ recoveryCode: 'recovery-code' });
		expect(deps.session.status).toBe('unlocked');
	});

	it('resumes after a reload without asking for anything if it can', async () => {
		const { server, deps } = await serverWithUser(mode);
		await signedIn(deps);
		const before = deps.session.keys?.masterKey.slice();

		const reloaded = testDeps(server, { pin: deps.pin });
		await resume(await server.api.getMe(), reloaded);

		expect(reloaded.session.status).toBe('unlocked');
		expect(reloaded.session.keys?.masterKey).toEqual(before);
	});

	it('signs out, ending the session and the keys', async () => {
		const { server, deps } = await serverWithUser(mode);
		await signedIn(deps);
		const master = deps.session.keys!.masterKey;

		await signOut(deps);

		expect(deps.session.status).toBe('signed-out');
		expect(master.every((b) => b === 0)).toBe(true);
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
		expect(server.state.signedIn).toBeNull();
	});
});

describe('split session key', () => {
	it('keeps neither half useful alone', async () => {
		const { server, deps } = await serverWithUser('e2e');
		await signedIn(deps);
		const master = encodeBase64(deps.session.keys!.masterKey);

		expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).not.toContain(master);
		expect(server.state.sessionKey).not.toBeNull();
		expect(JSON.stringify(server.bodies)).not.toContain(master);
	});

	it('leaves the session locked when the server half is gone, as after a restart', async () => {
		const { server, deps } = await serverWithUser('e2e');
		await signedIn(deps);
		server.state.sessionKey = null;

		const reloaded = testDeps(server, { pin: deps.pin });
		await resume(await server.api.getMe(), reloaded);

		expect(reloaded.session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('leaves the session locked when the sealed half does not open', async () => {
		const { server, deps } = await serverWithUser('e2e');
		await signedIn(deps);
		server.state.sessionKey = encodeBase64(new Uint8Array(32).fill(9));

		const reloaded = testDeps(server, { pin: deps.pin });
		await resume(await server.api.getMe(), reloaded);

		expect(reloaded.session.status).toBe('locked');
	});
});

describe('unlock', () => {
	async function lockedSession() {
		const context = await serverWithUser('e2e');
		await signedIn(context.deps);
		await lock(context.deps);
		return context;
	}

	it('opens the keys with the passphrase', async () => {
		const { deps, server } = await lockedSession();
		await unlock(PASSPHRASE, deps);
		expect(deps.session.status).toBe('unlocked');
		expect(deps.session.keys?.masterKey).toHaveLength(32);
		expect(server.state.sessionKey).not.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
	});

	it('says so for a wrong passphrase and stays locked', async () => {
		const { deps } = await lockedSession();
		await expect(unlock(OTHER_PASSPHRASE, deps)).rejects.toBeInstanceOf(WrongPassphraseError);
		expect(deps.session.status).toBe('locked');
	});

	it('refuses a passphrase too short to be one without running the KDF', async () => {
		const { deps } = await lockedSession();
		const derive = vi.spyOn(deps, 'deriveRoot');
		await expect(unlock('short', deps)).rejects.toBeInstanceOf(PassphraseTooShortError);
		expect(derive).not.toHaveBeenCalled();
	});

	it('refuses parameters below the floor from the server', async () => {
		const { deps, server } = await lockedSession();
		server.state.tamper = (a) => ({ ...a, kdf: { ...a.kdf, m: 1024 } });
		await expect(unlock(PASSPHRASE, deps)).rejects.toBeInstanceOf(InvalidKdfParamsError);
	});
});

describe('lock', () => {
	it('zeroes the keys, deletes the server half and forgets the sealed half', async () => {
		const { server, deps } = await serverWithUser('e2e');
		await signedIn(deps);
		const keys = deps.session.keys!;

		await lock(deps);

		expect(deps.session.status).toBe('locked');
		expect(deps.session.keys).toBeNull();
		for (const key of [
			keys.masterKey,
			keys.identity.x25519.privateKey,
			keys.identity.ed25519.privateKey
		]) {
			expect(key.every((b) => b === 0)).toBe(true);
		}
		expect(server.state.sessionKey).toBeNull();
		expect(server.state.signedIn).not.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('makes work in flight fail, since a zeroed key opens and seals nothing', async () => {
		const { deps } = await serverWithUser('e2e');
		await signedIn(deps);
		const { sealer, keys } = deps.session;
		const nodeKey = sealer!.newNodeKey();

		await lock(deps);

		expect(() => sealer!.wrapRootNodeKey(nodeKey, keys!.masterKey, 'n')).toThrow(ZeroKeyError);
	});

	it('does not need the server to finish', async () => {
		const { server, deps } = await serverWithUser('e2e');
		await signedIn(deps);
		server.state.signedIn = null;
		await expect(lock(deps)).resolves.toBeUndefined();
		expect(deps.session.status).toBe('locked');
	});

	it('wins over an unlock still storing its half', async () => {
		const { server, deps } = await serverWithUser('e2e');
		await signedIn(deps);
		await lock(deps);
		const put = server.api.putSessionKey;
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		server.api.putSessionKey = async (body) => {
			await held;
			return put(body);
		};

		const unlocking = unlock(PASSPHRASE, deps);
		await vi.waitFor(() => expect(deps.session.status).toBe('unlocked'));
		await lock(deps);
		release();
		await unlocking;

		expect(deps.session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
		expect(server.state.sessionKey).toBeNull();
	});
});

describe('other tabs', () => {
	async function twoTabs() {
		const { server, deps } = await serverWithUser('e2e');
		const tabs = memoryTabs();
		const one = { ...deps, channel: tabs.channel() };
		const two = testDeps(server, { pin: deps.pin, channel: tabs.channel() });
		await signedIn(one);
		await resume(await server.api.getMe(), two);
		followOtherTabs(two);
		return { server, one, two };
	}

	it('follow a lock at once', async () => {
		const { one, two } = await twoTabs();
		const keys = two.session.keys!;
		await lock(one);
		expect(two.session.status).toBe('locked');
		expect(keys.masterKey.every((b) => b === 0)).toBe(true);
	});

	it('follow a sign-out at once', async () => {
		const { one, two } = await twoTabs();
		await signOut(one);
		expect(two.session.status).toBe('signed-out');
	});

	it('stop following when told', async () => {
		const { server, deps } = await serverWithUser('e2e');
		const tabs = memoryTabs();
		const one = { ...deps, channel: tabs.channel() };
		const two = testDeps(server, { pin: deps.pin, channel: tabs.channel() });
		await signedIn(one);
		await resume(await server.api.getMe(), two);
		followOtherTabs(two)();
		await lock(one);
		expect(two.session.status).toBe('unlocked');
	});
});

describe('the downgrade guard', () => {
	const hideNothing = (mode: Mode) => (a: Parameters<FakeServer['state']['tamper']>[0]) => ({
		...a,
		mode
	});

	it('refuses none for an account with keys, opening nothing and ending the login', async () => {
		const { server, deps } = await serverWithUser('e2e');
		server.state.tamper = hideNothing('none');
		const fresh = testDeps(server);

		await expect(
			signIn({ username: 'admin', passphrase: PASSPHRASE }, fresh)
		).rejects.toMatchObject({ reason: 'account-has-keys' });
		await vi.waitFor(() => expect(server.state.signedIn).toBeNull());

		expect(fresh.session.refusal).toBe('account-has-keys');
		expect(fresh.session.keys).toBeNull();
		expect(deps.session.keys).toBeNull();
	});

	it('refuses none on a device that pinned end-to-end, even with the keys hidden', async () => {
		const { server, deps } = await serverWithUser('e2e');
		server.state.tamper = (a) => ({ ...a, mode: 'none', keys: undefined });

		await expect(
			signIn({ username: 'admin', passphrase: PASSPHRASE }, deps)
		).rejects.toBeInstanceOf(ModeRefusedError);
		expect(deps.session.refusal).toBe('device-pinned');
	});

	it('refuses end-to-end on a device that pinned none', async () => {
		const { server } = await serverWithUser('e2e');
		const deps = testDeps(server, { pin: memoryPin(SUITE_NONE) });
		await expect(signIn({ username: 'admin', passphrase: PASSPHRASE }, deps)).rejects.toMatchObject(
			{ reason: 'device-pinned' }
		);
	});

	it('refuses a mode it has never heard of', async () => {
		const { server } = await serverWithUser('e2e');
		server.state.tamper = (a) => ({ ...a, mode: 'rot13' as Mode });
		const deps = testDeps(server);
		await expect(signIn({ username: 'admin', passphrase: PASSPHRASE }, deps)).rejects.toMatchObject(
			{ reason: 'unknown-suite' }
		);
	});

	it('pins what a new device accepts', async () => {
		const { server } = await serverWithUser('e2e');
		const deps = testDeps(server);
		await signedIn(deps);
		expect(deps.pin.read()).toBe(SUITE_E2E);
	});

	it('checks on resume too', async () => {
		const { server, deps } = await serverWithUser('e2e');
		await signedIn(deps);
		server.state.tamper = hideNothing('none');
		const reloaded = testDeps(server, { pin: deps.pin });
		await expect(resume(await server.api.getMe(), reloaded)).rejects.toBeInstanceOf(
			ModeRefusedError
		);
		expect(reloaded.session.keys).toBeNull();
	});

	it('checks on unlock too', async () => {
		const { server, deps } = await serverWithUser('e2e');
		await signedIn(deps);
		await lock(deps);
		server.state.tamper = hideNothing('none');
		await expect(unlock(PASSPHRASE, deps)).rejects.toBeInstanceOf(ModeRefusedError);
		expect(deps.session.keys).toBeNull();
	});
});

it('keeps the master key out of every request', async () => {
	const { server, deps } = await serverWithUser('e2e');
	await signedIn(deps);
	const master = encodeBase64(deps.session.keys!.masterKey);
	const sent = JSON.stringify(server.bodies);
	expect(sent).not.toContain(master);
	expect(decodeBase64(master)).toHaveLength(32);
});
