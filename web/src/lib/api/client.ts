/**
 * Typed client for the YonDrive API. It mirrors the Go routes one for one and
 * knows nothing about crypto: bodies are what the server stores, opaque or not.
 * Types come from schema.ts, generated from api/openapi.yaml.
 */
import { ApiError, type ErrorBody, type Health } from './types';

const base = '/api/v1';

/** Reports liveness, the server version and whether setup is complete. */
export async function getHealth(fetcher: typeof fetch = fetch): Promise<Health> {
	const res = await fetcher(`${base}/health`, { headers: { Accept: 'application/json' } });
	if (!res.ok) throw await failure(res);
	return (await res.json()) as Health;
}

async function failure(res: Response): Promise<ApiError> {
	try {
		const body = (await res.json()) as Partial<ErrorBody>;
		if (typeof body.code === 'string') return new ApiError(res.status, body.code);
	} catch {
		// Not JSON: a proxy's error page, say.
	}
	return new ApiError(res.status, 'unknown');
}
