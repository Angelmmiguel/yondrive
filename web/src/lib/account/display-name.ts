/**
 * The name a person goes by. The server has no use for it, so it stays on the
 * device: the zero knowledge canary test types one and checks that it never leaves.
 */
export const DISPLAY_NAME_KEY = 'yondrive-display-name';

export function readDisplayName(storage: Pick<Storage, 'getItem'> | null): string {
	try {
		return storage?.getItem(DISPLAY_NAME_KEY) ?? '';
	} catch {
		return '';
	}
}

export function writeDisplayName(
	storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
	name: string
): void {
	try {
		const trimmed = name.trim();
		if (trimmed === '') storage?.removeItem(DISPLAY_NAME_KEY);
		else storage?.setItem(DISPLAY_NAME_KEY, trimmed);
	} catch {
		// It holds for this page load, in the form it was typed.
	}
}
