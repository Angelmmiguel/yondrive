/**
 * Document reading and writing in a worker, so that a large or hostile file does
 * not freeze the page; one that takes too long has its worker ended. Where there
 * is no `Worker` (tests) the same code runs here, loaded when first called so
 * that the readers stay out of the page's own bundle.
 */
import type { DocFormat, Opened, SaveFormat } from '$lib/formats/document';
import type { DocModel } from '$lib/formats/model';
import type { FormatsReply, FormatsRequest } from './formats.worker';

export class FormatTimeoutError extends Error {
	constructor() {
		super('reading this file took too long');
		this.name = 'FormatTimeoutError';
	}
}

const TIMEOUT_MS = 60_000;

export interface Formats {
	read(bytes: Uint8Array, format: DocFormat): Promise<Opened>;
	write(
		format: SaveFormat,
		model: DocModel,
		original?: { bytes: Uint8Array; format: DocFormat }
	): Promise<Uint8Array>;
	stop(): void;
}

type Payload = FormatsRequest extends infer R
	? R extends { seq: number }
		? Omit<R, 'seq'>
		: never
	: never;

export function createFormats(timeoutMs = TIMEOUT_MS): Formats {
	if (typeof Worker === 'undefined') {
		const here = () => import('$lib/formats/document');
		return {
			read: async (bytes, format) => (await here()).readDocument(bytes, format),
			write: async (format, model, original) =>
				(await here()).writeDocument(format, model, original),
			stop: () => {}
		};
	}
	let worker: Worker | null = null;
	let seq = 0;
	const pending = new Map<
		number,
		{
			resolve: (v: unknown) => void;
			reject: (e: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const fail = (error: Error) => {
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(error);
		}
		pending.clear();
		worker?.terminate();
		worker = null;
	};
	const start = () => {
		if (worker) return worker;
		const w = new Worker(new URL('./formats.worker.ts', import.meta.url), { type: 'module' });
		w.onmessage = (event: MessageEvent<FormatsReply>) => {
			const reply = event.data;
			const p = pending.get(reply.seq);
			if (!p) return;
			pending.delete(reply.seq);
			clearTimeout(p.timer);
			if ('error' in reply) p.reject(new Error(reply.error));
			else p.resolve(reply.result);
		};
		w.onerror = (event) => fail(new Error(event.message || 'the document worker failed'));
		worker = w;
		return w;
	};
	const call = <T>(payload: Payload): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const id = ++seq;
			const timer = setTimeout(() => fail(new FormatTimeoutError()), timeoutMs);
			pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			start().postMessage({ ...payload, seq: id } as FormatsRequest);
		});
	return {
		read: (bytes, format) => call<Opened>({ op: 'read', bytes, format }),
		write: (format, model, original) => call<Uint8Array>({ op: 'write', format, model, original }),
		stop: () => fail(new Error('stopped'))
	};
}
