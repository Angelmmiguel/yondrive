/**
 * What an editor's session does with the drive: save a version, make the copy a
 * conflict becomes, rename for a change of format, or make a converted file
 * beside the original. Each saved file is handed to search, which indexes it on
 * the device.
 */
import { canChangePlace, canWrite } from '$lib/sharing/roles';
import { drive } from '$lib/state/drive.svelte';
import { search } from '$lib/state/search.svelte';
import { session as account } from '$lib/state/session.svelte';
import { conflictName, createWith, saveVersion, type SaveDeps } from './save';
import type { EditSessionDeps, SessionFile } from './session';

function saveDeps(): SaveDeps {
	const core = drive.core;
	if (core === null) throw new Error('locked');
	return { tree: core.tree, engine: core.engine };
}

/** Where a new file goes: next to this one if this user may write there, or My files. */
function folderFor(file: SessionFile): string {
	const here = drive.node(file.id);
	const parent = here?.parentId == null ? undefined : drive.node(here.parentId);
	if (parent !== undefined && canWrite(parent)) return parent.id;
	return drive.rootId as string;
}

const indexed = (id: string, bytes: Uint8Array) =>
	search.fileCommitted(id, new Blob([bytes as Uint8Array<ArrayBuffer>]));

export function driveFiles(): Pick<EditSessionDeps, 'save' | 'copy' | 'rename' | 'create'> {
	return {
		save: async (file, out) => {
			const saved = await saveVersion(saveDeps(), file, out, file.version);
			indexed(saved.node.id, out);
			return saved.version;
		},
		copy: async (file, out) => {
			const who = account.account?.user.username ?? 'me';
			const made = await createWith(
				saveDeps(),
				folderFor(file),
				conflictName(file.name, who, new Date()),
				out
			);
			indexed(made.id, out);
			return { id: made.id, name: made.name, version: made.currentVersion ?? '' };
		},
		rename: async (file, name) => {
			const here = drive.node(file.id);
			const parent = here?.parentId == null ? undefined : drive.node(here.parentId);
			if (here === undefined || !canChangePlace(here, parent)) return false;
			try {
				await drive.core?.tree.rename(file.id, name);
				return true;
			} catch {
				return false;
			}
		},
		create: async (file, name, out) => {
			const made = await createWith(saveDeps(), folderFor(file), name, out);
			return { id: made.id, name: made.name, version: made.currentVersion ?? '' };
		}
	};
}
