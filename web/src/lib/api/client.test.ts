import { describe, expect, it } from 'vitest';
import { getHealth } from './client';
import { ApiError } from './types';

function respond(status: number, body: unknown, calls: Request[] = []): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push(new Request(new URL(String(input), 'http://localhost'), init));
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
	}) as typeof fetch;
}

describe('getHealth', () => {
	it('asks the health route and returns its body', async () => {
		const calls: Request[] = [];
		const health = { status: 'ok', version: 'dev', setup: false };
		expect(await getHealth(respond(200, health, calls))).toEqual(health);
		expect(new URL(calls[0].url).pathname).toBe('/api/v1/health');
		expect(calls[0].method).toBe('GET');
	});

	it('turns an error body into its code', async () => {
		const err = await getHealth(respond(500, { code: 'internal' })).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({ status: 500, code: 'internal' });
	});

	it('reports a non-JSON failure as unknown', async () => {
		const err = await getHealth(respond(502, '<html>bad gateway</html>')).catch((e) => e);
		expect(err).toMatchObject({ status: 502, code: 'unknown' });
	});
});
