/**
 * Runs Argon2id off the main thread. One request per worker: the client
 * creates it, sends the passphrase and parameters, receives the root and
 * terminates it, so no key material outlives the derivation in here.
 */
import { deriveLinkRoot, deriveRoot, type KdfParams } from './kdf';

/** What the client posts. */
export interface KdfRequest {
	passphrase: string;
	params: KdfParams;
	/** A link's password, which has no length rule of its own. */
	link?: boolean;
}

/** What the worker posts back; the root is transferred, not copied. */
export type KdfReply = { root: ArrayBuffer } | { error: string };

self.onmessage = (event: MessageEvent<KdfRequest>) => {
	let reply: KdfReply;
	let transfer: ArrayBuffer[] = [];
	try {
		const derive = event.data.link === true ? deriveLinkRoot : deriveRoot;
		const root = derive(event.data.passphrase, event.data.params);
		reply = { root: root.buffer };
		transfer = [root.buffer];
	} catch (e) {
		reply = { error: e instanceof Error ? e.message : String(e) };
	}
	self.postMessage(reply, { transfer });
};
