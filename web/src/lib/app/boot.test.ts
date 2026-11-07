import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUITE_E2E, SUITE_NONE, sealerFor } from '$lib/crypto/sealer';
import { newRecovery } from '$lib/account/recovery-key';
import { signIn } from '$lib/account/session';
import { completeSetup } from '$lib/account/setup';
import { fakeServer, memoryPin, memoryStorage, PASSPHRASE, testDeps } from '$lib/testing/account';
import { ApiError, type Mode } from '$lib/api/types';
import { boot } from './boot';

const suites = { e2e: SUITE_E2E, none: SUITE_NONE } as const;

beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));

async function configured(mode: Mode) {
	const server = fakeServer(mode);
	const first = testDeps(server);
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
		first
	);
	return { server, first };
}

describe('boot', () => {
	it('reports a server with no setup', async () => {
		const server = fakeServer('e2e');
		server.state.setup = false;
		const deps = testDeps(server);
		await boot(deps);
		expect(deps.session.status).toBe('needs-setup');
		expect(deps.pin.read()).toBeNull();
	});

	it('reports nobody signed in, with the sealer of the server', async () => {
		const { server } = await configured('none');
		const deps = testDeps(server);
		await boot(deps);
		expect(deps.session.status).toBe('signed-out');
		expect(deps.session.sealer?.encrypted).toBe(false);
	});

	it('opens a live session that holds both halves', async () => {
		const { server, first } = await configured('e2e');
		await signIn({ username: 'admin', passphrase: PASSPHRASE }, first);
		const deps = testDeps(server, { pin: first.pin });
		await boot(deps);
		expect(deps.session.status).toBe('unlocked');
	});

	it('leaves a live session locked when a half is gone', async () => {
		const { server, first } = await configured('e2e');
		await signIn({ username: 'admin', passphrase: PASSPHRASE }, first);
		server.state.sessionKey = null;
		const deps = testDeps(server, { pin: first.pin });
		await boot(deps);
		expect(deps.session.status).toBe('locked');
	});

	it('never locks a session in a mode without keys', async () => {
		const { server, first } = await configured('none');
		await signIn({ username: 'admin', passphrase: PASSPHRASE }, first);
		const deps = testDeps(server, { pin: first.pin });
		await boot(deps);
		expect(deps.session.status).toBe('unlocked');
	});

	it('stops at the guard when the mode changed under a pin', async () => {
		const { server } = await configured('none');
		const deps = testDeps(server, { pin: memoryPin(SUITE_E2E) });
		await boot(deps);
		expect(deps.session.refusal).toBe('device-pinned');
		expect(deps.session.status).toBe('booting');
	});

	it('reports a server that does not answer', async () => {
		const { server } = await configured('e2e');
		server.api.getHealth = async () => {
			throw new ApiError(0, 'network');
		};
		const deps = testDeps(server);
		await boot(deps);
		expect(deps.session.status).toBe('offline');
	});
});
