/**
 * Tool-error classification for the telemetry error funnel.
 *
 * PostHog `error` events used to carry the first 300 characters of every
 * `isError` tool result — which mixed four very different situations into one
 * metric: real infrastructure failures, intentional harness gates (plan mode,
 * todo check-in, bash guards), user declines, and ordinary bash non-zero
 * exits. This module classifies a tool error text into a taxonomy so the
 * emitters (tools.ts per-result, messages.ts run-final) can route each kind
 * to the right channel:
 *
 *  - `command_outcome` — a bash command that executed and reported its
 *    terminal status (non-zero exit / timeout / termination). Recorded by the
 *    `command_executed` execution signal, NOT an error.
 *  - `blocked` / `declined` — intentional gates and user decisions. Emitted as
 *    `tool_outcome`, never as `error`.
 *  - `model_mistake` — recognized input/target rejections (edit mismatch,
 *    missing path, invalid arguments, unknown tool). Analytical category for
 *    agent friction, NOT proof of model fault (concurrent edits or
 *    environment changes produce the same result). Emitted as `tool_outcome`.
 *  - `aborted` — user/agent aborts. No generic error/outcome emission;
 *    interruption detection (`agent.interrupted`) owns that signal.
 *  - `failure` — operational failures and everything unrecognized. Stays in
 *    the `error` funnel with a canonical message where the family is known.
 *
 * Contract for message-source owners: patterns below are matched against the
 * EXACT strings produced by the harness and the installed pi-mono version
 * (verified producers, see the co-located fixtures). If you change a
 * model-facing gate/decline message, update the pattern here and its fixture
 * — otherwise the message silently falls back to raw emission. The fail-open
 * fallback preserves today's behavior (`slice(0, 300)`), so classification
 * can never drop or corrupt a real error.
 *
 * Privacy: recognized families return canonical, low-cardinality messages
 * plus explicitly selected bounded attributes — no paths, timestamps,
 * free-text reasons, or command bodies. The fallback may still contain raw
 * text; canonicalization guarantees apply to recognized families only.
 */

import { isFermentToolName } from "../../ferment/tool-names.js"
import { TODO_CHECKIN_BLOCK_PREFIX } from "../../todos/checkin-gate.js"
import { hashFilePath } from "../helpers.js"

/** The gate's block reason carries its prefix (shared constant) plus the
 *  pending input revision; derive the match so this classifier cannot
 *  silently drift from the gate's text contract. */
const TODO_CHECKIN_GATE_RE = new RegExp(
	`^${TODO_CHECKIN_BLOCK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)\\)\\.`,
)

export type ToolErrorKind = "failure" | "command_outcome" | "model_mistake" | "blocked" | "declined" | "aborted"

interface ToolErrorClassificationBase {
	/** Canonical, low-cardinality message for PostHog grouping. */
	message: string
	/** Selected diagnostics; string lengths capped. Cardinality may remain high
	 *  (hashes, revisions, model ids) — attributes avoid message-based grouping
	 *  splits, they are not a cardinality guarantee. */
	attrs?: Record<string, string | number>
	/** Parsed bash exit code when the message carries one. */
	exitCode?: number
}

/** The kinds routed to the `tool_outcome` event. */
export type ToolOutcomeKind = "blocked" | "declined" | "model_mistake"

export type ToolErrorClassification =
	| (ToolErrorClassificationBase & {
			kind: "command_outcome"
			/** Recognized execution result; success is handled by the execution
			 *  handler. Required for this kind — there is no such thing as a
			 *  command outcome without a concrete outcome category. */
			commandOutcome: "nonzero_exit" | "timeout" | "terminated"
	  })
	| (ToolErrorClassificationBase & {
			kind: "failure"
	  })
	| (ToolErrorClassificationBase & {
			kind: "aborted"
	  })
	| (ToolErrorClassificationBase & {
			kind: ToolOutcomeKind
	  })

/** A classification routed to the `tool_outcome` event (see ToolOutcomeKind). */
export type ToolOutcomeClassification = Extract<ToolErrorClassification, { kind: ToolOutcomeKind }>

/** Bounded length for free-form diagnostic attributes (model/tool identifiers). */
const MAX_DIAGNOSTIC_STR_LEN = 64

function cap(value: string): string {
	return value.length > MAX_DIAGNOSTIC_STR_LEN ? value.slice(0, MAX_DIAGNOSTIC_STR_LEN) : value
}

/** write + edit + their multiedit/patch siblings — the tools the
 *  plan-persona/bundled-skills gates and the edit-error family serve. */
const WRITE_EDIT_TOOLS = new Set(["write", "edit", "multiedit", "patch"])
const PATH_TOOLS = new Set(["find", "grep", "ls"])

// ---------------------------------------------------------------------------
// Bash terminal status
// ---------------------------------------------------------------------------

/**
 * Terminal-status candidate line: the last non-empty line, skipping the
 * subagent budget-clamp's annotation note. The clamp appends its note as an
 * extra text block AFTER the terminal status (subagent-bash-clamp.ts), so
 * the note — not the status — is the text's last line. Both note variants
 * are harness-owned openers (verified against budgetNote/BUDGET_EXHAUSTED_NOTE):
 * "You have reached your wall-clock time budget…" / "You are close to your
 * wall-clock time budget…".
 */
const CLAMP_NOTE_PATTERN = /^You (?:have reached|are close to) your wall-clock time budget/

function statusCandidateLine(msg: string): string {
	const lines = msg.split("\n")
	for (let i = lines.length - 1; i >= 0; i--) {
		const t = lines[i].trim()
		if (!t) continue
		if (CLAMP_NOTE_PATTERN.test(t)) continue
		return t
	}
	return ""
}

/**
 * Resolve the terminal status of a bash result by matching the FINAL status
 * line exactly (upstream pi-mono tools/bash.js). Runs before gate-like
 * prefixes so a command that prints gate-shaped text but then reports a real
 * exit code is classified by its execution result, never by its output. A
 * command can print arbitrary gate text; we never infer a block from output
 * when a real terminal status is present.
 *
 * Residual ambiguity (documented, not fixable from strings): a command whose
 * output ends with a status-shaped line (e.g. `echo "Command exited with code
 * 42"`) on a throw path where the harness appended no real status is
 * attributed that code. The last-line anchor trusts harness-appended statuses
 * in both directions — a real appended status always wins, but echoed status
 * text can fabricate an exit code. The error direction is safe: a real error
 * is never dropped, it is merely mislabeled as a command outcome.
 */
function classifyBashTerminalStatus(fullMsg: string): ToolErrorClassification | undefined {
	const last = statusCandidateLine(fullMsg)
	if (!last) return undefined
	const exit = last.match(/^Command exited with code (\d+)$/)
	if (exit) {
		const code = Number(exit[1])
		return {
			kind: "command_outcome",
			message: `Command exited with code ${code}`,
			commandOutcome: "nonzero_exit",
			exitCode: code,
			attrs: { exit_code: code },
		}
	}
	const timeout = last.match(/^Command timed out after (\d+(?:\.\d+)?) seconds$/)
	if (timeout) {
		return {
			kind: "command_outcome",
			message: "Command timed out",
			commandOutcome: "timeout",
			attrs: { timeout_seconds: Number(timeout[1]) },
		}
	}
	if (last === "Command terminated without an exit code") {
		return {
			kind: "command_outcome",
			message: "Command terminated without an exit code",
			commandOutcome: "terminated",
		}
	}
	// Harness safety limit (bash-background terminal-status.ts): the process
	// ran and was killed by the session's own safety limit — an execution
	// outcome, not an anomaly.
	if (/^Process killed by the harness safety limit \(\d+s\)$/.test(last)) {
		return {
			kind: "command_outcome",
			message: "Command killed by harness safety limit",
			commandOutcome: "terminated",
		}
	}
	if (last === "Command aborted") return { kind: "aborted", message: "Command aborted" }
	return undefined
}

/**
 * Pre-execution bash gates: harness blocks that prevented the command from
 * running. These are whole-message prefixes (the block reason IS the result
 * text), anchored at the start — command output can never collide because a
 * blocked call produced no output.
 *
 * Residual (documented, not fixable from strings): bash-hook and PreToolUse
 * hook blocks (resources/bash-hooks.ts, hook-adapters/adapter.ts) carry
 * user-configured reason text with no harness-owned prefix — they stay on
 * the raw fail-open fallback. Wrapping those reasons at the producer (e.g.
 * a `Hook blocked: ` prefix) is the follow-up if hook blocks ever matter to
 * the funnel.
 */
function classifyBashGate(fullMsg: string): ToolErrorClassification | undefined {
	// Current guard (bash-tool-guard.ts BLOCK_REASON_BASE); the matched
	// command segment is dropped from the canonical message.
	if (fullMsg.startsWith("Bash-tool guard: blocked backgrounding")) {
		return { kind: "blocked", message: "Bash guard: backgrounding" }
	}
	// Old-format guard from pre-rename builds (kept for mixed-version traffic).
	if (fullMsg.startsWith("Blocked: this Bash call contains ")) {
		return { kind: "blocked", message: "Bash guard: complex command" }
	}
	if (
		fullMsg.startsWith("Command blocked by rule: ") ||
		fullMsg.startsWith("Hard-blocked program in command: ") ||
		fullMsg.startsWith("Denied by rule ") ||
		fullMsg.startsWith("Subcommand blocked by rule: ") ||
		fullMsg === "Subcommand denied"
	) {
		return { kind: "blocked", message: "Bash command blocked by rule" }
	}
	return undefined
}

// ---------------------------------------------------------------------------
// Classifier fail-closed gate
// ---------------------------------------------------------------------------

const CLASSIFIER_PREFIX = "Classifier: "
const NO_UI_SUFFIX = " (no UI to confirm)"

/**
 * The auto-mode classifier's fail-closed rejection (permissions/index.ts):
 * `Classifier: <reason> (no UI to confirm)` — the wrapper is matched via its
 * harness-owned prefix AND suffix, so ANY reason text is covered, not just the
 * ones that start with "classifier": provider errors, timeouts, budget
 * exhaustion, invalid/unparseable output, free-text model reasons
 * (classifier.ts json.reason), and "no model available for classifier".
 *
 * The rate-limit window timestamp embedded in provider error text is dropped;
 * availability stays observable via the bounded `failure_code`. Model/tool
 * attribution is extracted only from the strict "(model=X [tool=Y])" tail —
 * ids never contain spaces, so diagnostic-laden reasons yield no attr
 * rather than a polluted one.
 *
 * Trade-off (documented): the match is prefix-only — the suffix is stripped
 * when present but not required — so a NON-bash error result that happens to
 * start with "Classifier: " is absorbed as this gate. For bash, a real
 * terminal status always wins (resolved first), and no current producer
 * collides with the prefix; accepted for the coverage it buys on free-text
 * reasons.
 */
function classifyClassifierGate(fullMsg: string): ToolErrorClassification | undefined {
	if (!fullMsg.startsWith(CLASSIFIER_PREFIX)) return undefined
	let reason = fullMsg.slice(CLASSIFIER_PREFIX.length)
	if (reason.endsWith(NO_UI_SUFFIX)) reason = reason.slice(0, -NO_UI_SUFFIX.length)

	const attrs: Record<string, string | number> = {}
	const modelTool = reason.match(/\(model=([^\s()]+)(?: tool=([^\s()]+))?\)\s*$/)
	if (modelTool) {
		if (modelTool[1]) attrs.classifier_model = cap(modelTool[1])
		if (modelTool[2]) attrs.classifier_tool = cap(modelTool[2])
	}
	// Bounded failure code from the reason's leading phrase (the structured
	// reasons carry a "classifier " head word; free-text and no-candidates
	// reasons do not — both map to "other").
	let failureCode: "rate_limited" | "timeout" | "budget_exhausted" | "other"
	const body = reason.startsWith("classifier ") ? reason.slice("classifier ".length) : reason
	if (body.startsWith("budget exhausted")) failureCode = "budget_exhausted"
	else if (body.startsWith("timeout")) failureCode = "timeout"
	else if (/rate limited/i.test(reason)) failureCode = "rate_limited"
	else failureCode = "other"
	attrs.failure_code = failureCode
	return { kind: "blocked", message: "Classifier unavailable — fail closed", attrs }
}

// ---------------------------------------------------------------------------
// Edit family (edit / multiedit / patch — upstream edit-diff.js)
// ---------------------------------------------------------------------------

function classifyEditError(fullMsg: string): ToolErrorClassification | undefined {
	let m = fullMsg.match(/^Could not find the exact text in (.+?)\. The old text must match exactly/)
	if (m) return { kind: "model_mistake", message: "Edit oldText not found", attrs: { file_hash: hashFilePath(m[1]) } }
	m = fullMsg.match(/^Could not find edits\[(\d+)\] in (.+?)\. The oldText must match exactly/)
	if (m) {
		return {
			kind: "model_mistake",
			message: "Edit oldText not found",
			attrs: { edit_index: Number(m[1]), file_hash: hashFilePath(m[2]) },
		}
	}
	m = fullMsg.match(/^Found (\d+) occurrences of (?:the text|edits\[\d+\]) in /)
	if (m) return { kind: "model_mistake", message: "Edit oldText not unique", attrs: { occurrences: Number(m[1]) } }
	m = fullMsg.match(/^No changes made to (.+?)\. The replacements? produced identical content/)
	if (m) return { kind: "model_mistake", message: "Edit produced no changes", attrs: { file_hash: hashFilePath(m[1]) } }
	m = fullMsg.match(/^Could not edit file: (.+?)\. Error code: (\w+)\.$/)
	if (m) {
		// Upstream edit.js wraps any errno as "Could not edit file: <path>.
		// Error code: <ERRNO>." — route the permission errnos to the shared
		// fs family canonical; anything else falls through to fail-open.
		if (m[2] === "ENOENT")
			return { kind: "model_mistake", message: "Edit target missing", attrs: { file_hash: hashFilePath(m[1]) } }
		if (m[2] === "EACCES" || m[2] === "EPERM" || m[2] === "EROFS")
			return {
				kind: "model_mistake",
				message: "Filesystem permission denied",
				attrs: { file_hash: hashFilePath(m[1]) },
			}
	}
	// Upstream edit-diff.js: overlapping edits are rejected wholesale.
	m = fullMsg.match(
		/^edits\[(\d+)\] and edits\[(\d+)\] overlap in (.+?)\. Merge them into one edit or target disjoint regions\.$/,
	)
	if (m)
		return {
			kind: "model_mistake",
			message: "Edit targets overlap",
			attrs: { first_edit_index: Number(m[1]), second_edit_index: Number(m[2]), file_hash: hashFilePath(m[3]) },
		}
	// Upstream edit.js: argument validation.
	if (fullMsg === "Edit tool input is invalid. edits must contain at least one replacement.")
		return { kind: "model_mistake", message: "Edit empty replacements" }
	return undefined
}

// ---------------------------------------------------------------------------
// Read family (read — upstream read.js + the kimchi read directory gate)
// ---------------------------------------------------------------------------

function classifyReadError(fullMsg: string): ToolErrorClassification | undefined {
	let m = fullMsg.match(/^ENOENT: no such file or directory, (?:access|open) '(.+)'$/)
	if (m) return { kind: "model_mistake", message: "Read path not found", attrs: { file_hash: hashFilePath(m[1]) } }
	// Already canonical (kimchi permissions read gate) — keep the message.
	if (fullMsg === "Path is a directory; read only accepts files. List or search the directory instead.") {
		return { kind: "model_mistake", message: fullMsg }
	}
	// Upstream read.js surfaces the raw errno when the gate is bypassed
	// (e.g. a stat/open race): same semantics as the gate above.
	if (fullMsg === "EISDIR: illegal operation on a directory, read") {
		return { kind: "model_mistake", message: "Path is a directory" }
	}
	m = fullMsg.match(/^Offset (\d+) is beyond end of file \(\d+ lines total\)$/)
	if (m) return { kind: "model_mistake", message: "Read offset beyond EOF", attrs: { offset: Number(m[1]) } }
	return undefined
}

// ---------------------------------------------------------------------------
// Path family (find / grep / ls — upstream path probing)
// ---------------------------------------------------------------------------

function classifyPathError(fullMsg: string): ToolErrorClassification | undefined {
	const m = fullMsg.match(/^(?:Path not found|Not a directory): (.+)$/)
	if (!m) return undefined
	// Distinct from the read family's canonical message — these producers
	// (find/grep/ls path probing) are not the read tool.
	return { kind: "model_mistake", message: "Path not found", attrs: { file_hash: hashFilePath(m[1]) } }
}

// ---------------------------------------------------------------------------
// Filesystem errno family (read / write / edit / find / grep / ls)
// ---------------------------------------------------------------------------

/** Node fs errno shape shared by every file-accessing tool:
 *  `EXXXX: <description>, <verb> '<path>'` with an optional second path for
 *  rename (`'a' -> 'b'`), optionally wrapped by the upstream ls tool
 *  (`Cannot read directory: …`, ls.js). The errno code selects the family;
 *  every captured path is hashed, never exported raw.
 *
 *  EACCES/EPERM/EROFS are target rejections (the model attempted a file it
 *  has no permission for — model friction); ENOENT/ENOTDIR/EISDIR are path
 *  mistakes; ETIMEDOUT is an environment failure (network filesystems) and
 *  stays in the error funnel with a canonical; any other errno is
 *  conservatively a failure with the path hashed. */
const FS_ERRNO_RE =
	/^(?:Cannot read directory: )?(E[A-Z]{2,}): [^']*? (?:open|access|write|rename|mkdir|scandir|readdir|read|stat|lstat|unlink|rmdir|readlink|copyfile) '(.+?)'(?: -> '(.+?)')?$/

function classifyFsError(fullMsg: string): ToolErrorClassification | undefined {
	// Path-less errno forms first: the common ETIMEDOUT read/write carries
	// no quoted path.
	if (/^ETIMEDOUT: connection timed out, (?:read|write)$/.test(fullMsg))
		return { kind: "failure", message: "Filesystem timeout" }
	const m = fullMsg.match(FS_ERRNO_RE)
	if (!m) return undefined
	const [, errno, path, secondPath] = m
	const attrs: Record<string, string | number> = { file_hash: hashFilePath(path) }
	if (secondPath) attrs.target_file_hash = hashFilePath(secondPath)
	if (errno === "EACCES" || errno === "EPERM" || errno === "EROFS")
		return { kind: "model_mistake", message: "Filesystem permission denied", attrs }
	if (errno === "ENOENT" || errno === "ENOTDIR" || errno === "EISDIR")
		return { kind: "model_mistake", message: "Path not found", attrs }
	if (errno === "ETIMEDOUT") return { kind: "failure", message: "Filesystem timeout", attrs }
	return { kind: "failure", message: "Filesystem error", attrs }
}

// ---------------------------------------------------------------------------
// Engine validation (any tool — pi-mono agent-session argument checking)
// ---------------------------------------------------------------------------

function classifyEngineValidationError(fullMsg: string): ToolErrorClassification | undefined {
	let m = fullMsg.match(/^Tool (.+) not found$/)
	if (m) return { kind: "model_mistake", message: "Tool not found", attrs: { tool: cap(m[1]) } }
	m = fullMsg.match(/^Validation failed for tool "(.+)":/)
	if (m)
		return { kind: "model_mistake", message: "Tool arguments failed schema validation", attrs: { tool: cap(m[1]) } }
	m = fullMsg.match(/^Invalid arguments for tool "(.+)":/)
	if (m) return { kind: "model_mistake", message: "Tool arguments unparseable JSON", attrs: { tool: cap(m[1]) } }
	return undefined
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Classify a tool error message for telemetry. Pure — no I/O, never throws.
 * Tool scoping matters: edit/read/path/ferment/ask_user families only apply
 * to the tools their producers serve; harness gates and engine validation
 * are the one cross-tool exception. Ordering is most-specific first, with
 * bash terminal status resolved before gate-like output prefixes.
 */
/** First block of every failed codemode result (upstream codemode execute.js).
 *  It is its own content block, so output truncation never touches it. */
const CODEMODE_FAILED_HEADER = "Script failed\n"

/** A failed codemode script. The `Script error:` block names the cause (script
 *  error, timeout, abort, sandbox failure) but sits after the script output and
 *  can be cut by output truncation, so the message never depends on finding it:
 *  without it the result is the generic script error. Aborts match direct-tool
 *  aborts (no error record; `agent.interrupted` owns the signal). */
function classifyCodemodeScriptFailure(msg: string): ToolErrorClassification {
	if (msg.includes("\nScript error:\nScript aborted: ")) return { kind: "aborted", message: "Codemode script aborted" }
	if (msg.includes("\nScript error:\nScript timed out: "))
		return { kind: "failure", message: "Codemode script timeout" }
	return { kind: "failure", message: "Codemode script error" }
}

export function classifyToolError(toolName: string, fullMsg: string): ToolErrorClassification {
	const msg = fullMsg ?? ""

	// Bare abort, exact match only (upstream createErrorToolResult("Operation
	// aborted")) — never a substring search inside larger output.
	if (msg.trim() === "Operation aborted") return { kind: "aborted", message: "Operation aborted" }

	// Codemode script result: checked before every content-based family,
	// because the script's own output (echoed nested-call errors included)
	// follows the header and must never decide the family or reach the
	// fail-open fallback.
	if (toolName === "codemode" && msg.startsWith(CODEMODE_FAILED_HEADER)) return classifyCodemodeScriptFailure(msg)

	if (toolName === "bash") {
		// Terminal status of the executed command wins over gate-shaped output.
		const terminal = classifyBashTerminalStatus(msg)
		if (terminal) return terminal
		const gate = classifyBashGate(msg)
		if (gate) return gate
	}

	// Cross-tool harness gates.
	const todo = msg.match(TODO_CHECKIN_GATE_RE)
	if (todo) return { kind: "blocked", message: "Todo check-in gate", attrs: { revision: Number(todo[1]) } }

	if (msg.startsWith("Blocked: the session is in plan mode ") || msg.startsWith("Plan mode: ")) {
		return { kind: "blocked", message: "Plan mode gate" }
	}

	// Background-bash decision gate: while a continue/stop decision is pending,
	// EVERY work tool is gated ("Blocked <tool>: background bash process awaiting
	// …") — a harness gate on any tool, not a bash-only one.
	if (/^Blocked [a-z_]+: background bash process awaiting /.test(msg)) {
		return { kind: "blocked", message: "Background bash decision pending" }
	}

	// Headless fail-closed: no prompter surface exists (permissions handleConfirm
	// / handleCompoundConfirm).
	if (msg === "No UI to confirm permission") {
		return { kind: "blocked", message: "No UI to confirm" }
	}

	// Resource-disabled gate (resources/tool-blocker.ts) — the tool name and
	// resource id are dropped; the canonical message is the signal.
	if (/ is disabled in Kimchi resources\. Enable /.test(msg)) {
		return { kind: "blocked", message: "Resource disabled" }
	}

	const classifier = classifyClassifierGate(msg)
	if (classifier) return classifier

	// Mode-flap exhaustion is an operational failure (fail-closed loop): it
	// stays in the error funnel with a canonical message.
	if (msg === "Permission mode changed too many times during prompt") {
		return { kind: "failure", message: "Permission mode flap" }
	}

	if (isFermentToolName(toolName)) {
		if (
			/^Event "[^"]+" is not valid in state "/.test(msg) ||
			msg.startsWith("Cannot start new step — ") ||
			/^Ferment not found[.:]/.test(msg)
		) {
			return { kind: "blocked", message: "Ferment state guard" }
		}
		// Ferment argument-validation families (ferment/tools/lifecycle.ts
		// parseJsonArray + gate-validation.ts): the model passed malformed
		// or failing arguments — agent friction, not anomalies. All three
		// parseJsonArray variants plus the gate-object shape check.
		const fermentField = msg.match(
			/^Field "([a-z0-9_.]+)" (?:must be an array|was a JSON string, but it did not decode to an array|was a string, but it did not contain a valid JSON array)\./,
		)
		if (fermentField)
			return { kind: "model_mistake", message: "Ferment argument not valid JSON", attrs: { field: fermentField[1] } }
		if (msg.startsWith("Every gate object requires {id, verdict, rationale, evidence}. Fix these and retry:")) {
			return { kind: "model_mistake", message: "Ferment gate objects invalid" }
		}
		if (
			/^complete_ferment refused — agent self-flagged on \d+ ferment gate\(s\):/.test(msg) ||
			/^Call refused — agent self-flagged on \d+ gate\(s\):/.test(msg)
		) {
			return { kind: "model_mistake", message: "Ferment self-flagged" }
		}
		// The remaining self-flagged refusals share one harness-owned core —
		// `agent self-flagged on N (plan|ferment|step) gate(s):` — under five
		// different producer prefixes (lifecycle.ts scope/complete/propose,
		// steps.ts with model-authored step text before the core, and the
		// ASCII-hyphen step variant). Matching the core instead of per-shape
		// literals keeps future wording drift from leaking the free-text
		// gate lines into the raw fallback.
		if (/agent self-flagged on \d+ (?:plan |ferment |step )?gate\(s\):/.test(msg)) {
			return { kind: "model_mistake", message: "Ferment self-flagged" }
		}
	}

	// Declines — user decisions, by definition not failures.
	if (msg === "Declined by user") return { kind: "declined", message: "User declined" }
	if (msg.startsWith("The user declined this action before execution and said: ")) {
		return { kind: "declined", message: "User declined with reason" }
	}
	if (msg.startsWith("Denied by the connected client's permission policy")) {
		return { kind: "declined", message: "Client policy denied" }
	}
	if (toolName === "ask_user" && msg.startsWith("ask_user could not route the question (user_cancelled)")) {
		return { kind: "declined", message: "Question cancelled" }
	}

	// Tool-scoped families.
	if (WRITE_EDIT_TOOLS.has(toolName)) {
		// Plan persona path-scope gate (permissions/index.ts): the rejected
		// absolute path is dropped.
		if (msg.startsWith("Plan persona: ")) {
			return { kind: "blocked", message: "Plan persona gate" }
		}
		// Bundled skills directory write deny (permissions/index.ts).
		if (msg.startsWith("Blocked: ") && msg.includes(" inside the bundled skills directory")) {
			return { kind: "blocked", message: "Bundled skills directory gate" }
		}
		const edit = classifyEditError(msg)
		if (edit) return edit
	}
	if (toolName === "read") {
		const read = classifyReadError(msg)
		if (read) return read
	}
	if (PATH_TOOLS.has(toolName)) {
		// rg/fd subprocess families (the grep tool shells out to bundled rg,
		// find to fd): a bad pattern in the model's own regex is friction; a
		// bootstrap failure to download the tool is a real harness failure.
		if (/^rg: (?:regex parse error|the literal)/.test(msg)) {
			return { kind: "model_mistake", message: "Invalid regex" }
		}
		if (/^(?:ripgrep \(rg\)|rg|fd) is not available and could not be downloaded$/.test(msg)) {
			return { kind: "failure", message: "Search tool unavailable" }
		}
		// rg stderr reporting an OS-level failure on a target path the model
		// chose (unreadable, locked, special file): rg's own format, ending in
		// the errno code — distinct from the pattern-error forms above.
		const rgOs = msg.match(/^rg: (.+): .+ \(os error \d+\)$/)
		if (rgOs)
			return { kind: "model_mistake", message: "Search target error", attrs: { file_hash: hashFilePath(rgOs[1]) } }
		const path = classifyPathError(msg)
		if (path) return path
	}

	// Filesystem errno family — shared by every file-accessing tool scope.
	if (toolName === "read" || WRITE_EDIT_TOOLS.has(toolName) || PATH_TOOLS.has(toolName)) {
		const fs = classifyFsError(msg)
		if (fs) return fs
	}

	const engine = classifyEngineValidationError(msg)
	if (engine) return engine

	// Codemode options-line validation (pi-mono codemode chunk): the
	// // @options: directive must lead the script; a misplaced one is rejected.
	// Harness-owned string, tool-agnostic match (same exception class as
	// engine validation).
	if (/^The \/\/ @options: line must be the first line of the input; found one on line \d+$/.test(msg)) {
		return { kind: "model_mistake", message: "Codemode options line misplaced" }
	}

	// Fail-open fallback: today's behavior, unchanged.
	return { kind: "failure", message: msg.slice(0, 300) }
}
