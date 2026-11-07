/**
 * The downgrade guard between what the server claims and which sealer the app
 * uses: every flow gets its sealer here. The API spells the mode `e2e` or `none`
 * and the crypto layer names suites, so this is also where one becomes the other.
 */
import type { Mode } from '$lib/api/types';
import {
	accountHasWrappedKeys,
	decideMode,
	sealerFor,
	SUITE_E2E,
	SUITE_NONE,
	type Sealer,
	type Suite,
	type UserKeyRecord
} from '$lib/crypto/sealer';
import type { Deps } from './deps';
import { ModeRefusedError } from './errors';

const SUITES: Record<Mode, Suite> = { e2e: SUITE_E2E, none: SUITE_NONE };

/** The sealer of a mode being chosen, where nothing has been claimed yet. */
export function sealerForMode(mode: Mode): Sealer {
	return sealerFor(SUITES[mode]);
}

function judge(claimed: unknown, record: UserKeyRecord | null, deps: Pick<Deps, 'pin'>): Suite {
	const decision = decideMode({
		claimed: typeof claimed === 'string' ? SUITES[claimed as Mode] : undefined,
		accountHasWrappedKeys: accountHasWrappedKeys(record),
		pinned: deps.pin.read()
	});
	if (!decision.accept) throw new ModeRefusedError(decision.reason);
	return decision.suite;
}

/**
 * The sealer for a mode a server claims, or a `ModeRefusedError` and a session
 * that holds no keys and blocks the app. A device with no pin pins what it accepts.
 */
export function acceptMode(
	claimed: unknown,
	record: UserKeyRecord | null,
	deps: Pick<Deps, 'pin' | 'session'>
): Sealer {
	let suite: Suite;
	try {
		suite = judge(claimed, record, deps);
	} catch (e) {
		if (e instanceof ModeRefusedError) deps.session.refuse(e.reason);
		throw e;
	}
	if (deps.pin.read() === null) deps.pin.write(suite);
	return sealerFor(suite);
}

/** Checks a mode the wizard is about to write, without pinning it yet. */
export function checkMode(mode: Mode, deps: Pick<Deps, 'pin' | 'session'>): Sealer {
	try {
		return sealerFor(judge(mode, null, deps));
	} catch (e) {
		if (e instanceof ModeRefusedError) deps.session.refuse(e.reason);
		throw e;
	}
}
