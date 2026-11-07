/**
 * Which editor a file opens in, from its name: the spreadsheet editor for
 * workbooks and delimited text, the document editor for documents, or none.
 */
import { formatOf } from '$lib/formats/document';
import { sheetFormatOf } from '$lib/formats/spreadsheet';

export type EditorKind = 'doc' | 'sheet';

export function editorFor(name: string): EditorKind | null {
	if (sheetFormatOf(name) !== null) return 'sheet';
	if (formatOf(name) !== null) return 'doc';
	return null;
}

/** The address of a file in its editor. */
export const editorPath = (kind: EditorKind, id: string) => `/${kind}/${id}` as const;
