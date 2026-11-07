/**
 * What the toolbar and the keyboard do to the document. Every command takes
 * ProseMirror's (state, dispatch) form, so the toolbar can ask whether it applies
 * without doing it.
 */
import { toggleMark as pmToggleMark } from 'prosemirror-commands';
import type { Mark, MarkType, Node as PMNode } from 'prosemirror-model';
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import {
	addColumnAfter,
	addRowAfter,
	deleteColumn,
	deleteRow,
	deleteTable,
	isInTable
} from 'prosemirror-tables';
import type { BlockStyle, Callout, ListInfo } from '$lib/formats/model';
import { schema, type ParagraphAttrs } from './schema';

/** Each paragraph the selection touches, outside of locked blocks. */
function paragraphsIn(state: EditorState): { node: PMNode; pos: number }[] {
	const out: { node: PMNode; pos: number }[] = [];
	const { from, to } = state.selection;
	state.doc.nodesBetween(from, to, (node, pos) => {
		if (node.type === schema.nodes.paragraph) {
			out.push({ node, pos });
			return false;
		}
		return node.type !== schema.nodes.locked;
	});
	return out;
}

function setParagraphs(
	state: EditorState,
	dispatch: ((tr: Transaction) => void) | undefined,
	change: (a: ParagraphAttrs) => Partial<ParagraphAttrs>
): boolean {
	const paras = paragraphsIn(state);
	if (paras.length === 0) return false;
	if (dispatch) {
		const tr = state.tr;
		for (const { node, pos } of paras) {
			const attrs = node.attrs as ParagraphAttrs;
			tr.setNodeMarkup(pos, undefined, { ...attrs, ...change(attrs) });
		}
		dispatch(tr.scrollIntoView());
	}
	return true;
}

export const setStyle =
	(style: BlockStyle): Command =>
	(state, dispatch) =>
		setParagraphs(state, dispatch, () => ({ style, callout: null }));

/** Turns the selected paragraphs into a callout, a quote that stands out. */
export const setCallout =
	(callout: Callout = 'note'): Command =>
	(state, dispatch) =>
		setParagraphs(state, dispatch, () => ({ style: 'quote', callout, list: null }));

export const setAlign =
	(align: string | null): Command =>
	(state, dispatch) =>
		setParagraphs(state, dispatch, () => ({ align: align === 'left' ? null : align }));

/** Turns the selected paragraphs into a list of this kind, or out of it if they all are. */
export const toggleList =
	(kind: ListInfo['kind']): Command =>
	(state, dispatch) => {
		const paras = paragraphsIn(state);
		const all =
			paras.length > 0 && paras.every((p) => (p.node.attrs as ParagraphAttrs).list?.kind === kind);
		return setParagraphs(state, dispatch, (a) => ({
			list: all
				? null
				: { kind, level: a.list?.level ?? 0, ...(kind === 'check' ? { checked: false } : {}) },
			style: a.style === 'normal' || all ? a.style : 'normal'
		}));
	};

export const shiftLevel =
	(by: number): Command =>
	(state, dispatch) => {
		const paras = paragraphsIn(state);
		if (paras.length === 0 || paras.some((p) => (p.node.attrs as ParagraphAttrs).list === null))
			return false;
		return setParagraphs(state, dispatch, (a) => ({
			list: a.list ? { ...a.list, level: Math.max(0, Math.min(8, a.list.level + by)) } : null
		}));
	};

export function toggleCheck(pos: number): Command {
	return (state, dispatch) => {
		const node = state.doc.nodeAt(pos);
		const list = node?.attrs.list as ListInfo | null | undefined;
		if (!node || list?.kind !== 'check') return false;
		dispatch?.(
			state.tr.setNodeMarkup(pos, undefined, {
				...node.attrs,
				list: { ...list, checked: !list.checked }
			})
		);
		return true;
	};
}

export const toggleMark = (type: MarkType): Command => pmToggleMark(type);

/** Sets a mark with a value over the selection, or removes it with null. */
export const setMarkValue =
	(type: MarkType, attrs: Record<string, unknown> | null): Command =>
	(state, dispatch) => {
		const { from, to, empty } = state.selection;
		if (dispatch) {
			const tr = state.tr;
			if (empty) {
				if (attrs === null) tr.removeStoredMark(type);
				else tr.addStoredMark(type.create(attrs));
			} else {
				tr.removeMark(from, to, type);
				if (attrs !== null) tr.addMark(from, to, type.create(attrs));
			}
			dispatch(tr.scrollIntoView());
		}
		return true;
	};

/** The value of a mark across the selection, if it is one value. */
export function markValue(state: EditorState, type: MarkType): Mark | null {
	const { from, to, empty, $from } = state.selection;
	if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) ?? null;
	let found: Mark | null | undefined;
	state.doc.nodesBetween(from, to, (node) => {
		if (!node.isText) return true;
		const m = type.isInSet(node.marks) ?? null;
		if (found === undefined) found = m;
		else if (found === null || m === null || !found.eq(m)) found = null;
		return false;
	});
	return found ?? null;
}

export function isMarkActive(state: EditorState, type: MarkType): boolean {
	const { from, to, empty, $from } = state.selection;
	if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
	return state.doc.rangeHasMark(from, to, type);
}

/** The paragraph the selection starts in. */
export function currentParagraph(state: EditorState): ParagraphAttrs | null {
	const $from = state.selection.$from;
	for (let d = $from.depth; d >= 0; d--) {
		const n = $from.node(d);
		if (n.type === schema.nodes.paragraph) return n.attrs as ParagraphAttrs;
	}
	return null;
}

/**
 * Enter: a new paragraph that carries on a list, leaves a heading for body text,
 * and ends a list when its item is empty. In code it starts a new line.
 */
export const enter: Command = (state, dispatch) => {
	const { $from, $to } = state.selection;
	if ($from.parent.type !== schema.nodes.paragraph || !$from.sameParent($to)) return false;
	const a = $from.parent.attrs as ParagraphAttrs;
	const empty = $from.parent.content.size === 0;
	if (a.list && empty) {
		dispatch?.(state.tr.setNodeMarkup($from.before(), undefined, { ...a, list: null }));
		return true;
	}
	if (a.style === 'code') {
		const atEnd = $from.parentOffset === $from.parent.content.size;
		const last = $from.parent.lastChild;
		if (!(atEnd && last?.type === schema.nodes.hard_break)) {
			dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
			return true;
		}
		// A blank line at the end of code ends it.
		if (dispatch) {
			const tr = state.tr.delete($from.pos - 1, $from.pos);
			tr.split(tr.mapping.map($from.pos), 1, [
				{
					type: schema.nodes.paragraph,
					attrs: { style: 'normal', align: null, list: null, ref: null, callout: null }
				}
			]);
			dispatch(tr.scrollIntoView());
		}
		return true;
	}
	if (dispatch) {
		const tr = state.tr;
		if (!state.selection.empty) tr.deleteSelection();
		const atEnd = tr.selection.$from.parentOffset === tr.selection.$from.parent.content.size;
		const heading = /^h\d$|^title$/.test(a.style);
		// A callout is one paragraph, so what follows it is body text.
		const leaves = (heading && atEnd) || a.callout !== null;
		const next: ParagraphAttrs = {
			style: leaves ? 'normal' : a.style,
			align: heading && atEnd ? null : a.align,
			list: a.list ? { ...a.list, ...(a.list.kind === 'check' ? { checked: false } : {}) } : null,
			ref: null,
			callout: null
		};
		tr.split(tr.selection.from, 1, [{ type: schema.nodes.paragraph, attrs: next }]);
		dispatch(tr.scrollIntoView());
	}
	return true;
};

/** Backspace at the start of a list item takes it out of the list first. */
export const backspaceList: Command = (state, dispatch) => {
	const { $from, empty } = state.selection;
	if (!empty || $from.parentOffset !== 0 || $from.parent.type !== schema.nodes.paragraph)
		return false;
	const a = $from.parent.attrs as ParagraphAttrs;
	if (a.list === null) return false;
	dispatch?.(state.tr.setNodeMarkup($from.before(), undefined, { ...a, list: null }));
	return true;
};

export const insertBreak: Command = (state, dispatch) => {
	dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
	return true;
};

export function insertTable(rows = 3, cols = 3): Command {
	return (state, dispatch) => {
		const cell = () => schema.nodes.table_cell.create(null, schema.nodes.paragraph.create());
		const header = () => schema.nodes.table_header.create(null, schema.nodes.paragraph.create());
		const table = schema.nodes.table.create(
			null,
			Array.from({ length: rows }, (_, r) =>
				schema.nodes.table_row.create(
					null,
					Array.from({ length: cols }, () => (r === 0 ? header() : cell()))
				)
			)
		);
		if (dispatch) {
			const tr = state.tr.replaceSelectionWith(table);
			const after = tr.selection.from;
			const inside = tr.doc.resolve(Math.max(0, after - table.nodeSize + 4));
			tr.setSelection(TextSelection.near(inside));
			dispatch(tr.scrollIntoView());
		}
		return true;
	};
}

export function insertImage(
	key: string,
	alt: string,
	width: number | null,
	height: number | null
): Command {
	return (state, dispatch) => {
		dispatch?.(
			state.tr
				.replaceSelectionWith(schema.nodes.image.create({ key, alt, width, height }))
				.scrollIntoView()
		);
		return true;
	};
}

export const tableCommands = {
	addRowAfter,
	addColumnAfter,
	deleteRow,
	deleteColumn,
	deleteTable,
	isInTable
};
