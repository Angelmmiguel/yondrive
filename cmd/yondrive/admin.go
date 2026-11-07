package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"strings"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/store"
)

// admin runs an operator command against the data directory. The directory's
// lock means the server has to be stopped first, which is the point: these
// commands bypass what the running server would check.
func admin(args []string) error {
	if len(args) == 0 || args[0] != "reset-totp" {
		usage()
		return errors.New("admin: unknown command")
	}
	fs := flag.NewFlagSet("admin reset-totp", flag.ContinueOnError)
	fs.Usage = usage
	dataDir := fs.String("data", env("YONDRIVE_DATA", "./data"), "data directory")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 1 {
		usage()
		return errors.New("admin reset-totp: name one user")
	}
	return resetTOTP(*dataDir, fs.Arg(0))
}

// resetTOTP removes a user's TOTP secret and recovery codes, for someone who
// lost both. The change is audited like any other.
func resetTOTP(dataDir, username string) error {
	st, err := store.Open(dataDir)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	ctx := context.Background()
	user, err := st.UserByUsername(ctx, strings.ToLower(strings.TrimSpace(username)))
	if err != nil {
		return fmt.Errorf("user %q: %w", username, err)
	}
	if err := st.ClearTOTP(ctx, user.ID); err != nil {
		return err
	}
	return st.AppendAudit(ctx, store.AuditEntry{At: time.Now(), Action: "totp_reset_by_operator", TargetID: user.ID})
}
