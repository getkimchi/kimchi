/**
 * Bug Report (kimchi destination)
 *
 * upstream pi ships a built-in `/bug` command (consent, transcript choice, optional
 * model-written summary, diagnostics bundle, upload/zip delivery). This
 * extension does NOT register a command — it co-opts upstream's `/bug` so
 * the report lands on the kimchi tracker with PII/secrets scrubbed, via two
 * hook seams introduced by the pi patch (`patches/` + `patches/CHANGELOG.md`):
 *
 *   (globalThis).__kimchiBugReportScrub(bundle)   — deep-redact every string
 *                                                    before upload or zip ever
 *                                                    leaves the session
 *   (globalThis).__kimchiBugReportDeliver(bundle) — file on the getkimchi issue
 *                                                    tracker; returns a status
 *                                                    message or a failure text
 *
 * Holding both on this extension keeps the pi patch tiny (two delegation
 * checks) and keeps the scrub/deliver logic in TypeScript next to the
 * redactor it reuses.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import open from "open"
import { getCliModeArg, hasPrintFlag } from "../cli-modes.js"
import { getVersion } from "../utils.js"
import { redactObjectStrings } from "./pii-redaction/redactor.js"

const GITHUB_ISSUES_BASE = "https://github.com/getkimchi/kimchi/issues/new"

/** Shape of the upstream bundle at the scrub/deliver seam (1.3.0). */
export interface BugReportBundle {
	metadata: Record<string, unknown>
	diagnostics: Record<string, unknown>
	summary?: string
	sessionJsonl?: string
}

export interface KimchiBugReportDelivery {
	/** Status message shown after a successful delivery. */
	message?: string
	/** Failure text; upstream offers the zip-export fallback when set. */
	failure?: string
}

declare global {
	// eslint-disable-next-line no-var
	var __kimchiBugReportScrub: ((bundle: BugReportBundle) => Promise<BugReportBundle>) | undefined
	// eslint-disable-next-line no-var
	var __kimchiBugReportDeliver: ((bundle: BugReportBundle) => Promise<KimchiBugReportDelivery>) | undefined
}

/**
 * Redact a JSONL transcript line by line. Parsing each line keeps the
 * key-name rules in `redactObjectStrings` effective (`password`, `token`,
 * `apiKey`… redact regardless of value shape); a whole-document redact
 * would only catch pattern-matched secrets. Non-JSON lines get the plain
 * text redaction.
 */
export async function redactJsonlText(raw: string): Promise<string> {
	const trailingNewline = raw.endsWith("\n")
	const lines = raw.split("\n")
	if (trailingNewline) lines.pop()
	const redacted = await Promise.all(
		lines.map(async (line) => {
			if (!line.trim()) return line
			try {
				return JSON.stringify(await redactObjectStrings(JSON.parse(line)))
			} catch {
				return redactObjectStrings(line)
			}
		}),
	)
	return redacted.join("\n") + (trailingNewline ? "\n" : "")
}

/** Deep-redact every string of the bug report bundle (metadata, diagnostics, summary, transcript). */
async function scrubBundle(bundle: BugReportBundle): Promise<BugReportBundle> {
	const metadata = await redactObjectStrings(bundle.metadata)
	const diagnostics = await redactObjectStrings(bundle.diagnostics)
	const summary = bundle.summary === undefined ? undefined : await redactObjectStrings(bundle.summary)
	const sessionJsonl = bundle.sessionJsonl === undefined ? undefined : await redactJsonlText(bundle.sessionJsonl)
	return { metadata, diagnostics, summary, sessionJsonl }
}

/** Run `gh gist create` for the given files; returns the gist URL or undefined on failure. */
async function runGhGist(files: string[]): Promise<string | undefined> {
	try {
		const { execFileSync } = await import("node:child_process")
		const result = execFileSync("gh", ["gist", "create", "--public=false", ...files], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 30_000,
		})
		const gistUrl = result
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1)
		if (!gistUrl?.startsWith("https://")) {
			throw new Error(`Unexpected gh gist output: ${result}`)
		}
		return gistUrl
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error("Bug report: failed to create session gist:", message)
		return undefined
	}
}

/**
 * Upload the report files as a private gist; returns the gist URL. Only
 * already-scrubbed strings leave the machine, and only when the user opted
 * to include the session transcript (`bundle.sessionJsonl !== undefined`)
 * — a metadata-only gist carries no debugging value.
 */
async function createReportGist(bundle: BugReportBundle): Promise<string | undefined> {
	if (bundle.sessionJsonl === undefined) return undefined
	const tmpDir = mkdtempSync(join(tmpdir(), "kimchi-bug-report-"))
	try {
		const metadataPath = join(tmpDir, "report.json")
		writeFileSync(
			metadataPath,
			`${JSON.stringify({ metadata: bundle.metadata, diagnostics: bundle.diagnostics }, null, 2)}\n`,
		)
		const files = [metadataPath]
		if (bundle.summary !== undefined) {
			const summaryPath = join(tmpDir, "summary.md")
			writeFileSync(summaryPath, bundle.summary)
			files.push(summaryPath)
		}
		const sessionPath = join(tmpDir, "session.jsonl")
		writeFileSync(sessionPath, bundle.sessionJsonl)
		files.push(sessionPath)
		return await deliveryDeps.runGh(files)
	} finally {
		// Never leave the redacted transcript lingering on disk.
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// Best-effort cleanup — don't mask the primary failure.
		}
	}
}

/** Injectable seam for tests. */
export const deliveryDeps = {
	createGist: createReportGist,
	runGh: runGhGist,
	openUrl: open as (url: string) => Promise<unknown>,
}

/** File the report on the getkimchi issue tracker (browser, template- and version-prefilled). */
async function deliverToKimchi(bundle: BugReportBundle): Promise<KimchiBugReportDelivery> {
	// A gist is only created when the user opted to include the transcript —
	// no transcript, no upload (a metadata-only gist has no debugging value).
	const gistUrl = bundle.sessionJsonl !== undefined ? await deliveryDeps.createGist(bundle) : undefined
	const metadata = bundle.metadata as { hint?: string; id?: string }
	const params = new URLSearchParams({
		template: "bug_report.yml",
		labels: "bug",
		version: getVersion(),
		...(metadata.hint ? { title: metadata.hint, description: metadata.hint } : {}),
	})
	if (gistUrl) {
		params.set("session-file", gistUrl)
	}
	if (metadata.id) {
		params.set("report-id", metadata.id)
	}
	const url = `${GITHUB_ISSUES_BASE}?${params.toString()}`
	try {
		await deliveryDeps.openUrl(url)
	} catch {
		return { failure: `Failed to open browser. Manually file the report at: ${url}` }
	}
	return {
		message: gistUrl
			? `Bug report opened in your browser with redacted session data (gist: ${gistUrl}).`
			: bundle.sessionJsonl !== undefined
				? "Bug report opened in your browser (session export omitted — gist creation failed)."
				: "Bug report opened in your browser (no session data uploaded).",
	}
}

/** Redact the current session file and upload it as a private gist; for the headless/ACP `bug` command. */
async function createSessionGist(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile()
	if (!sessionFile) return undefined
	const tmpDir = mkdtempSync(join(tmpdir(), "kimchi-gist-"))
	try {
		const redactedFile = join(tmpDir, "session-redacted.jsonl")
		writeFileSync(redactedFile, await redactJsonlText(readFileSync(sessionFile, "utf-8")), "utf-8")
		return await deliveryDeps.runGh([redactedFile])
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error("Failed to create gist:", message)
		return undefined
	} finally {
		// Never leave the redacted transcript lingering on disk.
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// Best-effort cleanup — don't mask the primary failure.
		}
	}
}

const BUG_COMMAND_CONFIG = {
	description: "Report a bug in kimchi — opens GitHub issue form",
	handler: async (args: string, ctx: ExtensionCommandContext) => {
		const trimmed = args.trim()
		const params = new URLSearchParams({
			template: "bug_report.yml",
			labels: "bug",
			version: getVersion(),
			...(trimmed ? { title: trimmed, description: trimmed } : {}),
		})

		// Gist upload only happens on explicit confirmation — never silently.
		if (ctx.hasUI) {
			const includeGist = await ctx.ui.confirm(
				"Include session export",
				"Would you like to include a redacted session export as a private GitHub gist in the bug report?",
			)
			if (includeGist) {
				const gistUrl = await createSessionGist(ctx)
				if (gistUrl) params.set("session-file", gistUrl)
			}
		}

		const url = `${GITHUB_ISSUES_BASE}?${params.toString()}`
		if (ctx.hasUI) {
			ctx.ui.notify("Opening GitHub issues page for bug report...", "info")
			try {
				await deliveryDeps.openUrl(url)
			} catch {
				ctx.ui.notify(`Failed to open browser. Manually open: ${url}`, "error")
			}
		} else {
			console.log(`Bug report: ${url}`)
			console.log("Open this URL in your browser to file a bug report.")
		}
	},
}

/**
 * Whether the extension /bug command registers. The interactive TUI has its
 * own built-in /bug (which the pi patch routes through the kimchi destination
 * hooks), and upstream warns on the name clash — "Extension command '/bug'
 * conflicts with built-in interactive command" — so only the non-interactive
 * surfaces (ACP, print, protocol modes) get the extension command; their
 * prompt dispatch reaches registered commands and has no built-in /bug.
 */
export function shouldRegisterBugCommand(argv: readonly string[]): boolean {
	return getCliModeArg(argv) !== undefined || hasPrintFlag(argv)
}

export default function bugReportDestinationExtension(pi: ExtensionAPI, argv: readonly string[] = process.argv): void {
	globalThis.__kimchiBugReportScrub = scrubBundle
	globalThis.__kimchiBugReportDeliver = deliverToKimchi
	if (shouldRegisterBugCommand(argv)) pi.registerCommand("bug", BUG_COMMAND_CONFIG)
}

export const _internal = { scrubBundle, deliverToKimchi, createReportGist }
