package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Session is a browser sign-in. Only the hash of its token is stored.
type Session struct {
	Hash       []byte
	UserID     string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	AbsoluteAt time.Time
}

// CreateSession stores a session.
func (s *Store) CreateSession(ctx context.Context, sess Session) error {
	_, err := s.write.ExecContext(ctx,
		"INSERT INTO sessions (hash, user_id, created_at, expires_at, absolute_at) VALUES (?, ?, ?, ?, ?)",
		sess.Hash, sess.UserID, sess.CreatedAt.Unix(), sess.ExpiresAt.Unix(), sess.AbsoluteAt.Unix())
	if err != nil {
		return fmt.Errorf("store: create session: %w", err)
	}
	return nil
}

// SessionByHash returns a session, or ErrNotFound. Expiry is the caller's
// concern.
func (s *Store) SessionByHash(ctx context.Context, hash []byte) (Session, error) {
	var created, expires, absolute int64
	sess := Session{Hash: hash}
	err := s.read.QueryRowContext(ctx,
		"SELECT user_id, created_at, expires_at, absolute_at FROM sessions WHERE hash = ?", hash).
		Scan(&sess.UserID, &created, &expires, &absolute)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("store: read session: %w", err)
	}
	sess.CreatedAt = time.Unix(created, 0).UTC()
	sess.ExpiresAt = time.Unix(expires, 0).UTC()
	sess.AbsoluteAt = time.Unix(absolute, 0).UTC()
	return sess, nil
}

// TouchSession moves a session's idle expiry.
func (s *Store) TouchSession(ctx context.Context, hash []byte, expiresAt time.Time) error {
	_, err := s.write.ExecContext(ctx, "UPDATE sessions SET expires_at = ? WHERE hash = ?", expiresAt.Unix(), hash)
	if err != nil {
		return fmt.Errorf("store: touch session: %w", err)
	}
	return nil
}

// DeleteSession removes a session, if it exists.
func (s *Store) DeleteSession(ctx context.Context, hash []byte) error {
	if _, err := s.write.ExecContext(ctx, "DELETE FROM sessions WHERE hash = ?", hash); err != nil {
		return fmt.Errorf("store: delete session: %w", err)
	}
	return nil
}

// DeleteExpiredSessions removes sessions past either deadline at now and
// returns their hashes.
func (s *Store) DeleteExpiredSessions(ctx context.Context, now time.Time) ([][]byte, error) {
	var hashes [][]byte
	err := s.tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx,
			"DELETE FROM sessions WHERE expires_at <= ? OR absolute_at <= ? RETURNING hash", now.Unix(), now.Unix())
		if err != nil {
			return err
		}
		hashes, err = scanHashes(rows)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("store: purge sessions: %w", err)
	}
	return hashes, nil
}

// How a token was made.
const (
	TokenOriginSettings = "settings"
	TokenOriginPairing  = "pairing"
	TokenOriginLogin    = "login"
)

// Token is a named bearer token for one device. Only its hash is stored.
type Token struct {
	ID         string
	UserID     string
	Name       string
	Platform   string // empty if not given
	Origin     string // a TokenOrigin constant
	Hash       []byte
	CreatedAt  time.Time
	LastUsedAt time.Time // zero if never used
}

// CreateToken stores a token. It fails with ErrTokenHashTaken if another token
// has the same hash.
func (s *Store) CreateToken(ctx context.Context, t Token) error {
	return s.tx(ctx, func(tx *sql.Tx) error { return insertToken(ctx, tx, t) })
}

func insertToken(ctx context.Context, tx *sql.Tx, t Token) error {
	var exists int
	err := tx.QueryRowContext(ctx, "SELECT 1 FROM tokens WHERE hash = ?", t.Hash).Scan(&exists)
	if err == nil {
		return ErrTokenHashTaken
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("store: check token hash: %w", err)
	}
	_, err = tx.ExecContext(ctx,
		"INSERT INTO tokens (id, user_id, name, platform, origin, hash, created_at) VALUES (?, ?, ?, nullif(?, ''), ?, ?, ?)",
		t.ID, t.UserID, t.Name, t.Platform, t.Origin, t.Hash, t.CreatedAt.Unix())
	if err != nil {
		return fmt.Errorf("store: create token: %w", err)
	}
	return nil
}

// CountTokens returns how many tokens a user has.
func (s *Store) CountTokens(ctx context.Context, userID string) (int, error) {
	var n int
	if err := s.read.QueryRowContext(ctx, "SELECT count(*) FROM tokens WHERE user_id = ?", userID).Scan(&n); err != nil {
		return 0, fmt.Errorf("store: count tokens: %w", err)
	}
	return n, nil
}

const tokenColumns = "id, user_id, name, coalesce(platform, ''), origin, hash, created_at, last_used_at" //nolint:gosec // column names, not a credential

func scanToken(row interface{ Scan(...any) error }) (Token, error) {
	var t Token
	var created int64
	var used sql.NullInt64
	if err := row.Scan(&t.ID, &t.UserID, &t.Name, &t.Platform, &t.Origin, &t.Hash, &created, &used); err != nil {
		return Token{}, err
	}
	t.CreatedAt = time.Unix(created, 0).UTC()
	if used.Valid {
		t.LastUsedAt = time.Unix(used.Int64, 0).UTC()
	}
	return t, nil
}

// TokenByHash returns a token, or ErrNotFound.
func (s *Store) TokenByHash(ctx context.Context, hash []byte) (Token, error) {
	t, err := scanToken(s.read.QueryRowContext(ctx, "SELECT "+tokenColumns+" FROM tokens WHERE hash = ?", hash))
	if errors.Is(err, sql.ErrNoRows) {
		return Token{}, ErrNotFound
	}
	if err != nil {
		return Token{}, fmt.Errorf("store: read token: %w", err)
	}
	return t, nil
}

// ListTokens returns a user's tokens, oldest first.
func (s *Store) ListTokens(ctx context.Context, userID string) ([]Token, error) {
	rows, err := s.read.QueryContext(ctx,
		"SELECT "+tokenColumns+" FROM tokens WHERE user_id = ? ORDER BY created_at, id", userID)
	if err != nil {
		return nil, fmt.Errorf("store: list tokens: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var tokens []Token
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list tokens: %w", err)
		}
		tokens = append(tokens, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list tokens: %w", err)
	}
	return tokens, nil
}

// TouchToken records when a token was last used.
func (s *Store) TouchToken(ctx context.Context, id string, at time.Time) error {
	if _, err := s.write.ExecContext(ctx, "UPDATE tokens SET last_used_at = ? WHERE id = ?", at.Unix(), id); err != nil {
		return fmt.Errorf("store: touch token: %w", err)
	}
	return nil
}

// DeleteToken removes one of a user's tokens, or fails with ErrNotFound.
func (s *Store) DeleteToken(ctx context.Context, userID, id string) error {
	res, err := s.write.ExecContext(ctx, "DELETE FROM tokens WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return fmt.Errorf("store: delete token: %w", err)
	}
	return requireRow(res, ErrNotFound)
}

// Invite is a one-time registration link. Only the hash of its token is
// stored.
type Invite struct {
	ID         string
	TokenHash  []byte
	Email      string
	Role       string
	QuotaBytes *int64 // nil means the server default
	CreatedBy  string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	Used       bool
}

const inviteColumns = "id, token_hash, coalesce(email, ''), role, quota_bytes, coalesce(created_by, ''), created_at, expires_at, used_at IS NOT NULL"

func scanInvite(row interface{ Scan(...any) error }) (Invite, error) {
	var inv Invite
	var quota sql.NullInt64
	var created, expires int64
	if err := row.Scan(&inv.ID, &inv.TokenHash, &inv.Email, &inv.Role, &quota, &inv.CreatedBy, &created, &expires, &inv.Used); err != nil {
		return Invite{}, err
	}
	if quota.Valid {
		inv.QuotaBytes = &quota.Int64
	}
	inv.CreatedAt = time.Unix(created, 0).UTC()
	inv.ExpiresAt = time.Unix(expires, 0).UTC()
	return inv, nil
}

// CreateInvite stores an invite.
func (s *Store) CreateInvite(ctx context.Context, inv Invite) error {
	var quota sql.NullInt64
	if inv.QuotaBytes != nil {
		quota = sql.NullInt64{Int64: *inv.QuotaBytes, Valid: true}
	}
	_, err := s.write.ExecContext(ctx, `INSERT INTO invites (id, token_hash, email, role, quota_bytes, created_by, created_at, expires_at)
		VALUES (?, ?, nullif(?, ''), ?, ?, nullif(?, ''), ?, ?)`,
		inv.ID, inv.TokenHash, inv.Email, inv.Role, quota, inv.CreatedBy, inv.CreatedAt.Unix(), inv.ExpiresAt.Unix())
	if err != nil {
		return fmt.Errorf("store: create invite: %w", err)
	}
	return nil
}

// InviteByHash returns an invite, or ErrNotFound. Whether it can still be used
// is decided when it is consumed by CreateUser.
func (s *Store) InviteByHash(ctx context.Context, hash []byte) (Invite, error) {
	inv, err := scanInvite(s.read.QueryRowContext(ctx, "SELECT "+inviteColumns+" FROM invites WHERE token_hash = ?", hash))
	if errors.Is(err, sql.ErrNoRows) {
		return Invite{}, ErrNotFound
	}
	if err != nil {
		return Invite{}, fmt.Errorf("store: read invite: %w", err)
	}
	return inv, nil
}

// ListInvites returns the invites, newest first.
func (s *Store) ListInvites(ctx context.Context) ([]Invite, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT "+inviteColumns+" FROM invites ORDER BY created_at DESC, id")
	if err != nil {
		return nil, fmt.Errorf("store: list invites: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var invites []Invite
	for rows.Next() {
		inv, err := scanInvite(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list invites: %w", err)
		}
		invites = append(invites, inv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list invites: %w", err)
	}
	return invites, nil
}

// DeleteInvite removes an invite, or fails with ErrNotFound.
func (s *Store) DeleteInvite(ctx context.Context, id string) error {
	res, err := s.write.ExecContext(ctx, "DELETE FROM invites WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("store: delete invite: %w", err)
	}
	return requireRow(res, ErrNotFound)
}

// CreatePasswordReset stores a one-time reset for a user, replacing any earlier
// one.
func (s *Store) CreatePasswordReset(ctx context.Context, hash []byte, userID string, expiresAt time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "DELETE FROM password_resets WHERE user_id = ?", userID); err != nil {
			return fmt.Errorf("store: replace password reset: %w", err)
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO password_resets (hash, user_id, expires_at) VALUES (?, ?, ?)",
			hash, userID, expiresAt.Unix())
		if err != nil {
			return fmt.Errorf("store: create password reset: %w", err)
		}
		return nil
	})
}

// ConsumePasswordReset burns a reset, applies up to its user and ends all of
// that user's sessions and tokens in one transaction. It fails with
// ErrResetInvalid if the reset is unknown or expired at now. It returns the
// user's id and the hashes of the sessions it ended.
func (s *Store) ConsumePasswordReset(ctx context.Context, hash []byte, up CredentialUpdate, now time.Time) (string, [][]byte, error) {
	var userID string
	var revoked [][]byte
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var expires int64
		err := tx.QueryRowContext(ctx, "DELETE FROM password_resets WHERE hash = ? RETURNING user_id, expires_at", hash).
			Scan(&userID, &expires)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrResetInvalid
		}
		if err != nil {
			return fmt.Errorf("store: consume password reset: %w", err)
		}
		if expires <= now.Unix() {
			return ErrResetInvalid
		}
		if err := updateCredentials(ctx, tx, userID, up); err != nil {
			return err
		}
		revoked, err = revokeUserAccess(ctx, tx, userID, nil, "")
		return err
	})
	if err != nil {
		return "", nil, err
	}
	return userID, revoked, nil
}
