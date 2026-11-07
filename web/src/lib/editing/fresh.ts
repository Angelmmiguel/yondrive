/**
 * Files this tab just made with New document or New sheet. Their editor opens
 * without the notice about the file's format: the person did not bring the
 * file, so there is nothing to tell them about how it is kept.
 */
const made = new Set<string>();

/** A file was just made empty, to be opened in an editor. */
export function markNew(id: string): void {
	made.add(id);
}

/** Whether a file was just made, answered once: a later opening is an ordinary one. */
export function takeNew(id: string): boolean {
	return made.delete(id);
}
