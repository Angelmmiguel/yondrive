import { describe, expect, it } from 'vitest';
import { paragraph, text, type Block } from '$lib/formats/model';
import { countWords } from './words';

describe('countWords', () => {
	it('counts the words of paragraphs, tables and locked blocks, but not bare punctuation', () => {
		const blocks: Block[] = [
			paragraph([text('The plan is '), text('bold', { bold: true }), text(' — and clear.')]),
			{
				type: 'table',
				rows: [{ cells: [{ content: [paragraph([text('one two')])] }] }]
			},
			{ type: 'locked', label: 'Equation', text: 'x = 1', ref: 0 }
		];
		expect(countWords(blocks)).toBe(6 + 2 + 2);
		expect(countWords([])).toBe(0);
		expect(countWords([paragraph([text('  \n ')])])).toBe(0);
	});
});
