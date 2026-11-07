/**
 * Getting keys into the session and out of it: sign-in, unlock, resume, lock and
 * sign-out. Lock zeroes the keys in place, so anything still holding them fails,
 * since a zeroed key is refused by every construction.
 */
import { isApiError, type Account } from '$lib/api/types';
import type { Bytes } from '$lib/crypto/encoding';
import { parseKdfParams } from '$lib/crypto/kdf';
import { zero } from '$lib/crypto/random';
import { SealError } from '$lib/crypto/aead';
import type { Sealer, UserKeys } from '$lib/crypto/sealer';
import { deriveKeys } from './credentials';
import { defaultDeps, type Deps } from './deps';
import { WrongCredentialsError, WrongPassphraseError } from './errors';
import { attemptLogin, type LoginStep } from './login';
import { acceptMode } from './mode';
import { recordOf, sessionKeyApi } from './wire';

/**
 * Stores what a reload needs. Best effort: by now the session is open, and
 * without this the next reload simply asks for the passphrase. A lock that arrived
 * meanwhile wins, so nothing is left behind for it.
 */
export async function rememberSession(sealer: Sealer, keys: UserKeys, deps: Deps): Promise<void> {
	try {
		await sealer.persistSession(keys.masterKey, sessionKeyApi(deps));
	} catch (e) {
		sealer.clearSession();
		if (isApiError(e, 'unauthorized')) deps.session.signedOut();
	}
	if (deps.session.keys !== keys) {
		sealer.clearSession();
		await deps.api.deleteSessionKey().catch(() => {});
	}
}

/** Opens the user's keys from a master key it takes over, and the session on them. */
export async function openSession(
	sealer: Sealer,
	account: Account,
	master: Bytes,
	deps: Deps
): Promise<void> {
	let keys: UserKeys;
	try {
		keys = sealer.openUser(recordOf(account), master);
	} catch (e) {
		zero(master);
		throw e;
	}
	deps.session.open(sealer, account, keys);
	await rememberSession(sealer, keys, deps);
}

/**
 * Signs in. The auth key goes out, the KEK stays, and the keys open only once the
 * guard has accepted what the account says about its mode. A refused login is
 * signed straight out again.
 */
export async function signIn(
	input: { username: string; passphrase: string },
	deps: Deps = defaultDeps
): Promise<LoginStep<void>> {
	const kdf = parseKdfParams(await deps.api.getKdf(input.username));
	const { kek, authKey } = await deriveKeys(input.passphrase, kdf, deps);
	return attemptLogin(
		{
			username: input.username,
			authKey,
			wrong: () => new WrongCredentialsError(),
			release: () => zero(kek, authKey),
			complete: async (account) => {
				const record = recordOf(account);
				const sealer = acceptSigningIn(account, deps);
				const master = sealer.unwrapMaster(record.wrappedMaster, kek, 'passphrase');
				await openSession(sealer, account, master, deps);
			}
		},
		deps
	);
}

/** The guard after a login: the cookie just set goes if the mode is refused. */
export function acceptSigningIn(account: Account, deps: Deps): Sealer {
	try {
		return acceptMode(account.mode, recordOf(account), deps);
	} catch (e) {
		void deps.api.logout().catch(() => {});
		throw e;
	}
}

/**
 * The passphrase of a signed-in user, on a locked session. Nothing here needs
 * the server: a wrong passphrase simply does not open the wrapped key.
 */
export async function unlock(passphrase: string, deps: Deps = defaultDeps): Promise<void> {
	const account = await deps.api.getMe();
	const record = recordOf(account);
	const sealer = acceptMode(account.mode, record, deps);
	const { kek, authKey } = await deriveKeys(passphrase, parseKdfParams(account.kdf), deps);
	zero(authKey);
	let master: Bytes;
	try {
		master = sealer.unwrapMaster(record.wrappedMaster, kek, 'passphrase');
	} catch (e) {
		throw e instanceof SealError ? new WrongPassphraseError() : e;
	} finally {
		zero(kek);
	}
	await openSession(sealer, account, master, deps);
}

/**
 * A page load with a live session: reopens the keys from the half in
 * sessionStorage and the half on the server, or leaves the session locked. In a
 * mode without keys there is nothing to reopen, and it is simply open.
 */
export async function resume(account: Account, deps: Deps = defaultDeps): Promise<void> {
	const sealer = acceptMode(account.mode, recordOf(account), deps);
	if (account.enrolment_required === true) {
		deps.session.enrolling(sealer, account);
		return;
	}
	const master = await sealer.resumeSession(sessionKeyApi(deps));
	if (master === null) {
		deps.session.locked(sealer, account);
		return;
	}
	try {
		const keys = sealer.openUser(recordOf(account), master);
		deps.session.open(sealer, account, keys);
	} catch {
		zero(master);
		sealer.clearSession();
		deps.session.locked(sealer, account);
	}
}

/**
 * Zeroes the keys, forgets the sealed half, tells the other tabs and deletes the
 * server's half. The local part goes first, so locking never waits on the
 * network; if the delete fails, the half left on the server opens nothing alone.
 */
export async function lock(deps: Deps = defaultDeps): Promise<void> {
	deps.session.lock();
	deps.session.sealer?.clearSession();
	deps.channel.post('locked');
	await deps.api.deleteSessionKey().catch(() => {});
}

/** Lock, and the session with it. */
export async function signOut(deps: Deps = defaultDeps): Promise<void> {
	deps.session.signedOut();
	deps.session.sealer?.clearSession();
	deps.channel.post('signed-out');
	await deps.api.logout().catch(() => {});
}

/**
 * Follows what other tabs do: a lock or sign-out there is this tab's too, so its
 * keys go at once rather than at the next request the server refuses. Returns
 * the function that stops following.
 */
export function followOtherTabs(deps: Deps = defaultDeps): () => void {
	return deps.channel.subscribe((message) => {
		deps.session.sealer?.clearSession();
		if (message === 'locked') deps.session.lock();
		else deps.session.signedOut();
	});
}
