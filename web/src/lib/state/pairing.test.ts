import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, encodeBase64 } from '$lib/crypto/encoding';
import type { KeyPair } from '$lib/crypto/keys';
import {
	generatePairingKeys,
	openPairingPayload,
	pairingCode,
	parsePairingLink
} from '$lib/crypto/pairing';
import { sealerFor, SUITE_NONE } from '$lib/crypto/sealer';
import { newRecovery } from '$lib/account/recovery-key';
import { signIn } from '$lib/account/session';
import { completeSetup } from '$lib/account/setup';
import { fakeServer, memoryStorage, PASSPHRASE, testDeps } from '$lib/testing/account';
import { PAIRING_SECONDS, PairingFlow, POLL_MS } from './pairing.svelte';

const drawn = vi.hoisted(() => ({ keys: [] as KeyPair[] }));

vi.mock('$lib/crypto/pairing', async (original) => {
	const actual = await original<typeof import('$lib/crypto/pairing')>();
	return {
		...actual,
		generatePairingKeys: () => {
			const keys = actual.generatePairingKeys();
			drawn.keys.push(keys);
			return keys;
		}
	};
});

beforeEach(() => {
	vi.stubGlobal('sessionStorage', memoryStorage());
	drawn.keys = [];
});

afterEach(() => vi.useRealTimers());

async function setUp() {
	const server = fakeServer('none');
	let derivations = 0;
	const deps = testDeps(server);
	const derive = deps.deriveRoot;
	deps.deriveRoot = (passphrase, params) => {
		derivations += 1;
		return derive(passphrase, params);
	};
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
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
	const flow = new PairingFlow({ deps, origin: 'https://drive.example.com' });
	return { server, deps, flow, derivations: () => derivations };
}

/** A phone scanning the code: it claims with a key of its own. */
async function claim(server: ReturnType<typeof fakeServer>, flow: PairingFlow) {
	const device = generatePairingKeys();
	const id = flow.pairing!.id;
	await server.api.claimPairing(id, {
		public_key: encodeBase64(device.publicKey),
		name: "Angel's phone",
		platform: 'ios'
	});
	return device;
}

describe('adding a device', () => {
	it('shows a code, polls, compares digits and confirms', async () => {
		const { server, flow } = await setUp();
		await flow.begin(PASSPHRASE);
		expect(flow.step).toBe('scan');
		expect(flow.error).toBeNull();
		const parsed = parsePairingLink(flow.link)!;
		expect(parsed.origin).toBe('https://drive.example.com');
		expect(parsed.pairingId).toBe(flow.pairing!.id);

		const polls = () => server.calls.filter((c) => c === 'getPairing').length;
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(polls()).toBe(3);
		expect(flow.step).toBe('scan');

		const device = await claim(server, flow);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(flow.step).toBe('confirm');
		expect(flow.device).toEqual({ name: "Angel's phone", platform: 'ios' });
		expect(flow.code).toBe(pairingCode(parsed.browserKey, device.publicKey, parsed.pairingId));
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(polls()).toBe(4);

		await flow.confirm();
		expect(flow.step).toBe('done');
		expect(flow.token?.name).toBe("Angel's phone");
		const sealed = server.pairings.get(parsed.pairingId)!.sealed!;
		const payload = openPairingPayload(
			device,
			parsed.browserKey,
			parsed.pairingId,
			decodeBase64(sealed)
		);
		expect(payload.suite).toBe(SUITE_NONE);
		// The browser's private key is gone once the device has its token.
		expect(drawn.keys[0].privateKey.every((b) => b === 0)).toBe(true);
		flow.dispose();
	});

	it('counts down and expires, and a new code needs no passphrase', async () => {
		const { flow, derivations } = await setUp();
		const before = derivations();
		await flow.begin(PASSPHRASE);
		expect(derivations()).toBe(before + 1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(flow.remaining).toBe(PAIRING_SECONDS - 2);
		await vi.advanceTimersByTimeAsync((PAIRING_SECONDS - 2) * 1000);
		expect(flow.step).toBe('ended');
		expect(flow.remaining).toBe(0);
		expect(flow.error).toBe('The code expired. Show a new one.');
		const first = flow.pairing!.id;

		await flow.renew();
		expect(flow.step).toBe('scan');
		expect(flow.pairing!.id).not.toBe(first);
		expect(flow.error).toBeNull();
		expect(flow.remaining).toBe(PAIRING_SECONDS);
		expect(derivations()).toBe(before + 1);
		flow.dispose();
	});

	it('counts down to the time the server gave', async () => {
		const { server, flow } = await setUp();
		server.state.pairingSeconds = 120;
		await flow.begin(PASSPHRASE);
		expect(flow.remaining).toBe(120);
		await vi.advanceTimersByTimeAsync(119_000);
		expect(flow.step).toBe('scan');
		await vi.advanceTimersByTimeAsync(1000);
		expect(flow.step).toBe('ended');
		flow.dispose();
	});

	it('counts on its own when the server gives a time past the code’s lifetime', async () => {
		const { server, flow } = await setUp();
		server.state.pairingSeconds = 3600;
		await flow.begin(PASSPHRASE);
		expect(flow.remaining).toBe(PAIRING_SECONDS);
		flow.dispose();
	});

	it('ends when the server reports a device key nobody could hold', async () => {
		const { server, flow } = await setUp();
		await flow.begin(PASSPHRASE);
		await server.api.claimPairing(flow.pairing!.id, {
			public_key: encodeBase64(new Uint8Array(32)),
			name: 'nothing'
		});
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(flow.step).toBe('ended');
		expect(flow.code).toBe('');
		expect(flow.error).toBe('The pairing was cancelled.');
		const calls = server.calls.length;
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(server.calls.length).toBe(calls);
		flow.dispose();
	});

	it('moves to expired when the server says so', async () => {
		const { server, flow } = await setUp();
		await flow.begin(PASSPHRASE);
		server.pairings.get(flow.pairing!.id)!.expired = true;
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(flow.step).toBe('ended');
		flow.dispose();
	});

	it('says so when the pairing was cancelled elsewhere', async () => {
		const { server, flow } = await setUp();
		await flow.begin(PASSPHRASE);
		server.pairings.delete(flow.pairing!.id);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(flow.step).toBe('ended');
		expect(flow.error).toBe('The pairing was cancelled.');
		const calls = server.calls.length;
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(server.calls.length).toBe(calls);
		flow.dispose();
	});

	it('names a wrong passphrase and stays on the first step', async () => {
		const { flow } = await setUp();
		await flow.begin('not the passphrase at all');
		expect(flow.step).toBe('credential');
		expect(flow.error).toBe('That passphrase is not correct.');
	});

	it('cancels on the server, and zeroes its keys on dispose', async () => {
		const { server, flow } = await setUp();
		await flow.begin(PASSPHRASE);
		const id = flow.pairing!.id;
		await flow.cancel();
		expect(server.pairings.has(id)).toBe(false);
		expect(drawn.keys[0].privateKey.every((b) => b === 0)).toBe(true);
		flow.dispose();
		const calls = server.calls.length;
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(server.calls.length).toBe(calls);
		// With the auth key gone, a new code asks for the passphrase again.
		await flow.renew();
		expect(flow.step).toBe('credential');
	});
});
