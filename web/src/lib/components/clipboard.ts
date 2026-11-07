export type CopyResult = 'copied' | 'manual';

/**
 * Puts text on the clipboard. It tries the async Clipboard API, then the legacy
 * `execCommand('copy')` through a temporary textarea, and reports 'manual' when
 * neither is available so the caller can select the text for the user to copy.
 */
export async function copyText(text: string): Promise<CopyResult> {
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return 'copied';
		}
	} catch {
		// Denied or unavailable (insecure origin, permissions policy): fall through.
	}
	return legacyCopy(text) ? 'copied' : 'manual';
}

function legacyCopy(text: string): boolean {
	if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.opacity = '0';
	const active = document.activeElement as HTMLElement | null;
	document.body.appendChild(area);
	area.select();
	try {
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		area.remove();
		active?.focus?.();
	}
}
