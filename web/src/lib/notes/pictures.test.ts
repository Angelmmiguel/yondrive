import { describe, expect, it, vi } from 'vitest';
import { readMarkdown, writeMarkdown } from '$lib/formats/markdown';
import type { Block } from '$lib/formats/model';
import { nodeHref } from './parse';
import { PictureNotKeptError, PictureUploads } from './pictures';

const ID = 'a'.repeat(32);

/** A note holding a picture just pasted, by its key in the store. */
function withPicture(key: string): Block[] {
	const { model } = readMarkdown('Before\n\n![tram](x)\n');
	const p = model.blocks[1];
	if (p.type !== 'paragraph' || p.content[0].type !== 'image') throw new Error('no picture');
	p.content[0].image = key;
	return model.blocks;
}

describe('pictures on their way up', () => {
	it('never lets a note be written with a picture that did not go up', async () => {
		let fail = true;
		const upload = vi.fn(async () => {
			if (fail) throw new Error('offline');
			return nodeHref(ID);
		});
		const onfailed = vi.fn();
		const pictures = new PictureUploads({ upload, onkept: () => {}, onfailed });
		const pending = [{ key: 'new:1', alt: 'tram' }];

		pictures.start(pending);
		await pictures.settle();
		expect(onfailed).toHaveBeenCalledTimes(1);
		expect(() => pictures.resolve(withPicture('new:1'))).toThrow(PictureNotKeptError);

		// Typing does not send it again; a save does.
		pictures.start(pending);
		expect(upload).toHaveBeenCalledTimes(1);
		fail = false;
		pictures.start(pending, true);
		await pictures.settle();
		const blocks = pictures.resolve(withPicture('new:1'));
		expect(writeMarkdown({ blocks, images: {} })).toBe(`Before\n\n![tram](${nodeHref(ID)})\n`);
		pictures.start(pending, true);
		expect(upload).toHaveBeenCalledTimes(2);
	});

	it('points a picture at its file when the editor has gone', async () => {
		const onkept = vi.fn();
		const pictures = new PictureUploads({
			upload: async () => nodeHref(ID),
			onkept,
			onfailed: () => {}
		});
		pictures.start([{ key: 'new:2', alt: '' }]);
		await pictures.settle();
		expect(onkept).toHaveBeenCalledWith('new:2', nodeHref(ID));
		// What the screen kept of the document when it closed still says new:2.
		expect(writeMarkdown({ blocks: pictures.resolve(withPicture('new:2')), images: {} })).toContain(
			nodeHref(ID)
		);
	});
});
