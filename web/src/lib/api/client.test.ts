import { describe, expect, it } from 'vitest';
import { createApi, type Api } from './client';
import { ApiError, isApiError, parseErrorCode } from './types';

type Call = { method: string; path: string; headers: Headers; body: unknown };

function respond(status: number, body?: unknown): { api: Api; calls: Call[] } {
	const calls: Call[] = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			method: init?.method ?? 'GET',
			path: String(input),
			headers: new Headers(init?.headers),
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
		});
		if (body === undefined) return new Response(null, { status });
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
	}) as typeof fetch;
	return { api: createApi(fetcher), calls };
}

const body = { any: 'body' } as never;

/** Every route of api/openapi.yaml, with the call that reaches it. */
const routes: [string, string, (api: Api) => Promise<unknown>, boolean][] = [
	['GET', '/health', (a) => a.getHealth(), true],
	['GET', '/setup/info', (a) => a.getSetupInfo('t'), true],
	['POST', '/setup/validate-url', (a) => a.validateSetupUrl('t', 'u'), true],
	['POST', '/setup/complete', (a) => a.completeSetup('t', body), true],
	['GET', '/auth/kdf?username=a%20b', (a) => a.getKdf('a b'), true],
	['POST', '/auth/login', (a) => a.login(body), true],
	['POST', '/auth/logout', (a) => a.logout(), false],
	['POST', '/auth/register', (a) => a.register(body), true],
	['POST', '/auth/rekey', (a) => a.rekey(body), false],
	['POST', '/auth/totp/enrol', (a) => a.enrolTotp(body), true],
	['POST', '/auth/totp/confirm', (a) => a.confirmTotp(body), true],
	['POST', '/auth/totp/disable', (a) => a.disableTotp(body), false],
	['POST', '/auth/password-reset', (a) => a.completePasswordReset(body), false],
	['GET', '/session/key', (a) => a.getSessionKey(), true],
	['PUT', '/session/key', (a) => a.putSessionKey(body), false],
	['DELETE', '/session/key', (a) => a.deleteSessionKey(), false],
	['GET', '/me', (a) => a.getMe(), true],
	['GET', '/users/u%2F1/keys', (a) => a.getUserKeys('u/1'), true],
	['GET', '/me/tokens', (a) => a.listTokens(), true],
	['POST', '/me/tokens', (a) => a.createToken(body), true],
	['DELETE', '/me/tokens/t1', (a) => a.revokeToken('t1'), false],
	['GET', '/admin/invites', (a) => a.listInvites(), true],
	['POST', '/admin/invites', (a) => a.createInvite(body), true],
	['DELETE', '/admin/invites/i1', (a) => a.deleteInvite('i1'), false],
	['GET', '/admin/users', (a) => a.listUsers(), true],
	['PATCH', '/admin/users/u1', (a) => a.updateUser('u1', body), true],
	['DELETE', '/admin/users/u1', (a) => a.deleteUser('u1'), false],
	['POST', '/admin/users/u1/password-reset', (a) => a.createPasswordReset('u1', body), true],
	['GET', '/admin/settings', (a) => a.getSettings(), true],
	['PATCH', '/admin/settings', (a) => a.updateSettings(body), true]
];

describe('routes', () => {
	it.each(routes)('%s %s', async (method, path, call, hasAnswer) => {
		const answer = { ok: 1 };
		const { api, calls } = respond(hasAnswer ? 200 : 204, hasAnswer ? answer : undefined);
		const result = await call(api);
		expect(calls[0].method).toBe(method);
		expect(calls[0].path).toBe(`/api/v1${path}`);
		expect(result).toEqual(hasAnswer ? answer : undefined);
	});

	it('sends a JSON body as given', async () => {
		const { api, calls } = respond(200, {});
		await api.login({ username: 'a', auth_key: 'QQ==' });
		expect(calls[0].body).toEqual({ username: 'a', auth_key: 'QQ==' });
		expect(calls[0].headers.get('Content-Type')).toBe('application/json');
	});

	it('sends the setup token only on the routes of the wizard', async () => {
		const { api, calls } = respond(200, {});
		await api.getSetupInfo('tok');
		await api.validateSetupUrl('tok', 'http://x');
		await api.completeSetup('tok', body);
		await api.getHealth();
		expect(calls.map((c) => c.headers.get('X-Setup-Token'))).toEqual(['tok', 'tok', 'tok', null]);
	});
});

describe('errors', () => {
	it('turns an error body into its code', async () => {
		const err = await respond(401, { code: 'invalid_credentials' })
			.api.getHealth()
			.catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({ status: 401, code: 'invalid_credentials' });
		expect(isApiError(err, 'invalid_credentials', 'unauthorized')).toBe(true);
		expect(isApiError(err, 'unauthorized')).toBe(false);
	});

	it('reports a non-JSON failure as unknown', async () => {
		const err = await respond(502, '<html>bad gateway</html>')
			.api.getHealth()
			.catch((e) => e);
		expect(err).toMatchObject({ status: 502, code: 'unknown' });
	});

	it('passes on a code it does not list, and calls anything else unknown', () => {
		expect(parseErrorCode('from_the_future')).toBe('from_the_future');
		expect(parseErrorCode(7)).toBe('unknown');
		expect(parseErrorCode('')).toBe('unknown');
	});

	it('reports a request that never got an answer as network', async () => {
		const api = createApi((async () => {
			throw new TypeError('failed to fetch');
		}) as typeof fetch);
		await expect(api.getHealth()).rejects.toMatchObject({ status: 0, code: 'network' });
	});
});
