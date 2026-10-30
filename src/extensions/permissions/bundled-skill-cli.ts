/**
 * Deterministic gate for the hidden document-skill CLI route:
 * `kimchi doc-cli <pdf|docx|xlsx|pptx> <command> …`.
 *
 * The binary resolves and loads the staged CLI bundle itself (see
 * src/extensions/documents/doc-cli-main.ts), so the model never supplies a
 * script path — there is nothing path-shaped to spoof. In auto mode there is
 * nothing for the classifier to decide about this fixed command shape: the
 * matcher below accepts exactly that shape. Everything else — env prefixes,
 * redirects, compound tails, unknown skills, the legacy script-path forms —
 * falls through to the existing rule/classifier layers unchanged.
 */

import { realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { DOC_CLI_READ_ONLY_COMMANDS, DOC_CLI_SKILLS, type DocCliSkill } from "../documents/doc-cli-skills.js"
import { isHardBlockedBash, parseCommandSegments, splitLeadingEnv, stripTrailingOutputFilters } from "./taxonomy.js"

/**
 * True when `command` invokes the document-skill CLI route in the documented
 * shape. All of the following must hold:
 *
 *  1. The command survives `isHardBlockedBash` (fork bombs, sudo/rm/dd).
 *  2. No command substitution (`$(`/backticks) and no newline/CR — the real
 *     shell treats a newline as a command separator while the tokenizer folds
 *     it into one segment, so `… doc-cli pdf read x\nrm -rf ~` must not match.
 *  3. No leading env assignments at all: the harness's own process
 *     environment decides how the route loads its bundle, and an
 *     agent-supplied prefix must never reach it.
 *  4. Trailing whitelisted output-filter pipes (`2>&1 | tail -N`) normalize
 *     away (skipped when a quoted token contains whitespace — the rebuilt
 *     head would lose the quoting); any other multi-segment form (`&&`, `;`,
 *     `| sh`, …) fails.
 *  5. The single remaining segment carries no ops beyond digit fd-dups
 *     (`2>&1`) — a `>`/`>>`/`<`/heredoc redirect fails the check.
 *  6. The program token is bare `kimchi`, followed by `doc-cli`, a skill
 *     from the closed set, and a subcommand token.
 *
 * Tokenizer-divergence note (shell-quote vs the executing shell): the check
 * rests on shell-quote's word-splitting agreeing with bash. Where they
 * diverge, every observed direction fails closed or is benign: unicode
 * whitespace (e.g. U+00A0) splits into tokens here but the real shell
 * treats it as part of the program name → command not found; `$VAR`-glued
 * tokens erase to the plain token here and expand in the real shell only
 * when the variable is set — the harness spawns a fresh shell per bash
 * call, so the model cannot persist an env assignment across calls, and
 * an env prefix on the same command fails rule 3. The acceptance of the
 * bare name `kimchi` also trusts PATH resolution (the executing shell may
 * resolve a different `kimchi` first) — the residual is documented in
 * docs/doc-cli.md.
 */
export function isDocCliCommand(command: string): boolean {
	if (!command.trim()) return false
	if (isHardBlockedBash(command)) return false
	if (command.includes("$(") || command.includes("`")) return false
	// shell-quote folds \n/\r into token whitespace; the executing shell splits
	// on them, so a newline-separated second command must never match.
	if (/[\r\n]/.test(command)) return false

	const rawTokens = parseCommandSegments(command)[0]?.tokens ?? []
	// stripTrailingOutputFilters rebuilds the head from space-joined tokens; a
	// quoted token with embedded whitespace would lose its quoting and be
	// re-parsed as multiple tokens. Skip the tail-strip in that case: the pipe
	// then fails the single-segment gate below (fail-closed).
	const quotedWhitespace = rawTokens.some((t) => /\s/.test(t))

	// Output-filter tails normalize to the head (`… 2>&1 | tail -N`), matching
	// how remembered-rule matching tolerates the same LLM habit. Anything else
	// multi-segment stays opaque and fails below on the segment count.
	const head = quotedWhitespace ? command : (stripTrailingOutputFilters(command) ?? command)

	const { env, rest } = splitLeadingEnv(head)
	if (env.length > 0) return false

	const segments = parseCommandSegments(rest)
	if (segments.length !== 1) return false
	for (const op of segments[0].ops) {
		// Only fd-to-fd duplication (`2>&1`) is transparent; every other op
		// (`>`, `>>`, `>|`, `<`, `<<`, `(`, …) can write files or hide code.
		if (!(op.op === ">&" && op.target && /^[0-9]+$/.test(op.target))) return false
	}

	const tokens = segments[0].tokens
	if (tokens.length < 4) return false
	if (tokens[0] !== "kimchi") return false
	if (tokens[1] !== "doc-cli") return false
	if (!(DOC_CLI_SKILLS as readonly string[]).includes(tokens[2])) return false
	return true
}

/** True when the command is the documented doc-cli shape AND its
 *  subcommand is read-only for that skill — `pdf read/info/fields/dump-shapes`,
 *  `docx read/info`, `xlsx read/info`, `pptx read/inspect/check`. Used by the
 *  permission gate to accept without prompting in default mode; mutating
 *  subcommands (create/edit/render/…) still prompt there. Token extraction
 *  reads the original command's first segment: the output-filter tail the
 *  shape check strips is ops-only, so the head tokens are identical. */
export function isReadOnlyDocCliCommand(command: string): boolean {
	if (!isDocCliCommand(command)) return false
	const tokens = parseCommandSegments(command)[0]?.tokens ?? []
	const skill = tokens[2] as DocCliSkill
	const sub = tokens[3]
	return typeof sub === "string" && (DOC_CLI_READ_ONLY_COMMANDS[skill] ?? []).includes(sub)
}

/**
 * True when `path` (absolute or cwd-relative) is a write target that would
 * land inside the bundled skills root — used to deny write/edit calls that
 * could populate or overwrite the dir the doc-cli route loads its bundles
 * from.
 *
 * The target itself may not exist yet (a `write` creates it), so the check
 * realpaths the longest existing prefix instead: an overwrite realpaths to
 * the existing file strictly inside the root; a fresh creation walks up to
 * the root directory itself. Either way the deny fires (rel === "" means
 * the existing prefix IS the root — creation under it; otherwise the prefix
 * must be strictly inside). A prefix that realpaths OUTSIDE the root (e.g.
 * through a symlinked intermediate) is not under the root and falls
 * through to the classifier like any other write.
 */
export function isUnderBundledSkillsDir(
	path: string,
	bundledSkillsDir: string | null,
	cwd: string,
	realpath?: (path: string) => string | null,
): boolean {
	if (!path.trim() || !bundledSkillsDir) return false
	const real = realpath ?? safeRealpath
	const target = resolve(cwd, path)
	const root = real(bundledSkillsDir)
	if (!root) return false
	const existing = realpathOfExistingPrefix(target, real)
	if (!existing) return false
	const rel = relative(root, existing)
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function safeRealpath(path: string): string | null {
	try {
		return realpathSync(path)
	} catch {
		return null
	}
}

/**
 * Realpath the longest existing ancestor of `path`, checking the path itself
 * first. `null` only when even the filesystem root fails to resolve.
 */
function realpathOfExistingPrefix(path: string, realpath: (path: string) => string | null): string | null {
	let current = path
	while (true) {
		const resolved = realpath(current)
		if (resolved !== null) return resolved
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}
