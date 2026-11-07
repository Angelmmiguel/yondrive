/**
 * Where a person belongs, from the state of the session and the page they asked
 * for. `null` means where they are. The root layout follows this and draws nothing
 * of a page they are about to leave.
 */
import type { Role } from '$lib/api/types';
import type { SessionStatus } from '$lib/state/session.svelte';

export type Destination = '/' | '/setup' | '/signin' | '/unlock' | '/settings';

/** Open to anyone in any state: a link is for whoever holds it. */
const OPEN = ['/invite', '/reset', '/styleguide'];

/** A public link's page: it has no session and asks for none. */
export function isLinkPath(path: string): boolean {
	return path.startsWith('/s/');
}

export function destinationFor(input: {
	status: SessionStatus;
	path: string;
	role?: Role;
	wantsTotp?: boolean;
}): Destination | null {
	const { status, path, role, wantsTotp } = input;
	if (status === 'booting' || status === 'offline' || isLinkPath(path)) return null;
	if (status === 'needs-setup')
		return path === '/setup' || path === '/styleguide' ? null : '/setup';
	if (OPEN.includes(path)) return null;
	switch (status) {
		case 'signed-out':
			return path === '/signin' || path === '/recover' ? null : '/signin';
		case 'locked':
			return path === '/unlock' || path === '/recover' ? null : '/unlock';
		case 'unlocked':
			if (['/signin', '/unlock', '/recover', '/setup'].includes(path)) {
				return wantsTotp ? '/settings' : '/';
			}
			return path === '/admin' && role !== 'admin' ? '/' : null;
	}
}
