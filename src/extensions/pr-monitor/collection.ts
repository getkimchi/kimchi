import { createHash } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent"
import { resolvePreMainProjectTrust } from "../../project-trust.js"
import { object } from "../work-attribution/summary.js"
import { PRMonitor } from "./monitor.js"
import { parsePRTarget, preparePRCheckout } from "./targets.js"
import type { PRMonitorState, PRRepairMode } from "./types.js"

const ENTRY = "pr_watch_targets"
interface Target {
	url: string
	cwd: string
	monitor: PRMonitor
}

/** One conversation owns the targets; the existing monitor still owns each PR's lifecycle. */
export class PRWatchCollection {
	readonly local: PRMonitor
	private readonly targets = new Map<string, Target>()
	private readonly observers = new Set<(state: PRMonitorState) => void>()
	private notify: ((state: PRMonitorState) => void) | undefined
	private active: PRMonitor | undefined
	private timer: ReturnType<typeof setInterval> | undefined
	private pending: Promise<PRMonitorState> | undefined
	private additions: Promise<void> = Promise.resolve()
	private preparation = new AbortController()
	private stopped = false
	private cursor = 0
	private revision = 0
	private configuration = 0
	private errors: string[] = []

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
	) {
		this.local = this.createMonitor(ctx.cwd)
		const saved = ctx.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "custom" && entry.customType === ENTRY)
		if (saved?.type === "custom" && object(saved.data) && Array.isArray(saved.data.targets)) {
			for (const item of saved.data.targets) {
				if (!object(item) || typeof item.url !== "string" || typeof item.cwd !== "string" || !isAbsolute(item.cwd))
					continue
				try {
					const url = parsePRTarget(item.url).url
					this.targets.set(url, { url, cwd: item.cwd, monitor: this.createMonitor(item.cwd, url) })
				} catch {
					/* Invalid saved targets never grant access to another checkout. */
				}
			}
		}
		this.updateTimer()
	}

	private createMonitor(cwd: string, url?: string): PRMonitor {
		let monitor: PRMonitor
		const context: ExtensionContext = {
			...this.ctx,
			cwd,
			isIdle: () => this.ctx.isIdle() && (!this.active || this.active === monitor),
			isProjectTrusted: () => (url ? resolvePreMainProjectTrust(cwd, getAgentDir()) : this.ctx.isProjectTrusted()),
		}
		monitor = new PRMonitor(this.pi, context, {
			managed: true,
			...(url ? { url, entryType: `pr_monitor:${createHash("sha256").update(url).digest("hex")}` } : {}),
		})
		monitor.setNotify(() => {
			if (monitor.isRepairing) this.active = monitor
			else if (this.active === monitor) this.active = undefined
			this.publish()
		})
		return monitor
	}

	get snapshot(): PRMonitorState {
		if (!this.targets.size)
			return this.errors.length
				? { ...this.local.snapshot, revision: this.revision, phase: "error", message: this.errors.join("\n") }
				: { ...this.local.snapshot, revision: this.revision }
		const local = this.local.snapshot
		const watches = [
			...((local.enabled || local.pullRequest) && !this.targets.has(local.pullRequest?.url ?? "")
				? [{ cwd: this.ctx.cwd, state: local }]
				: []),
			...[...this.targets.values()].map((target) => ({ cwd: target.cwd, state: target.monitor.snapshot })),
		]
		const enabled = watches.filter(({ state }) => state.enabled)
		const selected =
			watches.find(({ state }) => state.phase === "fixing") ??
			enabled.find(({ state }) => state.phase === "error" || state.phase === "attention") ??
			enabled[0] ??
			watches[0]
		return {
			...selected.state,
			revision: this.revision,
			enabled: enabled.length > 0,
			autoFix: enabled.some(({ state }) => state.autoFix),
			...(this.errors.length
				? { message: this.errors.join("\n"), phase: this.active ? ("fixing" as const) : ("attention" as const) }
				: {}),
			watches,
		}
	}

	setNotify(notify: (state: PRMonitorState) => void): void {
		this.notify = notify
	}
	get configurationRevision(): number {
		return this.configuration
	}
	observe(listener: (state: PRMonitorState) => void): () => void {
		this.observers.add(listener)
		return () => this.observers.delete(listener)
	}
	private publish(): void {
		if (this.stopped) return
		this.revision++
		this.updateTimer()
		for (const notify of [this.notify, ...this.observers]) {
			try {
				notify?.(this.snapshot)
			} catch {
				/* A display failure must not interrupt tracking. */
			}
		}
	}
	private updateTimer(): void {
		const enabled =
			this.local.snapshot.enabled || [...this.targets.values()].some(({ monitor }) => monitor.snapshot.enabled)
		if (enabled && !this.timer) {
			this.timer = setInterval(() => {
				void this.refresh()
			}, 30_000)
			this.timer.unref()
		} else if (!enabled && this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
	}
	private persist(): void {
		this.pi.appendEntry(ENTRY, { targets: [...this.targets.values()].map(({ url, cwd }) => ({ url, cwd })) })
	}

	startTargets(
		requests: { url: string; cwd?: string }[],
		autoFix: boolean,
		instructions: string | undefined,
		mode: PRRepairMode,
		toolCtx: ExtensionToolContext,
		signal?: AbortSignal,
	): Promise<PRMonitorState> {
		if (this.stopped) throw new Error("The PR monitor session is closed.")
		this.configuration++
		const preparedSignal = signal ? AbortSignal.any([signal, this.preparation.signal]) : this.preparation.signal
		const started = this.additions.then(() =>
			this.addTargets(requests, autoFix, instructions, mode, toolCtx, preparedSignal),
		)
		this.additions = started.then(
			() => {},
			() => {},
		)
		return started
	}

	private async addTargets(
		requests: { url: string; cwd?: string }[],
		autoFix: boolean,
		instructions: string | undefined,
		mode: PRRepairMode,
		toolCtx: ExtensionToolContext,
		preparedSignal: AbortSignal,
	): Promise<PRMonitorState> {
		this.errors = []
		const touched = new Set<PRMonitor>()
		const unique = new Map(requests.map((request) => [request.url, request]))
		for (const request of unique.values()) {
			try {
				preparedSignal.throwIfAborted()
				const url = parsePRTarget(request.url).url
				const existing = this.targets.get(url)
				if (existing) {
					touched.add(existing.monitor)
					await existing.monitor.configure(true, autoFix, instructions, url, mode)
					continue
				}
				const local = await this.local.refresh()
				if ((!request.cwd || resolve(this.ctx.cwd, request.cwd) === this.ctx.cwd) && local.pullRequest?.url === url) {
					touched.add(this.local)
					await this.local.configure(true, autoFix, instructions, url, mode)
					continue
				}
				const cwd = await preparePRCheckout(toolCtx, url, preparedSignal, request.cwd, autoFix)
				preparedSignal.throwIfAborted()
				const monitor = this.createMonitor(cwd, url)
				touched.add(monitor)
				this.targets.set(url, { url, cwd, monitor })
				this.persist()
				if (this.local.snapshot.pullRequest?.url === url && this.local.snapshot.enabled)
					await this.local.configure(false, false)
				await monitor.configure(true, autoFix, instructions, url, mode)
			} catch (error) {
				if (preparedSignal.aborted) {
					for (const monitor of touched) await monitor.configure(false, false)
					preparedSignal.throwIfAborted()
				}
				this.errors.push(`${request.url}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		this.publish()
		return this.snapshot
	}

	async configure(
		enabled: boolean,
		autoFix: boolean,
		instructions?: string,
		url?: string,
		mode?: PRRepairMode,
	): Promise<PRMonitorState> {
		if (this.stopped) throw new Error("The PR monitor session is closed.")
		this.configuration++
		if (!enabled && !url) {
			this.preparation.abort()
			this.preparation = new AbortController()
		}
		this.errors = []
		if (url) {
			const target = this.targets.get(parsePRTarget(url).url)
			await (target?.monitor ?? this.local).configure(enabled, autoFix, instructions, url, mode)
		} else if (this.targets.size) {
			const monitors = [...this.targets.values()].map(({ monitor }) => monitor)
			if (this.local.snapshot.enabled || this.local.snapshot.pullRequest) monitors.unshift(this.local)
			const pause = enabled && !autoFix && monitors.some((monitor) => monitor.snapshot.enabled)
			for (const monitor of monitors) {
				if (pause && !monitor.snapshot.enabled) continue
				await monitor.configure(enabled, autoFix, instructions, undefined, mode)
			}
		} else await this.local.configure(enabled, autoFix, instructions, undefined, mode)
		this.publish()
		return this.snapshot
	}

	refresh(url?: string): Promise<PRMonitorState> {
		if (this.stopped) return Promise.resolve(this.snapshot)
		if (url) {
			const normalized = parsePRTarget(url).url
			const target = this.targets.get(normalized)?.monitor
			if (target) return target.refresh()
			if (this.local.snapshot.pullRequest?.url === normalized) return this.local.refresh()
			return Promise.reject(new Error("This PR is not being tracked in the session."))
		}
		if (this.pending) return this.pending
		this.pending = (async () => {
			const monitors = [this.local, ...[...this.targets.values()].map(({ monitor }) => monitor)]
			const start = this.cursor % monitors.length
			for (let i = 0; i < monitors.length && !this.stopped; i++) {
				const monitor = monitors[(start + i) % monitors.length]
				if (monitor.snapshot.enabled || (monitor === this.local && !this.targets.size)) await monitor.refresh()
			}
			this.publish()
			return this.snapshot
		})().finally(() => {
			this.pending = undefined
		})
		return this.pending
	}

	async settled(aborted: boolean): Promise<void> {
		const active = this.active
		if (active) {
			await active.settled(aborted)
			if (this.active === active) this.active = undefined
			const monitors = [this.local, ...[...this.targets.values()].map(({ monitor }) => monitor)]
			this.cursor = monitors.indexOf(active) + 1
		}
		const monitors = [this.local, ...[...this.targets.values()].map(({ monitor }) => monitor)]
		if (!aborted && !this.stopped && monitors.some((monitor) => monitor.snapshot.enabled && monitor.snapshot.autoFix))
			await this.refresh()
	}

	async dispose(): Promise<void> {
		this.stopped = true
		this.preparation.abort()
		clearInterval(this.timer)
		await this.additions
		await this.pending
		await this.local.dispose()
		for (const { monitor } of this.targets.values()) await monitor.dispose()
		this.observers.clear()
		this.notify = undefined
	}
}
