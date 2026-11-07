/**
 * From what a browser hands over to files and the folders they sit in: an input's
 * file list, with or without `webkitdirectory`, or the items of a drop.
 */
export interface PickedFile {
	file: File;
	path: string[];
}

export interface Picked {
	files: PickedFile[];
	/** Folders, each as its path, so that empty ones get made too. */
	folders: string[][];
}

/** The folders of a relative path such as `Top/Sub/file.txt`. */
export function foldersOf(relativePath: string): string[] {
	return relativePath.split('/').slice(0, -1).filter(Boolean);
}

/** What an `<input type=file>` holds. */
export function fromInput(files: Iterable<File>): Picked {
	const picked: PickedFile[] = [];
	for (const file of files) {
		picked.push({ file, path: foldersOf(file.webkitRelativePath) });
	}
	return { files: picked, folders: [] };
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
	return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
	return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, path: string[], out: Picked): Promise<void> {
	if (entry.isFile) {
		out.files.push({ file: await fileOf(entry as FileSystemFileEntry), path });
		return;
	}
	const inner = [...path, entry.name];
	out.folders.push(inner);
	const reader = (entry as FileSystemDirectoryEntry).createReader();
	// A directory reader gives a batch at a time, until it gives none.
	for (;;) {
		const batch = await readEntries(reader);
		if (batch.length === 0) return;
		for (const child of batch) await walk(child, inner, out);
	}
}

/**
 * What was dropped. The entries have to be taken before the first wait, because
 * the browser empties the transfer when the event ends.
 */
export async function fromDrop(transfer: DataTransfer): Promise<Picked> {
	const out: Picked = { files: [], folders: [] };
	const items = [...transfer.items]
		.filter((item) => item.kind === 'file')
		.map((item) => ({ entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() }));
	for (const { entry, file } of items) {
		if (entry !== null) await walk(entry, [], out);
		else if (file !== null) out.files.push({ file, path: [] });
	}
	return out;
}
