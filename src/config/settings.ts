import { homedir } from "node:os"
import { join } from "node:path"
import { readJson, writeJson } from "./json.js"

type Satisfies<T> = (value: unknown) => value is T

const HARNESS_CONFIG_BASE_DIR = join(homedir(), ".config", "kimchi", "harness")
const HARNESS_SETTINGS_PATH = join(HARNESS_CONFIG_BASE_DIR, "settings.json")

export function getConfigSetting<T>(
	config: Record<string, unknown>,
	sessionId: string | null,
	key: string,
	satisfies: Satisfies<T>,
): T | undefined {
	if (sessionId !== null) {
		const sessionKey = `session_${sessionId}`
		const sessionConfig = (sessionKey in config && (config[sessionKey] as Record<string, unknown>)) || {}
		const value = sessionConfig[key]
		if (satisfies(value)) {
			return value
		}
	}
	const value = config[key]
	if (satisfies(value)) {
		return value
	}
	return undefined
}

/** If `sessionId` is null, retrieve global configuration setting. */
export function readConfigSetting<T>(sessionId: string | null, key: string, satisfies: Satisfies<T>): T | undefined {
	try {
		const parsed = readJson(HARNESS_SETTINGS_PATH)
		return getConfigSetting(parsed, sessionId, key, satisfies)
	} catch {
		// thrown if the file is malformed: fall through
	}
	return undefined
}

export async function readConfigSettingAsync<T>(
	sessionId: string | null,
	key: string,
	satisfies: Satisfies<T>,
): Promise<T | undefined> {
	return new Promise((resolve) => {
		const setting = readConfigSetting(sessionId, key, satisfies)
		resolve(setting)
	})
}

export function writeConfigSetting<T>(sessionId: string | null, key: string, value: T): void {
	let config: Record<string, unknown>
	try {
		config = readJson(HARNESS_SETTINGS_PATH)
	} catch {
		// thrown if the file is malformed: don't override
		return
	}
	let changed = false
	if (sessionId !== null) {
		const sessionKey = `session_${sessionId}`
		if (!config[sessionKey]) {
			config[sessionKey] = {}
		}
		if ((config[sessionKey] as Record<string, unknown>)[key] !== value) {
			;(config[sessionKey] as Record<string, unknown>)[key] = value
			changed = true
		}
	} else {
		if (config[key] !== value) {
			config[key] = value
			changed = true
		}
	}
	if (!changed) {
		// avoid modifying settings file if it's up to date
		return
	}
	try {
		writeJson(HARNESS_SETTINGS_PATH, config)
	} catch {
		// best-effort
	}
}

export async function writeConfigSettingAsync<T>(sessionId: string | null, key: string, value: T): Promise<void> {
	return new Promise((resolve) => {
		writeConfigSetting(sessionId, key, value)
		resolve()
	})
}
