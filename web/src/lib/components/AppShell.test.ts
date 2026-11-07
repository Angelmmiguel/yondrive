// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { expect, it } from 'vitest';
import AppShell from './AppShell.svelte';

const html = (markup: string) => createRawSnippet(() => ({ render: () => markup }));

function shell() {
	return render(AppShell, {
		rail: html('<nav><a href="/x">Rail link</a></nav>'),
		sidebar: html('<aside>Side</aside>'),
		top: html('<header>Top</header>'),
		children: html('<p>Page</p>')
	});
}

it('opens with the menu button and closes on Escape, a link and the scrim', async () => {
	shell();
	const opener = screen.getByRole('button', { name: 'Menu' });
	expect(opener.getAttribute('aria-expanded')).toBe('false');

	await fireEvent.click(opener);
	expect(opener.getAttribute('aria-expanded')).toBe('true');
	await fireEvent.keyDown(window, { key: 'Escape' });
	expect(opener.getAttribute('aria-expanded')).toBe('false');

	await fireEvent.click(opener);
	await fireEvent.click(screen.getByText('Rail link'));
	expect(opener.getAttribute('aria-expanded')).toBe('false');

	await fireEvent.click(opener);
	await fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
	expect(opener.getAttribute('aria-expanded')).toBe('false');
});
