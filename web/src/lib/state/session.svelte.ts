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
