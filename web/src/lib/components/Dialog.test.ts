// @vitest-environment jsdom
import { createRawSnippet } from 'svelte';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dialog from './Dialog.svelte';

const body = createRawSnippet(() => ({
	render: () => '<div><button>First</button><input aria-label="Name" /><button>Last</button></div>'
}));

function opener() {
	const button = document.createElement('button');
	button.textContent = 'Open';
	document.body.appendChild(button);
	button.focus();
	return button;
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('Dialog', () => {
	it('is a labelled modal and moves focus to its first control', async () => {
		render(Dialog, { open: true, title: 'Delete', description: 'Sure?', children: body });
		const dialog = screen.getByRole('dialog', { name: 'Delete' });
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
		);
	});

	it('wraps Tab and Shift+Tab inside the dialog', async () => {
		render(Dialog, { open: true, title: 'Delete', children: body });
		const dialog = screen.getByRole('dialog');
		const close = screen.getByRole('button', { name: 'Close' });
		const last = screen.getByRole('button', { name: 'Last' });
		await waitFor(() => expect(document.activeElement).toBe(close));

		await fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(last);

		const notPrevented = await fireEvent.keyDown(last, { key: 'Tab' });
		expect(notPrevented).toBe(false);
		expect(document.activeElement).toBe(close);
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it('closes on Escape and gives focus back to the opener', async () => {
		const trigger = opener();
		const onclose = vi.fn();
		render(Dialog, { open: true, title: 'Delete', onclose, children: body });
		await waitFor(() => expect(document.activeElement).not.toBe(trigger));

		await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		expect(onclose).toHaveBeenCalledOnce();
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(document.activeElement).toBe(trigger);
	});

	it('ignores Escape and the backdrop when it must be answered', async () => {
		const onclose = vi.fn();
		render(Dialog, { open: true, title: 'Confirm', dismissible: false, onclose, children: body });
		await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		await fireEvent.click(screen.getByRole('dialog').parentElement!);
		expect(onclose).not.toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
	});

	it('renders nothing while closed', () => {
		render(Dialog, { open: false, title: 'Delete', children: body });
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});
