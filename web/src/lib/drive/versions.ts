/** A file's versions, as the panel shows them. */
import type { Api } from '$lib/api/client';
import type { VersionSummary } from '$lib/api/types';
import type { Sealer } from '$lib/crypto/sealer';
import { newId } from './ids';
import type { DriveTree } from './tree';
import { plaintextSize } from './upload/plan';

export interface VersionDeps {
	api: Pick<Api, 'listVersions' | 'restoreVersion' | 'deleteVersion'>;
	sealer: Sealer;
	tree: Pick<DriveTree, 'refresh' | 'patch'>;
}

export interface VersionEntry {
	id: string;
	current: boolean;
	size: number;
	createdAt: number;
	/** Marked for removal; it can still be restored until `removeAt`. */
	removeAt: number | null;
	restored: boolean;
}

function entry(version: VersionSummary, current: string | null, overhead: number): VersionEntry {
	return {
		id: version.id,
		current: version.id === current,
		size: plaintextSize(version.stored_size, version.frame_count, overhead),
		createdAt: Date.parse(version.created_at),
		removeAt: version.remove_at === undefined ? null : Date.parse(version.remove_at),
		restored: version.content_version_id !== version.id
	};
}

export async function listVersions(
	nodeId: string,
	current: string | null,
	deps: Pick<VersionDeps, 'api' | 'sealer'>
): Promise<VersionEntry[]> {
	const out: VersionEntry[] = [];
	let cursor: string | undefined;
	do {
		const page = await deps.api.listVersions(nodeId, { cursor });
		for (const version of page.versions) {
			out.push(entry(version, current, deps.sealer.frameOverhead));
		}
		cursor = page.next_cursor;
	} while (cursor !== undefined);
	return out;
}

/** Makes an older version current. The size in the metadata follows it. */
export async function restoreVersion(
	nodeId: string,
	version: { id: string; size: number },
	current: string | null,
	deps: VersionDeps
): Promise<void> {
	await deps.api.restoreVersion(nodeId, version.id, {
		version_id: newId(),
		expected_version: current ?? undefined
	});
	await deps.tree.refresh(nodeId);
	await deps.tree.patch(nodeId, { size: version.size });
}

export async function deleteVersion(
	nodeId: string,
	versionId: string,
	deps: Pick<VersionDeps, 'api'>
): Promise<void> {
	await deps.api.deleteVersion(nodeId, versionId);
}
