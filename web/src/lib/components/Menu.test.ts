// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Menu from './Menu.svelte';

const items = [
	{ id: 'docx', label: 'Word document' },
	{ id: 'odt', label: 'OpenDocument' },
	{ id: 'off', label: 'Disabled one', disabled: true },
	{ id: 'md', label: 'Markdown' }
];

function setup() {
	const onselect = vi.fn();
	render(Menu, { label: 'Download as', triggerLabel: 'Download', items, onselect });
	return { onselect, trigger: screen.getByRole('button', { name: 'Download' }) };
}

const active = () => document.activeElement;
const item = (name: string) => screen.getByRole('menuitem', { name });

describe('Menu', () => {
	it('opens from the trigger and exposes its state', async () => {
		const { trigger } = setup();
		expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		await fireEvent.click(trigger);
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByRole('menu', { name: 'Download as' })).toBeTruthy();
	});

	it('focuses the first item on ArrowDown and walks with the arrows, skipping disabled ones', async () => {
		const { trigger } = setup();
		await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
		await waitFor(() => expect(active()).toBe(item('Word document')));
		await fireEvent.keyDown(active()!, { key: 'ArrowDown' });
		expect(active()).toBe(item('OpenDocument'));
		await fireEvent.keyDown(active()!, { key: 'ArrowDown' });
		expect(active()).toBe(item('Markdown'));
		await fireEvent.keyDown(active()!, { key: 'ArrowDown' });
		expect(active()).toBe(item('Word document'));
		await fireEvent.keyDown(active()!, { key: 'ArrowUp' });
		expect(active()).toBe(item('Markdown'));
	});

	it('jumps with Home and End and by typing a letter', async () => {
		const { trigger } = setup();
		await fireEvent.keyDown(trigger, { key: 'Enter' });
		await waitFor(() => expect(active()).toBe(item('Word document')));
		await fireEvent.keyDown(active()!, { key: 'End' });
		expect(active()).toBe(item('Markdown'));
		await fireEvent.keyDown(active()!, { key: 'Home' });
		expect(active()).toBe(item('Word document'));
		await fireEvent.keyDown(active()!, { key: 'o' });
		expect(active()).toBe(item('OpenDocument'));
	});

	it('opens on the last item with ArrowUp', async () => {
		const { trigger } = setup();
		await fireEvent.keyDown(trigger, { key: 'ArrowUp' });
		await waitFor(() => expect(active()).toBe(item('Markdown')));
	});

	it('closes on Escape and returns focus to the trigger', async () => {
		const { trigger } = setup();
		await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
		await waitFor(() => expect(active()).toBe(item('Word document')));
		await fireEvent.keyDown(active()!, { key: 'Escape' });
		expect(screen.queryByRole('menu')).toBeNull();
		expect(active()).toBe(trigger);
	});

	it('closes on Tab without trapping focus', async () => {
		const { trigger } = setup();
		await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
		await waitFor(() => expect(active()).toBe(item('Word document')));
		await fireEvent.keyDown(active()!, { key: 'Tab' });
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('reports the chosen item and closes', async () => {
		const { trigger, onselect } = setup();
		await fireEvent.click(trigger);
		await fireEvent.click(item('Markdown'));
		expect(onselect).toHaveBeenCalledWith('md');
		expect(screen.queryByRole('menu')).toBeNull();
		expect(active()).toBe(trigger);
	});

	it('closes when pressing outside', async () => {
		const { trigger } = setup();
		await fireEvent.click(trigger);
		await fireEvent.pointerDown(document.body);
		expect(screen.queryByRole('menu')).toBeNull();
	});
});
