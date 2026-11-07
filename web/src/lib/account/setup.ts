/** Making an account: the first admin through the wizard, the others by registering. */
import type { NewAccount, ServerSettingsInput, SignInSettingsInput } from '$lib/api/types';
import { normalizePassphrase } from '$lib/crypto/kdf';
import { zeroIdentity } from '$lib/crypto/keys';
import { zero } from '$lib/crypto/random';
import type { Sealer } from '$lib/crypto/sealer';
import { deriveKeys } from './credentials';
import { defaultDeps, type Deps } from './deps';
import { checkMode } from './mode';
import { newAccountBody } from './wire';

export interface NewUser {
	username: string;
	email: string;
	passphrase: string;
	/** From `newRecovery`, empty in a mode without one. Stays the caller's to discard. */
	recoveryKey: Uint8Array;
}

async function accountBody(
	user: NewUser,
	sealer: Sealer,
	deps: Pick<Deps, 'deriveRoot' | 'newKdfParams'>
): Promise<NewAccount> {
	normalizePassphrase(user.passphrase);
	const kdf = deps.newKdfParams();
	const { kek, authKey } = await deriveKeys(user.passphrase, kdf, deps);
	const recovery = sealer.expandRecoveryKey(user.recoveryKey);
	try {
		const { keys, record } = sealer.createUser(kek, recovery.kek);
		zero(keys.masterKey);
		zeroIdentity(keys.identity);
		return newAccountBody({
			username: user.username,
			email: user.email,
			authKey,
			kdf,
			recoveryAuthKey: recovery.authKey,
			record
		});
	} finally {
		zero(kek, authKey, recovery.kek, recovery.authKey);
	}
}

/**
 * Stores the settings and creates the first admin. The mode goes through the
 * guard first, and is pinned only once the server has it: a failed setup must not
 * tie the device to a choice that can still change.
 */
export async function completeSetup(
	input: {
		token: string;
		settings: ServerSettingsInput;
		admin: NewUser;
		signIn?: SignInSettingsInput;
	},
	deps: Deps = defaultDeps
): Promise<void> {
	const sealer = checkMode(input.settings.mode, deps);
	const admin = await accountBody(input.admin, sealer, deps);
	await deps.api.completeSetup(input.token, {
		settings: input.settings,
		admin,
		sign_in: input.signIn
	});
	deps.pin.write(sealer.suite);
}

/** Creates an account from an invite, or without one where open sign-up is on. */
export async function register(
	input: { inviteToken: string | null; user: NewUser; sealer: Sealer },
	deps: Deps = defaultDeps
): Promise<void> {
	const account = await accountBody(input.user, input.sealer, deps);
	await deps.api.register({ invite_token: input.inviteToken ?? undefined, account });
}
