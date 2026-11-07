/**
 * What the account flows reach outside for. Tests hand in a mocked client, a
 * fresh session, a pin in memory and parameters cheap enough to run; the app uses
 * the real client, the worker and the production cost.
 */
import { api, type Api } from '$lib/api/client';
import type { Bytes } from '$lib/crypto/encoding';
import { deriveRootInWorker } from '$lib/crypto/kdf-client';
import { newKdfParams, type KdfParams } from '$lib/crypto/kdf';
import { parseSuite, type Suite } from '$lib/crypto/sealer';
import { session, type Session } from '$lib/state/session.svelte';

/** What one tab tells the others. */
export type TabMessage = 'locked' | 'signed-out';

export interface TabChannel {
	post(message: TabMessage): void;
	/** Returns the function that stops listening. */
	subscribe(listener: (message: TabMessage) => void): () => void;
}

/** The mode this device saw first, kept across visits. */
export interface ModePin {
	read(): Suite | null;
	write(suite: Suite): void;
}

export interface Deps {
	api: Api;
	session: Session;
	pin: ModePin;
	channel: TabChannel;
	deriveRoot: (passphrase: string, params: KdfParams) => Promise<Bytes>;
	/** Parameters, salt included, for a passphrase that is being set. */
	newKdfParams: () => KdfParams;
}

export const MODE_PIN_KEY = 'yondrive.mode';
export const TAB_CHANNEL = 'yondrive.session';

const storedPin: ModePin = {
	read() {
		try {
			return parseSuite(localStorage.getItem(MODE_PIN_KEY));
		} catch {
			return null;
		}
	},
	write(suite) {
		try {
			localStorage.setItem(MODE_PIN_KEY, suite);
		} catch {
			// Without storage the device has no memory, and acts as new each time.
		}
	}
};

/**
 * One channel per tab: a BroadcastChannel does not hear itself, so a tab that
 * posts does not also react to its own message.
 */
let tabChannel: BroadcastChannel | null = null;

function openChannel(): BroadcastChannel | null {
	if (typeof BroadcastChannel === 'undefined') return null;
	tabChannel ??= new BroadcastChannel(TAB_CHANNEL);
	return tabChannel;
}

const broadcast: TabChannel = {
	post(message) {
		openChannel()?.postMessage(message);
	},
	subscribe(listener) {
		const channel = openChannel();
		if (channel === null) return () => {};
		const handler = (event: MessageEvent<unknown>) => {
			if (event.data === 'locked' || event.data === 'signed-out') listener(event.data);
		};
		channel.addEventListener('message', handler);
		return () => channel.removeEventListener('message', handler);
	}
};

export const defaultDeps: Deps = {
	api,
	session,
	pin: storedPin,
	channel: broadcast,
	deriveRoot: deriveRootInWorker,
	newKdfParams
};
