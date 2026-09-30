/**
 * # Plan Markdown Persistence
 *
 * The single implementation for writing plan artifacts to disk. Both
 * planning flows converge here:
 *
 * | Flow | Written when | Filename |
 * |---|---|---|
 * | adhoc plan mode | plan is produced (`submit_plan` tool call) | `<slug-of-plan-title>.md` |
 * | ferment scoping | `propose_ferment_scoping` builds the plan | `ferment-<slug>-<first12(fermentId)>.md` |
 *
 * Editable files live under `<cwd>/.kimchi/plans/` and are overwritten on
 * rework. Plans with a work ID also retain each content version under the
 * agent directory's `work/<workId>/plans/`, outside disposable worktrees.
 *
 * This module intentionally has no load/delete surface: consumers read plan
 * files directly when needed, and the harness never deletes plan files —
 * they are user artifacts.
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { writeFileAtomic } from "../../config/json.js"
import { isWorkId } from "../work-id.js"

/** Canonical directory (relative to the project cwd) for plan markdown files. */
export const PLAN_DIR = ".kimchi/plans"

/**
 * One-line description of the canonical plan location for prompt templates.
 * Reference this constant instead of duplicating the wording so prompts
 * cannot drift into telling the model to write plan files elsewhere (or to
 * write them at all — the harness saves plans itself).
 */
export const PLAN_LOCATION_NOTE =
	"Completed plans are saved automatically by the harness to `.kimchi/plans/<slug>.md` — one file per plan, updated in place when the plan changes. Do not write plan files yourself."

/**
 * Context-aware plan persistence note for prompt injection. When the harness
 * saves plans (plan permission mode, ferment scoping), use `persistence: "harness"`
 * to tell the model not to write plan files itself. When an agent must write
 * the plan file (e.g. delegated Plan agent in orchestration mode), use
 * `persistence: "agent"` with the optional `activePlanPath` so the model knows
 * the exact file to continue from after a resume or compaction.
 */
export function generatePlanPersistenceNote(opts: {
	persistence: "harness" | "agent"
	activePlanPath?: string
}): string {
	const location = opts.activePlanPath ?? "`.kimchi/plans/<slug>.md`"
	if (opts.persistence === "harness") {
		return `Completed plans are saved automatically by the harness to ${location} — one file per plan, updated in place when the plan changes. Do not write plan files yourself.`
	}
	return `Write the completed plan to ${location} — one file per plan, updated in place when the plan changes. The file path must be returned in the \`files\` array of your response.`
}

const DEFAULT_SLUG = "untitled-plan"
const MAX_SLUG_LENGTH = 48

/**
 * Convert a human-readable name (plan title, ferment name) into a kebab-case
 * filename slug. Lowercase, non-alphanumeric runs collapse to `-`, trimmed,
 * capped at 48 chars. Falls back to {@link DEFAULT_SLUG} when nothing
 * usable remains.
 */
export function slugifyPlanName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/-+$/, "")
	return slug || DEFAULT_SLUG
}

/**
 * Derive a plan title from the plan text: the first markdown H1 heading if
 * present, else the first content line of the `## Goal` section, else
 * "untitled-plan".
 */
export function derivePlanTitle(text: string): string {
	const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(text)
	if (heading?.[1]) return heading[1]
	const goal = /^##[ \t]+Goal[ \t]*\r?\n+[ \t]*(\S[^\n\r]*)$/m.exec(text)
	if (goal?.[1]) return goal[1].trim()
	return DEFAULT_SLUG
}

/**
 * Deterministic filename stem for a ferment's plan file: `ferment-` prefix,
 * kebab-case ferment name, and the first 12 chars of the ferment id. The
 * `ferment-` prefix keeps ferment plans visually separate from adhoc plans.
 * The 12-char id suffix avoids collisions between same-named ferments whose
 * UUIDv7 ids share a time-based prefix (the first 8 chars can collide for
 * ferments created close together).
 */
export function fermentPlanFileName(fermentName: string, fermentId: string): string {
	return `ferment-${slugifyPlanName(fermentName)}-${fermentId.slice(0, 12)}`
}

const WORK_ID_PREFIX = "<!-- kimchi-work-id: "
const WORK_ID_SUFFIX = " -->"

/** Only the first line is metadata; marker examples in the plan body are content. */
export function readPlanWorkId(text: string): string | undefined {
	const newline = text.indexOf("\n")
	let line = newline === -1 ? text : text.slice(0, newline)
	if (line.endsWith("\r")) line = line.slice(0, -1)
	if (!line.startsWith(WORK_ID_PREFIX) || !line.endsWith(WORK_ID_SUFFIX)) return undefined
	const workId = line.slice(WORK_ID_PREFIX.length, -WORK_ID_SUFFIX.length)
	return isWorkId(workId) ? workId : undefined
}

export interface SavePlanMarkdownOptions {
	/** Project working directory — plan files land under `<cwd>/.kimchi/plans/`. */
	readonly cwd: string
	/** Filename base; slugified via {@link slugifyPlanName} before use. */
	readonly name: string
	/** Markdown content to persist (written verbatim). */
	readonly planText: string
	/** Attribution identity of the planning work. */
	readonly workId?: string
}

/**
 * Write (or overwrite in place) a plan markdown file under
 * `<cwd>/.kimchi/plans/<slug(name)>.md` and retain its version when attributed.
 * Local save errors propagate; a failed retained copy warns without blocking review.
 */
export function savePlanMarkdown(opts: SavePlanMarkdownOptions): { path: string; snapshotPath?: string } {
	const plansDir = resolve(opts.cwd, PLAN_DIR)
	mkdirSync(plansDir, { recursive: true })
	const filePath = resolve(plansDir, `${slugifyPlanName(opts.name)}.md`)
	let content = opts.planText
	if (opts.workId !== undefined) {
		if (!isWorkId(opts.workId)) throw new Error("Invalid work UUID")
		const header = `${WORK_ID_PREFIX}${opts.workId}${WORK_ID_SUFFIX}`
		const previous = readPlanWorkId(opts.planText)
		content = previous
			? header + opts.planText.slice(WORK_ID_PREFIX.length + previous.length + WORK_ID_SUFFIX.length)
			: `${header}\n${opts.planText}`
	}
	writeFileSync(filePath, content, "utf-8")
	if (opts.workId) {
		try {
			const plans = join(getAgentDir(), "work", opts.workId, "plans")
			mkdirSync(plans, { recursive: true, mode: 0o700 })
			const hash = createHash("sha256").update(content).digest("hex")
			const snapshotPath = join(plans, `${slugifyPlanName(opts.name)}-${hash}.md`)
			writeFileAtomic(snapshotPath, content)
			return { path: filePath, snapshotPath }
		} catch (error) {
			console.warn("[work-attribution] Could not retain plan version:", error)
		}
	}
	return { path: filePath }
}
