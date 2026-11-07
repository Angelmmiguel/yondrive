/**
 * Seals and opens frames off the main thread, so that a large upload or download
 * does not freeze the page. It holds the key of one version per session, never a
 * node key. Each arrives by transfer, and is zeroed when the session closes, and
 * a lock terminates this worker outright.
 */
import { SealError } from '$lib/crypto/aead';
import type { Bytes } from '$lib/crypto/encoding';
import type { VersionRef } from '$lib/crypto/content';
import { sealerFor, type Suite, type VersionCipher } from '$lib/crypto/sealer';

export type FrameRequest =
	| { op: 'open'; session: number; suite: Suite; ref: VersionRef; key: ArrayBuffer }
	| { op: 'close'; session: number }
	| { op: 'seal'; seq: number; session: number; index: number; final: boolean; data: ArrayBuffer }
	| {
			op: 'read';
			seq: number;
			session: number;
			index: number;
			final: boolean;
			data: ArrayBuffer;
			sha256: ArrayBuffer;
	  };

export type FrameReply =
	| { seq: number; data: ArrayBuffer; sha256: ArrayBuffer }
	| { seq: number; sealError: SealError['code'] }
	| { seq: number; error: string };

const sessions = new Map<number, VersionCipher>();

type Work = Extract<FrameRequest, { seq: number }>;

function handle(request: Work): {
	reply: FrameReply;
	send: ArrayBuffer[];
} {
	const cipher = sessions.get(request.session);
	if (cipher === undefined) throw new Error('no such session');
	const position = { index: request.index, final: request.final };
	if (request.op === 'seal') {
		const frame = cipher.sealFrame(position, new Uint8Array(request.data));
		return {
			reply: { seq: request.seq, data: frame.data.buffer, sha256: frame.sha256.buffer },
			send: [frame.data.buffer, frame.sha256.buffer]
		};
	}
	const sha256 = new Uint8Array(request.sha256);
	const plaintext = cipher.openFrame(position, { data: new Uint8Array(request.data), sha256 });
	return {
		reply: { seq: request.seq, data: plaintext.buffer as ArrayBuffer, sha256: request.sha256 },
		send: [plaintext.buffer as ArrayBuffer]
	};
}

self.onmessage = (event: MessageEvent<FrameRequest>) => {
	const request = event.data;
	if (request.op === 'open') {
		const key = new Uint8Array(request.key) as Bytes;
		sessions.set(request.session, sealerFor(request.suite).openVersionKey(key, request.ref));
		return;
	}
	if (request.op === 'close') {
		sessions.get(request.session)?.close();
		sessions.delete(request.session);
		return;
	}
	try {
		const { reply, send } = handle(request);
		self.postMessage(reply, { transfer: send });
	} catch (e) {
		const reply: FrameReply =
			e instanceof SealError
				? { seq: request.seq, sealError: e.code }
				: { seq: request.seq, error: e instanceof Error ? e.message : String(e) };
		self.postMessage(reply);
	}
};
