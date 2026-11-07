/**
 * The editor's behaviour beyond the schema: locked blocks that cannot be
 * removed, list numbers and check boxes, find highlights, pictures drawn from
 * the image store, and pastes reduced to what the file's format can hold.
 */
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type NodeView } from 'prosemirror-view';
import type { Caps } from '$lib/formats/document';
import type { ListInfo, Marks } from '$lib/formats/model';
import { toggleCheck } from './commands';
import { findAll, type Match } from './find';
import { dataUrlToBlob, redraw, type ImageStore } from './images';
import { schema, type ParagraphAttrs } from './schema';

/** The refs of locked blocks, which no edit may remove or add. */
function lockedRefs(doc: PMNode): string {
	const refs: number[] = [];
	doc.forEach((n) => {
		if (n.type === schema.nodes.locked) refs.push(n.attrs.ref as number);
	});
	return refs.join(',');
}

export function lockedGuard(onBlocked: () => void): Plugin {
	return new Plugin({
		filterTransaction(tr, state) {
			if (!tr.docChanged) return true;
			if (lockedRefs(tr.doc) === lockedRefs(state.doc)) return true;
			onBlocked();
			return false;
		}
	});
}

const ROMAN = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

function label(n: number, level: number): string {
	switch (level % 3) {
		case 1: {
			let s = '';
			for (let x = n; x > 0; x = Math.floor((x - 1) / 26))
				s = String.fromCharCode(97 + ((x - 1) % 26)) + s;
			return `${s}.`;
		}
		case 2:
			return `${ROMAN[n] ?? n}.`;
		default:
			return `${n}.`;
	}
}

function listDecorations(doc: PMNode, editable: () => boolean): DecorationSet {
	const decos: Decoration[] = [];
	let counters: number[] = [];
	let kinds: (ListInfo['kind'] | undefined)[] = [];
	doc.forEach((node, pos) => {
		const list = node.type === schema.nodes.paragraph ? (node.attrs as ParagraphAttrs).list : null;
		if (list === null) {
			counters = [];
			kinds = [];
			return;
		}
		const lvl = list.level;
		counters.length = lvl + 1;
		kinds.length = lvl + 1;
		if (kinds[lvl] !== list.kind) counters[lvl] = 0;
		kinds[lvl] = list.kind;
		counters[lvl] = (counters[lvl] ?? 0) + 1;
		if (list.kind === 'number') {
			decos.push(
				Decoration.node(pos, pos + node.nodeSize, { 'data-n': label(counters[lvl], lvl) })
			);
		} else if (list.kind === 'check') {
			const checked = list.checked === true;
			decos.push(
				Decoration.widget(
					pos + 1,
					(view, getPos) => {
						const box = document.createElement('button');
						box.type = 'button';
						box.className = 'check-box';
						box.contentEditable = 'false';
						box.setAttribute('role', 'checkbox');
						box.setAttribute('aria-checked', String(checked));
						box.setAttribute('aria-label', checked ? 'Done' : 'Not done');
						box.tabIndex = -1;
						box.addEventListener('mousedown', (e) => {
							e.preventDefault();
							const at = getPos();
							if (!editable() || at === undefined) return;
							toggleCheck(at - 1)(view.state, view.dispatch);
						});
						return box;
					},
					{
						side: -1,
						key: `check-${checked}-${editable()}`,
						ignoreSelection: true,
						stopEvent: () => true
					}
				)
			);
		}
	});
	return DecorationSet.create(doc, decos);
}

export function lists(editable: () => boolean): Plugin {
	const key = new PluginKey<DecorationSet>('lists');
	return new Plugin({
		key,
		state: {
			init: (_, s) => listDecorations(s.doc, editable),
			apply: (tr, old, _o, s) =>
				tr.docChanged || tr.getMeta(key) ? listDecorations(s.doc, editable) : old
		},
		props: { decorations: (s) => key.getState(s) }
	});
}

export interface FindState {
	query: string;
	matches: Match[];
	current: number;
}

export const findKey = new PluginKey<FindState>('find');

export function find(): Plugin<FindState> {
	return new Plugin<FindState>({
		key: findKey,
		state: {
			init: () => ({ query: '', matches: [], current: 0 }),
			apply(tr, old) {
				const meta = tr.getMeta(findKey) as Partial<FindState> | undefined;
				const query = meta?.query ?? old.query;
				if (!meta && !tr.docChanged) return old;
				const matches = findAll(tr.doc, query);
				const current = Math.min(meta?.current ?? old.current, Math.max(0, matches.length - 1));
				return { query, matches, current };
			}
		},
		props: {
			decorations(state) {
				const f = findKey.getState(state);
				if (!f || f.matches.length === 0) return null;
				return DecorationSet.create(
					state.doc,
					f.matches.map((m, i) =>
						Decoration.inline(m.from, m.to, {
							class: i === f.current ? 'find-hit current' : 'find-hit'
						})
					)
				);
			}
		}
	});
}

/** Pictures: drawn from the store, or a placeholder for what is not drawn. */
export function imageView(store: ImageStore) {
	return (node: PMNode): NodeView => {
		const url = node.attrs.pending ? null : store.url(node.attrs.key as string);
		let dom: HTMLElement;
		if (url) {
			const img = document.createElement('img');
			img.src = url;
			img.alt = node.attrs.alt as string;
			img.draggable = false;
			if (node.attrs.width) img.style.width = `${Number(node.attrs.width)}px`;
			if (node.attrs.width && node.attrs.height)
				img.style.aspectRatio = `${Number(node.attrs.width)} / ${Number(node.attrs.height)}`;
			dom = img;
		} else {
			dom = document.createElement('span');
			dom.className = 'image-placeholder';
			const key = node.attrs.key as string;
			dom.textContent = node.attrs.pending
				? 'Adding picture…'
				: /^(remote:|https?:)/.test(key) || !store.get(key)
					? `Picture not loaded${node.attrs.alt ? `: ${String(node.attrs.alt)}` : ''}`
					: `Picture not shown here${node.attrs.alt ? `: ${String(node.attrs.alt)}` : ''}`;
		}
		return { dom };
	};
}

const MARK_NAMES: Record<string, keyof Marks> = {
	link: 'link',
	bold: 'bold',
	italic: 'italic',
	underline: 'underline',
	strike: 'strike',
	code: 'code',
	font: 'font',
	size: 'size',
	color: 'color',
	highlight: 'highlight'
};

/** A pasted slice reduced to what this format can hold, with no ties to any source. */
function clean(fragment: Fragment, caps: Caps): Fragment {
	const out: PMNode[] = [];
	fragment.forEach((node) => {
		if (node.type === schema.nodes.locked) {
			// A copy of something locked is its text, never a second locked block.
			const text = String(node.attrs.text ?? '');
			out.push(schema.nodes.paragraph.create(null, text ? schema.text(text) : null));
			return;
		}
		if (node.isText) {
			const marks = node.marks.filter((m) => caps.marks.has(MARK_NAMES[m.type.name]));
			out.push(node.mark(marks));
			return;
		}
		if (node.type === schema.nodes.image && !caps.images) return;
		if (node.type === schema.nodes.table && !caps.tables) {
			node.descendants((d) => {
				if (d.type === schema.nodes.paragraph) out.push(...clean(Fragment.from(d), caps).content);
				return d.type !== schema.nodes.paragraph;
			});
			return;
		}
		let attrs = node.attrs;
		if ('ref' in attrs) attrs = { ...attrs, ref: null };
		if (node.type === schema.nodes.paragraph) {
			const a = attrs as ParagraphAttrs;
			attrs = {
				...a,
				style: caps.styles.has(a.style) ? a.style : 'normal',
				align: caps.align ? a.align : null,
				list: caps.lists ? a.list : null
			};
		}
		const marks = node.marks.filter((m) => caps.marks.has(MARK_NAMES[m.type.name]));
		out.push(node.type.create(attrs, clean(node.content, caps), marks));
	});
	return Fragment.fromArray(out);
}

/** Strips what a paste must not bring: pictures from elsewhere, and list markup's wrappers. */
export function cleanPastedHtml(html: string): string {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	for (const img of [...doc.querySelectorAll('img')]) {
		if (!/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(img.getAttribute('src') ?? ''))
			img.remove();
	}
	for (const el of [
		...doc.querySelectorAll(
			'script, style, iframe, object, embed, link, meta, svg, video, audio, source, picture'
		)
	]) {
		el.remove();
	}
	for (const p of [...doc.querySelectorAll('li > p')]) {
		p.replaceWith(...p.childNodes);
	}
	return doc.body.innerHTML;
}

export function paste(
	caps: () => Caps,
	store: ImageStore,
	onImageFailed: (e: unknown) => void
): Plugin {
	const working = new Set<string>();
	return new Plugin({
		props: {
			transformPastedHTML: cleanPastedHtml,
			transformPasted: (slice) =>
				new Slice(clean(slice.content, caps()), slice.openStart, slice.openEnd)
		},
		view: () => ({
			update(view) {
				// Pictures that came with a paste are drawn again before they are kept.
				view.state.doc.descendants((node) => {
					if (node.type !== schema.nodes.image || !node.attrs.pending) return true;
					const src = node.attrs.pending as string;
					if (working.has(src)) return false;
					working.add(src);
					void (async () => {
						let tr: Transaction;
						try {
							const img = await redraw(await dataUrlToBlob(src));
							const key = store.add(img);
							const at = findPending(view.state, src);
							if (at < 0) return;
							tr = view.state.tr.setNodeMarkup(at, undefined, {
								...node.attrs,
								key,
								pending: null,
								width: node.attrs.width ?? img.width,
								height: node.attrs.height ?? (node.attrs.width ? null : img.height)
							});
						} catch (e) {
							onImageFailed(e);
							const at = findPending(view.state, src);
							if (at < 0) return;
							tr = view.state.tr.delete(at, at + 1);
						}
						view.dispatch(tr.setMeta('addToHistory', false));
					})().finally(() => working.delete(src));
					// Only one at a time per pass: the next update picks up the rest.
					return false;
				});
			}
		})
	});
}

function findPending(state: EditorState, src: string): number {
	let at = -1;
	state.doc.descendants((node, pos) => {
		if (at >= 0) return false;
		if (node.type === schema.nodes.image && node.attrs.pending === src) at = pos;
		return true;
	});
	return at;
}
