/**
 * Spreadsheets in search: each sheet's name and its cells as shown (formulas by
 * their values), read on the device in a worker of their own, through the search
 * plug-in point. The format of `.xlsx`, `.ods` and `.xls` is told from the bytes;
 * CSV and TSV are plain text and need nothing here.
 */
import { registerExtractor } from '$lib/search/extract';
import { sheetFormatOf, sniffSheetFormat } from '$lib/formats/names';
import { createSheets } from './client';
import type { Remote } from './rpc';
import type { SheetService } from './service';

const BINARY = new Set(['xlsx', 'ods', 'xls']);

export function registerSheetText(
	sheets: () => Pick<Remote<SheetService>, 'text'> = lazy()
): () => void {
	return registerExtractor({
		accepts: (_type, file) => BINARY.has(sheetFormatOf(file.name) ?? ''),
		async extract(blob) {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const format = sniffSheetFormat(bytes);
			if (format === null) return '';
			return sheets().text(bytes, format);
		}
	});
}

/** One worker for search, started on first use. */
function lazy(): () => Pick<Remote<SheetService>, 'text'> {
	let api: Remote<SheetService> | null = null;
	return () => (api ??= createSheets().api);
}
