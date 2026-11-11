/**
 * Adding a device by code, as the dialog walks through it: the passphrase once,
 * then a code to scan that is polled every two seconds until a device claims it,
 * the six digits to compare, and the confirmation. The auth key is kept for a new
 * code without asking again, and the pairing's private key for the confirmation;
 * both are zeroed when the flow ends, however it ends.
 */
import { freshAuthKey } from '$lib/account/credentials';
import { defaultDeps, type Deps } from '$lib/account/deps';
import { confirmPairing, startPairing } from '$lib/account/pairing';
import { isApiError, type DevicePlatform, type DeviceToken, type Pairing } from '$lib/api/types';
import { failure } from '$lib/app/failure';
import { decodeBase64, type Bytes } from '$lib/crypto/encoding';
import type { KeyPair } from '$lib/crypto/keys';
import { encodePairingLink, generatePairingKeys, liveKey, pairingCode } from '$lib/crypto/pairing';
import { zero } from '$lib/crypto/random';

export type PairingStep = 'credential' | 'scan' | 'confirm' | 'done' | 'ended';

/** How long a code lasts, as the server keeps it. */
export const PAIRING_SECONDS = 300;
/** How often the browser asks whether a device has claimed the code. */
export const POLL_MS = 2000;

const CANCELLED = 'The pairing was cancelled.';
const EXPIRED = 'The code expired. Show a new one.';

export class PairingFlow {
	step = $state<PairingStep>('credential');
	pairing = $state.raw<Pairing | null>(null);
	/** What the code carries; the browser's key is in its fragment. */
	link = $state('');
	/** The six digits, once a device has claimed the code. */
	code = $state('');
	device = $state.raw<{ name: string; platform?: DevicePlatform } | null>(null);
	token = $state.raw<DeviceToken | null>(null);
	/** Seconds left on the code. */
	remaining = $state(PAIRING_SECONDS);
	error = $state<string | null>(null);
	busy = $state(false);

	#deps: Deps;
	#origin: string;
	#authKey: Bytes | null = null;
	#keys: KeyPair | null = null;
	#deviceKey: Bytes | null = null;
	#deadline = 0;
	#countdown: ReturnType<typeof setInterval> | null = null;
	#poller: ReturnType<typeof setInterval> | null = null;
	#polling = false;

	constructor(options: { deps?: Deps; origin?: string } = {}) {
		this.#deps = options.deps ?? defaultDeps;
		this.#origin = options.origin ?? location.origin;
	}

	/** Proves the passphrase once, and shows the first code. */
	async begin(passphrase: string): Promise<void> {
		await this.#run(async () => {
			this.#authKey = await freshAuthKey(passphrase, this.#deps);
			try {
				await this.#open();
			} catch (e) {
				this.#forgetAuthKey();
				throw e;
			}
		});
	}

	/** A new code in place of one that expired or was cancelled, with the passphrase already proven. */
	async renew(): Promise<void> {
		if (this.#authKey === null) {
			this.step = 'credential';
			return;
		}
		await this.#run(() => this.#open());
	}

	/** Hands the device that claimed the code its token. */
	async confirm(): Promise<void> {
		const { pairing } = this;
		if (pairing === null || this.#keys === null || this.#deviceKey === null) return;
		await this.#run(async () => {
			try {
				this.token = await confirmPairing(
					{ pairingId: pairing.id, keys: this.#keys!, deviceKey: this.#deviceKey! },
					this.#deps
				);
			} catch (e) {
				this.#ended(e);
				return;
			}
			this.#stop();
			this.#dropKeys();
			this.step = 'done';
		});
	}

	/** Ends the pairing on the server too. Best effort: it expires on its own. */
	async cancel(): Promise<void> {
		const id = this.pairing?.id;
		this.#stop();
		this.#dropKeys();
		if (id !== undefined) await this.#deps.api.cancelPairing(id).catch(() => {});
	}

	/** Stops everything and zeroes what the flow holds. */
	dispose(): void {
		this.#stop();
		this.#dropKeys();
		this.#forgetAuthKey();
	}

	async #run(work: () => Promise<void>): Promise<void> {
		this.busy = true;
		this.error = null;
		try {
			await work();
		} catch (e) {
			this.error = failure(e, this.#deps);
		} finally {
			this.busy = false;
		}
	}

	async #open(): Promise<void> {
		this.#stop();
		this.#dropKeys();
		const pairing = await startPairing(this.#authKey!, this.#deps);
		this.#keys = generatePairingKeys();
		this.pairing = pairing;
		this.link = encodePairingLink(this.#origin, pairing.id, this.#keys.publicKey);
		this.code = '';
		this.device = null;
		this.token = null;
		this.#deadline = deadlineOf(pairing);
		this.remaining = Math.max(0, Math.ceil((this.#deadline - Date.now()) / 1000));
		this.step = 'scan';
		this.#countdown = setInterval(() => this.#tick(), 1000);
		this.#poller = setInterval(() => void this.#poll(), POLL_MS);
	}

	#tick(): void {
		this.remaining = Math.max(0, Math.ceil((this.#deadline - Date.now()) / 1000));
		if (this.remaining === 0 && (this.step === 'scan' || this.step === 'confirm')) this.#expire();
	}

	async #poll(): Promise<void> {
		const pairing = this.pairing;
		if (this.#polling || pairing === null || this.step !== 'scan') return;
		this.#polling = true;
		try {
			const now = await this.#deps.api.getPairing(pairing.id);
			if (this.pairing !== pairing || this.step !== 'scan') return;
			this.error = null;
			if (now.status !== 'claimed' || now.device === undefined || this.#keys === null) return;
			const deviceKey = deviceKeyOf(now.device.public_key);
			if (deviceKey === null) {
				// No key a device could hold: nothing can be sealed to it, so this pairing is over.
				this.#cancelled();
				return;
			}
			this.#deviceKey = deviceKey;
			this.code = pairingCode(this.#keys.publicKey, deviceKey, pairing.id);
			this.device = { name: now.device.name, platform: now.device.platform };
			this.step = 'confirm';
			this.#stopPolling();
		} catch (e) {
			if (this.pairing === pairing) this.#ended(e);
		} finally {
			this.#polling = false;
		}
	}

	/** What a refusal from the server means for the flow. */
	#ended(e: unknown): void {
		if (isApiError(e, 'pairing_expired')) {
			this.#expire();
		} else if (isApiError(e, 'not_found')) {
			this.#cancelled();
		} else {
			this.error = failure(e, this.#deps);
		}
	}

	#cancelled(): void {
		this.#stop();
		this.#dropKeys();
		this.step = 'ended';
		this.error = CANCELLED;
	}

	#expire(): void {
		this.#stop();
		this.#dropKeys();
		this.remaining = 0;
		this.step = 'ended';
		this.error = EXPIRED;
	}

	#stopPolling(): void {
		if (this.#poller !== null) clearInterval(this.#poller);
		this.#poller = null;
	}

	#stop(): void {
		this.#stopPolling();
		if (this.#countdown !== null) clearInterval(this.#countdown);
		this.#countdown = null;
	}

	#dropKeys(): void {
		if (this.#keys !== null) zero(this.#keys.privateKey);
		this.#keys = null;
		this.#deviceKey = null;
	}

	#forgetAuthKey(): void {
		if (this.#authKey !== null) zero(this.#authKey);
		this.#authKey = null;
	}
}

/**
 * When the code expires, by the server's clock as it said in `expires_at`. A
 * device clock that disagrees by more than the code's lifetime falls back to its
 * own count; the server's answers to the polls decide in the end.
 */
function deadlineOf(pairing: Pairing): number {
	const now = Date.now();
	const fallback = now + PAIRING_SECONDS * 1000;
	const server = Date.parse(pairing.expires_at);
	return Number.isFinite(server) && server > now && server <= fallback ? server : fallback;
}

/** The device's key as the server reports it, or null if it cannot be one. */
function deviceKeyOf(encoded: string): Bytes | null {
	try {
		const key = decodeBase64(encoded);
		return liveKey(key) ? key : null;
	} catch {
		return null;
	}
}
