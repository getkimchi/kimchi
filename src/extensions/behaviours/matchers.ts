/**
 * High-level matchers built on top of `tool(...)`.
 *
 * Behaviour authors should reach for these first; they encode the patterns
 * that come up repeatedly (bash command regex, web_fetch URL regex, "fetched
 * this host by any means"). Drop down to the raw `tool(...)` factory only
 * when no helper fits.
 *
 * Every helper accepts a `RegExp` or a `(field: string) => boolean` predicate
 * over the relevant string field of the tool input. Authors never type the
 * full input shape themselves.
 */

import { bashInvokesCommand } from "./bash-tokenize.js"
import { type ToolMatcher, all, any, tool } from "./triggers.js"

/** A condition over a single string field. RegExp form is the common case. */
export type StringCondition = RegExp | ((value: string) => boolean)

/** Match a `bash` tool call whose `command` matches `condition`. */
export function bashCommand(condition: StringCondition): ToolMatcher {
	return tool("bash", (input) => testString(condition, input.command))
}

/**
 * Match a `bash` tool call that invokes `executable` as a program in any
 * stage of the command (pipeline, sequence, subshell, command substitution).
 *
 * Uses a shell tokeniser, so substring matches inside string literals,
 * comments, and heredoc bodies do not trigger; env-var prefixes
 * (`FOO=bar gh ...`) and pipelines (`cmd | gh ...`) do.
 */
export function bashInvokes(executable: string): ToolMatcher {
	return bashCommand((command) => bashInvokesCommand(command, executable))
}

/** Match a `web_fetch` tool call whose `url` matches `condition`. */
export function webFetchUrl(condition: StringCondition): ToolMatcher {
	return tool("web_fetch", (input) => testString(condition, input.url))
}

/** Match a `web_search` tool call whose `query` matches `condition`. */
export function webSearchQuery(condition: StringCondition): ToolMatcher {
	return tool("web_search", (input) => testString(condition, input.query))
}

/**
 * Match any tool call that fetches a URL whose host matches `hostPattern` —
 * `web_fetch` directly, or `bash` invoking `curl`/`wget` against that host.
 *
 * Pass a domain string (`"github.com"`) for an exact host match, or a RegExp
 * for fuzzier matching (`/(api\.)?github\.com/`).
 *
 * The bash branch routes through the shell tokeniser (`bashInvokes`) rather
 * than a raw regex, so `# curl github.com` (comment) and `echo curl github.com`
 * (curl mentioned but not invoked) do not trigger.
 */
export function fetchesHost(hostPattern: string | RegExp): ToolMatcher {
	const hostRe = typeof hostPattern === "string" ? new RegExp(`\\b${escapeRegex(hostPattern)}\\b`) : hostPattern
	return any(all(any(bashInvokes("curl"), bashInvokes("wget")), bashCommand(hostRe)), webFetchUrl(hostRe))
}

function testString(condition: StringCondition, value: string): boolean {
	return condition instanceof RegExp ? condition.test(value) : condition(value)
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
