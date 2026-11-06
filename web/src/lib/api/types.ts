import type { components } from './schema';

/** The body of `GET /api/v1/health`. */
export type Health = components['schemas']['Health'];

/** The JSON body of every failed response. */
export type ErrorBody = components['schemas']['Error'];

/** A failed call: the server's stable error code, never a message. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string
	) {
		super(`${status} ${code}`);
		this.name = 'ApiError';
	}
}
