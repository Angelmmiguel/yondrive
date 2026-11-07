/**
 * A server in memory for the account flows: it holds what the real one holds and
 * refuses what the real one refuses, without any crypto of its own, and records
 * each call. `deps` wires it to a fresh session at the cheapest KDF cost allowed.
 */
import type { Api } from '$lib/api/client';
import {
	ApiError,
	type Account,
	type AccountKeys,
	type ErrorCode,
	type Kdf,
	type Mode,
	type RekeyRequest
} from '$lib/api/types';
import type { Deps, TabChannel, TabMessage } from '$lib/account/deps';
import { deriveRoot, newKdfParams } from '$lib/crypto/kdf';
import type { Suite } from '$lib/crypto/sealer';
import { Session } from '$lib/state/session.svelte';

export const PASSPHRASE = 'correct horse battery staple';
export const OTHER_PASSPHRASE = 'a completely different one';
export const TOTP_CODE = '123456';

interface StoredUser {
	id: string;
	username: string;
	authKey: string;
	recoveryAuthKey?: string;
	kdf: Kdf;
	keys?: AccountKeys;
	totp: boolean;
	disabled: boolean;
}

const fail = (status: number, code: ErrorCode) => new ApiError(status, code);

export function fakeServer(mode: Mode) {
	const users = new Map<string, StoredUser>();
	const calls: string[] = [];
	const bodies: unknown[] = [];
	const state = {
		setup: true,
		mode,
		signedIn: null as StoredUser | null,
		sessionKey: null as string | null,
		/** Rewrites what login and /me say, to play a hostile server. */
		tamper: (account: Account): Account => account
	};

	const account = (user: StoredUser): Account =>
		state.tamper({
			user: {
				id: user.id,
				username: user.username,
				role: 'admin',
				quota_bytes: 0,
				totp_enabled: user.totp,
				disabled: user.disabled,
				created_at: '2026-01-01T00:00:00Z'
			},
			mode: state.mode,
			kdf: user.kdf,
			keys: user.keys
		});

	const me = (): StoredUser => {
		if (state.signedIn === null) throw fail(401, 'unauthorized');
		return state.signedIn;
	};

	const checkCurrent = (key: string): StoredUser => {
		const user = me();
		if (key !== user.authKey && key !== user.recoveryAuthKey) throw fail(401, 'wrong_credential');
		return user;
	};

	const create = (body: Parameters<Api['register']>[0]['account']) => {
		const hasKeys = body.keys !== undefined || body.recovery_auth_key !== undefined;
		if (state.mode === 'none' && hasKeys) throw fail(400, 'keys_not_allowed');
		if (state.mode === 'e2e' && !hasKeys) throw fail(400, 'keys_required');
		if (users.has(body.username)) throw fail(409, 'username_taken');
		const user: StoredUser = {
			id: `id-${users.size + 1}`,
			username: body.username,
			authKey: body.auth_key,
			recoveryAuthKey: body.recovery_auth_key,
			kdf: body.kdf,
			keys: body.keys,
			totp: false,
			disabled: false
		};
		users.set(user.username, user);
		return user;
	};

	const handlers: Partial<Api> = {
		getHealth: async () => ({
			status: 'ok',
			version: 'test',
			setup: state.setup,
			mode: state.mode
		}),
		completeSetup: async (token, body) => {
			if (token !== 'setup-token') throw fail(401, 'setup_token_invalid');
			state.mode = body.settings.mode;
			state.setup = true;
			return { user_id: create(body.admin).id };
		},
		getKdf: async (username) => users.get(username)?.kdf ?? newKdfParamsAtTestCost(),
		login: async (body) => {
			const user = users.get(body.username);
			if (
				user === undefined ||
				(body.auth_key !== user.authKey && body.auth_key !== user.recoveryAuthKey)
			) {
				throw fail(401, 'invalid_credentials');
			}
			if (user.disabled) throw fail(403, 'user_disabled');
			if (user.totp) {
				if (body.totp_code === undefined && body.totp_recovery_code === undefined) {
					throw fail(401, 'totp_required');
				}
				if (body.totp_code !== TOTP_CODE && body.totp_recovery_code !== 'recovery-code') {
					throw fail(401, 'totp_invalid');
				}
			}
			state.signedIn = user;
			return account(user);
		},
		logout: async () => {
			state.signedIn = null;
			state.sessionKey = null;
		},
		register: async (body) => {
			if (body.invite_token === undefined) throw fail(403, 'signup_closed');
			if (body.invite_token !== 'invite-token') throw fail(403, 'invite_invalid');
			return { user_id: create(body.account).id };
		},
		rekey: async (body: RekeyRequest) => {
			const user = checkCurrent(body.current_auth_key);
			if (state.mode === 'none' && (body.recovery_auth_key || body.wrapped_master_key)) {
				throw fail(400, 'keys_not_allowed');
			}
			if (body.auth_key !== undefined) {
				user.authKey = body.auth_key;
				if (body.kdf !== undefined) user.kdf = body.kdf;
				if (user.keys && body.wrapped_master_key)
					user.keys.wrapped_master_key = body.wrapped_master_key;
			}
			if (body.recovery_auth_key !== undefined && user.keys && body.wrapped_master_key_recovery) {
				user.recoveryAuthKey = body.recovery_auth_key;
				user.keys.wrapped_master_key_recovery = body.wrapped_master_key_recovery;
			}
		},
		completePasswordReset: async (body) => {
			if (state.mode !== 'none') throw fail(409, 'wrong_mode');
			if (body.token !== 'reset-token') throw fail(403, 'reset_invalid');
			const user = [...users.values()][0];
			user.authKey = body.auth_key;
			user.kdf = body.kdf;
		},
		enrolTotp: async (body) => {
			checkCurrent(body.current_auth_key);
			return { secret: 'SECRET', uri: 'otpauth://totp/x' };
		},
		confirmTotp: async (body) => {
			if (body.code !== TOTP_CODE) throw fail(401, 'totp_invalid');
			me().totp = true;
			return { recovery_codes: ['recovery-code'] };
		},
		disableTotp: async (body) => {
			checkCurrent(body.current_auth_key);
			if (body.code !== TOTP_CODE) throw fail(401, 'totp_invalid');
			me().totp = false;
		},
		createToken: async (body) => {
			checkCurrent(body.current_auth_key);
			return {
				token: { id: 't1', name: body.name, created_at: '2026-01-01T00:00:00Z' },
				secret: 'bearer'
			};
		},
		createInvite: async (body) => {
			if (body.role === 'admin') checkCurrent(body.current_auth_key ?? '');
			return {
				invite: {
					id: 'i1',
					role: body.role ?? 'user',
					created_at: '2026-01-01T00:00:00Z',
					expires_at: '2026-01-08T00:00:00Z',
					used: false
				},
				token: 'invite-token',
				link: 'http://x/invite#invite-token'
			};
		},
		deleteUser: async (_userId, body) => {
			checkCurrent(body.current_auth_key);
		},
		createPasswordReset: async (_userId, body) => {
			checkCurrent(body.current_auth_key);
			return { token: 'reset-token', link: 'http://x/reset#reset-token', expires_at: 'later' };
		},
		getMe: async () => account(me()),
		getSessionKey: async () => {
			me();
			if (state.sessionKey === null) throw fail(404, 'no_session_key');
			return { key: state.sessionKey };
		},
		putSessionKey: async (body) => {
			me();
			state.sessionKey = body.key;
		},
		deleteSessionKey: async () => {
			me();
			state.sessionKey = null;
		}
	};

	const api = new Proxy(handlers, {
		get(target, name: string) {
			const handler = target[name as keyof Api] as ((...a: unknown[]) => unknown) | undefined;
			if (handler === undefined) throw new Error(`fake server has no ${name}`);
			return (...args: unknown[]) => {
				calls.push(name);
				bodies.push(args.at(-1));
				return handler(...args);
			};
		}
	}) as unknown as Api;

	return { api, calls, bodies, users, state };
}

export type FakeServer = ReturnType<typeof fakeServer>;

const cheap = { name: 'argon2id', m: 8192, t: 1, p: 1 } as const;

function newKdfParamsAtTestCost(): Kdf {
	return { ...newKdfParams(), ...cheap };
}

export function memoryPin(initial: Suite | null = null): Deps['pin'] {
	let pin = initial;
	return {
		read: () => pin,
		write: (suite) => {
			pin = suite;
		}
	};
}

/** Tabs in one test: what one posts, the others hear. */
export function memoryTabs(): { channel: () => TabChannel } {
	const listeners = new Set<{ owner: object; listener: (m: TabMessage) => void }>();
	return {
		channel() {
			const owner = {};
			return {
				post(message) {
					for (const l of listeners) if (l.owner !== owner) l.listener(message);
				},
				subscribe(listener) {
					const entry = { owner, listener };
					listeners.add(entry);
					return () => listeners.delete(entry);
				}
			};
		}
	};
}

export function testDeps(server: FakeServer, overrides: Partial<Deps> = {}): Deps {
	return {
		api: server.api,
		session: new Session(),
		pin: memoryPin(),
		channel: memoryTabs().channel(),
		deriveRoot: async (passphrase, params) => deriveRoot(passphrase, params),
		newKdfParams: newKdfParamsAtTestCost,
		...overrides
	};
}

export function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (key) => items.get(key) ?? null,
		key: (i) => [...items.keys()][i] ?? null,
		removeItem: (key) => void items.delete(key),
		setItem: (key, value) => void items.set(key, value)
	};
}

/**
 * The same server, but the response to a rekey is lost after it took effect and
 * the next `/me` fails, so the session is left holding the old KDF parameters.
 */
export function losingRekeyResponse(server: FakeServer): Api {
	let lost = false;
	return new Proxy(server.api, {
		get(target, name: string) {
			if (name === 'rekey') {
				return async (...args: Parameters<Api['rekey']>) => {
					await target.rekey(...args);
					lost = true;
					throw new TypeError('network');
				};
			}
			if (name === 'getMe') {
				return async () => {
					if (lost) {
						lost = false;
						throw new TypeError('network');
					}
					return target.getMe();
				};
			}
			return target[name as keyof Api];
		}
	});
}
