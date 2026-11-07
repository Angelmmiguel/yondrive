/**
 * A small OpenID Connect provider for the browser specs, in Node: discovery, the code
 * flow with PKCE, a client secret and RS256 tokens. It checks what a real one checks, so
 * that a sign-in works only if the server behaves, and it always says yes as whoever a
 * spec sets, unless the spec says otherwise.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CLIENT_ID = 'yondrive';
export const CLIENT_SECRET = 'the secret of the test client';

export interface Identity {
	sub: string;
	email?: string;
	email_verified?: boolean;
	preferred_username?: string;
	groups?: string[];
}

export interface FakeProvider {
	issuer: string;
	/** Who signs in next. */
	who: Identity;
	/** Sends the next sign-in back refused, as someone pressing cancel does. */
	denyNext: boolean;
	/** Makes the token endpoint fail, as a wrong client secret does. */
	refuseTokens: boolean;
	/** Each sign-in that reached the authorization endpoint, with its parameters. */
	authorizations: URLSearchParams[];
	stop(): Promise<void>;
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

function read(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => resolve(body));
	});
}

export async function startProvider(who: Identity = { sub: 'first' }): Promise<FakeProvider> {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const jwk = publicKey.export({ format: 'jwk' });
	const kid = 'test-key';
	const codes = new Map<string, { nonce: string; challenge: string; who: Identity }>();
	const tokens = new Map<string, Identity>();

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', provider.issuer);
		const json = (status: number, body: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		switch (url.pathname) {
			case '/.well-known/openid-configuration':
				return json(200, {
					issuer: provider.issuer,
					authorization_endpoint: `${provider.issuer}/authorize`,
					token_endpoint: `${provider.issuer}/token`,
					userinfo_endpoint: `${provider.issuer}/userinfo`,
					jwks_uri: `${provider.issuer}/jwks`,
					response_types_supported: ['code'],
					subject_types_supported: ['public'],
					id_token_signing_alg_values_supported: ['RS256'],
					code_challenge_methods_supported: ['S256'],
					token_endpoint_auth_methods_supported: ['client_secret_basic']
				});
			case '/jwks':
				return json(200, { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
			case '/authorize': {
				provider.authorizations.push(url.searchParams);
				const back = new URL(url.searchParams.get('redirect_uri') ?? '');
				back.searchParams.set('state', url.searchParams.get('state') ?? '');
				if (provider.denyNext) {
					provider.denyNext = false;
					back.searchParams.set('error', 'access_denied');
				} else {
					const code = randomBytes(16).toString('hex');
					codes.set(code, {
						nonce: url.searchParams.get('nonce') ?? '',
						challenge: url.searchParams.get('code_challenge') ?? '',
						who: { ...provider.who }
					});
					back.searchParams.set('code', code);
				}
				res.writeHead(302, { location: back.href });
				return res.end();
			}
			case '/token': {
				const form = new URLSearchParams(await read(req));
				const basic = Buffer.from(
					(req.headers.authorization ?? '').replace(/^Basic /, ''),
					'base64'
				).toString();
				const [id, secret] = basic
					.split(':')
					// Each half is form-encoded first (RFC 6749, 2.3.1), so a space arrives as a plus.
					.map((half) => decodeURIComponent(half.replaceAll('+', ' ')));
				const grant = codes.get(form.get('code') ?? '');
				if (provider.refuseTokens || id !== CLIENT_ID || secret !== CLIENT_SECRET) {
					return json(401, { error: 'invalid_client' });
				}
				const verifier = createHash('sha256')
					.update(form.get('code_verifier') ?? '')
					.digest('base64url');
				if (grant === undefined || verifier !== grant.challenge) {
					return json(400, { error: 'invalid_grant' });
				}
				codes.delete(form.get('code') ?? '');
				const now = Math.floor(Date.now() / 1000);
				const claims = {
					iss: provider.issuer,
					aud: CLIENT_ID,
					iat: now,
					exp: now + 300,
					nonce: grant.nonce,
					...grant.who
				};
				const input = `${b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
				const signature = createSign('RSA-SHA256').update(input).sign(privateKey);
				const access = randomBytes(16).toString('hex');
				tokens.set(access, grant.who);
				return json(200, {
					access_token: access,
					token_type: 'Bearer',
					expires_in: 300,
					id_token: `${input}.${b64url(signature)}`
				});
			}
			case '/userinfo': {
				const known = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
				return known === undefined ? json(401, {}) : json(200, known);
			}
			default:
				res.writeHead(404);
				return res.end();
		}
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	const provider: FakeProvider = {
		issuer: `http://127.0.0.1:${port}`,
		who,
		denyNext: false,
		refuseTokens: false,
		authorizations: [],
		stop: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
	return provider;
}
