/**
 * The identity providers the sign-in settings have a guide for, drawn as monograms.
 * Which of them someone picks only fills in the form: a provider is any issuer.
 */
export type ProviderId = 'pocketid' | 'authelia' | 'authentik' | 'keycloak' | 'other';

export interface Provider {
	id: ProviderId;
	name: string;
	tag: string;
	mono: string;
	tone: 'blue' | 'green' | 'orange' | 'rose' | 'grey';
	label: string;
	issuer: string;
	scopes: string;
	steps: string[];
	snippet: (redirect: string) => string;
	note: string;
}

export const PROVIDERS: readonly Provider[] = [
	{
		id: 'pocketid',
		name: 'Pocket ID',
		tag: 'Passkeys only',
		mono: 'P',
		tone: 'rose',
		label: 'Pocket ID',
		issuer: 'https://id.example.com',
		scopes: 'openid profile email groups',
		steps: [
			'In Pocket ID, open Administration → OIDC Clients → Add OIDC Client.',
			'Name it “YonDrive” and paste the redirect URI as the callback URL.',
			'Save, then copy the client ID and client secret into this form.',
			'Optional: limit access to a user group such as yondrive-users.'
		],
		snippet: (redirect) =>
			`Name:           YonDrive\nCallback URLs:  ${redirect}\nPublic client:  off\nPKCE:           on\n\nIssuer:         https://id.example.com`,
		note: 'Pocket ID signs users in with passkeys, so people never type a password for YonDrive. In end-to-end mode they still choose an unlock passphrase, which Pocket ID never sees.'
	},
	{
		id: 'authelia',
		name: 'Authelia',
		tag: 'YAML config',
		mono: 'A',
		tone: 'blue',
		label: 'Authelia',
		issuer: 'https://auth.example.com',
		scopes: 'openid profile email groups',
		steps: [
			'Generate a client secret and its hash: authelia crypto hash generate pbkdf2 --random',
			'Add the client below under identity_providers.oidc.clients.',
			'Restart Authelia and paste the plain secret into this form.'
		],
		snippet: (redirect) =>
			`identity_providers:\n  oidc:\n    clients:\n      - client_id: 'yondrive'\n        client_name: 'YonDrive'\n        client_secret: '$pbkdf2-sha512$310000$…'\n        public: false\n        authorization_policy: 'two_factor'\n        require_pkce: true\n        pkce_challenge_method: 'S256'\n        redirect_uris:\n          - '${redirect}'\n        scopes: ['openid', 'profile', 'email', 'groups']\n        token_endpoint_auth_method: 'client_secret_basic'`,
		note: 'authorization_policy: two_factor makes Authelia ask for a second factor before YonDrive sees the user.'
	},
	{
		id: 'authentik',
		name: 'Authentik',
		tag: 'Provider + app',
		mono: 'Ak',
		tone: 'orange',
		label: 'Authentik',
		issuer: 'https://authentik.example.com/application/o/yondrive/',
		scopes: 'openid profile email',
		steps: [
			'Applications → Providers → Create → OAuth2/OpenID Provider.',
			'Client type: Confidential. Add the redirect URI below.',
			'Create an Application with slug “yondrive” and attach the provider.',
			'Copy the client ID and secret. The issuer includes the slug.'
		],
		snippet: (redirect) =>
			`Provider type:  OAuth2/OpenID Provider\nClient type:    Confidential\nRedirect URIs:  ${redirect}\nSigning key:    authentik Self-signed Certificate\n\nIssuer:         https://authentik.example.com/application/o/yondrive/`,
		note: 'Choose a signing key: without one, Authentik signs with HS256, which YonDrive refuses. Groups come in the profile scope, so no extra scope is needed.'
	},
	{
		id: 'keycloak',
		name: 'Keycloak',
		tag: 'Realm client',
		mono: 'K',
		tone: 'green',
		label: 'Keycloak',
		issuer: 'https://keycloak.example.com/realms/home',
		scopes: 'openid profile email',
		steps: [
			'In your realm, Clients → Create client → OpenID Connect, ID “yondrive”.',
			'Turn on Client authentication, and keep Standard flow.',
			'Add the redirect URI below to Valid redirect URIs.',
			'Add a “Group Membership” mapper with claim name groups.'
		],
		snippet: (redirect) =>
			`Client ID:              yondrive\nClient authentication:  On\nValid redirect URIs:    ${redirect}\nMapper:                 Group Membership → groups\n\nIssuer:                 https://keycloak.example.com/realms/home`,
		note: 'Turn off “Full group path” on the mapper, so that the admin group reads yondrive-admins and not /yondrive-admins.'
	},
	{
		id: 'other',
		name: 'Other',
		tag: 'Any OIDC provider',
		mono: '…',
		tone: 'grey',
		label: 'Single sign-on',
		issuer: 'https://sso.example.com',
		scopes: 'openid profile email',
		steps: [
			'Create a confidential client using the authorization code flow.',
			'Add the redirect URI below.',
			'Make sure the provider publishes /.well-known/openid-configuration.',
			'Optional: expose a groups claim, to map administrators.'
		],
		snippet: (redirect) =>
			`grant_types:     authorization_code\nresponse_types:  code\nredirect_uri:    ${redirect}\nscopes:          openid profile email\n\nDiscovery:       <issuer>/.well-known/openid-configuration`,
		note: 'This works with Zitadel, Kanidm, Dex, Google Workspace and anything else that speaks OpenID Connect.'
	}
];

export function providerById(id: string): Provider {
	return PROVIDERS.find((one) => one.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

/** The form behind the settings of a provider, in the API's terms. */
export interface OidcForm {
	provider: ProviderId;
	label: string;
	issuer: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	adminGroup: string;
	adminClaim: string;
	matchMode: 'email' | 'preferred_username' | 'sub';
	newUsers: 'create' | 'invited';
	allowInsecure: boolean;
}

export function newOidcForm(id: ProviderId = 'pocketid'): OidcForm {
	const provider = providerById(id);
	return {
		provider: provider.id,
		label: provider.label,
		issuer: provider.issuer,
		clientId: '',
		clientSecret: '',
		scopes: provider.scopes,
		adminGroup: '',
		adminClaim: 'groups',
		matchMode: 'email',
		newUsers: 'create',
		allowInsecure: false
	};
}

/** Whether the form says enough to turn single sign-on on. A known secret can stay blank. */
export function oidcFormProblem(form: OidcForm, secretKnown = false): string | null {
	if (form.label.trim() === '') return 'A button label is needed.';
	if (form.issuer.trim() === '') return 'An issuer URL is needed.';
	if (form.clientId.trim() === '') return 'A client ID is needed.';
	if (!secretKnown && form.clientSecret === '') return 'A client secret is needed.';
	if (!form.scopes.split(/\s+/).includes('openid')) return 'The scopes need to include openid.';
	return null;
}

/** The form as the API takes it, with `enabled` and without a blank secret. */
export function oidcInput(form: OidcForm, enabled: boolean) {
	return {
		enabled,
		label: form.label.trim(),
		issuer: form.issuer.trim(),
		client_id: form.clientId.trim(),
		client_secret: form.clientSecret === '' ? undefined : form.clientSecret,
		scopes: form.scopes.trim(),
		admin_group: form.adminGroup.trim(),
		admin_claim: form.adminClaim.trim(),
		match_mode: form.matchMode,
		new_users: form.newUsers,
		allow_insecure: form.allowInsecure
	};
}

const CLAIMS_OK = 'authorize, token and JWKS endpoints found';

/** What a successful test says. */
export function describeOidcTest(result: {
	userinfo_endpoint?: string;
	keys: number;
	token_auth_method: string;
}): string {
	const found = result.userinfo_endpoint
		? 'authorize, token, userinfo and JWKS endpoints found'
		: CLAIMS_OK;
	const keys = `${result.keys} usable signing ${result.keys === 1 ? 'key' : 'keys'}`;
	return `Discovery OK · ${found} · ${keys}. The client secret is first tried at a real sign-in.`;
}
