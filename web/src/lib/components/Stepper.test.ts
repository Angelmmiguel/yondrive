// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Stepper from './Stepper.svelte';

const steps = [
	{ id: 'server', label: 'Server' },
	{ id: 'encryption', label: 'Encryption' },
	{ id: 'admin', label: 'Administrator' }
];

const step = (name: string) => screen.getByRole('button', { name: new RegExp(name) });

describe('Stepper', () => {
	it('marks the current step and shows a check on the finished ones', () => {
		render(Stepper, { steps, current: 'encryption' });
		expect(step('Encryption').getAttribute('aria-current')).toBe('step');
		expect(step('Server').getAttribute('aria-current')).toBeNull();
		expect(step('Server').textContent).toContain('Done');
		expect(step('Administrator').textContent).toContain('3');
	});

	it('goes back to a finished step', async () => {
		const onselect = vi.fn();
		render(Stepper, { steps, current: 'admin', onselect });
		await fireEvent.click(step('Server'));
		expect(onselect).toHaveBeenCalledWith('server');
	});

	it('keeps later steps locked until reached', async () => {
		const onselect = vi.fn();
		render(Stepper, { steps, current: 'server', onselect });
		const later = step('Administrator');
		expect(later.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(later);
		await fireEvent.click(step('Server'));
		expect(onselect).not.toHaveBeenCalled();
	});

	it('lets the user jump anywhere when free', async () => {
		const onselect = vi.fn();
		render(Stepper, { steps, current: 'server', free: true, onselect });
		await fireEvent.click(step('Administrator'));
		expect(onselect).toHaveBeenCalledWith('admin');
	});
});
