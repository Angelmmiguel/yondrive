// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import {
	commentMarks,
	commentsKey,
	rangeOf,
	revealComment,
	selectionAnchor,
	showComments,
	textBlocks
} from './comments';

const doc = (...lines: string[]) =>
	schema.node(
		'doc',
		null,
		lines.map((l) => schema.node('paragraph', null, l === '' ? [] : [schema.text(l)]))
	);

function view(...lines: string[]) {
	const picked: string[] = [];
	const v = new EditorView(document.createElement('div'), {
		state: EditorState.create({
			doc: doc(...lines),
			plugins: [commentMarks((id) => picked.push(id))]
		})
	});
	return { v, picked };
}

describe('comments in a long document', () => {
	it('places 2,000 threads without reading the document for each', () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i} says a few words.`);
		const { v } = view(...lines);
		const threads = Array.from({ length: 2000 }, (_, i) => ({
			id: `t${i}`,
			anchor: { kind: 'text' as const, quote: 'a', before: '', after: '', block: i },
			shown: true
		}));
		const started = performance.now();
		const lost = showComments(v, threads, null);
		expect(performance.now() - started).toBeLessThan(3000);
		expect(lost.size).toBe(0);
		expect(commentsKey.getState(v.state)?.ranges).toHaveLength(2000);
	});
});

describe('comments in a document', () => {
	it('anchors a selection and finds it again', () => {
		const { v } = view('Hello world', 'The plan is good.');
		const blocks = textBlocks(v.state.doc);
		expect(blocks.texts).toEqual(['Hello world', 'The plan is good.']);
		// "plan", in the second paragraph: its text starts at 14.
		v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 18, 22)));
		const anchor = selectionAnchor(v.state)!;
		expect(anchor).toMatchObject({ quote: 'plan', block: 1 });
		expect(rangeOf(v.state.doc, anchor)).toEqual({ from: 18, to: 22 });
		expect(rangeOf(doc('Intro', 'Hello world', 'The new plan is good.'), anchor)).toEqual({
			from: 29,
			to: 33
		});
		expect(rangeOf(doc('Nothing here'), anchor)).toBeNull();
	});

	it('highlights with decorations, which leave the document alone', () => {
		const { v } = view('The plan is good.');
		const before = v.state.doc;
		const lost = showComments(
			v,
			[
				{
					id: 't1',
					anchor: { kind: 'text', quote: 'plan', before: 'The ', after: ' is', block: 0 },
					shown: true
				},
				{
					id: 't2',
					anchor: { kind: 'text', quote: 'gone', before: '', after: '', block: 0 },
					shown: true
				}
			],
			null
		);
		expect(lost).toEqual(new Set(['t2']));
		expect(v.state.doc.eq(before)).toBe(true);
		expect(v.dom.querySelector('.comment-mark')?.textContent).toBe('plan');

		// Typing before it moves it along.
		v.dispatch(v.state.tr.insertText('So ', 1));
		expect(commentsKey.getState(v.state)?.ranges).toEqual([{ id: 't1', from: 8, to: 12 }]);
		revealComment(v, 't1');
		expect(v.dom.querySelector('.comment-mark.current')?.textContent).toBe('plan');
	});
});
