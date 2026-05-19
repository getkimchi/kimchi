import { execFile, execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
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
// Disable via:
//   - KIMCHI_RTK=0 environment variable, or
//   - "rtk": false  in ~/.config/kimchi/harness/settings.json (/settings)
//
// See https://github.com/rtk-ai/rtk
// ---------------------------------------------------------------------------

const HARNESS_SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

/** Tri-state: undefined = not yet probed, true/false = cached result. */
let rtkAvailable: boolean | undefined

/** Cached in-flight detection promise to avoid concurrent spawns. */
let rtkDetectPromise: Promise<boolean> | undefined

function isRtkDisabledByEnv(): boolean {
	const v = process.env.KIMCHI_RTK
	return v === "0" || v === "false" || v === "off"
}

function isRtkDisabledBySettings(): boolean {
	try {
		const raw = readFileSync(HARNESS_SETTINGS_PATH, "utf-8")
		const parsed = JSON.parse(raw)
		if ("rtk" in parsed) return parsed.rtk === false
	} catch {
		// settings.json absent or unreadable — not disabled
	}
	return false
}

function isRtkDisabled(): boolean {
	return isRtkDisabledByEnv() || isRtkDisabledBySettings()
}

/**
 * Probe for the `rtk` binary once per process.  Caches the result so
 * subsequent calls are free.  The in-flight promise is also cached so
 * concurrent callers share a single `rtk --version` subprocess.
 *
 * Returns true when rtk is installed and responds to `--version` within 1 s.
 */
export function detectRtk(): Promise<boolean> {
	if (rtkAvailable !== undefined) return Promise.resolve(rtkAvailable)
	if (isRtkDisabled()) {
		rtkAvailable = false
		return Promise.resolve(false)
	}
	if (rtkDetectPromise) return rtkDetectPromise
	rtkDetectPromise = new Promise<boolean>((resolve) => {
		execFile("rtk", ["--version"], { timeout: 1000 }, (err) => {
			rtkAvailable = !err
			rtkDetectPromise = undefined
			resolve(rtkAvailable)
		})
	})
	return rtkDetectPromise
}

/**
 * Synchronously ask `rtk rewrite` to compress / rewrite a command string.
 * Used as a pi-mono BashSpawnHook (which must be synchronous).
 *
 * Returns the original command unchanged when:
 *   - rtk is not available or disabled via KIMCHI_RTK / settings.json
 *   - rtk returns empty output or the same string
 *   - the subprocess times out or fails to spawn
 */
export function rewriteWithRtk(command: string): string {
	if (isRtkDisabled()) return command
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

/** Cache of rewrite results so renderCall never spawns a subprocess. */
const rewriteCache = new Map<string, string>()

/**
 * BashSpawnHook for pi-mono's createBashToolDefinition.
 * Rewrites the command through `rtk rewrite` before the shell spawns.
 * Caches the result so renderCall can display it without a subprocess.
 */
export function rtkSpawnHook(context: BashSpawnContext): BashSpawnContext {
	const rewritten = rewriteWithRtk(context.command)
	rewriteCache.set(context.command, rewritten)
	return rewritten !== context.command ? { ...context, command: rewritten } : context
}

/** Reset cached detection state (for tests). */
export function _resetRtkState(): void {
	rtkAvailable = undefined
	rtkDetectPromise = undefined
	rewriteCache.clear()
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
			// Use the cached rewrite result if available (populated by rtkSpawnHook
			// during execute).  This avoids spawning a subprocess on the render path.
			// Falls back to the original command when no cached result exists yet.
			const command = collapseCommand(rewriteCache.get(args.command ?? "") ?? args.command ?? "")
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
}
