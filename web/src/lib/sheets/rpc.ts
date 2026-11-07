/**
 * Calling an object in a worker as if it were here: `wrap` gives a proxy whose
 * methods post a message and resolve with the reply, and `expose` answers those
 * messages from the object. Only the object's own methods can be called. Errors
 * cross with their name, message and the fields the UI reads (`problem`,
 * `detail`), and values marked with `transfer` move rather than copy.
 */

/** The methods of `T`, each returning a promise. */
export type Remote<T> = {
	[K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
		...args: infer A
	) => infer R
		? (...args: A) => Promise<Awaited<R>>
		: never;
};

interface Request {
	id: number;
	method: string;
	args: unknown[];
}

interface WireError {
	name: string;
	message: string;
	problem?: string;
	detail?: string;
}

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: WireError };

/** An error from the other side, as it was named there. */
export class RemoteError extends Error {
	readonly problem?: string;
	readonly detail?: string;
	constructor(e: WireError) {
		super(e.message);
		this.name = e.name;
		this.problem = e.problem;
		this.detail = e.detail;
	}
}

export class RpcTimeoutError extends Error {
	constructor() {
		super('the worker took too long');
		this.name = 'RpcTimeoutError';
	}
}

const transfers = new WeakMap<object, Transferable[]>();

/** Marks a result whose buffers move to the other side instead of being copied. */
export function transfer<T extends object>(value: T, list: Transferable[]): T {
	transfers.set(value, list);
	return value;
}

interface Port {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	onmessage: ((event: MessageEvent) => void) | null;
}

function callable(target: object, method: string): ((...args: unknown[]) => unknown) | null {
	if (method === 'constructor' || method.startsWith('_')) return null;
	let proto = Object.getPrototypeOf(target);
	while (proto && proto !== Object.prototype) {
		if (Object.hasOwn(proto, method)) {
			const f = (target as Record<string, unknown>)[method];
			return typeof f === 'function' ? (f as (...args: unknown[]) => unknown) : null;
		}
		proto = Object.getPrototypeOf(proto);
	}
	return null;
}

function wire(e: unknown): WireError {
	if (e instanceof Error) {
		const x = e as Error & { problem?: string; detail?: string };
		return { name: x.name, message: x.message, problem: x.problem, detail: x.detail };
	}
	return { name: 'Error', message: 'failed' };
}

/** Answers calls arriving on `port` from `target`, one at a time, in order. */
export function expose(target: object, port: Port): void {
	let queue = Promise.resolve();
	port.onmessage = (event: MessageEvent<Request>) => {
		const req = event.data;
		queue = queue.then(async () => {
			let reply: Reply;
			let list: Transferable[] = [];
			try {
				const f = callable(target, req.method);
				if (!f) throw new Error(`no method ${req.method}`);
				const value = await f.apply(target, req.args);
				if (value !== null && typeof value === 'object') list = transfers.get(value) ?? [];
				reply = { id: req.id, ok: true, value };
			} catch (e) {
				reply = { id: req.id, ok: false, error: wire(e) };
			}
			port.postMessage(reply, list);
		});
	};
}

export interface Wrapped<T> {
	api: Remote<T>;
	/** Ends the worker; pending calls fail. */
	close(): void;
}

/**
 * A proxy for an object exposed in a worker. A call that takes longer than
 * `timeoutMs` ends the worker, since what it held can no longer be trusted, and
 * every pending call fails; `onFail` hears about it.
 */
export function wrap<T>(
	start: () => Worker,
	opts: { timeoutMs: number; onFail?: (e: Error) => void }
): Wrapped<T> {
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
		opts.onFail?.(error);
	};
	const get = () => {
		if (worker) return worker;
		const w = start();
		w.onmessage = (event: MessageEvent<Reply>) => {
			const r = event.data;
			const p = pending.get(r.id);
			if (!p) return;
			pending.delete(r.id);
			clearTimeout(p.timer);
			if (r.ok) p.resolve(r.value);
			else p.reject(new RemoteError(r.error));
		};
		w.onerror = (event) => fail(new Error(event.message || 'the worker failed'));
		worker = w;
		return w;
	};
	const api = new Proxy({} as Remote<T>, {
		get(_, method) {
			if (typeof method !== 'string' || method === 'then') return undefined;
			return (...args: unknown[]) =>
				new Promise((resolve, reject) => {
					const id = ++seq;
					const timer = setTimeout(() => fail(new RpcTimeoutError()), opts.timeoutMs);
					pending.set(id, { resolve, reject, timer });
					get().postMessage({ id, method, args } satisfies Request);
				});
		}
	});
	return { api, close: () => fail(new Error('closed')) };
}

/** The same calls on an object here, for tests and where there is no `Worker`. */
export function local<T extends object>(target: T): Wrapped<T> {
	const api = new Proxy({} as Remote<T>, {
		get(_, method) {
			if (typeof method !== 'string' || method === 'then') return undefined;
			return async (...args: unknown[]) => {
				const f = callable(target, method);
				if (!f) throw new Error(`no method ${method}`);
				try {
					return await f.apply(target, args);
				} catch (e) {
					throw new RemoteError(wire(e));
				}
			};
		}
	});
	return { api, close: () => {} };
}
