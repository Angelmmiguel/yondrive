/**
 * Where frames get sealed and opened. In a browser that is a small pool of workers,
 * each holding the one version key by transfer; where there is no `Worker` it is
 * this thread, through the same interface. The key given to `session` is taken over.
 */
import { SealError } from '$lib/crypto/aead';
import type { VersionRef } from '$lib/crypto/content';
import type { Bytes } from '$lib/crypto/encoding';
import { zero } from '$lib/crypto/random';
import type { SealedFrame, Sealer, VersionCipher } from '$lib/crypto/sealer';
import type { FrameReply, FrameRequest } from './workers/frames.worker';

export interface FrameSession {
	/** Takes the buffer of `plaintext`, which is gone from here afterwards. */
	seal(index: number, final: boolean, plaintext: Uint8Array<ArrayBuffer>): Promise<SealedFrame>;
	/** Takes the buffer of the frame. Refuses it with `SealError` unless it verifies. */
	read(index: number, final: boolean, frame: SealedFrame): Promise<Bytes>;
	close(): void;
}

export interface FramePool {
	session(versionKey: Bytes, ref: VersionRef): FrameSession;
	/** Ends everything: every session fails from here on, and the keys die with the workers. */
	stop(): void;
}

/** The same work in this thread. */
export function inlineFramePool(sealer: Sealer): FramePool {
	const open = new Set<VersionCipher>();
	return {
		session(versionKey, ref) {
			const cipher = sealer.openVersionKey(versionKey, ref);
			open.add(cipher);
			return {
				seal: async (index, final, plaintext) => cipher.sealFrame({ index, final }, plaintext),
				read: async (index, final, frame) => cipher.openFrame({ index, final }, frame),
				close() {
					cipher.close();
					open.delete(cipher);
				}
			};
		},
		stop() {
			for (const cipher of open) cipher.close();
			open.clear();
		}
	};
}

const WORKERS = Math.max(
	1,
	Math.min(3, ((typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency) || 2) - 1)
);

interface Waiting {
	resolve: (reply: { data: ArrayBuffer; sha256: ArrayBuffer }) => void;
	reject: (e: Error) => void;
}

/** A pool of frame workers, started on first use. */
export function workerFramePool(sealer: Sealer): FramePool {
	let workers: Worker[] = [];
	let nextWorker = 0;
	let nextSession = 0;
	let nextSeq = 0;
	const waiting = new Map<number, Waiting>();

	function failAll(error: Error) {
		for (const { reject } of waiting.values()) reject(error);
		waiting.clear();
	}

	function start(): Worker[] {
		if (workers.length > 0) return workers;
		workers = Array.from({ length: WORKERS }, () => {
			const worker = new Worker(new URL('./workers/frames.worker.ts', import.meta.url), {
				type: 'module'
			});
			worker.onmessage = (event: MessageEvent<FrameReply>) => {
				const reply = event.data;
				const pending = waiting.get(reply.seq);
				waiting.delete(reply.seq);
				if (pending === undefined) return;
				if ('sealError' in reply) pending.reject(new SealError(reply.sealError));
				else if ('error' in reply) pending.reject(new Error(reply.error));
				else pending.resolve(reply);
			};
			worker.onerror = (event) => failAll(new Error(event.message || 'frame worker failed'));
			return worker;
		});
		return workers;
	}

	function submit(request: FrameRequest, transfer: ArrayBuffer[], seq: number) {
		return new Promise<{ data: ArrayBuffer; sha256: ArrayBuffer }>((resolve, reject) => {
			const pool = start();
			waiting.set(seq, { resolve, reject });
			pool[nextWorker++ % pool.length].postMessage(request, transfer);
		});
	}

	return {
		session(versionKey, ref) {
			const session = ++nextSession;
			const pool = start();
			const plainRef = { nodeId: ref.nodeId, versionId: ref.versionId, frameSize: ref.frameSize };
			for (const worker of pool) {
				const key = versionKey.slice();
				const open: FrameRequest = {
					op: 'open',
					session,
					suite: sealer.suite,
					ref: plainRef,
					key: key.buffer
				};
				worker.postMessage(open, [key.buffer]);
			}
			zero(versionKey);
			return {
				async seal(index, final, plaintext) {
					const seq = ++nextSeq;
					const data = plaintext.buffer;
					const reply = await submit({ op: 'seal', seq, session, index, final, data }, [data], seq);
					return { data: new Uint8Array(reply.data), sha256: new Uint8Array(reply.sha256) };
				},
				async read(index, final, frame) {
					const seq = ++nextSeq;
					const data = frame.data.buffer;
					const sha256 = frame.sha256.buffer;
					const reply = await submit(
						{ op: 'read', seq, session, index, final, data, sha256 },
						[data],
						seq
					);
					return new Uint8Array(reply.data);
				},
				close() {
					for (const worker of workers) {
						const close: FrameRequest = { op: 'close', session };
						worker.postMessage(close);
					}
				}
			};
		},
		stop() {
			for (const worker of workers) worker.terminate();
			workers = [];
			failAll(new Error('stopped'));
		}
	};
}

/** The pool for this environment. */
export function createFramePool(sealer: Sealer): FramePool {
	return typeof Worker === 'undefined' ? inlineFramePool(sealer) : workerFramePool(sealer);
}
