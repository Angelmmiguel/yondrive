/**
 * Following the change journal: start at the end of what has happened, then read
 * what happens next. The cursor lives in memory, since on a new page load everything
 * is read fresh anyway. A cursor from before what the server has trimmed has missed
 * something: the feed starts over, and `JournalExpiredError` tells the caller to read
 * the tree again.
 */
import type { Api } from '$lib/api/client';
import { isApiError, type Change, type ChangeOp } from '$lib/api/types';

const PAGE = 1000;

/** The journal no longer reaches back to this feed's cursor. The feed is at its end again. */
export class JournalExpiredError extends Error {
	constructor() {
		super('the journal has been trimmed past this cursor');
		this.name = 'JournalExpiredError';
	}
}

export class ChangeFeed {
	readonly #api: Pick<Api, 'listChanges'>;
	#cursor: string | undefined;

	constructor(api: Pick<Api, 'listChanges'>) {
		this.#api = api;
	}

	/** Skips to the end: what this device is about to read has all of that in it. Returns what it passed. */
	catchUp(): Promise<Change[]> {
		return this.next();
	}

	/** Every change since the last call, or `JournalExpiredError` if some are lost. */
	async next(): Promise<Change[]> {
		try {
			return await this.#read();
		} catch (e) {
			if (!isApiError(e, 'cursor_expired')) throw e;
			this.#cursor = undefined;
			await this.#read();
			throw new JournalExpiredError();
		}
	}

	async #read(): Promise<Change[]> {
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

/** The nodes whose last revocation has no rotation after it, so whose keys are still the old ones. */
export function revokedNotRotated(changes: readonly Change[]): string[] {
	const open = new Set<string>();
	for (const { op, node_id: id } of changes) {
		if (op === 'revoked') open.add(id);
		if (op === 'rotated') open.delete(id);
	}
	return [...open];
}

/** The nodes that changed, in order, each once. */
export function changedNodes(changes: readonly Change[]): string[] {
	return [...new Set(changes.map((change) => change.node_id))];
}
