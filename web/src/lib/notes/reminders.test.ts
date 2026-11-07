import { describe, expect, it } from 'vitest';
import { memoryStorage } from '$lib/testing/account';
import { dueReminders, givenStore, nextReminder, reminderKey } from './reminders';

const notes = [
	{ id: 'a', title: 'Call', reminder: 1000 },
	{ id: 'b', title: 'Later', reminder: 5000 },
	{ id: 'c', title: 'None', reminder: null }
];

describe('reminders', () => {
	it('are due once each', () => {
		expect(dueReminders(notes, 2000, new Set())).toEqual([{ id: 'a', title: 'Call', at: 1000 }]);
		expect(dueReminders(notes, 6000, new Set([reminderKey('a', 1000)])).map((r) => r.id)).toEqual([
			'b'
		]);
		expect(nextReminder(notes, 2000)).toBe(5000);
		expect(nextReminder(notes, 9000)).toBeNull();
	});

	it('remember on the device which were given, per user', () => {
		const storage = memoryStorage();
		const store = givenStore('u1', storage);
		store.add(reminderKey('a', 1000));
		expect(store.load().has('a:1000')).toBe(true);
		expect(givenStore('u2', storage).load().size).toBe(0);
	});
});
