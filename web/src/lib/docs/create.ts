/** A new, empty document: a minimal valid `.docx`, uploaded like any file. */
import { writeDocument } from '$lib/formats/document';
import type { DriveNode } from '$lib/drive/tree';
import { markNew } from '$lib/editing/fresh';
import { createWith, type SaveDeps } from '$lib/editing/save';

export const NEW_DOCUMENT_NAME = 'Untitled document.docx';

export async function createDocument(
	deps: SaveDeps,
	parentId: string,
	name = NEW_DOCUMENT_NAME
): Promise<DriveNode> {
	const bytes = await writeDocument('docx', {
		blocks: [{ type: 'paragraph', style: 'normal', content: [] }],
		images: {}
	});
	const made = await createWith(deps, parentId, name, bytes);
	markNew(made.id);
	return made;
}
