import type { Theme } from "@earendil-works/pi-coding-agent"

/** Where pi keeps its live Theme instance: on globalThis, so every module
 * loader sees the same one. Every theme switch swaps it, including in-memory
 * previews that never write settings. The package entry does not re-export it. */
const PI_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme")

/** The live pi theme, or undefined before pi initialises one.
 *
 * Only for code that cannot be handed a theme: prototype patches of upstream
 * components (which pi constructs itself) and render caches that compare the
 * instance by reference. Everything else takes the theme as a parameter (see
 * AGENTS.md, "Theme is always passed in"). */
export function liveTheme(): Theme | undefined {
	const theme = (globalThis as Record<symbol, unknown>)[PI_THEME_KEY]
	return isTheme(theme) ? theme : undefined
}

function isTheme(value: unknown): value is Theme {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "fg") === "function"
}
