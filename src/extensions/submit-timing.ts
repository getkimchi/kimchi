/**
 * Submit-path timing marks — diagnostics for the Enter→first-reaction gap.
 *
 * Enabled only when KIMCHI_SUBMIT_TIMING points at an ABSOLUTE file path: every
 * mark is one JSONL line `{ ...detail, t, perf, seq, event, session }` (t =
 * wall-clock epoch ms, perf = performance.now(), session = the emitting
 * session's id, so a shared file splits per session — absent on lines written
 * before this field existed, and it correlates each prompt prefix to one
 * named session, so share the file accordingly). The path
 * must be absolute so marks can
 * never land inside the checked-out project (a relative value is ignored with
 * one error line). The file is created 0o600 and carries the first 80 chars
 * of each user prompt, so treat the location accordingly. Without the env var
 * (or with an invalid one) every mark is a no-op, so the extension is safe to
 * register unconditionally.
 *
 * The marks cover the submit path end to end: `submit.input` (Enter),
 * `agent.beforeStart` (pre-request hooks, where memory recall runs),
 * `provider.request` / `provider.response`, and the first streamed token
 * (`message.firstUpdate`). The memory recall legs (digest / gate / search)
 * are marked from src/extensions/memory/index.ts via the same helper.
 */

import { randomUUID } from "node:crypto"
import { appendFileSync, chmodSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import type {
	AfterProviderResponseEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent"

let seq = 0
let warned = false
// A write failure must not warn per mark — once is enough to be heard.
let warnedWrite = false
// The same goes for a tightening failure, which otherwise leaves prompt
// prefixes in a world-readable file with zero signal.
let warnedPerms = false
// Fallback attribution for callers that cannot pass their own session id;
// the extension instances stamp their marks per session (see below), so
// this only covers marks emitted before any session_start in the process.
let sessionId: string = randomUUID()
// Paths whose permissions were already verified/tightened this process —
// the stat+chmod runs once per path, not per mark.
const ensuredPrivate = new Set<string>()

/** Append one timing mark; no-op unless KIMCHI_SUBMIT_TIMING is set. */
export function submitTimingMark(event: string, detail?: Record<string, unknown>, session?: string): void {
	const path = process.env.KIMCHI_SUBMIT_TIMING
	if (!path) return
	// Absolute only — a relative value would write into the checked-out
	// project, one accidental commit away from publishing prompt fragments.
	// Refuse it loudly once.
	if (!isAbsolute(path)) {
		if (!warned) {
			warned = true
			console.error(`[submit-timing] KIMCHI_SUBMIT_TIMING must be an absolute path, ignoring: ${path}`)
		}
		return
	}
	// Reserved keys AFTER the spread — a detail key named t/perf/seq/event
	// (or session) must not shadow the envelope. An explicit session wins
	// (per-instance capture); the module fallback only covers pre-session
	// marks.
	const line = JSON.stringify({
		...detail,
		t: Date.now(),
		perf: performance.now(),
		seq: seq++,
		event,
		session: session ?? sessionId,
	})
	try {
		appendFileSync(path, `${line}\n`, { mode: 0o600 })
	} catch (error) {
		// Diagnostics must never break the turn — but a marks file that
		// silently never appears defeats the investigation, so say so once.
		if (!warnedWrite) {
			warnedWrite = true
			console.error(
				`[submit-timing] cannot write marks to ${path} (a partial record may remain): ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		return
	}
	// 0o600 — the file carries prompt prefixes; match the diagnostics
	// precedent (work-attribution) rather than umask defaults. The mode
	// applies only when the file is CREATED: a pre-existing looser file
	// (e.g. `touch`-ed 0644) would expose the prefixes, so tighten it once
	// per path. A failure retries on later marks (a transient swap can
	// heal) and warns once — a silently loose file is the one failure here
	// that quietly keeps the prefixes exposed.
	if (!ensuredPrivate.has(path)) {
		try {
			if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600)
			ensuredPrivate.add(path)
		} catch (error) {
			if (!warnedPerms) {
				warnedPerms = true
				console.error(
					`[submit-timing] cannot tighten ${path} to 0o600 — marks (prompt prefixes) remain readable by others: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}
}

export default function submitTimingExtension(pi: ExtensionAPI): void {
	let sawFirstUpdate = false
	// This instance's session id — per instance, NOT module state: the ACP
	// server hosts concurrent sessions in one process, and a shared marks
	// file only splits per session if each instance stamps its own id (the
	// module-level fallback cannot tell sessions apart).
	let instanceSession: string | undefined
	const mark = (event: string, detail?: Record<string, unknown>) => submitTimingMark(event, detail, instanceSession)

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		instanceSession = ctx.sessionManager.getSessionId()
		sessionId = instanceSession
		mark("session.start")
	})

	pi.on("input", (event: InputEvent) => mark("submit.input", { source: event.source, prompt: event.text.slice(0, 80) }))

	pi.on("before_agent_start", (event) => mark("agent.beforeStart", { messageType: event.messageType }))

	pi.on("turn_start", () => mark("turn.start"))

	pi.on("message_start", (event: MessageStartEvent) => {
		if (event.message.role === "assistant") {
			sawFirstUpdate = false
			mark("message.assistantStart")
		} else {
			mark("message.entryStart", { role: event.message.role })
		}
	})

	// Only the first update per assistant message matters — first streamed
	// token reaching the UI path.
	pi.on("message_update", (event: MessageUpdateEvent) => {
		if (sawFirstUpdate || event.message.role !== "assistant") return
		sawFirstUpdate = true
		mark("message.firstUpdate")
	})

	pi.on("message_end", (event: MessageEndEvent) => {
		if (event.message.role === "assistant") mark("message.assistantEnd")
	})

	pi.on("turn_end", () => mark("turn.end"))

	pi.on("before_provider_request", () => mark("provider.request"))

	pi.on("after_provider_response", (event: AfterProviderResponseEvent) =>
		mark("provider.response", { status: event.status }),
	)
}
