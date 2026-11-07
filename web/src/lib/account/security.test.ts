import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	fakeServer,
	losingRekeyResponse,
	memoryStorage,
	OTHER_PASSPHRASE,
	PASSPHRASE,
	testDeps,
	TOTP_CODE
} from '$lib/testing/account';
import { changePassphrase } from './change';
import { sealerFor, SUITE_NONE } from '$lib/crypto/sealer';
import { WrongPassphraseError } from './errors';
import { newRecovery } from './recovery-key';
import {
	confirmTotp,
	createDeviceToken,
	createInvite,
	createPasswordResetLink,
	disableTotp,
	enrolTotp
} from './security';
import { signIn } from './session';
import { completeSetup } from './setup';

beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));

async function setUp() {
	const server = fakeServer('none');
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
				mode: 'none'
			},
			admin: {
				username: 'admin',
				email: '',
				passphrase: PASSPHRASE,
				recoveryKey: newRecovery(sealerFor(SUITE_NONE)).key
			}
		},
		deps
	);
	await signIn({ username: 'admin', passphrase: PASSPHRASE }, deps);
	return { server, deps };
}

describe('totp', () => {
	it('enrols with the passphrase and shows on the account once confirmed', async () => {
		const { deps } = await setUp();
		const enrolment = await enrolTotp(PASSPHRASE, deps);
		expect(enrolment.secret).toBe('SECRET');
		expect(deps.session.account?.user.totp_enabled).toBe(false);

		const codes = await confirmTotp(` ${TOTP_CODE} `, deps);

		expect(codes.recovery_codes).toHaveLength(1);
		expect(deps.session.account?.user.totp_enabled).toBe(true);
	});

	it('turns off with the passphrase and a code', async () => {
		const { deps } = await setUp();
		await enrolTotp(PASSPHRASE, deps);
		await confirmTotp(TOTP_CODE, deps);
		await disableTotp({ passphrase: PASSPHRASE, factor: { code: TOTP_CODE } }, deps);
		expect(deps.session.account?.user.totp_enabled).toBe(false);
	});

	it('names a wrong passphrase', async () => {
		const { deps } = await setUp();
		await expect(enrolTotp('not the passphrase', deps)).rejects.toBeInstanceOf(
			WrongPassphraseError
		);
	});
});

describe('passphrase-confirmed actions', () => {
	it('mints a device token', async () => {
		const { deps } = await setUp();
		const created = await createDeviceToken({ name: 'phone', passphrase: PASSPHRASE }, deps);
		expect(created.token.name).toBe('phone');
		await expect(
			createDeviceToken({ name: 'phone', passphrase: 'not the passphrase' }, deps)
		).rejects.toBeInstanceOf(WrongPassphraseError);
	});

	it('invites a plain user with no passphrase', async () => {
		const { server, deps } = await setUp();
		server.calls.length = 0;
		await createInvite({ request: { role: 'user' } }, deps);
		expect(server.calls).toEqual(['createInvite']);
	});

	it('invites an admin with the passphrase, carrying the current key', async () => {
		const { server, deps } = await setUp();
		const created = await createInvite(
			{ request: { role: 'admin' }, passphrase: PASSPHRASE },
			deps
		);
		expect(created.token).toBe('invite-token');
		expect(server.bodies.at(-1)).toMatchObject({ role: 'admin' });
		expect(server.bodies.at(-1)).toHaveProperty('current_auth_key');
	});

	it('refuses an admin invite with a wrong passphrase', async () => {
		const { deps } = await setUp();
		await expect(
			createInvite({ request: { role: 'admin' }, passphrase: 'not the passphrase' }, deps)
		).rejects.toBeInstanceOf(WrongPassphraseError);
	});

	it('issues a reset link with the passphrase', async () => {
		const { deps } = await setUp();
		const link = await createPasswordResetLink({ userId: 'id-2', passphrase: PASSPHRASE }, deps);
		expect(link.token).toBe('reset-token');
		await expect(
			createPasswordResetLink({ userId: 'id-2', passphrase: 'not the passphrase' }, deps)
		).rejects.toBeInstanceOf(WrongPassphraseError);
	});
});

describe('after a rekey whose response was lost', () => {
	it('confirms a device token and a TOTP change with the current KDF', async () => {
		const { server, deps } = await setUp();
		const lossy = { ...deps, api: losingRekeyResponse(server) };
		await expect(
			changePassphrase({ current: PASSPHRASE, next: OTHER_PASSPHRASE }, lossy)
		).rejects.toBeInstanceOf(TypeError);

		await createDeviceToken({ name: 'phone', passphrase: OTHER_PASSPHRASE }, deps);
		await enrolTotp(OTHER_PASSPHRASE, deps);
		await confirmTotp(TOTP_CODE, deps);
		await disableTotp({ passphrase: OTHER_PASSPHRASE, factor: { code: TOTP_CODE } }, deps);
		expect(deps.session.account?.user.totp_enabled).toBe(false);
	});
});
