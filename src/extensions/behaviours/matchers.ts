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

import { type ToolMatcher, tool } from "./triggers.js"

/** A condition over a single string field. RegExp form is the common case. */
export type StringCondition = RegExp | ((value: string) => boolean)

/** Match a `bash` tool call whose `command` matches `condition`. */
export function bashCommand(condition: StringCondition): ToolMatcher {
	return tool("bash", (input) => testString(condition, input.command))
}

/** Match a `web_fetch` tool call whose `url` matches `condition`. */
export function webFetchUrl(condition: StringCondition): ToolMatcher {
	return tool("web_fetch", (input) => testString(condition, input.url))
}

/** Match a `web_search` tool call whose `query` matches `condition`. */
export function webSearchQuery(condition: StringCondition): ToolMatcher {
	return tool("web_search", (input) => testString(condition, input.query))
}

function testString(condition: StringCondition, value: string): boolean {
	return condition instanceof RegExp ? condition.test(value) : condition(value)
}
