/**
 * Comments in the text: where each thread's quote is, drawn as decorations and never
 * as marks, so the document, and the file saved from it, stay as they are. The ranges
 * follow edits as they are made, and are found again from the anchors when the
 * comments are read again.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import {
	findText,
	joinBlocks,
	textAnchor,
	type JoinedText,
	type TextAnchor
} from '$lib/comments/anchor';

/** The text blocks of a document in order, with each character's position. */
export function textBlocks(doc: PMNode): { texts: string[]; positions: number[][] } {
	const texts: string[] = [];
	const positions: number[][] = [];
	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;
		let text = '';
		const at: number[] = [];
		node.forEach((child, offset) => {
			if (child.isText) {
				const t = child.text ?? '';
				for (let i = 0; i < t.length; i++) at.push(pos + 1 + offset + i);
				text += t;
			} else {
				at.push(-1);
				text += '￼';
			}
		});
		texts.push(text);
		positions.push(at);
		return false;
	});
	return { texts, positions };
}

/** The anchor of what is selected, within the block the selection starts in. */
export function selectionAnchor(state: EditorState): TextAnchor | null {
	const { from, to, empty } = state.selection;
	if (empty) return null;
	const { texts, positions } = textBlocks(state.doc);
	for (const [block, at] of positions.entries()) {
		const start = at.findIndex((p) => p >= from);
		if (start < 0 || at[start] >= to) continue;
		let end = start;
		while (end < at.length && at[end] >= 0 && at[end] < to) end++;
		return textAnchor(texts, block, start, end);
	}
	return null;
}

/** A document's text, read once for finding any number of anchors in it. */
export interface DocText {
	texts: string[];
	positions: number[][];
	joined: JoinedText;
}

export function docText(doc: PMNode): DocText {
	const { texts, positions } = textBlocks(doc);
	return { texts, positions, joined: joinBlocks(texts) };
}

/** Where an anchor's quote is in this document, or null when it is no longer found. */
export function rangeOf(
	doc: PMNode,
	anchor: TextAnchor,
	text: DocText = docText(doc)
): { from: number; to: number } | null {
	const { texts, positions, joined } = text;
	const found = findText(texts, anchor, joined);
	if (found === null || found.to <= found.from) return null;
	const at = positions[found.block];
	const from = at[found.from];
	const last = at[found.to - 1];
	if (from < 0 || last < 0) return null;
	return { from, to: last + 1 };
}

export interface CommentRange {
	id: string;
	from: number;
	to: number;
}

interface CommentMarks {
	ranges: CommentRange[];
	selected: string | null;
}

export const commentsKey = new PluginKey<CommentMarks>('comments');

/** Highlights the ranges it is given; a click in one picks its thread. */
export function commentMarks(onpick: (id: string) => void): Plugin<CommentMarks> {
	return new Plugin<CommentMarks>({
		key: commentsKey,
		state: {
			init: () => ({ ranges: [], selected: null }),
			apply(tr, old) {
				const meta = tr.getMeta(commentsKey) as Partial<CommentMarks> | undefined;
				let next = meta ? { ...old, ...meta } : old;
				if (tr.docChanged && !meta?.ranges) {
					next = {
						...next,
						ranges: next.ranges.flatMap((r) => {
							const from = tr.mapping.map(r.from, 1);
							const to = tr.mapping.map(r.to, -1);
							return to > from ? [{ id: r.id, from, to }] : [];
						})
					};
				}
				return next;
			}
		},
		props: {
			decorations(state) {
				const marks = commentsKey.getState(state);
				if (!marks || marks.ranges.length === 0) return null;
				return DecorationSet.create(
					state.doc,
					marks.ranges.map((r) =>
						Decoration.inline(r.from, r.to, {
							class: r.id === marks.selected ? 'comment-mark current' : 'comment-mark',
							'data-comment': r.id
						})
					)
				);
			},
			handleClick(view, pos) {
				const marks = commentsKey.getState(view.state);
				const hit = marks?.ranges.find((r) => pos >= r.from && pos <= r.to);
				if (hit === undefined) return false;
				onpick(hit.id);
				return false;
			}
		}
	});
}

/**
 * Puts the ranges of the threads that are `shown` on the editor, found from their
 * anchors in the document as it is. Returns the threads whose text is no longer found.
 */
export function showComments(
	view: EditorView,
	threads: readonly { id: string; anchor: TextAnchor; shown: boolean }[],
	selected: string | null
): Set<string> {
	const ranges: CommentRange[] = [];
	const lost = new Set<string>();
	const text = docText(view.state.doc);
	for (const t of threads) {
		const range = rangeOf(view.state.doc, t.anchor, text);
		if (range === null) lost.add(t.id);
		else if (t.shown) ranges.push({ id: t.id, ...range });
	}
	view.dispatch(view.state.tr.setMeta(commentsKey, { ranges, selected }));
	return lost;
}

/** Picks a thread in the editor, and brings its range into view. */
export function revealComment(view: EditorView, id: string | null): void {
	const marks = commentsKey.getState(view.state);
	const range = marks?.ranges.find((r) => r.id === id);
	const tr = view.state.tr.setMeta(commentsKey, { selected: id });
	if (range) tr.setSelection(TextSelection.create(tr.doc, range.from)).scrollIntoView();
	view.dispatch(tr);
}
