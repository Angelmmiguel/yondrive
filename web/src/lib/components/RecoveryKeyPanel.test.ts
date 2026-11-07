// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { newRecovery } from '$lib/account/recovery-key';
import { sealerFor, SUITE_E2E } from '$lib/crypto/sealer';
import RecoveryKeyPanel from './RecoveryKeyPanel.svelte';

describe('RecoveryKeyPanel', () => {
	it('shows 24 words and asks for three by number', () => {
		const pending = newRecovery(sealerFor(SUITE_E2E));
		render(RecoveryKeyPanel, { pending, username: 'a', server: 's' });
		expect(screen.getByTestId('recovery-words').querySelectorAll('li')).toHaveLength(24);
		for (const position of pending.asked) {
			expect(screen.getByLabelText(new RegExp(`^Word ${position + 1}\\b`))).toBeTruthy();
		}
	});

	it('says it matches only with all three right', async () => {
		const pending = newRecovery(sealerFor(SUITE_E2E));
		render(RecoveryKeyPanel, { pending, username: 'a', server: 's' });
		const inputs = pending.asked.map((p) =>
			screen.getByLabelText<HTMLInputElement>(new RegExp(`^Word ${p + 1}\\b`))
		);
		await fireEvent.input(inputs[0], { target: { value: pending.words[pending.asked[0]] } });
		await fireEvent.input(inputs[1], { target: { value: pending.words[pending.asked[1]] } });
		expect(screen.queryByText('That matches.')).toBeNull();
		await fireEvent.input(inputs[2], { target: { value: pending.words[pending.asked[2]] } });
		expect(await screen.findByText('That matches.')).toBeTruthy();
	});
});
