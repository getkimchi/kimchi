/**
 * Headless-browser enhancer: styled HTML → PDF via Chrome / Chromium /
 * Edge. Detection lives here, not in the model — the skill CLI reports
 * `tool-missing` with the install hint and the caller falls back to core
 * `create`. The browser runs with a throwaway profile, a host-resolver
 * rule that maps every hostname to nothing (no network), and a timeout.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, win32 } from "node:path"
import { pathToFileURL } from "node:url"
import { DocumentError } from "./model.js"
import { defaultWhich } from "./soffice.js"

const BROWSER_TIMEOUT_MS = 60_000

export interface BrowserDeps {
	which: (cmd: string) => string | undefined
	fileExists: (path: string) => boolean
	run: (cmd: string, args: string[]) => { code: number; stderr: string; signal?: NodeJS.Signals }
	env?: Record<string, string | undefined>
	platform?: NodeJS.Platform
	home?: string
	mkdtemp?: (prefix: string) => string
	rmdir?: (dir: string) => void
}

export interface Browser {
	/** Executable path to invoke. */
	cmd: string
	/** Route label for the result line (rule: label the route). */
	label: string
}

/** PATH names, tried first via `which`/`where` on every OS. */
const PATH_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]

function appCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string[] {
	if (platform === "darwin") {
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		]
	}
	if (platform === "win32") {
		const roots = [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"]
		// Edge ships with Windows 10+ — the guaranteed fallback — so every Edge
		// location is tried before any Chrome location.
		const byBrowser = [
			(root: string) => win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
			(root: string) => win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
			(root: string) => win32.join(root, "Chromium", "Application", "chrome.exe"),
		]
		return byBrowser.flatMap((pick) => roots.map(pick))
	}
	return [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/microsoft-edge",
		"/snap/bin/chromium",
	]
}

export function findBrowser(deps: BrowserDeps): Browser {
	const env = deps.env ?? process.env
	const platform = deps.platform ?? process.platform
	const home = deps.home ?? homedir()
	const override = env.KIMCHI_BROWSER
	if (override) {
		if (deps.fileExists(override)) return { cmd: override, label: `KIMCHI_BROWSER (${override})` }
		throw new DocumentError(
			"tool-missing",
			`KIMCHI_BROWSER points at ${override}, which does not exist. Fix or unset it.`,
			"pdf",
		)
	}
	for (const name of PATH_NAMES) {
		const onPath = deps.which(name)
		if (onPath) return { cmd: onPath, label: name }
	}
	for (const candidate of appCandidates(platform, env, home)) {
		if (deps.fileExists(candidate)) {
			const label = candidate.toLowerCase().includes("edge")
				? "Microsoft Edge"
				: candidate.toLowerCase().includes("chromium")
					? "Chromium"
					: "Google Chrome"
			return { cmd: candidate, label }
		}
	}
	throw new DocumentError(
		"tool-missing",
		"html needs a Chromium-based browser: Google Chrome, Chromium, or Microsoft Edge (Edge ships with Windows). Install one, or set KIMCHI_BROWSER to the browser binary. create (plain styling) never needs it.",
		"pdf",
	)
}

/** First few lines of tool stderr — enough to diagnose, small enough to read. */
function excerpt(stderr: string): string {
	const lines = stderr
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.slice(0, 3)
	const text = lines.join("; ")
	return text.length > 300 ? `${text.slice(0, 297)}...` : text
}

/**
 * Print `inputHtml` (absolute path) to a PDF at `outPdf` (absolute path).
 * The browser never sees the user's profile: a throwaway user-data-dir is
 * created per run and removed afterwards, and every hostname is mapped to
 * a non-existent one so remote subresources cannot load.
 */
export function htmlToPdf(inputHtml: string, outPdf: string, io?: BrowserDeps): Browser {
	const deps: Required<BrowserDeps> = {
		which: io?.which ?? defaultWhich,
		fileExists: io?.fileExists ?? existsSync,
		run: io?.run ?? defaultRun,
		env: io?.env ?? process.env,
		platform: io?.platform ?? process.platform,
		home: io?.home ?? homedir(),
		mkdtemp: io?.mkdtemp ?? ((prefix) => mkdtempSync(prefix)),
		rmdir: io?.rmdir ?? ((dir) => rmSync(dir, { recursive: true, force: true })),
	}
	const browser = findBrowser(deps)
	const profileDir = deps.mkdtemp(join(tmpdir(), "pdf-html-profile-"))
	try {
		const result = deps.run(browser.cmd, [
			"--headless",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-extensions",
			// Map every hostname to a non-existent one: local file only, no network.
			"--host-resolver-rules=MAP * ~NOTFOUND",
			`--user-data-dir=${profileDir}`,
			"--print-to-pdf-no-header",
			`--print-to-pdf=${outPdf}`,
			pathToFileURL(inputHtml).href,
		])
		if (result.signal) {
			throw new DocumentError(
				"timeout",
				`the browser did not finish printing within ${BROWSER_TIMEOUT_MS / 1000}s. Retry once; if it stalls again, use create instead.`,
				"pdf",
			)
		}
		if (result.code !== 0) {
			throw new DocumentError(
				"corrupt",
				`the browser exited ${result.code}: ${excerpt(result.stderr) || "(no stderr)"}`,
				"pdf",
			)
		}
		if (!deps.fileExists(outPdf)) {
			throw new DocumentError("corrupt", `the browser reported success but produced no PDF at ${outPdf}`, "pdf")
		}
		return browser
	} finally {
		deps.rmdir(profileDir)
	}
}

function defaultRun(cmd: string, args: string[]): { code: number; stderr: string; signal?: NodeJS.Signals } {
	const result = spawnSync(cmd, args, { encoding: "utf-8", timeout: BROWSER_TIMEOUT_MS })
	return {
		code: result.status ?? 1,
		stderr: result.stderr ?? result.error?.message ?? "",
		signal: result.signal ?? undefined,
	}
}
