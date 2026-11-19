// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import Tooltip, { type TooltipAttrs } from './Tooltip.svelte';

const trigger = createRawSnippet((attrs: () => TooltipAttrs) => ({
	render: () => '<button type="button">XLSX</button>',
	setup: (el: Element) => {
		const a = attrs();
		el.setAttribute('aria-describedby', a['aria-describedby']);
		el.addEventListener('pointerenter', a.onpointerenter);
		el.addEventListener('pointerleave', a.onpointerleave);
		el.addEventListener('focus', a.onfocus);
		el.addEventListener('blur', a.onblur);
		el.addEventListener('click', a.onclick);
		el.addEventListener('keydown', (e) => a.onkeydown(e as KeyboardEvent));
	}
}));

describe('Tooltip', () => {
	it('describes its trigger, even while hidden', () => {
		render(Tooltip, { text: 'Saved back as .xlsx.', trigger });
		const badge = screen.getByRole('button', { name: 'XLSX' });
		const tip = document.getElementById(badge.getAttribute('aria-describedby') ?? '');
		expect(tip?.getAttribute('role')).toBe('tooltip');
		expect(tip?.textContent).toBe('Saved back as .xlsx.');
		expect(tip?.classList.contains('open')).toBe(false);
	});

	it('shows on hover, focus and a tap; leaving, blur and Escape hide it', async () => {
		render(Tooltip, { text: 'Saved back as .xlsx.', trigger });
		const badge = screen.getByRole('button', { name: 'XLSX' });
		const tip = () => document.querySelector('[role=tooltip]') as HTMLElement;
		await fireEvent.pointerEnter(badge);
		expect(tip().classList.contains('open')).toBe(true);
		await fireEvent.pointerLeave(badge);
		expect(tip().classList.contains('open')).toBe(false);
		await fireEvent.focus(badge);
		expect(tip().classList.contains('open')).toBe(true);
		await fireEvent.keyDown(badge, { key: 'Escape' });
		expect(tip().classList.contains('open')).toBe(false);
		await fireEvent.click(badge);
		expect(tip().classList.contains('open')).toBe(true);
		await fireEvent.blur(badge);
		expect(tip().classList.contains('open')).toBe(false);
	});
});
