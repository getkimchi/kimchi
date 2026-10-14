import { join } from "node:path"
import {
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	InteractiveMode,
} from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../cli-args.js"
import { getResourceSettingsPath, isResourceEnabled, onTerminalRecordingChange } from "../resources/store.js"
import { TERMINAL_RECORDING_RESOURCE_ID } from "../resources/types.js"
import { tapTerminalOutput } from "./output-tap.js"
import { type Recording, readRecordings, recordingDeadline, TerminalRecorder } from "./recorder.js"
import { traceStepForEvent } from "./trace.js"

let active: TerminalRecorder | undefined
let untap: (() => void) | undefined
let untrace: (() => void) | undefined
let installed = false
let currentMode: ReplayInteractiveMode | undefined
let generation = 0
let closing = Promise.resolve()
const exportConsent = new Map<string, () => Promise<boolean>>()
const recordingRoot = () => join(getAgentDir(), "terminal-recordings")

function enabled(): boolean {
	if (!process.stdin.isTTY || !process.stdout.isTTY || getParsedCliArgs().options["no-session"]) return false
	try {
		return isResourceEnabled(TERMINAL_RECORDING_RESOURCE_ID)
	} catch {
		// A malformed settings file must not prevent the terminal from opening.
		return false
	}
}

async function begin(manager: ExtensionContext["sessionManager"]): Promise<boolean> {
	if (!enabled()) {
		await finish()
		return false
	}
	if (active?.metadata.sessionId === manager.getSessionId()) return false
	const version = await finish()
	if (version !== generation || !enabled()) return false
	try {
		const pending = TerminalRecorder.create({
			root: recordingRoot(),
			sessionId: manager.getSessionId(),
			cols: process.stdout.columns || 80,
			rows: process.stdout.rows || 24,
		})
		const recorder = await recordingDeadline(pending)
		if (!recorder) {
			void pending.then((recorder) => recorder.close()).catch(() => {})
			return false
		}
		if (version !== generation || !enabled()) {
			void recorder.close().catch(() => {})
			return false
		}
		active = recorder
		untap = tapTerminalOutput(
			[process.stdout, process.stderr],
			(data) => recorder.write(data),
			(cols, rows) => recorder.resize(cols, rows),
		)
		return true
	} catch {
		// Failure to record must not prevent opening a session. Export explains missing coverage.
		return false
	}
}

async function finish(): Promise<number> {
	const version = ++generation
	untrace?.()
	untrace = undefined
	untap?.()
	untap = undefined
	const previous = active
	active = undefined
	if (previous)
		closing = recordingDeadline(previous.close()).then(
			() => {},
			() => {},
		)
	await closing
	return version
}

interface ReplayInteractiveMode {
	session: Pick<AgentSession, "subscribe" | "sessionManager">
	sessionManager: ExtensionContext["sessionManager"]
	ui: { requestRender(force?: boolean): void }
	init(): Promise<void>
	rebindCurrentSession(options?: { renderBeforeBind?: boolean }): Promise<void>
}

function subscribeTrace(mode: ReplayInteractiveMode, session: ReplayInteractiveMode["session"]): void {
	const recorder = active
	if (
		currentMode !== mode ||
		mode.session !== session ||
		!recorder ||
		recorder.metadata.sessionId !== session.sessionManager.getSessionId()
	)
		return
	untrace?.()
	// Subscribe after the TUI: it has applied the event and requested its next frame.
	untrace = session.subscribe((event) => {
		try {
			const step = traceStepForEvent(event)
			if (step) recorder.trace(step)
		} catch {
			// An untyped extension result must not make optional recording interrupt the agent.
		}
	})
}

async function applyRecordingSetting(mode: ReplayInteractiveMode): Promise<void> {
	const session = mode.session
	const changed = await begin(mode.sessionManager)
	if (!changed || currentMode !== mode || mode.session !== session) return
	subscribeTrace(mode, session)
	// A new visit must begin with the whole screen, including when enabled inside a menu.
	mode.ui.requestRender(true)
}

/** Pi starts its terminal before session_start. This adapter captures that first frame too. */
export function installTerminalRecording(): void {
	if (installed) return
	installed = true
	onTerminalRecordingChange((path) => {
		if (currentMode && path === getResourceSettingsPath()) void applyRecordingSetting(currentMode).catch(() => {})
	})
	// Private upstream boundary, intentionally confined to this adapter and pinned by a TUI e2e.
	const prototype = InteractiveMode.prototype as unknown as ReplayInteractiveMode
	const init = prototype.init
	prototype.init = async function () {
		currentMode = this
		await begin(this.sessionManager)
		return init.call(this)
	}
	const rebind = prototype.rebindCurrentSession
	prototype.rebindCurrentSession = async function (options) {
		currentMode = this
		untrace?.()
		untrace = undefined
		const session = this.session
		const changed = await begin(this.sessionManager)
		// A session visit needs a full initial frame; differential output alone is not replayable.
		if (changed) this.ui.requestRender(true)
		await rebind.call(this, options)
		subscribeTrace(this, session)
	}
}

export function terminalRecordingExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId()
		exportConsent.set(id, async () => {
			const include = "Transcript + replay (raw terminal output)"
			return (
				(await ctx.ui.select(
					"Include terminal replay? Replay and trace tool arguments and results can contain secrets, drafts and cleared output. Only the transcript is redacted.",
					["Transcript only (redacted)", include],
				)) === include
			)
		})
	})
	pi.on("session_shutdown", async (event, ctx) => {
		exportConsent.delete(ctx.sessionManager.getSessionId())
		if (event.reason !== "quit") return
		currentMode = undefined
		await finish()
	})
}

/** Raw terminal content is never silently added to an otherwise redacted export. */
export async function recordingsForExport(sessionId: string): Promise<Recording[] | undefined> {
	const consent = exportConsent.get(sessionId)
	if (!consent) return undefined
	if (!(await consent())) return undefined
	await closing
	if (active?.metadata.sessionId === sessionId) {
		active.finalizeTrace()
		await recordingDeadline(active.flush())
	}
	return (await recordingDeadline(readRecordings(recordingRoot(), sessionId), 30000)) ?? []
}
