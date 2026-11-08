/**
 * Sending files through a file request, with no account. The request's public key
 * comes from the URL and from nowhere else: the server's copy is only compared with
 * it, so a server that names another key is refused. Each file gets a node key of its
 * own, its content and metadata are sealed under it as any upload's are, and the key
 * is sealed to the request. Nothing here can open anything afterwards, and nothing is
 * kept: keys and the token live in memory and go with `stop`.
 */
import type { Api } from '$lib/api/client';
import { ApiError, isApiError, type PublicRequest } from '$lib/api/types';
import { decodeBase64, encodeBase64, type Bytes } from '$lib/crypto/encoding';
import { parseKdfParams, type KdfParams } from '$lib/crypto/kdf';
import { constantTimeEqual, zero } from '$lib/crypto/random';
import type { Sealer } from '$lib/crypto/sealer';
import type { FramePool } from '$lib/drive/frame-pool';
import { inferType } from '$lib/drive/kinds';
import { cleanName } from '$lib/drive/names';
import { withRetry } from '$lib/drive/retry';
import { inParallel, type UploadSource } from '$lib/drive/upload/engine';
import { frameBounds, planFrames } from '$lib/drive/upload/plan';
import { WrongLinkPasswordError } from './public';

/**
 * Why a request does not open, or no longer does. `wrong-mode` is a server whose files are not
 * sealed the way this page seals them; `downgraded` an address made for encrypted files, on a
 * server that says it encrypts nothing.
 */
export type RequestEnding =
	'expired' | 'revoked' | 'gone' | 'no-key' | 'bad-key' | 'wrong-mode' | 'downgraded';

export type RequestState =
	{ kind: 'password' } | { kind: 'open' } | { kind: 'ended'; why: RequestEnding };

/** What the request takes from here on. Null means no limit. */
export interface RequestRoom {
	maxFileSize: number | null;
	filesRemaining: number | null;
	bytesRemaining: number | null;
	expiresAt: number | null;
}

/** Why a file will not go, known before anything is sent. */
export type RequestRefusal = 'too-large' | 'no-files' | 'no-room';

/** What a sender may say about themselves, sealed with each file. */
export interface SenderNote {
	from?: string;
	message?: string;
}

export const MAX_FROM = 100;
export const MAX_MESSAGE = 1000;

/** A file to send: a `File` does, and so does a test. */
export interface SendSource extends UploadSource {
	name: string;
	type: string;
}

/** A file on its way: what a retry goes on from. Its key is zeroed when it is done. */
export interface Sending {
	uploadId: string;
	nodeId: string;
	versionId: string;
	frameSize: number;
	nodeKey: Bytes;
	/** What is sealed of the file, which goes with its commit. */
	sealedKey: string;
	sealedMetadata: string;
}

export interface RequestDeps {
	api: Pick<
		Api,
		| 'getPublicRequest'
		| 'unlockPublicRequest'
		| 'createRequestUpload'
		| 'getRequestUpload'
		| 'abortRequestUpload'
		| 'putRequestFrame'
		| 'commitRequestUpload'
	>;
	sealer: Sealer;
	pool: FramePool;
	deriveRoot: (password: string, params: KdfParams) => Promise<Bytes>;
	/** Told when a request that was open ends. */
	onended?: (why: RequestEnding) => void;
	/** Told when the session has run out and the password is asked for again. */
	onlocked?: () => void;
	now?: () => number;
	schedule?: (run: () => void, ms: number) => () => void;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Instead of the default, for tests that would rather not seal megabytes. */
	frameSize?: number;
}

/** The upload is not on the server any more, as after a long pause: the file starts over. */
export class UploadGoneError extends Error {
	constructor() {
		super('the upload is gone');
		this.name = 'UploadGoneError';
	}
}

const gone = (e: unknown): never => {
	throw isApiError(e, 'not_found') ? new UploadGoneError() : e;
};

/**
 * Whether the page must refuse the mode the server claims, before it asks anything else. An
 * address with a key in it was made by an owner whose server encrypts; one that now says it
 * does not would have the files sent as they are. A server with keys and an address with none
 * is the `no-key` ending, which a session reaches itself.
 */
export function modeRefusal(fragment: string, sealer: Sealer): 'downgraded' | null {
	return fragment !== '' && !sealer.encrypted ? 'downgraded' : null;
}

const ENDINGS: Record<string, RequestEnding> = {
	link_expired: 'expired',
	link_revoked: 'revoked',
	not_found: 'gone',
	invalid_id: 'gone'
};

const RENEW_MARGIN_MS = 60_000;
const MIN_RENEW_MS = 1_000;
const FRAMES_AT_ONCE = 4;
/** Starting uploads is limited per address, so a pile of files waits its turn. */
const START_ATTEMPTS = 9;

/** The time a refused start is retried over, and every other call. */
const retry = (deps: RequestDeps, signal?: AbortSignal, attempts?: number) => ({
	signal,
	sleep: deps.sleep,
	attempts
});

export class RequestSession {
	readonly #deps: RequestDeps;
	readonly #id: string;
	/** From the URL: what every file is sealed to. Empty in suite `none`. */
	readonly #publicKey: Bytes;
	#kdf: KdfParams | null = null;
	#token = '';
	#cancelRenew: (() => void) | null = null;
	#stopped = false;
	room: RequestRoom = {
		maxFileSize: null,
		filesRemaining: null,
		bytesRemaining: null,
		expiresAt: null
	};

	/** Takes over `publicKey`, read out of the URL. */
	constructor(id: string, publicKey: Bytes, deps: RequestDeps) {
		this.#id = id;
		this.#publicKey = publicKey;
		this.#deps = deps;
	}

	stop(): void {
		this.#stopped = true;
		this.#cancelRenew?.();
		this.#cancelRenew = null;
		this.#token = '';
		this.#deps.pool.stop();
	}

	#ended(e: unknown): RequestState {
		const why = e instanceof ApiError ? ENDINGS[e.code] : undefined;
		if (why === undefined) throw e;
		return { kind: 'ended', why };
	}

	async open(): Promise<RequestState> {
		try {
			return this.#adopt(await this.#deps.api.getPublicRequest(this.#id));
		} catch (e) {
			return this.#ended(e);
		}
	}

	async unlock(password: string): Promise<RequestState> {
		const { sealer, api, deriveRoot } = this.#deps;
		if (this.#kdf === null) throw new Error('this request has no password');
		const root = await deriveRoot(password, this.#kdf);
		const { authKey, kek } = sealer.linkPasswordKeys(root);
		zero(root, kek);
		try {
			return this.#adopt(
				await api.unlockPublicRequest(this.#id, { auth_key: encodeBase64(authKey) })
			);
		} catch (e) {
			if (isApiError(e, 'link_password_invalid')) throw new WrongLinkPasswordError();
			return this.#ended(e);
		} finally {
			zero(authKey);
		}
	}

	#adopt(document: PublicRequest): RequestState {
		const { sealer } = this.#deps;
		if (document.state === 'password_required') {
			this.#kdf = parseKdfParams(document.kdf);
			return { kind: 'password' };
		}
		const { token, token_expires_at: until, suite, public_key: offered } = document;
		if (suite !== sealer.suite) return { kind: 'ended', why: 'wrong-mode' };
		if (token === undefined || until === undefined) return { kind: 'ended', why: 'bad-key' };
		if (sealer.encrypted && this.#publicKey.length === 0) return { kind: 'ended', why: 'no-key' };
		// The URL vouches for the key. One the server names otherwise is not the owner's.
		if (!constantTimeEqual(decodeBase64(offered ?? ''), this.#publicKey)) {
			return { kind: 'ended', why: 'bad-key' };
		}
		this.#token = token;
		const time = (value: string | undefined) => (value === undefined ? null : Date.parse(value));
		this.room = {
			maxFileSize: document.max_file_size ?? null,
			filesRemaining: document.files_remaining ?? null,
			bytesRemaining: document.bytes_remaining ?? null,
			expiresAt: time(document.expires_at)
		};
		this.#scheduleRenewal(Date.parse(until));
		return { kind: 'open' };
	}

	#scheduleRenewal(until: number): void {
		this.#cancelRenew?.();
		if (this.#stopped) return;
		const now = this.#deps.now?.() ?? Date.now();
		const wait = Math.max(until - now - RENEW_MARGIN_MS, MIN_RENEW_MS);
		const schedule =
			this.#deps.schedule ??
			((run, ms) => {
				const timer = setTimeout(run, ms);
				return () => clearTimeout(timer);
			});
		this.#cancelRenew = schedule(() => void this.renew(), wait);
	}

	/** A new token within the session, which also shows whether the request has ended. */
	async renew(): Promise<void> {
		if (this.#stopped) return;
		try {
			const state = this.#adopt(await this.#deps.api.getPublicRequest(this.#id, this.#token));
			if (state.kind === 'ended') this.#deps.onended?.(state.why);
			// The session has ended, and only the password starts another.
			if (state.kind === 'password') this.#deps.onlocked?.();
		} catch (e) {
			if (isApiError(e, 'network', 'rate_limited', 'internal')) {
				this.#scheduleRenewal(Date.now() + RENEW_MARGIN_MS + MIN_RENEW_MS * 10);
				return;
			}
			const ended = this.#ended(e);
			if (ended.kind === 'ended') this.#deps.onended?.(ended.why);
		}
	}

	/** Calls with the token, renewing it once if it has run out, and seeing an ending through. */
	async #call<T>(attempt: (token: string) => Promise<T>): Promise<T> {
		try {
			return await attempt(this.#token);
		} catch (e) {
			if (isApiError(e, 'link_token_invalid', 'link_token_required')) {
				await this.renew();
				return attempt(this.#token);
			}
			if (isApiError(e, 'link_expired', 'link_revoked')) {
				const ended = this.#ended(e);
				if (ended.kind === 'ended') this.#deps.onended?.(ended.why);
			}
			throw e;
		}
	}

	/** Whether a file of this size fits what is left, as far as this page knows. */
	refusal(size: number): RequestRefusal | null {
		const { maxFileSize, filesRemaining, bytesRemaining } = this.room;
		if (maxFileSize !== null && size > maxFileSize) return 'too-large';
		if (filesRemaining !== null && filesRemaining < 1) return 'no-files';
		if (bytesRemaining !== null && size > bytesRemaining) return 'no-room';
		return null;
	}

	/**
	 * Reserves a file's place, and seals what is said about it under a new key, with
	 * the ids the server chose for it.
	 */
	async begin(file: SendSource, note: SenderNote, signal?: AbortSignal): Promise<Sending> {
		const { sealer, api } = this.#deps;
		const plan = planFrames(file.size, sealer.frameOverhead, this.#deps.frameSize);
		const body = {
			suite: sealer.suite,
			frame_count: plan.frameCount,
			frame_size: plan.frameSize,
			stored_size: plan.storedSize
		};
		const upload = await withRetry(
			() => this.#call((token) => api.createRequestUpload(this.#id, token, body)),
			retry(this.#deps, signal, START_ATTEMPTS)
		);
		const nodeId = upload.node_id;
		const nodeKey = sealer.newNodeKey();
		const now = this.#deps.now?.() ?? Date.now();
		let name: string;
		try {
			name = cleanName(file.name);
		} catch {
			name = 'Untitled file';
		}
		const request: Record<string, string> = {};
		const from = note.from?.trim().slice(0, MAX_FROM);
		const message = note.message?.trim().slice(0, MAX_MESSAGE);
		if (from) request.from = from;
		if (message) request.message = message;
		const metadata = {
			name,
			type: inferType(name, file.type),
			created: now,
			modified: file.lastModified,
			size: file.size,
			tags: [],
			favorite: false,
			request
		};
		return {
			uploadId: upload.id,
			nodeId,
			versionId: upload.version_id,
			frameSize: plan.frameSize,
			nodeKey,
			sealedKey: encodeBase64(
				sealer.sealNodeKeyToRequest(nodeKey, this.#publicKey, this.#id, nodeId)
			),
			sealedMetadata: encodeBase64(sealer.sealMetadata(nodeKey, nodeId, metadata))
		};
	}

	/** Sends what the server does not have yet, then hands the file over. */
	async transfer(
		file: SendSource,
		sending: Sending,
		onProgress: (done: number) => void = () => {},
		signal?: AbortSignal
	): Promise<void> {
		const { sealer, api, pool } = this.#deps;
		const plan = planFrames(file.size, sealer.frameOverhead, sending.frameSize);
		const upload = await withRetry(
			() => this.#call((token) => api.getRequestUpload(this.#id, sending.uploadId, token)),
			retry(this.#deps, signal)
		).catch(gone);
		const arrived = new Set(upload.frames);
		let done = 0;
		for (const index of arrived) {
			const { start, end } = frameBounds(plan, index);
			done += end - start;
		}
		onProgress(done);
		const ref = { nodeId: sending.nodeId, versionId: sending.versionId, frameSize: plan.frameSize };
		const session = pool.session(sealer.versionKey(sending.nodeKey, ref), ref);
		try {
			const missing = Array.from({ length: plan.frameCount }, (_, i) => i).filter(
				(i) => !arrived.has(i)
			);
			await inParallel(missing, FRAMES_AT_ONCE, async (index) => {
				signal?.throwIfAborted();
				const { start, end, final } = frameBounds(plan, index);
				const plaintext = new Uint8Array(await file.slice(start, end).arrayBuffer());
				const frame = await session.seal(index, final, plaintext);
				const digest = encodeBase64(frame.sha256);
				await withRetry(
					() =>
						this.#call((token) =>
							api.putRequestFrame(
								this.#id,
								sending.uploadId,
								index,
								token,
								frame.data,
								digest,
								signal
							)
						),
					retry(this.#deps, signal)
				).catch(gone);
				done += end - start;
				onProgress(done);
			});
		} finally {
			session.close();
		}
		// A commit that has happened answers the same again, so `not_found` is a file that
		// never arrived.
		const sealed = { sealed_key: sending.sealedKey, sealed_metadata: sending.sealedMetadata };
		await withRetry(
			() =>
				this.#call((token) => api.commitRequestUpload(this.#id, sending.uploadId, token, sealed)),
			retry(this.#deps, signal)
		).catch(gone);
		zero(sending.nodeKey);
		this.#took(file.size);
	}

	#took(size: number): void {
		const { filesRemaining, bytesRemaining } = this.room;
		this.room = {
			...this.room,
			filesRemaining: filesRemaining === null ? null : Math.max(filesRemaining - 1, 0),
			bytesRemaining: bytesRemaining === null ? null : Math.max(bytesRemaining - size, 0)
		};
	}

	/** Lets go of a file on its way, and of its key. */
	async abandon(sending: Sending): Promise<void> {
		zero(sending.nodeKey);
		await this.#call((token) =>
			this.#deps.api.abortRequestUpload(this.#id, sending.uploadId, token)
		).catch(() => {});
	}
}

export type SendStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface SendItem {
	id: number;
	name: string;
	size: number;
	done: number;
	status: SendStatus;
	error?: unknown;
}

interface SendJob {
	item: SendItem;
	file: SendSource;
	note: SenderNote;
	sending?: Sending;
	controller: AbortController;
}

const FILES_AT_ONCE = 2;

/**
 * The files someone has dropped on a request, a few at a time. A failed one goes on
 * from the frames the server has when it is tried again. Reactive state wraps it from
 * outside, through `onchange`.
 */
export class RequestSender {
	items: SendItem[] = [];
	onchange: () => void = () => {};
	readonly #session: RequestSession;
	readonly #jobs = new Map<number, SendJob>();
	readonly #waiting: SendJob[] = [];
	#running = 0;
	#seq = 0;

	constructor(session: RequestSession) {
		this.#session = session;
	}

	get active(): boolean {
		return this.items.some((i) => i.status === 'queued' || i.status === 'sending');
	}

	/** Queues files, or says why one will not go. Each is checked against what is left. */
	add(files: readonly SendSource[], note: SenderNote): RequestRefusal | null {
		let count = this.#session.room.filesRemaining;
		let bytes = this.#session.room.bytesRemaining;
		for (const job of this.#jobs.values()) {
			if (job.item.status === 'queued' || job.item.status === 'sending') {
				if (count !== null) count -= 1;
				if (bytes !== null) bytes -= job.item.size;
			}
		}
		const max = this.#session.room.maxFileSize;
		for (const file of files) {
			if (max !== null && file.size > max) return 'too-large';
			if (count !== null && count < 1) return 'no-files';
			if (bytes !== null && file.size > bytes) return 'no-room';
			if (count !== null) count -= 1;
			if (bytes !== null) bytes -= file.size;
		}
		for (const file of files) {
			const item: SendItem = {
				id: ++this.#seq,
				name: file.name,
				size: file.size,
				done: 0,
				status: 'queued'
			};
			const job: SendJob = { item, file, note: { ...note }, controller: new AbortController() };
			this.items = [...this.items, item];
			this.#jobs.set(item.id, job);
			this.#waiting.push(job);
		}
		this.#pump();
		this.onchange();
		return null;
	}

	/** Tries a failed one again, from what has arrived. */
	retry(id: number): void {
		const job = this.#jobs.get(id);
		if (job === undefined || job.item.status !== 'failed') return;
		job.controller = new AbortController();
		this.#update(job, { status: 'queued', error: undefined });
		this.#waiting.push(job);
		this.#pump();
	}

	async cancel(id: number): Promise<void> {
		const job = this.#jobs.get(id);
		if (job === undefined || job.item.status === 'sent' || job.item.status === 'cancelled') return;
		job.controller.abort(new DOMException('cancelled', 'AbortError'));
		const at = this.#waiting.indexOf(job);
		if (at >= 0) this.#waiting.splice(at, 1);
		this.#update(job, { status: 'cancelled', error: undefined });
		if (job.sending !== undefined) await this.#session.abandon(job.sending);
		job.sending = undefined;
	}

	/** Forgets everything that has finished, names included: nothing of it stays on screen. */
	clear(): void {
		for (const item of this.items) {
			if (item.status !== 'queued' && item.status !== 'sending') {
				const job = this.#jobs.get(item.id);
				if (job?.sending !== undefined) void this.#session.abandon(job.sending);
				this.#jobs.delete(item.id);
			}
		}
		this.items = this.items.filter((i) => i.status === 'queued' || i.status === 'sending');
		this.onchange();
	}

	/** Stops everything here and lets go of the keys. */
	stop(): void {
		this.#waiting.length = 0;
		for (const job of this.#jobs.values()) {
			job.controller.abort(new DOMException('stopped', 'AbortError'));
			if (job.sending !== undefined) zero(job.sending.nodeKey);
		}
		this.#jobs.clear();
		this.items = [];
	}

	#update(job: SendJob, patch: Partial<SendItem>): void {
		job.item = { ...job.item, ...patch };
		this.items = this.items.map((i) => (i.id === job.item.id ? job.item : i));
		this.onchange();
	}

	#pump(): void {
		while (this.#running < FILES_AT_ONCE && this.#waiting.length > 0) {
			const job = this.#waiting.shift() as SendJob;
			this.#running += 1;
			void this.#run(job).finally(() => {
				this.#running -= 1;
				this.#pump();
			});
		}
	}

	async #run(job: SendJob): Promise<void> {
		const signal = job.controller.signal;
		this.#update(job, { status: 'sending' });
		try {
			for (let started = 0; ; started++) {
				job.sending ??= await this.#session.begin(job.file, job.note, signal);
				signal.throwIfAborted();
				try {
					await this.#session.transfer(
						job.file,
						job.sending,
						(done) => this.#update(job, { done }),
						signal
					);
					break;
				} catch (e) {
					// The server dropped it, idle too long: begin again, once in a row.
					if (!(e instanceof UploadGoneError) || started > 0) throw e;
					zero(job.sending.nodeKey);
					job.sending = undefined;
					this.#update(job, { done: 0 });
				}
			}
			job.sending = undefined;
			this.#update(job, { status: 'sent', done: job.file.size });
		} catch (e) {
			if (signal.aborted) return;
			if (
				job.sending !== undefined &&
				(e instanceof UploadGoneError || isApiError(e, 'frame_conflict'))
			) {
				// Nothing to go on from: what arrived is gone, or is not what this page sealed.
				await this.#session.abandon(job.sending);
				job.sending = undefined;
			}
			this.#update(job, { status: 'failed', error: e });
		}
	}
}
