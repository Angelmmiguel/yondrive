import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatQuota, formatWhen, GB, greeting } from './format';

describe('formatWhen', () => {
	const now = new Date(2026, 5, 15, 12, 0, 0).getTime();

	it.each([
		[now - 10_000, 'Just now'],
		[now - 5 * 60_000, '5 min ago'],
		[new Date(2026, 5, 14, 12, 0).getTime(), 'Yesterday'],
		[0, '—'],
		[Number.NaN, '—']
	])('says %s as %s', (when, text) => {
		expect(formatWhen(when, now)).toBe(text);
	});

	it('says today with the time and older days with the date', () => {
		expect(formatWhen(now - 3 * 3_600_000, now)).toMatch(/^Today, /);
		expect(formatWhen(new Date(2026, 1, 3).getTime(), now)).not.toMatch(/2026/);
		expect(formatWhen(new Date(2020, 1, 3).getTime(), now)).toMatch(/2020/);
	});
});

describe('greeting', () => {
	it.each([
		[3, 'Good evening'],
		[9, 'Good morning'],
		[15, 'Good afternoon'],
		[21, 'Good evening']
	])('at %i says %s', (hour, text) => {
		expect(greeting(hour)).toBe(text);
	});
});

describe('format', () => {
	it.each([
		[0, '0 bytes'],
		[999, '999 bytes'],
		[1000, '1 KB'],
		[1500, '1.5 KB'],
		[500 * GB, '500 GB'],
		[3_600_000_000_000, '3.6 TB']
	])('%i bytes reads %s', (bytes, text) => {
		expect(formatBytes(bytes)).toBe(text);
	});

	it('calls a quota of 0 unlimited', () => {
		expect(formatQuota(0)).toBe('Unlimited');
		expect(formatQuota(GB)).toBe('1 GB');
	});

	it('hands back a date it cannot read', () => {
		expect(formatDate('nonsense')).toBe('nonsense');
	});
});
