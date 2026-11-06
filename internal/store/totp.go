package store

import (
	"context"
	"database/sql"
	"fmt"
)

// SetPendingTOTP stores a secret that is not yet in force, replacing any
// earlier pending one. It fails with ErrNotFound if the user is unknown or
// already has TOTP enabled.
func (s *Store) SetPendingTOTP(ctx context.Context, userID string, secret []byte) error {
	res, err := s.write.ExecContext(ctx,
		"UPDATE users SET totp_secret = ? WHERE id = ? AND totp_enabled_at IS NULL", secret, userID)
	if err != nil {
		return fmt.Errorf("store: set totp secret: %w", err)
	}
	return requireRow(res, ErrNotFound)
}

// EnableTOTP puts the pending secret in force, records step as used and stores
// the hashes of the recovery codes, in one transaction. It fails with
// ErrNotFound if no secret is pending.
func (s *Store) EnableTOTP(ctx context.Context, userID string, step, enabledAt int64, codeHashes [][]byte) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE users SET totp_enabled_at = ?, totp_last_step = ?
			WHERE id = ? AND totp_secret IS NOT NULL AND totp_enabled_at IS NULL`, enabledAt, step, userID)
		if err != nil {
			return fmt.Errorf("store: enable totp: %w", err)
		}
		if err := requireRow(res, ErrNotFound); err != nil {
			return err
		}
		for _, h := range codeHashes {
			if _, err := tx.ExecContext(ctx, "INSERT INTO recovery_codes (user_id, hash) VALUES (?, ?)", userID, h); err != nil {
				return fmt.Errorf("store: store recovery code: %w", err)
			}
		}
		return nil
	})
}

// ClearTOTP removes a user's secret and recovery codes. It fails with
// ErrNotFound if the user is unknown.
func (s *Store) ClearTOTP(ctx context.Context, userID string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			"UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = 0 WHERE id = ?", userID)
		if err != nil {
			return fmt.Errorf("store: clear totp: %w", err)
		}
		if err := requireRow(res, ErrNotFound); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM recovery_codes WHERE user_id = ?", userID); err != nil {
			return fmt.Errorf("store: clear recovery codes: %w", err)
		}
		return nil
	})
}

// ConsumeTOTPStep records step as used and reports false if it, or a later
// one, already was: the update is what makes a code single-use under
// concurrent requests.
func (s *Store) ConsumeTOTPStep(ctx context.Context, userID string, step int64) (bool, error) {
	res, err := s.write.ExecContext(ctx,
		"UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?", step, userID, step)
	if err != nil {
		return false, fmt.Errorf("store: consume totp step: %w", err)
	}
	return affected(res)
}

// ConsumeRecoveryCode deletes a matching code and reports whether there was
// one.
func (s *Store) ConsumeRecoveryCode(ctx context.Context, userID string, hash []byte) (bool, error) {
	res, err := s.write.ExecContext(ctx, "DELETE FROM recovery_codes WHERE user_id = ? AND hash = ?", userID, hash)
	if err != nil {
		return false, fmt.Errorf("store: consume recovery code: %w", err)
	}
	return affected(res)
}

// CountRecoveryCodes returns how many unused recovery codes a user has.
func (s *Store) CountRecoveryCodes(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.read.QueryRowContext(ctx, "SELECT count(*) FROM recovery_codes WHERE user_id = ?", userID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("store: count recovery codes: %w", err)
	}
	return n, nil
}

func affected(res sql.Result) (bool, error) {
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("store: rows affected: %w", err)
	}
	return n > 0, nil
}
