/** Search wired to one `Drive`: the tree is what the index follows, and where text comes from. */
import type { Api } from '$lib/api/client';
import type { Sealer } from '$lib/crypto/sealer';
import type { Drive } from '$lib/drive/drive';
import type { SegmentCache } from './cache';
import type { IndexClient } from './engine';
import { TEXT_LIMIT } from './extract';
import { SearchService, type SearchDeps, type SearchStatus } from './service';
import { docOf, reachableDocs } from './snapshot';

export interface SearchOfDrive {
	api: SearchDeps['api'] & Pick<Api, 'listIndexBlobs'>;
	sealer: Pick<Sealer, 'suite'>;
	cache: SegmentCache;
	index: IndexClient;
	userId: string;
	onstatus?: (status: SearchStatus) => void;
	reconcileMs?: number;
	flushMs?: number;
	pause?: () => Promise<void>;
}

export function searchOfDrive(core: Drive, deps: SearchOfDrive): SearchService {
	return new SearchService({
		...deps,
		settle: (signal) => core.walkEverything(signal),
		snapshot: () => reachableDocs(core.tree, core.sharedTops(), deps.userId),
		docOf(id) {
			const node = core.tree.nodes.get(id);
			return node === undefined ? undefined : docOf(node, core.tree.tags, deps.userId);
		},
		async read(id) {
			const node = await core.tree.resolve(id);
			if (node.currentVersion === null) return null;
			return core.readBlob(node, await core.openVersion(node), { limit: TEXT_LIMIT });
		}
	});
}
