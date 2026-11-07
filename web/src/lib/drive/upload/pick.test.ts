import { describe, expect, it } from 'vitest';
import { foldersOf, fromInput } from './pick';

describe('picking', () => {
	it.each([
		['', []],
		['file.txt', []],
		['Top/file.txt', ['Top']],
		['Top/Sub/file.txt', ['Top', 'Sub']]
	])('finds the folders of "%s"', (path, folders) => {
		expect(foldersOf(path)).toEqual(folders);
	});

	it('keeps the path of each file of an input', () => {
		const file = new File(['x'], 'a.txt');
		Object.defineProperty(file, 'webkitRelativePath', { value: 'Top/a.txt' });
		expect(fromInput([file]).files).toEqual([{ file, path: ['Top'] }]);
	});
});
