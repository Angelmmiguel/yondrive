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
	type AdminHealth,
	type ChangePage,
	type CommitUploadRequest,
	type CompletePasswordResetRequest,
	type ConfirmTotpRequest,
	type CreatedInvite,
	type CreatedPasswordReset,
	type CreatedToken,
	type CreatedUser,
	type CreateInviteRequest,
	type CreateNodeRequest,
	type CreateRootRequest,
	type CreateTokenRequest,
	type CreateUploadRequest,
	type CurrentCredential,
	type DeviceToken,
	type DisableTotpRequest,
	type EmptiedTrash,
	type Health,
	type Invite,
	type Kdf,
	type LoginRequest,
	type MoveNodeRequest,
	type Node,
	type NodePage,
	type Profile,
	type RecoveryCodes,
	type RegisterRequest,
	type RekeyRequest,
	type RestoreVersionRequest,
	type ServerSettings,
	type SessionKey,
	type SetupInfo,
	type SetupRequest,
	type SmallBlob,
	type SmallBlobKind,
	type SmallBlobPage,
	type Storage,
	type Suite,
	type TotpEnrolment,
	type UpdateNodeRequest,
	type UpdateSettingsRequest,
	type UpdateUserRequest,
	type Upload,
	type UserKeys,
	type ValidatedUrl,
	type Version,
	type VersionPage
} from './types';

const base = '/api/v1';

interface Options {
	body?: unknown;
	/** Bytes sent as they are, for a frame or a small blob. */
	bytes?: Uint8Array<ArrayBuffer>;
	/** The padded base64 SHA-256 that goes with `bytes`. */
	sha256?: string;
	range?: string;
	signal?: AbortSignal;
	/** The one-time token every call of the wizard carries. */
	setupToken?: string;
}

/** A query string of the values that are set, or nothing. */
function query(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined) search.set(name, String(value));
	}
	const text = search.toString();
	return text === '' ? '' : `?${text}`;
}

/** Where a paged list goes on from. */
export interface PageOptions {
	cursor?: string;
	limit?: number;
}

/** Builds the client over a `fetch`; tests pass their own. */
export function createApi(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
	async function send(method: string, path: string, options: Options = {}): Promise<Response> {
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (options.body !== undefined) headers['Content-Type'] = 'application/json';
		if (options.setupToken !== undefined) headers['X-Setup-Token'] = options.setupToken;
		if (options.bytes !== undefined) headers['Content-Type'] = 'application/octet-stream';
		if (options.sha256 !== undefined) headers['X-Content-SHA256'] = options.sha256;
		if (options.range !== undefined) headers['Range'] = options.range;
		let res: Response;
		try {
			res = await fetcher(`${base}${path}`, {
				method,
				headers,
				signal: options.signal,
				body:
					options.bytes ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
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
		deleteUser: (userId: string, body: CurrentCredential) =>
			empty('DELETE', `/admin/users/${id(userId)}`, { body }),
		createPasswordReset: (userId: string, body: CurrentCredential) =>
			json<CreatedPasswordReset>('POST', `/admin/users/${id(userId)}/password-reset`, { body }),
		getSettings: () => json<ServerSettings>('GET', '/admin/settings'),
		updateSettings: (body: UpdateSettingsRequest) =>
			json<ServerSettings>('PATCH', '/admin/settings', { body }),
		getAdminHealth: () => json<AdminHealth>('GET', '/admin/health'),

		getMyStorage: () => json<Storage>('GET', '/me/storage'),
		getRootNode: () => json<Node>('GET', '/nodes/root'),
		createRootNode: (body: CreateRootRequest) => json<Node>('POST', '/nodes/root', { body }),
		createNode: (body: CreateNodeRequest) => json<Node>('POST', '/nodes', { body }),
		getNode: (nodeId: string) => json<Node>('GET', `/nodes/${id(nodeId)}`),
		updateNode: (nodeId: string, body: UpdateNodeRequest) =>
			json<Node>('PATCH', `/nodes/${id(nodeId)}`, { body }),
		listChildren: (nodeId: string, page: PageOptions = {}) =>
			json<NodePage>('GET', `/nodes/${id(nodeId)}/children${query({ ...page })}`),
		moveNode: (nodeId: string, body: MoveNodeRequest) =>
			json<Node>('POST', `/nodes/${id(nodeId)}/move`, { body }),
		trashNode: (nodeId: string) => json<Node>('POST', `/nodes/${id(nodeId)}/trash`),
		restoreNode: (nodeId: string) => json<Node>('POST', `/nodes/${id(nodeId)}/restore`),
		purgeNode: (nodeId: string) => json<Node>('POST', `/nodes/${id(nodeId)}/purge`),
		listTrash: (page: PageOptions = {}) => json<NodePage>('GET', `/trash${query({ ...page })}`),
		emptyTrash: () => json<EmptiedTrash>('POST', '/trash/empty'),

		listVersions: (nodeId: string, page: PageOptions = {}) =>
			json<VersionPage>('GET', `/nodes/${id(nodeId)}/versions${query({ ...page })}`),
		getVersion: (nodeId: string, versionId: string) =>
			json<Version>('GET', `/nodes/${id(nodeId)}/versions/${id(versionId)}`),
		deleteVersion: (nodeId: string, versionId: string) =>
			json<Version>('DELETE', `/nodes/${id(nodeId)}/versions/${id(versionId)}`),
		restoreVersion: (nodeId: string, versionId: string, body: RestoreVersionRequest) =>
			json<Version>('POST', `/nodes/${id(nodeId)}/versions/${id(versionId)}/restore`, { body }),

		createUpload: (body: CreateUploadRequest) => json<Upload>('POST', '/uploads', { body }),
		getUpload: (uploadId: string) => json<Upload>('GET', `/uploads/${id(uploadId)}`),
		abortUpload: (uploadId: string) => empty('DELETE', `/uploads/${id(uploadId)}`),
		putFrame: (
			uploadId: string,
			index: number,
			bytes: Uint8Array<ArrayBuffer>,
			sha256: string,
			signal?: AbortSignal
		) => empty('PUT', `/uploads/${id(uploadId)}/frames/${index}`, { bytes, sha256, signal }),
		commitUpload: (uploadId: string, body: CommitUploadRequest) =>
			json<Version>('POST', `/uploads/${id(uploadId)}/commit`, { body }),

		/** The stored bytes, or the part of them `range` asks for. */
		getBlob: async (
			blobId: string,
			range?: { start: number; end: number },
			signal?: AbortSignal
		): Promise<Uint8Array<ArrayBuffer>> => {
			const res = await send('GET', `/blobs/${id(blobId)}`, {
				range: range && `bytes=${range.start}-${range.end}`,
				signal
			});
			try {
				return new Uint8Array(await res.arrayBuffer());
			} catch {
				throw new ApiError(0, 'network');
			}
		},
		putSmallBlob: (
			blobId: string,
			params: { kind: SmallBlobKind; suite: Suite; node_id?: string },
			bytes: Uint8Array<ArrayBuffer>,
			sha256: string
		) => json<SmallBlob>('PUT', `/blobs/${id(blobId)}${query({ ...params })}`, { bytes, sha256 }),
		deleteSmallBlob: (blobId: string) => empty('DELETE', `/blobs/${id(blobId)}`),
		listIndexBlobs: (page: PageOptions = {}) =>
			json<SmallBlobPage>('GET', `/me/index${query({ ...page })}`),

		listChanges: (page: PageOptions = {}) =>
			json<ChangePage>('GET', `/changes${query({ ...page })}`)
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
