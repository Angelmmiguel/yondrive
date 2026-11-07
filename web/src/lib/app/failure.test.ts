import { expect, it } from 'vitest';
import { ApiError } from '$lib/api/types';
import { Session } from '$lib/state/session.svelte';
import { failure } from './failure';

it('signs out a session the server no longer knows', () => {
	const session = new Session();
	session.status = 'unlocked';
	expect(failure(new ApiError(401, 'unauthorized'), { session })).toContain('Sign in again');
	expect(session.status).toBe('signed-out');
});

it('leaves the session alone for anything else', () => {
	const session = new Session();
	session.status = 'unlocked';
	expect(failure(new ApiError(429, 'rate_limited'), { session })).toContain('Too many');
	expect(session.status).toBe('unlocked');
});
