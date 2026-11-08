<script lang="ts">
	import {
		AppRail,
		Avatar,
		Banner,
		Button,
		Card,
		Checkbox,
		CodeBlock,
		Dialog,
		EmptyState,
		Field,
		FileList,
		FileRow,
		FileTile,
		ICONS,
		Icon,
		Menu,
		NavItem,
		NavSection,
		PassphraseFields,
		PasswordField,
		ProgressBar,
		RadioCard,
		RadioGroup,
		RecoveryKeyPanel,
		SearchField,
		SegmentedControl,
		Select,
		Sidebar,
		SidePanel,
		Stepper,
		StrengthMeter,
		Switch,
		Tabs,
		Tag,
		TextInput,
		ThemeToggle,
		Toast,
		ToastStack,
		TopBar,
		type IconName,
		type Step
	} from '$lib/components';

	const steps: Step[] = [
		{ id: 'server', label: 'Server', hint: 'Name and address' },
		{ id: 'encryption', label: 'Encryption', hint: 'Choose a mode' },
		{ id: 'admin', label: 'Administrator', hint: 'First account' },
		{ id: 'review', label: 'Review', hint: 'Check and finish' }
	];

	let newPassphrase = $state('');
	let newConfirmation = $state('');
	let step = $state('encryption');
	let mode = $state('e2e');
	let view = $state('list');
	let tab = $state('details');
	let panelTab = $state('versions');
	let name = $state('nas-01');
	let password = $state('Tr1cky-passphrase');
	let search = $state('');
	let agree = $state(true);
	let notify = $state(true);
	let quiet = $state(false);
	let quota = $state('500');
	let dialogOpen = $state(false);
	let selectedFile = $state('q4');
	let starred = $state<Record<string, boolean>>({ q4: true });
	let picked = $state('none');

	const score = $derived(
		[
			password.length >= 8,
			password.length >= 12,
			/[A-Z]/.test(password) && /[a-z]/.test(password),
			/\d/.test(password) && /\W/.test(password)
		].filter(Boolean).length
	);

	const files = [
		{
			id: 'q4',
			name: 'Q4 Budget',
			kind: 'sheet',
			modified: '12 min ago',
			size: '84 KB',
			tags: [
				{ name: 'Finance', tone: 'green' },
				{ name: 'Q4', tone: 'blue' }
			],
			people: ['Maya', 'Noor']
		},
		{
			id: 'road',
			name: 'Roadmap 2027',
			kind: 'doc',
			modified: 'Yesterday',
			size: '212 KB',
			tags: [{ name: 'Q4', tone: 'blue' }],
			people: []
		},
		{
			id: 'fam',
			name: 'Family',
			kind: 'folder',
			modified: 'Mon',
			size: '3.2 GB',
			tags: [{ name: 'Family', tone: 'rose' }],
			people: ['Leo']
		},
		{
			id: 'inv',
			name: 'Invoice 0042.pdf',
			kind: 'pdf',
			modified: 'Oct 28',
			size: '1.1 MB',
			tags: [
				{ name: 'Travel', tone: 'orange' },
				{ name: 'Archive', tone: 'grey' }
			],
			people: []
		},
		{
			id: 'img',
			name: 'Lake.jpg',
			kind: 'image',
			modified: 'Oct 20',
			size: '4.8 MB',
			tags: [],
			people: []
		},
		{
			id: 'vid',
			name: 'Demo.mp4',
			kind: 'video',
			modified: 'Oct 02',
			size: '212 MB',
			tags: [],
			people: []
		},
		{
			id: 'note',
			name: 'Sync ideas',
			kind: 'note',
			modified: 'Sep 14',
			size: '3 KB',
			tags: [],
			people: []
		}
	] as const;

	const exportItems = [
		{ id: 'docx', lead: '.docx', label: 'Word document', note: 'Original' },
		{ id: 'odt', lead: '.odt', label: 'OpenDocument' },
		{ id: 'md', lead: '.md', label: 'Markdown' },
		{ id: 'print', lead: 'PDF', label: 'Print or save as PDF', disabled: true }
	];

	const snippet =
		'client_id = "yondrive"\nredirect_uri = "https://drive.example.com/api/v1/oidc/callback"';
	const iconNames = Object.keys(ICONS) as IconName[];
</script>

<div class="gallery">
	<section>
		<h2>Buttons</h2>
		<div class="row">
			<Button variant="primary">Continue</Button>
			<Button variant="primary" trailingIcon="arrow-right">Next</Button>
			<Button variant="primary" disabled>Disabled</Button>
			<Button variant="primary" busy>Working</Button>
			<Button variant="secondary" icon="upload">Upload</Button>
			<Button variant="secondary" size="sm" icon="filter">Filter</Button>
			<Button variant="ghost">Back</Button>
			<Button variant="icon" icon="bell" label="Notifications" />
			<Button variant="icon" size="sm" icon="more" label="More" />
			<Button variant="secondary" href="#top">As a link</Button>
		</div>
	</section>

	<section>
		<h2>Fields</h2>
		<div class="grid">
			<Field label="Server name" hint="Shown in the app and in share links.">
				{#snippet children(f)}<TextInput {...f} bind:value={name} />{/snippet}
			</Field>
			<Field label="Public URL" error="Enter a full address, such as https://drive.example.com.">
				{#snippet children(f)}<TextInput {...f} mono value="drive.example" />{/snippet}
			</Field>
			<Field label="Data directory" hint="Set through the environment.">
				{#snippet children(f)}<TextInput {...f} mono readonly value="/var/lib/yondrive" />{/snippet}
			</Field>
			<Field label="Default storage per user" required>
				{#snippet children(f)}
					<Select
						{...f}
						bind:value={quota}
						options={[
							{ value: '100', label: '100 GB' },
							{ value: '500', label: '500 GB' },
							{ value: '1000', label: '1 TB' },
							{ value: '0', label: 'Unlimited' }
						]}
					/>
				{/snippet}
			</Field>
			<Field label="Passphrase" hint="At least 12 characters.">
				{#snippet children(f)}
					<PasswordField {...f} bind:value={password} autocomplete="new-password">
						{#snippet meter()}<StrengthMeter {score} />{/snippet}
					</PasswordField>
				{/snippet}
			</Field>
			<SearchField
				bind:value={search}
				label="Search files"
				placeholder="Search files, tags, people…"
				shortcut="⌘K"
			/>
		</div>
		<div class="stack">
			<Checkbox bind:checked={agree}
				>I have stored the recovery key somewhere safe, away from this server.</Checkbox
			>
			<Checkbox checked={false} disabled>Disabled option</Checkbox>
			<div class="switch-row">
				<span
					><strong>Allow sign-up</strong><small>Let people create their own account.</small></span
				>
				<Switch bind:checked={notify} label="Allow sign-up" />
			</div>
			<div class="switch-row">
				<span><strong>Require TOTP</strong><small>Off.</small></span>
				<Switch bind:checked={quiet} label="Require TOTP" />
			</div>
			<div class="switch-row">
				<span><strong>Locked</strong><small>Disabled.</small></span>
				<Switch checked label="Locked" disabled />
			</div>
		</div>
	</section>

	<section>
		<h2>Choices</h2>
		<RadioGroup label="Encryption mode" bind:value={mode}>
			<RadioCard
				value="e2e"
				title="End-to-end, on the client"
				icon="shield-check"
				badge="Recommended"
			>
				Everything is encrypted on each user's device with their own keys.
			</RadioCard>
			<RadioCard value="off" title="No encryption" icon="lock-open">
				Files are stored as they are. Search and previews run in the browser.
			</RadioCard>
		</RadioGroup>
		<div class="row">
			<SegmentedControl
				label="View"
				bind:value={view}
				options={[
					{ value: 'list', label: 'List view', icon: 'list', iconOnly: true },
					{ value: 'grid', label: 'Grid view', icon: 'grid', iconOnly: true }
				]}
			/>
			<SegmentedControl
				label="Scope"
				value="mine"
				options={[
					{ value: 'mine', label: 'Mine' },
					{ value: 'shared', label: 'Shared' },
					{ value: 'all', label: 'Everyone' }
				]}
			/>
			<ThemeToggle />
		</div>
		<Stepper label="Setup steps" {steps} current={step} onselect={(id) => (step = id)} />
		<div class="row">
			<Button
				size="sm"
				variant="secondary"
				onclick={() => (step = steps[Math.max(0, steps.findIndex((s) => s.id === step) - 1)].id)}
				>Previous step</Button
			>
			<Button
				size="sm"
				variant="secondary"
				onclick={() =>
					(step = steps[Math.min(steps.length - 1, steps.findIndex((s) => s.id === step) + 1)].id)}
				>Next step</Button
			>
		</div>
	</section>

	<section>
		<h2>Notices and feedback</h2>
		<Banner tone="info" title="Opened from .docx">Changes are saved back in the same format.</Banner
		>
		<Banner tone="ok" title="Sent">Your 3 files were sent.</Banner>
		<Banner tone="warn" dismissible title="Someone else is editing"
			>Their changes may replace yours when you save.</Banner
		>
		<Banner tone="danger" dismissible
			>The connection is not secure. Anything you type can be read on the way.</Banner
		>
		<Banner tone="neutral" icon="shield"
			>Not encrypted. Anyone with access to the disks can read these files.</Banner
		>
		<ToastStack inline>
			<Toast tone="ok" ondismiss={() => {}}>Link copied</Toast>
			<Toast tone="info">Uploading 3 files…</Toast>
			<Toast tone="warn" ondismiss={() => {}}>
				Storage is almost full
				{#snippet action()}<Button variant="ghost" size="sm">Manage</Button>{/snippet}
			</Toast>
			<Toast tone="danger" ondismiss={() => {}}>Upload failed</Toast>
		</ToastStack>
		<ProgressBar label="Setup progress" value={60} height={4} />
		<ProgressBar label="Uploading" value={35} tone="ok" />
		<ProgressBar label="Preparing" />
		<ProgressBar
			label="Storage: photos 128 GB, videos 52 GB, documents 20 GB, other 12 GB"
			max={500}
			segments={[
				{ value: 128, color: 'var(--file-image)' },
				{ value: 52, color: 'var(--file-video)' },
				{ value: 20, color: 'var(--drive)' },
				{ value: 12, color: 'var(--star-off)' }
			]}
		/>
		<CodeBlock variant="key" label="recovery key" code="YOND-7Q2M-K9XF-3TPL-W8ND-6HCE-Z4RA-JV5U" />
		<CodeBlock label="snippet" code={snippet} />
	</section>

	<section>
		<h2>Overlays</h2>
		<div class="row">
			<Button variant="secondary" onclick={() => (dialogOpen = true)}>Open dialog</Button>
			<Menu
				label="Download as"
				heading="Download as"
				triggerLabel="Download"
				triggerIcon="download"
				items={exportItems}
				onselect={(id) => (picked = id)}
			/>
			<span class="note">Chosen: {picked}</span>
		</div>
		<Dialog
			bind:open={dialogOpen}
			title="Delete this folder?"
			description="It goes to the trash for 30 days."
		>
			<Field label="Type the folder name to confirm">
				{#snippet children(f)}<TextInput {...f} placeholder="Family" />{/snippet}
			</Field>
			{#snippet footer()}
				<Button variant="secondary" onclick={() => (dialogOpen = false)}>Cancel</Button>
				<Button variant="primary" onclick={() => (dialogOpen = false)}>Delete</Button>
			{/snippet}
		</Dialog>
		<Tabs
			label="Panel"
			bind:value={tab}
			tabs={[
				{ id: 'details', label: 'Details' },
				{ id: 'versions', label: 'Versions' }
			]}
		>
			{#snippet children(id)}<p class="pad">The {id} tab.</p>{/snippet}
		</Tabs>
		<div class="panel">
			<SidePanel label="Document details" width={320}>
				<Tabs
					label="Panel"
					bind:value={panelTab}
					tabs={[
						{ id: 'details', label: 'Details' },
						{ id: 'versions', label: 'Versions' }
					]}
				>
					{#snippet children(id)}<p class="pad">
							{id === 'details' ? 'Owner, size, dates.' : 'Earlier saves of this file.'}
						</p>{/snippet}
				</Tabs>
			</SidePanel>
		</div>
	</section>

	<section>
		<h2>Tags, avatars, cards, empty state</h2>
		<div class="row">
			<Tag>Neutral</Tag><Tag tone="green">Finance</Tag><Tag tone="blue">Q4</Tag><Tag tone="orange"
				>Travel</Tag
			><Tag tone="rose">Family</Tag><Tag tone="grey">Archive</Tag>
			<Tag tone="ok">Healthy</Tag><Tag tone="warn">Warning</Tag><Tag tone="danger">Failed</Tag>
		</div>
		<div class="row">
			<Avatar name="Angel" /><Avatar name="Maya" size={24} /><Avatar
				name="Noor"
				size={24}
				ring
			/><Avatar name="Leo" tone="yellow" /><Avatar name="Zed" tone="pink" size={44} />
		</div>
		<div class="grid">
			<Card
				><strong>Keys stay on devices</strong>
				<p class="small">Each key is created in the browser.</p></Card
			>
			<Card variant="sunken"
				><strong>Done on your device</strong>
				<p class="small">Search is built locally.</p></Card
			>
			<Card variant="dashed" padding="sm"
				><p class="small">Everything here can be changed later in Settings.</p></Card
			>
		</div>
		<Card padding="none">
			<EmptyState title="Nothing here yet" icon="trash">
				Deleted files stay here for 30 days.
				{#snippet action()}<Button variant="secondary">Go to My files</Button>{/snippet}
			</EmptyState>
		</Card>
	</section>

	<section>
		<h2>Account</h2>
		<div class="grid">
			<PassphraseFields bind:passphrase={newPassphrase} bind:confirmation={newConfirmation} />
		</div>
		<RecoveryKeyPanel
			pending={{
				key: new Uint8Array(0),
				words: Array.from({ length: 24 }, (_, i) => `word${i + 1}`),
				asked: [2, 9, 17]
			}}
			username="angel"
			server="nas-01"
		/>
	</section>

	<section>
		<h2>Files</h2>
		<FileList label="My files">
			{#each files as f (f.id)}
				<FileRow
					name={f.name}
					kind={f.kind}
					modified={f.modified}
					size={f.size}
					tags={f.tags}
					people={f.people}
					selected={selectedFile === f.id}
					starred={starred[f.id] ?? false}
					onselect={() => (selectedFile = f.id)}
					onstar={(v) => (starred[f.id] = v)}
				/>
			{/each}
		</FileList>
		<div class="tiles">
			{#each files.slice(0, 4) as f (f.id)}
				<FileTile
					name={f.name}
					kind={f.kind}
					modified={f.modified}
					size={f.size}
					selected={selectedFile === f.id}
					starred={starred[f.id] ?? false}
					onselect={() => (selectedFile = f.id)}
					onstar={(v) => (starred[f.id] = v)}
				/>
			{/each}
		</div>
	</section>

	<section>
		<h2>Shell</h2>
		<div class="shell">
			<AppRail current="drive" />
			<Sidebar title="Drive" badge="nas-01">
				<button class="new" type="button"><Icon name="plus" size={18} strokeWidth={2} /> New</button
				>
				<nav aria-label="Main" class="nav">
					<NavItem icon="home" label="Home" />
					<NavItem icon="folder" label="My files" current />
					<NavItem icon="shared" label="Shared with me" badge={3} />
					<NavItem icon="star" label="Favorites" count={4} />
					<NavItem icon="trash" label="Trash" />
				</nav>
				<NavSection title="Tags">
					{#snippet action()}<Button
							variant="icon"
							size="sm"
							icon="plus"
							label="New tag"
						/>{/snippet}
					<NavItem dot="var(--dot-green)" label="Finance" count={23} />
					<NavItem dot="var(--dot-blue)" label="Q4" count={9} />
					<NavItem dot="var(--dot-rose)" label="Family" count={312} />
				</NavSection>
				{#snippet footer()}
					<Card padding="sm">
						<div class="space"><strong>Your space</strong><small>212 of 500 GB</small></div>
						<ProgressBar label="Storage used" value={212} max={500} />
					</Card>
				{/snippet}
			</Sidebar>
			<div class="content">
				<TopBar>
					{#snippet leading()}<SearchField
							label="Search the shell"
							placeholder="Search files…"
							shortcut="⌘K"
						/>{/snippet}
					<Button variant="secondary" icon="upload">Upload</Button>
					<Button variant="icon" icon="bell" label="Notifications" />
					<Avatar name="Angel" />
				</TopBar>
			</div>
		</div>
		<div class="shell">
			<AppRail current="notes" />
			<span class="note pad">The Notes entry current.</span>
		</div>
	</section>

	<section>
		<h2>Icons</h2>
		<ul class="icons">
			{#each iconNames as n (n)}
				<li><Icon name={n} size={22} /><span>{n}</span></li>
			{/each}
		</ul>
	</section>
</div>

<style>
	.gallery {
		display: flex;
		flex-direction: column;
		gap: 36px;
	}

	section {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	h2 {
		margin: 0;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 18px 20px;
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.switch-row {
		display: flex;
		align-items: center;
		gap: 14px;
		min-height: 56px;
		border-bottom: 1px solid var(--divider);
	}

	.switch-row span {
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	small,
	.small,
	.note {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.small {
		margin: 4px 0 0;
	}

	.pad {
		padding: 16px 20px;
		margin: 0;
	}

	.panel {
		display: flex;
		border: 1px solid var(--border);
		border-radius: 12px;
		overflow: hidden;
		min-height: 140px;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
		gap: 14px;
	}

	.shell {
		display: flex;
		min-height: 120px;
		border: 1px solid var(--border);
		border-radius: 12px;
		overflow: hidden;
	}

	.content {
		flex: 1;
		min-width: 0;
	}

	.nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.new {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 0 14px;
		border: 0;
		border-radius: 12px;
		background: var(--primary);
		color: var(--on-primary);
		font-weight: 500;
		cursor: pointer;
	}

	.space {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 10px;
	}

	.icons {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.icons li {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--text-soft);
	}
</style>
