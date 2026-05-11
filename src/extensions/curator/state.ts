import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface CuratorState {
	last_run_at?: string
	last_session_ended_at?: string
	run_count: number
	paused: boolean
	running: boolean
	last_run_summary?: string
	known_agent_skills?: string[]
}

export const DEFAULT_CURATOR_STATE: CuratorState = {
	run_count: 0,
	paused: false,
	running: false,
}

export async function loadState(statePath: string): Promise<CuratorState> {
	try {
		const raw = await readFile(statePath, "utf-8")
		return { ...DEFAULT_CURATOR_STATE, ...(JSON.parse(raw) as Partial<CuratorState>) }
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && (err as { code: string }).code === "ENOENT") {
			return { ...DEFAULT_CURATOR_STATE }
		}
		throw err
	}
}

export async function saveState(statePath: string, state: CuratorState): Promise<void> {
	await mkdir(dirname(statePath), { recursive: true })
	const tmp = `${statePath}.tmp.${Date.now()}`
	await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8")
	await rename(tmp, statePath)
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const TWO_HOURS_S = 2 * 3600

export function shouldRunNow(state: CuratorState, idleSeconds: number, now: Date = new Date()): boolean {
	if (state.paused) return false

	if (state.running) {
		if (!state.last_run_at) return false
		const lastRun = new Date(state.last_run_at)
		if (now.getTime() - lastRun.getTime() < FOUR_HOURS_MS) return false
		// Stale lock (crash assumed) — fall through
	}

	if (state.last_run_at) {
		const lastRun = new Date(state.last_run_at)
		if (now.getTime() - lastRun.getTime() < SEVEN_DAYS_MS) return false
	}

	if (idleSeconds < TWO_HOURS_S) return false

	return true
}
