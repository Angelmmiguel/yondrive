/** Numbers and dates as the screens show them. */
const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} bytes`;
	const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), UNITS.length - 1);
	const value = bytes / 1000 ** unit;
	return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))} ${UNITS[unit]}`;
}

export function formatQuota(bytes: number): string {
	return bytes === 0 ? 'Unlimited' : formatBytes(bytes);
}

export const GB = 1_000_000_000;

/** The sizes offered wherever a quota is chosen, as values for a `Select`. */
export const QUOTA_OPTIONS = [
	{ value: String(100 * GB), label: '100 GB' },
	{ value: String(250 * GB), label: '250 GB' },
	{ value: String(500 * GB), label: '500 GB' },
	{ value: String(1000 * GB), label: '1 TB' },
	{ value: '0', label: 'Unlimited' }
];

export function formatDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}
