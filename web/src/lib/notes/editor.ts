/**
 * The note editor: the document editor's ProseMirror setup and schema, with what
 * notes add. Typing `/` at the start of a word, or `[[`, opens a menu the screen
 * draws; Markdown shortcuts at the start of a line set a block; links to notes and
 * files draw as chips and open in the app; pictures named by id are read from the
 * drive and never fetched from anywhere else; `#tags` and due dates stand out.
 */
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import {
	Plugin,
	PluginKey,
	TextSelection,
	type Command,
	type EditorState,
	type Transaction
} from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView, type NodeView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { CAPS, type Caps } from '$lib/formats/document';
import { createState } from '$lib/docs/editor';
import { setStyle, toggleList, toggleMark } from '$lib/docs/commands';
import type { ImageStore } from '$lib/docs/images';
import { schema, type ParagraphAttrs } from '$lib/docs/schema';
import { dayKey } from './model';
import { NODE_HREF, nodeHref } from './parse';

/** What a note can hold: Markdown's, with pictures, which notes keep as files. */
export const NOTE_CAPS: Caps = { ...CAPS.md, images: true };

export type SuggestKind = 'slash' | 'link';

export interface Suggest {
	kind: SuggestKind;
	/** Where the trigger starts and the caret is. */
	from: number;
	to: number;
	query: string;
}

const suggestKey = new PluginKey<Suggest | null>('suggest');

/** The menu the caret is in, if any. */
export function suggestAt(state: EditorState): Suggest | null {
	const { selection } = state;
	if (!selection.empty) return null;
	const $from = selection.$from;
	const parent = $from.parent;
	if (parent.type !== schema.nodes.paragraph || (parent.attrs as ParagraphAttrs).style === 'code')
		return null;
	const before = parent.textBetween(0, $from.parentOffset, undefined, '￼');
	const link = /\[\[([^\]\n￼]{0,60})$/.exec(before);
	if (link) {
		return {
			kind: 'link',
			from: $from.pos - link[1].length - 2,
			to: $from.pos,
			query: link[1]
		};
	}
	const slash = /(?:^|\s)\/([\p{L}\p{N} ]{0,24})$/u.exec(before);
	if (slash && !/\s{2}|^\s/.test(slash[1])) {
		return {
			kind: 'slash',
			from: $from.pos - slash[1].length - 1,
			to: $from.pos,
			query: slash[1]
		};
	}
	return null;
}

/**
 * Tells the screen where a menu is, and lets it take the keys a menu uses. The
 * screen answers `onkey` with whether it took the key.
 */
export function suggestPlugin(
	onchange: (s: Suggest | null) => void,
	onkey: (key: string) => boolean
): Plugin {
	let dismissed: number | null = null;
	return new Plugin<Suggest | null>({
		key: suggestKey,
		state: {
			init: () => null,
			apply: (tr, _old, _o, state) => {
				const s = suggestAt(state);
				if (s === null) dismissed = null;
				return s !== null && s.from === dismissed ? null : s;
			}
		},
		view: () => ({
			update(view, prev) {
				const now = suggestKey.getState(view.state) ?? null;
				const before = suggestKey.getState(prev) ?? null;
				if (JSON.stringify(now) !== JSON.stringify(before)) onchange(now);
			}
		}),
		props: {
			handleKeyDown(view, event) {
				const s = suggestKey.getState(view.state);
				if (!s) return false;
				if (event.key === 'Escape') {
					dismissed = s.from;
					view.dispatch(view.state.tr.setMeta(suggestKey, 'dismiss'));
					onchange(null);
					return true;
				}
				if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) return onkey(event.key);
				return false;
			}
		}
	});
}

/** Replaces the trigger and what was typed after it, then runs a command on the block. */
export function runSlash(view: EditorView, s: Suggest, command: Command | null): void {
	const tr = view.state.tr.delete(s.from, s.to);
	view.dispatch(tr);
	if (command) command(view.state, view.dispatch);
	view.focus();
}

/** Replaces `[[query` with a link to a node, named by its title. */
export function insertNodeLink(view: EditorView, s: Suggest, id: string, title: string): void {
	const mark = schema.marks.link.create({ href: nodeHref(id) });
	const tr = view.state.tr.replaceWith(s.from, s.to, schema.text(title, [mark]));
	const after = s.from + title.length;
	tr.setSelection(TextSelection.create(tr.doc, after)).removeStoredMark(schema.marks.link);
	tr.insertText(' ', after);
	view.dispatch(tr.scrollIntoView());
	view.focus();
}

/** Inserts a link to a node at the caret, or over the selection. */
export function linkNode(view: EditorView, id: string, title: string): void {
	const mark = schema.marks.link.create({ href: nodeHref(id) });
	const { from, to, empty } = view.state.selection;
	const tr = empty
		? view.state.tr.insertText(title, from).addMark(from, from + title.length, mark)
		: view.state.tr.addMark(from, to, mark);
	tr.removeStoredMark(schema.marks.link);
	view.dispatch(tr.scrollIntoView());
	view.focus();
}

/** Markdown typed at the start of a line, then a space: the block it means. */
const SHORTCUTS: [RegExp, Command][] = [
	[/^#$/, setStyle('h1')],
	[/^##$/, setStyle('h2')],
	[/^###$/, setStyle('h3')],
	[/^[-*]$/, toggleList('bullet')],
	[/^1[.)]$/, toggleList('number')],
	[/^>$/, setStyle('quote')],
	[/^```$/, setStyle('code')]
];

/**
 * A checklist item as Markdown writes it, ticked with an `x`: `[ ] `, `[x] ` or
 * `- [ ] ` at the start of any line or list item. Typed on a bullet, which `- `
 * has already made, or on the next item of a checklist, it sets that item.
 */
const CHECK = /^(?:[-*]\s)?\[([ xX]?)\]$/;

function shortcuts(): Plugin {
	return new Plugin({
		props: {
			handleTextInput(view, from, to, text) {
				if (text !== ' ' || to !== from) return false;
				const $from = view.state.doc.resolve(from);
				const para = $from.parent;
				if (para.type !== schema.nodes.paragraph) return false;
				const a = para.attrs as ParagraphAttrs;
				if (a.style !== 'normal') return false;
				const before = para.textBetween(0, $from.parentOffset, undefined, '￼');
				const box = CHECK.exec(before);
				if (box) {
					const checked = box[1].toLowerCase() === 'x';
					const list = { kind: 'check' as const, level: a.list?.level ?? 0, checked };
					const tr = view.state.tr.delete(from - before.length, from);
					view.dispatch(tr.setNodeMarkup($from.before(), undefined, { ...a, list }));
					return true;
				}
				if (a.list !== null) return false;
				const found = SHORTCUTS.find(([re]) => re.test(before));
				if (!found) return false;
				view.dispatch(view.state.tr.delete(from - before.length, from));
				return found[1](view.state, view.dispatch);
			}
		}
	});
}

export type LinkKind = 'note' | 'file' | 'missing';

const TAG = /(^|[\s(])(#[\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;
const DUE = /\s(@\d{4}-\d{2}-\d{2})\s*$/;

/** Chips for links by kind, `#tags`, and due dates on tasks, coloured by how near they are. */
function decorations(doc: PMNode, kindOf: (id: string) => LinkKind, today: string): DecorationSet {
	const decos: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (node.isText) {
			const link = node.marks.find((m) => m.type === schema.marks.link);
			const id = link ? NODE_HREF.exec(link.attrs.href as string)?.[1] : undefined;
			if (id !== undefined) {
				decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: `chip-${kindOf(id)}` }));
			} else if (!node.marks.some((m) => m.type === schema.marks.code)) {
				for (const m of (node.text ?? '').matchAll(TAG)) {
					if (!/\p{L}/u.test(m[2])) continue;
					const start = pos + (m.index ?? 0) + m[1].length;
					decos.push(Decoration.inline(start, start + m[2].length, { class: 'hashtag' }));
				}
			}
			return false;
		}
		if (node.type === schema.nodes.paragraph) {
			const a = node.attrs as ParagraphAttrs;
			if (a.style === 'code') return false;
			if (a.list?.kind === 'check') {
				const text = node.textContent;
				const m = DUE.exec(text);
				if (m && !a.list.checked) {
					const day = m[1].slice(1);
					const when = day < today ? 'overdue' : day === today ? 'today' : 'later';
					let offset = 0;
					// Text positions inside the paragraph, skipping what is not text.
					const at = text.length - m[0].length + m[0].indexOf('@');
					node.forEach((child, childOffset) => {
						if (child.isText && offset <= at && at < offset + (child.text?.length ?? 0)) {
							const start = pos + 1 + childOffset + (at - offset);
							decos.push(
								Decoration.inline(start, start + m[1].length, { class: `due due-${when}` })
							);
						}
						offset += child.isText ? (child.text?.length ?? 0) : 1;
					});
				}
			}
		}
		return true;
	});
	return DecorationSet.create(doc, decos);
}

const decorationsKey = new PluginKey<DecorationSet>('note-decorations');

function noteDecorations(kindOf: (id: string) => LinkKind): Plugin {
	const key = decorationsKey;
	const today = () => dayKey(new Date());
	return new Plugin({
		key,
		state: {
			init: (_, s) => decorations(s.doc, kindOf, today()),
			apply: (tr, old, _o, s) =>
				tr.docChanged || tr.getMeta(key) ? decorations(s.doc, kindOf, today()) : old
		},
		props: { decorations: (s) => key.getState(s) }
	});
}

/** Draws a picture of the drive, read by id; a picture just pasted, from the store. */
export function noteImageView(store: ImageStore, read: (id: string) => Promise<string | null>) {
	return (node: PMNode): NodeView => {
		const key = node.attrs.key as string;
		const alt = node.attrs.alt as string;
		const id = NODE_HREF.exec(key)?.[1];
		const local = node.attrs.pending ? null : store.url(key);
		// One element that stays, whose contents change as the picture arrives.
		const dom = document.createElement('span');
		dom.className = 'note-image';
		const say = (text: string) => {
			const span = document.createElement('span');
			span.className = 'image-placeholder';
			span.textContent = text;
			dom.replaceChildren(span);
		};
		const show = (url: string) => {
			const img = document.createElement('img');
			img.alt = alt;
			img.draggable = false;
			if (node.attrs.width) img.style.width = `${Number(node.attrs.width)}px`;
			img.src = url;
			dom.replaceChildren(img);
		};
		if (local) show(local);
		else if (id === undefined) {
			// Anything else, an address on the web included, is never fetched.
			say(`Picture not loaded${alt ? `: ${alt}` : ''}`);
		} else {
			say('Loading picture…');
			void read(id).then(
				(url) => (url === null ? say(`Picture not available${alt ? `: ${alt}` : ''}`) : show(url)),
				() => say(`Picture not available${alt ? `: ${alt}` : ''}`)
			);
		}
		return { dom, ignoreMutation: () => true };
	};
}

/** A fragment without the pictures a paste brings as data. */
function withoutNewPictures(fragment: Fragment): Fragment {
	const out: PMNode[] = [];
	fragment.forEach((node) => {
		if (node.type === schema.nodes.image && node.attrs.pending) return;
		out.push(node.isLeaf ? node : node.copy(withoutNewPictures(node.content)));
	});
	return Fragment.fromArray(out);
}

/**
 * Pictures pasted or dropped into a note that has nowhere to keep them, such as
 * a note shared on its own: they are left out and `refuse` says so, rather than
 * shown in a note that would be saved without them.
 */
export function pictureGuard(canAdd: () => boolean, refuse: () => void): Plugin {
	return new Plugin({
		props: {
			transformPasted(slice) {
				if (canAdd()) return slice;
				let found = false;
				slice.content.descendants((node) => {
					if (node.type === schema.nodes.image && node.attrs.pending) found = true;
					return !found;
				});
				if (!found) return slice;
				refuse();
				return new Slice(withoutNewPictures(slice.content), slice.openStart, slice.openEnd);
			}
		}
	});
}

export interface NoteEditorOptions {
	doc: PMNode;
	editable: () => boolean;
	store: ImageStore;
	onUpdate: (view: EditorView, changed: boolean) => void;
	onSave: () => void;
	onSuggest: (s: Suggest | null) => void;
	onSuggestKey: (key: string) => boolean;
	/** A link to a note or a file was clicked. */
	onOpenNode: (id: string) => void;
	kindOf: (id: string) => LinkKind;
	readImage: (id: string) => Promise<string | null>;
	onImageFailed: (e: unknown) => void;
	/** A click in a commented range, with its thread. */
	onComment?: (threadId: string) => void;
	/** Whether the note has a folder to keep new pictures in. */
	canAddPictures: () => boolean;
	/** A picture was pasted or dropped where it cannot be kept. */
	onPictureRefused: () => void;
}

export function createNoteEditor(mount: HTMLElement, o: NoteEditorOptions): EditorView {
	const base = createState(o.doc, {
		caps: () => NOTE_CAPS,
		editable: o.editable,
		store: o.store,
		onBlocked: () => {},
		onImageFailed: o.onImageFailed,
		onSave: o.onSave,
		onFind: () => {},
		onComment: o.onComment
	});
	const state = base.reconfigure({
		plugins: [
			pictureGuard(o.canAddPictures, o.onPictureRefused),
			suggestPlugin(o.onSuggest, o.onSuggestKey),
			shortcuts(),
			keymap({
				'Mod-Shift-x': toggleMark(schema.marks.strike),
				'Mod-e': toggleMark(schema.marks.code)
			}),
			noteDecorations(o.kindOf),
			...base.plugins
		]
	});
	const view: EditorView = new EditorView(mount, {
		state,
		editable: o.editable,
		nodeViews: { image: noteImageView(o.store, o.readImage) },
		attributes: {
			spellcheck: 'true',
			class: 'doc-body note-body',
			'aria-label': 'Note',
			role: 'textbox',
			'aria-multiline': 'true'
		},
		dispatchTransaction(tr: Transaction) {
			view.updateState(view.state.apply(tr));
			o.onUpdate(view, tr.docChanged);
		},
		handleClickOn(_view, _pos, _node, _nodePos, event) {
			const target = event.target as HTMLElement;
			const chip = target.closest('a.node-link') as HTMLElement | null;
			if (chip?.dataset.node) {
				o.onOpenNode(chip.dataset.node);
				return true;
			}
			const a = target.closest('a[href]') as HTMLAnchorElement | null;
			if (a && (!o.editable() || event.ctrlKey || event.metaKey)) {
				window.open(a.href, '_blank', 'noopener,noreferrer');
				return true;
			}
			return false;
		}
	});
	return view;
}

/** Redraws the chips, as when a linked note was renamed or a file arrived. */
export function refreshDecorations(view: EditorView): void {
	view.dispatch(view.state.tr.setMeta(decorationsKey, true).setMeta('addToHistory', false));
}

/** Every picture just added, by its key in the store. */
export function pendingImages(doc: PMNode): { key: string; alt: string }[] {
	const out: { key: string; alt: string }[] = [];
	doc.descendants((node) => {
		if (node.type === schema.nodes.image && String(node.attrs.key).startsWith('new:'))
			out.push({ key: node.attrs.key as string, alt: node.attrs.alt as string });
		return true;
	});
	return out;
}

/** Points every picture with a store key at the file it became. */
export function replaceImageKey(view: EditorView, from: string, to: string): void {
	const tr = view.state.tr;
	view.state.doc.descendants((node, pos) => {
		if (node.type === schema.nodes.image && node.attrs.key === from)
			tr.setNodeMarkup(pos, undefined, { ...node.attrs, key: to });
		return true;
	});
	if (tr.docChanged) view.dispatch(tr.setMeta('addToHistory', false));
}

/** Plain body text: the paragraph at the caret out of any heading, list or callout. */
export const setText: Command = (state, dispatch) => {
	const $from = state.selection.$from;
	if ($from.parent.type !== schema.nodes.paragraph) return false;
	const a = $from.parent.attrs as ParagraphAttrs;
	dispatch?.(
		state.tr.setNodeMarkup($from.before(), undefined, {
			...a,
			style: 'normal',
			list: null,
			callout: null
		})
	);
	return true;
};
