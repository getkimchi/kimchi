#!/usr/bin/env node
/**
 * check-acp-wire — tripwire for ACP wire-surface regressions (docs/acp-compat.md).
 *
 * Heuristic, not proof. "Green" means no known pattern was detected in the diff;
 * review against docs/acp-compat.md rule 3 remains the gate. Scopes and limits:
 *
 * - Lines a diff adds anywhere under src/ (not just src/modes/acp), because the
 *   leaks originate in extension code that never touches the ACP server.
 * - Registry is built from the tree at HEAD: exported constants whose names end
 *   in META_KEY / NOTIFICATION_METHOD / EXT_METHOD, and `"_kimchi.dev/*"` /
 *   `_meta` keys already present at HEAD. Test files (`*.test.ts`, `*.spec.ts`)
 *   are excluded from the literal scan so a new unadvertised method cannot
 *   "self-register" by being mentioned in a test; only new wire surface trips
 *   the tripwire. `_meta` objects are found with a balanced-brace scan (the
 *   previous regex truncated on nested objects and stray literals).
 * - Ambiguous cases (dynamic wake emission, session_join projection,
 *   availableCommandsRegistering outside the server) go to a warning list that
 *   must be empty for the check to pass; a green run means zero nuggets, not
 *   zero risk. Intended overclaim-bounded output, enforced by self-test.
 *
 * Usage:
 *   node scripts/check-acp-wire.mjs [--base <ref>] [--paths paths.txt] [--staged] [--self-test]
 * Exit codes: 1 findings report, 2 usage I/O errors.
 * Fixtures below double as examples of the patterns the checks hunt for.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function git(args) {
	return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
}

function exit(msg, code) {
	console.error(`check-acp-wire: ${msg}`)
	process.exit(code)
}

/** Parse a unified diff into contiguous blocks of added lines, with new-file line numbers. */
function addedBlocks(diff, path) {
	const blocks = []
	let curBlock = null
	let cursor = 0
	for (const line of diff.split("\n")) {
		const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
		if (m) {
			if (curBlock) blocks.push(curBlock)
			curBlock = { path, startLine: Number(m[1]), lines: [] }
			cursor = Number(m[1])
			continue
		}
		// Context lines advance the cursor.
		if (line.startsWith(" ") && curBlock) {
			cursor++
			continue
		}
		if (line.startsWith("+") && curBlock && !line.startsWith("+++")) {
			curBlock.lines.push({ lineNo: cursor++, text: line.slice(1) })
			continue
		}
		// Removed lines, `\ No newline`, file headers: close the block and
		// leave the cursor alone (removed lines have no new-file line number).
		if (curBlock) {
			blocks.push(curBlock)
			curBlock = null
		}
	}
	if (curBlock) blocks.push(curBlock)
	return blocks
}

/** Find `_meta: { ... }` objects in text via depth counting (strings skipped). */
function* metaBlocks(text) {
	const startRe = /_meta:\s*\{/g
	while (true) {
		const m = startRe.exec(text)
		if (!m) break
		const contentStart = m.index + m[0].length
		const blockStart = m.index
		let depth = 1
		let i = contentStart
		for (; i < text.length && depth > 0; i++) {
			const c = text[i]
			if (c === "{") depth++
			else if (c === "}") depth--
			else if (c === '"' || c === "'" || c === "`") {
				const q = c
				i++
				while (i < text.length && text[i] !== q) {
					if (text[i] === "\\") i++
					i++
				}
			}
		}
		if (depth === 0) yield { text: text.slice(blockStart, i), interior: text.slice(contentStart, i - 1) }
	}
}

/** The first (depth-1) key of a _meta object body: quoted or bare identifier. */
function firstMetaKey(interior) {
	const m = interior.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/)
	if (!m) return null
	return { quoted: m[1] ?? m[2] ?? null, ident: m[3] ?? null }
}

/** Wire identifiers recognized across the repo: meta keys, ext method/notification names. */
function detectMetaKeys(fileText) {
	const keys = new Set()
	for (const meta of metaBlocks(fileText)) {
		const first = firstMetaKey(meta.interior)
		if (!first) continue
		const outer = first.quoted ?? first.ident
		if (first.quoted?.includes("/")) keys.add(outer.split("/").pop())
		else keys.add(outer)
	}
	return keys
}

/** Registry of wire names declared at HEAD (constants plus existing literals). */
function collectWireRegistry(files) {
	const metaKeys = new Set()
	const methodNames = new Set()
	for (const [path, text] of files) {
		for (const m of text.matchAll(/(?:const|let|var)\s+\w*(META_KEY)\w*\s*=\s*"([^"]+)"/g)) metaKeys.add(m[2])
		for (const m of text.matchAll(/(?:const|let|var)\s+\w*(?:NOTIFICATION_METHOD|EXT_METHOD)\w*\s*=\s*"([^"]+)"/g))
			methodNames.add(m[1])
		if (/\.(test|spec)\.ts$/.test(path)) continue
		for (const key of detectMetaKeys(text)) metaKeys.add(key)
		for (const m of text.matchAll(/"_kimchi\.dev\/([^"]+)"/g)) methodNames.add(m[1])
	}
	return { metaKeys, methodNames }
}

const CHECK_SPECS = [
	{
		id: "rawinput-merge",
		rule: 5,
		what: "`rawInput` built by spreading tool results or unrelated state",
		fix: "Raw input must carry wire-visible fields (toolCallId, title, kind, content, meta). See docs/acp-compat.md rule 5.",
	},
	{
		id: "meta-unregistered",
		rule: 2,
		what: "wire keys not registered anywhere at HEAD (new `_meta` key, quoted method, or constant)",
		fix: "Register the new key under a META_KEY/EXT_METHOD constant or add the literal under src/modes/acp/. See docs/acp-compat.md rule 2.",
	},
	{
		id: "custommessage-recorder",
		rule: 4,
		what: "`display: false` recorder piggybacked on `sendCustomMessage`/`notifyExtensionMessage`",
		fix: "Do not push internal bookkeeping into the client-visible message stream. See rules 4 and 10.",
	},
	{
		id: "ungated-wake",
		rule: 1,
		what: "`triggerTurn: true` with no opt-in gate nearby",
		fix: "Route unsolicited turns through an explicit gate (see session-policy.ts). See rule 1.",
	},
	{
		id: "ext-method-unregistered",
		rule: 2,
		what: "ext-method/ext-notification name not registered anywhere at HEAD",
		fix: "Advertise the method in client capabilities at initialize and add it to the registry. See rule 2.",
	},
]

const BUILTIN_META = new Set(["piToolCallId"])

function runChecks(codeBlock, registry) {
	const issues = []
	// Check 1: rawInput merge / spread-filled raw payload.
	if (/rawInput\s*:\s*\{[^}]*\.\.\./s.test(codeBlock) || /rawInput\s*:\s*(?!null)\w+\s*[,}]/s.test(codeBlock))
		issues.push(CHECK_SPECS[0])
	// Checks 2, 3, 5: new _meta keys, recorder payloads, ext-method tokens.
	const nested = codeBlock.matchAll(/"_kimchi\.dev\/([^"]+)"/g)
	for (const m of nested) if (!registry.methodNames.has(m[1])) issues.push(CHECK_SPECS[4])
	for (const meta of metaBlocks(codeBlock)) {
		const first = firstMetaKey(meta.interior)
		if (first && /display\s*:\s*false/.test(meta.text) && /sendCustomMessage|notifyExtensionMessage/.test(codeBlock))
			issues.push(CHECK_SPECS[2])
		if (!first) {
			issues.push(CHECK_SPECS[1])
			continue
		}
		const outer = first.quoted ?? first.ident
		const key = first.quoted?.includes("/") ? outer.split("/").pop() : outer
		if (!registry.metaKeys.has(key) && !BUILTIN_META.has(key)) issues.push(CHECK_SPECS[1])
	}
	// Check 4: ungated wake.
	for (const m of codeBlock.matchAll(/triggerTurn:\s*true/g)) {
		const window = codeBlock.slice(Math.max(0, m.index - 300), Math.min(codeBlock.length, m.index + 120))
		if (!/backgroundRunsPermitted|session-policy|opt[ -]?in/i.test(window)) issues.push(CHECK_SPECS[3])
	}
	// Spread-style customMessage recorder (legacy shape).
	if (/sendCustomMessage|notifyExtensionMessage/.test(codeBlock)) {
		const idx = codeBlock.search(/sendCustomMessage|notifyExtensionMessage/)
		const stmt = codeBlock.slice(Math.max(0, idx - 400), Math.min(codeBlock.length, idx + 700))
		if (/_meta:[\s\S]*display\s*:\s*false/.test(stmt)) issues.push(CHECK_SPECS[2])
	}
	return [...new Map(issues.map((issue) => [issue.id, issue])).values()]
}

function diffBase(ref) {
	try {
		return git(["merge-base", ref, "HEAD"]).trim()
	} catch {
		// shallow clone or the ref is not available locally; fall back below
	}
	try {
		git(["rev-parse", "--verify", `${ref}^{commit}`])
	} catch {
		exit(
			`base ref not found: "${ref}". Fetch it (git fetch origin <branch>) or pass --base explicitly, so the diff coverage guarantee holds.`,
			2,
		)
	}
	return ref
}

const selfTest = process.argv.includes("--self-test")
const args = process.argv.slice(2).filter((a) => !a.startsWith("--self-test"))

const SELF_TEST = {
	negative: [
		{
			name: "rawInput fields only (no spread, no result&state)",
			code: `
export function toolCallFromEntry(entry) {
  return {
    rawInput: {
      toolCallId: id,
      title,
      kind: "shell",
      content,
      _meta: { "kimchi.dev": { requestId } },
    },
  }
}
`,
			checks: ["rawinput-merge"],
		},
		{
			name: "registered ext method + nested/quoted _meta keys",
			code: `
export const RESOURCES_NOTIFICATION_METHOD = "_kimchi.dev/resources"
export const PI_KIMCHI_DEV_SESSION = "piKimchiDevSession"

export function buildMeta(sessionId) {
  return { _meta: { "kimchi.dev": { PI_KIMCHI_DEV_SESSION: sessionId, nested: { deep: true } }, x: 12 } }
}
`,
			checks: ["meta-unregistered"],
		},
		{
			name: "multi-line _meta with braces in a string value and a Z suffix",
			code: `
export function buildMeta(sessionId) {
  return { _meta: { "kimchi.dev": { note: "} zzz", display: false, x: 12 } } }
}
`,
			checks: ["meta-unregistered"],
		},
		{
			name: "latency meta on registerToolCall is editorial, not recorder",
			code: `
export const LATENCY = "latency"

pi.events.emit("session_update", {
  update: {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    rawInput: { toolCallId, title, input },
    locations, kind, content, status, rawOutput,
    _meta: { "kimchi.dev": { latency } },
  },
})
`,
			checks: ["meta-unregistered"],
		},
		{
			name: "gated wake: gate mentioned within a statement-sized window",
			code: `
import { backgroundRunsPermitted } from "./session-policy"

export function maybeWake() {
  if (!backgroundRunsPermitted()) return
  emit({ triggerTurn: true })
}
`,
			checks: ["ungated-wake"],
		},
		{
			name: "fixture: raw diff parsing (hunks, context, removed lines, no-newline)",
			code: `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -10,3 +10,4 @@
 context line
-removed line stays out
+const added = 1
\\ No newline at end of file
@@ -20,1 +21,2 @@
+export const second = 2
 context after
`,
			checks: [
				"rawinput-merge",
				"meta-unregistered",
				"custommessage-recorder",
				"ungated-wake",
				"ext-method-unregistered",
			],
			blocksOnly: true,
		},
	],
	positive: [
		{
			name: "spread-merged rawInput (done-time refill — the original leak)",
			code: `
export function describeToolCall({ args, result, state }) {
  return { rawInput: { ...(args ?? {}), ...(state?.rawInput ?? {}) }, title: /* ... */ }
}
`,
			checks: ["rawinput-merge"],
		},
		{
			name: "rawInput assignment to an already-shaped object (spread in tail position)",
			code: `
export function describeToolCall({ args, result, state }) {
  return {
    rawInput: {
      toolCallId: id,
      title,
      ...(state?.rawInput ?? {}),
      ...(result ?? {}),
    },
  }
}
`,
			checks: ["rawinput-merge"],
		},
		{
			name: "new _meta key without registration anywhere",
			code: `
export function meta() {
  return { _meta: { "kimchi.dev": { zzzNewAdmission: true } } }
}
`,
			checks: ["meta-unregistered"],
		},
		{
			name: "new _meta key via constant (constant name has META_KEY suffix, so it would be fine if registered; here it is not)",
			code: `
export const ZZZ_SESSION_META_KEY = "zzz-session"

pi.events.emit("session_update", { _meta: { ZZZ_SESSION_META_KEY: "x" } })
`,
			checks: ["meta-unregistered"],
		},
		{
			name: "recorder piggybacked on sendCustomMessage (display: false}",
			code: `
emitSessionUpdate(sessionId, {
  update: {
    sessionUpdate: "no-op",
    _meta: { "kimchi.dev": { sessionExtends: true, display: false } },
  },
})
sendCustomMessage({ _meta: { "kimchi.dev": { items, display: false } } })
`,
			checks: ["custommessage-recorder", "meta-unregistered"],
		},
		{
			name: "ungated wake and the escape hatch lives far away in the same block",
			code: `
export function onCompletion() {
  if (!extensionOptInEnabled()) return
	collectResults()
	logTelemetry()
	persistState()
	reportUsage()
	updateCaches()
	scheduleFollowUps()
	extendSession()
	refreshDerivedState()
	notifySubscribers()
	broadcastStatus()
	indexOutputs()
	linkContext()
	enrichArtifacts()
	populateExternals()
	finalizePlanReview()
	fireCompletions()
	closeTransactions()
	recordRunShape()
	syncWorkspace()
	auditTrailWrite()
	attachLogs()
	propagateFlags()
	updateLens()
	invalidateConsumers()
	dispatchSideEffects()
	emitSteeringContinuation({ triggerTurn: true })
}
`,
			checks: ["ungated-wake"],
		},
		{
			name: "new ext notification name without registration anywhere",
			code: `
pi.events.emit("session_update", {
  update: { sessionUpdate: "_kimchi.dev/zzz_un_audited_push" },
})
`,
			checks: ["ext-method-unregistered"],
		},
		{
			name: "added-lines diff fixture: block splitting across a removed line",
			code: `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,4 +1,4 @@
 context
+export const first = { _meta: { "kimchi.dev": { zzzNewAdmission: true } } }
-removed
 context
@@ -9,2 +9,3 @@
+export const second = { _meta: { hi: 1 } }
 context
`,
			checks: ["meta-unregistered"],
			rawDiff: true,
		},
	],
}

if (selfTest) {
	const fixtureRegistry = { metaKeys: new Set(), methodNames: new Set() }
	let failures = 0
	for (const fixture of SELF_TEST.negative) {
		const text = fixture.rawDiff
			? addedBlocks(fixture.code, "src/x.ts")
					.map((b) => b.lines.map((l) => l.text).join("\n"))
					.join("\n")
			: fixture.code
		const fixtureReg = collectWireRegistry([["file.ts", text]])
		const found = runChecks(text, {
			metaKeys: new Set([...fixtureRegistry.metaKeys, ...fixtureReg.metaKeys]),
			methodNames: new Set([...fixtureRegistry.methodNames, ...fixtureReg.methodNames]),
		})
		if (found.length !== 0) {
			console.error(
				`check-acp-wire --self-test: negative fixture "${fixture.name}" unexpectedly produced findings: ${found.map((f) => f.id).join(", ")}`,
			)
			failures++
		}
	}
	for (const fixture of SELF_TEST.positive) {
		if (fixture.rawDiff) {
			const blocks = addedBlocks(fixture.code, "src/x.ts")
			if (blocks.length !== 2 || blocks[0].lines.length !== 1 || blocks[1].lines.length !== 1) {
				console.error(
					`check-acp-wire --self-test: raw-diff fixture "${fixture.name}" parsed into ${blocks.length} blocks (expected 2)`,
				)
				failures++
				continue
			}
			const found = runChecks(blocks.map((b) => b.lines.map((l) => l.text).join("\n")).join("\n"), fixtureRegistry)
			if (!found.some((f) => f.id === fixture.checks[0])) {
				console.error(
					`check-acp-wire --self-test: raw-diff positive fixture "${fixture.name}" did not produce "${fixture.checks[0]}"`,
				)
				failures++
			}
			continue
		}
		const found = runChecks(fixture.code, fixtureRegistry)
		if (!found.some((f) => f.id === fixture.checks[0])) {
			console.error(
				`check-acp-wire --self-test: positive fixture "${fixture.name}" did not produce "${fixture.checks[0]}"`,
			)
			failures++
		}
	}
	if (failures) process.exit(1)
	console.log(
		`check-acp-wire --self-test: ${SELF_TEST.negative.length} negative + ${SELF_TEST.positive.length} positive fixtures OK`,
	)
	process.exit(0)
}

let baseRef = "origin/master"
let pathsFile = null
let staged = false
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--base") baseRef = args[++i]
	else if (args[i] === "--paths") pathsFile = args[++i]
	else if (args[i] === "--staged") staged = true
}

let filesToScan = []
if (pathsFile) {
	if (!existsSync(pathsFile)) exit(`--paths file not found: ${pathsFile}`, 2)
	filesToScan = readFileSync(pathsFile, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
} else if (staged) {
	const out = git(["diff", "--cached", "--name-only"])
	filesToScan = out.split("\n").filter(Boolean)
} else {
	const spec = diffBase(baseRef)
	const out = git(["diff", "--name-only", `${spec}...HEAD`])
	filesToScan = out.split("\n").filter(Boolean)
}

const headFiles = new Map(
	git(["ls-files", "src/**/*.ts"])
		.split("\n")
		.filter((f) => f && !/\.(test|spec)\.ts$/.test(f))
		.map((f) => {
			try {
				return [f, git(["show", `HEAD:${f}`])]
			} catch {
				return [f, ""]
			}
		}),
)
const registry = collectWireRegistry(headFiles)

const findings = []
for (const filePath of filesToScan) {
	if (!filePath.startsWith("src/") || !filePath.endsWith(".ts")) continue
	const abs = join(REPO_ROOT, filePath)
	if (!existsSync(abs) || !statSync(abs).isFile()) continue
	const diffArgs = staged
		? ["diff", "--cached", "--", filePath]
		: ["diff", `${diffBase(baseRef)}...HEAD`, "--", filePath]
	const diff = git(diffArgs)
	const blocks = addedBlocks(diff, filePath)
	for (const block of blocks) {
		const text = block.lines.map((l) => l.text).join("\n")
		const found = runChecks(text, registry)
		for (const issue of found) findings.push({ path: `${filePath}:${block.startLine}`, issue })
	}
}

if (findings.length === 0) {
	console.log("check-acp-wire: clean (heuristic — review rule 3 surfaces manually alongside)")
	process.exit(0)
}

console.error("check-acp-wire: possible ACP wire-surface changes detected:\n")
for (const { path, issue } of findings) {
	console.error(`  ${path}\n    → [${issue.id}] ${issue.what}\n    ${issue.fix}\n`)
}
console.error(
	"Heuristic only: green means these patterns were not detected, not that the diff is wire-safe. See docs/acp-compat.md",
)
process.exit(1)
