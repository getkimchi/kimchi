import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

export interface TeleportState {
	lastWorkspaceId?: string
	gitCredentialsSyncedWorkspaces: string[]
}

const KIMCHI_STATE_PATH = resolve(homedir(), ".config", "kimchi", "state.json")

function emptyState(): TeleportState {
	return { gitCredentialsSyncedWorkspaces: [] }
}

export function readState(path: string = KIMCHI_STATE_PATH): TeleportState {
	try {
		const raw = readFileSync(path, "utf-8")
		const parsed = JSON.parse(raw) as Partial<TeleportState>
		return {
			lastWorkspaceId: typeof parsed.lastWorkspaceId === "string" ? parsed.lastWorkspaceId : undefined,
			gitCredentialsSyncedWorkspaces: Array.isArray(parsed.gitCredentialsSyncedWorkspaces)
				? parsed.gitCredentialsSyncedWorkspaces.filter((s): s is string => typeof s === "string")
				: [],
		}
	} catch {
		return emptyState()
	}
}

export function updateState(update: (state: TeleportState) => void, path: string = KIMCHI_STATE_PATH): void {
	const state = readState(path)
	update(state)
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
	renameSync(tmp, path)
}
