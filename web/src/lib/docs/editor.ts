/** The ProseMirror view of a document, with everything the editor screen needs. */
import { baseKeymap, chainCommands, joinBackward, selectParentNode } from 'prosemirror-commands';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, type Transaction } from 'prosemirror-state';
import { goToNextCell, tableEditing } from 'prosemirror-tables';
import { EditorView } from 'prosemirror-view';
import type { Caps } from '$lib/formats/document';
import type { Marks } from '$lib/formats/model';
import { backspaceList, enter, insertBreak, shiftLevel, toggleMark } from './commands';
import { commentMarks } from './comments';
import type { ImageStore } from './images';
import { find, imageView, lists, lockedGuard, paste } from './plugins';
import { schema } from './schema';

export interface EditorOptions {
	doc: PMNode;
	caps: () => Caps;
	editable: () => boolean;
	store: ImageStore;
	/** After every transaction, with whether the document changed. */
	onUpdate: (view: EditorView, changed: boolean) => void;
	onBlocked: () => void;
	onImageFailed: (e: unknown) => void;
	onSave: () => void;
	onFind: () => void;
	/** A click in a commented range, with its thread. */
	onComment?: (threadId: string) => void;
}

export function createState(doc: PMNode, o: Omit<EditorOptions, 'doc' | 'onUpdate'>): EditorState {
	const mark =
		(name: keyof typeof schema.marks, cap: keyof Marks = name as keyof Marks) =>
		(state: EditorState, dispatch?: (tr: Transaction) => void) =>
			o.caps().marks.has(cap) && toggleMark(schema.marks[name])(state, dispatch);
	return EditorState.create({
		doc,
		plugins: [
			lockedGuard(o.onBlocked),
			history(),
			keymap({
				'Mod-z': undo,
				'Mod-y': redo,
				'Shift-Mod-z': redo,
				'Mod-b': mark('bold'),
				'Mod-i': mark('italic'),
				'Mod-u': mark('underline'),
				'Mod-.': mark('sup', 'script'),
				'Mod-,': mark('sub', 'script'),
				'Mod-s': () => {
					o.onSave();
					return true;
				},
				'Mod-f': () => {
					o.onFind();
					return true;
				},
				Enter: enter,
				'Shift-Enter': insertBreak,
				Tab: chainCommands(goToNextCell(1), shiftLevel(1)),
				'Shift-Tab': chainCommands(goToNextCell(-1), shiftLevel(-1)),
				Backspace: chainCommands(backspaceList, joinBackward),
				Escape: selectParentNode
			}),
			keymap(baseKeymap),
			gapCursor(),
			tableEditing(),
			lists(o.editable),
			find(),
			commentMarks((id) => o.onComment?.(id)),
			paste(o.caps, o.store, o.onImageFailed)
		]
	});
}

export function createEditor(mount: HTMLElement, o: EditorOptions): EditorView {
	const view: EditorView = new EditorView(mount, {
		state: createState(o.doc, o),
		editable: o.editable,
		nodeViews: { image: imageView(o.store) },
		attributes: {
			spellcheck: 'true',
			class: 'doc-body',
			'aria-label': 'Document',
			role: 'textbox',
			'aria-multiline': 'true'
		},
		dispatchTransaction(tr) {
			const state = view.state.apply(tr);
			view.updateState(state);
			o.onUpdate(view, tr.docChanged);
		},
		handleClickOn(_view, _pos, _node, _nodePos, event) {
			// Links open from view mode, or with Ctrl or Cmd held while editing.
			const a = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
			if (a && (!o.editable() || event.ctrlKey || event.metaKey)) {
				window.open(a.href, '_blank', 'noopener,noreferrer');
				return true;
			}
			return false;
		}
	});
	return view;
}
