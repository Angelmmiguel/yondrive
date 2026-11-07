import { describe, expect, it } from 'vitest';
import type { DriveNode } from '$lib/drive/tree';
import { NotesIndex } from './index';
import { buildItems, exportName, matchedIds, notesSubtree } from './items';
import { analyze } from './parse';

const node = (id: string, over: Partial<DriveNode> = {}) =>
	({ id, kind: 'file', name: `${id}.md`, raw: {}, ...over }) as DriveNode;

describe('notes items', () => {
	it('builds items with tags and attachments counted', () => {
		const index = new NotesIndex();
		index.set('a', 'v', analyze('About #travel\n'));
		const children: Record<string, DriveNode[]> = {
			root: [node('pic', { name: 'p.png', raw: { attachment: { note: 'a' } } })]
		};
		const items = buildItems(
			{ childrenOf: (id: string) => children[id] ?? [] },
			['root'],
			[{ node: node('a', { raw: { note: { tags: ['work'] } } }), notebook: null }],
			[{ node: node('b'), notebook: null }],
			index
		);
		expect(items.map((i) => [i.id, i.title, i.tags, i.attachments, i.shared])).toEqual([
			['a', 'a', ['work', 'travel'], 1, false],
			['b', 'b', [], 0, true]
		]);
		expect([...matchedIds(items, 'B', ['a', 'zzz'])].sort()).toEqual(['a', 'b']);
	});

	it('finds the folder of notes and all under it', () => {
		const tree = {
			rootId: 'r',
			childrenOf: (id: string): DriveNode[] =>
				({
					r: [node('n', { kind: 'folder', raw: { app: 'notes' } }), node('f', { kind: 'folder' })],
					n: [node('nb', { kind: 'folder' })],
					nb: [node('x')]
				})[id] ?? []
		};
		expect([...notesSubtree(tree)].sort()).toEqual(['n', 'nb', 'x']);
		expect(exportName(new Date(2026, 10, 7).getTime())).toBe('Notes 2026-11-07.zip');
	});
});
