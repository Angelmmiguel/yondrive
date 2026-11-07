import { describe, expect, it } from 'vitest';
import { editorFor, editorPath } from './editors';

describe('which editor opens a file', () => {
	it('goes by the name', () => {
		expect(editorFor('Budget.xlsx')).toBe('sheet');
		expect(editorFor('old.XLS')).toBe('sheet');
		expect(editorFor('data.csv')).toBe('sheet');
		expect(editorFor('table.tsv')).toBe('sheet');
		expect(editorFor('calc.ods')).toBe('sheet');
		expect(editorFor('Report.docx')).toBe('doc');
		expect(editorFor('notes.md')).toBe('doc');
		expect(editorFor('photo.png')).toBeNull();
		expect(editorPath('sheet', 'n1')).toBe('/sheet/n1');
	});
});
