import { describe, expect, it } from 'vitest';
import { theme, THEME_KEY, type Theme, type ThemeDeps } from './theme.svelte';

function fake(initial: Record<string, string> = {}) {
	const items = new Map(Object.entries(initial));
	const painted: Theme[] = [];
	const deps: ThemeDeps = {
		storage: () =>
			({
				getItem: (key: string) => items.get(key) ?? null,
				setItem: (key: string, value: string) => void items.set(key, value),
				removeItem: (key: string) => void items.delete(key)
			}) as unknown as Storage,
		paint: (t) => void painted.push(t)
	};
	return { deps, items, painted };
}

describe('theme', () => {
	it('uses the key yondrive-theme', () => {
		expect(THEME_KEY).toBe('yondrive-theme');
	});

	it('starts from what is stored, or from the system', () => {
		const a = fake();
		theme.start(a.deps);
		expect(theme.choice).toBe('system');
		expect(a.painted).toEqual(['system']);

		const b = fake({ [THEME_KEY]: 'dark' });
		theme.start(b.deps);
		expect(theme.choice).toBe('dark');
		expect(b.painted).toEqual(['dark']);

		const c = fake({ [THEME_KEY]: 'neon' });
		theme.start(c.deps);
		expect(theme.choice).toBe('system');
	});

	it('keeps a choice and forgets it for system', () => {
		const f = fake();
		theme.start(f.deps);
		theme.choose('dark');
		expect(f.items.get(THEME_KEY)).toBe('dark');
		theme.choose('system');
		expect(f.items.has(THEME_KEY)).toBe(false);
		expect(f.painted).toEqual(['system', 'dark', 'system']);
	});

	it('holds the choice for the page when storage refuses', () => {
		const painted: Theme[] = [];
		theme.start({
			storage: () => {
				throw new Error('denied');
			},
			paint: (t) => void painted.push(t)
		});
		theme.choose('light');
		expect(theme.choice).toBe('light');
		expect(painted).toEqual(['system', 'light']);
	});
});
