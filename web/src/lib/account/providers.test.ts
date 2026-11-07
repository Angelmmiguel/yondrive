import { describe, expect, it } from 'vitest';
import {
	describeOidcTest,
	newOidcForm,
	oidcFormProblem,
	oidcInput,
	PROVIDERS,
	providerById
} from './providers';

describe('the provider guides', () => {
	it('put the live redirect URI in each snippet, and name no other product', () => {
		for (const provider of PROVIDERS) {
			const redirect = 'https://drive.test/auth/oidc/callback';
			expect(provider.snippet(redirect)).toContain(redirect);
			expect(provider.scopes.split(' ')).toContain('openid');
			expect(provider.steps.length).toBeGreaterThan(2);
			expect(JSON.stringify(provider.steps)).not.toMatch(/burrow/i);
		}
		expect(providerById('nope').id).toBe('other');
	});

	it('fills the form from a provider', () => {
		const form = newOidcForm('keycloak');
		expect(form.issuer).toContain('/realms/');
		expect(form.label).toBe('Keycloak');
		expect(form.matchMode).toBe('email');
	});

	it('says what is missing, and a known secret can stay blank', () => {
		const form = newOidcForm('other');
		expect(oidcFormProblem(form)).toMatch(/client ID/);
		form.clientId = 'yondrive';
		expect(oidcFormProblem(form)).toMatch(/secret/);
		expect(oidcFormProblem(form, true)).toBeNull();
		form.clientSecret = 'x';
		expect(oidcFormProblem(form)).toBeNull();
		form.scopes = 'profile email';
		expect(oidcFormProblem(form)).toMatch(/openid/);
		form.scopes = 'openid';
		form.issuer = ' ';
		expect(oidcFormProblem(form)).toMatch(/issuer/i);
	});

	it('leaves a blank secret out, which keeps the stored one', () => {
		const form = { ...newOidcForm('other'), clientId: ' id ', issuer: ' https://x ' };
		const input = oidcInput(form, true);
		expect(input.client_secret).toBeUndefined();
		expect(input.client_id).toBe('id');
		expect(input.issuer).toBe('https://x');
		expect(oidcInput({ ...form, clientSecret: 's' }, false)).toMatchObject({
			client_secret: 's',
			enabled: false
		});
	});

	it('says what a test found', () => {
		expect(
			describeOidcTest({
				userinfo_endpoint: 'u',
				keys: 2,
				token_auth_method: 'client_secret_basic'
			})
		).toMatch(/userinfo.*2 usable signing keys/);
		expect(describeOidcTest({ keys: 1, token_auth_method: 'client_secret_post' })).toMatch(
			/1 usable signing key\./
		);
	});
});
