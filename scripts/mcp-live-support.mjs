/**
 * Shared support for the live MCP OAuth check scripts
 * (mcp-live-probe.mjs, mcp-live-google-lifecycle.mjs): paths, the recording
 * browser driver, and the spawned probe's environment.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url))
export const BINARY = resolve(REPO_ROOT, "dist/bin/kimchi")

/**
 * Browser driver that records any authorize URL it is asked to open and
 * exits — no sign-in is ever completed. Returns the driver path and the
 * JSONL log the URLs land in.
 */
export function writeRecordingBrowserDriver(binDir) {
	mkdirSync(binDir, { recursive: true })
	const browserPath = join(binDir, "open")
	const urlLog = join(binDir, "authorize-urls.jsonl")
	writeFileSync(
		browserPath,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs"
const urlLog = ${JSON.stringify(urlLog)}
const target = process.argv.find((argument) => argument.startsWith("http://") || argument.startsWith("https://"))
if (target) appendFileSync(urlLog, JSON.stringify({ target }) + "\\n")
`,
		"utf-8",
	)
	chmodSync(browserPath, 0o755)
	return { browserPath, urlLog }
}

/**
 * Environment for a spawned `kimchi mcp probe`: isolated HOME, the recording
 * browser driver, and a file-backed OAuth credential store inside that HOME
 * (the store switches on its env var alone — see TEST_KEYRING_DIR_ENV in
 * keyring-require-bridge — so the OS keychain is never touched and the probe
 * never blocks on a keychain prompt).
 */
export function probeChildEnv({ homeDir, binDir }) {
	return {
		...process.env,
		HOME: homeDir,
		BROWSER: join(binDir, "open"),
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		DISPLAY: "",
		XDG_CURRENT_DESKTOP: "X-Generic",
		...(process.env.WAYLAND_DISPLAY !== undefined ? { WAYLAND_DISPLAY: "" } : {}),
		KIMCHI_NO_UPDATE_CHECK: "1",
		KIMCHI_MCP_E2E_KEYRING_DIR: join(homeDir, "mcp-keyring"),
	}
}

/** Structural redirect-URI class check: scheme and host must match the expected prefix, and the port too when the prefix pins one. */
export function redirectUriMatchesClass(redirectUri, redirectUriPrefix) {
	let actual
	let expected
	try {
		actual = new URL(redirectUri)
		expected = new URL(redirectUriPrefix)
	} catch {
		return false
	}
	return (
		actual.protocol === expected.protocol &&
		actual.hostname === expected.hostname &&
		(expected.port === "" || actual.port === expected.port) &&
		// A prefix that pins a callback path must match it exactly — hosted-callback
		// classes are distinguished by their path, not just their host.
		(expected.pathname === "/" || actual.pathname === expected.pathname)
	)
}

/** Count the authorize URLs the browser driver was asked to open. */
export function countBrowserOpens(urlLog) {
	try {
		return readFileSync(urlLog, "utf-8").split("\n").filter(Boolean).length
	} catch {
		return 0
	}
}
