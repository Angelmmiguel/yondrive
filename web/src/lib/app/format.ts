/** Numbers and dates as the screens show them. */
import type { DevicePlatform } from '$lib/api/types';

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

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** When something happened, as a person would say it. */
export function formatWhen(when: number, now: number = Date.now()): string {
	if (!Number.isFinite(when) || when <= 0) return '—';
	const ago = now - when;
	if (ago < MINUTE) return 'Just now';
	if (ago < 60 * MINUTE) return `${Math.floor(ago / MINUTE)} min ago`;
	const date = new Date(when);
	const today = new Date(now);
	const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	if (when >= startOfToday) {
		return `Today, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
	}
	if (when >= startOfToday - DAY) return 'Yesterday';
	const sameYear = date.getFullYear() === today.getFullYear();
	return date.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: sameYear ? undefined : 'numeric'
	});
}

/** A day to come, for when something will happen. */
export function formatDay(when: number): string {
	return new Date(when).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
}

export function greeting(hour: number): string {
	if (hour < 5) return 'Good evening';
	if (hour < 12) return 'Good morning';
	if (hour < 19) return 'Good afternoon';
	return 'Good evening';
}

export function formatDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

const PLATFORMS: Record<DevicePlatform, string> = {
	ios: 'iOS',
	android: 'Android',
	macos: 'macOS',
	windows: 'Windows',
	linux: 'Linux',
	web: 'Web',
	other: 'Other'
};

/** A device's platform as people write it; empty when the device did not say. */
export function formatPlatform(platform: DevicePlatform | undefined): string {
	return platform === undefined ? '' : (PLATFORMS[platform] ?? '');
}
