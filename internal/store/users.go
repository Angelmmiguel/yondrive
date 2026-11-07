package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Credentials is what an account signs in and unlocks with, as the server
// holds it: hashes of the auth keys, the KDF parameters, and blobs it cannot
// read. In no-encryption mode everything after KDF is empty.
type Credentials struct {
	AuthKeyHash []byte
	// UnlockAuthKeyHash is that of a single sign-on account's unlock passphrase. It
	// proves a current credential and never signs in.
	UnlockAuthKeyHash        []byte
	KDF                      []byte
	RecoveryAuthKeyHash      []byte
	WrappedMasterKey         []byte
	WrappedMasterKeyRecovery []byte
	SealedX25519             []byte
	SealedEd25519            []byte
	PublicKeyX25519          []byte
	PublicKeyEd25519         []byte
}

// User is an account.
type User struct {
	ID         string
	Username   string
	Email      string
	Role       string
	QuotaBytes int64
	Credentials
	TOTPSecret   []byte
	TOTPEnabled  bool
	TOTPLastStep int64
	Disabled     bool
	CreatedAt    time.Time
	// OIDCIssuer and OIDCSubject are the identity at a provider, if linked.
	OIDCIssuer  string
	OIDCSubject string
}

// HasIdentity reports whether the account is linked to a provider identity.
func (u User) HasIdentity() bool { return u.OIDCSubject != "" }

// SSOOnly reports whether the account has no passphrase to sign in with. It stays so
// while its identity is unlinked, as it has still only ever had a provider.
func (u User) SSOOnly() bool { return u.AuthKeyHash == nil }

// CurrentCredentialHash is the hash of the passphrase's auth key, whichever kind the
// account has. The recovery auth key's is apart.
func (u User) CurrentCredentialHash() []byte {
	if u.AuthKeyHash != nil {
		return u.AuthKeyHash
	}
	return u.UnlockAuthKeyHash
}

// CredentialUpdate replaces the credentials whose fields are not nil.
type CredentialUpdate struct {
	AuthKeyHash              []byte
	UnlockAuthKeyHash        []byte
	KDF                      []byte
	WrappedMasterKey         []byte
	RecoveryAuthKeyHash      []byte
	WrappedMasterKeyRecovery []byte
}

const userColumns = `id, username, coalesce(email, ''), role, quota_bytes, kdf, auth_key_hash,
	recovery_auth_key_hash, wrapped_master_key, wrapped_master_key_recovery, sealed_x25519, sealed_ed25519,
	public_key_x25519, public_key_ed25519, totp_secret, totp_enabled_at IS NOT NULL, totp_last_step,
	disabled_at IS NOT NULL, created_at, unlock_auth_key_hash, coalesce(oidc_issuer, ''), coalesce(oidc_subject, '')`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	var created int64
	err := row.Scan(&u.ID, &u.Username, &u.Email, &u.Role, &u.QuotaBytes, &u.KDF, &u.AuthKeyHash,
		&u.RecoveryAuthKeyHash, &u.WrappedMasterKey, &u.WrappedMasterKeyRecovery, &u.SealedX25519, &u.SealedEd25519,
		&u.PublicKeyX25519, &u.PublicKeyEd25519, &u.TOTPSecret, &u.TOTPEnabled, &u.TOTPLastStep,
		&u.Disabled, &created, &u.UnlockAuthKeyHash, &u.OIDCIssuer, &u.OIDCSubject)
	u.CreatedAt = time.Unix(created, 0).UTC()
	return u, err
}

// insertUser writes u inside tx, refusing a taken username or email. Writes
// are serialised, so checking first cannot race.
func insertUser(ctx context.Context, tx *sql.Tx, u User) error {
	var exists int
	err := tx.QueryRowContext(ctx, "SELECT 1 FROM users WHERE username = ?", u.Username).Scan(&exists)
	if err == nil {
		return ErrUsernameTaken
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("store: check username: %w", err)
	}
	if u.Email != "" {
		err := tx.QueryRowContext(ctx, "SELECT 1 FROM users WHERE lower(email) = lower(?)", u.Email).Scan(&exists)
		if err == nil {
			return ErrEmailTaken
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: check email: %w", err)
		}
	}
	if u.HasIdentity() {
		err := tx.QueryRowContext(ctx, "SELECT 1 FROM users WHERE oidc_issuer = ? AND oidc_subject = ?", u.OIDCIssuer, u.OIDCSubject).Scan(&exists)
		if err == nil {
			return ErrIdentityTaken
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: check identity: %w", err)
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO users (id, username, email, role, quota_bytes, kdf, auth_key_hash,
		recovery_auth_key_hash, wrapped_master_key, wrapped_master_key_recovery, sealed_x25519, sealed_ed25519,
		public_key_x25519, public_key_ed25519, created_at, oidc_issuer, oidc_subject)
		VALUES (?, ?, nullif(?, ''), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, nullif(?, ''), nullif(?, ''))`,
		u.ID, u.Username, u.Email, u.Role, u.QuotaBytes, u.KDF, u.AuthKeyHash,
		u.RecoveryAuthKeyHash, u.WrappedMasterKey, u.WrappedMasterKeyRecovery, u.SealedX25519, u.SealedEd25519,
		u.PublicKeyX25519, u.PublicKeyEd25519, u.CreatedAt.Unix(), u.OIDCIssuer, u.OIDCSubject)
	if err != nil {
		return fmt.Errorf("store: insert user: %w", err)
	}
	return nil
}

// CreateUser adds a user. A non-empty inviteID is consumed in the same
// transaction, failing with ErrInviteInvalid if it is used or expired at now.
func (s *Store) CreateUser(ctx context.Context, u User, inviteID string, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := insertUser(ctx, tx, u); err != nil {
			return err
		}
		if inviteID == "" {
			return nil
		}
		res, err := tx.ExecContext(ctx,
			"UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?",
			now.Unix(), u.ID, inviteID, now.Unix())
		if err != nil {
			return fmt.Errorf("store: consume invite: %w", err)
		}
		return requireRow(res, ErrInviteInvalid)
	})
}

// UserByID returns a user, or ErrNotFound.
func (s *Store) UserByID(ctx context.Context, id string) (User, error) {
	return s.oneUser(ctx, "id = ?", id)
}

// UserByUsername returns a user, or ErrNotFound.
func (s *Store) UserByUsername(ctx context.Context, username string) (User, error) {
	return s.oneUser(ctx, "username = ?", username)
}

func (s *Store) oneUser(ctx context.Context, where string, arg string) (User, error) {
	u, err := scanUser(s.read.QueryRowContext(ctx, "SELECT "+userColumns+" FROM users WHERE "+where, arg))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("store: read user: %w", err)
	}
	return u, nil
}

// ListUsers returns every user, ordered by username.
func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT "+userColumns+" FROM users ORDER BY username")
	if err != nil {
		return nil, fmt.Errorf("store: list users: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var users []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list users: %w", err)
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list users: %w", err)
	}
	return users, nil
}

// SetQuota sets a user's quota, or fails with ErrNotFound.
func (s *Store) SetQuota(ctx context.Context, userID string, quotaBytes int64) error {
	return s.updateUser(ctx, "UPDATE users SET quota_bytes = ? WHERE id = ?", quotaBytes, userID)
}

// EnableUser clears a user's disabled flag, or fails with ErrNotFound.
func (s *Store) EnableUser(ctx context.Context, userID string) error {
	return s.updateUser(ctx, "UPDATE users SET disabled_at = NULL WHERE id = ?", userID)
}

func (s *Store) updateUser(ctx context.Context, query string, args ...any) error {
	res, err := s.write.ExecContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("store: update user: %w", err)
	}
	return requireRow(res, ErrNotFound)
}

// DisableUser marks a user disabled and ends their sessions and tokens in one
// transaction. It returns the hashes of the sessions it ended.
func (s *Store) DisableUser(ctx context.Context, userID string, now time.Time) ([][]byte, error) {
	var revoked [][]byte
	err := s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			"UPDATE users SET disabled_at = coalesce(disabled_at, ?) WHERE id = ?", now.Unix(), userID)
		if err != nil {
			return fmt.Errorf("store: disable user: %w", err)
		}
		if err := requireRow(res, ErrNotFound); err != nil {
			return err
		}
		revoked, err = revokeUserAccess(ctx, tx, userID, nil, "")
		return err
	})
	return revoked, err
}

// DeleteUser removes a user and, by cascade, everything that hangs off the
// account. It returns the hashes of the sessions that ended with it.
func (s *Store) DeleteUser(ctx context.Context, userID string) ([][]byte, error) {
	var revoked [][]byte
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		if revoked, err = revokeUserAccess(ctx, tx, userID, nil, ""); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, "DELETE FROM users WHERE id = ?", userID)
		if err != nil {
			return fmt.Errorf("store: delete user: %w", err)
		}
		return requireRow(res, ErrNotFound)
	})
	return revoked, err
}

// UpdateCredentials replaces credentials and ends the user's other sessions
// and tokens in one transaction, so no failure can leave old access next to
// new keys. keepSession and keepToken name the access that survives, if any.
// It returns the hashes of the sessions it ended.
func (s *Store) UpdateCredentials(ctx context.Context, userID string, up CredentialUpdate, keepSession []byte, keepToken string) ([][]byte, error) {
	var revoked [][]byte
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := updateCredentials(ctx, tx, userID, up); err != nil {
			return err
		}
		var err error
		revoked, err = revokeUserAccess(ctx, tx, userID, keepSession, keepToken)
		return err
	})
	return revoked, err
}

func updateCredentials(ctx context.Context, tx *sql.Tx, userID string, up CredentialUpdate) error {
	res, err := tx.ExecContext(ctx, `UPDATE users SET
		auth_key_hash = coalesce(?, auth_key_hash),
		unlock_auth_key_hash = coalesce(?, unlock_auth_key_hash),
		kdf = coalesce(?, kdf),
		wrapped_master_key = coalesce(?, wrapped_master_key),
		recovery_auth_key_hash = coalesce(?, recovery_auth_key_hash),
		wrapped_master_key_recovery = coalesce(?, wrapped_master_key_recovery)
		WHERE id = ?`,
		up.AuthKeyHash, up.UnlockAuthKeyHash, up.KDF, up.WrappedMasterKey, up.RecoveryAuthKeyHash, up.WrappedMasterKeyRecovery, userID)
	if err != nil {
		return fmt.Errorf("store: update credentials: %w", err)
	}
	return requireRow(res, ErrNotFound)
}

// revokeUserAccess deletes a user's sessions and tokens, except those named,
// and returns the hashes of the sessions it deleted.
func revokeUserAccess(ctx context.Context, tx *sql.Tx, userID string, keepSession []byte, keepToken string) ([][]byte, error) {
	if keepSession == nil {
		keepSession = []byte{}
	}
	rows, err := tx.QueryContext(ctx,
		"DELETE FROM sessions WHERE user_id = ? AND hash <> ? RETURNING hash", userID, keepSession)
	if err != nil {
		return nil, fmt.Errorf("store: revoke sessions: %w", err)
	}
	revoked, err := scanHashes(rows)
	if err != nil {
		return nil, fmt.Errorf("store: revoke sessions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM tokens WHERE user_id = ? AND id <> ?", userID, keepToken); err != nil {
		return nil, fmt.Errorf("store: revoke tokens: %w", err)
	}
	return revoked, nil
}

func scanHashes(rows *sql.Rows) ([][]byte, error) {
	defer func() { _ = rows.Close() }()
	var hashes [][]byte
	for rows.Next() {
		var h []byte
		if err := rows.Scan(&h); err != nil {
			return nil, err
		}
		hashes = append(hashes, h)
	}
	return hashes, rows.Err()
}

// requireRow turns an update that touched nothing into notFound.
func requireRow(res sql.Result, notFound error) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: rows affected: %w", err)
	}
	if n == 0 {
		return notFound
	}
	return nil
}
