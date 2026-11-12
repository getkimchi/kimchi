/**
 * Submit-path timing marks — diagnostics for the Enter→first-reaction gap.
 *
 * Enabled only when KIMCHI_SUBMIT_TIMING points at an ABSOLUTE file path: every
 * mark is one JSONL line `{ ...detail, t, perf, seq, event, session }` (t =
 * wall-clock epoch ms, perf = performance.now(), session = the session id
 * captured at session_start so a shared file splits per session). The path
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
// Marks carry the session id once session_start has run; until then a
// process-level id attributes the early marks (and the single-session CLI,
// where every mark belongs to the one session, exactly).
let sessionId: string = randomUUID()
// Paths whose permissions were already verified/tightened this process —
// the stat+chmod runs once per path, not per mark.
const ensuredPrivate = new Set<string>()

/** Append one timing mark; no-op unless KIMCHI_SUBMIT_TIMING is set. */
export function submitTimingMark(event: string, detail?: Record<string, unknown>): void {
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
	// (or session) must not shadow the envelope.
	const line = JSON.stringify({
		...detail,
		t: Date.now(),
		perf: performance.now(),
		seq: seq++,
		event,
		session: sessionId,
	})
	try {
		appendFileSync(path, `${line}\n`, { mode: 0o600 })
	} catch (error) {
		// Diagnostics must never break the turn — but a marks file that
		// silently never appears defeats the investigation, so say so once.
		if (!warnedWrite) {
			warnedWrite = true
			console.error(
				`[submit-timing] cannot write marks to ${path}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		return
	}
	// 0o600 — the file carries prompt prefixes; match the diagnostics
	// precedent (work-attribution) rather than umask defaults. The mode
	// applies only when the file is CREATED: a pre-existing looser file
	// (e.g. `touch`-ed 0644) would expose the prefixes, so tighten it
	// once per path. Best effort — the write already succeeded.
	if (!ensuredPrivate.has(path)) {
		ensuredPrivate.add(path)
		try {
			if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600)
		} catch {
			// Tightening failed; the marks are still being written.
		}
	}
}

export default function submitTimingExtension(pi: ExtensionAPI): void {
	let sawFirstUpdate = false

	// Stamp marks with the session id so a shared marks file (the ACP server
	// hosts concurrent sessions in one process) can be split per session.
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		sessionId = ctx.sessionManager.getSessionId()
		submitTimingMark("session.start")
	})

	pi.on("input", (event: InputEvent) =>
		submitTimingMark("submit.input", { source: event.source, prompt: event.text.slice(0, 80) }),
	)

	pi.on("before_agent_start", (event) => submitTimingMark("agent.beforeStart", { messageType: event.messageType }))

	pi.on("turn_start", () => submitTimingMark("turn.start"))

	pi.on("message_start", (event: MessageStartEvent) => {
		if (event.message.role === "assistant") {
			sawFirstUpdate = false
			submitTimingMark("message.assistantStart")
		} else {
			submitTimingMark("message.entryStart", { role: event.message.role })
		}
	})

	// Only the first update per assistant message matters — first streamed
	// token reaching the UI path.
	pi.on("message_update", (event: MessageUpdateEvent) => {
		if (sawFirstUpdate || event.message.role !== "assistant") return
		sawFirstUpdate = true
		submitTimingMark("message.firstUpdate")
	})

	pi.on("message_end", (event: MessageEndEvent) => {
		if (event.message.role === "assistant") submitTimingMark("message.assistantEnd")
	})

	pi.on("turn_end", () => submitTimingMark("turn.end"))

	pi.on("before_provider_request", () => submitTimingMark("provider.request"))

	pi.on("after_provider_response", (event: AfterProviderResponseEvent) =>
		submitTimingMark("provider.response", { status: event.status }),
	)
}
