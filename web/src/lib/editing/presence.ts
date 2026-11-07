/**
 * Who else has a file open in an editor (PLAN 6.6). Someone who may edit sends a
 * heartbeat; anyone may ask. Either way the answer is who else is there, which
 * is a warning to show, never a lock.
 */
import type { Api } from '$lib/api/client';
import type { Editor } from '$lib/api/types';

export const HEARTBEAT_MS = 15_000;

export interface PresenceDeps {
	api: Pick<Api, 'getEditing' | 'putEditing'>;
	onchange(editors: Editor[]): void;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}

export class Presence {
	readonly #deps: PresenceDeps;
	#timer: unknown = null;
	#node: string | null = null;
	#editing = false;
	#last = '';

	constructor(deps: PresenceDeps) {
		this.#deps = deps;
	}

	/** Starts, or switches to another node or to editing or just looking. */
	start(nodeId: string, editing: boolean): void {
		this.stop();
		this.#node = nodeId;
		this.#editing = editing;
		void this.beat();
		this.#timer = (this.#deps.setInterval ?? ((f, ms) => setInterval(f, ms)))(
			() => void this.beat(),
			HEARTBEAT_MS
		);
	}

	async beat(): Promise<void> {
		const node = this.#node;
		if (node === null) return;
		try {
			const reply = this.#editing
				? await this.#deps.api.putEditing(node)
				: await this.#deps.api.getEditing(node);
			if (node !== this.#node) return;
			const key = reply.editors.map((e) => e.user_id).join(',');
			if (key !== this.#last) {
				this.#last = key;
				this.#deps.onchange(reply.editors);
			}
		} catch {
			// The next beat tries again; a warning that is late is still a warning.
		}
	}

	stop(): void {
		if (this.#timer !== null)
			(this.#deps.clearInterval ?? ((h) => clearInterval(h as number)))(this.#timer);
		this.#timer = null;
		this.#node = null;
		if (this.#last !== '') this.#deps.onchange([]);
		this.#last = '';
	}
}
