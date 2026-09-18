/**
 * Regression tests for patch hunks that inject `sessionId` into upstream's
 * selector methods.
 *
 * Why: the `sessionId` injection belongs to `showModelSelector`, which declares
 * `const sessionId = this.sessionManager.getSessionId()` in scope. During the
 * 0.84.1 -> 0.85.1 rebase a second copy of the hunk landed in
 * `showLoginProviderSelector`, which has no such binding — making `sessionId` a
 * free variable that throws `ReferenceError: sessionId is not defined` whenever
 * that selector renders.
 *
 * It typechecked and the whole unit suite passed: the login tests stub the
 * selector, and Kimchi's `/login` menu (`src/login-command-patch.ts`) does not
 * route through it. The reachable path is `/login <prefix>` where the prefix
 * matches two providers with different ids, which delegates to upstream.
 *
 * These tests read the installed dist, so they fail fast if a future rebase
 * relocates the hunk onto the wrong enclosing function again. The trailing
 * context (`}, initialSearchInput);`) is identical in both methods, so a
 * fuzzy-matched hunk lands silently.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const distFile = resolve(
	projectRoot,
	"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
)

/**
 * Source of upstream's interactive-mode dist module, as installed and patched.
 *
 * The package is ESM-only and its exports map covers neither `./package.json`
 * nor deep dist paths, so the file is read from node_modules directly.
 */
function readInteractiveModeSource(): string {
	return readFileSync(distFile, "utf-8")
}

/**
 * Extracts a method body by name from the dist source.
 *
 * The dist is formatted one statement per line with stable four-space method
 * indentation, so the method ends at the first line that is exactly `    }`.
 */
function extractMethod(source: string, signature: string): string {
	const lines = source.split("\n")
	const start = lines.findIndex((line) => line.includes(signature))
	if (start === -1) {
		throw new Error(`Upstream internals changed: could not find "${signature}" in interactive-mode.js`)
	}
	const end = lines.findIndex((line, index) => index > start && line === "    }")
	if (end === -1) {
		throw new Error(`Could not find the end of "${signature}" in interactive-mode.js`)
	}
	return lines.slice(start, end + 1).join("\n")
}

describe("sessionId injection is scoped to the method that declares it", () => {
	it("showModelSelector both declares and uses sessionId", () => {
		const body = extractMethod(readInteractiveModeSource(), "showModelSelector(initialSearchInput) {")

		// The patch adds this declaration; without it the use below is unbound.
		expect(body).toContain("const sessionId = this.sessionManager.getSessionId();")
		expect(body).toContain("undefined, sessionId);")
	})

	it("showLoginProviderSelector does not reference sessionId", () => {
		const body = extractMethod(readInteractiveModeSource(), "showLoginProviderSelector(authType, initialSearchInput) {")

		// This method takes (authType, initialSearchInput) and declares no
		// sessionId, so any reference here is a free variable that throws at
		// render time. OAuthSelectorComponent takes five parameters, so the
		// argument is inert even when the variable happens to be defined.
		expect(body).not.toContain("sessionId")
	})
})
