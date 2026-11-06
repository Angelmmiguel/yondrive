/**
 * The colour theme. A preference of this device rather than of the account,
 * so it lives in localStorage and applies before sign-in. `system` leaves the
 * document without a `data-theme`, and the stylesheet follows the browser's
 * own setting; `light` and `dark` pin it.
 */
export type Theme = 'system' | 'light' | 'dark';

export const THEMES: readonly { id: Theme; label: string }[] = [
	{ id: 'system', label: 'System' },
	{ id: 'light', label: 'Light' },
	{ id: 'dark', label: 'Dark' }
];

export const THEME_KEY = 'yondrive-theme';

export interface ThemeDeps {
	/** Where the choice is kept, or null when the browser refuses storage. */
	storage: () => Storage | null;
	/** Sets the choice on the document. */
	paint: (theme: Theme) => void;
}

const browserDeps: ThemeDeps = {
	storage: () => {
		try {
			return window.localStorage;
		} catch {
			return null;
		}
	},
	paint: (theme) => {
		if (theme === 'system') delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = theme;
	}
};

class ThemeState {
	choice = $state<Theme>('system');
	private deps: ThemeDeps = browserDeps;

	/** Reads the stored choice and paints it. Once per page load. */
	start(deps: ThemeDeps = browserDeps): void {
		this.deps = deps;
		this.choice = stored(deps.storage);
		deps.paint(this.choice);
	}

	choose(theme: Theme): void {
		this.choice = theme;
		try {
			const storage = this.deps.storage();
			if (theme === 'system') storage?.removeItem(THEME_KEY);
			else storage?.setItem(THEME_KEY, theme);
		} catch {
			// The choice still holds for this page load.
		}
		this.deps.paint(theme);
	}
}

function stored(storage: ThemeDeps['storage']): Theme {
	try {
		const value = storage()?.getItem(THEME_KEY);
		return value === 'light' || value === 'dark' ? value : 'system';
	} catch {
		return 'system';
	}
}

export const theme = new ThemeState();
