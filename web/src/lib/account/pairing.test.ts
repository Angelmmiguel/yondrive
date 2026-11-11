import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mode } from '$lib/api/types';
import { decodeBase64, encodeBase64 } from '$lib/crypto/encoding';
import { generatePairingKeys, openPairingPayload, tokenHash } from '$lib/crypto/pairing';
import { sealerFor, SUITE_E2E, SUITE_NONE } from '$lib/crypto/sealer';
import { fakeServer, memoryStorage, PASSPHRASE, testDeps } from '$lib/testing/account';
import { currentAuthKey } from './credentials';
import { LockedError, WrongPassphraseError } from './errors';
import { buildPayload, confirmPairing, startPairing } from './pairing';
import { newRecovery } from './recovery-key';
import { lock, signIn } from './session';
import { completeSetup } from './setup';
import { parseKdfParams } from '$lib/crypto/kdf';

const suites = { e2e: SUITE_E2E, none: SUITE_NONE } as const;

beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));

async function setUp(mode: Mode) {
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
	await signIn({ username: 'admin', passphrase: PASSPHRASE }, deps);
	const authKey = await currentAuthKey(PASSPHRASE, parseKdfParams(deps.session.account!.kdf), deps);
	return { server, deps, authKey };
}

describe.each(['e2e', 'none'] as const)('pairing in mode %s', (mode) => {
	it('starts with the current auth key and names a wrong one', async () => {
		const { server, deps, authKey } = await setUp(mode);
		const pairing = await startPairing(authKey, deps);
		expect(pairing.status).toBe('open');
		expect(server.bodies.at(-1)).toEqual({ current_auth_key: encodeBase64(authKey) });
		await expect(startPairing(new Uint8Array(32), deps)).rejects.toThrow(WrongPassphraseError);
	});

	it('seals the device its token, and the master key only with encryption', async () => {
		const { server, deps, authKey } = await setUp(mode);
		const pairing = await startPairing(authKey, deps);
		const browser = generatePairingKeys();
		const device = generatePairingKeys();
		await server.api.claimPairing(pairing.id, {
			public_key: encodeBase64(device.publicKey),
			name: 'phone',
			platform: 'ios'
		});

		const token = await confirmPairing(
			{ pairingId: pairing.id, keys: browser, deviceKey: device.publicKey },
			deps
		);
		expect(token.origin).toBe('pairing');

		const stored = server.pairings.get(pairing.id)!;
		const payload = openPairingPayload(
			device,
			browser.publicKey,
			pairing.id,
			decodeBase64(stored.sealed!)
		);
		expect(payload.suite).toBe(suites[mode]);
		expect(stored.tokenHash).toBe(encodeBase64(tokenHash(payload.token)));
		expect(JSON.stringify(server.bodies)).not.toContain(payload.token);
		if (mode === 'e2e') {
			expect(payload.master_key).toBe(encodeBase64(deps.session.keys!.masterKey));
			expect(JSON.stringify(server.bodies)).not.toContain(payload.master_key);
		} else {
			expect(payload).not.toHaveProperty('master_key');
		}
	});

	it('refuses to build a payload once locked', async () => {
		const { deps } = await setUp(mode);
		expect(buildPayload('secret', deps).token).toBe('secret');
		await lock(deps);
		expect(() => buildPayload('secret', deps)).toThrow(LockedError);
	});
});
