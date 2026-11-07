/**
 * What the service worker does with a request for a stream, without being a service
 * worker: everything comes in through `HostDeps`. A range maps to frames. Each is
 * fetched with its own `Range`, checked against its hash, opened and released, so
 * nothing that fails to verify reaches the page, and nothing is buffered beyond a
 * frame or two. Keys stay in memory here. A browser stops idle service workers, so
 * after a restart it asks the page for what it needs again.
 */
import { SealError } from '$lib/crypto/aead';
import type { VersionRef } from '$lib/crypto/content';
import type { Bytes } from '$lib/crypto/encoding';
import { sealerFor, type Suite, type VersionCipher } from '$lib/crypto/sealer';
import { framesOf, parseRange } from '../download/ranges';
import { storedRange } from '../upload/plan';

export const STREAM_PATH = '/stream/';

/** The channel the tabs announce a lock on. The account layer owns it; a test keeps these equal. */
export const TAB_CHANNEL = 'yondrive.session';

/** All that is needed to serve a version, the key included. */
export interface StreamInfo {
	id: string;
	suite: Suite;
	ref: VersionRef;
	blobId: string;
	size: number;
	storedSize: number;
	frameCount: number;
	hashes: ArrayBuffer;
	/** What it is served as, for a media element; a download is never anything but bytes. */
	mime: string | null;
	filename: string;
	key: ArrayBuffer;
}

export type PageMessage =
	{ type: 'register'; info: StreamInfo } | { type: 'release'; id: string } | { type: 'clear' };

export type WorkerMessage =
	| { type: 'need-stream'; id: string }
	| { type: 'stream-error'; id: string; integrity: boolean }
	| { type: 'stream-done'; id: string };

export interface HostDeps {
	/** The stored bytes of a range, ends included. */
	fetchBytes(blobId: string, start: number, end: number, signal?: AbortSignal): Promise<Bytes>;
	/** Asks the pages for a stream after a restart: `null` if none has it, as after a lock. */
	askPages(id: string): Promise<StreamInfo | null>;
	report(message: WorkerMessage): void;
}

interface Stream {
	info: StreamInfo;
	cipher: VersionCipher;
	hashes: Uint8Array;
	overhead: number;
}

/** A stream with `mime` keeps it only if it is media: anything else could run as a page. */
export function responseHeaders(info: Pick<StreamInfo, 'mime' | 'filename'>): Headers {
	const media = info.mime !== null && /^(audio|video)\/[\w.+-]+$/.test(info.mime);
	return new Headers({
		'Content-Type': media ? (info.mime as string) : 'application/octet-stream',
		'Content-Disposition': `${media ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(info.filename)}`,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'private, no-store',
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': "default-src 'none'; sandbox"
	});
}

export class StreamHost {
	readonly #deps: HostDeps;
	readonly #streams = new Map<string, Stream>();
	readonly #asking = new Map<string, Promise<Stream | null>>();

	constructor(deps: HostDeps) {
		this.#deps = deps;
	}

	get size(): number {
		return this.#streams.size;
	}

	register(info: StreamInfo): void {
		this.release(info.id);
		this.#streams.set(info.id, this.#open(info));
	}

	#open(info: StreamInfo): Stream {
		const sealer = sealerFor(info.suite);
		return {
			info,
			cipher: sealer.openVersionKey(new Uint8Array(info.key), info.ref),
			hashes: new Uint8Array(info.hashes),
			overhead: sealer.frameOverhead
		};
	}

	release(id: string): void {
		this.#streams.get(id)?.cipher.close();
		this.#streams.delete(id);
	}

	/** On lock and sign-out: every key goes, and whatever is streaming fails on its next frame. */
	clear(): void {
		for (const id of [...this.#streams.keys()]) this.release(id);
	}

	async #find(id: string): Promise<Stream | null> {
		const known = this.#streams.get(id);
		if (known !== undefined) return known;
		let asking = this.#asking.get(id);
		if (asking === undefined) {
			asking = this.#deps.askPages(id).then((info) => {
				if (info === null) return null;
				this.register(info);
				return this.#streams.get(id) ?? null;
			});
			asking = asking.finally(() => this.#asking.delete(id));
			this.#asking.set(id, asking);
		}
		return asking;
	}

	/** The answer to a request for `/stream/<id>`. */
	async respond(id: string, range: string | null, signal?: AbortSignal): Promise<Response> {
		const stream = await this.#find(id);
		if (stream === null) return new Response(null, { status: 404 });
		const { info } = stream;
		const headers = responseHeaders(info);
		const parsed = parseRange(range, info.size);
		if (parsed.kind === 'invalid') {
			headers.set('Content-Range', `bytes */${info.size}`);
			return new Response(null, { status: 416, headers });
		}
		if (info.size === 0) {
			headers.set('Content-Length', '0');
			return new Response(null, { status: 200, headers });
		}
		const start = parsed.kind === 'partial' ? parsed.start : 0;
		const end = parsed.kind === 'partial' ? parsed.end : info.size - 1;
		headers.set('Content-Length', String(end - start + 1));
		if (parsed.kind === 'partial') {
			headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
		}
		const whole = parsed.kind === 'full' && info.mime === null;
		return new Response(this.#body(stream, start, end, whole, signal), {
			status: parsed.kind === 'partial' ? 206 : 200,
			headers
		});
	}

	#body(
		stream: Stream,
		start: number,
		end: number,
		oneShot: boolean,
		signal?: AbortSignal
	): ReadableStream {
		const { frameSize } = stream.info.ref;
		const { first, last, skip, keep } = framesOf(start, end, frameSize);
		let index = first;
		const fetched = new Map<number, Promise<Bytes>>();
		const fetchFrame = (i: number) => {
			let promise = fetched.get(i);
			if (promise === undefined) {
				const range = storedRange(frameSize, stream.overhead, stream.info.storedSize, i);
				promise =
					range === null
						? Promise.resolve(new Uint8Array(0) as Bytes)
						: this.#deps.fetchBytes(stream.info.blobId, range.start, range.end, signal);
				// A failure here is reported when its turn comes.
				promise.catch(() => {});
				fetched.set(i, promise);
			}
			return promise;
		};
		return new ReadableStream<Uint8Array>(
			{
				pull: async (controller) => {
					try {
						const data = await fetchFrame(index);
						fetched.delete(index);
						// One frame ahead, so that the network and the cipher overlap.
						if (index < last) void fetchFrame(index + 1);
						const opened = stream.cipher.openFrame(
							{ index, final: index === stream.info.frameCount - 1 },
							{ data, sha256: stream.hashes.slice(index * 32, (index + 1) * 32) as Bytes }
						);
						const from = index === first ? skip : 0;
						const to = index === last ? keep : opened.length;
						controller.enqueue(opened.subarray(from, to));
						index += 1;
						if (index > last) {
							controller.close();
							// A finished download will not be asked for again, so its key can go.
							if (oneShot) {
								this.release(stream.info.id);
								this.#deps.report({ type: 'stream-done', id: stream.info.id });
							}
						}
					} catch (e) {
						this.#deps.report({
							type: 'stream-error',
							id: stream.info.id,
							integrity: e instanceof SealError
						});
						controller.error(e);
					}
				}
			},
			{ highWaterMark: 0 }
		);
	}
}
