import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/types';
import { EditSession, type EditSessionDeps } from './session';

function deps() {
	const timers: (() => void)[] = [];
	const d: EditSessionDeps = {
		save: vi.fn(async () => 'v2'),
		copy: vi.fn(async (file) => ({ ...file, id: 'copy' })),
		rename: vi.fn(async () => true),
		create: vi.fn(async (_f, name) => ({ id: 'new', name, version: 'n1' })),
		onstatus: () => {},
		onconflict: vi.fn(),
		onfile: vi.fn(),
		setTimeout: (fn) => timers.push(fn),
		clearTimeout: () => timers.splice(0)
	};
	return { d, timers };
}

const file = { id: 'n1', name: 'Book.xls', version: 'v1' };

describe('an edit session', () => {
	it('saves what the editor writes, in the format it saves in', async () => {
		const { d } = deps();
		const write = vi.fn(async (f: string) => new TextEncoder().encode(f));
		const s = new EditSession(d, file, { original: 'xls', saveAs: 'xlsx' }, write);
		expect(s.converting).toBe(true);
		s.changed();
		await s.flush();
		expect(write).toHaveBeenCalledWith('xlsx');
		expect(d.rename).toHaveBeenCalledWith(file, 'Book.xlsx');
		expect(s.file).toEqual({ id: 'n1', name: 'Book.xlsx', version: 'v2' });
		expect(s.status).toBe('saved');
	});

	it('never saves again once discarded, whatever was waiting', async () => {
		const { d, timers } = deps();
		const write = vi.fn(async () => new Uint8Array([1]));
		const s = new EditSession(d, file, { original: 'xlsx', saveAs: 'xlsx' }, write);
		s.changed();
		s.discard();
		expect(timers).toEqual([]);
		await s.flush();
		await s.close();
		s.changed();
		expect(write).not.toHaveBeenCalled();
		expect(d.save).not.toHaveBeenCalled();
	});
});

describe('closing while a save runs', () => {
	it('resolves only once the edits made during that save are saved', async () => {
		const { d, timers } = deps();
		let release = () => {};
		const saved: string[] = [];
		d.save = vi.fn(async (_f, bytes) => {
			if (saved.length === 0) await new Promise<void>((r) => (release = r));
			saved.push(new TextDecoder().decode(bytes));
			return `v${saved.length + 1}`;
		});
		let text = 'one';
		let alive = true;
		const s = new EditSession(
			d,
			{ ...file, name: 'Book.xlsx' },
			{ original: 'xlsx', saveAs: 'xlsx' },
			async () => {
				// A worker round trip, which fails once the screen has stopped the worker.
				await new Promise((r) => setTimeout(r, 0));
				if (!alive) throw new Error('closed');
				return new TextEncoder().encode(text);
			}
		);
		s.changed();
		timers.splice(0).forEach((f) => f());
		await new Promise((r) => setTimeout(r, 5));
		text = 'two';
		s.changed();
		// As the screens do when leaving: close, then stop the worker.
		const closing = s.close().finally(() => (alive = false));
		release();
		await closing;
		expect(saved).toEqual(['one', 'two']);
		expect(s.status).toBe('saved');
		expect(s.file.version).toBe('v3');
	});
});

describe('a conflict on the first save in a new format', () => {
	it('makes the copy under the new format’s name', async () => {
		const { d } = deps();
		d.save = vi.fn(async () => {
			throw new ApiError(409, 'version_conflict');
		});
		const s = new EditSession(
			d,
			file,
			{ original: 'xls', saveAs: 'xlsx' },
			async () => new Uint8Array([1])
		);
		s.changed();
		await s.flush();
		expect(d.rename).toHaveBeenLastCalledWith({ ...file, name: 'Book.xlsx' }, 'Book.xls');
		expect(d.copy).toHaveBeenCalledWith({ ...file, name: 'Book.xlsx' }, new Uint8Array([1]));
		expect(s.status).toBe('saved');
	});
});
