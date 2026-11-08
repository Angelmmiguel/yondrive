/**
 * What arrives through this user's file requests, as the screens see it. When the app
 * opens, and as it polls, every item that has arrived is adopted into its folder; how
 * many is counted for the notification, and what could not be adopted waits in the
 * list, for the owner to try again or throw away.
 */
import { isApiError, type IncomingItem } from '$lib/api/types';
import type { IncomingDeps } from '$lib/sharing/incoming';

/** Adopting is loaded when there is something to adopt, which is not on every screen. */
const adoption = () => import('$lib/sharing/incoming');

export interface WaitingItem {
	item: IncomingItem;
	/** `unreadable` will not get better by trying again. */
	why: 'unreadable' | 'failed';
	error?: unknown;
}

export class IncomingState {
	/** What could not be adopted. */
	waiting = $state.raw<WaitingItem[]>([]);
	/** How many files were adopted since the owner last looked. */
	adopted = $state(0);
	/** The folders they went into, newest last. */
	folders = $state.raw<string[]>([]);
	running = $state(false);

	#deps: IncomingDeps | null = null;
	#run: Promise<number> | null = null;

	attach(deps: IncomingDeps): void {
		this.#deps = deps;
	}

	detach(): void {
		this.#deps = null;
		this.#run = null;
		this.waiting = [];
		this.adopted = 0;
		this.folders = [];
		this.running = false;
	}

	/** Adopts everything that has arrived, one run at a time. Returns how many went in. */
	run(): Promise<number> {
		this.#run ??= this.#adoptAll().finally(() => {
			this.#run = null;
		});
		return this.#run;
	}

	async #adoptAll(): Promise<number> {
		const deps = this.#deps;
		if (deps === null) return 0;
		this.running = true;
		let count = 0;
		try {
			const items = await (await adoption()).listIncoming(deps);
			const waiting: WaitingItem[] = [];
			for (const item of items) {
				if (this.#deps !== deps) return count;
				const outcome = await this.#adopt(item, deps);
				if (outcome === null) count += 1;
				else waiting.push(outcome);
			}
			if (this.#deps === deps) this.waiting = waiting;
			return count;
		} finally {
			if (this.#deps === deps) this.running = false;
		}
	}

	async #adopt(item: IncomingItem, deps: IncomingDeps): Promise<WaitingItem | null> {
		const { adoptIncoming, UnreadableIncomingError } = await adoption();
		try {
			await adoptIncoming(item, deps);
		} catch (error) {
			// Signed out: nothing else will go either, and the app has to hear of it.
			if (isApiError(error, 'unauthorized')) throw error;
			const why = error instanceof UnreadableIncomingError ? 'unreadable' : 'failed';
			return { item, why, error };
		}
		if (this.#deps === deps) {
			this.adopted += 1;
			this.folders = [...this.folders.filter((id) => id !== item.folder_id), item.folder_id];
		}
		return null;
	}

	/** Tries one again. Whether it went in. */
	async retry(id: string): Promise<boolean> {
		const deps = this.#deps;
		const one = this.waiting.find((w) => w.item.id === id);
		if (deps === null || one === undefined) return false;
		const outcome = await this.#adopt(one.item, deps);
		if (this.#deps !== deps) return false;
		this.waiting = this.waiting.flatMap((w) =>
			w.item.id !== id ? [w] : outcome === null ? [] : [outcome]
		);
		return outcome === null;
	}

	/** Throws one away, for good. */
	async remove(id: string): Promise<void> {
		const deps = this.#deps;
		if (deps === null) return;
		await deps.api.deleteIncoming(id);
		if (this.#deps === deps) this.waiting = this.waiting.filter((w) => w.item.id !== id);
	}

	/** The owner has seen what arrived. */
	seen(): void {
		this.adopted = 0;
		this.folders = [];
	}
}

export const incoming = new IncomingState();
