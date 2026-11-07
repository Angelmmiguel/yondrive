<!--
  The first-run wizard, in the shape of the Setup board and with the changes in
  PLAN section 3. Everything stays in memory until Finish, so a reload starts over
  with a new recovery key. Without a token in the address it only says where to
  find the link.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { onDestroy } from 'svelte';
	import { writeDisplayName } from '$lib/account/display-name';
	import { sealerForMode } from '$lib/account/mode';
	import { discardRecovery, newRecovery, type PendingRecovery } from '$lib/account/recovery-key';
	import { completeSetup } from '$lib/account/setup';
	import { passphraseProblem } from '$lib/account/strength';
	import { api } from '$lib/api/client';
	import { isApiError, type Mode, type SetupInfo } from '$lib/api/types';
	import { boot } from '$lib/app/boot';
	import { failure } from '$lib/app/failure';
	import { formatBytes, GB, QUOTA_OPTIONS } from '$lib/app/format';
	import {
		AuthCard,
		Banner,
		Button,
		Card,
		Field,
		Icon,
		Logo,
		PassphraseFields,
		ProgressBar,
		RadioCard,
		RadioGroup,
		RecoveryKeyPanel,
		Select,
		Stepper,
		Switch,
		TextInput,
		type Step
	} from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	const token = page.url.hash.slice(1);

	let info = $state<SetupInfo | null>(null);
	let blocked = $state<string | null>(null);

	let step = $state('server');
	let finished = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	let name = $state('YonDrive');
	let url = $state(location.origin);
	let quota = $state(String(500 * GB));
	let timeZone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

	let mode = $state<Mode>('e2e');
	const sealer = $derived(sealerForMode(mode));

	let displayName = $state('');
	let username = $state('');
	let email = $state('');
	let passphrase = $state('');
	let confirmation = $state('');
	let wantsTotp = $state(false);

	let pending = $state.raw<PendingRecovery | null>(null);
	let confirmed = $state(false);

	const STEPS: Step[] = [
		{ id: 'server', label: 'Server', hint: 'Name, address, storage' },
		{ id: 'encryption', label: 'Encryption', hint: 'End-to-end or none' },
		{ id: 'admin', label: 'Admin account', hint: 'Your first local user' },
		{ id: 'recovery', label: 'Recovery key', hint: 'Save it somewhere safe' },
		{ id: 'review', label: 'Review', hint: 'Check and finish' }
	];
	const steps = $derived(STEPS.filter((s) => s.id !== 'recovery' || sealer.encrypted));
	const at = $derived(steps.findIndex((s) => s.id === step));

	const TEXT: Record<string, { title: string; intro: string }> = {
		server: {
			title: 'Set up your server',
			intro: 'Basic details about this YonDrive and where it keeps files.'
		},
		encryption: {
			title: 'Choose how files are encrypted',
			intro: 'This applies to the whole server, and is the one setting you cannot change later.'
		},
		admin: {
			title: 'Create the first administrator',
			intro: 'A local account with full access. Other people can be invited afterwards.'
		},
		recovery: {
			title: 'Your recovery key',
			intro: 'A lost passphrase can be replaced only with this key.'
		},
		review: {
			title: 'Review and finish',
			intro: 'Make sure everything looks right. You can jump back to any step.'
		}
	};

	const usernameMissing = $derived(username.trim() === '');
	const passphraseIssue = $derived(passphraseProblem(passphrase, confirmation));
	const zones = $derived.by(() => {
		let names: string[] = [];
		try {
			names = Intl.supportedValuesOf('timeZone');
		} catch {
			// An older browser: the one the browser reports, and UTC.
		}
		const all = new Set([timeZone, 'UTC', ...names]);
		return [...all].map((z) => ({ value: z, label: z }));
	});

	const canContinue = $derived.by(() => {
		if (step === 'server') return name.trim() !== '' && url.trim() !== '';
		if (step === 'admin') return !usernameMissing && passphraseIssue === null;
		if (step === 'recovery') return confirmed;
		return true;
	});
	const blockedHint = $derived.by(() => {
		if (canContinue) return '';
		if (step === 'server') return 'A name and an address are needed.';
		if (step === 'admin') return usernameMissing ? 'Choose a username.' : (passphraseIssue ?? '');
		if (step === 'recovery') return 'Type the three words back to continue.';
		return '';
	});

	$effect(() => {
		if (token === '') return;
		api
			.getSetupInfo(token)
			.then((i) => {
				info = i;
				if (i.public_url) url = i.public_url;
			})
			.catch((e: unknown) => {
				if (isApiError(e, 'already_setup')) void boot();
				else blocked = failure(e);
			});
	});

	onDestroy(forgetRecovery);

	function forgetRecovery() {
		if (pending) discardRecovery(pending);
		pending = null;
		confirmed = false;
	}

	function go(id: string) {
		error = null;
		if (id === 'recovery') pending ??= newRecovery(sealer);
		step = id;
	}

	async function next() {
		error = null;
		if (step === 'server') {
			busy = true;
			try {
				url = (await api.validateSetupUrl(token, url)).url;
			} catch (e) {
				error = failure(e);
				return;
			} finally {
				busy = false;
			}
		}
		if (at === steps.length - 1) {
			await finish();
			return;
		}
		go(steps[at + 1].id);
	}

	async function finish() {
		busy = true;
		error = null;
		try {
			await completeSetup({
				token,
				settings: {
					name: name.trim(),
					public_url: url,
					default_quota_bytes: Number(quota),
					language: 'en',
					time_zone: timeZone,
					mode
				},
				admin: {
					username: username.trim(),
					email,
					passphrase,
					recoveryKey: pending?.key ?? new Uint8Array(0)
				}
			});
			writeDisplayName(localStorage, displayName);
			session.wantsTotp = wantsTotp;
			forgetRecovery();
			passphrase = '';
			confirmation = '';
			finished = true;
		} catch (e) {
			error = failure(e);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Setup · YonDrive</title></svelte:head>

{#if token === ''}
	<AuthCard
		title="This server is waiting to be set up"
		lede="For safety, setup needs the link the server printed to its logs when it started."
		width={520}
	>
		<p class="plain">
			Open the server's logs and look for a line with <code>first-run setup required</code>. The
			link there ends in <code>/setup#</code> and a one-time token. Restarting the server prints a new
			one.
		</p>
	</AuthCard>
{:else if blocked}
	<AuthCard title="This setup link does not work">
		<Banner tone="danger">{blocked}</Banner>
	</AuthCard>
{:else if info}
	<div class="page">
		<header class="brand">
			<Logo size={28} />
			<span class="product">YonDrive</span>
			<span class="sub">· First-run setup</span>
			<span class="version">{info.version}</span>
		</header>
		<div class="layout">
			<div class="rail">
				<Stepper label="Setup steps" {steps} current={step} onselect={go} />
				<Card variant="dashed">
					<span class="small">
						Everything here can be changed later in Administration, except the encryption mode.
					</span>
				</Card>
			</div>
			<main class="card">
				{#if finished}
					<div class="done">
						<span class="tick"><Icon name="check" size={28} strokeWidth={2.4} /></span>
						<h1>YonDrive is ready</h1>
						<p>
							Your server is configured. Sign in as <strong>{username}</strong> to start{wantsTotp
								? ' and set up two-factor sign-in'
								: ''}.
						</p>
						<Button variant="primary" trailingIcon="arrow-right" onclick={() => boot()}>
							Go to sign in
						</Button>
					</div>
				{:else}
					<div class="head">
						<span class="counter">Step {at + 1} of {steps.length}</span>
						<h1>{TEXT[step].title}</h1>
						<p>{TEXT[step].intro}</p>
						<ProgressBar label="Setup progress" value={at + 1} max={steps.length} height={4} />
					</div>
					<div class="body">
						{#if error}<Banner tone="danger">{error}</Banner>{/if}
						{#if step === 'server'}
							<div class="fields">
								<Field label="Server name" hint="Shown in the app and in share links." required>
									{#snippet children(field)}<TextInput {...field} bind:value={name} />{/snippet}
								</Field>
								<Field
									label="Public URL"
									hint="The address people use, usually behind your reverse proxy."
									required
								>
									{#snippet children(field)}
										<TextInput {...field} bind:value={url} mono spellcheck="false" />
									{/snippet}
								</Field>
								<Field
									label="Data directory"
									hint={info.free_bytes === undefined
										? 'Set through the environment.'
										: `Set through the environment · ${formatBytes(info.free_bytes)} free`}
								>
									{#snippet children(field)}
										<TextInput {...field} value={info?.data_dir} mono readonly />
									{/snippet}
								</Field>
								<Field label="Default storage per user" hint="You can override it per user.">
									{#snippet children(field)}
										<Select {...field} options={QUOTA_OPTIONS} bind:value={quota} />
									{/snippet}
								</Field>
								<Field label="Time zone">
									{#snippet children(field)}
										<Select {...field} options={zones} bind:value={timeZone} />
									{/snippet}
								</Field>
							</div>
							{#if url.trim().toLowerCase().startsWith('http://')}
								<Banner tone="warn" title="This address is plain HTTP">
									It works, but anyone on the network can see or change what is sent, including the
									app itself. Put YonDrive behind an HTTPS reverse proxy for anything beyond a
									network you trust.
								</Banner>
							{/if}
						{:else if step === 'encryption'}
							<RadioGroup
								label="Encryption mode"
								bind:value={mode}
								onchange={() => forgetRecovery()}
							>
								<RadioCard value="e2e" title="End-to-end" badge="Recommended" icon="shield-check">
									Everything is encrypted on each person's device, with their own keys. The server
									stores what it cannot read, and nobody can reset a lost passphrase.
								</RadioCard>
								<RadioCard value="none" title="No encryption" icon="lock-open">
									Files are stored as they are. You get the same features, all still running on the
									device, but anyone with access to the server or its disks can read them.
								</RadioCard>
							</RadioGroup>
							{#if sealer.encrypted}
								<div class="notes">
									<Card variant="sunken">
										<strong>Keys stay on devices</strong>
										<span class="small">
											Each person's key is created in their browser. The server only stores
											encrypted blobs and public keys.
										</span>
									</Card>
									<Card variant="sunken">
										<strong>Encrypted per user</strong>
										<span class="small">
											Every file, name, thumbnail and note is encrypted before upload. Shared items
											are wrapped again for each person's public key.
										</span>
									</Card>
									<Card variant="sunken">
										<strong>Done on your device</strong>
										<span class="small">
											Search, previews and thumbnails are built locally, so the first sync on a new
											device takes longer.
										</span>
									</Card>
								</div>
								<Field label="Algorithms" hint="Key derivation · file encryption · key sharing.">
									{#snippet children(field)}
										<TextInput
											{...field}
											value="Argon2id · XChaCha20-Poly1305 · X25519"
											mono
											readonly
										/>
									{/snippet}
								</Field>
							{:else}
								<Banner tone="neutral" icon="info">
									Search, previews and thumbnails are still built on each device, exactly as with
									encryption, and the server never processes your files. It simply stores them
									readable, so anyone with access to the server or its disks can read them. Use disk
									encryption, such as LUKS or ZFS native encryption, against stolen drives. An
									administrator can reset passwords in this mode.
								</Banner>
							{/if}
						{:else if step === 'admin'}
							<Banner tone="info" icon="shield">
								This first account is a local administrator, your way in whatever else you set up
								later.
							</Banner>
							<div class="fields">
								<Field
									label="Your name"
									hint="Stays on this device. It is never sent to the server."
								>
									{#snippet children(field)}
										<TextInput {...field} bind:value={displayName} autocomplete="name" />
									{/snippet}
								</Field>
								<Field label="Username" required>
									{#snippet children(field)}
										<TextInput
											{...field}
											bind:value={username}
											mono
											autocomplete="username"
											autocapitalize="off"
											spellcheck="false"
										/>
									{/snippet}
								</Field>
								<Field label="Email" hint="Optional.">
									{#snippet children(field)}
										<TextInput {...field} bind:value={email} type="email" autocomplete="email" />
									{/snippet}
								</Field>
							</div>
							<div class="fields">
								<PassphraseFields bind:passphrase bind:confirmation />
							</div>
							<div class="switch-row">
								<span class="switch-text">
									<span class="switch-label">Set up two-factor sign-in</span>
									<span class="small"
										>With an authenticator app, right after you first sign in.</span
									>
								</span>
								<Switch label="Set up two-factor sign-in" bind:checked={wantsTotp} />
							</div>
						{:else if step === 'recovery' && pending}
							<RecoveryKeyPanel {pending} {username} server={name} bind:confirmed />
						{:else if step === 'review'}
							<div class="review">
								<section>
									<div class="row">
										<h2>Server</h2>
										<Button variant="ghost" size="sm" onclick={() => go('server')}>Edit</Button>
									</div>
									<dl>
										<dt>Name</dt>
										<dd>{name}</dd>
										<dt>Public URL</dt>
										<dd>{url}</dd>
										<dt>Data directory</dt>
										<dd>{info.data_dir}</dd>
									</dl>
								</section>
								<section>
									<div class="row">
										<h2>Encryption</h2>
										<Button variant="ghost" size="sm" onclick={() => go('encryption')}>Edit</Button>
									</div>
									<dl>
										<dt>Mode</dt>
										<dd>{sealer.encrypted ? 'End-to-end' : 'No encryption'}</dd>
										{#if sealer.encrypted}
											<dt>Your recovery key</dt>
											<dd>Saved and confirmed</dd>
										{/if}
									</dl>
								</section>
								<section>
									<div class="row">
										<h2>Administrator</h2>
										<Button variant="ghost" size="sm" onclick={() => go('admin')}>Edit</Button>
									</div>
									<dl>
										<dt>Username</dt>
										<dd>{username}</dd>
										{#if email.trim()}
											<dt>Email</dt>
											<dd>{email}</dd>
										{/if}
										<dt>Two-factor</dt>
										<dd>{wantsTotp ? 'Set up after first sign-in' : 'Not now'}</dd>
									</dl>
								</section>
							</div>
						{/if}
					</div>
					<div class="foot">
						{#if at > 0}
							<Button onclick={() => go(steps[at - 1].id)}>Back</Button>
						{/if}
						<span class="hint">{blockedHint}</span>
						<Button
							variant="primary"
							trailingIcon="arrow-right"
							{busy}
							disabled={!canContinue}
							onclick={next}
						>
							{at === steps.length - 1 ? (busy ? 'Setting up…' : 'Finish setup') : 'Continue'}
						</Button>
					</div>
				{/if}
			</main>
		</div>
	</div>
{/if}

<style>
	.plain {
		margin: 0;
		color: var(--text-soft);
	}

	code {
		font-family: var(--font-mono);
		font-size: 12.5px;
	}

	.page {
		flex: 1;
		display: flex;
		flex-direction: column;
		background: var(--surface-side);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 16px 28px;
	}

	.product {
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}

	.sub {
		font-size: 13px;
		color: var(--text-muted);
	}

	.version {
		margin-left: auto;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-muted);
	}

	.layout {
		flex: 1;
		width: 100%;
		max-width: 1180px;
		margin: 0 auto;
		padding: 12px 24px 48px;
		display: flex;
		flex-wrap: wrap;
		gap: 28px;
		align-items: flex-start;
	}

	.rail {
		flex: 1 1 240px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.small {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.card {
		flex: 999 1 600px;
		min-width: 0;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 20px;
		box-shadow: 0 20px 50px -36px var(--shadow-ink);
	}

	.head {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 28px 32px 0;
	}

	.counter {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-muted);
	}

	h1 {
		margin: 0;
		font-size: 26px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-strong);
	}

	.head p {
		margin: 0 0 8px;
		max-width: 640px;
		color: var(--text-muted);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 22px;
		padding: 28px 32px;
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
		gap: 18px 20px;
		align-items: start;
	}

	.notes {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
		gap: 12px;
	}

	.notes strong {
		display: block;
		margin-bottom: 6px;
		font-weight: 600;
		color: var(--text-strong);
	}

	.switch-row {
		display: flex;
		align-items: center;
		gap: 14px;
		min-height: 56px;
		padding-top: 14px;
		border-top: 1px solid var(--divider);
	}

	.switch-text {
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.switch-label {
		font-weight: 500;
		color: var(--text-strong);
	}

	.review {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.review section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px 18px;
		border: 1px solid var(--border);
		border-radius: 14px;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		color: var(--text-strong);
	}

	dl {
		display: grid;
		grid-template-columns: minmax(100px, 160px) minmax(0, 1fr);
		gap: 6px 14px;
		margin: 0;
		font-size: 13px;
	}

	dt {
		color: var(--text-muted);
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.foot {
		margin-top: auto;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		padding: 18px 32px;
		border-top: 1px solid var(--divider);
	}

	.hint {
		margin-left: auto;
		font-size: 13px;
		color: var(--text-muted);
	}

	.done {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		padding: 48px 20px;
		text-align: center;
	}

	.done p {
		margin: 0;
		max-width: 440px;
		color: var(--text-muted);
	}

	.tick {
		width: 64px;
		height: 64px;
		display: grid;
		place-items: center;
		border-radius: 99px;
		background: var(--ok-soft);
		color: var(--ok);
	}

	@media (max-width: 640px) {
		.brand {
			padding: 14px 16px;
		}

		.layout {
			padding: 8px 12px 32px;
			gap: 16px;
		}

		.rail :global(.step) {
			min-height: 44px;
		}

		.head {
			padding: 20px 18px 0;
		}

		.body {
			padding: 20px 18px;
		}

		.foot {
			padding: 14px 18px;
		}
	}
</style>
