import type { components } from './schema';

type Schemas = components['schemas'];

export type Health = Schemas['Health'];
export type Mode = Schemas['Mode'];
export type Role = Schemas['Role'];
export type Kdf = Schemas['KDF'];
export type Account = Schemas['Account'];
export type AccountKeys = Schemas['AccountKeys'];
export type NewAccount = Schemas['NewAccount'];
export type Profile = Schemas['Profile'];
export type CreatedUser = Schemas['CreatedUser'];
export type SetupInfo = Schemas['SetupInfo'];
export type ValidatedUrl = Schemas['ValidatedURL'];
export type SetupRequest = Schemas['SetupRequest'];
export type ServerSettingsInput = Schemas['ServerSettingsInput'];
export type LoginRequest = Schemas['LoginRequest'];
export type RegisterRequest = Schemas['RegisterRequest'];
export type RekeyRequest = Schemas['RekeyRequest'];
export type SessionKey = Schemas['SessionKey'];
export type UserKeys = Schemas['UserKeys'];
export type Invite = Schemas['Invite'];
export type CreateInviteRequest = Schemas['CreateInviteRequest'];
export type CreatedInvite = Schemas['CreatedInvite'];
export type CurrentCredential = Schemas['CurrentCredential'];
export type TotpEnrolment = Schemas['TOTPEnrolment'];
export type ConfirmTotpRequest = Schemas['ConfirmTOTPRequest'];
export type RecoveryCodes = Schemas['RecoveryCodes'];
export type DisableTotpRequest = Schemas['DisableTOTPRequest'];
export type DeviceToken = Schemas['DeviceToken'];
export type CreateTokenRequest = Schemas['CreateTokenRequest'];
export type CreatedToken = Schemas['CreatedToken'];
export type UpdateUserRequest = Schemas['UpdateUserRequest'];
export type CreatedPasswordReset = Schemas['CreatedPasswordReset'];
export type CompletePasswordResetRequest = Schemas['CompletePasswordResetRequest'];
export type ServerSettings = Schemas['ServerSettings'];
export type UpdateSettingsRequest = Schemas['UpdateSettingsRequest'];
export type AdminHealth = Schemas['AdminHealth'];
export type Storage = Schemas['Storage'];
export type Suite = Schemas['Suite'];
export type NodeKind = Schemas['NodeKind'];
export type Node = Schemas['Node'];
export type NodePage = Schemas['NodePage'];
export type CreateRootRequest = Schemas['CreateRootRequest'];
export type CreateNodeRequest = Schemas['CreateNodeRequest'];
export type UpdateNodeRequest = Schemas['UpdateNodeRequest'];
export type MoveNodeRequest = Schemas['MoveNodeRequest'];
export type EmptiedTrash = Schemas['EmptiedTrash'];
export type VersionSummary = Schemas['VersionSummary'];
export type Version = Schemas['Version'];
export type VersionPage = Schemas['VersionPage'];
export type RestoreVersionRequest = Schemas['RestoreVersionRequest'];
export type CreateUploadRequest = Schemas['CreateUploadRequest'];
export type Upload = Schemas['Upload'];
export type CommitUploadRequest = Schemas['CommitUploadRequest'];
export type SmallBlobKind = Schemas['SmallBlobKind'];
export type SmallBlob = Schemas['SmallBlob'];
export type SmallBlobPage = Schemas['SmallBlobPage'];
export type Change = Schemas['Change'];
export type ChangeOp = Schemas['ChangeOp'];
export type ChangePage = Schemas['ChangePage'];

/** The JSON body of every failed response. */
export type ErrorBody = Schemas['Error'];

/**
 * The stable codes the account flows act on, as listed on the `Error` schema.
 * `network` is ours, for a request that never got an answer, and `unknown` for
 * an answer that does not carry a code, such as a proxy's error page. Any other
 * code passes through as it is, for the screen that knows it.
 */
export type ErrorCode =
	| 'bad_request'
	| 'forbidden'
	| 'not_found'
	| 'internal'
	| 'too_large'
	| 'rate_limited'
	| 'setup_token_invalid'
	| 'already_setup'
	| 'not_setup'
	| 'invalid_username'
	| 'invalid_email'
	| 'invalid_kdf'
	| 'invalid_auth_key'
	| 'invalid_keys'
	| 'invalid_settings'
	| 'invalid_public_url'
	| 'invalid_mode'
	| 'keys_required'
	| 'keys_not_allowed'
	| 'username_taken'
	| 'email_taken'
	| 'unauthorized'
	| 'invalid_credentials'
	| 'wrong_credential'
	| 'invalid_rekey'
	| 'user_disabled'
	| 'invite_invalid'
	| 'signup_closed'
	| 'invalid_invite'
	| 'invalid_session_key'
	| 'no_session_key'
	| 'no_keys'
	| 'totp_required'
	| 'totp_invalid'
	| 'totp_already_enabled'
	| 'totp_not_pending'
	| 'totp_not_enabled'
	| 'invalid_token_name'
	| 'session_required'
	| 'cannot_modify_self'
	| 'invalid_quota'
	| 'wrong_mode'
	| 'reset_invalid'
	| 'invalid_id'
	| 'id_taken'
	| 'suite_mismatch'
	| 'invalid_node'
	| 'name_conflict'
	| 'not_a_folder'
	| 'not_a_file'
	| 'move_cycle'
	| 'tree_too_deep'
	| 'root_immutable'
	| 'node_trashed'
	| 'parent_trashed'
	| 'not_trashed'
	| 'version_conflict'
	| 'version_current'
	| 'invalid_framing'
	| 'invalid_frame'
	| 'frame_length'
	| 'frame_hash'
	| 'frame_conflict'
	| 'invalid_commit'
	| 'upload_incomplete'
	| 'quota_exceeded'
	| 'storage_full'
	| 'invalid_blob'
	| 'blob_in_use'
	| 'invalid_cursor'
	| 'network'
	| 'unknown'
	| (string & {});

/** A code off the wire; anything that is not a code at all is `unknown`. */
export function parseErrorCode(value: unknown): ErrorCode {
	return typeof value === 'string' && value !== '' ? value : 'unknown';
}

/** A failed call: the server's stable error code, never a message. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: ErrorCode
	) {
		super(`${status} ${code}`);
		this.name = 'ApiError';
	}
}

/** Whether `e` is a failed call answered with one of `codes`. */
export function isApiError(e: unknown, ...codes: readonly ErrorCode[]): e is ApiError {
	return e instanceof ApiError && codes.includes(e.code);
}
