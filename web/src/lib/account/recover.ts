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
import { isApiError } from '$lib/api/types';
import { deriveKeys } from './credentials';
import { defaultDeps, type Deps } from './deps';
import { WrongRecoveryKeyError } from './errors';
import { attemptLogin, type LoginStep } from './login';
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

	constructor(sealer: Sealer, account: Account, master: Bytes, authKey: Bytes, deps: Deps) {
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
			throw isApiError(e, 'wrong_credential') ? new WrongRecoveryKeyError() : e;
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
		await this.#deps.api.logout().catch(() => {});
	}
}
