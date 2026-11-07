/** Find and replace over the editable text of a document. */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';

export interface Match {
	from: number;
	to: number;
}

/** Every match of `query` in the document's text, case-insensitively, in order. */
export function findAll(doc: PMNode, query: string, caseSensitive = false): Match[] {
	if (query === '') return [];
	const needle = caseSensitive ? query : query.toLowerCase();
	const out: Match[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name === 'locked') return false;
		if (!node.isTextblock) return true;
		// The text of the block, with each character's position in the document.
		let text = '';
		const positions: number[] = [];
		node.forEach((child, offset) => {
			if (child.isText) {
				for (let i = 0; i < (child.text ?? '').length; i++) positions.push(pos + 1 + offset + i);
				text += child.text;
			} else {
				positions.push(-1);
				text += '￼';
			}
		});
		const hay = caseSensitive ? text : text.toLowerCase();
		let at = hay.indexOf(needle);
		while (at >= 0) {
			const from = positions[at];
			const last = positions[at + needle.length - 1];
			if (from >= 0 && last >= 0 && last - from === needle.length - 1)
				out.push({ from, to: last + 1 });
			at = hay.indexOf(needle, at + Math.max(1, needle.length));
		}
		return false;
	});
	return out;
}

/** Replaces the given matches, last first so that earlier positions stay valid. */
export function replaceMatches(
	state: EditorState,
	matches: readonly Match[],
	text: string
): Transaction {
	const tr = state.tr;
	for (const m of [...matches].sort((a, b) => b.from - a.from)) {
		const marks = state.doc.resolve(m.from).marksAcross(state.doc.resolve(m.to)) ?? [];
		if (text === '') tr.delete(m.from, m.to);
		else tr.replaceWith(m.from, m.to, state.schema.text(text, marks));
	}
	return tr;
}
