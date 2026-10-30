/**
 * Side loop (experimental): watches the main session, works out which stage it
 * is in (exploring → implementing → verifying → shipping → reviewing →
 * deploying) and keeps live cards for what matters at that stage in a
 * top-right dock. Nothing to turn on or off: cards appear, evolve, park and
 * retire with the session; the pane opens itself when something needs you and
 * closes when it is resolved. Detection runs on every surface; drawing is
 * TUI-only for now. See docs/side-loop.md.
 */
import { execFile } from "node:child_process"
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui"
import type { DecisionGateOptions } from "../memory/decision-gate.js"
import { type CardSeed, cardFor, changesCard, contextCard } from "./cards.js"
import { admit, decisionGateFromConfig } from "./decide.js"
import { pollIntervalMs, readPullRequest } from "./pr-watch.js"
import { renderDock, renderPane, type StageView } from "./render.js"
import { detectSignals, type Signal } from "./signals.js"
import { ActivityLog, classifyStage, describeActivity, placement, ruleStage } from "./stage.js"
import { createStats, formatStats, type SideLoopStats } from "./stats.js"
import { readSurfaceMessage, resolve, SIDE_SURFACE_CHANNEL, type SideSurface, SurfaceStore } from "./surface.js"

const FLASH_MS = 4000
const DOCK_WIDTH = 54
/** Finished cards (merged PR, live deploy) leave after this many prompts. */
const RETIRE_PROMPTS = 3
const CONTEXT_WARN_PERCENT = 60
const PARKED_POLL_FACTOR = 4

interface Poller {
	timer: ReturnType<typeof setInterval>
	controller: AbortController
}

function git(args: string[], cwd: string): Promise<string> {
	return new Promise((done) => {
		execFile("git", args, { cwd, timeout: 3000 }, (error, stdout) => done(error ? "" : stdout))
	})
}

export default function sideLoopExtension(pi: ExtensionAPI): void {
	const store = new SurfaceStore()
	const activity = new ActivityLog()
	let stats: SideLoopStats = createStats()
	let gate: DecisionGateOptions | undefined | null = null
	let prompt = ""
	let prompts = 0
	let stage: StageView = { stage: "exploring", source: "rule" }
	let tui: TUI | undefined
	let dock: OverlayHandle | undefined
	let pane: OverlayHandle | undefined
	/** `/side` overrides; "auto" lets the side loop open and close the pane. */
	let paneMode: "auto" | "open" | "closed" = "auto"
	let flashUntil = 0
	const starts = new Map<string, { args: unknown; startedAt: number }>()
	const pollers = new Map<string, Poller>()

	const decisionGate = () => {
		if (gate === null) gate = decisionGateFromConfig()
		return gate
	}

	const tone = (s: SideSurface) => resolve(s.tone, s.data)
	const docked = () => store.list().filter((s) => placement(s, stage.stage, prompts, tone(s)) === "dock")
	const parked = () => store.list().filter((s) => placement(s, stage.stage, prompts, tone(s)) === "parked")
	/** Pane and `/side open <n>` share this numbering. */
	const ordered = () => [...docked(), ...parked()]
	const needsYou = () => store.list().some((s) => tone(s) === "error")
	const paneVisible = () => paneMode === "open" || (paneMode === "auto" && needsYou())

	const timed = (draw: () => string[]) => {
		const started = performance.now()
		const lines = draw()
		stats.renders.count++
		stats.renders.totalMs += performance.now() - started
		return lines
	}

	function refresh(): void {
		dock?.setHidden(paneVisible() || docked().length === 0)
		pane?.setHidden(!paneVisible())
		tui?.requestRender()
	}

	function mount(ctx: ExtensionContext): void {
		if (!ctx.hasUI || dock) return
		let theme: Theme | undefined
		const overlay = (draw: (th: Theme, width: number) => string[]) => ({
			render: (width: number) => (theme ? timed(() => draw(theme as Theme, width)) : []),
			invalidate: () => {},
		})
		const capture = (t: TUI, th: Theme) => {
			tui = t
			theme = th
		}
		void ctx.ui.custom<void>(
			(t, th) => {
				capture(t, th)
				return overlay((style, width) =>
					renderDock(style, docked(), width, { flash: Date.now() < flashUntil, stage, hidden: parked().length }),
				)
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-right",
					width: DOCK_WIDTH,
					margin: { top: 1, right: 1 },
					nonCapturing: true,
					visible: (w) => w >= 90,
				},
				onHandle: (handle) => {
					dock = handle
					refresh()
				},
			},
		)
		void ctx.ui.custom<void>(
			(t, th) => {
				capture(t, th)
				return overlay((style, width) =>
					renderPane(style, docked(), parked(), width, stats, Math.max(10, t.terminal.rows - 4), stage),
				)
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-right",
					width: "45%",
					minWidth: 50,
					maxHeight: "90%",
					margin: { top: 1, right: 1 },
					nonCapturing: true,
				},
				onHandle: (handle) => {
					pane = handle
					refresh()
				},
			},
		)
	}

	function interrupt(): void {
		flashUntil = Date.now() + FLASH_MS
		// A new problem re-arms automatic opening even after the user closed the pane.
		if (paneMode === "closed") paneMode = "auto"
		setTimeout(() => tui?.requestRender(), FLASH_MS + 50)
	}

	/** Create or evolve a card; the decision layer runs on creation and on every change of tone. */
	async function upsert(seed: CardSeed, signal: Signal | undefined): Promise<void> {
		const existing = store.get(seed.id)
		if (existing) {
			const before = tone(existing)
			const runs = Number(existing.data.runs ?? 1) + 1
			store.apply({ op: "update", id: seed.id, data: { ...seed.data, runs: String(runs) } })
			stats.surfaces.updated++
			const after = resolve(seed.tone, { ...existing.data, ...seed.data })
			if (signal && before !== after && after !== "pending") await rejudge(seed.id, signal)
			return refresh()
		}
		const data = { ...seed.data, runs: "1" }
		const admission = signal ? await admit({ signal, prompt, data }, decisionGate(), stats) : undefined
		if (admission && !admission.keep) {
			stats.surfaces.dropped++
			return refresh()
		}
		store.apply({ op: "create", surface: { ...seed, data, verdict: admission?.verdict, bornAtPrompt: prompts } })
		stats.surfaces.created++
		if (admission?.verdict.attention === "interrupt") interrupt()
		refresh()
	}

	async function rejudge(id: string, signal: Signal): Promise<void> {
		const current = store.get(id)
		if (!current) return
		const { verdict } = await admit({ signal, prompt, data: current.data }, decisionGate(), stats)
		const latest = store.get(id)
		if (!latest) return
		store.apply({ op: "create", surface: { ...latest, verdict } })
		if (verdict.attention === "interrupt") interrupt()
	}

	function stopPoller(id: string): void {
		const poller = pollers.get(id)
		if (!poller) return
		clearInterval(poller.timer)
		poller.controller.abort()
		pollers.delete(id)
	}

	async function pollPullRequest(id: string, signal: Signal & { kind: "pr" }, cwd: string): Promise<void> {
		const started = performance.now()
		stats.polls.calls++
		try {
			const signalAbort = pollers.get(id)?.controller.signal ?? AbortSignal.timeout(15_000)
			const data = await readPullRequest(signal.pr, cwd, signalAbort)
			const existing = store.get(id)
			if (!existing) return
			const before = tone(existing)
			store.apply({ op: "update", id, data: { ...data, finishedAtPrompt: data.terminal ? prompts : undefined } })
			stats.surfaces.updated++
			if (before !== data.tone && data.tone !== "pending") await rejudge(id, signal)
			if (data.terminal) stopPoller(id)
		} catch {
			stats.polls.failures++
		} finally {
			stats.polls.totalMs += performance.now() - started
		}
		refresh()
	}

	async function onSignal(signal: Signal, cwd: string): Promise<void> {
		const seed = cardFor(signal, cwd)
		if (signal.kind !== "pr") {
			const finished = signal.kind === "deploy" && signal.ok ? { finishedAtPrompt: prompts } : {}
			return upsert({ ...seed, data: { ...seed.data, ...finished } }, signal)
		}
		if (store.get(seed.id)) return pollPullRequest(seed.id, signal, cwd)
		await upsert(seed, signal)
		if (!store.get(seed.id) || signal.pr.host !== "github") return
		const controller = new AbortController()
		let ticks = 0
		const timer = setInterval(() => {
			const surface = store.get(seed.id)
			// A parked PR (not relevant at this stage) is checked 4× less often; it re-docks on failure anyway.
			const parkedNow = surface && placement(surface, stage.stage, prompts, tone(surface)) === "parked"
			if (parkedNow && ++ticks % PARKED_POLL_FACTOR !== 0) return
			void pollPullRequest(seed.id, signal, cwd)
		}, pollIntervalMs())
		timer.unref?.()
		pollers.set(seed.id, { timer, controller })
		await pollPullRequest(seed.id, signal, cwd)
	}

	/** Once per prompt: re-read the stage, refresh the ambient cards, retire finished ones. */
	async function settle(ctx: ExtensionContext): Promise<void> {
		const cwd = ctx.sessionManager.getCwd()
		const prs = store.list().filter((s) => s.kind === "pr" && !s.data.terminal).length
		const [classified, porcelain, shortstat] = await Promise.all([
			classifyStage(decisionGate(), { prompt, activity: activity.recent(), prs }, stats),
			git(["status", "--porcelain"], cwd),
			git(["diff", "--shortstat", "HEAD"], cwd),
		])
		stage = classified
		const files = porcelain.split("\n").filter(Boolean).length
		if (files) await upsert(changesCard(shortstat, files), undefined)
		else store.apply({ op: "delete", id: "changes" })
		const percent = ctx.getContextUsage()?.percent
		if (typeof percent === "number" && percent >= CONTEXT_WARN_PERCENT) await upsert(contextCard(percent), undefined)
		else store.apply({ op: "delete", id: "context" })
		for (const surface of store.list()) {
			const finished = surface.data.finishedAtPrompt
			if (typeof finished === "number" && prompts - finished >= RETIRE_PROMPTS) {
				stopPoller(surface.id)
				store.apply({ op: "delete", id: surface.id })
			}
		}
		refresh()
	}

	function reset(): void {
		for (const id of [...pollers.keys()]) stopPoller(id)
		store.clear()
		activity.clear()
		starts.clear()
		stats = createStats()
		stage = { stage: "exploring", source: "rule" }
		prompts = 0
		paneMode = "auto"
	}

	pi.on("session_start", (_event, ctx) => {
		reset()
		try {
			mount(ctx)
		} catch {
			// A surface without overlays (ACP) still tracks cards; it just draws nothing.
		}
		refresh()
	})

	pi.on("session_shutdown", () => {
		reset()
		dock?.hide()
		pane?.hide()
		dock = pane = undefined
	})

	pi.on("input", (event) => {
		if (!event.text.trim() || event.text.startsWith("/")) return
		prompt = event.text
		prompts++
	})

	pi.on("tool_execution_start", (event) => {
		starts.set(event.toolCallId, { args: event.args, startedAt: Date.now() })
	})

	pi.on("tool_execution_end", (event, ctx) => {
		const start = starts.get(event.toolCallId)
		starts.delete(event.toolCallId)
		if (!start) return
		activity.push({ tool: event.toolName, detail: describeActivity(event.toolName, start.args), ok: !event.isError })
		// Rules follow the stage live during the turn; d3 re-reads it once the prompt settles.
		const prs = store.list().filter((s) => s.kind === "pr").length
		const live = ruleStage(activity.recent(), prs)
		if (live !== stage.stage) stage = { stage: live, source: "rule" }
		const cwd = ctx.sessionManager.getCwd()
		const signals = detectSignals(event.toolName, start.args, event.result, event.isError, cwd, start.startedAt)
		// Off the tool path: a slow decision or poll never delays the main loop.
		for (const signal of signals) void onSignal(signal, cwd).catch(() => {})
		refresh()
	})

	pi.on("agent_settled", (_event, ctx) => {
		void settle(ctx).catch(() => {})
	})

	pi.events.on(SIDE_SURFACE_CHANNEL, (payload: unknown) => {
		const message = readSurfaceMessage(payload)
		if (!message) return
		if (message.op === "create") {
			message.surface.bornAtPrompt ??= prompts
			stats.surfaces.created++
		} else if (message.op === "update") stats.surfaces.updated++
		store.apply(message)
		refresh()
	})

	pi.registerCommand("side", {
		description: "In-time side loop: show/hide the pane, open a card's link, clear cards, or show what it cost",
		handler: async (args, ctx) => {
			const [verb, value] = args.trim().split(/\s+/)
			if (!verb) {
				paneMode = paneVisible() ? "closed" : "open"
				return refresh()
			}
			if (verb === "auto") {
				paneMode = "auto"
				return refresh()
			}
			if (verb === "clear") {
				for (const id of [...pollers.keys()]) stopPoller(id)
				store.clear()
				return refresh()
			}
			if (verb === "stats") {
				ctx.ui.notify(["Side loop cost", ...formatStats(stats)].join("\n"), "info")
				return
			}
			if (verb === "open") {
				const surface = ordered()[Number(value) - 1]
				if (!surface?.link) return ctx.ui.notify(`No card ${value ?? ""} with a link.`, "warning")
				const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
				execFile(opener, [surface.link], () => {})
				return ctx.ui.notify(`Opening ${surface.link}`, "info")
			}
			ctx.ui.notify("Usage: /side [open <n> | auto | clear | stats]", "warning")
		},
		getArgumentCompletions: (prefix: string) =>
			["open", "auto", "clear", "stats"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
	})
}
