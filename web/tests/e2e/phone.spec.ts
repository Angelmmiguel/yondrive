/**
 * Every screen on a phone, at 390×844 and at 360×740: the page never scrolls
 * sideways, text stays readable, every control can be reached on screen (or in
 * a box that scrolls to it), and each is at least 44px to touch.
 */
import { expect, test, type Page } from '@playwright/test';
import { tour, tourEnrol } from '../tour';

/** What is wrong with the screen as it stands, in words. */
function problems(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const out: string[] = [];
		const width = window.innerWidth;
		const page = document.scrollingElement ?? document.documentElement;
		if (page.scrollWidth > width + 1) out.push(`the page is ${page.scrollWidth}px wide`);

		const shown = (el: Element) => {
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) return null;
			// Above the page, as the skip link waits until it has the focus.
			if (r.bottom <= 0) return null;
			const s = getComputedStyle(el);
			if (s.visibility === 'hidden' || s.opacity === '0') return null;
			// Behind a closed drawer or an open dialog, nothing is there to touch.
			if (el.closest('[inert], [aria-hidden="true"]')) return null;
			return r;
		};
		const named = (el: Element) =>
			`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`;
		/** A box between the element and the page that scrolls sideways to it. */
		const scrolls = (el: Element) => {
			for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
				const s = getComputedStyle(p);
				if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return true;
			}
			return false;
		};

		for (const el of document.querySelectorAll('body *')) {
			if (el.closest('svg, .ProseMirror, [role=grid]')) continue;
			const own = [...el.childNodes].some(
				(n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== ''
			);
			if (!own || !shown(el)) continue;
			const size = parseFloat(getComputedStyle(el).fontSize);
			if (size < 11) out.push(`${named(el)} is set in ${size}px`);
		}

		const controls =
			'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], [role=switch]';
		for (const el of document.querySelectorAll(controls)) {
			if (el.closest('[role=grid], .ProseMirror')) continue;
			const r = shown(el);
			if (r === null) continue;
			if ((r.right > width + 1 || r.left < -1) && !scrolls(el)) {
				out.push(`${named(el)} is off screen at ${Math.round(r.left)}px`);
			}
			// A checkbox or radio is aimed at through its label.
			const target =
				el.matches('input[type=checkbox], input[type=radio]') && el.closest('label')
					? (el.closest('label') as Element).getBoundingClientRect()
					: r;
			// A link inside running text is as tall as its line, as everywhere.
			const inline = el.matches('a') && getComputedStyle(el).display === 'inline';
			if (!inline && (target.width < 44 || target.height < 44)) {
				out.push(`${named(el)} is ${Math.round(target.width)}×${Math.round(target.height)}`);
			}
		}
		return [...new Set(out)];
	});
}

for (const [width, height] of [
	[390, 844],
	[360, 740]
]) {
	test(`every screen fits a phone ${width} wide`, async ({ browser }) => {
		test.setTimeout(600_000);
		const context = await browser.newContext({
			viewport: { width, height },
			hasTouch: true,
			isMobile: true,
			acceptDownloads: true
		});
		const page = await context.newPage();
		page.setDefaultTimeout(30_000);
		const found: string[] = [];
		const visit = async (p: Page, screen: string) => {
			const here = (await problems(p)).map((what) => `${screen}: ${what}`);
			// Each as it is found, so that a run cut short still says what it saw.
			if (here.length > 0) console.log(here.join('\n'));
			found.push(...here);
		};
		await tour(browser, page, visit);
		await tourEnrol(browser, page, visit);
		await context.close();
		expect(found).toEqual([]);
	});
}
