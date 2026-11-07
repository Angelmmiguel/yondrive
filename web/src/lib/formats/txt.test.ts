import { describe, expect, it } from 'vitest';
import { readText, writeText } from './txt';
import type { Paragraph } from './model';

const enc = new TextEncoder();

describe('txt', () => {
	it('keeps line endings, the BOM and unchanged lines', () => {
		const src = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('one\r\n\r\nthree\r\n')]);
		const { model } = readText(src);
		expect(model.blocks.length).toBe(3);
		expect(writeText(model, src)).toEqual(src);
		(model.blocks[2] as Paragraph).content = [{ type: 'text', text: 'THREE', marks: {} }];
		expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(writeText(model, src))).toBe(
			'﻿one\r\n\r\nTHREE\r\n'
		);
	});

	it('reads another encoding and says it saves as UTF-8', () => {
		const { model, census } = readText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
		expect((model.blocks[0] as Paragraph).content[0]).toMatchObject({ text: 'café' });
		expect(census.items[0].handling).toBe('changed');
	});
});
