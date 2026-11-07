import { describe, expect, it, vi } from 'vitest';
import { Presence } from './presence';

describe('presence', () => {
	it('beats while editing, asks while looking, and reports changes once', async () => {
		const seen: string[][] = [];
		const api = {
			putEditing: vi.fn(async () => ({
				editors: [{ user_id: 'u2', username: 'bob', since: '' }],
				ttl_seconds: 45
			})),
			getEditing: vi.fn(async () => ({ editors: [], ttl_seconds: 45 }))
		};
		let tick: () => void = () => {};
		const p = new Presence({
			api,
			onchange: (e) => seen.push(e.map((x) => x.username)),
			setInterval: (fn) => (tick = fn),
			clearInterval: () => {}
		});
		p.start('n1', true);
		await vi.waitFor(() => expect(seen).toEqual([['bob']]));
		tick();
		await Promise.resolve();
		expect(seen).toEqual([['bob']]);
		p.start('n1', false);
		await vi.waitFor(() => expect(api.getEditing).toHaveBeenCalled());
		p.stop();
		expect(seen.at(-1)).toEqual([]);
	});
});
