import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { getParsedCliArgs } from "../../cli-args.js"
import { PRWatchCollection } from "./collection.js"
import { formatPRWatchStatus, runPRWatchCommand } from "./command.js"
import { createPRTrackingOffer } from "./offer.js"
import { PRMonitorPanel } from "./panel.js"
import { renderPRWatchCall, renderPRWatchResult } from "./render.js"
import { isPRMonitoringPermitted } from "./session-policy.js"
import { discoverMyOpenPRs } from "./targets.js"
import type { PRMonitorState } from "./types.js"
import { renderPRWatchWidget } from "./widget.js"

const monitors = new WeakMap<object, PRWatchCollection>()

export function getPRMonitor(sessionManager: object): PRWatchCollection | undefined {
	return monitors.get(sessionManager)
}

export default function prMonitorExtension(pi: ExtensionAPI): void {
	if (!isPRMonitoringPermitted()) return
	let monitor: PRWatchCollection | undefined
	let panel: PRMonitorPanel | undefined
	let refreshUI: (() => void) | undefined
	let offer: ReturnType<typeof createPRTrackingOffer> | undefined
	pi.registerTool({
		name: "pr_watch",
		label: "PR Watch",
		renderShell: "self",
		renderCall: renderPRWatchCall,
		renderResult: renderPRWatchResult,
		description:
			"Watch and fix one or any requested set of GitHub PRs or GitLab MRs locally, including from the home directory. Use for 'watch this <url> PR', 'watch my active PRs and fix them' or 'watch my active GitLab MRs'. Supply url for one, targets for several, or allMine=true to discover the signed-in user's open PRs/MRs. For account discovery set provider=gitlab for GitLab MRs (default github), and host for a self-hosted instance. Requests add to existing tracking; there is no PR-count limit. Kimchi reuses the matching session checkout or prepares an isolated checkout through normal tool permissions, without switching the conversation's branch. Starting enables CI fixes only by default: investigate, edit, test, commit and push. Set mode=all or reviews only when the user explicitly asks to fix review comments. autoFix=false means watch only. Fixes wait for idle and outside Plan mode, one PR at a time. Pause/stop/status apply to all targets unless URLs are supplied. Keep the process open.",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union([Type.Literal("start"), Type.Literal("pause"), Type.Literal("stop"), Type.Literal("status")]),
			),
			url: Type.Optional(
				Type.String({ minLength: 1, maxLength: 2048, description: "The PR/MR URL requested by the user." }),
			),
			targets: Type.Optional(
				Type.Array(
					Type.Object({
						url: Type.String({ minLength: 1, maxLength: 2048 }),
						cwd: Type.Optional(
							Type.String({
								minLength: 1,
								description: "Existing checkout for this PR. Omit to prepare an isolated checkout.",
							}),
						),
					}),
				),
			),
			allMine: Type.Optional(
				Type.Boolean({ description: "Explicitly find and watch all open PRs/MRs authored by the signed-in user." }),
			),
			provider: Type.Optional(Type.Union([Type.Literal("github"), Type.Literal("gitlab")])),
			host: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: 255,
					description: "Git provider hostname for account discovery, including self-hosted instances.",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("ci"), Type.Literal("reviews"), Type.Literal("all")], {
					description: "Defaults to ci. Review fixes require an explicit user request.",
				}),
			),
			autoFix: Type.Optional(
				Type.Boolean({ description: "Defaults to true when starting. False explicitly requests watch-only." }),
			),
			instructions: Type.Optional(Type.String({ maxLength: 4000, description: "Optional user limits on repairs." })),
		}),
		async execute(_id, args, signal, _update, ctx) {
			const current = getPRMonitor(ctx.sessionManager)
			if (!current) throw new Error("The PR monitor session is unavailable.")
			if (signal?.aborted) throw new Error("PR watch request cancelled.")
			const action = args.action ?? "start"
			const targets = [...(args.targets ?? []), ...(args.url ? [{ url: args.url }] : [])]
			if (args.allMine && action === "start")
				targets.push(
					...(await discoverMyOpenPRs(signal ?? new AbortController().signal, args.provider, args.host)).map((url) => ({
						url,
					})),
				)
			if (action !== "start" && args.targets?.length) {
				for (const { url } of targets) {
					if (action === "status") await current.refresh(url)
					else await current.configure(action === "pause", false, undefined, url)
				}
				const state = current.snapshot
				return { content: [{ type: "text", text: formatPRWatchStatus(state) }], details: { state } }
			}
			const state =
				action === "status"
					? await current.refresh(args.url)
					: action === "stop"
						? await current.configure(false, false, undefined, args.url)
						: action === "pause"
							? await current.configure(true, false, undefined, args.url)
							: targets.length
								? await current.startTargets(
										targets,
										args.autoFix ?? true,
										args.instructions,
										args.mode ?? "ci",
										ctx,
										signal,
									)
								: args.allMine
									? { ...current.snapshot, message: "No open PRs or MRs found for your account." }
									: await current.configure(true, args.autoFix ?? true, args.instructions, undefined, args.mode)
			if (signal?.aborted && action === "start") {
				await current.configure(false, false)
				throw new Error("PR watch request cancelled.")
			}
			return { content: [{ type: "text", text: formatPRWatchStatus(state) }], details: { state } }
		},
	})
	pi.registerFlag("pr-watch", {
		type: "boolean",
		default: false,
		description: "Watch this session's PR without granting automatic fixes.",
	})
	pi.on("session_start", async (_event, ctx) => {
		offer?.dispose()
		offer = undefined
		panel?.close()
		panel = undefined
		refreshUI = undefined
		await monitor?.dispose()
		monitor = new PRWatchCollection(pi, ctx)
		if (ctx.mode === "tui") {
			const current = monitor
			const updateUI = (state: PRMonitorState) => {
				ctx.ui.setStatus("pr-watch", state.enabled && !panel ? `PR watch: ${state.phase}` : undefined)
				ctx.ui.setWidget(
					"pr-watch",
					state.enabled && !panel
						? (_tui, theme) => ({ render: (width) => renderPRWatchWidget(state, width, theme), invalidate() {} })
						: undefined,
					{ placement: "aboveEditor" },
				)
			}
			refreshUI = () => updateUI(current.snapshot)
			monitor.setNotify(updateUI)
			refreshUI()
		}
		monitors.set(ctx.sessionManager, monitor)
		const prior = ctx.sessionManager
			.getEntries()
			.some((entry) => entry.type === "custom" && entry.customType === "pr_monitor")
		if (getParsedCliArgs().options["pr-watch"] === true && !prior) await monitor.configure(true, false)
		offer = createPRTrackingOffer(pi, ctx, monitor)
	})
	async function openPanel(ctx: ExtensionContext): Promise<void> {
		if (!monitor) return
		panel?.close()
		const current = monitor
		const refresh = refreshUI
		let opened: PRMonitorPanel | undefined
		try {
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				opened = new PRMonitorPanel(current, tui, () => done(), theme)
				panel = opened
				refresh?.()
				return opened
			})
		} finally {
			opened?.dispose()
			if (opened && panel === opened) {
				panel = undefined
				if (monitor === current) refresh?.()
			}
		}
	}
	pi.registerCommand("pr-watch", {
		description: "Watch and fix PRs locally: /pr-watch [URL|instructions|enable|disable|watch|monitor|status|stop]",
		handler: async (args, ctx) => {
			if (!monitor) return
			try {
				if (args.trim() === "monitor" && ctx.mode === "tui") return await openPanel(ctx)
				const mine = /^mine(?:\s+(github|gitlab)(?:\s+(\S+))?)?$/.exec(args.trim())
				if (mine) {
					pi.sendUserMessage(
						`Watch my open ${mine[1] === "gitlab" ? "GitLab MRs" : "GitHub PRs"} and fix CI failures locally using pr_watch with allMine=true, provider=${mine[1] ?? "github"}, mode=ci${mine[2] ? ` and host=${JSON.stringify(mine[2])}` : ""}.`,
					)
					return
				}
				const urls = args.trim().split(/\s+/)
				if (urls.length && urls.every((url) => /^https?:\/\/\S+$/.test(url))) {
					const local = await monitor.local.refresh()
					if (urls.length > 1 || local.pullRequest?.url !== urls[0]) {
						pi.sendUserMessage(
							`Watch these PRs and fix CI failures locally using pr_watch with mode=ci: ${JSON.stringify(urls)}`,
						)
						return
					}
				}
				ctx.ui.notify(formatPRWatchStatus(await runPRWatchCommand(monitor, args)), "info")
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
			}
		},
	})
	pi.on("agent_settled", async (event) => {
		await monitor?.settled(event.aborted)
		offer?.show()
	})
	pi.on("session_shutdown", async (_event, ctx) => {
		offer?.dispose()
		offer = undefined
		panel?.close()
		panel = undefined
		refreshUI = undefined
		monitors.delete(ctx.sessionManager)
		await monitor?.dispose()
		monitor = undefined
		if (ctx.mode === "tui") {
			ctx.ui.setStatus("pr-watch", undefined)
			ctx.ui.setWidget("pr-watch", undefined)
		}
	})
}
