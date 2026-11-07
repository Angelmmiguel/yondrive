import { describe, expect, it } from 'vitest';
import { markNew, takeNew } from './fresh';

describe('files just made', () => {
	it('are new once, for the opening that follows', () => {
		expect(takeNew('n1')).toBe(false);
		markNew('n1');
		expect(takeNew('n2')).toBe(false);
		expect(takeNew('n1')).toBe(true);
		expect(takeNew('n1')).toBe(false);
	});
});
