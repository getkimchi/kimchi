import { readConfigSetting, writeConfigSetting, writeConfigSettingAsync } from "../config/settings.js"
import { getProcessMultiModelEnabled, setProcessMultiModelEnabled } from "./kimchi-process.js"

function hasExplicitModelFlag(): boolean {
	const args = process.argv
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i]?.startsWith("--model=")) return true
	}
	return false
}

export function readMultiModelSetting(sessionId: string | null): boolean {
	return readConfigSetting(sessionId, "multiModel", (value) => typeof value === "boolean") ?? true
}

const _defaultMultiModelEnabled = hasExplicitModelFlag() ? false : readMultiModelSetting(null)

export function getMultiModelEnabled(sessionId: string | null): boolean {
	if (sessionId !== null) {
		return getProcessMultiModelEnabled(sessionId)
	}
	return _defaultMultiModelEnabled
}

export async function writeMultiModelSettingAsync(sessionId: string, enabled: boolean): Promise<void> {
	await writeConfigSettingAsync(sessionId, "multiModel", enabled)
}

export async function setMultiModelEnabled(sessionId: string, enabled: boolean): Promise<void> {
	setProcessMultiModelEnabled(sessionId, enabled)
	await writeMultiModelSettingAsync(sessionId, enabled)
}
