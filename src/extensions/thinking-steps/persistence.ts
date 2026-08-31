import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseThinkingMode } from "./parse.js"
import type { PersistedThinkingStepsPreferenceScope, ThinkingStepsMode } from "./types.js"

const PREFERENCE_FILE_NAME = "thinking-steps.json"

function getAgentDir(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR ?? join(homedir(), ".config", "kimchi", "harness")
}

function getPreferencePath(scope: PersistedThinkingStepsPreferenceScope, cwd: string): string {
	if (scope === "global") {
		return join(getAgentDir(), "agent", "state", PREFERENCE_FILE_NAME)
	}

	return join(cwd, ".kimchi", PREFERENCE_FILE_NAME)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

async function readModeFromFile(path: string): Promise<ThinkingStepsMode | undefined> {
	try {
		const content = await readFile(path, "utf8")
		let parsed: unknown

		try {
			parsed = JSON.parse(content) as { mode?: unknown }
		} catch (error) {
			throw new Error(`Failed to parse thinking view preference at ${path}: ${errorMessage(error)}`)
		}

		const mode =
			typeof parsed === "object" &&
			parsed !== null &&
			"mode" in parsed &&
			typeof (parsed as { mode?: unknown }).mode === "string"
				? parseThinkingMode((parsed as { mode: string }).mode)
				: undefined

		if (!mode) {
			throw new Error(`Invalid thinking view preference at ${path}`)
		}

		return mode
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined
		}

		throw error
	}
}

async function writeModeToFile(path: string, mode: ThinkingStepsMode): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, `${JSON.stringify({ mode }, null, 2)}\n`, "utf8")
	} catch (error) {
		throw new Error(`Failed to save thinking view preference at ${path}: ${errorMessage(error)}`)
	}
}

async function clearModeFile(path: string): Promise<void> {
	try {
		await rm(path, { force: true })
	} catch (error) {
		throw new Error(`Failed to clear thinking view preference at ${path}: ${errorMessage(error)}`)
	}
}

export async function readThinkingStepsModePreference(
	scope: PersistedThinkingStepsPreferenceScope,
	cwd: string,
): Promise<ThinkingStepsMode | undefined> {
	return readModeFromFile(getPreferencePath(scope, cwd))
}

export async function writeThinkingStepsModePreference(
	scope: PersistedThinkingStepsPreferenceScope,
	cwd: string,
	mode: ThinkingStepsMode,
): Promise<void> {
	await writeModeToFile(getPreferencePath(scope, cwd), mode)
}

export async function clearThinkingStepsModePreference(
	scope: PersistedThinkingStepsPreferenceScope,
	cwd: string,
): Promise<void> {
	await clearModeFile(getPreferencePath(scope, cwd))
}
