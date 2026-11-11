package store

import (
	"bytes"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"
)

func addPairing(t *testing.T, st *Store, userID string, session []byte) Pairing {
	t.Helper()
	p := Pairing{ID: NewID(), UserID: userID, SessionHash: session, CreatedAt: t0, ExpiresAt: t0.Add(5 * time.Minute)}
	if err := st.CreatePairing(ctx, p); err != nil {
		t.Fatal(err)
	}
	return p
}

func pairingToken(userID, name string) Token {
	return Token{ID: NewID(), UserID: userID, Name: name, Platform: "ios", Origin: TokenOriginPairing, Hash: hash(name), CreatedAt: t0}
}

func TestCreatePairingReplacesTheUsersUnconfirmedOnes(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	bob := addUser(t, st, "bob")
	session := addSession(t, st, u.ID, "s")
	bobs := addPairing(t, st, bob.ID, addSession(t, st, bob.ID, "b"))

	first := addPairing(t, st, u.ID, session)
	claimed := addPairing(t, st, u.ID, session)
	if _, err := st.ClaimPairing(ctx, claimed.ID, hash("d"), "phone", "", t0); err != nil {
		t.Fatal(err)
	}
	confirmed := addPairing(t, st, u.ID, session)
	if _, err := st.ClaimPairing(ctx, confirmed.ID, hash("d"), "phone", "ios", t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ConfirmPairing(ctx, confirmed.ID, pairingToken(u.ID, "tok"), hash("sealed"), t0, 2*time.Minute); err != nil {
		t.Fatal(err)
	}
	latest := addPairing(t, st, u.ID, session)

	for _, gone := range []string{first.ID, claimed.ID} {
		if _, err := st.PairingByID(ctx, gone); !errors.Is(err, ErrNotFound) {
			t.Errorf("pairing %s: %v, want ErrNotFound", gone, err)
		}
	}
	for _, kept := range []string{confirmed.ID, latest.ID, bobs.ID} {
		if _, err := st.PairingByID(ctx, kept); err != nil {
			t.Errorf("pairing %s: %v", kept, err)
		}
	}
	if p, _ := st.PairingByID(ctx, latest.ID); p.State != PairingOpen || !bytes.Equal(p.SessionHash, session) || p.CreatorTokenID != "" {
		t.Errorf("latest = %+v", p)
	}
}

func TestAPairingBelongsToASessionOrAToken(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	tok := addToken(t, st, u.ID, "t")
	p := Pairing{ID: NewID(), UserID: u.ID, CreatorTokenID: tok.ID, CreatedAt: t0, ExpiresAt: t0.Add(time.Minute)}
	if err := st.CreatePairing(ctx, p); err != nil {
		t.Fatal(err)
	}
	if got, err := st.PairingByID(ctx, p.ID); err != nil || got.CreatorTokenID != tok.ID || got.SessionHash != nil {
		t.Errorf("pairing = %+v, %v", got, err)
	}
	neither := Pairing{ID: NewID(), UserID: u.ID, CreatedAt: t0, ExpiresAt: t0.Add(time.Minute)}
	if err := st.CreatePairing(ctx, neither); err == nil {
		t.Error("a pairing with no creator was stored")
	}
}

func TestOfTwoClaimsOneWins(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	p := addPairing(t, st, u.ID, addSession(t, st, u.ID, "s"))

	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Go(func() {
			_, errs[i] = st.ClaimPairing(ctx, p.ID, hash(strconv.Itoa(i)), "phone", "ios", t0)
		})
	}
	wg.Wait()
	won := 0
	for _, err := range errs {
		switch {
		case err == nil:
			won++
		case !errors.Is(err, ErrPairingClaimed):
			t.Errorf("claim: %v", err)
		}
	}
	if won != 1 {
		t.Errorf("%d claims won", won)
	}
	got, err := st.PairingByID(ctx, p.ID)
	if err != nil || got.State != PairingClaimed || len(got.DevicePublicKey) != 32 || got.DeviceName != "phone" ||
		got.DevicePlatform != "ios" || !got.ClaimedAt.Equal(t0) {
		t.Errorf("claimed = %+v, %v", got, err)
	}
}

func TestClaimAnswersNotFoundForUnknownAndExpired(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	p := addPairing(t, st, u.ID, addSession(t, st, u.ID, "s"))
	if _, err := st.ClaimPairing(ctx, NewID(), hash("d"), "phone", "", t0); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown: %v", err)
	}
	if _, err := st.ClaimPairing(ctx, p.ID, hash("d"), "phone", "", p.ExpiresAt); !errors.Is(err, ErrNotFound) {
		t.Errorf("expired: %v", err)
	}
}

func TestConfirmInsertsTheTokenAtomically(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	p := addPairing(t, st, u.ID, addSession(t, st, u.ID, "s"))

	if _, err := st.ConfirmPairing(ctx, p.ID, pairingToken(u.ID, "early"), hash("x"), t0, time.Minute); !errors.Is(err, ErrPairingState) {
		t.Errorf("confirm before a claim: %v", err)
	}
	if _, err := st.TokenByHash(ctx, hash("early")); !errors.Is(err, ErrNotFound) {
		t.Error("a refused confirmation left its token")
	}
	if _, err := st.ClaimPairing(ctx, p.ID, hash("d"), "phone", "ios", t0); err != nil {
		t.Fatal(err)
	}
	taken := addToken(t, st, u.ID, "taken")
	clash := pairingToken(u.ID, "clash")
	clash.Hash = taken.Hash
	if _, err := st.ConfirmPairing(ctx, p.ID, clash, hash("x"), t0, time.Minute); !errors.Is(err, ErrTokenHashTaken) {
		t.Errorf("hash in use: %v", err)
	}

	tok := pairingToken(u.ID, "phone")
	now := t0.Add(time.Minute)
	got, err := st.ConfirmPairing(ctx, p.ID, tok, hash("sealed"), now, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != PairingConfirmed || got.TokenID != tok.ID || !bytes.Equal(got.SealedPayload, hash("sealed")) ||
		!got.ConfirmedAt.Equal(now) || !got.ExpiresAt.Equal(now.Add(2*time.Minute)) {
		t.Errorf("confirmed = %+v", got)
	}
	stored, err := st.TokenByHash(ctx, tok.Hash)
	if err != nil || stored.Origin != TokenOriginPairing || stored.Platform != "ios" || stored.UserID != u.ID {
		t.Errorf("token = %+v, %v", stored, err)
	}
	if _, err := st.ConfirmPairing(ctx, p.ID, pairingToken(u.ID, "again"), hash("x"), now, time.Minute); !errors.Is(err, ErrPairingState) {
		t.Errorf("second confirmation: %v", err)
	}
	if n, err := st.CountTokens(ctx, u.ID); err != nil || n != 2 {
		t.Errorf("tokens = %d, %v", n, err)
	}
}

func TestDeletingAConfirmedPairingDeletesItsToken(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	bob := addUser(t, st, "bob")
	session := addSession(t, st, u.ID, "s")
	unclaimed := addPairing(t, st, u.ID, session)
	if _, err := st.DeletePairing(ctx, bob.ID, unclaimed.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("another user's: %v", err)
	}
	if id, err := st.DeletePairing(ctx, u.ID, unclaimed.ID); err != nil || id != "" {
		t.Errorf("open: %q, %v", id, err)
	}

	p := addPairing(t, st, u.ID, session)
	if _, err := st.ClaimPairing(ctx, p.ID, hash("d"), "phone", "", t0); err != nil {
		t.Fatal(err)
	}
	tok := pairingToken(u.ID, "phone")
	if _, err := st.ConfirmPairing(ctx, p.ID, tok, hash("sealed"), t0, time.Minute); err != nil {
		t.Fatal(err)
	}
	if id, err := st.DeletePairing(ctx, u.ID, p.ID); err != nil || id != tok.ID {
		t.Errorf("confirmed: %q, %v", id, err)
	}
	if _, err := st.TokenByHash(ctx, tok.Hash); !errors.Is(err, ErrNotFound) {
		t.Error("the token outlived its pairing's cancellation")
	}
	if _, err := st.DeletePairing(ctx, u.ID, p.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("twice: %v", err)
	}
}

// confirmedPairing is a pairing that a device claimed and its browser confirmed.
func confirmedPairing(t *testing.T, st *Store, userID string, session []byte, name string) (Pairing, Token) {
	t.Helper()
	p := addPairing(t, st, userID, session)
	if _, err := st.ClaimPairing(ctx, p.ID, hash("d"), "phone", "", t0); err != nil {
		t.Fatal(err)
	}
	tok := pairingToken(userID, name)
	p, err := st.ConfirmPairing(ctx, p.ID, tok, hash("sealed"), t0, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return p, tok
}

func TestRemoveExpiredPairingsKeepsOnlyCollectedTokens(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	collected, kept := confirmedPairing(t, st, u.ID, addSession(t, st, u.ID, "s1"), "kept")
	if got, err := st.CollectPairing(ctx, collected.ID, t0.Add(time.Minute)); err != nil || !got.PickedUpAt.Equal(t0.Add(time.Minute)) {
		t.Fatalf("collected = %+v, %v", got, err)
	}
	// A second fetch keeps the time of the first.
	if got, err := st.CollectPairing(ctx, collected.ID, t0.Add(90*time.Second)); err != nil || !got.PickedUpAt.Equal(t0.Add(time.Minute)) {
		t.Errorf("fetched again = %+v, %v", got, err)
	}
	uncollected, lost := confirmedPairing(t, st, u.ID, addSession(t, st, u.ID, "s2"), "lost")
	waiting := addPairing(t, st, u.ID, addSession(t, st, u.ID, "s3"))
	if _, err := st.CollectPairing(ctx, waiting.ID, t0); !errors.Is(err, ErrNotFound) {
		t.Errorf("collecting an open pairing: %v", err)
	}
	if _, err := st.CollectPairing(ctx, uncollected.ID, uncollected.ExpiresAt); !errors.Is(err, ErrNotFound) {
		t.Errorf("collecting after the pickup window: %v", err)
	}

	if n, err := st.RemoveExpiredPairings(ctx, t0.Add(2*time.Minute)); err != nil || n != 2 {
		t.Errorf("removed %d, %v", n, err)
	}
	for _, gone := range []string{collected.ID, uncollected.ID} {
		if _, err := st.PairingByID(ctx, gone); !errors.Is(err, ErrNotFound) {
			t.Errorf("pairing %s stayed", gone)
		}
	}
	if _, err := st.TokenByHash(ctx, kept.Hash); err != nil {
		t.Errorf("the collected token: %v", err)
	}
	if _, err := st.TokenByHash(ctx, lost.Hash); !errors.Is(err, ErrNotFound) {
		t.Error("a token nobody collected outlived its pairing")
	}
	if n, err := st.RemoveExpiredPairings(ctx, waiting.ExpiresAt); err != nil || n != 1 {
		t.Errorf("removed %d, %v", n, err)
	}
}

func TestAConfirmedPairingOutlivesItsSessionAndToken(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	session := addSession(t, st, u.ID, "s")
	p, tok := confirmedPairing(t, st, u.ID, session, "phone")
	if err := st.DeleteSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	got, err := st.PairingByID(ctx, p.ID)
	if err != nil || got.SessionHash != nil || got.State != PairingConfirmed {
		t.Fatalf("pairing = %+v, %v", got, err)
	}
	if _, err := st.CollectPairing(ctx, p.ID, t0); err != nil {
		t.Errorf("collect: %v", err)
	}

	creator := addToken(t, st, u.ID, "laptop")
	byToken := Pairing{ID: NewID(), UserID: u.ID, CreatorTokenID: creator.ID, CreatedAt: t0, ExpiresAt: t0.Add(time.Minute)}
	if err := st.CreatePairing(ctx, byToken); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ClaimPairing(ctx, byToken.ID, hash("e"), "tablet", "", t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ConfirmPairing(ctx, byToken.ID, pairingToken(u.ID, "tablet"), hash("sealed"), t0, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteToken(ctx, u.ID, creator.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := st.PairingByID(ctx, byToken.ID); err != nil || got.CreatorTokenID != "" {
		t.Errorf("pairing by token = %+v, %v", got, err)
	}
	if _, err := st.TokenByHash(ctx, tok.Hash); err != nil {
		t.Errorf("the device's token: %v", err)
	}
}

func TestAnUncollectedPairingTakesItsTokenHoweverItGoes(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	session := addSession(t, st, u.ID, "s")
	lost, lostToken := confirmedPairing(t, st, u.ID, session, "lost")
	kept, keptToken := confirmedPairing(t, st, u.ID, addSession(t, st, u.ID, "s2"), "kept")
	if _, err := st.CollectPairing(ctx, kept.ID, t0); err != nil {
		t.Fatal(err)
	}
	// Whatever removes the row, the database takes the uncollected token with it.
	for _, id := range []string{lost.ID, kept.ID} {
		if _, err := st.write.ExecContext(ctx, "DELETE FROM pairings WHERE id = ?", id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.TokenByHash(ctx, lostToken.Hash); !errors.Is(err, ErrNotFound) {
		t.Error("a token nobody collected outlived its pairing")
	}
	if _, err := st.TokenByHash(ctx, keptToken.Hash); err != nil {
		t.Errorf("the collected token: %v", err)
	}
}

func TestPairingsGoWithTheirSessionTokenAndUser(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	session := addSession(t, st, u.ID, "s")
	p := addPairing(t, st, u.ID, session)
	if err := st.DeleteSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PairingByID(ctx, p.ID); !errors.Is(err, ErrNotFound) {
		t.Error("the pairing outlived its session")
	}

	tok := addToken(t, st, u.ID, "t")
	byToken := Pairing{ID: NewID(), UserID: u.ID, CreatorTokenID: tok.ID, CreatedAt: t0, ExpiresAt: t0.Add(time.Minute)}
	if err := st.CreatePairing(ctx, byToken); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteToken(ctx, u.ID, tok.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PairingByID(ctx, byToken.ID); !errors.Is(err, ErrNotFound) {
		t.Error("the pairing outlived its token")
	}

	last := addPairing(t, st, u.ID, addSession(t, st, u.ID, "s2"))
	if _, err := st.DeleteUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PairingByID(ctx, last.ID); !errors.Is(err, ErrNotFound) {
		t.Error("the pairing outlived its user")
	}
}
