/**
 * The comments of the file a screen has open: its threads, verified, and what
 * writing to them does. The code that opens and seals comments is loaded with the
 * first file that asks for it, not with the shell. Each change reads the threads
 * again, so what shows is what the server holds and what checked.
 */
import type { Anchor } from '$lib/comments/anchor';
import type { CommentDeps, CommentView, Thread } from '$lib/comments/comments';
import { sharing } from './sharing.svelte';

const logic = () => import('$lib/comments/comments');

export class FileCommentsState {
	threads = $state.raw<Thread[]>([]);
	/** Comments that did not open or check, and are not shown. */
	refused = $state(0);
	phase = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
	/** Why the last read failed. */
	error = $state<unknown>(null);
	busy = $state(false);

	readonly nodeId: string;
	readonly #deps: () => CommentDeps | null;
	readonly #seen: (() => void) | undefined;
	#reads = 0;

	/** `seen` is told each time the threads have been read and shown. */
	constructor(nodeId: string, deps: () => CommentDeps | null, seen?: () => void) {
		this.nodeId = nodeId;
		this.#deps = deps;
		this.#seen = seen;
	}

	/** Threads that are not resolved, in order. */
	get open(): Thread[] {
		return this.threads.filter((t) => !t.resolved);
	}

	/** Reads the threads again. A read that a newer one overtakes changes nothing. */
	async load(): Promise<void> {
		const deps = this.#deps();
		if (deps === null) return;
		const read = ++this.#reads;
		if (this.phase !== 'ready') this.phase = 'loading';
		try {
			const found = await (await logic()).loadComments(this.nodeId, deps);
			if (read !== this.#reads) return;
			this.threads = found.threads;
			this.refused = found.refused;
			this.error = null;
			this.phase = 'ready';
			this.#seen?.();
		} catch (e) {
			if (read !== this.#reads) return;
			// A contact whose keys changed stops everything until someone answers, as anywhere.
			sharing.warn(e);
			this.error = e;
			this.phase = 'failed';
		}
	}

	/** Runs a change, then reads the threads again. A failure is the caller's to show. */
	async #change<T>(
		write: (deps: CommentDeps, m: typeof import('$lib/comments/comments')) => Promise<T>
	): Promise<T> {
		const deps = this.#deps();
		if (deps === null) throw new Error('The drive is locked.');
		this.busy = true;
		try {
			return await write(deps, await logic());
		} finally {
			this.busy = false;
			await this.load();
		}
	}

	start(text: string, anchor: Anchor | null): Promise<string> {
		return this.#change((deps, m) => m.startThread(this.nodeId, text, anchor, deps));
	}

	reply(threadId: string, text: string): Promise<string> {
		return this.#change((deps, m) => m.reply(this.nodeId, threadId, text, deps));
	}

	edit(comment: Pick<CommentView, 'id' | 'threadId'>, text: string): Promise<void> {
		return this.#change((deps, m) => m.editComment(this.nodeId, comment, text, deps));
	}

	remove(commentId: string): Promise<void> {
		return this.#change((deps, m) => m.deleteComment(this.nodeId, commentId, deps));
	}

	resolve(threadId: string, resolved: boolean): Promise<void> {
		return this.#change((deps, m) => m.resolveThread(this.nodeId, threadId, resolved, deps));
	}

	/**
	 * Moves anchors after an edit moved what they point at. Returns the moves that did not
	 * go, for the caller to keep and try again with the next save.
	 */
	async moveAnchors(
		moves: readonly { threadId: string; anchor: Anchor }[]
	): Promise<{ threadId: string; anchor: Anchor }[]> {
		if (moves.length === 0) return [];
		return this.#change(async (deps, m) => {
			const failed: { threadId: string; anchor: Anchor }[] = [];
			for (const move of moves) {
				try {
					await m.moveAnchor(this.nodeId, move.threadId, move.anchor, deps);
				} catch {
					failed.push(move);
				}
			}
			return failed;
		});
	}
}
