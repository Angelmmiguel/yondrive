package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"maps"
	"strconv"
	"time"
)

// Keys of the settings table.
const (
	keyMode         = "mode"
	keyName         = "name"
	keyPublicURL    = "public_url"
	keyDefaultQuota = "default_quota_bytes"
	keyLanguage     = "language"
	keyTimeZone     = "time_zone"
	keyOpenSignup   = "open_signup"
	keyServerSecret = "server_secret"
	keyPurgeGrace   = "purge_grace_days"
	keyTrashKeep    = "trash_retention_days"
	keyLastBackup   = "last_backup_at"
	keyAuditKeep    = "audit_retention_days"
	keyJournalKeep  = "journal_retention_days"
	keyLocal        = "local_accounts"
	keyOIDCEnabled  = "oidc_enabled"
	keyOIDCLabel    = "oidc_label"
	keyOIDCIssuer   = "oidc_issuer"
	keyOIDCClient   = "oidc_client_id"
	keyOIDCSecret   = "oidc_client_secret" //nolint:gosec // the name of a setting
	keyOIDCScopes   = "oidc_scopes"
	keyOIDCGroup    = "oidc_admin_group"
	keyOIDCClaim    = "oidc_admin_claim"
	keyOIDCMatch    = "oidc_match_mode"
	keyOIDCNewUsers = "oidc_new_users"
	keyOIDCInsecure = "oidc_allow_insecure"
)

// Defaults of the settings that setup does not ask about.
const (
	// DefaultPurgeGraceDays is how long purged data stays before its bytes go.
	DefaultPurgeGraceDays = 30
	// DefaultTrashRetentionDays is how long the trash keeps a node before
	// purging it.
	DefaultTrashRetentionDays = 30
	// DefaultAuditRetentionDays is how long the audit trail keeps an entry.
	DefaultAuditRetentionDays = 365
	// DefaultJournalRetentionDays is how long the change journal keeps an entry.
	DefaultJournalRetentionDays = 90
)

// serverSecretLen is the size in bytes of the persisted server secret.
const serverSecretLen = 32

// How single sign-on links an identity, and what it does with one that links to
// nothing.
const (
	MatchEmail    = "email"
	MatchUsername = "preferred_username"
	MatchSubject  = "sub"

	NewUsersCreate  = "create"
	NewUsersInvited = "invited"
)

// OIDCSettings is how the server signs people in through a provider. The client
// secret is readable by the server because it has to send it. It protects sign-in
// only, and decrypts nothing.
type OIDCSettings struct {
	Enabled       bool
	Label         string
	Issuer        string
	ClientID      string
	ClientSecret  string //nolint:gosec // stored by design, and no route returns it
	Scopes        string
	AdminGroup    string
	AdminClaim    string
	MatchMode     string
	NewUsers      string
	AllowInsecure bool
}

// DefaultOIDCSettings is what the settings are until someone changes them.
func DefaultOIDCSettings() OIDCSettings {
	return OIDCSettings{
		Label:      "Single sign-on",
		Scopes:     "openid profile email",
		AdminClaim: "groups",
		MatchMode:  MatchEmail,
		NewUsers:   NewUsersCreate,
	}
}

func (o OIDCSettings) values() map[string]string {
	return map[string]string{
		keyOIDCEnabled:  boolValue(o.Enabled),
		keyOIDCLabel:    o.Label,
		keyOIDCIssuer:   o.Issuer,
		keyOIDCClient:   o.ClientID,
		keyOIDCSecret:   o.ClientSecret,
		keyOIDCScopes:   o.Scopes,
		keyOIDCGroup:    o.AdminGroup,
		keyOIDCClaim:    o.AdminClaim,
		keyOIDCMatch:    o.MatchMode,
		keyOIDCNewUsers: o.NewUsers,
		keyOIDCInsecure: boolValue(o.AllowInsecure),
	}
}

// Settings is the server-wide configuration chosen at setup.
type Settings struct {
	Mode              string
	Name              string
	PublicURL         string
	DefaultQuotaBytes int64
	Language          string
	TimeZone          string
	OpenSignup        bool
	// LocalAccounts says whether local sign-in and registration are on. The fallback
	// admin can always sign in.
	LocalAccounts bool
	OIDC          OIDCSettings
	// PurgeGraceDays is how long purged data stays before its bytes go.
	PurgeGraceDays int
	// TrashRetentionDays is how long the trash keeps a node before purging it.
	// Zero keeps it until someone purges it.
	TrashRetentionDays int
	// AuditRetentionDays is how long the audit trail keeps an entry. Zero keeps it
	// for good.
	AuditRetentionDays int
	// JournalRetentionDays is how long the change journal keeps an entry. Zero keeps
	// it for good.
	JournalRetentionDays int
	// LastBackupAt is when `yondrive backup` last finished, if ever.
	LastBackupAt time.Time
}

// SettingsPatch changes the settings whose fields are set. The mode has no
// field on purpose: it is written once, at setup.
type SettingsPatch struct {
	Name                 *string
	PublicURL            *string
	DefaultQuotaBytes    *int64
	Language             *string
	TimeZone             *string
	OpenSignup           *bool
	PurgeGraceDays       *int
	TrashRetentionDays   *int
	AuditRetentionDays   *int
	JournalRetentionDays *int
	LocalAccounts        *bool
	// OIDC replaces all of the provider's settings.
	OIDC *OIDCSettings
}

// Settings returns the configuration, or ErrNotConfigured before setup.
func (s *Store) Settings(ctx context.Context) (Settings, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT key, value FROM settings WHERE key <> ?", keyServerSecret)
	if err != nil {
		return Settings{}, fmt.Errorf("store: read settings: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := Settings{
		PurgeGraceDays:       DefaultPurgeGraceDays,
		TrashRetentionDays:   DefaultTrashRetentionDays,
		AuditRetentionDays:   DefaultAuditRetentionDays,
		JournalRetentionDays: DefaultJournalRetentionDays,
		LocalAccounts:        true,
		OIDC:                 DefaultOIDCSettings(),
	}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return Settings{}, fmt.Errorf("store: read settings: %w", err)
		}
		switch key {
		case keyMode:
			out.Mode = value
		case keyName:
			out.Name = value
		case keyPublicURL:
			out.PublicURL = value
		case keyDefaultQuota:
			if out.DefaultQuotaBytes, err = strconv.ParseInt(value, 10, 64); err != nil {
				return Settings{}, fmt.Errorf("store: read settings: %w", err)
			}
		case keyLanguage:
			out.Language = value
		case keyTimeZone:
			out.TimeZone = value
		case keyOpenSignup:
			out.OpenSignup = value == "1"
		case keyPurgeGrace:
			if out.PurgeGraceDays, err = strconv.Atoi(value); err != nil {
				return Settings{}, fmt.Errorf("store: read settings: %w", err)
			}
		case keyTrashKeep:
			if out.TrashRetentionDays, err = strconv.Atoi(value); err != nil {
				return Settings{}, fmt.Errorf("store: read settings: %w", err)
			}
		case keyLocal:
			out.LocalAccounts = value == "1"
		case keyOIDCEnabled:
			out.OIDC.Enabled = value == "1"
		case keyOIDCLabel:
			out.OIDC.Label = value
		case keyOIDCIssuer:
			out.OIDC.Issuer = value
		case keyOIDCClient:
			out.OIDC.ClientID = value
		case keyOIDCSecret:
			out.OIDC.ClientSecret = value
		case keyOIDCScopes:
			out.OIDC.Scopes = value
		case keyOIDCGroup:
			out.OIDC.AdminGroup = value
		case keyOIDCClaim:
			out.OIDC.AdminClaim = value
		case keyOIDCMatch:
			out.OIDC.MatchMode = value
		case keyOIDCNewUsers:
			out.OIDC.NewUsers = value
		case keyOIDCInsecure:
			out.OIDC.AllowInsecure = value == "1"
		case keyAuditKeep:
			if out.AuditRetentionDays, err = strconv.Atoi(value); err != nil {
				return Settings{}, fmt.Errorf("store: read settings: %w", err)
			}
		case keyJournalKeep:
			if out.JournalRetentionDays, err = strconv.Atoi(value); err != nil {
				return Settings{}, fmt.Errorf("store: read settings: %w", err)
			}
		case keyLastBackup:
			at, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return Settings{}, fmt.Errorf("store: read settings: %w", err)
			}
			out.LastBackupAt = time.Unix(at, 0).UTC()
		}
	}
	if err := rows.Err(); err != nil {
		return Settings{}, fmt.Errorf("store: read settings: %w", err)
	}
	if out.Mode == "" {
		return Settings{}, ErrNotConfigured
	}
	return out, nil
}

// CompleteSetup stores the settings and creates the first user in one
// transaction. It fails with ErrAlreadyConfigured if setup was completed.
func (s *Store) CompleteSetup(ctx context.Context, cfg Settings, admin User) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var exists int
		err := tx.QueryRowContext(ctx, "SELECT 1 FROM settings WHERE key = ?", keyMode).Scan(&exists)
		if err == nil {
			return ErrAlreadyConfigured
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: read mode: %w", err)
		}
		values := map[string]string{
			keyMode:         cfg.Mode,
			keyName:         cfg.Name,
			keyPublicURL:    cfg.PublicURL,
			keyDefaultQuota: strconv.FormatInt(cfg.DefaultQuotaBytes, 10),
			keyLanguage:     cfg.Language,
			keyTimeZone:     cfg.TimeZone,
			keyOpenSignup:   boolValue(cfg.OpenSignup),
			keyLocal:        boolValue(cfg.LocalAccounts),
		}
		maps.Copy(values, cfg.OIDC.values())
		for key, value := range values {
			if err := putSetting(ctx, tx, key, value); err != nil {
				return err
			}
		}
		return insertUser(ctx, tx, admin)
	})
}

// UpdateSettings applies patch in one transaction and returns the result.
func (s *Store) UpdateSettings(ctx context.Context, patch SettingsPatch) (Settings, error) {
	err := s.tx(ctx, func(tx *sql.Tx) error {
		put := func(key string, value *string) error {
			if value == nil {
				return nil
			}
			return putSetting(ctx, tx, key, *value)
		}
		var quota, signup, local *string
		if patch.LocalAccounts != nil {
			v := boolValue(*patch.LocalAccounts)
			local = &v
		}
		if patch.OIDC != nil {
			for key, value := range patch.OIDC.values() {
				if err := putSetting(ctx, tx, key, value); err != nil {
					return err
				}
			}
		}
		days := func(v *int) *string {
			if v == nil {
				return nil
			}
			text := strconv.Itoa(*v)
			return &text
		}
		if patch.DefaultQuotaBytes != nil {
			v := strconv.FormatInt(*patch.DefaultQuotaBytes, 10)
			quota = &v
		}
		if patch.OpenSignup != nil {
			v := boolValue(*patch.OpenSignup)
			signup = &v
		}
		return errors.Join(
			put(keyName, patch.Name),
			put(keyPublicURL, patch.PublicURL),
			put(keyDefaultQuota, quota),
			put(keyLanguage, patch.Language),
			put(keyTimeZone, patch.TimeZone),
			put(keyOpenSignup, signup),
			put(keyLocal, local),
			put(keyPurgeGrace, days(patch.PurgeGraceDays)),
			put(keyTrashKeep, days(patch.TrashRetentionDays)),
			put(keyAuditKeep, days(patch.AuditRetentionDays)),
			put(keyJournalKeep, days(patch.JournalRetentionDays)),
		)
	})
	if err != nil {
		return Settings{}, err
	}
	return s.Settings(ctx)
}

// ServerSecret returns the persisted secret, creating it the first time. It
// never leaves the server.
func (s *Store) ServerSecret(ctx context.Context) ([]byte, error) {
	var value string
	err := s.tx(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, "SELECT value FROM settings WHERE key = ?", keyServerSecret).Scan(&value)
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var b [serverSecretLen]byte
		_, _ = rand.Read(b[:])
		value = hex.EncodeToString(b[:])
		return putSetting(ctx, tx, keyServerSecret, value)
	})
	if err != nil {
		return nil, fmt.Errorf("store: server secret: %w", err)
	}
	return hex.DecodeString(value)
}

// RotateServerSecret replaces the server secret with a new one. Every link token
// and sign-in in flight stops working, and readers of a link open it again.
func (s *Store) RotateServerSecret(ctx context.Context) error {
	var b [serverSecretLen]byte
	_, _ = rand.Read(b[:])
	err := s.tx(ctx, func(tx *sql.Tx) error {
		return putSetting(ctx, tx, keyServerSecret, hex.EncodeToString(b[:]))
	})
	if err != nil {
		return fmt.Errorf("store: rotate server secret: %w", err)
	}
	return nil
}

func putSetting(ctx context.Context, tx *sql.Tx, key, value string) error {
	_, err := tx.ExecContext(ctx,
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
		key, value)
	if err != nil {
		return fmt.Errorf("store: write setting: %w", err)
	}
	return nil
}

func boolValue(b bool) string {
	if b {
		return "1"
	}
	return "0"
}
