/**
 * Recovery, in the two halves the screen shows. The words sign in and open the
 * master key; the account then gets a new passphrase and a new recovery key in one
 * rekey, so the words just typed stop working. Between the two the keys wait in
 * memory, held by the `Recovery` the first half returns.
 */
import type { Account } from '$lib/api/types';
import type { Bytes } from '$lib/crypto/encoding';
import { zero } from '$lib/crypto/random';
import type { Sealer } from '$lib/crypto/sealer';
import { SealError } from '$lib/crypto/aead';
import { ApiError, isApiError } from '$lib/api/types';
import { deriveKeys } from './credentials';
import { defaultDeps, type Deps } from './deps';
import { RekeyMaybeAppliedError, WrongRecoveryKeyError } from './errors';
import { attemptLogin, type LoginStep } from './login';
import { acceptMode } from './mode';
import { acceptSigningIn, rememberSession } from './session';
import { recordOf, rekeyBody } from './wire';

export async function openRecovery(
	input: { username: string; phrase: string; sealer: Sealer },
	deps: Deps = defaultDeps
): Promise<LoginStep<Recovery>> {
	const recoveryKey = input.sealer.parseRecoveryPhrase(input.phrase);
	const { kek, authKey } = input.sealer.expandRecoveryKey(recoveryKey);
	zero(recoveryKey);
	let handedOver = false;
	return attemptLogin(
		{
			username: input.username,
			authKey,
			wrong: () => new WrongRecoveryKeyError(),
			release: () => {
				zero(kek);
				if (!handedOver) zero(authKey);
			},
			complete: async (account) => {
				const sealer = acceptSigningIn(account, deps);
				const master = unwrapWithRecovery(sealer, account, kek);
				handedOver = true;
				return new Recovery(sealer, account, master, authKey, deps);
			}
		},
		deps
	);
}

/**
 * The same for someone already signed in through a provider, where the words sign
 * nobody in. They open the recovery wrap from the account, and their auth key goes out
 * with the rekey alone, as the current credential.
 */
export async function openRecoveryInSession(
	input: { phrase: string },
	deps: Deps = defaultDeps
): Promise<Recovery> {
	const account = await deps.api.getMe();
	const sealer = acceptMode(account.mode, recordOf(account), deps);
	const recoveryKey = sealer.parseRecoveryPhrase(input.phrase);
	const { kek, authKey } = sealer.expandRecoveryKey(recoveryKey);
	zero(recoveryKey);
	try {
		const master = unwrapWithRecovery(sealer, account, kek);
		return new Recovery(sealer, account, master, authKey, deps, true);
	} catch (e) {
		zero(authKey);
		throw e;
	} finally {
		zero(kek);
	}
}

function unwrapWithRecovery(sealer: Sealer, account: Account, kek: Bytes): Bytes {
	try {
		return sealer.unwrapMaster(recordOf(account).recoveryWrappedMaster, kek, 'recovery');
	} catch (e) {
		throw e instanceof SealError ? new WrongRecoveryKeyError() : e;
	}
}

/** An account opened with its recovery key, waiting for its new credentials. */
export class Recovery {
	#sealer: Sealer;
	#account: Account;
	#master: Bytes | null;
	#authKey: Bytes;
	#deps: Deps;
	/** A rekey failed without an answer from the server, so it may have been applied. */
	#unanswered = false;
	/** The session came from elsewhere, so giving up here does not end it. */
	readonly #keepSession: boolean;

	constructor(
		sealer: Sealer,
		account: Account,
		master: Bytes,
		authKey: Bytes,
		deps: Deps,
		keepSession = false
	) {
		this.#keepSession = keepSession;
		this.#sealer = sealer;
		this.#account = account;
		this.#master = master;
		this.#authKey = authKey;
		this.#deps = deps;
	}

	/**
	 * Replaces the passphrase and the recovery key, and opens the session. On
	 * failure the recovery stays open for another try. `recoveryKey` stays the
	 * caller's, who has already shown its words and had them typed back.
	 */
	async finish(input: { passphrase: string; recoveryKey: Uint8Array }): Promise<void> {
		const master = this.#master;
		if (master === null) throw new Error('recovery already finished or abandoned');
		const deps = this.#deps;
		const kdf = deps.newKdfParams();
		const passphrase = await deriveKeys(input.passphrase, kdf, deps);
		const priorUnanswered = this.#unanswered;
		const recovery = this.#sealer.expandRecoveryKey(input.recoveryKey);
		try {
			await deps.api.rekey(
				rekeyBody({
					currentAuthKey: this.#authKey,
					passphrase: {
						authKey: passphrase.authKey,
						kdf,
						wrapped: this.#sealer.wrapMaster(master, passphrase.kek, 'passphrase')
					},
					recovery: {
						authKey: recovery.authKey,
						wrapped: this.#sealer.wrapMaster(master, recovery.kek, 'recovery')
					}
				})
			);
		} catch (e) {
			if (!(e instanceof ApiError) || e.code === 'network') this.#unanswered = true;
			if (isApiError(e, 'wrong_credential')) {
				throw priorUnanswered ? new RekeyMaybeAppliedError() : new WrongRecoveryKeyError();
			}
			throw e;
		} finally {
			zero(passphrase.kek, passphrase.authKey, recovery.kek, recovery.authKey);
		}
		this.#master = null;
		zero(this.#authKey);
		const account = await deps.api.getMe().catch(() => this.#account);
		const keys = this.#sealer.openUser(recordOf(account), master);
		deps.session.open(this.#sealer, account, keys);
		await rememberSession(this.#sealer, keys, deps);
	}

	/** Zeroes the keys and ends the login. Does nothing after `finish` succeeded. */
	async abandon(): Promise<void> {
		if (this.#master === null) return;
		zero(this.#master, this.#authKey);
		this.#master = null;
		if (!this.#keepSession) await this.#deps.api.logout().catch(() => {});
	}
}
