/**
 * Cursor rules extension for Kimchi.
 *
 * Discovers Cursor-style project rules (`.cursor/rules/*.mdc` and legacy
 * `.cursorrules`), tracks files the agent touches, and injects only the rules
 * that are active for the current turn:
 *   - `alwaysApply: true` rules are always injected.
 *   - Rules with `globs` are injected when a touched file matches.
 *   - Rules with only a `description` (or no frontmatter) are listed as
 *     available so the model can request them.
 */

import { basename, resolve } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { discoverCursorRules } from "./discovery.js"
import { getActiveRules } from "./matcher.js"
import type { ParsedCursorRule } from "./types.js"

const MAX_TOUCHED_FILES = 100
const FILE_TOOLS = new Set(["read", "write", "edit"])

export default function cursorRulesExtension(pi: ExtensionAPI): void {
	const touchedFiles = new Set<string>()
	let rules: ParsedCursorRule[] = []
	let cwd = ""

	// Register the system-prompt block first so its internal `session_start`
	// handler records the session ID before any test harness synchronously
	// fires the event.
	createSystemPromptBlocks(pi, "cursor-rules").register({
		id: "active-rules",
		render: () => renderActiveRules(rules, touchedFiles),
	})

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		rules = discoverCursorRules(ctx.cwd).rules
		cwd = ctx.cwd
		touchedFiles.clear()
	})

	pi.on("tool_call", async (event) => {
		if (!cwd) return
		const input = event.input as Record<string, unknown>
		const filePath = extractToolPath(event.toolName, input)
		if (filePath === undefined) return
		touchedFiles.add(resolve(cwd, filePath))
		if (touchedFiles.size > MAX_TOUCHED_FILES) {
			const first = touchedFiles.values().next().value
			if (first !== undefined) touchedFiles.delete(first)
		}
	})
}

function extractToolPath(toolName: string, input: Record<string, unknown>): string | undefined {
	if (!FILE_TOOLS.has(toolName)) return undefined
	const path = input.path
	return typeof path === "string" && path.length > 0 ? path : undefined
}

function renderActiveRules(rules: ParsedCursorRule[], touchedFiles: ReadonlySet<string>): string | undefined {
	if (rules.length === 0) return undefined

	const active = getActiveRules(rules, touchedFiles)
	const sections: string[] = []

	for (const rule of active.alwaysApply) {
		sections.push(formatInjectedRule(rule))
	}

	for (const rule of active.matched) {
		sections.push(formatInjectedRule(rule, rule.globs.join(", ")))
	}

	if (active.available.length > 0) {
		sections.push(formatAvailableRules(active.available))
	}

	if (sections.length === 0) return undefined
	return `## Cursor Rules\n\n${sections.join("\n\n")}`
}

function formatInjectedRule(rule: ParsedCursorRule, appliesTo?: string): string {
	const header = appliesTo
		? `<project_rule path="${rule.path}" applies_to="${appliesTo}">`
		: `<project_rule path="${rule.path}">`
	return `${header}\n${escapeRuleBody(rule.body)}\n</project_rule>`
}

function escapeRuleBody(body: string): string {
	// Prevent a rule body from prematurely closing the <project_rule> envelope.
	return body.replace(/<\/project_rule>/g, "&lt;/project_rule&gt;")
}

function formatAvailableRules(available: ParsedCursorRule[]): string {
	const lines = available.map((rule) => {
		const name = basename(rule.path)
		const desc = rule.description ?? "Manual rule — request it explicitly if relevant."
		return `- \`${name}\`: ${desc}`
	})
	return `The following Cursor rules are available for this project. Request one explicitly if it is relevant:\n\n${lines.join("\n")}`
}
