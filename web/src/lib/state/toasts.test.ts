import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toasts, TOAST_MS } from './toasts.svelte';

describe('toasts', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('go away on their own', () => {
		const toasts = new Toasts();
		toasts.push('ok', 'saved');
		expect(toasts.items.map((t) => t.message)).toEqual(['saved']);
		vi.advanceTimersByTime(TOAST_MS);
		expect(toasts.items).toEqual([]);
	});

	it('stay with a lifetime of 0 until dismissed', () => {
		const toasts = new Toasts();
		const id = toasts.push('danger', 'bad', 0);
		vi.advanceTimersByTime(TOAST_MS * 10);
		expect(toasts.items).toHaveLength(1);
		toasts.dismiss(id);
		expect(toasts.items).toEqual([]);
	});

	it('clear drops everything and its timers', () => {
		const toasts = new Toasts();
		toasts.push('info', 'a');
		toasts.push('info', 'b', 0);
		toasts.clear();
		expect(toasts.items).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
