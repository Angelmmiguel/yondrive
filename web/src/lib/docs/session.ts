/**
 * One open document: what it was opened from, and getting edits saved through
 * the shared edit session. Each save writes into the bytes that were opened, so
 * what was not edited stays as it was.
 */
import { EditSession, type EditSessionDeps } from '$lib/editing/session';
import { saveFormatOf, type DocFormat, type SaveFormat } from '$lib/formats/document';
import type { Block, DocModel } from '$lib/formats/model';
import type { Formats } from './formats-client';
import type { ImageStore } from './images';

export type { SaveStatus, SessionFile } from '$lib/editing/session';

export interface SessionDeps extends EditSessionDeps {
	formats: Pick<Formats, 'write'>;
	/** The document's blocks as the editor has them now. */
	blocks(): Block[];
	images: ImageStore;
}

/** Every image key a set of blocks refers to. */
export function imageKeys(blocks: readonly Block[]): Set<string> {
	const keys = new Set<string>();
	const walk = (bs: readonly Block[]) => {
		for (const b of bs) {
			if (b.type === 'paragraph') {
				for (const i of b.content) if (i.type === 'image') keys.add(i.image);
			} else if (b.type === 'table')
				for (const r of b.rows) for (const c of r.cells) walk(c.content);
		}
	};
	walk(blocks);
	return keys;
}

export class DocSession extends EditSession<SaveFormat> {
	constructor(
		deps: SessionDeps,
		file: { id: string; name: string; version: string },
		original: { bytes: Uint8Array; format: DocFormat }
	) {
		super(deps, file, { original: original.format, saveAs: saveFormatOf(original.format) }, (f) => {
			const blocks = deps.blocks();
			const model: DocModel = { blocks, images: deps.images.pick(imageKeys(blocks)) };
			return deps.formats.write(f, model, original);
		});
	}
}
