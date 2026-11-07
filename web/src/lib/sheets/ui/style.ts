/**
 * A cell's style from the file as inline CSS. Values from a file are data: only
 * colours of the form `#rrggbb`, font names of letters, digits, spaces and
 * hyphens, and sizes in range ever reach the page. Black text and white fills,
 * which most files carry, follow the theme so they stay readable in the dark.
 */
import type { CellStyle, Edge } from '$lib/formats/workbook';
import type { Scalar } from '$lib/formula/values';

const HEX = /^#[0-9a-f]{6}$/i;
const FONT = /^[\p{L}\p{N} -]{1,64}$/u;

export const safeColor = (c: string | undefined) => (c && HEX.test(c) ? c.toLowerCase() : null);

/** Relative luminance, 0 to 1. */
export function luminance(hex: string): number {
	const n = parseInt(hex.slice(1), 16);
	const ch = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

const EDGE: Record<string, string> = {
	thin: '1px solid',
	medium: '2px solid',
	thick: '3px solid',
	dashed: '1px dashed',
	mediumDashed: '2px dashed',
	dotted: '1px dotted',
	hair: '1px dotted',
	double: '3px double',
	dashDot: '1px dashed',
	mediumDashDot: '2px dashed',
	dashDotDot: '1px dashed',
	mediumDashDotDot: '2px dashed',
	slantDashDot: '2px dashed'
};

function edge(e: Edge | undefined): string | null {
	if (!e) return null;
	const kind = EDGE[e.style] ?? '1px solid';
	return `${kind} ${safeColor(e.color) ?? 'var(--text-strong)'}`;
}

/** Where a value sits when the style leaves it to the value: numbers right, text left, the rest centred. */
export function defaultAlign(v: Scalar | undefined): 'left' | 'right' | 'center' {
	if (typeof v === 'number') return 'right';
	if (v === null || v === undefined || typeof v === 'string') return 'left';
	return 'center';
}

export interface CellLook {
	/** For the cell box: fill and text. */
	css: string;
	/** For the borders, drawn over the grid lines; empty for none. */
	border: string;
	align: 'left' | 'right' | 'center';
	wrap: boolean;
}

const looks = new WeakMap<CellStyle, Map<string, CellLook>>();

export function cellLook(style: CellStyle | undefined, value: Scalar | undefined): CellLook {
	const h = style?.align.h;
	const align =
		h === 'center' || h === 'centerContinuous' || h === 'distributed'
			? 'center'
			: h === 'right'
				? 'right'
				: h === 'left' || h === 'justify' || h === 'fill'
					? 'left'
					: defaultAlign(value);
	if (!style) return { css: '', border: '', align, wrap: false };
	const cached = looks.get(style)?.get(align);
	if (cached) return cached;
	const parts: string[] = [];
	const f = style.font;
	const given = safeColor(style.fill);
	const fill = given && luminance(given) < 0.97 ? given : null;
	let color = safeColor(f.color);
	if (fill) {
		parts.push(`background:${fill}`);
		if (!color) color = luminance(fill) > 0.4 ? '#000000' : '#ffffff';
	} else if (color && luminance(color) < 0.02) color = null;
	if (color) parts.push(`color:${color}`);
	if (f.name && FONT.test(f.name)) parts.push(`font-family:"${f.name}",var(--font-sans)`);
	if (f.size && f.size >= 1 && f.size <= 409)
		parts.push(`font-size:calc(${Math.round((f.size * 4) / 3)}px * var(--z))`);
	if (f.bold) parts.push('font-weight:700');
	if (f.italic) parts.push('font-style:italic');
	const deco = [f.underline ? 'underline' : '', f.strike ? 'line-through' : '']
		.filter(Boolean)
		.join(' ');
	if (deco) parts.push(`text-decoration:${deco}`);
	const v = style.align.v;
	parts.push(`align-items:${v === 'top' ? 'flex-start' : v === 'center' ? 'center' : 'flex-end'}`);
	if (style.align.indent && style.align.indent > 0)
		parts.push(`padding-left:calc(${Math.min(style.align.indent, 15) * 9 + 4}px * var(--z))`);
	const b = style.border;
	const borders = (['top', 'right', 'bottom', 'left'] as const)
		.map((k) => {
			const e = edge(b[k]);
			return e ? `border-${k}:${e}` : '';
		})
		.filter(Boolean)
		.join(';');
	const look: CellLook = { css: parts.join(';'), border: borders, align, wrap: !!style.align.wrap };
	const byAlign = looks.get(style) ?? new Map<string, CellLook>();
	byAlign.set(align, look);
	looks.set(style, byAlign);
	return look;
}
