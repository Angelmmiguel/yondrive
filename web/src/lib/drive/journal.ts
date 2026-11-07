/**
 * Following the change journal: start at the end of what has happened, then read
 * what happens next. The cursor lives in memory, since on a new page load everything
 * is read fresh anyway.
 */
import type { Api } from '$lib/api/client';
import type { Change, ChangeOp } from '$lib/api/types';

const PAGE = 1000;

export class ChangeFeed {
	readonly #api: Pick<Api, 'listChanges'>;
	#cursor: string | undefined;

	constructor(api: Pick<Api, 'listChanges'>) {
		this.#api = api;
	}

	/** Skips to the end: what this device is about to read has all of that in it. */
	async catchUp(): Promise<void> {
		await this.next();
	}

	/** Every change since the last call. */
	async next(): Promise<Change[]> {
		const changes: Change[] = [];
		for (;;) {
			const page = await this.#api.listChanges({ cursor: this.#cursor, limit: PAGE });
			changes.push(...page.changes);
			this.#cursor = page.next_cursor;
			if (page.changes.length < PAGE) return changes;
		}
	}
}

/** Beyond this many nodes it is cheaper to read the folders again. */
export const REFRESH_ONE_BY_ONE = 100;

/** The nodes one of these operations touched, in order, each once. */
export function nodesChangedBy(changes: readonly Change[], ...ops: ChangeOp[]): string[] {
	return changedNodes(changes.filter((change) => ops.includes(change.op)));
}

/** The nodes that changed, in order, each once. */
export function changedNodes(changes: readonly Change[]): string[] {
	return [...new Set(changes.map((change) => change.node_id))];
}
