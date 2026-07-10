import { homedir } from "node:os"
import { join } from "node:path"
import { readJson, writeJson } from "./json.js"

type Satisfies<T> = (value: unknown) => value is T

const HARNESS_CONFIG_BASE_DIR = join(homedir(), ".config", "kimchi", "harness")
const HARNESS_SETTINGS_PATH = join(HARNESS_CONFIG_BASE_DIR, "settings.json")

export function getConfigSetting<T>(
	config: Record<string, unknown>,
	key: string,
	satisfies: Satisfies<T>,
): T | undefined {
	const value = config[key]
	if (satisfies(value)) {
		return value
	}
	return undefined
}

/** If `sessionId` is null, retrieve global configuration setting. */
export function readConfigSetting<T>(key: string, satisfies: Satisfies<T>): T | undefined {
	try {
		const parsed = readJson(HARNESS_SETTINGS_PATH)
		return getConfigSetting(parsed, key, satisfies)
	} catch {
		// thrown if the file is malformed: fall through
	}
	return undefined
}

export async function readConfigSettingAsync<T>(key: string, satisfies: Satisfies<T>): Promise<T | undefined> {
	return readConfigSetting(key, satisfies)
}

export function writeConfigSetting<T>(key: string, value: T): void {
	const config = readJson(HARNESS_SETTINGS_PATH)
	if (config[key] !== value) {
		config[key] = value
	} else {
		// avoid modifying settings file if it's up to date
		return
	}
	writeJson(HARNESS_SETTINGS_PATH, config)
}

export async function writeConfigSettingAsync<T>(key: string, value: T): Promise<void> {
	writeConfigSetting(key, value)
}
