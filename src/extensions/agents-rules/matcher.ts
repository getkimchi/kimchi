/**
 * Glob matching for agent rules.
 *
 * Rule glob patterns are resolved against the directory containing the
 * `.agents/` folder (`AgentRule.baseDir`) — a rule in an ancestor's
 * `.agents/rules/` with `globs: ["src/**"]` matches `src/**` under that
 * ancestor, exactly like the documented `.mdc` semantics.
 *
 * File paths observed from tool calls (`read`/`edit`/`write`) may be absolute
 * or cwd-relative; both are handled by resolving against the session cwd
 * before relativizing to the rule's base directory.
 */

import { relative, resolve } from "node:path"
import micromatch from "micromatch"
import type { AgentRule } from "./types.js"

/** Tool names whose calls expose a file path we match globs against. */
export const FILE_PATH_TOOLS = new Set(["read", "edit", "write"])

/** Extract the target file path from a read/edit/write tool call input.
 *  Returns undefined for other tools or inputs without a usable `path`. */
export function extractFilePath(toolName: string, input: unknown): string | undefined {
	if (!FILE_PATH_TOOLS.has(toolName)) return undefined
	if (typeof input !== "object" || input === null) return undefined
	const path = (input as Record<string, unknown>).path
	return typeof path === "string" && path.length > 0 ? path : undefined
}

/** Normalize path separators to forward slashes for glob matching. */
function toPosix(p: string): string {
	return p.split("\\").join("/")
}

/** True when the file path matches one of the rule's glob patterns.
 *
 *  - `filePath` may be absolute or relative (resolved against `cwd`)
 *  - relative patterns are matched against the path relative to `rule.baseDir`
 *  - absolute patterns (leading `/`) are matched against the absolute file path
 */
export function matchesRule(rule: AgentRule, filePath: string, cwd: string): boolean {
	if (rule.globs.length === 0) return false

	const absolute = resolve(cwd, filePath)
	const relativeToBase = toPosix(relative(rule.baseDir, absolute))

	const relativePatterns: string[] = []
	const absolutePatterns: string[] = []
	for (const pattern of rule.globs) {
		if (pattern.startsWith("/")) absolutePatterns.push(toPosix(pattern))
		else relativePatterns.push(toPosix(pattern))
	}

	if (relativePatterns.length > 0 && micromatch.isMatch(relativeToBase, relativePatterns)) return true
	if (absolutePatterns.length > 0 && micromatch.isMatch(toPosix(absolute), absolutePatterns)) return true
	return false
}
