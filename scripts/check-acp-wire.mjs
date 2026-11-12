#!/usr/bin/env node
/**
 * check:acp-wire — tripwire for ACP wire-compat regressions (docs/acp-compat.md).
 *
 * Diff-scoped (`origin/main...HEAD` by default): scans lines ADDED by the
 * checked change in TypeScript sources and flags the known failure class —
 * agent-side work whose side effects leak onto the ACP wire in ways plain
 * clients never opted into.
 *
 * This is a heuristic tripwire, not a linter: a fail means "walk
 * docs/acp-compat.md rule 1–2 and either fix the diff or justify it in the
 * PR body", not that the patch provably breaks a client.
 *
 * Usage:
 *   node scripts/check-acp-wire.mjs [--base <ref>]   # run the checks (default base: origin/HEAD)
 *   node scripts/check-acp-wire.mjs --self-test      # run built-in fixtures
 */
import { strict as assert } from "node:assert"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

const SUPPORTED_FLAGS = ["--self-test", "--base"]

/**
 * Registered `_meta` keys / ext method names are collected dynamically:
 * exported constants whose name ends in META_KEY / NOTIFICATION_METHOD /
 * EXT_METHOD (value a string literal) anywhere under src/, plus these
 * historical inline keys. Keys NOT discovered this way get flagged only when
 * they appear as quoted _meta keys in an emission path — unquoted constant
 * references are always fine.
 */
const HARDCODED_REGISTERED_META = new Set(["piToolCallId"])

const detectMetaKeys = (srcFiles) => {
	const keys = new Set(HARDCODED_REGISTERED_META)
	const re = /export const \w+(?:META_KEY|NOTIFICATION_METHOD|EXT_METHOD)\w*\s*=\s*"([^"]+)"/g
	for (const content of srcFiles.values()) {
		for (const m of content.matchAll(re)) keys.add(m[1])
	}
	// `_kimchi.dev/...` method literals anywhere in src count as registered
	// (they exist on some send path already); brand-new ones are exactly what
	// check 5 wants to see justified.
	for (const content of srcFiles.values()) {
		for (const m of content.matchAll(/"(_kimchi\.dev\/[^"]+)"/g)) keys.add(m[1])
	}
	return keys
}

/**
 * Split a unified-diff hunk body into contiguous blocks of added lines.
 * Context and removed lines are dropped; each added block keeps 1-based
 * line numbers in the NEW file for reporting.
 */
export function addedBlocks(diffText) {
	const blocks = []
	let pending = []
	let newLine = 0
	for (const line of diffText.split("\n")) {
		const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
		if (hunk) {
			if (pending.length) {
				blocks.push(pending)
				pending = []
			}
			newLine = Number(hunk[1])
			continue
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			pending.push({ line: newLine, text: line.slice(1) })
			newLine++
		} else {
			if (pending.length) {
				blocks.push(pending)
				pending = []
			}
			if (line.startsWith("-") || line.startsWith("\\")) continue
			newLine++
		}
	}
	if (pending.length) blocks.push(pending)
	return blocks
}

/**
 * Run the five wire-compat checks over the added lines of one file.
 *
 * @param {string} path file path (repo-relative)
 * @param {ReadonlyArray<ReadonlyArray<{line:number,text:string}>>} blocks added-line blocks
 * @param {Set<string>} registeredMetaKeys
 * @returns {Array<{check:string,line:number,snippet:string}>}
 */
export function checkAddedBlocks(_path, blocks, registeredMetaKeys) {
	const findings = []
	for (const block of blocks) {
		const text = block.map((l) => l.text).join("\n")
		const line0 = block[0].line

		// 1. rawInput must stay the agent's verbatim input — a spread merged
		//    with extra keys into an emitted rawInput means computed/live
		//    state is piggybacking on it (rule 2).
		{
			const m = /rawInput:\s*\{[^}]*\.\.\.[^}]*[,}]/.exec(text)
			if (m) findings.push({ check: "rawinput-merge", line: line0, snippet: m[0].slice(0, 120) })
		}

		// 2. `_meta` keys belong in the registry (rule 2): quoted string keys
		//    inside a `_meta` object literal must be a registered key.
		{
			const metaRe = /_meta:\s*\{([^}]|\}[^)])*?(?:\}|Z)/gs
			const keyRe = /"([^"]+)":/g
			for (const metaMatch of text.matchAll(metaRe)) {
				for (const km of metaMatch[0].matchAll(keyRe)) {
					const key = km[1]
					if (!registeredMetaKeys.has(key)) {
						findings.push({ check: "meta-unregistered", line: line0, snippet: `"${key}"` })
					}
				}
			}
		}

		// 3. sendCustomMessage is a messaging API, not a recording API
		//    (rule 4): display:false means "record without showing", which
		//    projects into model context and replay anyway. Facts of the past
		//    belong in appendCustomEntry.
		{
			const m = /sendCustomMessage\([\s\S]*?display:\s*false/.exec(text)
			if (m) findings.push({ check: "custommessage-recorder", line: line0, snippet: m[0].slice(0, 120) })
		}
		if (/triggerTurn:\s*true/.test(text) && !/backgroundRunsPermitted|session-policy|opt[ -]?in/i.test(text)) {
			findings.push({ check: "ungated-wake", line: line0, snippet: "sendMessage({ ..., triggerTurn: true })" })
		}

		// 5. New ext methods must be advertised as custom capabilities at
		//    initialize (extensibility anchor; rule 9 for v2-RFD grounding).
		//    Unregistered means: not a known _kimchi.dev/* literal anywhere
		//    else in the tree.
		{
			const methodRe = /"(_kimchi\.dev\/[^"]+)"/g
			for (const m of text.matchAll(methodRe)) {
				if (!registeredMetaKeys.has(m[1])) {
					findings.push({ check: "ext-method-unregistered", line: line0, snippet: m[1] })
				}
			}
		}
	}
	return findings
}

const CHECK_DOCS = {
	"rawinput-merge": "rule 2 (schema-first): rawInput stays the agent's verbatim input; live state goes in _meta",
	"meta-unregistered":
		"rule 2: register _meta keys as exported *META_KEY constants instead of inline literals in emission paths",
	"custommessage-recorder":
		"rule 4: sendCustomMessage is messaging, not recording — use sessionManager.appendCustomEntry for facts of the past",
	"ungated-wake":
		"rules 1+7 (default-invisible / no-dead-window): new agent-initiated turns need the session-policy opt-in",
	"ext-method-unregistered":
		"extensibility + rule 9: new _-prefixed methods must be advertised in client capabilities at initialize and cite their v2 RFD (or 'own design, no spec track')",
}

function parseArgs(argv) {
	const args = { base: null, selfTest: false }
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--self-test") args.selfTest = true
		else if (argv[i] === "--base") args.base = argv[++i]
		else if (SUPPORTED_FLAGS.includes(argv[i])) continue
		else throw new Error(`unknown argument: ${argv[i]}`)
	}
	return args
}

function git(cmd) {
	return execSync(`git ${cmd}`, { encoding: "utf8" })
}

/** Diff base for `git diff <x> HEAD`: merge-base when reachable, else the ref as-is (shallow CI clones). */
function diffBase(ref) {
	try {
		return git(`merge-base ${ref} HEAD`).trim() || ref
	} catch {
		return ref
	}
}

function listChangedTs(base) {
	return git(`diff --name-only ${diffBase(base)} HEAD`)
		.split("\n")
		.map((p) => p.trim())
		.filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && (p.startsWith("src/") || p.startsWith("scripts/")))
}

function readHeadFiles(paths) {
	const files = new Map()
	for (const p of paths) {
		try {
			files.set(p, readFileSync(p, "utf8"))
		} catch {
			/* deleted file */
		}
	}
	return files
}

function listAllSrcTs() {
	return git("ls-files 'src/**/*.ts'").split("\n").filter(Boolean)
}

// ---------------------------------------------------------------------------

function runFixtures() {
	let failures = 0
	const fixture = (name, snippet, registered, expectFindings) => {
		const uniqueSorting = (f) => `${f.check}@${f.line}`
		const blocks = snippet.split("\n").map((text, i) => ({ line: i + 1, text }))
		const findings = checkAddedBlocks("fixture.ts", [blocks], new Set(registered))
		const got = findings.map((f) => f.check)
		for (const expected of expectFindings) {
			const ok = got.includes(expected)
			if (!ok) failures++
			console.error(
				`${ok ? "ok" : "FAIL"}  ${name}: expected ${expected}${ok ? "" : ` (got: ${got.join(", ") || "nothing"})`}`,
			)
		}
		for (const unexpected of got.filter((g) => !expectFindings.includes(g))) {
			failures++
			console.error(`FAIL  ${name}: unexpected ${unexpected}`)
		}
		assert.equal(new Set(findings.map(uniqueSorting)).size, findings.length, `${name}: duplicate findings`)
	}

	fixture(
		"rawInput spread merge",
		`emit({ rawInput: { ...rawInput, cohort: resolved }, status: "in_progress" })`,
		[],
		["rawinput-merge"],
	)
	fixture("rawInput verbatim passthrough", `emit({ rawInput, status: "in_progress" })`, [], [])
	fixture(
		"unregistered _meta literal",
		`_meta: { "brandNewKey": value, piToolCallId }`,
		["piToolCallId"],
		["meta-unregistered"],
	)
	fixture("registered _meta key", `_meta: { "piToolCallId": id }`, ["piToolCallId"], [])
	fixture("constant _meta key", `_meta: { [BASH_CONTROL_WAIT_META_KEY]: info, piToolCallId }`, ["piToolCallId"], [])
	fixture(
		"sendCustomMessage recorder",
		`pi.sendCustomMessage({ customType: "fact", content: data, display: false })`,
		[],
		["custommessage-recorder"],
	)
	fixture("sendCustomMessage plain message", `pi.sendCustomMessage({ customType: "note", content: data })`, [], [])
	fixture("ungated wake", `pi.sendMessage({ content: "wake", triggerTurn: true })`, [], ["ungated-wake"])
	fixture(
		"gated wake",
		'// gated via getBackgroundRunsPermitted (session-policy opt-in)\npi.sendMessage({ content: "wake", triggerTurn: true })',
		[],
		[],
	)
	fixture(
		"new ext method",
		`connection.notification("_kimchi.dev/brand_new_thing", params)`,
		[],
		["ext-method-unregistered"],
	)
	fixture(
		"known ext method",
		`connection.notification("_kimchi.dev/background_run_start", params)`,
		["_kimchi.dev/background_run_start"],
		[],
	)

	if (failures > 0) {
		console.error(`\n${failures} fixture failure(s)`)
		process.exit(1)
	}
	console.error(`\nself-test: all fixtures pass`)
}

// ---------------------------------------------------------------------------

function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.selfTest) return runFixtures()

	const base = args.base ?? "origin/HEAD"
	const changed = listChangedTs(base)
	// Registered keys are rooted at HEAD: pre-existing literals anywhere in the
	// tree are the registry of "already on the wire".
	const allSrc = listAllSrcTs()
	const registered = detectMetaKeys(readHeadFiles(allSrc))

	const findings = []
	for (const path of changed) {
		const diff = git(`diff ${diffBase(base)} HEAD -- "${path}"`)
		for (const f of checkAddedBlocks(path, addedBlocks(diff), registered)) {
			findings.push({ path, ...f })
		}
	}

	if (findings.length === 0) {
		console.log("check:acp-wire: clean")
		return
	}
	console.error("check:acp-wire: ACP wire-compat tripwires fired:\n")
	for (const f of findings) {
		console.error(`  ${f.path}:${f.line}  [${f.check}] ${f.snippet}`)
		console.error(`    ↳ ${CHECK_DOCS[f.check]}`)
	}
	console.error(`
A failing tripwire means: walk docs/acp-compat.md rules 1–2, then either fix
the diff or state in the PR body what a client that opts into nothing sees
change (main turn, between turns, on replay).`)
	process.exit(1)
}

main()
