import { describe, expect, it } from 'vitest';
import { destinationFor } from './routing';

describe('destinationFor', () => {
	it.each([
		['needs-setup', '/', '/setup'],
		['needs-setup', '/signin', '/setup'],
		['needs-setup', '/invite', '/setup'],
		['needs-setup', '/setup', null],
		['signed-out', '/', '/signin'],
		['signed-out', '/settings', '/signin'],
		['signed-out', '/admin', '/signin'],
		['signed-out', '/unlock', '/signin'],
		['signed-out', '/setup', '/signin'],
		['signed-out', '/signin', null],
		['signed-out', '/recover', null],
		['signed-out', '/invite', null],
		['signed-out', '/reset', null],
		['locked', '/', '/unlock'],
		['locked', '/settings', '/unlock'],
		['locked', '/signin', '/unlock'],
		['locked', '/unlock', null],
		['locked', '/recover', null],
		['unlocked', '/signin', '/'],
		['unlocked', '/unlock', '/'],
		['unlocked', '/recover', '/'],
		['unlocked', '/setup', '/'],
		['unlocked', '/', null],
		['unlocked', '/settings', null],
		['unlocked', '/invite', null],
		['booting', '/', null],
		['offline', '/', null]
	] as const)('%s at %s goes to %s', (status, path, expected) => {
		expect(destinationFor({ status, path })).toBe(expected);
	});

	it('keeps /admin to admins', () => {
		expect(destinationFor({ status: 'unlocked', path: '/admin', role: 'user' })).toBe('/');
		expect(destinationFor({ status: 'unlocked', path: '/admin', role: 'admin' })).toBeNull();
	});

	it('goes to settings first when the wizard asked for two-factor', () => {
		expect(destinationFor({ status: 'unlocked', path: '/signin', wantsTotp: true })).toBe(
			'/settings'
		);
	});
});
