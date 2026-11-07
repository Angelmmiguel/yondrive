// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';
import CodeBlock from './CodeBlock.svelte';

const KEY = 'YOND-7Q2M-K9XF';

function clipboard(value: unknown) {
	Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

function execCommand(value: unknown) {
	Object.defineProperty(document, 'execCommand', { value, configurable: true });
}

afterEach(() => {
	clipboard(undefined);
	execCommand(undefined);
	vi.restoreAllMocks();
});

describe('copyText', () => {
	it('uses the Clipboard API when present', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		clipboard({ writeText });
		expect(await copyText('x')).toBe('copied');
		expect(writeText).toHaveBeenCalledWith('x');
	});

	it('falls back to execCommand when the API is missing or refuses', async () => {
		const exec = vi.fn().mockReturnValue(true);
		execCommand(exec);
		expect(await copyText('x')).toBe('copied');

		clipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
		expect(await copyText('y')).toBe('copied');
		expect(exec).toHaveBeenCalledTimes(2);
		expect(document.querySelector('textarea')).toBeNull();
	});

	it('reports manual when nothing can copy', async () => {
		expect(await copyText('x')).toBe('manual');
		execCommand(vi.fn().mockReturnValue(false));
		expect(await copyText('x')).toBe('manual');
	});
});

describe('CodeBlock', () => {
	it('shows Copied after a successful copy', async () => {
		clipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
		render(CodeBlock, { code: KEY, variant: 'key', label: 'recovery key' });
		await fireEvent.click(screen.getByRole('button', { name: 'Copy recovery key' }));
		await waitFor(() => expect(screen.getByRole('button').textContent?.trim()).toBe('Copied'));
		expect(screen.getByRole('status').textContent).toContain('Copied');
	});

	it('selects the text and asks for a manual copy when the Clipboard API is missing', async () => {
		render(CodeBlock, { code: KEY });
		await fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
		await waitFor(() =>
			expect(screen.getByRole('button').textContent?.trim()).toBe('Press Ctrl+C')
		);
		expect(window.getSelection()?.toString()).toBe(KEY);
		expect(screen.getByRole('status').textContent).toContain('Press Ctrl+C');
	});
});
