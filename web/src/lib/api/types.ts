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
export type Editing = Schemas['Editing'];
export type Editor = Schemas['Editor'];
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
export type NodeRole = Schemas['NodeRole'];
export type GrantRole = Schemas['GrantRole'];
export type Grant = Schemas['Grant'];
export type GrantedNode = Schemas['GrantedNode'];
export type GrantPage = Schemas['GrantPage'];
export type CreateGrantRequest = Schemas['CreateGrantRequest'];
export type UpdateGrantRequest = Schemas['UpdateGrantRequest'];
export type NodeAccess = Schemas['NodeAccess'];
export type NodeAccessList = Schemas['NodeAccessList'];
export type UserLookup = Schemas['UserLookup'];
export type Notification = Schemas['Notification'];
export type NotificationList = Schemas['NotificationList'];
export type MarkNotificationsReadRequest = Schemas['MarkNotificationsReadRequest'];
export type RotateNodeRequest = Schemas['RotateNodeRequest'];
export type KeyLink = Schemas['KeyLink'];
export type CreateLinkRequest = Schemas['CreateLinkRequest'];
export type Link = Schemas['Link'];
export type LinkedNode = Schemas['LinkedNode'];
export type LinkPage = Schemas['LinkPage'];
export type PublicNode = Schemas['PublicNode'];
export type PublicNodePage = Schemas['PublicNodePage'];
export type PublicLink = Schemas['PublicLink'];
export type PublicVersion = Schemas['PublicVersion'];
export type UnlockLinkRequest = Schemas['UnlockLinkRequest'];
export type AuthMethods = Schemas['AuthMethods'];
export type OidcStart = Schemas['OIDCStart'];
export type OidcStartRequest = Schemas['OIDCStartRequest'];
export type EnrolRequest = Schemas['EnrolRequest'];
export type OidcSettings = Schemas['OIDCSettings'];
export type OidcSettingsInput = Schemas['OIDCSettingsInput'];
export type OidcMatchMode = Schemas['OIDCMatchMode'];
export type OidcNewUsers = Schemas['OIDCNewUsers'];
export type SignInSettingsInput = Schemas['SignInSettingsInput'];
export type OidcTestRequest = Schemas['OIDCTestRequest'];
export type OidcTestResult = Schemas['OIDCTestResult'];
export type AuditEntry = Schemas['AuditEntry'];
export type AuditPage = Schemas['AuditPage'];
export type UploadSummary = Schemas['UploadSummary'];
export type UploadPage = Schemas['UploadPage'];

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
	| 'key_generation_conflict'
	| 'move_refused'
	| 'grant_exists'
	| 'invalid_grant'
	| 'invalid_rotation'
	| 'rotate_conflict'
	| 'invalid_link'
	| 'link_expired'
	| 'link_revoked'
	| 'link_limit_reached'
	| 'link_token_required'
	| 'link_token_invalid'
	| 'link_password_invalid'
	| 'sso_disabled'
	| 'sso_only'
	| 'local_accounts_disabled'
	| 'local_accounts_lockout'
	| 'identity_not_relinkable'
	| 'already_enrolled'
	| 'totp_local_only'
	| 'reauth_required'
	| 'invalid_issuer'
	| 'invalid_oidc_settings'
	| 'oidc_discovery_failed'
	| 'oidc_issuer_mismatch'
	| 'oidc_keys_failed'
	| 'sso_state_invalid'
	| 'sso_denied'
	| 'sso_provider_error'
	| 'sso_token_invalid'
	| 'sso_identity_conflict'
	| 'sso_email_unverified'
	| 'sso_not_invited'
	| 'cursor_expired'
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
