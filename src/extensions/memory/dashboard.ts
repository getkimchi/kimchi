/**
 * `kimchi memory dashboard` — a loopback-only web surface over the capture
 * drain: the live queue (pending jobs, quarantine, capture lock) plus the
 * per-drain traces the capture worker records (see trace.ts), rendered as
 * drill-down pages — drain → job → window/fact → full API exchanges
 * (complete request text and complete raw response) and per-question d3
 * decision detail (state, instructions, criteria, choice, probabilities,
 * confidence).
 *
 * Server design mirrors src/cli-auth/callback-server.ts: plain node:http,
 * loopback bind, and a per-request rejection of non-loopback peers (the
 * trace files contain raw session text — the exposure class of the memory
 * store itself — so wide binds are deliberately impossible).
 *
 * The page is one self-contained HTML document (inline CSS + JS, no
 * dependencies, no build step), auto-polling the queue every 5s with a
 * pause toggle. All data rendering goes through DOM nodes (textContent)
 * — dynamic values are never interpolated into HTML.
 *
 * Pure I/O aside from node:http + fs — unit-testable under Node via a
 * temp memory root.
 */
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { join } from "node:path"
import { defaultMemoryDir } from "./backend.js"
import { CAPTURE_LOCK_STALE_MS } from "./config.js"
import {
	listRecallFiles,
	listTraceFiles,
	readTraceEvents,
	resolveRecallFile,
	resolveTraceFile,
	traceFileMtime,
	tracesDir,
} from "./trace.js"

export interface MemoryDashboardOptions {
	/** Fixed port; 0/undefined = ephemeral. */
	port?: number
	/** Open the browser at startup (default true). */
	openBrowser?: boolean
	/** Injectable for tests — replaces the default memory root. */
	memoryRoot?: string
}

export interface MemoryDashboard {
	port: number
	url: string
	close: () => void
}

/** Loopback peer check (callback-server pattern): 127.*, ::1, and the
 * IPv4-mapped form a dual-stack localhost resolves to. Exported so the
 * forbidden path is unit-testable. */
export function isLoopbackRemote(remote: string): boolean {
	return remote.startsWith("127.") || remote === "::1" || remote === "::ffff:127.0.0.1"
}

// ---------------------------------------------------------------------------
// Queue snapshot
// ---------------------------------------------------------------------------

interface PendingJobSummary {
	name: string
	ageMs: number
	messages: number
	project: string | null
	session: string | null
	drainAttempts: number
	addAttempts: number
	stagedWindows: number
	unparseable: boolean
}

interface QueueSnapshot {
	pendingDir: string
	pending: PendingJobSummary[]
	quarantined: string[]
	lock: { state: "held" | "stale" | "free"; ageMs: number | null }
	lastDrain: { name: string; mtimeMs: number } | null
}

function readQueueSnapshot(memoryRoot: string): QueueSnapshot {
	const now = Date.now()
	const pendingDir = join(memoryRoot, "pending")
	const pending: PendingJobSummary[] = []
	if (existsSync(pendingDir)) {
		for (const name of readdirSync(pendingDir)
			.filter((n) => n.endsWith(".json"))
			.sort()) {
			const file = join(pendingDir, name)
			let mtimeMs: number
			try {
				mtimeMs = statSync(file).mtimeMs
			} catch {
				continue
			}
			const summary: PendingJobSummary = {
				name,
				ageMs: now - mtimeMs,
				messages: 0,
				project: null,
				session: null,
				drainAttempts: 0,
				addAttempts: 0,
				stagedWindows: 0,
				unparseable: false,
			}
			try {
				const job = JSON.parse(readFileSync(file, "utf-8")) as {
					messages?: unknown
					project?: { id?: unknown } | null
					session?: unknown
					drainAttempts?: unknown
					addAttempts?: unknown
					staged?: { windowHashes?: unknown }
				}
				summary.messages = Array.isArray(job.messages) ? job.messages.length : 0
				summary.project = typeof job.project?.id === "string" ? job.project.id : null
				summary.session = typeof job.session === "string" ? job.session : null
				summary.drainAttempts = typeof job.drainAttempts === "number" ? job.drainAttempts : 0
				summary.addAttempts = typeof job.addAttempts === "number" ? job.addAttempts : 0
				summary.stagedWindows = Array.isArray(job.staged?.windowHashes) ? job.staged.windowHashes.length : 0
			} catch {
				summary.unparseable = true
			}
			pending.push(summary)
		}
	}
	const failedDir = join(memoryRoot, "failed")
	const quarantined = existsSync(failedDir)
		? readdirSync(failedDir)
				.filter((n) => n.endsWith(".json"))
				.sort()
		: []
	// proper-lockfile holds `<lockfile>.lock/` while held; its mtime is
	// refreshed by the holder (CAPTURE_LOCK_UPDATE_MS) and goes stale when
	// the holder crashed.
	try {
		const lockDir = `${join(memoryRoot, "capture.lock")}.lock`
		const mtimeMs = statSync(lockDir).mtimeMs
		const ageMs = now - mtimeMs
		return {
			pendingDir,
			pending,
			quarantined,
			lock: { state: ageMs > CAPTURE_LOCK_STALE_MS ? "stale" : "held", ageMs },
			lastDrain: lastDrainFile(memoryRoot),
		}
	} catch {
		return {
			pendingDir,
			pending,
			quarantined,
			lock: { state: "free", ageMs: null },
			lastDrain: lastDrainFile(memoryRoot),
		}
	}
}

function lastDrainFile(memoryRoot: string): { name: string; mtimeMs: number } | null {
	const files = listTraceFiles(memoryRoot)
	const last = files[files.length - 1]
	if (!last) return null
	return { name: last, mtimeMs: traceFileMtime(join(tracesDir(memoryRoot), last)) }
}

// ---------------------------------------------------------------------------
// Trace summaries
// ---------------------------------------------------------------------------

interface DrainSummary {
	name: string
	mtimeMs: number
	jobs: number
	windows: number
	added: number
	skipped: number
	apiCalls: number
	errors: number
	durationMs: number | null
	finished: boolean
}

function summarizeDrain(memoryRoot: string, name: string): DrainSummary {
	const file = join(tracesDir(memoryRoot), name)
	const events = readTraceEvents(file)
	let jobs = 0
	let windows = 0
	let apiCalls = 0
	let errors = 0
	let captured: number | null = null
	let triagedOut = 0
	let skipped = 0
	let durationMs: number | null = null
	let finished = false
	for (const event of events) {
		if (event.type === "job") {
			jobs += 1
			windows += typeof event.windows === "number" ? event.windows : 0
		} else if (event.type === "api") {
			apiCalls += 1
			if (typeof event.error === "string") errors += 1
		} else if (event.type === "drain_end") {
			finished = true
			captured = typeof event.captured === "number" ? event.captured : 0
			triagedOut = typeof event.triagedOut === "number" ? event.triagedOut : 0
			durationMs = typeof event.durationMs === "number" ? event.durationMs : null
			for (const key of ["skippedNonDurable", "skippedByValuation", "skippedOversized"]) {
				const value = event[key]
				if (typeof value === "number") skipped += value
			}
		}
	}
	return {
		name,
		mtimeMs: traceFileMtime(file),
		jobs,
		windows,
		added: captured ?? 0,
		skipped: skipped + triagedOut,
		apiCalls,
		errors,
		durationMs,
		finished,
	}
}

// ---------------------------------------------------------------------------
// Recall summaries (retrieval side)
// ---------------------------------------------------------------------------

interface RecallSummary {
	name: string
	mtimeMs: number
	kind: string | null
	queryPreview: string
	hits: number
	injected: number
	gateSkip: boolean
	durationMs: number | null
	error: string | null
}

function summarizeRecall(memoryRoot: string, name: string): RecallSummary {
	const file = join(tracesDir(memoryRoot), name)
	const events = readTraceEvents(file)
	let kind: string | null = null
	let queryPreview = ""
	let hits = 0
	let injected = 0
	let gateSkip = false
	let durationMs: number | null = null
	let error: string | null = null
	for (const event of events) {
		if (event.type !== "recall") continue
		if (typeof event.kind === "string") kind = event.kind
		if (typeof event.query === "string") queryPreview = event.query.slice(0, 80)
		if (Array.isArray(event.hits)) hits = event.hits.length
		if (Array.isArray(event.injected)) injected = event.injected.length
		const gate = event.gate as { lookup?: string } | undefined
		if (gate?.lookup === "skip") gateSkip = true
		if (typeof event.durationMs === "number") durationMs = event.durationMs
		if (typeof event.error === "string") error = event.error
	}
	return { name, mtimeMs: traceFileMtime(file), kind, queryPreview, hits, injected, gateSkip, durationMs, error }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
	response.end(JSON.stringify(body))
}

export function startMemoryDashboard(options: MemoryDashboardOptions = {}): Promise<MemoryDashboard> {
	const memoryRoot = options.memoryRoot ?? defaultMemoryDir()
	return new Promise<MemoryDashboard>((resolveStart, rejectStart) => {
		const server = createServer((request, response) => {
			try {
				if (!isLoopbackRemote(request.socket.remoteAddress ?? "")) {
					sendJson(response, 403, { error: "Only localhost connections are allowed." })
					return
				}
				const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
				if (url.pathname === "/") {
					response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
					response.end(DASHBOARD_HTML)
					return
				}
				if (url.pathname === "/api/queue") {
					sendJson(response, 200, readQueueSnapshot(memoryRoot))
					return
				}
				if (url.pathname === "/api/traces") {
					const drains = listTraceFiles(memoryRoot)
						.reverse() // newest first
						.map((name) => summarizeDrain(memoryRoot, name))
					sendJson(response, 200, drains)
					return
				}
				if (url.pathname === "/api/trace") {
					const name = url.searchParams.get("name") ?? ""
					const file = resolveTraceFile(name, memoryRoot)
					if (!file) {
						sendJson(response, 400, { error: "not a trace file" })
						return
					}
					sendJson(response, 200, { name, events: readTraceEvents(file) })
					return
				}
				if (url.pathname === "/api/recalls") {
					const recalls = listRecallFiles(memoryRoot)
						.reverse() // newest first
						.map((name) => summarizeRecall(memoryRoot, name))
					sendJson(response, 200, recalls)
					return
				}
				if (url.pathname === "/api/recall") {
					const name = url.searchParams.get("name") ?? ""
					const file = resolveRecallFile(name, memoryRoot)
					if (!file) {
						sendJson(response, 400, { error: "not a recall file" })
						return
					}
					sendJson(response, 200, { name, events: readTraceEvents(file) })
					return
				}
				sendJson(response, 404, { error: "not found" })
			} catch (err) {
				sendJson(response, 500, { error: err instanceof Error ? err.message : String(err) })
			}
		})
		server.on("error", rejectStart)
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			const address = server.address()
			const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0)
			const url = `http://127.0.0.1:${port}/`
			if (options.openBrowser !== false) openInBrowser(url)
			resolveStart({
				port,
				url,
				close: () => {
					server.close()
				},
			})
		})
	})
}

/** Best-effort browser open — the URL is also printed, so a failure is
 * cosmetic (headless shells just don't get a tab). Never throws. */
function openInBrowser(url: string): void {
	try {
		const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
		const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
		const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
		child.on("error", () => {
			// No launcher available (minimal Linux) — the printed URL is enough.
		})
		child.unref()
	} catch {
		// Spawn itself failed — printed URL is enough.
	}
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kimchi Memory Dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 16px; font-size: 13px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #8b949e; margin: 24px 0 8px; }
  a, .link { color: #58a6ff; cursor: pointer; text-decoration: none; }
  a:hover, .link:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid #21262d; white-space: nowrap; }
  th { color: #8b949e; font-weight: normal; }
  .muted { color: #8b949e; }
  .ok { color: #3fb950; }
  .bad { color: #f85149; }
  .warn { color: #d29922; }
  .section { border: 1px solid #21262d; border-radius: 6px; padding: 12px 16px; margin-bottom: 8px; }
  .window { margin: 10px 0; padding-left: 10px; border-left: 2px solid #30363d; }
  .ev { margin: 4px 0 4px 8px; }
  details { margin-left: 16px; }
  summary { cursor: pointer; color: #58a6ff; }
  pre { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-width: 100%; }
  .bar { display: inline-block; height: 8px; background: #58a6ff; border-radius: 3px; vertical-align: middle; margin-right: 6px; }
  .q { margin: 6px 0 6px 12px; }
  .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
  button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 3px 10px; font: inherit; cursor: pointer; }
</style>
</head>
<body>
<h1>Kimchi Memory Dashboard</h1>
<div class="toolbar">
  <span class="muted" id="status">loading…</span>
  <button id="poll-toggle">pause auto-refresh</button>
</div>

<h2>Queue</h2>
<div class="section" id="queue"></div>

<h2>Drains</h2>
<div class="section" id="drains"></div>

<h2>Recalls (retrieval)</h2>
<div class="section" id="recalls"></div>

<div id="detail"></div>

<script>
"use strict";
const state = { paused: false, open: null, openTrace: null };

document.getElementById("poll-toggle").onclick = () => {
  state.paused = !state.paused;
  document.getElementById("poll-toggle").textContent = state.paused ? "resume auto-refresh" : "pause auto-refresh";
};

function el(tag, parent, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (parent) parent.appendChild(node);
  return node;
}

function fmtAge(ms) {
  if (ms === null || ms === undefined) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h";
  return Math.floor(h / 24) + "d";
}

function fmtP(p) {
  return typeof p === "number" ? p.toFixed(2) : "—";
}

async function get(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(path + " → HTTP " + r.status);
  return r.json();
}

async function renderQueue() {
  try {
    const q = await get("/api/queue");
    const root = document.getElementById("queue");
    root.textContent = "";
    const lockCls = q.lock.state === "held" ? "ok" : q.lock.state === "stale" ? "warn" : "muted";
    const line = el("div", root);
    el("span", line, lockCls, "Lock: " + q.lock.state + (q.lock.ageMs !== null ? " (" + fmtAge(q.lock.ageMs) + ")" : ""));
    el("span", line, "muted", "   Pending: " + q.pending.length + "  Quarantined: " + q.quarantined.length);
    if (q.pending.length) {
      const t = el("table", root);
      const head = el("tr", t);
      for (const h of ["job", "age", "scope", "msgs", "staged", "attempts"]) el("th", head, "", h);
      for (const j of q.pending) {
        const tr = el("tr", t);
        el("td", tr, j.unparseable ? "bad" : "", j.name + (j.unparseable ? " (unparseable)" : ""));
        el("td", tr, "", fmtAge(j.ageMs));
        el("td", tr, "", j.project || "personal");
        el("td", tr, "", j.messages);
        el("td", tr, "", j.stagedWindows ? j.stagedWindows + " win" : "—");
        el("td", tr, "", j.drainAttempts + j.addAttempts || "—");
      }
    }
    if (q.quarantined.length) {
      el("div", root, "warn", "Failed/ (quarantined): " + q.quarantined.join(", "));
    }
  } catch (e) {
    document.getElementById("queue").textContent = "queue unavailable: " + e.message;
  }
}

async function renderDrains() {
  try {
    const drains = await get("/api/traces");
    const root = document.getElementById("drains");
    root.textContent = "";
    if (!drains.length) {
      el("div", root, "muted", "no drains traced yet");
      return;
    }
    const t = el("table", root);
    const head = el("tr", t);
    for (const h of ["drain", "jobs", "windows", "added", "skipped", "api", "errors", "dur"]) el("th", head, "", h);
    for (const d of drains) {
      const tr = el("tr", t);
      const td = el("td", tr);
      const link = el("span", td, "link", d.name.replace("drain-", "").replace(".jsonl", ""));
      link.onclick = () => openDrain(d.name);
      el("td", tr, "", d.jobs);
      el("td", tr, "", d.windows);
      el("td", tr, "ok", d.added);
      el("td", tr, "", d.skipped);
      el("td", tr, "", d.apiCalls);
      el("td", tr, d.errors ? "bad" : "", d.errors || "");
      el("td", tr, "muted", d.finished ? Math.round((d.durationMs || 0) / 1000) + "s" : "…");
    }
  } catch (e) {
    document.getElementById("drains").textContent = "drains unavailable: " + e.message;
  }
}

function phaseMark(phase) {
  const skip = phase.includes("skip") || phase.includes("discard") || phase === "redaction";
  return skip ? "✗ " : "✓ ";
}

function renderApiEvent(ev, parent) {
  const req = ev.request || {};
  const res = ev.response;
  const isDecision = ev.kind === "triage" || ev.kind === "valuation" || ev.kind === "supersede-d3";
  const d = el("details", parent);
  const summary = isDecision ? "d3 call — " + ev.kind + " · " + Object.keys(req.questions || {}).length + " question(s)" : "API call — " + ev.kind + " · " + (req.model || "?") + (ev.status ? " · HTTP " + ev.status : ev.error ? " · failed" : "");
  el("summary", d, "", summary);
  if (ev.error) el("pre", d, "bad", "error: " + ev.error + (ev.status !== undefined ? " (HTTP " + ev.status + ")" : ""));
  if (isDecision) {
    el("div", d, "muted", "state:");
    el("pre", d, "", req.state || "(empty)");
    const questions = req.questions || {};
    const answers = (res && res.answers) || {};
    for (const [name, q] of Object.entries(questions)) {
      const qDiv = el("div", d, "q");
      el("div", qDiv, "", "question " + name);
      el("div", qDiv, "muted", q.instructions || "");
      const crit = el("div", qDiv, "muted", "criteria: " + Object.keys(q.criteria || {}).join(" / "));
      crit.style.fontSize = "12px";
      const a = answers[name];
      if (a) {
        const probs = Object.entries(a.probabilities || {});
        for (const [opt, p] of probs) {
          const row = el("div", qDiv);
          row.style.marginLeft = "12px";
          const bar = el("span", row, "bar");
          bar.style.width = Math.round(p * 60) + "px";
          el("span", row, opt === a.choice ? "ok" : "muted", opt + "  p=" + fmtP(p));
        }
        el("div", qDiv, "", "→ " + a.choice + " (confidence " + fmtP(a.confidence) + ")");
      } else {
        el("div", qDiv, "bad", "→ no answer");
      }
    }
    if (res) el("div", d, "muted", "id: " + (res.id || "?") + " · usage: " + JSON.stringify(res.usage || {}));
  } else {
    if (req.system !== undefined) {
      const ds = el("details", d);
      el("summary", ds, "", "Request — system prompt");
      el("pre", ds, "", req.system);
    }
    if (req.user !== undefined) {
      const du = el("details", d);
      el("summary", du, "", "Request — user text (window transcript)");
      el("pre", du, "", req.user);
    }
    if (res) {
      const dr = el("details", d);
      el("summary", dr, "", "Response (raw)" + (res.usage ? " — " + JSON.stringify(res.usage) : ""));
      el("pre", dr, "", res.content !== undefined ? res.content : JSON.stringify(res, null, 2));
    }
  }
}

function renderPhaseEvent(ev, parent) {
  const line = el("div", parent, "ev");
  const mark = el("span", line, phaseMark(ev.phase) === "✗ " ? "bad" : "ok", phaseMark(ev.phase) + ev.phase);
  mark.style.display = "inline-block";
  mark.style.minWidth = "140px";
  const details = {
    "triage-skip": "p(durable)=" + fmtP(ev.probability) + (ev.topClass ? " · closest class: " + ev.topClass : ""),
    "valuation-discard": (ev.fact || "").slice(0, 80) + " — p(discard)=" + fmtP(ev.probability),
    "durability-skip": (ev.fact || "").slice(0, 80) + " — pattern: " + ev.pattern,
    "oversized-skip": (ev.fact || "").slice(0, 80) + " — " + ev.length + " chars",
    "exact-dup-skip": (ev.fact || "").slice(0, 80),
    "near-dup-skip": (ev.fact || "").slice(0, 60) + " — score " + fmtP(ev.score) + " twin: " + (ev.twin || "").slice(0, 60),
    "redaction": (ev.before || "").slice(0, 60) + " → " + (ev.after || "").slice(0, 60),
    "store-add": (ev.fact || "").slice(0, 80) + " → " + (ev.store || "") + (ev.id ? " (" + ev.id + ")" : ""),
    "strict-json-retry": ev.kind || "",
    "supersede-search": "query: " + (ev.query || "").slice(0, 60) + " — " + (Array.isArray(ev.hits) ? ev.hits.length : 0) + " hit(s)",
    "supersede-delete": (ev.id || "") + " — " + (ev.deleted || "").slice(0, 80),
  };
  el("span", line, "muted", details[ev.phase] !== undefined ? details[ev.phase] : JSON.stringify(ev));
}

async function openDrain(name) {
  const detail = document.getElementById("detail");
  detail.textContent = "";
  let data;
  try {
    data = await get("/api/trace?name=" + encodeURIComponent(name));
  } catch (e) {
    detail.textContent = "drain unreadable: " + e.message;
    return;
  }
  el("h2", detail, "", "Drain " + name);
  const events = data.events || [];
  if (!events.length) {
    el("div", detail, "muted", "no parseable events (empty or crashed before the first append)");
    return;
  }
  const jobs = events.filter((e) => e.type === "job");
  const other = (s) => events.filter(s);
  for (const job of jobs) {
    const sec = el("div", detail, "section");
    el("h2", sec, "", "Job " + job.job + (job.project ? " (" + job.project + ")" : " (personal)"));
    el("div", sec, "muted", job.messages + " messages · " + job.windows + " window(s) · staged: " + job.stagedWindows + " · attempts: drain " + job.drainAttempts + " / add " + job.addAttempts);
    const jobEvents = events.filter((e) => e.job === job.job);
    const windowCount = job.windows || 0;
    for (let w = 0; w < windowCount; w++) {
      const wDiv = el("div", sec, "window");
      el("div", wDiv, "", "Window " + (w + 1) + "/" + windowCount);
      const wEvents = jobEvents.filter((e) => e.window === w);
      for (const ev of wEvents) {
        if (ev.type === "api") renderApiEvent(ev, wDiv);
        else if (ev.type === "phase") renderPhaseEvent(ev, wDiv);
      }
      if (!wEvents.length) el("div", wDiv, "muted", "(no events — staged or not reached)");
    }
    const spanless = jobEvents.filter((e) => e.window === undefined);
    for (const ev of spanless) {
      if (ev.type === "api") renderApiEvent(ev, sec);
      else if (ev.type === "phase") renderPhaseEvent(ev, sec);
    }
    const end = events.find((e) => e.type === "job_end" && e.job === job.job);
    if (end) {
      const cls = end.outcome === "committed" ? "ok" : end.outcome === "quarantined" ? "bad" : "warn";
      el("div", sec, cls, "→ " + end.outcome + (end.reason ? " (" + end.reason + ")" : "") + (end.captured !== undefined ? " — " + end.captured + " fact(s) added" : ""));
    }
  }
  const unscoped = other((e) => e.type === "api" && e.job === undefined).concat(other((e) => e.type === "phase" && e.job === undefined));
  if (unscoped.length) {
    const sec = el("div", detail, "section");
    el("h2", sec, "", "Drain-level (supersede)" );
    for (const ev of unscoped) {
      if (ev.type === "api") renderApiEvent(ev, sec);
      else renderPhaseEvent(ev, sec);
    }
  }
  const endAll = events.filter((e) => e.type === "drain_end");
  if (endAll.length && endAll[0]) {
    const e = endAll[0];
    el("div", detail, "muted", "drain_end: " + e.captured + " captured, " + e.failed + " failed, " + (e.durationMs || 0) + "ms");
  }
  detail.scrollIntoView({ behavior: "smooth" });
}

async function renderRecalls() {
  try {
    const recalls = await get("/api/recalls");
    const root = document.getElementById("recalls");
    root.textContent = "";
    if (!recalls.length) {
      el("div", root, "muted", "no recalls traced yet");
      return;
    }
    const t = el("table", root);
    const head = el("tr", t);
    for (const h of ["recall", "kind", "hits", "injected", "gate", "ms", "error", "query"]) el("th", head, "", h);
    for (const r of recalls) {
      const tr = el("tr", t);
      const td = el("td", tr);
      const link = el("span", td, "link", r.name.replace("recall-", "").replace(".jsonl", ""));
      link.onclick = () => openRecall(r.name);
      el("td", tr, "muted", r.kind || "?");
      el("td", tr, "", r.hits);
      el("td", tr, r.injected ? "ok" : "", r.injected);
      el("td", tr, r.gateSkip ? "warn" : "muted", r.gateSkip ? "skip" : "");
      el("td", tr, "muted", r.durationMs !== null ? r.durationMs : "");
      el("td", tr, r.error ? "bad" : "", r.error ? String(r.error).slice(0, 30) : "");
      el("td", tr, "muted", r.queryPreview);
    }
  } catch (e) {
    document.getElementById("recalls").textContent = "recalls unavailable: " + e.message;
  }
}

async function openRecall(name) {
  const detail = document.getElementById("detail");
  detail.textContent = "";
  let data;
  try {
    data = await get("/api/recall?name=" + encodeURIComponent(name));
  } catch (e) {
    detail.textContent = "recall unreadable: " + e.message;
    return;
  }
  el("h2", detail, "", "Recall " + name);
  const events = (data.events || []).filter((e) => e.type === "recall");
  if (!events.length) {
    el("div", detail, "muted", "no recall events in this file");
    return;
  }
  for (const ev of events) {
    const sec = el("div", detail, "section");
    el("div", sec, "", (ev.kind || "?") + " — " + (ev.hits ? ev.hits.length : 0) + " hits · " + (ev.injected ? ev.injected.length : 0) + " injected" + (ev.durationMs !== undefined ? " · " + ev.durationMs + "ms" : ""));
    if (ev.error) el("pre", sec, "bad", "error: " + ev.error);
    if (ev.query !== undefined) {
      const dq = el("details", sec);
      el("summary", dq, "", "Query (" + String(ev.query).length + " chars)");
      el("pre", dq, "", ev.query);
    }
    if (Array.isArray(ev.gate)) {
      el("div", sec, "muted", "digest selector gate answers:");
      for (const a of ev.gate) {
        const row = el("div", sec, "q");
        const p = a.choice === "inject" ? a.injectP : a.keepP;
        const bar = el("span", row, "bar");
        bar.style.width = Math.round((p || 0) * 60) + "px";
        el("span", row, a.choice === "inject" ? "ok" : "muted", a.choice + "  p=" + fmtP(p) + "  " + String(a.text || "").slice(0, 90));
      }
    } else if (ev.gate && ev.gate.lookup === "skip") {
      el("div", sec, "warn", "recall gate judged no archive value — search skipped");
    }
    if (Array.isArray(ev.hits) && ev.hits.length) {
      const dh = el("details", sec);
      const injectedSet = new Set(ev.injected || []);
      el("summary", dh, "", "Hits (" + ev.hits.length + ") — green = injected");
      for (const h of ev.hits) {
        const cls = injectedSet.has(h.text) ? "ok" : "muted";
        el("pre", dh, cls, (h.store ? "[" + h.store + "] " : "") + (typeof h.score === "number" ? "score " + h.score.toFixed(3) + " · " : "") + (h.text || ""));
      }
    }
    if (Array.isArray(ev.injected) && ev.injected.length) {
      el("div", sec, "ok", "Injected (" + ev.injected.length + "):");
      for (const f of ev.injected) el("pre", sec, "ok", f);
    }
    if (ev.composition) el("div", sec, "muted", "composition: " + JSON.stringify(ev.composition));
  }
  detail.scrollIntoView({ behavior: "smooth" });
}

async function refresh() {
  document.getElementById("status").textContent = "updated " + new Date().toLocaleTimeString();
  await renderQueue();
  await renderDrains();
  await renderRecalls();
}

refresh();
setInterval(() => {
  if (!state.paused) refresh();
}, 5000);
</script>
</body>
</html>
`
