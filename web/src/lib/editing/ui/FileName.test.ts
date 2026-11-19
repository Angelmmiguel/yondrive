// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import FileName from './FileName.svelte';

const field = () => screen.getByRole('textbox', { name: 'File name' }) as HTMLInputElement;

describe('FileName', () => {
	it('is the heading, and only a button for whoever may rename', () => {
		const { unmount } = render(FileName, {
			name: 'Budget.xlsx',
			canRename: false,
			onrename: vi.fn()
		});
		expect(screen.getByRole('heading', { name: 'Budget.xlsx' })).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();
		unmount();
		render(FileName, { name: 'Budget.xlsx', canRename: true, onrename: vi.fn() });
		expect(screen.getByRole('heading', { name: 'Budget.xlsx' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Rename Budget.xlsx' })).toBeTruthy();
	});

	it('edits in place: Enter saves, and the name before the extension is selected', async () => {
		const onrename = vi.fn(async () => null);
		render(FileName, { name: 'Budget.xlsx', canRename: true, onrename });
		await fireEvent.click(screen.getByRole('button', { name: /Rename/ }));
		await tick();
		expect(field().value).toBe('Budget.xlsx');
		expect([field().selectionStart, field().selectionEnd]).toEqual([0, 6]);
		await fireEvent.input(field(), { target: { value: 'Plan.xlsx' } });
		await fireEvent.keyDown(field(), { key: 'Enter' });
		await vi.waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
		expect(onrename).toHaveBeenCalledWith('Plan.xlsx');
	});

	it('keeps the field open with the reason when the name is refused', async () => {
		const onrename = vi.fn(async () => 'Type a name.');
		render(FileName, { name: 'Budget.xlsx', canRename: true, onrename });
		await fireEvent.click(screen.getByRole('button', { name: /Rename/ }));
		await tick();
		await fireEvent.input(field(), { target: { value: '' } });
		await fireEvent.blur(field());
		await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Type a name.'));
		expect(field().getAttribute('aria-invalid')).toBe('true');
		expect(field().getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
	});

	it('Escape puts the old name back, and an unchanged name saves nothing', async () => {
		const onrename = vi.fn(async () => null);
		render(FileName, { name: 'Budget.xlsx', canRename: true, onrename });
		await fireEvent.click(screen.getByRole('button', { name: /Rename/ }));
		await tick();
		await fireEvent.input(field(), { target: { value: 'Other.xlsx' } });
		await fireEvent.keyDown(field(), { key: 'Escape' });
		await tick();
		expect(screen.queryByRole('textbox')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: /Rename/ }));
		await tick();
		await fireEvent.keyDown(field(), { key: 'Enter' });
		await tick();
		expect(onrename).not.toHaveBeenCalled();
	});
});
