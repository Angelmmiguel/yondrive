# Single sign-on

YonDrive signs people in through any OpenID Connect provider that offers the authorization code
flow. Set it up in the wizard's sign-in step, or later in the admin area. What it means for security
is in [SECURITY.md](SECURITY.md#single-sign-on).

## What to give the provider and what you get

**Redirect URI:** your public URL followed by `/auth/oidc/callback`, for example
`https://drive.example.com/auth/oidc/callback`. The wizard and the settings show the exact one.

Create a **confidential** client with the authorization code flow, and copy its client ID and secret.
YonDrive always uses PKCE with S256.

| Setting | What it does |
| --- | --- |
| Button label | The text on the sign-in page. |
| Issuer URL | The provider's issuer, **exactly** as the provider spells it, trailing slash and all. YonDrive fetches `/.well-known/openid-configuration` under it and requires the document to name the same issuer. |
| Client ID, client secret | From the provider. The secret is never shown again, and leaving it empty on a later change keeps it. |
| Scopes | Must include `openid`. `openid profile email` by default, and `groups` for those that want it. |
| Admin group, claim | If set, this decides who is an admin at each sign-in. The claim, `groups` by default, holds the names. Empty means sign-in never changes a role. |
| Match existing users by | `email`, `preferred_username` or `sub`. See below. |
| New users | Create on first sign-in, or only if invited. |
| Local accounts | Whether people can sign in with a passphrase. See below. |
| Allow insecure | Allows an issuer over plain `http://`. Only for a test on a trusted network. |

**Test connection** fetches the configuration and keys from the server, and reports which endpoints it
found. It does not try the client secret, so a wrong secret shows at the first sign-in.

## Provider guides

### Pocket ID

Issuer `https://id.example.com`, scopes `openid profile email groups`.

1. In Pocket ID, open Administration → OIDC Clients → Add OIDC Client.
2. Name it "YonDrive", and paste the redirect URI as the callback URL.
3. Save, then copy the client ID and client secret into YonDrive.
4. Optional: limit access to a user group such as `yondrive-users`.

```
Name:           YonDrive
Callback URLs:  https://drive.example.com/auth/oidc/callback
Public client:  off
PKCE:           on

Issuer:         https://id.example.com
```

Pocket ID signs users in with passkeys, so people never type a password for YonDrive. In end-to-end
mode they still choose an unlock passphrase, which Pocket ID never sees.

### Authelia

Issuer `https://auth.example.com`, scopes `openid profile email groups`.

1. Generate a client secret and its hash: `authelia crypto hash generate pbkdf2 --random`.
2. Add the client below under `identity_providers.oidc.clients`.
3. Restart Authelia, and paste the plain secret into YonDrive.

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: 'yondrive'
        client_name: 'YonDrive'
        client_secret: '$pbkdf2-sha512$310000$…'
        public: false
        authorization_policy: 'two_factor'
        require_pkce: true
        pkce_challenge_method: 'S256'
        redirect_uris:
          - 'https://drive.example.com/auth/oidc/callback'
        scopes: ['openid', 'profile', 'email', 'groups']
        token_endpoint_auth_method: 'client_secret_basic'
```

`authorization_policy: two_factor` makes Authelia ask for a second factor before YonDrive sees the
user. Authelia puts most claims in userinfo rather than the ID token, which YonDrive reads as needed.

### Authentik

Issuer `https://authentik.example.com/application/o/yondrive/`, with the trailing slash, and scopes
`openid profile email`.

1. Applications → Providers → Create → OAuth2/OpenID Provider.
2. Client type: Confidential. Add the redirect URI.
3. Create an Application with slug `yondrive` and attach the provider.
4. Copy the client ID and secret. The issuer includes the slug.

```
Provider type:  OAuth2/OpenID Provider
Client type:    Confidential
Redirect URIs:  https://drive.example.com/auth/oidc/callback
Signing key:    authentik Self-signed Certificate

Issuer:         https://authentik.example.com/application/o/yondrive/
```

Choose a signing key. Without one, Authentik signs with HS256, which YonDrive refuses. Authentik sends
groups in the `profile` scope by default, so no extra `groups` scope is needed.

### Keycloak

Issuer `https://keycloak.example.com/realms/home`, scopes `openid profile email`.

1. In your realm, Clients → Create client → OpenID Connect, ID `yondrive`.
2. Turn on Client authentication, and keep Standard flow.
3. Add the redirect URI to Valid redirect URIs.
4. Add a "Group Membership" mapper with claim name `groups`.

```
Client ID:              yondrive
Client authentication:  On
Valid redirect URIs:    https://drive.example.com/auth/oidc/callback
Mapper:                 Group Membership → groups

Issuer:                 https://keycloak.example.com/realms/home
```

Turn off "Full group path" on the mapper, so that the admin group reads `yondrive-admins` and not
`/yondrive-admins`.

### Others

Issuer `https://sso.example.com`, scopes `openid profile email`. This works with Zitadel, Kanidm, Dex,
Google Workspace and anything else that speaks OpenID Connect.

1. Create a confidential client using the authorization code flow.
2. Add the redirect URI.
3. Make sure the provider publishes `/.well-known/openid-configuration`.
4. Optional: expose a groups claim, to map administrators.

```
grant_types:     authorization_code
response_types:  code
redirect_uri:    https://drive.example.com/auth/oidc/callback
scopes:          openid profile email

Discovery:       <issuer>/.well-known/openid-configuration
```

The provider must sign ID tokens with RS256, ES256 or EdDSA. RSA keys need at least 2048 bits. The
client authenticates with `client_secret_basic` or `client_secret_post`, whichever discovery offers.

## Who ends up as whom

Each account remembers its identity as the pair of issuer and `sub`. Someone coming back with that pair
is that account, whatever their email or name has become. For a pair not seen before:

| Match mode | Links to a local account with | Notes |
| --- | --- | --- |
| `email` | The same address, when `email_verified` is true | Must be the boolean `true`. A provider that sends the string `"true"` counts as not verified. A match that is not verified is refused. |
| `preferred_username` | The same username | Only with a provider whose usernames an admin assigns. If people choose their own, they can choose someone else's. |
| `sub` | Nothing | Everyone gets a new account. |

Whatever links nothing becomes a new account, if new users are allowed. The username comes from
`preferred_username` or the address, with a suffix if taken. Only a verified address is stored. Under
"only if invited", they need an invite for their verified address, or an invite link's token.

An account linked to one identity is never moved to another by signing in, and that sign-in is refused
with `sso_identity_conflict`. After changing provider, or when a provider has changed its `sub`, an admin
forgets the old identity with `DELETE /api/v1/admin/users/{id}/identity`, and the next sign-in links again
under the match mode. The server refuses with `identity_not_relinkable` (409) when the match mode could not
find the account again, which is `sub`, `email` for an account with no address, and `preferred_username`
for one whose username does not fit: the next sign-in would make an empty account and leave this one out of
reach. Change the match mode first, or give the account an address.

## Admins, local accounts and getting back in

The admin from the wizard always has a passphrase. The oldest enabled admin with a passphrase is the
**fallback admin**. They can always sign in with it, even with local accounts turned off and whatever the
provider says, and the admin group never demotes them. Keep their passphrase and recovery key safe, as
they are how you get back in if the provider is down or misconfigured.

With local accounts off, nobody else can sign in with a passphrase or register. YonDrive refuses to turn
them off without a working provider setting and a local admin.

## Passphrases and the second factor

**End-to-end mode.** The provider's word gets a session, which opens nothing. On first sign-in people
choose an **unlock passphrase** and save a recovery key, and they enter that passphrase to unlock.
The provider never sees it. They can sign in through the provider on a new device, and lost passphrases
are recovered with the recovery key's words after signing in through the provider. An admin cannot reset
it, and neither can the provider.

**No-encryption mode.** There is no unlock passphrase. Sensitive actions ask for a fresh sign-in through
the provider, within five minutes.

**Second factor.** Configure it at the provider. TOTP in YonDrive is for local sign-in.

## An internal certificate authority

The image carries a CA bundle for public certificates. For an issuer behind your own authority, put its
certificate in a PEM file, and give the path in `YONDRIVE_CA_FILE`, such as `/data/ca.pem`. It is trusted
as well as the bundle. The server does not start if it cannot read the file. Do not use plain `http://`
to get around this: the client secret travels to the token endpoint.

## When it fails

A failed sign-in lands on the sign-in page with a code, and the details are in the server's log.

| Code | Usually means |
| --- | --- |
| `sso_state_invalid` | The browser did not bring back its cookie: more than ten minutes went by, or the public URL differs from the address the sign-in started on, or `YONDRIVE_SECURE` does not match how the site is really reached. |
| `sso_denied` | The provider refused, or the user cancelled. |
| `sso_provider_error` | Discovery, the token endpoint or userinfo failed. Most often a wrong secret, a redirect URI that does not match, an unknown certificate authority, or the provider being unreachable from the container. |
| `sso_token_invalid` | The ID token failed verification: an algorithm that is not allowed, a clock that differs by more than a minute, a client ID that is not the audience. |
| `sso_identity_conflict` | The match points at an account linked to another identity. |
| `sso_email_unverified` | The address belongs to an account, and the provider has not verified it. |
| `sso_not_invited` | New users need an invite, and this person has none. |
| `user_disabled` | The account is disabled here. |

Test connection answers `invalid_issuer`, `oidc_issuer_mismatch` (the issuer URL is not spelled as the
provider spells it), `oidc_discovery_failed` or `oidc_keys_failed`.
