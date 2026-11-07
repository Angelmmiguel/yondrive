import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sealerFor, SUITE_E2E, SUITE_NONE } from '$lib/crypto/sealer';
import { PassphraseTooShortError } from '$lib/crypto/kdf';
import { ApiError } from '$lib/api/types';
import { fakeServer, memoryPin, memoryStorage, PASSPHRASE, testDeps } from '$lib/testing/account';
import { ModeRefusedError } from './errors';
import { newRecovery } from './recovery-key';
import { completeSetup, register } from './setup';
import { signIn } from './session';
import type { Mode, ServerSettingsInput } from '$lib/api/types';

const settings = (mode: Mode): ServerSettingsInput => ({
	name: 'nas',
	public_url: 'http://nas.local',
	default_quota_bytes: 0,
	language: 'en',
	time_zone: 'UTC',
	mode
});

const suites = { e2e: SUITE_E2E, none: SUITE_NONE } as const;

beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));

describe.each(['e2e', 'none'] as const)('setup in mode %s', (mode) => {
	const sealer = sealerFor(suites[mode]);

	const user = () => ({
		username: 'admin',
		email: 'admin@example.com',
		passphrase: PASSPHRASE,
		recoveryKey: newRecovery(sealer).key
	});

	it('creates an admin who can sign in, with the keys the mode wants', async () => {
		const server = fakeServer(mode);
		server.state.setup = false;
		const deps = testDeps(server);

		await completeSetup({ token: 'setup-token', settings: settings(mode), admin: user() }, deps);

		const stored = server.users.get('admin');
		expect(stored?.keys !== undefined).toBe(sealer.encrypted);
		expect(stored?.recoveryAuthKey !== undefined).toBe(sealer.encrypted);
		expect(deps.pin.read()).toBe(suites[mode]);

		await signIn({ username: 'admin', passphrase: PASSPHRASE }, deps);
		expect(deps.session.status).toBe('unlocked');
	});

	it('sends nothing that holds the passphrase', async () => {
		const server = fakeServer(mode);
		await completeSetup(
			{ token: 'setup-token', settings: settings(mode), admin: user() },
			testDeps(server)
		);
		expect(JSON.stringify(server.bodies)).not.toContain(PASSPHRASE);
	});

	it('leaves the device unpinned when the server refuses', async () => {
		const deps = testDeps(fakeServer(mode));
		await expect(
			completeSetup({ token: 'wrong', settings: settings(mode), admin: user() }, deps)
		).rejects.toBeInstanceOf(ApiError);
		expect(deps.pin.read()).toBeNull();
	});

	it('refuses a short passphrase before doing anything', async () => {
		const server = fakeServer(mode);
		await expect(
			completeSetup(
				{
					token: 'setup-token',
					settings: settings(mode),
					admin: { ...user(), passphrase: 'too short' }
				},
				testDeps(server)
			)
		).rejects.toBeInstanceOf(PassphraseTooShortError);
		expect(server.calls).toEqual([]);
	});

	it('registers a user from an invite', async () => {
		const server = fakeServer(mode);
		const deps = testDeps(server);
		await register({ inviteToken: 'invite-token', user: user(), sealer }, deps);
		expect(server.users.has('admin')).toBe(true);
	});

	it('registers without an invite when the server allows it, and passes on its refusal', async () => {
		const server = fakeServer(mode);
		await expect(
			register({ inviteToken: null, user: user(), sealer }, testDeps(server))
		).rejects.toMatchObject({ code: 'signup_closed' });
	});
});

it('stops on a device pinned to the other mode, before anything is sent', async () => {
	const server = fakeServer('none');
	const deps = testDeps(server, { pin: memoryPin(SUITE_E2E) });
	await expect(
		completeSetup(
			{
				token: 'setup-token',
				settings: settings('none'),
				admin: { username: 'a', email: '', passphrase: PASSPHRASE, recoveryKey: new Uint8Array(0) }
			},
			deps
		)
	).rejects.toBeInstanceOf(ModeRefusedError);
	expect(deps.session.refusal).toBe('device-pinned');
	expect(server.calls).toEqual([]);
});

it('omits an empty email', async () => {
	const server = fakeServer('none');
	const sealer = sealerFor(SUITE_NONE);
	await register(
		{
			inviteToken: 'invite-token',
			user: { username: 'a', email: '  ', passphrase: PASSPHRASE, recoveryKey: new Uint8Array(0) },
			sealer
		},
		testDeps(server)
	);
	expect(JSON.stringify(server.bodies[0])).not.toContain('email');
});
