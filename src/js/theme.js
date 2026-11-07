/**
 * theme.js - light / dark colour theme switch
 *
 * The theme is a `data-theme` attribute on <html> ("dark", or absent for the
 * default light look); viewer.css maps it to colour tokens. The choice is kept
 * in localStorage under the key below, and each page re-applies it from a
 * one-line inline <head> script before the first paint (index.html,
 * membrane-dynamics.html), so that script and this module must agree on the
 * key and the "dark" value. This module fills and wires the `.theme-toggle`
 * buttons.
 */

const STORAGE_KEY = 'theme';
const LIGHT = 'light';
const DARK = 'dark';

// Sun (shown in dark mode: switch to light) and crescent moon (shown in light
// mode: switch to dark); viewer.css picks one by the theme attribute
const TOGGLE_ICONS = `
	<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
	<svg class="icon-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
`;

/**
 * Theme currently applied to the document
 * @returns {'light'|'dark'}
 */
function getTheme() {
	return document.documentElement.dataset.theme === DARK ? DARK : LIGHT;
}

/**
 * Relabel every toggle button for the theme it would switch to
 * @param {'light'|'dark'} theme - Theme currently applied
 */
function labelToggles(theme) {
	const label = theme === LIGHT ? 'Switch to dark mode' : 'Switch to light mode';
	document.querySelectorAll('.theme-toggle').forEach((button) => {
		button.setAttribute('aria-label', label);
		button.title = label;
	});
}

/**
 * Apply a theme to the document, remember it and relabel the toggle buttons
 * @param {'light'|'dark'} theme
 */
function setTheme(theme) {
	const root = document.documentElement;
	// Some controls animate their own colours on hover; turn every transition off
	// for the frame in which the theme flips so all elements change together
	root.dataset.themeSwitching = '';
	if (theme === DARK) {
		root.dataset.theme = DARK;
	} else {
		delete root.dataset.theme;
	}
	void root.offsetWidth; // flush styles so the new colours apply without transitions
	requestAnimationFrame(() => { delete root.dataset.themeSwitching; });
	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch (error) {
		// Storage unavailable (private mode, blocked cookies): the choice just won't persist
	}
	labelToggles(theme);
}

/**
 * Fill every `.theme-toggle` button with the sun / moon icons and wire it to
 * flip the theme. The theme itself is already applied by the <head> script.
 */
export function initThemeToggle() {
	document.querySelectorAll('.theme-toggle').forEach((button) => {
		button.type = 'button';
		button.innerHTML = TOGGLE_ICONS;
		button.addEventListener('click', () => {
			setTheme(getTheme() === LIGHT ? DARK : LIGHT);
		});
	});
	labelToggles(getTheme());
}
