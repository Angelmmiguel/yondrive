/**
 * Writing a document's bytes as a version of its file, through the same upload
 * path as any file: sealed in frames, signed, and committed on the version it
 * started from. A commit the server refuses with `version_conflict` is the
 * caller's to turn into a copy; nothing here retries over someone else's save.
 */
import { isApiError } from '$lib/api/types';
import { newId } from '$lib/drive/ids';
import { inferType } from '$lib/drive/kinds';
import type { DriveNode, DriveTree } from '$lib/drive/tree';
import { abandonUpload, beginUpload, sendUpload, type EngineDeps } from '$lib/drive/upload/engine';

export interface SaveDeps {
	tree: Pick<
		DriveTree,
		'nodeKey' | 'generationOf' | 'refresh' | 'patch' | 'createFile' | 'findByName'
	>;
	engine: EngineDeps;
	now?: () => number;
}

/** Sends bytes as the next version of a node, on top of `expected` ('' for a new file). */
async function upload(
	deps: SaveDeps,
	nodeId: string,
	name: string,
	bytes: Uint8Array,
	expected: string
): Promise<void> {
	const file = new File([bytes as Uint8Array<ArrayBuffer>], name, {
		type: inferType(name, ''),
		lastModified: deps.now?.() ?? Date.now()
	});
	for (let attempt = 0; ; attempt++) {
		const nodeKey = await deps.tree.nodeKey(nodeId);
		const record = await beginUpload(
			file,
			{
				nodeId,
				nodeKey,
				expected,
				versionId: newId(),
				keyGeneration: deps.tree.generationOf(nodeId)
			},
			deps.engine
		);
		try {
			await sendUpload(file, record, nodeKey, deps.engine);
			return;
		} catch (e) {
			await abandonUpload(record.uploadId, deps.engine);
			// Rotated meanwhile: once more under the new key.
			if (isApiError(e, 'key_generation_conflict') && attempt === 0) {
				await deps.tree.refresh(nodeId);
				continue;
			}
			throw e;
		}
	}
}

/** Saves bytes over the version this editor started from, renaming the file if asked. */
export async function saveVersion(
	deps: SaveDeps,
	node: Pick<DriveNode, 'id' | 'name'>,
	bytes: Uint8Array,
	expected: string
): Promise<DriveNode> {
	await upload(deps, node.id, node.name, bytes, expected);
	await deps.tree.refresh(node.id);
	const now = deps.now?.() ?? Date.now();
	return deps.tree.patch(node.id, {
		size: bytes.length,
		modified: now,
		type: inferType(node.name, '')
	});
}

/** Makes a new file with these bytes, with a name not yet taken in the folder. */
export async function createWith(
	deps: SaveDeps,
	parentId: string,
	name: string,
	bytes: Uint8Array
): Promise<DriveNode> {
	const now = deps.now?.() ?? Date.now();
	let node: DriveNode | undefined;
	for (let n = 1; node === undefined; n++) {
		const candidate = n === 1 ? name : numbered(name, n);
		try {
			node = await deps.tree.createFile(parentId, {
				name: candidate,
				type: inferType(candidate, ''),
				size: bytes.length,
				modified: now
			});
		} catch (e) {
			if (!isApiError(e, 'name_conflict') || n >= 50) throw e;
		}
	}
	await upload(deps, node.id, node.name, bytes, '');
	return (await deps.tree.refresh(node.id)) ?? node;
}

/** `Report.docx` as `Report (2).docx`. */
export function numbered(name: string, n: number): string {
	const at = name.lastIndexOf('.');
	return at > 0 ? `${name.slice(0, at)} (${n})${name.slice(at)}` : `${name} (${n})`;
}

/** The name of the copy a conflicting save becomes. */
export function conflictName(name: string, who: string, when: Date): string {
	const at = name.lastIndexOf('.');
	const pad = (x: number) => String(x).padStart(2, '0');
	const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}.${pad(when.getMinutes())}`;
	const tag = ` (conflicting copy from ${who}, ${stamp})`;
	return at > 0 ? `${name.slice(0, at)}${tag}${name.slice(at)}` : `${name}${tag}`;
}
