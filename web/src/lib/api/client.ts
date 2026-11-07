/**
 * Typed client for the YonDrive API. It mirrors the Go routes one for one, with
 * the names of their operation ids, and knows nothing about crypto: bodies are
 * what the server stores, opaque or not, and binary values are the base64 the
 * spec says they are. Types come from schema.ts, generated from api/openapi.yaml.
 */
import {
	ApiError,
	parseErrorCode,
	type Account,
	type CompletePasswordResetRequest,
	type ConfirmTotpRequest,
	type CreatedInvite,
	type CreatedPasswordReset,
	type CreatedToken,
	type CreatedUser,
	type CreateInviteRequest,
	type CreateTokenRequest,
	type CurrentCredential,
	type DeviceToken,
	type DisableTotpRequest,
	type Health,
	type Invite,
	type Kdf,
	type LoginRequest,
	type Profile,
	type RecoveryCodes,
	type RegisterRequest,
	type RekeyRequest,
	type ServerSettings,
	type SessionKey,
	type SetupInfo,
	type SetupRequest,
	type TotpEnrolment,
	type UpdateSettingsRequest,
	type UpdateUserRequest,
	type UserKeys,
	type ValidatedUrl
} from './types';

const base = '/api/v1';

interface Options {
	body?: unknown;
	/** The one-time token every call of the wizard carries. */
	setupToken?: string;
}

/** Builds the client over a `fetch`; tests pass their own. */
export function createApi(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
	async function send(method: string, path: string, options: Options = {}): Promise<Response> {
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (options.body !== undefined) headers['Content-Type'] = 'application/json';
		if (options.setupToken !== undefined) headers['X-Setup-Token'] = options.setupToken;
		let res: Response;
		try {
			res = await fetcher(`${base}${path}`, {
				method,
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body)
			});
		} catch {
			throw new ApiError(0, 'network');
		}
		if (!res.ok) throw await failure(res);
		return res;
	}

	const json = async <T>(method: string, path: string, options?: Options): Promise<T> =>
		(await (await send(method, path, options)).json()) as T;

	const empty = async (method: string, path: string, options?: Options): Promise<void> => {
		await send(method, path, options);
	};

	const id = encodeURIComponent;

	return {
		getHealth: () => json<Health>('GET', '/health'),

		getSetupInfo: (setupToken: string) => json<SetupInfo>('GET', '/setup/info', { setupToken }),
		validateSetupUrl: (setupToken: string, url: string) =>
			json<ValidatedUrl>('POST', '/setup/validate-url', { setupToken, body: { url } }),
		completeSetup: (setupToken: string, body: SetupRequest) =>
			json<CreatedUser>('POST', '/setup/complete', { setupToken, body }),

		getKdf: (username: string) => json<Kdf>('GET', `/auth/kdf?username=${id(username)}`),
		login: (body: LoginRequest) => json<Account>('POST', '/auth/login', { body }),
		logout: () => empty('POST', '/auth/logout'),
		register: (body: RegisterRequest) => json<CreatedUser>('POST', '/auth/register', { body }),
		rekey: (body: RekeyRequest) => empty('POST', '/auth/rekey', { body }),
		enrolTotp: (body: CurrentCredential) =>
			json<TotpEnrolment>('POST', '/auth/totp/enrol', { body }),
		confirmTotp: (body: ConfirmTotpRequest) =>
			json<RecoveryCodes>('POST', '/auth/totp/confirm', { body }),
		disableTotp: (body: DisableTotpRequest) => empty('POST', '/auth/totp/disable', { body }),
		completePasswordReset: (body: CompletePasswordResetRequest) =>
			empty('POST', '/auth/password-reset', { body }),

		getSessionKey: () => json<SessionKey>('GET', '/session/key'),
		putSessionKey: (body: SessionKey) => empty('PUT', '/session/key', { body }),
		deleteSessionKey: () => empty('DELETE', '/session/key'),

		getMe: () => json<Account>('GET', '/me'),
		getUserKeys: (userId: string) => json<UserKeys>('GET', `/users/${id(userId)}/keys`),
		listTokens: () => json<DeviceToken[]>('GET', '/me/tokens'),
		createToken: (body: CreateTokenRequest) => json<CreatedToken>('POST', '/me/tokens', { body }),
		revokeToken: (tokenId: string) => empty('DELETE', `/me/tokens/${id(tokenId)}`),

		listInvites: () => json<Invite[]>('GET', '/admin/invites'),
		createInvite: (body: CreateInviteRequest) =>
			json<CreatedInvite>('POST', '/admin/invites', { body }),
		deleteInvite: (inviteId: string) => empty('DELETE', `/admin/invites/${id(inviteId)}`),
		listUsers: () => json<Profile[]>('GET', '/admin/users'),
		updateUser: (userId: string, body: UpdateUserRequest) =>
			json<Profile>('PATCH', `/admin/users/${id(userId)}`, { body }),
		deleteUser: (userId: string) => empty('DELETE', `/admin/users/${id(userId)}`),
		createPasswordReset: (userId: string, body: CurrentCredential) =>
			json<CreatedPasswordReset>('POST', `/admin/users/${id(userId)}/password-reset`, { body }),
		getSettings: () => json<ServerSettings>('GET', '/admin/settings'),
		updateSettings: (body: UpdateSettingsRequest) =>
			json<ServerSettings>('PATCH', '/admin/settings', { body })
	};
}

export type Api = ReturnType<typeof createApi>;

/** The client the app uses. */
export const api: Api = createApi();

async function failure(res: Response): Promise<ApiError> {
	try {
		const body: unknown = await res.json();
		if (body !== null && typeof body === 'object' && 'code' in body) {
			return new ApiError(res.status, parseErrorCode(body.code));
		}
	} catch {
		// Not JSON: a proxy's error page, say.
	}
	return new ApiError(res.status, 'unknown');
}
