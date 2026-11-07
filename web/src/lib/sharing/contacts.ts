/**
 * The people this device has seen, with the keys it first saw them with. A server
 * could hand out a false public key and read everything shared afterwards, so a
 * key is pinned on first use, and a different one is never used without asking: it
 * throws `ContactKeysChangedError`, which ends in a blocking warning. The pins stay
 * on the device, sealed under a key from the master key. In suite `none` a
 * fingerprint is empty, so there is nothing to pin and nothing to compare.
 */
import type { Api } from '$lib/api/client';
import { isApiError } from '$lib/api/types';
import { decodeBase64, encodeBase64, utf8, type Bytes } from '$lib/crypto/encoding';
import type { PublicKeys } from '$lib/crypto/keys';
import { checkPin } from '$lib/crypto/pinning';
import type { Sealer, UserKeys } from '$lib/crypto/sealer';

/** Where the sealed pins of one user are kept, as text. */
export interface PinStorage {
	read(): string | null;
	write(sealed: string): void;
}

export function memoryPinStorage(): PinStorage {
	let value: string | null = null;
	return {
		read: () => value,
		write(sealed) {
			value = sealed;
		}
	};
}

/** Survives a sign-out, as it has to: a pin is worth nothing if it goes with the session. */
export function localPinStorage(userId: string): PinStorage {
	const name = `yondrive.pins.${userId}`;
	return {
		read() {
			try {
				return localStorage.getItem(name);
			} catch {
				return null;
			}
		},
		write(sealed) {
			try {
				localStorage.setItem(name, sealed);
			} catch {
				// Without storage the device has no memory, and each session is a first use.
			}
		}
	};
}

export interface Contact {
	userId: string;
	username: string;
	keys: PublicKeys;
	pinnedAt: number;
	/** When someone said they compared the safety number with this person. */
	comparedAt: number | null;
}

/** A contact whose keys are not the pinned ones. Nothing is shared until someone decides. */
export class ContactKeysChangedError extends Error {
	constructor(
		readonly userId: string,
		readonly username: string,
		readonly pinned: PublicKeys,
		readonly current: PublicKeys
	) {
		super('this contact has different keys');
		this.name = 'ContactKeysChangedError';
	}
}

interface StoredPin {
	username: string;
	x25519: string;
	ed25519: string;
	pinnedAt: number;
	comparedAt: number | null;
}

type StoredPins = Record<string, StoredPin>;

export interface ContactDeps {
	api: Pick<Api, 'getUserKeys' | 'lookupUser'>;
	sealer: Sealer;
	keys: () => UserKeys;
	userId: () => string;
	storage: PinStorage;
	now?: () => number;
}

const NO_KEYS = (): PublicKeys => ({
	x25519: new Uint8Array(0) as Bytes,
	ed25519: new Uint8Array(0) as Bytes
});

export class Contacts {
	readonly #deps: ContactDeps;
	/** What was checked in this session, so that a page of files does not ask for each. */
	readonly #checked = new Map<string, PublicKeys>();

	constructor(deps: ContactDeps) {
		this.#deps = deps;
	}

	#read(): StoredPins {
		const { storage, sealer, keys, userId } = this.#deps;
		const stored = storage.read();
		if (stored === null) return {};
		try {
			const bytes = sealer.openPins(decodeBase64(stored), keys().masterKey, userId());
			const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
			return parsed !== null && typeof parsed === 'object' ? (parsed as StoredPins) : {};
		} catch {
			// Damaged, or from before a new master key. Everyone is a first use again.
			return {};
		}
	}

	#write(pins: StoredPins): void {
		const { storage, sealer, keys, userId } = this.#deps;
		const sealed = sealer.sealPins(utf8(JSON.stringify(pins)), keys().masterKey, userId());
		storage.write(encodeBase64(sealed));
	}

	#pinned(pin: StoredPin): PublicKeys {
		return { x25519: decodeBase64(pin.x25519), ed25519: decodeBase64(pin.ed25519) };
	}

	/** The keys to use for someone, once checked against the pin. Pins them on first use. */
	check(userId: string, username: string, current: PublicKeys): PublicKeys {
		const { sealer } = this.#deps;
		const fingerprint = sealer.fingerprint(current);
		if (fingerprint.length === 0) return current;
		const pins = this.#read();
		const pin = pins[userId];
		const status = checkPin(
			pin === undefined ? null : sealer.fingerprint(this.#pinned(pin)),
			fingerprint
		);
		if (status === 'changed') {
			this.#checked.delete(userId);
			throw new ContactKeysChangedError(userId, pin.username, this.#pinned(pin), current);
		}
		if (status === 'first-use' || pin.username !== username) {
			pins[userId] = {
				username,
				x25519: encodeBase64(current.x25519),
				ed25519: encodeBase64(current.ed25519),
				pinnedAt: pin?.pinnedAt ?? this.#now(),
				comparedAt: pin?.comparedAt ?? null
			};
			this.#write(pins);
		}
		this.#checked.set(userId, current);
		return current;
	}

	#now(): number {
		return this.#deps.now?.() ?? Date.now();
	}

	/** Finds someone to share with. Always asks, so that a changed key shows now and not later. */
	async lookup(username: string): Promise<{ id: string; username: string; keys: PublicKeys }> {
		const found = await this.#deps.api.lookupUser(username);
		const given = found.public_keys;
		const keys = given
			? { x25519: decodeBase64(given.x25519), ed25519: decodeBase64(given.ed25519) }
			: NO_KEYS();
		this.check(found.id, found.username, keys);
		return { id: found.id, username: found.username, keys };
	}

	/**
	 * The keys of a user id. Someone whose account has gone still has the keys they
	 * were pinned with. With neither there are none, and whatever needs them refuses.
	 */
	async keysOf(userId: string): Promise<PublicKeys> {
		const { api, keys } = this.#deps;
		if (userId === this.#deps.userId()) {
			const { identity } = keys();
			return { x25519: identity.x25519.publicKey, ed25519: identity.ed25519.publicKey };
		}
		const known = this.#checked.get(userId);
		if (known !== undefined) return known;
		try {
			const found = await api.getUserKeys(userId);
			return this.check(userId, found.username, {
				x25519: decodeBase64(found.public_keys.x25519),
				ed25519: decodeBase64(found.public_keys.ed25519)
			});
		} catch (e) {
			if (!isApiError(e, 'not_found', 'no_keys')) throw e;
			const pin = this.#read()[userId];
			return pin === undefined ? NO_KEYS() : this.#pinned(pin);
		}
	}

	/** Takes the keys that raised the warning, after someone has looked at the numbers. */
	accept(changed: ContactKeysChangedError): void {
		const pins = this.#read();
		pins[changed.userId] = {
			username: changed.username,
			x25519: encodeBase64(changed.current.x25519),
			ed25519: encodeBase64(changed.current.ed25519),
			pinnedAt: this.#now(),
			comparedAt: null
		};
		this.#write(pins);
		this.#checked.set(changed.userId, changed.current);
	}

	/** Forgets what this session has checked, so that the next read asks the server. */
	refresh(): void {
		this.#checked.clear();
	}

	get(userId: string): Contact | undefined {
		const pin = this.#read()[userId];
		if (pin === undefined) return undefined;
		return {
			userId,
			username: pin.username,
			keys: this.#pinned(pin),
			pinnedAt: pin.pinnedAt,
			comparedAt: pin.comparedAt
		};
	}

	markCompared(userId: string, compared = true): void {
		const pins = this.#read();
		const pin = pins[userId];
		if (pin === undefined) return;
		pin.comparedAt = compared ? this.#now() : null;
		this.#write(pins);
	}

	/** The number two people compare, between the signed-in user and these keys. */
	safetyNumberWith(keys: PublicKeys): string {
		const { sealer, keys: own } = this.#deps;
		const { identity } = own();
		return sealer.safetyNumber(
			sealer.fingerprint({
				x25519: identity.x25519.publicKey,
				ed25519: identity.ed25519.publicKey
			}),
			sealer.fingerprint(keys)
		);
	}
}
