import { describe, expect, it } from 'vitest';
import { expose, local, RemoteError, RpcTimeoutError, transfer, wrap } from './rpc';

class Target {
	add(a: number, b: number) {
		return a + b;
	}
	async slow() {
		await new Promise((r) => setTimeout(r, 200));
		return 1;
	}
	async while(ms: number) {
		await new Promise((r) => setTimeout(r, ms));
		return ms;
	}
	fail() {
		const e = new Error('nope') as Error & { problem: string };
		e.name = 'FormulaInputError';
		e.problem = 'syntax';
		throw e;
	}
	bytes() {
		const b = new Uint8Array([1, 2, 3]);
		return transfer({ b }, [b.buffer]);
	}
	uncloneable() {
		return { f: () => 1 };
	}
	moved() {
		const b = new Uint8Array([1]);
		structuredClone(b.buffer, { transfer: [b.buffer] });
		return transfer({ b }, [b.buffer]);
	}
}

/** A worker made of a message channel, with the target on the far port. */
function fakeWorker(): Worker {
	const ch = new MessageChannel();
	fakeWorker.port = ch.port2;
	expose(new Target(), ch.port1 as never);
	return {
		postMessage: (m: unknown) => ch.port2.postMessage(m),
		set onmessage(f: ((e: MessageEvent) => void) | null) {
			ch.port2.onmessage = f;
		},
		onerror: null,
		terminate: () => {
			ch.port1.close();
			ch.port2.close();
		}
	} as unknown as Worker;
}

fakeWorker.port = null as MessagePort | null;

describe('rpc', () => {
	it('calls methods and carries errors with their fields', async () => {
		const w = wrap<Target>(fakeWorker, { timeoutMs: 1000 });
		expect(await w.api.add(2, 3)).toBe(5);
		const e = await w.api.fail().catch((x) => x);
		expect(e).toBeInstanceOf(RemoteError);
		expect(e).toMatchObject({ name: 'FormulaInputError', problem: 'syntax', message: 'nope' });
		expect((await w.api.bytes()).b).toEqual(new Uint8Array([1, 2, 3]));
		w.close();
	});

	it('refuses what is not a method of the object', async () => {
		const w = wrap<Target>(fakeWorker, { timeoutMs: 1000 });
		const api = w.api as unknown as Record<string, () => Promise<unknown>>;
		await expect(api.constructor()).rejects.toThrow(/no method/);
		await expect(api.toString()).rejects.toThrow(/no method/);
		w.close();
	});

	it('ends a worker that takes too long, and says so', async () => {
		let failed: Error | null = null;
		const w = wrap<Target>(fakeWorker, { timeoutMs: 20, onFail: (e) => (failed = e) });
		await expect(w.api.slow()).rejects.toBeInstanceOf(RpcTimeoutError);
		expect(failed).toBeInstanceOf(RpcTimeoutError);
		expect(await w.api.add(1, 1)).toBe(2);
		w.close();
	});

	it('keeps answering after a malformed message or a reply that cannot be sent', async () => {
		const w = wrap<Target>(fakeWorker, { timeoutMs: 1000 });
		expect(await w.api.add(1, 1)).toBe(2);
		for (const bad of [null, 1, 'x', {}, { id: 'a' }]) fakeWorker.port!.postMessage(bad);
		await expect(w.api.uncloneable()).rejects.toMatchObject({ name: 'DataCloneError' });
		await expect(w.api.moved()).rejects.toBeInstanceOf(RemoteError);
		expect(await w.api.add(2, 2)).toBe(4);
		w.close();
	});

	it('counts the time of a call from when the worker starts it', async () => {
		const w = wrap<Target>(fakeWorker, { timeoutMs: 150 });
		expect(await Promise.all([w.api.while(100), w.api.while(100), w.api.while(100)])).toEqual([
			100, 100, 100
		]);
		await expect(Promise.all([w.api.while(100), w.api.slow()])).rejects.toBeInstanceOf(
			RpcTimeoutError
		);
		w.close();
	});

	it('runs the same calls here', async () => {
		const l = local(new Target());
		expect(await l.api.add(1, 2)).toBe(3);
		await expect(l.api.fail()).rejects.toMatchObject({ problem: 'syntax' });
	});
});
