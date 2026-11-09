package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// Error codes sent to the client as {"code":"<code>"}. They are stable
// identifiers, never free-form messages: an internal error must not describe
// the state of the server. The specification lists them.
const (
	codeBadRequest         = "bad_request"
	codeForbidden          = "forbidden"
	codeNotFound           = "not_found"
	codeInternal           = "internal"
	codeTooLarge           = "too_large"
	codeRateLimited        = "rate_limited"
	codeSetupTokenInvalid  = "setup_token_invalid" //nolint:gosec // an error code, not a secret
	codeAlreadySetup       = "already_setup"
	codeNotSetup           = "not_setup"
	codeInvalidUsername    = "invalid_username"
	codeInvalidEmail       = "invalid_email"
	codeInvalidKDF         = "invalid_kdf"
	codeInvalidAuthKey     = "invalid_auth_key"
	codeInvalidKeys        = "invalid_keys"
	codeInvalidSettings    = "invalid_settings"
	codeInvalidPublicURL   = "invalid_public_url"
	codeInvalidMode        = "invalid_mode"
	codeKeysRequired       = "keys_required"
	codeKeysNotAllowed     = "keys_not_allowed"
	codeUsernameTaken      = "username_taken"
	codeEmailTaken         = "email_taken"
	codeUnauthorized       = "unauthorized"
	codeInvalidCredentials = "invalid_credentials" //nolint:gosec // an error code, not a secret
	codeWrongCredential    = "wrong_credential"    //nolint:gosec // an error code, not a secret
	codeInvalidRekey       = "invalid_rekey"
	codeUserDisabled       = "user_disabled"
	codeInviteInvalid      = "invite_invalid"
	codeSignupClosed       = "signup_closed"
	codeInvalidInvite      = "invalid_invite"
	codeInvalidSessionKey  = "invalid_session_key"
	codeNoSessionKey       = "no_session_key"
	codeNoKeys             = "no_keys"
	codeTOTPRequired       = "totp_required"
	codeTOTPInvalid        = "totp_invalid"
	codeTOTPAlreadyEnabled = "totp_already_enabled"
	codeTOTPNotPending     = "totp_not_pending"
	codeTOTPNotEnabled     = "totp_not_enabled"
	codeInvalidTokenName   = "invalid_token_name" //nolint:gosec // an error code, not a secret
	codeSessionRequired    = "session_required"
	codeCannotModifySelf   = "cannot_modify_self"
	codeInvalidQuota       = "invalid_quota"
	codeWrongMode          = "wrong_mode"
	codeResetInvalid       = "reset_invalid"
	codeInvalidID          = "invalid_id"
	codeIDTaken            = "id_taken"
	codeSuiteMismatch      = "suite_mismatch"
	codeInvalidNode        = "invalid_node"
	codeNameConflict       = "name_conflict"
	codeNotAFolder         = "not_a_folder"
	codeNotAFile           = "not_a_file"
	codeMoveCycle          = "move_cycle"
	codeTreeTooDeep        = "tree_too_deep"
	codeRootImmutable      = "root_immutable"
	codeNodeTrashed        = "node_trashed"
	codeParentTrashed      = "parent_trashed"
	codeNotTrashed         = "not_trashed"
	codeVersionConflict    = "version_conflict"
	codeVersionCurrent     = "version_current"
	codeInvalidFraming     = "invalid_framing"
	codeInvalidFrame       = "invalid_frame"
	codeFrameLength        = "frame_length"
	codeFrameHash          = "frame_hash"
	codeFrameConflict      = "frame_conflict"
	codeInvalidCommit      = "invalid_commit"
	codeUploadIncomplete   = "upload_incomplete"
	codeTooManyUploads     = "too_many_uploads"
	codeQuotaExceeded      = "quota_exceeded"
	codeStorageFull        = "storage_full"
	codeInvalidBlob        = "invalid_blob"
	codeBlobInUse          = "blob_in_use"
	codeSSODisabled        = "sso_disabled"
	codeSSOOnly            = "sso_only"
	codeLocalDisabled      = "local_accounts_disabled"
	codeLocalLockout       = "local_accounts_lockout"
	codeAlreadyEnrolled    = "already_enrolled"
	codeTOTPLocalOnly      = "totp_local_only"
	codeReauthRequired     = "reauth_required"
	codeInvalidIssuer      = "invalid_issuer"
	codeInvalidOIDC        = "invalid_oidc_settings"
	codeOIDCDiscovery      = "oidc_discovery_failed"
	codeOIDCIssuerMismatch = "oidc_issuer_mismatch"
	codeOIDCKeys           = "oidc_keys_failed"
	codeSSOState           = "sso_state_invalid"
	codeSSODenied          = "sso_denied"
	codeSSOProvider        = "sso_provider_error"
	codeSSOToken           = "sso_token_invalid" //nolint:gosec // an error code, not a secret
	codeSSOConflict        = "sso_identity_conflict"
	codeNotRelinkable      = "identity_not_relinkable"
	codeSSOUnverified      = "sso_email_unverified"
	codeSSONotInvited      = "sso_not_invited"
	codeSSOReauth          = "sso_reauth_unconfirmed"
	codeInvalidCursor      = "invalid_cursor"
	codeCursorExpired      = "cursor_expired"

	codeMoveRefused           = "move_refused"
	codeKeyGenerationConflict = "key_generation_conflict"
	codeRotateConflict        = "rotate_conflict"
	codeInvalidRotation       = "invalid_rotation"
	codeGrantExists           = "grant_exists"
	codeInvalidGrant          = "invalid_grant"
	codeInvalidLink           = "invalid_link"
	codeLinkExpired           = "link_expired"
	codeLinkRevoked           = "link_revoked"
	codeLinkLimitReached      = "link_limit_reached"
	codeLinkTokenRequired     = "link_token_required"   //nolint:gosec // an error code, not a secret
	codeLinkTokenInvalid      = "link_token_invalid"    //nolint:gosec // an error code, not a secret
	codeLinkPasswordInvalid   = "link_password_invalid" //nolint:gosec // an error code, not a secret
	codeRequestFileTooLarge   = "request_file_too_large"
	codeRequestFilesReached   = "request_files_reached"
	codeRequestBytesReached   = "request_bytes_reached"
	codeInvalidComment        = "invalid_comment"
	codeCommentTooLarge       = "comment_too_large"
	codeCommentLimitReached   = "comment_limit_reached"
	codeCommentHasReplies     = "comment_has_replies"
)

type errorBody struct {
	Code string `json:"code"`
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, errorBody{Code: code})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// apiError is a failure a handler answers with: handlers return it as an error
// and the response error handler writes it. Anything else is a 500.
type apiError struct {
	status int
	code   string
}

func (e *apiError) Error() string { return fmt.Sprintf("%d %s", e.status, e.code) }

func fail(status int, code string) error { return &apiError{status: status, code: code} }

func badRequest(code string) error { return fail(http.StatusBadRequest, code) }

// writeFailure answers with err if it is an apiError or an oversized body, and
// reports whether it did.
func writeFailure(w http.ResponseWriter, err error) bool {
	var api *apiError
	if errors.As(err, &api) {
		writeError(w, api.status, api.code)
		return true
	}
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeError(w, http.StatusRequestEntityTooLarge, codeTooLarge)
		return true
	}
	return false
}
