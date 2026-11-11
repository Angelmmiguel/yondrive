package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// The states of a pairing.
const (
	PairingOpen      = "open"
	PairingClaimed   = "claimed"
	PairingConfirmed = "confirmed"
)

// Pairing is a device being added by code. It belongs to the session or the
// token that started it: exactly one of SessionHash and CreatorTokenID is set,
// until it is confirmed, after which both may have gone.
// The server cannot open SealedPayload, which is sealed to the device's key.
type Pairing struct {
	ID              string
	UserID          string
	SessionHash     []byte
	CreatorTokenID  string
	State           string
	DevicePublicKey []byte
	DeviceName      string
	DevicePlatform  string
	SealedPayload   []byte
	TokenID         string
	CreatedAt       time.Time
	ClaimedAt       time.Time // zero until claimed
	ConfirmedAt     time.Time // zero until confirmed
	PickedUpAt      time.Time // zero until the device fetched the sealed payload
	ExpiresAt       time.Time
}

const pairingColumns = `id, user_id, session_hash, coalesce(creator_token_id, ''), state, device_public_key,
	coalesce(device_name, ''), coalesce(device_platform, ''), sealed_payload, coalesce(token_id, ''),
	created_at, claimed_at, confirmed_at, picked_up_at, expires_at`

func scanPairing(row interface{ Scan(...any) error }) (Pairing, error) {
	var p Pairing
	var created, expires int64
	var claimed, confirmed, pickedUp sql.NullInt64
	err := row.Scan(&p.ID, &p.UserID, &p.SessionHash, &p.CreatorTokenID, &p.State, &p.DevicePublicKey,
		&p.DeviceName, &p.DevicePlatform, &p.SealedPayload, &p.TokenID, &created, &claimed, &confirmed, &pickedUp, &expires)
	if err != nil {
		return Pairing{}, err
	}
	p.CreatedAt = time.Unix(created, 0).UTC()
	p.ExpiresAt = time.Unix(expires, 0).UTC()
	if claimed.Valid {
		p.ClaimedAt = time.Unix(claimed.Int64, 0).UTC()
	}
	if confirmed.Valid {
		p.ConfirmedAt = time.Unix(confirmed.Int64, 0).UTC()
	}
	if pickedUp.Valid {
		p.PickedUpAt = time.Unix(pickedUp.Int64, 0).UTC()
	}
	return p, nil
}

// CreatePairing stores an open pairing, replacing every pairing of the user that
// is not yet confirmed: a user has one code in play at a time.
func (s *Store) CreatePairing(ctx context.Context, p Pairing) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "DELETE FROM pairings WHERE user_id = ? AND state <> 'confirmed'", p.UserID); err != nil {
			return fmt.Errorf("store: replace pairings: %w", err)
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO pairings (id, user_id, session_hash, creator_token_id, state, created_at, expires_at)
			VALUES (?, ?, ?, nullif(?, ''), 'open', ?, ?)`,
			p.ID, p.UserID, p.SessionHash, p.CreatorTokenID, p.CreatedAt.Unix(), p.ExpiresAt.Unix())
		if err != nil {
			return fmt.Errorf("store: create pairing: %w", err)
		}
		return nil
	})
}

// PairingByID returns a pairing, or ErrNotFound. Expiry is the caller's concern.
func (s *Store) PairingByID(ctx context.Context, id string) (Pairing, error) {
	p, err := scanPairing(s.read.QueryRowContext(ctx, "SELECT "+pairingColumns+" FROM pairings WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return Pairing{}, ErrNotFound
	}
	if err != nil {
		return Pairing{}, fmt.Errorf("store: read pairing: %w", err)
	}
	return p, nil
}

// ClaimPairing records the device that scanned an open pairing's code, and
// returns the pairing. Of two claims, one wins. It fails with ErrNotFound if
// there is no such pairing or it has expired at now, and with ErrPairingClaimed
// if a device claimed it before.
func (s *Store) ClaimPairing(ctx context.Context, id string, publicKey []byte, name, platform string, now time.Time) (Pairing, error) {
	var out Pairing
	err := s.tx(ctx, func(tx *sql.Tx) error {
		p, err := scanPairing(tx.QueryRowContext(ctx, `UPDATE pairings SET state = 'claimed', device_public_key = ?,
			device_name = ?, device_platform = nullif(?, ''), claimed_at = ?
			WHERE id = ? AND state = 'open' AND expires_at > ? RETURNING `+pairingColumns,
			publicKey, name, platform, now.Unix(), id, now.Unix()))
		if err == nil {
			out = p
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: claim pairing: %w", err)
		}
		var expires int64
		err = tx.QueryRowContext(ctx, "SELECT expires_at FROM pairings WHERE id = ?", id).Scan(&expires)
		switch {
		case errors.Is(err, sql.ErrNoRows) || (err == nil && expires <= now.Unix()):
			return ErrNotFound
		case err != nil:
			return fmt.Errorf("store: claim pairing: %w", err)
		}
		return ErrPairingClaimed
	})
	return out, err
}

// ConfirmPairing stores the device's token and the payload sealed to it, and
// gives the device until now+pickupTTL to collect it, in one transaction. It
// fails with ErrPairingState unless the pairing is claimed and unexpired at now,
// and with ErrTokenHashTaken if another token has the hash.
func (s *Store) ConfirmPairing(ctx context.Context, id string, token Token, sealed []byte, now time.Time, pickupTTL time.Duration) (Pairing, error) {
	var out Pairing
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := insertToken(ctx, tx, token); err != nil {
			return err
		}
		p, err := scanPairing(tx.QueryRowContext(ctx, `UPDATE pairings SET state = 'confirmed', sealed_payload = ?,
			token_id = ?, confirmed_at = ?, expires_at = ?
			WHERE id = ? AND state = 'claimed' AND expires_at > ? RETURNING `+pairingColumns,
			sealed, token.ID, now.Unix(), now.Add(pickupTTL).Unix(), id, now.Unix()))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrPairingState
		}
		if err != nil {
			return fmt.Errorf("store: confirm pairing: %w", err)
		}
		out = p
		return nil
	})
	return out, err
}

// DeletePairing removes one of a user's pairings and, if it was confirmed, the
// token it made, whether or not the device collected it. It returns that token's
// id, or "" if there was none, and fails with ErrNotFound if there is no such
// pairing.
func (s *Store) DeletePairing(ctx context.Context, userID, id string) (string, error) {
	var tokenID string
	err := s.tx(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, "DELETE FROM pairings WHERE id = ? AND user_id = ? RETURNING coalesce(token_id, '')", id, userID).
			Scan(&tokenID)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("store: delete pairing: %w", err)
		}
		if tokenID == "" {
			return nil
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM tokens WHERE id = ?", tokenID); err != nil {
			return fmt.Errorf("store: delete pairing token: %w", err)
		}
		return nil
	})
	return tokenID, err
}

// CollectPairing returns a confirmed pairing for its device to fetch the sealed
// payload, recording the first time it does: from then on the token outlives the
// pairing. It fails with ErrNotFound unless the pairing is confirmed and
// unexpired at now, so what it returns is what it marked.
func (s *Store) CollectPairing(ctx context.Context, id string, now time.Time) (Pairing, error) {
	p, err := scanPairing(s.write.QueryRowContext(ctx,
		`UPDATE pairings SET picked_up_at = coalesce(picked_up_at, ?)
		WHERE id = ? AND state = 'confirmed' AND expires_at > ? RETURNING `+pairingColumns,
		now.Unix(), id, now.Unix()))
	if errors.Is(err, sql.ErrNoRows) {
		return Pairing{}, ErrNotFound
	}
	if err != nil {
		return Pairing{}, fmt.Errorf("store: collect pairing: %w", err)
	}
	return p, nil
}

// RemoveExpiredPairings drops the pairings whose time is up at now, and returns
// how many. A confirmed pairing's token stays if the device collected it; one
// nobody collected goes with its pairing (a trigger), since nobody holds its
// secret.
func (s *Store) RemoveExpiredPairings(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.write.ExecContext(ctx, "DELETE FROM pairings WHERE expires_at <= ?", now.Unix())
	if err != nil {
		return 0, fmt.Errorf("store: remove expired pairings: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: remove expired pairings: %w", err)
	}
	return n, nil
}
