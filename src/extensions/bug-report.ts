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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import open from "open"
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

/** Deep-redact every string of the bug report bundle (metadata, diagnostics, summary, transcript). */
async function scrubBundle(bundle: BugReportBundle): Promise<BugReportBundle> {
	const metadata = await redactObjectStrings(bundle.metadata)
	const diagnostics = await redactObjectStrings(bundle.diagnostics)
	const summary = bundle.summary === undefined ? undefined : await redactObjectStrings(bundle.summary)
	const sessionJsonl = bundle.sessionJsonl === undefined ? undefined : await redactObjectStrings(bundle.sessionJsonl)
	return { metadata, diagnostics, summary, sessionJsonl }
}

/** Upload files as a private gist; returns the gist URL. Only the already-scrubbed strings leave the machine. */
async function createReportGist(bundle: BugReportBundle): Promise<string | undefined> {
	const { execFileSync } = await import("node:child_process")
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
		if (bundle.sessionJsonl !== undefined) {
			const sessionPath = join(tmpDir, "session.jsonl")
			writeFileSync(sessionPath, bundle.sessionJsonl)
			files.push(sessionPath)
		}
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
	openUrl: open as (url: string) => Promise<unknown>,
}

/** File the report on the getkimchi issue tracker (browser, template- and version-prefilled). */
async function deliverToKimchi(bundle: BugReportBundle): Promise<KimchiBugReportDelivery> {
	const gistUrl = await deliveryDeps.createGist(bundle)
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
			: "Bug report opened in your browser (session export omitted — gist creation failed).",
	}
}

export default function bugReportDestinationExtension(_pi: ExtensionAPI): void {
	globalThis.__kimchiBugReportScrub = scrubBundle
	globalThis.__kimchiBugReportDeliver = deliverToKimchi
}

export const _internal = { scrubBundle, deliverToKimchi, createReportGist }
