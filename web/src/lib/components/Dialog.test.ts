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

	it('does not take the focus back from what has it since', async () => {
		const trigger = opener();
		const view = render(Dialog, { open: true, title: 'Viewer', children: body });
		await waitFor(() => expect(document.activeElement).not.toBe(trigger));

		// Another overlay's field has the focus when this one goes.
		const field = document.createElement('input');
		document.body.appendChild(field);
		field.focus();
		await view.rerender({ open: false });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(document.activeElement).toBe(field);
	});

	it('keeps the focus of the dialog opened as another closes', async () => {
		const trigger = opener();
		const first = render(Dialog, { open: true, title: 'Viewer', children: body });
		await waitFor(() => expect(document.activeElement).not.toBe(trigger));
		const second = render(Dialog, { open: false, title: 'Search', children: body });

		// The palette opens on the same keystroke that sees the viewer closed.
		await first.rerender({ open: false });
		await second.rerender({ open: true });
		await waitFor(() =>
			expect(screen.getByRole('dialog', { name: 'Search' }).contains(document.activeElement)).toBe(
				true
			)
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.getByRole('dialog', { name: 'Search' }).contains(document.activeElement)).toBe(
			true
		);
	});

	it('takes the focus back when the page resets it, as a navigation does', async () => {
		render(Dialog, { open: true, title: 'Search', children: body });
		const input = screen.getByLabelText('Name');
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
		);
		input.focus();

		document.body.tabIndex = -1;
		document.body.focus();
		document.body.removeAttribute('tabindex');
		expect(document.activeElement).toBe(input);
	});

	it('leaves the focus alone when it goes to another dialog on top', async () => {
		render(Dialog, { open: true, title: 'Under', children: body });
		await waitFor(() => expect(document.activeElement).not.toBe(document.body));
		render(Dialog, { open: true, title: 'Over', children: body });
		const over = await screen.findByRole('dialog', { name: 'Over' });
		await waitFor(() => expect(over.contains(document.activeElement)).toBe(true));

		document.body.tabIndex = -1;
		document.body.focus();
		document.body.removeAttribute('tabindex');
		expect(over.contains(document.activeElement)).toBe(true);
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
