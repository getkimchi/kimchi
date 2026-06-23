import micromatch from "micromatch"
import {
	FILE_TOOLS,
	bashSegmentForms,
	extractBashProgram,
	parseCommandSegments,
	rememberedScopeTokens,
} from "./taxonomy.js"
import type { Rule, RuleBehavior, RuleSource } from "./types.js"

// Rule syntax: `toolname` or `toolname(content)`. Tool names are case-
// insensitive on input and normalized to the lowercase internal name;
// MCP names containing `__` are preserved verbatim.
export function parseRule(raw: string, behavior: RuleBehavior, source: RuleSource): Rule | null {
	const trimmed = raw.trim()
	if (!trimmed) return null
	const match = trimmed.match(/^([A-Za-z0-9_]+)(?:\(([\s\S]*)\))?\s*$/)
	if (!match) return null
	const toolName = match[1].toLowerCase()
	const content = match[2]
	return { toolName, content, behavior, source }
}

export function parseRules(strings: string[], behavior: RuleBehavior, source: RuleSource): Rule[] {
	return strings.map((s) => parseRule(s, behavior, source)).filter((r): r is Rule => r !== null)
}

export function stringifyRule(rule: Rule): string {
	return rule.content === undefined ? rule.toolName : `${rule.toolName}(${rule.content})`
}

const BASH_TOOL = "bash"

export function matchRule(rule: Rule, toolName: string, input: Record<string, unknown>): boolean {
	const lowerToolName = toolName.toLowerCase()
	if (rule.toolName !== lowerToolName) {
		// Auto-rewrite: bare rules like "rm" or "mv" should match bash invocations
		// of that program (including through rtk wrapper). Users naturally write
		// deny: ["rm"] expecting it to block bash(rm ...) commands.
		if (rule.content === undefined && lowerToolName === BASH_TOOL) {
			const command = typeof input.command === "string" ? input.command : ""
			const { program } = extractBashProgram(command)
			if (rule.toolName === program) return true
		}
		return false
	}
	if (rule.content === undefined) return true

	if (toolName === BASH_TOOL) {
		const command = typeof input.command === "string" ? input.command : ""
		return matchBashRule(rule.content, command, rule.behavior)
	}

	if (FILE_TOOLS.has(toolName)) {
		const path = typeof input.path === "string" ? input.path : ""
		return matchPathRule(rule.content, path)
	}

	return rule.content === stableStringify(input)
}

// Bash content matching: `prefix:*` (legacy prefix), `*` wildcard (escape with
// `\*`), or exact. Trailing ` *` makes arguments optional so `git *` matches
// bare `git`. Anchored, case-sensitive.
//
// Matches a remembered rule against a command. The canonical form
// (rememberedScopeTokens: leading env assignments PRESERVED, rtk wrapper
// stripped, quotes/whitespace normalized, first segment only) lets a rule match
// the command that produced it — `suggestScope` derives scopes from the same
// normalization — while never authorizing a wider command than was approved.
//
// SECURITY: `canonicalMatchForm` returns null for a multi-segment command (a
// `| && || ;` tail runs too) or an empty canonical (bare rtk / env-only /
// backtick). Broad-scope rules (legacy `prefix:*` and any wildcard) must NOT
// fall back to a raw `startsWith`/regex match when the canonical form is null —
// otherwise `go test:*` (or `go *`) would match `go test | sh`, because the raw
// command starts with `go test `. So those rules require a non-null canonical
// up front. Only an exact literal rule may match the raw command directly: that
// is precise (the user allowed exactly that string), and an anchored regex can
// never match a longer piped/chained command unless the rule literally contains
// the tail. This single-segment gate is the right call for an ALLOW; DENY is
// broader and handled separately (see `matchBashDeny`).
export function matchBashRule(pattern: string, command: string, behavior: RuleBehavior = "allow"): boolean {
	const pat = pattern.trim()
	if (behavior === "deny") return matchBashDeny(pat, command)

	const raw = command.trim()
	const canonical = canonicalMatchForm(command)

	// Broad scope (legacy `prefix:*` or any wildcard) requires a non-null canonical
	// so a raw match can't bypass the single-segment gate (`go *` vs `go test | sh`).
	if (pat.includes("*")) return canonical !== null && (matchOne(pat, raw) || matchOne(pat, canonical))

	// Exact literal: a raw match is precise; the canonical fallback (quote/
	// whitespace/rtk/env normalization) stays gated to single-segment.
	if (matchOne(pat, raw)) return true
	return canonical !== null && matchOne(pat, canonical)
}

// Deny matching is broad on purpose: a denied program in ANY top-level segment
// must block. Candidates are the raw whole command (so literal config patterns
// with exact spacing/quotes still match) plus each segment's canonical form
// (rtk-unwrapped, env-stripped — see bashSegmentForms), which catches a denied
// program hidden behind a pipe (`echo x | curl evil`). Over-matching a deny is
// safe; under-matching is the hole we are closing. This is not a complete
// sandbox — it inherits parseCommandSegments' limits (command substitution and
// path-qualified program names are not normalized); isHardBlockedBash and the
// classifier are the other layers.
function matchBashDeny(pat: string, command: string): boolean {
	return [command.trim(), ...bashSegmentForms(command)].some((c) => matchOne(pat, c))
}

// Does a single command string match one rule pattern? `prefix:*` matches the
// prefix or anything under it; otherwise the wildcard/exact pattern is compiled
// to an anchored regex. Callers decide which command form(s) to test.
function matchOne(pat: string, cmd: string): boolean {
	const prefixMatch = pat.match(/^(.+):\*$/)
	if (prefixMatch) {
		const prefix = prefixMatch[1]
		return cmd === prefix || cmd.startsWith(`${prefix} `) || cmd.startsWith(`${prefix}\t`)
	}
	return regexFromWildcard(pat).test(cmd)
}

// Canonical command form for a match, or `null` when there is none — multi-segment
// (a `|`/`&&`/`||`/`;` tail runs but is invisible here), empty, bare rtk, env-only,
// or backtick. Env is preserved, so an env-injected variant of an approved command
// does not match. See `rememberedScopeTokens` for the normalization.
function canonicalMatchForm(command: string): string | null {
	if (parseCommandSegments(command).length !== 1) return null
	const tokens = rememberedScopeTokens(command)
	return tokens.length ? tokens.join(" ") : null
}

const REGEX_META = /[.+?^${}()|[\]\\'"]/g
const PATTERN_TOKEN = /\\\\|\\\*|\*|[^\\*]+|\\/g

// Compile a wildcard pattern to an anchored regex. `*` matches anything,
// `\*` / `\\` are literal `*` / `\`, other chars match literally. As a
// convenience, a lone trailing ` *` is optional so `cmd *` also matches `cmd`.
//
//   pattern        regex             matches
//   -------------  ----------------  ------------------------------
//   git status     ^git status$      git status
//   npm test *     ^npm test( .*)?$  npm test, npm test foo
//   foo * bar      ^foo .* bar$      foo anything bar
//   echo \*        ^echo \*$         echo * (literal)
//   a.b*           ^a\.b.*$          a.b, a.bxyz
function regexFromWildcard(pattern: string): RegExp {
	let stars = 0
	const body = Array.from(pattern.matchAll(PATTERN_TOKEN), (m) => {
		const t = m[0]
		if (t === "*") {
			stars++
			return ".*"
		}
		if (t === "\\*" || t === "\\\\") return t // already a valid regex escape
		return t.replace(REGEX_META, "\\$&")
	}).join("")

	const adjusted = stars === 1 && body.endsWith(" .*") ? `${body.slice(0, -3)}( .*)?` : body
	return new RegExp(`^${adjusted}$`, "s")
}

export function matchPathRule(pattern: string, path: string): boolean {
	if (!path) return false
	return micromatch.isMatch(path, pattern, { dot: true, nocase: false })
}

export type RuleMatch = { decision: "allow"; rule: Rule } | { decision: "deny"; rule: Rule } | { decision: "no-match" }

// Precedence (highest first): session > cli > local > project > user > builtin.
// Deny beats allow within a source; first match wins.
export function evaluateRules(rules: Rule[], toolName: string, input: Record<string, unknown>): RuleMatch {
	const bySource = groupBySource(rules)
	const order: RuleSource[] = ["session", "cli", "local", "project", "user", "builtin"]

	for (const source of order) {
		const group = bySource[source]
		if (!group) continue

		const deny = group.find((r) => r.behavior === "deny" && matchRule(r, toolName, input))
		if (deny) return { decision: "deny", rule: deny }

		const allow = group.find((r) => r.behavior === "allow" && matchRule(r, toolName, input))
		if (allow) return { decision: "allow", rule: allow }
	}
	return { decision: "no-match" }
}

function groupBySource(rules: Rule[]): Partial<Record<RuleSource, Rule[]>> {
	const out: Partial<Record<RuleSource, Rule[]>> = {}
	for (const rule of rules) {
		const key = rule.source
		let bucket = out[key]
		if (!bucket) {
			bucket = []
			out[key] = bucket
		}
		bucket.push(rule)
	}
	return out
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}
