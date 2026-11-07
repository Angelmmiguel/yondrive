import type { UploadItem } from './queue';

/** How long a finished queue stays open before it folds into a pill. */
export const COLLAPSE_AFTER_MS = 3000;
/** How long the pill stays before it goes away. */
export const REMOVE_AFTER_MS = 4000;

export type PanelPhase = 'open' | 'pill';

/**
 * What the upload panel shows. While anything moves, fails or waits it is open.
 * Once every upload has finished it folds into a pill, and the pill leaves
 * after a while. A failure keeps it open until the person deals with it.
 */
export class UploadPanelState {
	phase = $state<PanelPhase>('open');
	/** Whether there is anything to show at all. */
	present = $state(false);
	/** Finished uploads, for the pill. */
	count = $state(0);
	/** The person opened the pill again: leave it open until the queue changes. */
	#pinned = false;
	#timer: ReturnType<typeof setTimeout> | null = null;
	readonly #remove: () => void;

	constructor(remove: () => void) {
		this.#remove = remove;
	}

	/** How much room the panel needs under the page content. */
	get room(): 'none' | 'pill' | 'panel' {
		if (!this.present) return 'none';
		return this.phase === 'pill' ? 'pill' : 'panel';
	}

	/** Follows the queue. Call it whenever the items change. */
	sync(items: readonly UploadItem[]): void {
		this.present = items.length > 0;
		this.count = items.filter((i) => i.status === 'done').length;
		const settled =
			this.count > 0 && items.every((i) => i.status === 'done' || i.status === 'cancelled');
		if (!settled) {
			this.#clear();
			this.#pinned = false;
			this.phase = 'open';
			return;
		}
		if (this.#timer !== null || this.#pinned || this.phase === 'pill') return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.phase = 'pill';
			this.#timer = setTimeout(() => {
				this.#timer = null;
				this.#remove();
			}, REMOVE_AFTER_MS);
		}, COLLAPSE_AFTER_MS);
	}

	/** Opens the pill again, and keeps it open. */
	expand(): void {
		this.#clear();
		this.#pinned = true;
		this.phase = 'open';
	}

	/** Stops the timers, when the panel goes away. */
	dispose(): void {
		this.#clear();
	}

	#clear(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}
}
