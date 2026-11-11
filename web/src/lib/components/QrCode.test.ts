// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { encodeQr } from '$lib/qr/encode';
import QrCode from './QrCode.svelte';

describe('QrCode', () => {
	it('is a named picture of the value, with a quiet zone', () => {
		const value = 'https://drive.example.com/pair#1.abc';
		render(QrCode, { value, label: 'Pairing code' });
		const svg = screen.getByRole('img', { name: 'Pairing code' });
		const side = encodeQr(value).length + 8;
		expect(svg.getAttribute('data-pairing-link')).toBe(value);
		expect(svg.getAttribute('viewBox')).toBe(`0 0 ${side} ${side}`);
		expect(svg.getAttribute('shape-rendering')).toBe('crispEdges');
		expect(svg.style.width).toBe('min(240px, 100%)');
		expect(svg.querySelectorAll('path')).toHaveLength(1);
		const dark = encodeQr(value)
			.flat()
			.filter((d) => d).length;
		expect(svg.querySelector('path')?.getAttribute('d')?.match(/M/g)).toHaveLength(dark);
	});
});
