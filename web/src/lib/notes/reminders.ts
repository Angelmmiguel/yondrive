/**
 * Reminders, which only an open app can give: the server cannot read a reminder's
 * time in end-to-end mode, and in both modes nothing is sent anywhere. A reminder
 * that came due while the app was closed is given at the next opening. Each one is
 * given once on a device, remembered by note and time.
 */
export interface Reminding {
	id: string;
	title: string;
	reminder: number | null;
}

export interface DueReminder {
	id: string;
	title: string;
	at: number;
}

export const reminderKey = (id: string, at: number) => `${id}:${at}`;

/** What is due by `now` and has not been given yet, oldest first. */
export function dueReminders(
	notes: readonly Reminding[],
	now: number,
	given: ReadonlySet<string>
): DueReminder[] {
	return notes
		.filter(
			(n) => n.reminder !== null && n.reminder <= now && !given.has(reminderKey(n.id, n.reminder))
		)
		.map((n) => ({ id: n.id, title: n.title, at: n.reminder as number }))
		.sort((a, b) => a.at - b.at);
}

/** When the next reminder comes due, or null. */
export function nextReminder(notes: readonly Reminding[], now: number): number | null {
	let next: number | null = null;
	for (const n of notes) {
		if (n.reminder !== null && n.reminder > now && (next === null || n.reminder < next))
			next = n.reminder;
	}
	return next;
}

const KEY = 'yondrive-reminders';
const KEEP = 500;

/** Which reminders this device has given, per user, in `localStorage`; times and ids only. */
export function givenStore(
	userId: string,
	storage: Storage | null = globalThis.localStorage ?? null
) {
	const key = `${KEY}-${userId}`;
	const read = (): string[] => {
		try {
			const value = JSON.parse(storage?.getItem(key) ?? '[]') as unknown;
			return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
		} catch {
			return [];
		}
	};
	return {
		load: () => new Set(read()),
		add(given: string): void {
			const list = [...read().filter((v) => v !== given), given].slice(-KEEP);
			try {
				storage?.setItem(key, JSON.stringify(list));
			} catch {
				// Without storage a reminder may be given again after a reload.
			}
		}
	};
}
