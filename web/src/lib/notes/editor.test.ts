// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import { toDoc } from '$lib/docs/convert';
import { ImageStore } from '$lib/docs/images';
import { schema } from '$lib/docs/schema';
import { readMarkdown } from '$lib/formats/markdown';
import { createNoteEditor } from './editor';

const PIXEL =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function editor(markdown: string, options: { canAddPictures?: boolean } = {}) {
	const refused = vi.fn();
	const mount = document.createElement('div');
	document.body.append(mount);
	const view = createNoteEditor(mount, {
		doc: toDoc(readMarkdown(markdown).model),
		editable: () => true,
		store: new ImageStore(),
		onUpdate: () => {},
		onSave: () => {},
		onSuggest: () => {},
		onSuggestKey: () => false,
		onOpenNode: () => {},
		kindOf: () => 'note',
		readImage: async () => null,
		onImageFailed: () => {},
		canAddPictures: () => options.canAddPictures ?? true,
		onPictureRefused: refused
	});
	return { view, refused };
}

/** A paste of this HTML, as the browser would hand it over. jsdom has no ClipboardEvent. */
const paste = (view: EditorView, html: string) =>
	view.pasteHTML(html, new Event('paste') as ClipboardEvent);
const images = (view: EditorView) => {
	let count = 0;
	view.state.doc.descendants((n) => {
		if (n.type === schema.nodes.image) count++;
	});
	return count;
};

/** Types at the caret, a key at a time, as the browser hands text to the editor. */
function type(view: EditorView, text: string) {
	for (const ch of text) {
		const { from, to } = view.state.selection;
		const insert = () => view.state.tr.insertText(ch, from, to);
		const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, insert));
		if (!handled) view.dispatch(insert());
	}
}

/** The checklist items of the note, as Markdown would read them. */
function tasks(view: EditorView) {
	const out: { text: string; checked: boolean }[] = [];
	view.state.doc.descendants((n) => {
		const list = n.attrs.list as { kind: string; checked?: boolean } | null | undefined;
		if (n.type === schema.nodes.paragraph && list?.kind === 'check')
			out.push({ text: n.textContent, checked: list.checked === true });
	});
	return out;
}

describe('the note editor', () => {
	it.each([
		['- [ ] ', false],
		['- [x] ', true],
		['* [X] ', true],
		['[ ] ', false],
		['[] ', false],
		['[x] ', true]
	])('makes “%s” at the start of a line a checklist item', (typed, checked) => {
		const { view } = editor('\n');
		type(view, `${typed}Write the schema`);
		expect(tasks(view)).toEqual([{ text: 'Write the schema', checked }]);
		view.destroy();
	});

	it('takes a checklist typed line after line, as Markdown is written', () => {
		const { view } = editor('\n');
		type(view, '- [x] Write the schema');
		view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key: 'Enter' })));
		type(view, '- [ ] Benchmark');
		expect(tasks(view)).toEqual([
			{ text: 'Write the schema', checked: true },
			{ text: 'Benchmark', checked: false }
		]);
		view.destroy();
	});

	it('leaves brackets later in a line as text', () => {
		const { view } = editor('\n');
		type(view, 'a [x] b');
		expect(tasks(view)).toEqual([]);
		expect(view.state.doc.textContent).toBe('a [x] b');
		view.destroy();
	});

	it('refuses a pasted picture where it could not be kept, and keeps the text', () => {
		const { view, refused } = editor('Start\n', { canAddPictures: false });
		paste(view, `<p>Look <img src="${PIXEL}" alt="dot"> here</p>`);
		expect(refused).toHaveBeenCalledTimes(1);
		expect(images(view)).toBe(0);
		expect(view.state.doc.textContent).toContain('Look');
		view.destroy();
	});

	it('takes a pasted picture where it can be kept', () => {
		const { view, refused } = editor('Start\n');
		paste(view, `<p>Look <img src="${PIXEL}" alt="dot"> here</p>`);
		expect(refused).not.toHaveBeenCalled();
		expect(images(view)).toBe(1);
		// Left open: the picture is still being drawn again, after the test.
	});
});
