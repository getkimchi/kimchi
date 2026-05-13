import { existsSync } from "node:fs"
import { platform } from "node:os"
import type { ConfigScope } from "../config/scope.js"
import { resolveScopePath } from "../config/scope.js"
import type { ModelMetadata } from "../models.js"
import { BASE_URL, PROVIDER_NAME } from "./constants.js"
import { resolveModelRole } from "./models.js"
import { register } from "./registry.js"

const CURSOR_REACTIVE_STORAGE_KEY =
	"src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser"
const CURSOR_API_KEY_ROW = "cursorAuth/openAIKey"

function cursorDbPath(): string {
	return platform() === "darwin"
		? "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb"
		: "~/.config/Cursor/User/globalStorage/state.vscdb"
}

function detectCursor(): boolean {
	const dbPath = resolveScopePath("global", cursorDbPath())
	if (existsSync(dbPath)) return true
	if (platform() === "darwin" && existsSync("/Applications/Cursor.app")) return true
	return false
}

/**
 * Cursor detects model names containing "sonnet-", "opus-", "haiku-" and
 * switches to its native Anthropic API integration, bypassing the OpenAI compat
 * layer. Alias those substrings so Cursor always routes through kimchi's gateway
 * regardless of the underlying provider.
 */
function modelSlug(model: ModelMetadata): string {
	const slug = model.slug
		.replace(/claude-sonnet-/g, "claude-so-")
		.replace(/claude-opus-/g, "claude-op-")
		.replace(/claude-haiku-/g, "claude-ha-")
	return `${PROVIDER_NAME}/${slug}`
}

function modelEntry(slug: string): Record<string, unknown> {
	return {
		modelName: slug,
		maxMode: false,
		selectedModels: [{ modelId: slug, parameters: [] }],
	}
}

function toStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

function appendUnique(existing: string[], add: readonly string[]): string[] {
	const seen = new Set(existing)
	const out = [...existing]
	for (const s of add) {
		if (!seen.has(s)) {
			out.push(s)
			seen.add(s)
		}
	}
	return out
}

function removeAll(slice: string[], remove: readonly string[]): string[] {
	const drop = new Set(remove)
	return slice.filter((s) => !drop.has(s))
}

/**
 * Mutate Cursor's reactive-storage blob in place to point at the kimchi
 * proxy. Pure — no fs, no SQLite — so the per-row JSON shape is testable
 * without bringing up a real Cursor database.
 *
 * Cursor routes different surfaces (composer / cmd-k / quick-agent / ...)
 * at different models; we map those onto Main/Coding/Sub. The user's
 * pre-existing model lists are preserved (kimchi models are added
 * uniquely, no clobber).
 *
 * @param storage - The parsed reactive-storage blob from Cursor's SQLite DB.
 * @param models  - Live `ModelMetadata[]` fetched from the API.
 */
export function mergeCursorConfig(
	storage: Record<string, unknown>,
	models: readonly ModelMetadata[],
): Record<string, unknown> {
	if (!models || models.length === 0) return storage

	storage.openAIBaseUrl = BASE_URL
	storage.useOpenAIKey = true

	const aiSettings =
		(storage.aiSettings as Record<string, unknown> | undefined) && typeof storage.aiSettings === "object"
			? (storage.aiSettings as Record<string, unknown>)
			: {}

	const main = resolveModelRole(models, "main")
	const coding = resolveModelRole(models, "coding", main)
	const sub = resolveModelRole(models, "sub", main)

	// Add all available models to Cursor's picker — Cursor is a flat list, not a
	// provider block, so there is no downside to including everything the API knows
	// about. Role resolution only determines which surface maps to which model.
	const allSlugs = models.map(modelSlug)

	aiSettings.userAddedModels = appendUnique(toStringArray(aiSettings.userAddedModels), allSlugs)
	aiSettings.modelOverrideEnabled = appendUnique(toStringArray(aiSettings.modelOverrideEnabled), allSlugs)
	aiSettings.modelOverrideDisabled = removeAll(toStringArray(aiSettings.modelOverrideDisabled), allSlugs)

	const modelConfig =
		(aiSettings.modelConfig as Record<string, unknown> | undefined) && typeof aiSettings.modelConfig === "object"
			? (aiSettings.modelConfig as Record<string, unknown>)
			: {}

	// Only write surface mappings for models that were successfully resolved.
	if (main) modelConfig.composer = modelEntry(modelSlug(main))
	if (coding) modelConfig["cmd-k"] = modelEntry(modelSlug(coding))
	if (main) modelConfig["background-composer"] = modelEntry(modelSlug(main))
	if (coding) modelConfig["plan-execution"] = modelEntry(modelSlug(coding))
	if (main) modelConfig.spec = modelEntry(modelSlug(main))
	if (main) modelConfig["deep-search"] = modelEntry(modelSlug(main))
	if (sub) modelConfig["quick-agent"] = modelEntry(modelSlug(sub))
	if (main) modelConfig["composer-ensemble"] = modelEntry(modelSlug(main))

	aiSettings.modelConfig = modelConfig
	storage.aiSettings = aiSettings
	return storage
}

/**
 * Open Cursor's state.vscdb, merge the reactive-storage blob, and persist
 * the new blob plus the API key row in a single transaction. Cursor stores
 * everything in one user-level SQLite database; there's no project-local
 * equivalent, so the `scope` argument is accepted for the ToolDefinition
 * contract but ignored — the writer always targets the global path.
 */
async function writeCursor(
	_scope: ConfigScope,
	apiKey: string,
	models: readonly ModelMetadata[],
	_options?: { telemetryEnabled?: boolean },
): Promise<void> {
	if (!apiKey) {
		throw new Error("API key not configured")
	}
	if (!models || models.length === 0) {
		throw new Error("No models available — is the API key valid?")
	}
	const dbPath = resolveScopePath("global", cursorDbPath())
	if (!existsSync(dbPath)) {
		throw new Error(`Cursor database not found at ${dbPath}`)
	}

	// bun:sqlite is built into the compiled kimchi binary and into `bun run`.
	// Dynamic import so vitest (running on Node) can still load this module
	// without erroring at parse time — tests cover mergeCursorConfig directly.
	const { Database } = (await import("bun:sqlite")) as typeof import("bun:sqlite")

	const db = new Database(dbPath)
	try {
		db.exec("PRAGMA busy_timeout = 5000")
		const txn = db.transaction(() => {
			const row = db
				.query<{ value: string }, [string]>("SELECT value FROM ItemTable WHERE key = ?")
				.get(CURSOR_REACTIVE_STORAGE_KEY)
			const storage: Record<string, unknown> = row?.value ? JSON.parse(row.value) : {}
			mergeCursorConfig(storage, models)
			db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [
				CURSOR_REACTIVE_STORAGE_KEY,
				JSON.stringify(storage),
			])
			db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [CURSOR_API_KEY_ROW, apiKey])
		})
		txn()
	} finally {
		db.close()
	}
}

register({
	id: "cursor",
	name: "Cursor",
	description: "AI-powered code editor",
	configPath: cursorDbPath(),
	binaryName: "cursor",
	isInstalled: detectCursor,
	write: writeCursor,
})
