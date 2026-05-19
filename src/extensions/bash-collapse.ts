import { execFile, execFileSync } from "node:child_process"
import type { BashSpawnContext, BashToolDetails, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent"
import { Container, Spacer, Text } from "@earendil-works/pi-tui"
import { ToolBlockView, buildToolCallHeader, getTextContent } from "../components/tool-block.js"
import { isToolExpanded, registerToolCall } from "../expand-state.js"

export function collapseCommand(command: string | undefined): string {
	return (command ?? "").replace(/\n+/g, " ⏎ ")
}

// ---------------------------------------------------------------------------
// RTK (Rust Token Killer) integration
//
// When the `rtk` binary is on PATH, bash commands are rewritten through
// `rtk rewrite <cmd>` before execution.  This reduces LLM token consumption
// by 60-90% on common dev commands (git, cargo, npm, etc.).
//
// Set KIMCHI_RTK=0 to disable even when rtk is installed.
// See https://github.com/rtk-ai/rtk
// ---------------------------------------------------------------------------

/** Tri-state: undefined = not yet probed, true/false = cached result. */
let rtkAvailable: boolean | undefined

function isRtkDisabledByEnv(): boolean {
	const v = process.env.KIMCHI_RTK
	return v === "0" || v === "false" || v === "off"
}

/**
 * Probe for the `rtk` binary once per process.  Caches the result so
 * subsequent calls are free.  Returns true when rtk is installed and
 * responds to `--version` within 1 s.
 */
export function detectRtk(): Promise<boolean> {
	if (rtkAvailable !== undefined) return Promise.resolve(rtkAvailable)
	if (isRtkDisabledByEnv()) {
		rtkAvailable = false
		return Promise.resolve(false)
	}
	return new Promise<boolean>((resolve) => {
		execFile("rtk", ["--version"], { timeout: 1000 }, (err) => {
			rtkAvailable = !err
			resolve(rtkAvailable)
		})
	})
}

/**
 * Synchronously ask `rtk rewrite` to compress / rewrite a command string.
 * Used as a pi-mono BashSpawnHook (which must be synchronous).
 *
 * Returns the original command unchanged when:
 *   - rtk is not available or disabled via KIMCHI_RTK
 *   - rtk returns empty output or the same string
 *   - the subprocess times out or fails to spawn
 */
export function rewriteWithRtk(command: string): string {
	if (isRtkDisabledByEnv()) return command
	if (rtkAvailable === false) return command

	try {
		const stdout = execFileSync("rtk", ["rewrite", command], { timeout: 2000, encoding: "utf-8" })
		const rewritten = stdout.trim()
		return rewritten && rewritten !== command ? rewritten : command
	} catch (err) {
		// execFileSync throws on any non-zero exit code.  RTK uses exit code 3
		// to signal a successful rewrite, so we extract stdout from the error.
		const execErr = err as { status?: number; stdout?: string; code?: string }
		if (execErr.status === 3 && typeof execErr.stdout === "string") {
			const rewritten = execErr.stdout.trim()
			return rewritten && rewritten !== command ? rewritten : command
		}
		// On first ENOENT, cache the negative result so we stop spawning.
		if (execErr.code === "ENOENT") {
			rtkAvailable = false
		}
		return command
	}
}

/**
 * BashSpawnHook for pi-mono's createBashToolDefinition.
 * Rewrites the command through `rtk rewrite` before the shell spawns.
 */
export function rtkSpawnHook(context: BashSpawnContext): BashSpawnContext {
	const rewritten = rewriteWithRtk(context.command)
	return rewritten !== context.command ? { ...context, command: rewritten } : context
}

/** Reset cached detection state (for tests). */
export function _resetRtkState(): void {
	rtkAvailable = undefined
}

export default function (pi: ExtensionAPI) {
	const baseDef = createBashToolDefinition(process.cwd(), { spawnHook: rtkSpawnHook })

	// Eagerly probe for rtk at extension load time (non-blocking).
	detectRtk()

	const def: ToolDefinition<typeof baseDef.parameters, BashToolDetails | undefined> = {
		...baseDef,

		execute(toolCallId, params, signal, onUpdate, ctx) {
			return createBashToolDefinition(ctx.cwd, { spawnHook: rtkSpawnHook }).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx,
			)
		},

		renderCall(args, theme, ctx) {
			const view = ctx.lastComponent instanceof ToolBlockView ? ctx.lastComponent : new ToolBlockView()
			// Show the rewritten command (if rtk is active) so the user sees
			// exactly what will be executed.  rewriteWithRtk is synchronous and
			// returns the original string unchanged when rtk is unavailable.
			const rewritten = rewriteWithRtk(args.command ?? "")
			const command = collapseCommand(rewritten)
			buildToolCallHeader(view, "bash", command, theme, ctx)
			return view
		},

		renderResult(result, options, theme, context) {
			if (options.isPartial) {
				const displayText = getTextContent(result).split("\n").slice(-5).join("\n")

				const component = context.lastComponent instanceof Container ? context.lastComponent : new Container()
				component.clear()
				component.addChild(new Spacer(1))
				component.addChild(new Text(theme.fg("toolOutput", displayText), 0, 0))
				component.invalidate()
				return component
			}

			registerToolCall(context.toolCallId)

			if (isToolExpanded(context.toolCallId)) {
				return baseDef.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0)
			}

			const view = context.lastComponent instanceof ToolBlockView ? context.lastComponent : new ToolBlockView()
			const trimmed = getTextContent(result).replace(/\n$/, "")
			const lineCount = trimmed ? trimmed.split("\n").length : 0

			view.setHeader("", "")
			view.setDivider((s: string) => theme.fg("borderMuted", s))
			view.setFooter(
				theme.fg("dim", `${lineCount} line${lineCount === 1 ? "" : "s"} of output`),
				theme.fg("dim", "ctrl+o to expand"),
			)
			view.setExtra([])
			return view
		},
	}

	pi.registerTool(def)

	// Log RTK availability once at session start (informational only).
	pi.on("session_start", async () => {
		await detectRtk()
	})
}
