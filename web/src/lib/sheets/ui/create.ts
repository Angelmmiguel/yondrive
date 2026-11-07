/** A new, empty spreadsheet: a one-sheet `.xlsx` written by the worker, uploaded like any file. */
import type { DriveNode } from '$lib/drive/tree';
import { createWith, type SaveDeps } from '$lib/editing/save';
import { createSheets } from '../client';

export const NEW_SHEET_NAME = 'Untitled spreadsheet.xlsx';

/** The bytes of an empty workbook with one sheet. */
export async function emptyWorkbook(): Promise<Uint8Array> {
	const sheets = createSheets();
	try {
		await sheets.api.load(new Uint8Array(0), 'csv');
		return (await sheets.api.save('xlsx')).bytes;
	} finally {
		sheets.stop();
	}
}

export async function createSpreadsheet(
	deps: SaveDeps,
	parentId: string,
	name = NEW_SHEET_NAME
): Promise<DriveNode> {
	return createWith(deps, parentId, name, await emptyWorkbook());
}
