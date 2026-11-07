package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Errors of single sign-on accounts. Callers match them with errors.Is.
var (
	// ErrIdentityTaken means the account, or the identity, is already linked.
	ErrIdentityTaken = errors.New("store: identity is already linked")
	// ErrAlreadyEnrolled means the account has its keys.
	ErrAlreadyEnrolled = errors.New("store: account already has keys")
)

// UserByIdentity returns the user with an identity at a provider, or ErrNotFound.
func (s *Store) UserByIdentity(ctx context.Context, issuer, subject string) (User, error) {
	u, err := scanUser(s.read.QueryRowContext(ctx,
		"SELECT "+userColumns+" FROM users WHERE oidc_issuer = ? AND oidc_subject = ?", issuer, subject))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("store: read user: %w", err)
	}
	return u, nil
}

// UserByEmail returns the user with an address, in any case, or ErrNotFound.
func (s *Store) UserByEmail(ctx context.Context, email string) (User, error) {
	return s.oneUser(ctx, "lower(email) = lower(?)", email)
}

// LinkIdentity gives an account with no identity one. It fails with
// ErrIdentityTaken if the account already has one or the identity is someone's.
func (s *Store) LinkIdentity(ctx context.Context, userID, issuer, subject string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var exists int
		err := tx.QueryRowContext(ctx, "SELECT 1 FROM users WHERE oidc_issuer = ? AND oidc_subject = ?", issuer, subject).Scan(&exists)
		if err == nil {
			return ErrIdentityTaken
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: read identity: %w", err)
		}
		res, err := tx.ExecContext(ctx,
			"UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ? AND oidc_issuer IS NULL", issuer, subject, userID)
		if err != nil {
			return fmt.Errorf("store: link identity: %w", err)
		}
		return requireRow(res, ErrIdentityTaken)
	})
}

// UnlinkIdentity forgets an account's identity and ends its sessions and tokens,
// returning the hashes of the sessions. It fails with ErrNotFound if the account has
// no identity.
func (s *Store) UnlinkIdentity(ctx context.Context, userID string) ([][]byte, error) {
	var revoked [][]byte
	err := s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			"UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE id = ? AND oidc_issuer IS NOT NULL", userID)
		if err != nil {
			return fmt.Errorf("store: unlink identity: %w", err)
		}
		if err := requireRow(res, ErrNotFound); err != nil {
			return err
		}
		revoked, err = revokeUserAccess(ctx, tx, userID, nil, "")
		return err
	})
	return revoked, err
}

// SetRole changes a user's role, or fails with ErrNotFound.
func (s *Store) SetRole(ctx context.Context, userID, role string) error {
	return s.updateUser(ctx, "UPDATE users SET role = ? WHERE id = ?", role, userID)
}

// Enrol stores the keys of an account that has none, and fails with
// ErrAlreadyEnrolled otherwise: the condition is what makes this happen once.
func (s *Store) Enrol(ctx context.Context, userID string, c Credentials) error {
	res, err := s.write.ExecContext(ctx, `UPDATE users SET kdf = ?, unlock_auth_key_hash = ?, recovery_auth_key_hash = ?,
		wrapped_master_key = ?, wrapped_master_key_recovery = ?, sealed_x25519 = ?, sealed_ed25519 = ?,
		public_key_x25519 = ?, public_key_ed25519 = ?
		WHERE id = ? AND wrapped_master_key IS NULL AND auth_key_hash IS NULL`,
		c.KDF, c.UnlockAuthKeyHash, c.RecoveryAuthKeyHash, c.WrappedMasterKey, c.WrappedMasterKeyRecovery,
		c.SealedX25519, c.SealedEd25519, c.PublicKeyX25519, c.PublicKeyEd25519, userID)
	if err != nil {
		return fmt.Errorf("store: enrol: %w", err)
	}
	return requireRow(res, ErrAlreadyEnrolled)
}

// LocalAdmins returns the ids of the enabled admins who can sign in with a
// passphrase, oldest first. The first is the fallback admin, who is never demoted
// and can always sign in, as the way back in when the provider is down.
func (s *Store) LocalAdmins(ctx context.Context) ([]string, error) {
	rows, err := s.read.QueryContext(ctx, `SELECT id FROM users
		WHERE role = 'admin' AND auth_key_hash IS NOT NULL AND disabled_at IS NULL ORDER BY created_at, rowid`)
	if err != nil {
		return nil, fmt.Errorf("store: list local admins: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("store: list local admins: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list local admins: %w", err)
	}
	return ids, nil
}

// CountAdmins returns how many enabled admins there are of any kind.
func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.read.QueryRowContext(ctx, "SELECT count(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL").Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("store: count admins: %w", err)
	}
	return n, nil
}

// InviteByID returns an invite, or ErrNotFound.
func (s *Store) InviteByID(ctx context.Context, id string) (Invite, error) {
	inv, err := scanInvite(s.read.QueryRowContext(ctx, "SELECT "+inviteColumns+" FROM invites WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return Invite{}, ErrNotFound
	}
	if err != nil {
		return Invite{}, fmt.Errorf("store: read invite: %w", err)
	}
	return inv, nil
}

// OpenInviteForEmail returns the newest unused invite for an address, or ErrNotFound.
func (s *Store) OpenInviteForEmail(ctx context.Context, email string, now time.Time) (Invite, error) {
	inv, err := scanInvite(s.read.QueryRowContext(ctx, "SELECT "+inviteColumns+
		" FROM invites WHERE lower(email) = lower(?) AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC, id LIMIT 1", email, now.Unix()))
	if errors.Is(err, sql.ErrNoRows) {
		return Invite{}, ErrNotFound
	}
	if err != nil {
		return Invite{}, fmt.Errorf("store: read invite: %w", err)
	}
	return inv, nil
}
