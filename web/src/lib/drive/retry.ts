/** Trying a request again when that can help. */
import { ApiError } from '$lib/api/types';

export interface RetryOptions {
	attempts?: number;
	baseMs?: number;
	signal?: AbortSignal;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The connection, or a server having a moment. Anything else will answer the same again. */
export function isRetryable(e: unknown): boolean {
	return (
		e instanceof ApiError &&
		(e.code === 'network' || e.status === 429 || e.status === 408 || e.status >= 500)
	);
}

/** Waits, or rejects as soon as `signal` fires. */
export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
}

/** Runs `attempt`, waiting twice as long before each new try. */
export async function withRetry<T>(
	attempt: () => Promise<T>,
	options: RetryOptions = {}
): Promise<T> {
	const { attempts = 6, baseMs = 500, signal, sleep = sleepFor } = options;
	for (let tried = 1; ; tried++) {
		try {
			return await attempt();
		} catch (e) {
			if (signal?.aborted) throw signal.reason;
			if (tried >= attempts || !isRetryable(e)) throw e;
			await sleep(baseMs * 2 ** (tried - 1), signal);
		}
	}
}

/** At most `limit` at once, first come first served. */
export class Limiter {
	readonly #limit: number;
	#active = 0;
	readonly #waiting: (() => void)[] = [];

	constructor(limit: number) {
		this.#limit = limit;
	}

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.#active >= this.#limit) {
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		} else {
			this.#active += 1;
		}
		try {
			return await task();
		} finally {
			const next = this.#waiting.shift();
			if (next !== undefined) next();
			else this.#active -= 1;
		}
	}
}
