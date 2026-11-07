import { describe, expect, it } from 'vitest';
import { findIn } from '../../../tests/scan';

const secrets = { s: 'canary zebra quartz meadow' };

describe('the secret scan', () => {
	it.each([0, 1, 2])('finds the secret in base64 at alignment %i', (lead) => {
		for (const tail of [0, 1, 2]) {
			const body = Buffer.concat([
				Buffer.alloc(lead, 'x'),
				Buffer.from(secrets.s),
				Buffer.alloc(tail, 'y')
			]);
			expect(findIn(Buffer.from(body.toString('base64')), secrets)).toEqual(['s']);
		}
	});

	it('finds it as it is, percent-encoded and URL-safe', () => {
		expect(findIn(Buffer.from('a canary zebra quartz meadow b'), secrets)).toEqual(['s']);
		expect(findIn(Buffer.from('q=canary%20zebra%20quartz%20meadow'), secrets)).toEqual(['s']);
		const safe = Buffer.from(`\xff\xfe${secrets.s}`, 'latin1').toString('base64url');
		expect(findIn(Buffer.from(safe), secrets)).toEqual(['s']);
	});

	it('does not find what is not there', () => {
		expect(findIn(Buffer.from('nothing of the kind'), secrets)).toEqual([]);
	});
});
