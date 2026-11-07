/**
 * Who is here and what they hold: the state of the server, the signed-in
 * account and the usable keys, in memory only. Byte buffers sit in `$state.raw`,
 * because a deep proxy over a Uint8Array would defeat zeroing them on lock.
 */
import type { Account, Health } from '$lib/api/types';
import { zeroIdentity } from '$lib/crypto/keys';
import { zero } from '$lib/crypto/random';
import type { ModeRefusal, Sealer, UserKeys } from '$lib/crypto/sealer';

export type SessionStatus =
	| 'booting'
	/** The server did not answer. */
	| 'offline'
	/** The first-run setup has not been completed. */
	| 'needs-setup'
	| 'signed-out'
	/** Signed in, with the keys gone: only a passphrase brings them back. */
	| 'locked'
	/** Signed in through a provider, with no keys made yet. Nothing else comes first. */
	| 'enrolling'
	| 'unlocked';

export class Session {
	status = $state<SessionStatus>('booting');
	health = $state.raw<Health | null>(null);
	/** The sealer of the mode this device accepted. */
	sealer = $state.raw<Sealer | null>(null);
	account = $state.raw<Account | null>(null);
	keys = $state.raw<UserKeys | null>(null);
	/** Why this device refuses the server's mode. Blocks the whole app. */
	refusal = $state<ModeRefusal | null>(null);
	/** The wizard asked for two-factor: settings is the first stop after signing in. */
	wantsTotp = $state(false);

	/** Takes ownership of `keys`. */
	open(sealer: Sealer, account: Account, keys: UserKeys): void {
		this.#zero();
		this.sealer = sealer;
		this.account = account;
		this.keys = keys;
		this.status = 'unlocked';
	}

	/**
	 * Whether a current credential is a passphrase this person types. An account with
	 * only a provider, in a mode with no keys, has none, and a recent sign-in stands in.
	 */
	get asksPassphrase(): boolean {
		const { account, sealer } = this;
		if (account === null || sealer === null) return true;
		return account.user.sign_in_method !== 'sso' || sealer.ssoHasPassphrase;
	}

	/** Signed in through a provider, and about to make its keys. */
	enrolling(sealer: Sealer, account: Account): void {
		this.#zero();
		this.sealer = sealer;
		this.account = account;
		this.status = 'enrolling';
	}

	/** Signed in with no keys, as after a reload whose session key is gone. */
	locked(sealer: Sealer, account: Account): void {
		this.#zero();
		this.sealer = sealer;
		this.account = account;
		this.status = 'locked';
	}

	/**
	 * Zeroes the keys in place, so that work holding them fails from here on.
	 * Being signed out already stays what it is.
	 */
	lock(): void {
		this.#zero();
		if (this.status === 'unlocked') this.status = 'locked';
	}

	signedOut(): void {
		this.#zero();
		this.account = null;
		this.status = 'signed-out';
	}

	refuse(reason: ModeRefusal): void {
		this.#zero();
		this.refusal = reason;
	}

	#zero(): void {
		if (this.keys === null) return;
		zero(this.keys.masterKey);
		zeroIdentity(this.keys.identity);
		this.keys = null;
	}
}

export const session = new Session();
