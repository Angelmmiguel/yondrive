/**
 * Search as the screens see it: whether the palette is open, what it asks, and how
 * the index is doing. What is typed stays here and in the index's worker. It is not
 * sent anywhere and it does not go in the address.
 */
import { api } from '$lib/api/client';
import type { Sealer } from '$lib/crypto/sealer';
import type { Drive } from '$lib/drive/drive';
import type { KindFilter } from '$lib/drive/sort';
import { indexedDbSegmentCache, type SegmentCache } from '$lib/search/cache';
import { createIndexClient } from '$lib/search/client';
import type { IndexClient } from '$lib/search/engine';
import { searchOfDrive } from '$lib/search/of-drive';
import type { SearchService, SearchStatus } from '$lib/search/service';
import type { DateFilter, SearchHit, SearchQuery, SharedFilter } from '$lib/search/types';

const IDLE: SearchStatus = { phase: 'idle', items: 0, pending: 0, unsaved: false };
const TYPING_MS = 60;
const SHOWN = 50;

/** What wires a session to its index; tests hand in their own. */
export interface SearchWiring {
	cache: (userId: string) => SegmentCache;
	index: (sealer: Sealer, masterKey: Uint8Array) => IndexClient;
	apiOf: () => typeof api;
	reconcileMs?: number;
	flushMs?: number;
}

const realWiring: SearchWiring = {
	cache: indexedDbSegmentCache,
	index: (sealer, masterKey) =>
		createIndexClient(sealer.suite, sealer.indexKey(masterKey) as Uint8Array<ArrayBuffer>),
	apiOf: () => api
};

export class SearchState {
	open = $state(false);
	text = $state('');
	type = $state<KindFilter>('all');
	tag = $state('');
	date = $state<DateFilter>('any');
	shared = $state<SharedFilter>('any');
	hits = $state.raw<SearchHit[]>([]);
	total = $state(0);
	/** A question has been answered since the last change. */
	answered = $state(false);
	status = $state.raw<SearchStatus>(IDLE);

	readonly #wiring: SearchWiring;
	#service: SearchService | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#asked = 0;

	constructor(wiring: SearchWiring = realWiring) {
		this.#wiring = wiring;
	}

	/** Gives this drive an index. Nothing is read until `start`. */
	attach(core: Drive, sealer: Sealer, masterKey: Uint8Array, userId: string): void {
		this.detach();
		const { cache, index, apiOf, reconcileMs, flushMs } = this.#wiring;
		this.#service = searchOfDrive(core, {
			api: apiOf(),
			sealer,
			cache: cache(userId),
			index: index(sealer, masterKey),
			userId,
			reconcileMs,
			flushMs,
			onstatus: (status) => {
				this.status = status;
			}
		});
	}

	/** The tree is open: loads what is stored and catches up, behind the screen. */
	start(): void {
		void this.#service?.start();
	}

	treeChanged(): void {
		this.#service?.treeChanged();
	}

	/** Tells the index about a file whose bytes are in hand. */
	fileCommitted(id: string, blob: Blob): void {
		void this.#service?.fileCommitted(id, blob);
	}

	/**
	 * A lock or sign-out: the index goes. Returns what forgets this device's copy as well,
	 * for a sign-out, which a lock keeps for the next unlock.
	 */
	detach(): () => Promise<void> {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#asked++;
		const service = this.#service;
		service?.stop();
		this.#service = null;
		this.open = false;
		this.status = IDLE;
		this.reset();
		return () => service?.forget().catch(() => {}) ?? Promise.resolve();
	}

	/** Forgets the question and the answer. */
	reset(): void {
		this.text = '';
		this.type = 'all';
		this.tag = '';
		this.date = 'any';
		this.shared = 'any';
		this.hits = [];
		this.total = 0;
		this.answered = false;
	}

	show(seed = ''): void {
		if (seed !== '') this.text = seed;
		this.open = true;
		this.ask();
	}

	hide(): void {
		this.open = false;
		this.reset();
	}

	#query(): SearchQuery {
		return {
			text: this.text,
			type: this.type,
			tag: this.tag === '' ? null : this.tag,
			date: this.date,
			shared: this.shared,
			limit: SHOWN
		};
	}

	/** Asks again, a moment after the typing stops. */
	ask(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.answered = false;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.askNow();
		}, TYPING_MS);
	}

	async askNow(): Promise<void> {
		const service = this.#service;
		if (service === null) return;
		const asked = ++this.#asked;
		try {
			const { hits, total } = await service.search(this.#query());
			if (asked !== this.#asked) return;
			this.hits = hits;
			this.total = total;
			this.answered = true;
		} catch {
			if (asked === this.#asked) this.answered = true;
		}
	}
}

export const search = new SearchState();
