/**
 * Accessibility of every screen, in both themes: the WCAG 2.1 AA rules of
 * axe-core, of which a serious or critical finding fails, and what a person on
 * a keyboard meets: a skip link, a visible focus, dialogs that hold the focus
 * and give it back, menus that move with the arrows, Escape that closes, and
 * motion that stops when asked to.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openDrive, row } from '../drive';
import { startServer, type Server } from '../server';
import { tour, tourEnrol } from '../tour';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface Finding {
	screen: string;
	theme: string;
	rule: string;
	impact: string;
	targets: string[];
}

/** Runs axe on what is on screen now, in the light theme and then the dark one. */
async function audit(page: Page, screen: string): Promise<Finding[]> {
	const found: Finding[] = [];
	const before = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
	for (const theme of ['light', 'dark']) {
		await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
		// Colours settle before contrast is read: transitions are off under reduced motion.
		await page.waitForTimeout(50);
		const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
		for (const v of results.violations) {
			if (v.impact !== 'serious' && v.impact !== 'critical') continue;
			found.push({
				screen,
				theme,
				rule: v.id,
				impact: v.impact,
				targets: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')}: ${n.failureSummary}`)
			});
		}
	}
	await page.evaluate((t) => {
		if (t === null) delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = t;
	}, before);
	return found;
}

const report = (found: Finding[]) =>
	found.map((f) => `${f.screen} (${f.theme}) ${f.rule} [${f.impact}]\n  ${f.targets.join('\n  ')}`);

test('every screen passes the WCAG 2.1 AA rules in both themes', async ({ browser }) => {
	test.setTimeout(600_000);
	const page = await (await browser.newContext({ reducedMotion: 'reduce' })).newPage();
	page.setDefaultTimeout(30_000);
	const found: Finding[] = [];
	const seen: string[] = [];
	const visit = async (p: Page, screen: string) => {
		seen.push(screen);
		const here = await audit(p, screen);
		// Each as it is found, so that a run cut short still says what it saw.
		if (here.length > 0) console.log(report(here).join('\n'));
		found.push(...here);
	};
	await tour(browser, page, visit);
	await tourEnrol(browser, page, visit);
	await page.context().close();
	expect(seen.length).toBeGreaterThan(30);
	expect(report(found)).toEqual([]);
});

test.describe.serial('from the keyboard', () => {
	let server: Server;
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		test.setTimeout(120_000);
		server = await startServer({ mode: 'none' });
		page = await (await browser.newContext({ reducedMotion: 'reduce' })).newPage();
		await openDrive(page, server, 'none');
		await page.getByRole('button', { name: 'New', exact: true }).click();
		await page.getByRole('menuitem', { name: 'New folder' }).click();
		const dialog = page.getByRole('dialog', { name: 'New folder' });
		await dialog.getByLabel('Name').fill('Projects');
		await dialog.getByRole('button', { name: 'Create' }).click();
		await expect(row(page, 'Projects')).toBeVisible();
	});

	test.afterAll(async () => {
		await page.context().close();
		await server.stop();
	});

	/** Two frames on, so that a style the focus started has been drawn. */
	const settled = (p: Page) =>
		p.evaluate(
			() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
		);

	/** The outline or ring the focused element draws, in pixels; 0 for none. */
	const focusRing = (p: Page) =>
		p.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			if (!el || el === document.body) return -1;
			const s = getComputedStyle(el);
			const outline = s.outlineStyle === 'none' ? 0 : parseFloat(s.outlineWidth);
			const ring = /\d+px \d+px 0px \d+px|0px 0px 0px [1-9]/.test(s.boxShadow) ? 2 : 0;
			return Math.max(outline, ring);
		});

	test('the first Tab reaches a skip link that moves to the main content', async () => {
		await page.goto(server.url);
		await expect(page.getByTestId('storage')).toBeVisible();
		await page.keyboard.press('Tab');
		const skip = page.getByRole('link', { name: 'Skip to main content' });
		await expect(skip).toBeFocused();
		await expect(skip).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(page.locator('main')).toBeFocused();
		await page.keyboard.press('Tab');
		const inMain = await page.evaluate(
			() => document.querySelector('main')?.contains(document.activeElement) ?? false
		);
		expect(inMain).toBe(true);
	});

	test('every stop of the Tab order shows where the focus is, in order', async () => {
		await page.goto(server.url);
		await expect(page.getByTestId('storage')).toBeVisible();
		const stops: { name: string; ring: number; region: string }[] = [];
		for (let i = 0; i < 60; i++) {
			await page.keyboard.press('Tab');
			await settled(page);
			const ring = await focusRing(page);
			const where = await page.evaluate(() => {
				const el = document.activeElement as HTMLElement;
				const region = el.matches('a[href="#main"]')
					? 'skip'
					: el.closest('main')
						? 'main'
						: el.closest('header')
							? 'top'
							: el.closest('nav, aside')
								? 'nav'
								: 'other';
				const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? '';
				return { name: `${el.tagName.toLowerCase()} ${label}`, region };
			});
			// Round once: past the end the focus leaves the page and comes back to the top.
			if (where.region === 'skip' && stops.length > 0) break;
			stops.push({ ...where, ring });
		}
		const unseen = stops.filter((s) => s.ring === 0).map((s) => s.name);
		expect(unseen).toEqual([]);
		// The page reads as it is laid out: the skip link, the navigation, the top bar,
		// then the page itself, without going back.
		const order = ['skip', 'nav', 'top', 'main'];
		const regions = stops.map((s) => s.region).filter((r) => order.includes(r));
		const firsts = regions.filter((r, i) => regions.indexOf(r) === i);
		expect(firsts).toEqual(order);
		const back = regions.findIndex(
			(r, i) => i > 0 && order.indexOf(r) < order.indexOf(regions[i - 1])
		);
		expect(back, `went back to ${regions[back]} at stop ${back}`).toBe(-1);
	});

	test('a menu opens from the keyboard, moves with the arrows and closes on Escape', async () => {
		const button = page.getByRole('button', { name: 'Actions for Projects' });
		await button.focus();
		await page.keyboard.press('Enter');
		const items = page.getByRole('menuitem');
		await expect(items.first()).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(items.nth(1)).toBeFocused();
		await page.keyboard.press('ArrowUp');
		await expect(items.first()).toBeFocused();
		await page.keyboard.press('End');
		await expect(items.last()).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(items).toHaveCount(0);
		await expect(button).toBeFocused();
	});

	test('a dialog holds the focus, closes on Escape and gives it back', async () => {
		const button = page.getByRole('button', { name: 'Actions for Projects' });
		await button.focus();
		await page.keyboard.press('Enter');
		await page.getByRole('menuitem', { name: 'Rename' }).press('Enter');
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		for (let i = 0; i < 12; i++) {
			await page.keyboard.press('Tab');
			const inside = await dialog.evaluate((d) => d.contains(document.activeElement));
			expect(inside).toBe(true);
		}
		for (let i = 0; i < 12; i++) {
			await page.keyboard.press('Shift+Tab');
			const inside = await dialog.evaluate((d) => d.contains(document.activeElement));
			expect(inside).toBe(true);
		}
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(button).toBeFocused();
	});

	test('the search palette closes on Escape and gives the focus back', async () => {
		const button = page.getByRole('button', { name: 'Actions for Projects' });
		await button.focus();
		await page.keyboard.press('ControlOrMeta+k');
		await expect(page.getByRole('combobox', { name: 'Search for' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('search-palette')).toHaveCount(0);
		await expect(button).toBeFocused();
	});

	test('a new document is written and saved with the keyboard alone', async () => {
		await page.getByRole('button', { name: /New doc/ }).focus();
		await page.keyboard.press('Enter');
		const doc = page.getByRole('textbox', { name: 'Document' });
		await expect(doc).toBeVisible({ timeout: 30_000 });
		await expect(doc).toBeFocused();
		await page.keyboard.type('Typed without a mouse.');
		await page.keyboard.press('Control+b');
		await page.keyboard.type(' Bold.');
		await page.keyboard.press('Control+s');
		await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 30_000 });
		await expect(doc.locator('strong')).toHaveText(' Bold.');
		await page.goBack();
		await expect(page.getByTestId('storage')).toBeVisible();
	});

	test('a new sheet is filled and moved through with the keyboard alone', async () => {
		await page.getByRole('button', { name: /New sheet/ }).focus();
		await page.keyboard.press('Enter');
		const grid = page.getByRole('grid', { name: /: cells$/ });
		await expect(grid).toBeVisible({ timeout: 30_000 });
		await expect(grid).toBeFocused();
		await page.keyboard.type('2');
		await page.keyboard.press('Enter');
		await page.keyboard.type('3');
		await page.keyboard.press('Enter');
		await page.keyboard.type('=A1*A2');
		await page.keyboard.press('Enter');
		await page.keyboard.press('ArrowUp');
		await expect(page.getByLabel('Selected cell')).toHaveValue('A3');
		await expect(page.getByLabel('Cell contents')).toHaveValue('=A1*A2');
		const a3 = grid.locator('[role=row][aria-rowindex="3"] > [role=gridcell][aria-colindex="1"]');
		await expect(a3).toHaveText('6');
		await page.keyboard.press('ArrowRight');
		await expect(page.getByLabel('Selected cell')).toHaveValue('B3');
		await page.keyboard.press('Control+s');
		await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 30_000 });
		await page.goBack();
		await expect(page.getByTestId('storage')).toBeVisible();
	});

	test('the focus ring and the edges of fields stand out 3:1 in both themes', async () => {
		await page.goto(server.url);
		await expect(page.getByTestId('storage')).toBeVisible();
		for (const theme of ['light', 'dark']) {
			await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
			const low: string[] = [];
			for (let i = 0; i < 15; i++) {
				await page.keyboard.press('Tab');
				await settled(page);
				const found = await page.evaluate(() => {
					const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
					const lum = ([r, g, b]: number[]) => {
						const f = (v: number) => {
							const s = v / 255;
							return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
						};
						return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
					};
					const ratio = (a: number[], b: number[]) => {
						const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
						return (x + 0.05) / (y + 0.05);
					};
					const behind = (el: Element | null): number[] => {
						for (let p = el; p; p = p.parentElement) {
							const c = rgb(getComputedStyle(p).backgroundColor);
							if (c.length === 3 || c[3] === 1) return c.slice(0, 3);
						}
						return [255, 255, 255];
					};
					const el = document.activeElement as HTMLElement;
					const ring = /rgba?\([^)]*\)/.exec(getComputedStyle(el).boxShadow)?.[0];
					const out: string[] = [];
					const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20);
					if (ring) {
						const r = ratio(rgb(ring), behind(el.parentElement));
						if (r < 3) out.push(`focus on ${name} ${r.toFixed(2)}:1`);
					}
					for (const field of document.querySelectorAll('input[type=search], input[type=text]')) {
						const s = getComputedStyle(field);
						if (s.borderTopWidth === '0px' || field.getBoundingClientRect().width === 0) continue;
						const r = ratio(rgb(s.borderTopColor), behind(field.parentElement));
						if (r < 3) out.push(`edge of ${field.getAttribute('aria-label')} ${r.toFixed(2)}:1`);
					}
					return out;
				});
				low.push(...found);
			}
			expect([...new Set(low)], theme).toEqual([]);
		}
		await page.evaluate(() => delete document.documentElement.dataset.theme);
	});

	test('motion stops when the system asks for less of it', async () => {
		const moving = await page.evaluate(() => {
			const long: string[] = [];
			for (const el of document.querySelectorAll('*')) {
				const s = getComputedStyle(el);
				const t = Math.max(...s.transitionDuration.split(',').map((d) => parseFloat(d)));
				const a = Math.max(...s.animationDuration.split(',').map((d) => parseFloat(d)));
				const running = s.animationName !== 'none' && s.animationIterationCount === 'infinite';
				if (t > 0.01 || (a > 0.01 && !running)) long.push(el.tagName.toLowerCase());
			}
			return long;
		});
		expect(moving).toEqual([]);
	});
});
