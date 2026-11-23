// Generated-artifact detection (live turns, any surface).
//
// Detects user-openable files (slides, spreadsheets, PDFs, …) the agent
// produced, so clients can render an "Open <name>" action. Live only:
// replayed sessions replay recorded rows, they never re-run this module. Detection is
// conservative: write/edit paths, tool-declared `details.artifacts`
// (submit_plan is the first producer), and bash/powershell output are
// inspected; candidates must match the extension allowlist, and live
// detection requires the file to exist. Detection never throws.
//
// Trust assumption: artifact paths are agent-controlled output; the link
// is an explicit user action. Script-capable types (.html/.svg) open in
// the user's own environment.

import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseCommandSegments } from "../permissions/taxonomy.js"
import { resolveToolPath } from "./paths.js"

export type Artifact = {
	/** Absolute resolved path. */
	path: string
	/** Basename, for link labels. */
	name: string
	/** file:// URI form of path. */
	uri: string
	/** Best-known MIME type from the extension allowlist; may be undefined. */
	mimeType?: string
	/**
	 * Provenance, assigned once here in detect: "declared" (tool's own
	 * details.artifacts — mid-turn emission trigger), "write" (write/edit
	 * args — intentional), "sniffed" (bash/powershell output), or
	 * "snapshot" (a filesystem delta hidden behind the client's artifact
	 * opt-in). Sniffed/snapshot entries are eviction-eligible at the cap.
	 */
	origin: "declared" | "write" | "sniffed" | "snapshot"
}

/** Lowercase extension → MIME type. Fixed allowlist for v1 (not configurable). */
export const ARTIFACT_EXTENSIONS: Record<string, string> = {
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pdf": "application/pdf",
	".html": "text/html",
	".htm": "text/html",
	".csv": "text/csv",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".zip": "application/zip",
	".ics": "text/calendar",
}

// Max artifacts reported per bash result (bounds flood-prone output).
const MAX_BASH_ARTIFACTS = 8

// Max tool-declared artifacts per result. Declared paths are trusted, but
// the array is arbitrary tool output — bound it so a verbose or buggy
// execute() can't burst resource_link chunks.
const MAX_DECLARED_ARTIFACTS = 32

// Max candidate tokens evaluated per result. statSync is synchronous,
// so an unbounded match stream could stall the server's event loop.
const MAX_BASH_CANDIDATES = 256

// A sniffed bash/powershell candidate counts as agent-produced only if its
// mtime is at-or-after the tool call's start (stamped at
// tool_execution_start); otherwise a read-only command (`cat`/`ls`) naming
// a pre-existing file would produce a link (cf. anthropics/claude-code
// #102401). The tolerance absorbs 1-second mtime granularity (HFS+, some
// network mounts). Backgrounded commands are not covered: their output
// arrives via steering/bash_control messages, not tool results.
const MTIME_TOLERANCE_MS = 2000

// Tree-materializing git commands restore files from git objects with
// fresh mtimes, bypassing the window check, so output sniffing is skipped
// for them. Whole-command skip: `git stash pop && python make.py` also
// misses the python artifact (accepted v1 trade-off). Commands are
// tokenized with the permissions taxonomy's shell parser
// (parseCommandSegments), not ad-hoc regex.
const GIT_TREE_MATERIALIZING = new Set([
	"checkout",
	"switch",
	"merge",
	"rebase",
	"reset",
	"restore",
	"pull",
	"cherry-pick",
	"revert",
	"apply",
	"worktree",
])
// Flags that take a separate argument; other dash-prefixed tokens are
// skipped and the next bare token is the subcommand.
const GIT_ARG_FLAGS = new Set(["-C", "-c", "-u", "--git-dir", "--work-tree", "--exec-path", "--namespace"])

// Commands that simply delegate to the real command after their own
// options and (for env) VAR=value assignments.
const WRAPPER_COMMANDS = new Set([
	"sudo",
	"doas",
	"command",
	"noglob",
	"nohup",
	"setsid",
	"stdbuf",
	"time",
	"nice",
	"env",
])

// Wrapper options that take a separate argument (`sudo -u root`), per
// their man pages (sudo.ws, coreutils env/stdbuf/nice, util-linux setsid,
// GNU time, OpenBSD doas). Keyed by wrapper because the same flag differs
// between them: `sudo -n` takes no argument, `nice -n 5` does; `sudo -S`
// (stdin) is argless, `env -S string` is not. Long options with separate
// arguments (`sudo --user root`) misclassify and degrade to sniffing.
// Windows `cmd /c git …`-style launches are not wrappers (`/`-prefixed
// options don't parse through `-` handling) and also degrade to sniffing.
const WRAPPER_ARG_FLAGS: Record<string, ReadonlySet<string>> = {
	sudo: new Set(["-a", "-c", "-C", "-D", "-g", "-h", "-p", "-R", "-r", "-t", "-T", "-U", "-u"]),
	doas: new Set(["-a", "-C", "-u"]),
	nice: new Set(["-n"]),
	// env `-P altpath` is BSD-only (inert in the set on GNU env).
	env: new Set(["-a", "-u", "-C", "-S", "-P"]),
	time: new Set(["-f", "-o"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
}

// Lowercased basename without a Windows .exe suffix, so absolute paths
// (/usr/bin/git) and git.exe both match.
function executableName(token: string): string {
	const base = token.slice(Math.max(token.lastIndexOf("/") + 1, token.lastIndexOf("\\") + 1))
	return base.replace(/\.exe$/i, "").toLowerCase()
}

// Skips leading wrapper commands (and their option/assignment tokens) so
// "sudo git pull" or "env FOO=1 git merge" classify as git. Unknown
// wrapper options with arguments misclassify and degrade to plain
// sniffing.
function firstRealCommand(tokens: string[]): { name: string; index: number } | undefined {
	let i = 0
	for (;;) {
		const token = tokens[i]
		if (token === undefined) return undefined
		const name = executableName(token)
		if (!WRAPPER_COMMANDS.has(name)) return { name, index: i }
		i++
		const argFlags = WRAPPER_ARG_FLAGS[name]
		while (i < tokens.length) {
			const opt = tokens[i] as string
			if (argFlags?.has(opt)) {
				i += 2
				continue
			}
			if (!/^(?:-|[A-Za-z_]\w*=)/.test(opt)) break
			i++
		}
	}
}

function gitSubcommand(tokens: string[]): string | undefined {
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i] as string
		if (GIT_ARG_FLAGS.has(t)) {
			i++
			continue
		}
		if (t.startsWith("-")) continue
		return t
	}
	return undefined
}

/**
 * True when any segment of the command is a git invocation that restores
 * working-tree files from git objects (checkout/merge/stash pop/…), so its
 * output must not be sniffed for artifacts. Handles wrapper commands
 * (sudo/env/time, …) and non-bare invocations (/usr/bin/git, git.exe); a
 * git call hidden inside a script is not detectable at this layer.
 */
function isTreeMaterializingGit(segments: CommandSegments): boolean {
	for (const segment of segments) {
		const cmd = firstRealCommand(segment.tokens)
		if (cmd === undefined || cmd.name !== "git") continue
		const gitTokens = segment.tokens.slice(cmd.index)
		const sub = gitSubcommand(gitTokens)
		if (sub === undefined) continue
		if (GIT_TREE_MATERIALIZING.has(sub)) return true
		if (sub === "stash" && (gitTokens.includes("pop") || gitTokens.includes("apply"))) return true
	}
	return false
}

// Leading navigation ("cd X && …", PowerShell "Set-Location X; …"):
// resolve sniffed relative tokens against the target directory instead of
// the session cwd. Only a leading segment is honored; mid-script cd,
// pushd/popd, and make -C remain misses (conservative direction).
function navigatedCwd(segments: CommandSegments, cwd: string): string {
	const tokens = segments[0]?.tokens ?? []
	const name = tokens[0]?.toLowerCase()
	if ((name === "cd" || name === "set-location") && tokens.length === 2) {
		try {
			return resolveToolPath(tokens[1] as string, cwd)
		} catch {
			return cwd
		}
	}
	return cwd
}

type CommandSegments = ReturnType<typeof parseCommandSegments>

type FileStamp = { mtimeMs: number; size: number }

/**
 * Pre-execution view of allowlisted files directly in a shell command's
 * effective working directory. A delta is an authorship candidate, not
 * proof that this command wrote the file. The deliberately shallow scope
 * avoids whole-tree/filesystem monitoring.
 */
export type ArtifactFileSnapshot = { cwd: string; files: ReadonlyMap<string, FileStamp> }

/** One consumer of a shared execution claim (live ACP or recorder). */
export type ArtifactSnapshotClaim = {
	scope: object
	toolCallId: string
	consumer: "acp" | "recorder"
	/** Ineligible calls retain producer tracking without capturing a file snapshot. */
	capture?: boolean
}

type ExecutionObservationKind = "snapshot" | "direct-path" | "opaque"
type CwdExecutionObservation = {
	cwd: string
	active: number
	activeSnapshots: number
	activeOpaqueProducers: number
	ambiguous: boolean
	knownWriterPaths: Set<string>
}
type SharedSnapshot = {
	snapshot: ArtifactFileSnapshot | undefined
	consumers: Set<ArtifactSnapshotClaim["consumer"]>
	observation: CwdExecutionObservation
	observationKind: ExecutionObservationKind
	executionReleased: boolean
}

const sharedSnapshots = new WeakMap<object, Map<string, SharedSnapshot>>()
const cwdExecutions = new Map<string, CwdExecutionObservation>()
const snapshotExecutions = new WeakMap<ArtifactFileSnapshot, CwdExecutionObservation>()

function isArtifactExtension(path: string): boolean {
	return extname(path).toLowerCase() in ARTIFACT_EXTENSIONS
}

function supportedDirectoryFiles(cwd: string): Map<string, FileStamp> {
	const files = new Map<string, FileStamp>()
	let entries: Dirent[]
	try {
		entries = readdirSync(cwd, { withFileTypes: true })
	} catch {
		return files
	}
	for (const entry of entries) {
		if (!isArtifactExtension(entry.name)) continue
		try {
			const path = join(cwd, entry.name)
			const stats = statSync(path)
			if (stats.isFile()) files.set(path, { mtimeMs: stats.mtimeMs, size: stats.size })
		} catch {
			// A concurrently removed or unreadable entry is a conservative miss.
		}
	}
	return files
}

function shellCommandContext(toolName: string, args: unknown, cwd: string) {
	if (toolName !== "bash" && toolName !== "powershell") return undefined
	const command = (args as { command?: unknown } | null | undefined)?.command
	if (typeof command !== "string") return undefined
	const segments = parseCommandSegments(command)
	if (isTreeMaterializingGit(segments)) return null
	return { segments, cwd: navigatedCwd(segments, cwd) }
}

function captureArtifactSnapshot(toolName: string, args: unknown, cwd: string): ArtifactFileSnapshot | undefined {
	try {
		const context = shellCommandContext(toolName, args, cwd)
		if (!context) return undefined
		return { cwd: context.cwd, files: supportedDirectoryFiles(context.cwd) }
	} catch {
		return undefined
	}
}

function canonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd)
	} catch {
		return resolve(cwd)
	}
}

function rememberArtifactPath(path: string): void {
	const cwd = canonicalCwd(dirname(path))
	cwdExecutions.get(cwd)?.knownWriterPaths.add(join(cwd, basename(path)))
}

/** Shared bookkeeping for every non-snapshot source; snapshot candidates never call this. */
function rememberProducedArtifacts(artifacts: readonly Artifact[]): void {
	for (const artifact of artifacts) rememberArtifactPath(artifact.path)
}

/** Keep direct write/edit ownership ahead of any active shell snapshot. */
export function observeDirectArtifactWrite(toolName: string, args: unknown, cwd: string): void {
	try {
		if (toolName !== "write" && toolName !== "edit") return
		const rawPath = (args as { path?: unknown } | null | undefined)?.path
		if (typeof rawPath !== "string" || !isArtifactExtension(rawPath)) return
		rememberArtifactPath(resolveToolPath(rawPath, cwd))
	} catch {
		// Provenance tracking must never prevent the tool from executing.
	}
}

function observeExecution(
	cwd: string,
	snapshot: ArtifactFileSnapshot | undefined,
	kind: ExecutionObservationKind,
): CwdExecutionObservation {
	const canonical = canonicalCwd(cwd)
	let observation = cwdExecutions.get(canonical)
	if (!observation) {
		observation = {
			cwd: canonical,
			active: 0,
			activeSnapshots: 0,
			activeOpaqueProducers: 0,
			ambiguous: false,
			knownWriterPaths: new Set(),
		}
		cwdExecutions.set(canonical, observation)
	}
	// Unknown producer outputs make overlapping filesystem deltas ambiguous,
	// regardless of which call finishes first. Precise direct-write paths do
	// not suppress the rest of the directory. Ambiguity stays through its interval.
	if (kind === "snapshot") {
		if (observation.activeSnapshots > 0 || observation.activeOpaqueProducers > 0) observation.ambiguous = true
		observation.activeSnapshots++
	} else if (kind === "opaque") {
		if (observation.activeSnapshots > 0) observation.ambiguous = true
		observation.activeOpaqueProducers++
	}
	observation.active++
	if (snapshot) snapshotExecutions.set(snapshot, observation)
	return observation
}

/**
 * Capture eligible file state before a tool runs and share producer ownership.
 * ACP and the recorder pass the same SessionManager as `claim.scope`, so
 * they share one execution observation (and at most one directory scan).
 */
export function snapshotArtifactFiles(
	toolName: string,
	args: unknown,
	cwd: string,
	claim?: ArtifactSnapshotClaim,
): ArtifactFileSnapshot | undefined {
	if (!claim) return captureArtifactSnapshot(toolName, args, cwd)
	let calls = sharedSnapshots.get(claim.scope)
	if (!calls) {
		calls = new Map()
		sharedSnapshots.set(claim.scope, calls)
	}
	const existing = calls.get(claim.toolCallId)
	if (existing) {
		existing.consumers.add(claim.consumer)
		return existing.snapshot
	}
	const snapshot = claim.capture === false ? undefined : captureArtifactSnapshot(toolName, args, cwd)
	let executionCwd = snapshot?.cwd ?? cwd
	if (!snapshot) {
		try {
			executionCwd = shellCommandContext(toolName, args, cwd)?.cwd ?? cwd
		} catch {
			// A malformed command can still run through its legacy fallback.
		}
	}
	const observationKind: ExecutionObservationKind = snapshot
		? "snapshot"
		: toolName === "write" || toolName === "edit"
			? "direct-path"
			: "opaque"
	calls.set(claim.toolCallId, {
		snapshot,
		consumers: new Set([claim.consumer]),
		observation: observeExecution(executionCwd, snapshot, observationKind),
		observationKind,
		executionReleased: false,
	})
	return snapshot
}

/** Release one consumer; the snapshot dies after its last user finishes. */
export function releaseArtifactSnapshot(claim: ArtifactSnapshotClaim): void {
	const calls = sharedSnapshots.get(claim.scope)
	const existing = calls?.get(claim.toolCallId)
	if (!calls || !existing?.consumers.delete(claim.consumer)) return
	if (!existing.executionReleased) {
		// The consumers finish at the same execution boundary. Only one ends
		// the claim's ownership; cache retention must not prolong its lifetime.
		existing.executionReleased = true
		const { observation, observationKind } = existing
		observation.active--
		if (observationKind === "snapshot") observation.activeSnapshots--
		if (observationKind === "opaque") observation.activeOpaqueProducers--
		if (observation.active === 0 && cwdExecutions.get(observation.cwd) === observation) {
			cwdExecutions.delete(observation.cwd)
		}
	}
	if (existing.consumers.size > 0) return
	calls.delete(claim.toolCallId)
	if (calls.size === 0) sharedSnapshots.delete(claim.scope)
}

function changedSnapshotArtifacts(snapshot: ArtifactFileSnapshot, opts: DetectOpts): Artifact[] {
	const observation = snapshotExecutions.get(snapshot)
	if (observation?.ambiguous) return []
	const out: Artifact[] = []
	const current = [...supportedDirectoryFiles(snapshot.cwd).entries()].sort(([a], [b]) => a.localeCompare(b))
	for (const [path, stamp] of current) {
		if (out.length >= MAX_BASH_ARTIFACTS) break
		const before = snapshot.files.get(path)
		if (before && before.mtimeMs === stamp.mtimeMs && before.size === stamp.size) continue
		// Another prompt's validated non-snapshot producer may own this path.
		// Exclude only that path; other shell-created files remain eligible.
		if (observation?.knownWriterPaths.has(join(observation.cwd, basename(path)))) continue
		const artifact = artifactFromPath(path, snapshot.cwd, opts, "snapshot")
		if (artifact) out.push(artifact)
	}
	return out
}

// Tool-declared artifact entry, shaped after ACP's ToolCallLocation.
// `name` falls back to the file basename.
type DeclaredArtifactEntry = { path?: unknown; name?: unknown }

// `details.artifacts` declarations are authoritative paths (like write/edit
// args): no mtime window. They let tools that write files internally
// (submit_plan saves .kimchi/plans/<slug>.md itself) surface artifacts
// without the write tool running. Empty/missing entries are skipped; filtered
// entries (wrong extension, missing live file) drop out, and an empty
// result still short-circuits the path-guess fallbacks.
function parseDeclaredArtifacts(result: unknown, cwd: string): { handled: boolean; artifacts: Artifact[] } {
	const entries = (result as { details?: { artifacts?: unknown } } | null | undefined)?.details?.artifacts
	if (!Array.isArray(entries) || !entries.length) return { handled: false, artifacts: [] }
	const artifacts: Artifact[] = []
	for (const entry of entries as DeclaredArtifactEntry[]) {
		if (artifacts.length >= MAX_DECLARED_ARTIFACTS) break
		const { path, name } = entry ?? {}
		if (!path || typeof path !== "string") continue
		const artifact = artifactFromPath(path, cwd, {}, "declared")
		if (!artifact) continue
		artifacts.push(name && typeof name === "string" ? { ...artifact, name } : artifact)
	}
	return { handled: true, artifacts }
}

type DetectOpts = {
	/**
	 * Tool-call start (epoch ms). Sniffed bash/powershell candidates must
	 * have an mtime inside the window; write/edit args are authoritative
	 * and skip the check.
	 */
	windowStart?: number
	/** State captured at tool_execution_start for silent shell side effects. */
	fileSnapshot?: ArtifactFileSnapshot
}

// Candidates always have to exist on disk — this is live detection; replay
// reads recorded rows instead of re-running this pipeline.
function artifactFromPath(rawPath: string, cwd: string, opts: DetectOpts, origin: Artifact["origin"]): Artifact | null {
	if (!isArtifactExtension(rawPath)) return null
	const mimeType = ARTIFACT_EXTENSIONS[extname(rawPath).toLowerCase()]
	let path: string
	try {
		path = resolveToolPath(rawPath, cwd)
	} catch {
		return null
	}
	let stats: ReturnType<typeof statSync>
	try {
		stats = statSync(path)
	} catch {
		return null
	}
	if (!stats.isFile()) return null
	if (opts.windowStart !== undefined && stats.mtimeMs < opts.windowStart - MTIME_TOLERANCE_MS) return null
	return { path, name: basename(path), uri: pathToFileURL(path).href, mimeType, origin }
}

// Candidate path tokens in shell output, keyed on the extension allowlist
// so plain words never match. Quotes, whitespace, and shell metachars
// terminate a token (paths with spaces are not detected — v1 trade-off).
// One trailing sentence period is allowed (\.?, stripped from the token)
// so "Wrote report.md." matches, while (?![\w.]) still rejects
// report.md.bak. Tokens containing "://" (URLs) are rejected before
// resolution. detect.test.ts keeps this extension list in sync with
// ARTIFACT_EXTENSIONS in both directions. The prefix requires >=1 char so
// bare extension mentions ("wrote a .md file") never become candidates —
// `.md` alone would resolve to <cwd>/.md. Also excluded: commas (data rows
// like "monday,grumpy,report.csv" must not become comma-joined fake paths),
// backslashes (escape noise in output), and dollars (shell syntax —
// "$OUT.md", "${DIR}/x.pdf") — none realistically appear in doc-ish names.
const PATH_TOKEN =
	/[^\s"'<>`;|&*?()[\]{},$\\]+\.(?:pptx|xlsx|docx|pdf|html|htm|csv|png|jpg|jpeg|gif|webp|svg|md|markdown|zip|ics)\.?(?![\w.])/gi

function textBlocks(result: unknown): string[] {
	const r = result as { content?: unknown } | null | undefined
	if (!r || !Array.isArray(r.content)) return []
	const out: string[] = []
	for (const block of r.content) {
		const b = block as { type?: unknown; text?: unknown } | null
		if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") out.push(b.text)
	}
	return out
}

function isErrorResult(result: unknown): boolean {
	return (result as { isError?: unknown } | null | undefined)?.isError === true
}

function bashArtifacts(result: unknown, cwd: string, opts: DetectOpts): Artifact[] {
	const out: Artifact[] = []
	const seen = new Set<string>()
	const seenTokens = new Set<string>()
	let candidates = 0
	for (const text of textBlocks(result)) {
		for (const match of text.matchAll(PATH_TOKEN)) {
			if (out.length >= MAX_BASH_ARTIFACTS) return out
			// Strip the allowed sentence-final period (see PATH_TOKEN).
			const token = match[0].endsWith(".") ? match[0].slice(0, -1) : match[0]
			// Dedupe raw tokens before the budget check so repeats cost
			// neither a budget slot nor resolution/existence syscalls.
			if (seenTokens.has(token)) continue
			seenTokens.add(token)
			if (++candidates > MAX_BASH_CANDIDATES) return out
			if (token.includes("://")) continue
			const artifact = artifactFromPath(token, cwd, opts, "sniffed")
			if (!artifact || seen.has(artifact.path)) continue
			seen.add(artifact.path)
			out.push(artifact)
		}
	}
	return out
}

// Redirect targets (echo foo > out.csv, tee report.md). Taxonomy ops carry
// the target; only stdout forms (">"/">>") count — fd/stderr forms like
// 2>log never match. Same gates as sniffed tokens: allowlisted extension,
// existence (live), mtime window.
function redirectArtifacts(segments: CommandSegments, cwd: string, opts: DetectOpts): Artifact[] {
	const out: Artifact[] = []
	const seen = new Set<string>()
	for (const segment of segments) {
		for (const op of segment.ops) {
			if ((op.op !== ">" && op.op !== ">>") || typeof op.target !== "string") continue
			if (!isArtifactExtension(op.target)) continue
			const artifact = artifactFromPath(op.target, cwd, opts, "sniffed")
			if (!artifact || seen.has(artifact.path)) continue
			seen.add(artifact.path)
			out.push(artifact)
		}
	}
	return out
}

/**
 * Detect generated artifacts from a completed tool call. `args` are the
 * tool's arguments (stashed at tool_execution_start; the end event has
 * none). Errored results produce no artifacts. Never throws.
 */
export function artifactsFromToolCall(
	toolName: string,
	args: unknown,
	result: unknown,
	cwd: string,
	opts: DetectOpts = {},
): Artifact[] {
	try {
		if (isErrorResult(result)) return []
		const declared = parseDeclaredArtifacts(result, cwd)
		if (declared.handled) {
			rememberProducedArtifacts(declared.artifacts)
			return declared.artifacts
		}
		if (toolName === "write" || toolName === "edit") {
			const path = (args as { path?: unknown } | null | undefined)?.path
			if (typeof path !== "string") return []
			// No mtime window here: the write/edit tool authored the file itself.
			const artifact = artifactFromPath(path, cwd, {}, "write")
			if (!artifact) return []
			rememberArtifactPath(artifact.path)
			return [artifact]
		}
		if (toolName === "bash" || toolName === "powershell") {
			const context = shellCommandContext(toolName, args, cwd)
			if (context === null) return []
			const outputArtifacts = bashArtifacts(result, context?.cwd ?? cwd, opts)
			rememberProducedArtifacts(outputArtifacts)
			if (!context) return outputArtifacts
			const out = redirectArtifacts(context.segments, context.cwd, opts)
			rememberProducedArtifacts(out)
			for (const artifact of outputArtifacts) {
				if (!out.some((a) => a.path === artifact.path)) out.push(artifact)
			}
			if (opts.fileSnapshot?.cwd === context.cwd) {
				for (const artifact of changedSnapshotArtifacts(opts.fileSnapshot, opts)) {
					if (out.length >= MAX_BASH_ARTIFACTS) break
					if (!out.some((a) => a.path === artifact.path)) out.push(artifact)
				}
			}
			return out
		}
		return []
	} catch {
		return []
	}
}
