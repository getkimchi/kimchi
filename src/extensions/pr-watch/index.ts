import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { getParsedCliArgs } from "../../cli-args.js"
import { runPRWatchCommand } from "./command.js"
import { followCheckoutPR } from "./offer.js"
import { PRWatchPanel } from "./panel.js"
import { formatPRWatchStatus } from "./presentation.js"
import { discoverMyOpenPRs } from "./providers.js"
import { renderPRWatchCall, renderPRWatchResult } from "./render.js"
import { isPRMonitoringPermitted } from "./session-policy.js"
import type { PRWatchState } from "./types.js"
import { PRWatcher } from "./watcher.js"
import { renderPRWatchWidget } from "./widget.js"

const watchers = new WeakMap<object, PRWatcher>()

export function getPRWatcher(sessionManager: object): PRWatcher | undefined {
	return watchers.get(sessionManager)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

const prWatchTool = defineTool({
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
		const current = getPRWatcher(ctx.sessionManager)
		if (!current) throw new Error("PR watch is unavailable in this session.")
		const abort = signal ?? new AbortController().signal
		const targets = [...(args.targets ?? []), ...(args.url ? [{ url: args.url }] : [])]
		const urls = targets.map(({ url }) => url)
		let state: PRWatchState
		if (args.action === "status") state = await current.refresh()
		else if (args.action === "pause") state = await current.pause(urls)
		else if (args.action === "stop") state = current.stop(urls)
		else {
			if (args.allMine)
				targets.push(...(await discoverMyOpenPRs(abort, args.provider, args.host)).map((url) => ({ url })))
			const grant = { autoFix: args.autoFix ?? true, instructions: args.instructions }
			state = targets.length
				? await current.add(targets, { ...grant, mode: args.mode ?? "ci" }, ctx, abort)
				: args.allMine
					? { ...current.snapshot, message: "No open PRs or MRs found for your account." }
					: await current.start({ ...grant, mode: args.mode })
		}
		return { content: [{ type: "text", text: formatPRWatchStatus(state) }], details: { state } }
	},
})

export default function prWatchExtension(pi: ExtensionAPI): void {
	if (!isPRMonitoringPermitted()) return
	let watcher: PRWatcher | undefined
	let offer: ReturnType<typeof followCheckoutPR> | undefined
	let panel: PRWatchPanel | undefined
	let showWidget: (() => void) | undefined
	let unobserve: (() => void) | undefined

	pi.registerTool(prWatchTool)
	pi.registerFlag("pr-watch", {
		type: "boolean",
		default: false,
		description: "Watch this session's PR without granting automatic fixes.",
	})

	async function close(ctx: ExtensionContext): Promise<void> {
		offer?.dispose()
		offer = undefined
		panel?.close()
		panel = undefined
		unobserve?.()
		unobserve = undefined
		showWidget = undefined
		watchers.delete(ctx.sessionManager)
		await watcher?.dispose()
		watcher = undefined
	}

	pi.on("session_start", async (_event, ctx) => {
		await close(ctx)
		const current = new PRWatcher(pi, ctx)
		watcher = current
		watchers.set(ctx.sessionManager, current)
		if (ctx.mode === "tui") {
			const update = (state: PRWatchState) =>
				ctx.ui.setWidget(
					"pr-watch",
					panel || !state.targets.some((target) => target.enabled)
						? undefined
						: (_tui, theme) => ({ render: (width) => renderPRWatchWidget(state, width, theme), invalidate() {} }),
					{ placement: "aboveEditor" },
				)
			showWidget = () => update(current.snapshot)
			unobserve = current.observe(update)
			showWidget()
		}
		offer = followCheckoutPR(pi, ctx, current, getParsedCliArgs().options["pr-watch"] === true)
	})

	async function openPanel(ctx: ExtensionContext, current: PRWatcher): Promise<void> {
		panel?.close()
		let opened: PRWatchPanel | undefined
		try {
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				opened = new PRWatchPanel(current, tui, () => done(), theme)
				panel = opened
				showWidget?.()
				return opened
			})
		} finally {
			opened?.dispose()
			if (opened && panel === opened) {
				panel = undefined
				if (watcher === current) showWidget?.()
			}
		}
	}

	pi.registerCommand("pr-watch", {
		description: "Watch and fix PRs locally: /pr-watch [URL|instructions|enable|disable|watch|monitor|status|stop]",
		handler: async (args, ctx) => {
			if (!watcher) return
			try {
				if (args.trim() === "monitor" && ctx.mode === "tui") return await openPanel(ctx, watcher)
				const result = await runPRWatchCommand(watcher, args)
				if ("prompt" in result) pi.sendUserMessage(result.prompt)
				else ctx.ui.notify(formatPRWatchStatus(result.state), "info")
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error")
			}
		},
	})
	pi.on("agent_settled", async (event) => {
		await watcher?.settled(event.aborted)
		offer?.show()
	})
	pi.on("session_shutdown", async (_event, ctx) => {
		await close(ctx)
		if (ctx.mode === "tui") ctx.ui.setWidget("pr-watch", undefined)
	})
}
