// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Switch from './Switch.svelte';

describe('Switch', () => {
	it('is a named switch that reflects its state', () => {
		render(Switch, { label: 'Allow sign-up', checked: true });
		const control = screen.getByRole('switch', { name: 'Allow sign-up' });
		expect(control.getAttribute('aria-checked')).toBe('true');
	});

	it('toggles on click and reports the new value', async () => {
		const onchange = vi.fn();
		render(Switch, { label: 'Allow sign-up', onchange });
		const control = screen.getByRole('switch');
		expect(control.getAttribute('aria-checked')).toBe('false');
		await fireEvent.click(control);
		expect(control.getAttribute('aria-checked')).toBe('true');
		await fireEvent.click(control);
		expect(control.getAttribute('aria-checked')).toBe('false');
		expect(onchange.mock.calls).toEqual([[true], [false]]);
	});

	it('does nothing while disabled', async () => {
		const onchange = vi.fn();
		render(Switch, { label: 'Locked', disabled: true, onchange });
		await fireEvent.click(screen.getByRole('switch'));
		expect(onchange).not.toHaveBeenCalled();
	});
});
