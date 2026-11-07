import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLLAPSE_AFTER_MS, REMOVE_AFTER_MS, UploadPanelState } from './panel.svelte';
import type { UploadItem, UploadStatus } from './queue';

const item = (id: number, status: UploadStatus): UploadItem =>
	({ id, name: `f${id}`, size: 1, done: 1, status }) as UploadItem;

describe('the upload panel state', () => {
	const remove = vi.fn();
	let panel: UploadPanelState;

	beforeEach(() => {
		vi.useFakeTimers();
		remove.mockClear();
		panel = new UploadPanelState(remove);
	});
	afterEach(() => {
		panel.dispose();
		vi.useRealTimers();
	});

	it('needs no room while the queue is empty', () => {
		panel.sync([]);
		expect(panel.room).toBe('none');
	});

	it('stays open while anything moves', () => {
		panel.sync([item(1, 'done'), item(2, 'uploading')]);
		vi.advanceTimersByTime(COLLAPSE_AFTER_MS * 3);
		expect(panel.phase).toBe('open');
		expect(panel.room).toBe('panel');
	});

	it('folds into a pill after a few seconds, then leaves', () => {
		panel.sync([item(1, 'done'), item(2, 'done')]);
		vi.advanceTimersByTime(COLLAPSE_AFTER_MS - 1);
		expect(panel.phase).toBe('open');
		vi.advanceTimersByTime(1);
		expect(panel.phase).toBe('pill');
		expect(panel.room).toBe('pill');
		expect(panel.count).toBe(2);
		expect(remove).not.toHaveBeenCalled();
		vi.advanceTimersByTime(REMOVE_AFTER_MS);
		expect(remove).toHaveBeenCalledOnce();
	});

	it('does not restart the countdown on every sync', () => {
		const items = [item(1, 'done')];
		panel.sync(items);
		vi.advanceTimersByTime(COLLAPSE_AFTER_MS - 100);
		panel.sync([...items]);
		vi.advanceTimersByTime(100);
		expect(panel.phase).toBe('pill');
	});

	it('keeps a failure open', () => {
		panel.sync([item(1, 'done'), item(2, 'failed')]);
		vi.advanceTimersByTime(COLLAPSE_AFTER_MS * 5);
		expect(panel.phase).toBe('open');
		expect(remove).not.toHaveBeenCalled();
	});

	it('opens again when new uploads begin, and cancels the removal', () => {
		panel.sync([item(1, 'done')]);
		vi.advanceTimersByTime(COLLAPSE_AFTER_MS);
		expect(panel.phase).toBe('pill');
		panel.sync([item(1, 'done'), item(2, 'uploading')]);
		expect(panel.phase).toBe('open');
		vi.advanceTimersByTime(REMOVE_AFTER_MS * 2);
		expect(remove).not.toHaveBeenCalled();
	});

	it('stays open once the person expands the pill', () => {
		panel.sync([item(1, 'done')]);
		vi.advanceTimersByTime(COLLAPSE_AFTER_MS);
		panel.expand();
		panel.sync([item(1, 'done')]);
		vi.advanceTimersByTime(COLLAPSE_AFTER_MS * 5);
		expect(panel.phase).toBe('open');
		expect(remove).not.toHaveBeenCalled();
	});

	it('does not remove after Clear empties the queue', () => {
		panel.sync([item(1, 'done')]);
		vi.advanceTimersByTime(COLLAPSE_AFTER_MS);
		panel.sync([]);
		expect(panel.room).toBe('none');
		vi.advanceTimersByTime(REMOVE_AFTER_MS * 2);
		expect(remove).not.toHaveBeenCalled();
	});

	it('does not fold a queue of only cancelled uploads', () => {
		panel.sync([item(1, 'cancelled')]);
		vi.advanceTimersByTime(COLLAPSE_AFTER_MS * 2);
		expect(panel.phase).toBe('open');
	});
});
