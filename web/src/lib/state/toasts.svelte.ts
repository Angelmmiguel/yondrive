/**
 * Short notices stacked at the corner of the app. Each goes away on its own
 * unless it is pushed with a lifetime of 0.
 */
export type ToastTone = 'info' | 'ok' | 'warn' | 'danger';

export interface ToastItem {
	id: number;
	tone: ToastTone;
	message: string;
}

export const TOAST_MS = 6000;

export class Toasts {
	items = $state<ToastItem[]>([]);
	#seq = 0;
	#timers: Record<number, ReturnType<typeof setTimeout>> = {};

	push(tone: ToastTone, message: string, ttl: number = TOAST_MS): number {
		const id = ++this.#seq;
		this.items = [...this.items, { id, tone, message }];
		if (ttl > 0) {
			this.#timers[id] = setTimeout(() => this.dismiss(id), ttl);
		}
		return id;
	}

	dismiss(id: number): void {
		clearTimeout(this.#timers[id]);
		delete this.#timers[id];
		this.items = this.items.filter((t) => t.id !== id);
	}

	clear(): void {
		for (const timer of Object.values(this.#timers)) clearTimeout(timer);
		this.#timers = {};
		this.items = [];
	}
}

export const toasts = new Toasts();
