import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatQuota, GB } from './format';

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
