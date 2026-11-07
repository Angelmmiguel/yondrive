/**
 * The spreadsheet worker for the page. Each client is its own worker holding one
 * open workbook. A call that takes longer than the limit ends the worker and the
 * workbook with it: `onFail` hears about it, and the editor opens the file again.
 * Where there is no `Worker` (tests) the same service runs here, loaded when
 * first called so that it stays out of the page's own bundle.
 */
import { local, wrap, type Remote } from './rpc';
import type { SheetService } from './service';

const TIMEOUT_MS = 60_000;

export interface Sheets {
	api: Remote<SheetService>;
	stop(): void;
}

export function createSheets(
	opts: { timeoutMs?: number; onFail?: (e: Error) => void } = {}
): Sheets {
	if (typeof Worker === 'undefined') {
		const here = import('./service').then(({ SheetService }) => local(new SheetService()).api);
		type Calls = Record<string, (...args: unknown[]) => Promise<unknown>>;
		const api = new Proxy({} as Remote<SheetService>, {
			get: (_, method) =>
				typeof method !== 'string' || method === 'then'
					? undefined
					: async (...args: unknown[]) => ((await here) as unknown as Calls)[method](...args)
		});
		return { api, stop: () => {} };
	}
	const w = wrap<SheetService>(
		() => new Worker(new URL('./sheets.worker.ts', import.meta.url), { type: 'module' }),
		{ timeoutMs: opts.timeoutMs ?? TIMEOUT_MS, onFail: opts.onFail }
	);
	return { api: w.api, stop: w.close };
}
