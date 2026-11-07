package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// operatorResetTTL is how long a reset link from `yondrive admin password-reset`
// lasts, as long as one an admin makes in the app.
const operatorResetTTL = 24 * time.Hour

// adminCommands are the operator's ways back in when the app cannot help: each
// changes one user, is audited, and runs with the server stopped.
var adminCommands = map[string]func(dataDir, username string, out io.Writer) error{
	"reset-totp":     func(dataDir, username string, _ io.Writer) error { return resetTOTP(dataDir, username) },
	"promote":        promote,
	"password-reset": operatorPasswordReset,
}

// serverCommands are operator commands about the server rather than a user.
var serverCommands = map[string]func(dataDir string, out io.Writer) error{
	"rotate-secret": rotateSecret,
}

// admin runs an operator command against the data directory. The directory's
// lock means the server has to be stopped first, which is the point: these
// commands bypass what the running server would check.
func admin(args []string) error {
	if len(args) == 0 || adminCommands[args[0]] == nil && serverCommands[args[0]] == nil {
		usage()
		return errors.New("admin: unknown command")
	}
	fs := flag.NewFlagSet("admin "+args[0], flag.ContinueOnError)
	fs.Usage = usage
	dataDir := fs.String("data", env("YONDRIVE_DATA", "./data"), "data directory")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if run := serverCommands[args[0]]; run != nil {
		if fs.NArg() != 0 {
			usage()
			return fmt.Errorf("admin %s: takes no user", args[0])
		}
		return run(*dataDir, os.Stdout)
	}
	if fs.NArg() != 1 {
		usage()
		return fmt.Errorf("admin %s: name one user", args[0])
	}
	return adminCommands[args[0]](*dataDir, fs.Arg(0), os.Stdout)
}

// withUser opens the store, finds a user by name and runs fn.
func withUser(dataDir, username string, fn func(context.Context, *store.Store, store.User) error) error {
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
	return fn(ctx, st, user)
}

// resetTOTP removes a user's TOTP secret and recovery codes, for someone who
// lost both. The change is audited like any other.
func resetTOTP(dataDir, username string) error {
	return withUser(dataDir, username, func(ctx context.Context, st *store.Store, user store.User) error {
		if err := st.ClearTOTP(ctx, user.ID); err != nil {
			return err
		}
		return st.AppendAudit(ctx, store.AuditEntry{At: time.Now(), Action: "totp_reset_by_operator", TargetID: user.ID})
	})
}

// promote makes a user an enabled admin, for a server whose admins are all
// locked out. It gives no access to anyone's content in end-to-end mode, as
// being an admin never does.
func promote(dataDir, username string, out io.Writer) error {
	return withUser(dataDir, username, func(ctx context.Context, st *store.Store, user store.User) error {
		if err := st.SetRole(ctx, user.ID, "admin"); err != nil {
			return err
		}
		if user.Disabled {
			if err := st.EnableUser(ctx, user.ID); err != nil {
				return err
			}
		}
		if err := st.AppendAudit(ctx, store.AuditEntry{At: time.Now(), Action: "promoted_by_operator", TargetID: user.ID}); err != nil {
			return err
		}
		_, err := fmt.Fprintf(out, "%s is an admin\n", user.Username)
		return err
	})
}

// rotateSecret replaces the server secret, for a copy of the database that left
// the operator's hands: a backup from before backups left the secret out, or the
// data directory itself. Whoever has the old secret can sign link tokens for any
// live link until it is replaced.
func rotateSecret(dataDir string, out io.Writer) error {
	st, err := store.Open(dataDir)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	ctx := context.Background()
	if err := st.RotateServerSecret(ctx); err != nil {
		return err
	}
	if err := st.AppendAudit(ctx, store.AuditEntry{At: time.Now(), Action: "server_secret_rotated_by_operator"}); err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, "server secret replaced; open link sessions and sign-ins in progress have ended")
	return err
}

// operatorPasswordReset prints a one-time reset link for a local account, in
// mode none alone: no key depends on the password there, which is why an admin
// can do the same in the app. In end-to-end mode only the user's recovery key
// can recover an account, and no command changes that.
func operatorPasswordReset(dataDir, username string, out io.Writer) error {
	return withUser(dataDir, username, func(ctx context.Context, st *store.Store, user store.User) error {
		settings, err := st.Settings(ctx)
		if err != nil {
			return err
		}
		if settings.Mode != "none" {
			return errors.New("admin password-reset: in end-to-end mode only the user's recovery key can recover an account")
		}
		if user.SSOOnly() {
			return fmt.Errorf("admin password-reset: %s signs in only through the identity provider", user.Username)
		}
		token := auth.NewToken()
		expires := time.Now().Add(operatorResetTTL)
		if err := st.CreatePasswordReset(ctx, auth.HashToken(token), user.ID, expires); err != nil {
			return err
		}
		if err := st.AppendAudit(ctx, store.AuditEntry{At: time.Now(), Action: "password_reset_by_operator", TargetID: user.ID}); err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "reset link for %s, valid until %s:\n%s/reset#%s\n",
			user.Username, expires.UTC().Format(time.RFC3339), settings.PublicURL, token)
		return err
	})
}
