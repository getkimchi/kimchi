// Persistence for agents extension operational settings.
// - Global:  ~/.config/kimchi/harness/agents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.kimchi/agents.json — written by /agents → Settings; overrides global on load

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type { JoinMode } from "./personas/types.js"

export interface SubagentsSettings {
	maxConcurrent?: number
	/**
	 * 0 = unlimited — the extension's single source of truth for that convention:
	 * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
	 * `/agents` → Settings input prompt explicitly says "0 = unlimited".
	 */
	defaultMaxTurns?: number
	graceTurns?: number
	defaultJoinMode?: JoinMode
}

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
	setMaxConcurrent: (n: number) => void
	setDefaultMaxTurns: (n: number) => void
	setGraceTurns: (n: number) => void
	setDefaultJoinMode: (mode: JoinMode) => void
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void

const VALID_JOIN_MODES: ReadonlySet<string> = new Set<JoinMode>(["async", "group", "smart"])

const MAX_CONCURRENT_CEILING = 1024
const MAX_TURNS_CEILING = 10_000
const GRACE_TURNS_CEILING = 1_000

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
	if (!raw || typeof raw !== "object") return {}
	const r = raw as Record<string, unknown>
	const out: SubagentsSettings = {}
	if (
		Number.isInteger(r.maxConcurrent) &&
		(r.maxConcurrent as number) >= 1 &&
		(r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
	) {
		out.maxConcurrent = r.maxConcurrent as number
	}
	if (
		Number.isInteger(r.defaultMaxTurns) &&
		(r.defaultMaxTurns as number) >= 0 &&
		(r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
	) {
		out.defaultMaxTurns = r.defaultMaxTurns as number
	}
	if (
		Number.isInteger(r.graceTurns) &&
		(r.graceTurns as number) >= 1 &&
		(r.graceTurns as number) <= GRACE_TURNS_CEILING
	) {
		out.graceTurns = r.graceTurns as number
	}
	if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode)) {
		out.defaultJoinMode = r.defaultJoinMode as JoinMode
	}
	return out
}

function globalPath(): string {
	return join(getAgentDir(), "agents.json")
}

function projectPath(cwd: string): string {
	return join(cwd, ".kimchi", "agents.json")
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path: string): SubagentsSettings {
	if (!existsSync(path)) return {}
	try {
		return sanitize(JSON.parse(readFileSync(path, "utf-8")))
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		console.warn(`[kimchi-agents] Ignoring malformed settings at ${path}: ${reason}`)
		return {}
	}
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
	return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) }
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
	const path = projectPath(cwd)
	try {
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, JSON.stringify(s, null, 2), "utf-8")
		return true
	} catch {
		return false
	}
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
	if (typeof s.maxConcurrent === "number") appliers.setMaxConcurrent(s.maxConcurrent)
	if (typeof s.defaultMaxTurns === "number") appliers.setDefaultMaxTurns(s.defaultMaxTurns)
	if (typeof s.graceTurns === "number") appliers.setGraceTurns(s.graceTurns)
	if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode)
}

/**
 * Format the user-facing toast for a settings mutation.
 */
export function persistToastFor(
	successMsg: string,
	persisted: boolean,
): { message: string; level: "info" | "warning" } {
	return persisted
		? { message: successMsg, level: "info" }
		: { message: `${successMsg} (session only; failed to persist)`, level: "warning" }
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings.
 */
export function applyAndEmitLoaded(
	appliers: SettingsAppliers,
	emit: SettingsEmit,
	cwd: string = process.cwd(),
): SubagentsSettings {
	const settings = loadSettings(cwd)
	applySettings(settings, appliers)
	emit("subagents:settings_loaded", { settings })
	return settings
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event,
 * and return the toast the UI should display.
 */
export function saveAndEmitChanged(
	snapshot: SubagentsSettings,
	successMsg: string,
	emit: SettingsEmit,
	cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
	const persisted = saveSettings(snapshot, cwd)
	emit("subagents:settings_changed", { settings: snapshot, persisted })
	return persistToastFor(successMsg, persisted)
}
