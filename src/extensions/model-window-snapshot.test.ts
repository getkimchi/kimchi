import { describe, expect, it } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { testTheme } from "./__mocks__/theme.js"
import modelWindowSnapshotExtension, {
	isModelWindowSnapshotEntry,
	MODEL_WINDOW_SNAPSHOT_ENTRY,
} from "./model-window-snapshot.js"

describe("model-window-snapshot", () => {
	it("appends the live model's window at compaction", async () => {
		const api = createExtensionApi()
		const ctx = { model: { provider: "kimchi-dev", id: "glm-5.3-flash", contextWindow: 262_144, maxTokens: 65_536 } }
		modelWindowSnapshotExtension(api.api)

		await api.emit("session_compact", { type: "session_compact" }, ctx as never)

		const entries = api.getAppendedEntries<typeof ctx.model & { timestamp: number }>(MODEL_WINDOW_SNAPSHOT_ENTRY)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({
			version: 1,
			provider: "kimchi-dev",
			modelId: "glm-5.3-flash",
			contextWindow: 262_144,
			maxTokens: 65_536,
		})
		expect(typeof entries[0]?.timestamp).toBe("number")
	})

	it("appends nothing when no model is set", async () => {
		const api = createExtensionApi()
		modelWindowSnapshotExtension(api.api)

		await api.emit("session_compact", { type: "session_compact" }, { model: undefined } as never)

		expect(api.getAppendedEntries(MODEL_WINDOW_SNAPSHOT_ENTRY)).toHaveLength(0)
	})

	it("renders a valid snapshot entry and rejects malformed payloads", () => {
		const api = createExtensionApi()
		modelWindowSnapshotExtension(api.api)

		const render = api.getEntryRenderer(MODEL_WINDOW_SNAPSHOT_ENTRY)
		expect(render).toBeDefined()

		const valid = render?.(
			{
				type: "custom",
				customType: MODEL_WINDOW_SNAPSHOT_ENTRY,
				data: {
					version: 1,
					provider: "kimchi-dev",
					modelId: "glm-5.3-flash",
					contextWindow: 1_048_576,
					maxTokens: 65_536,
					timestamp: 0,
				},
			} as never,
			{} as never,
			testTheme,
		)
		expect(valid).toBeDefined()
		// Number grouping is locale-dependent; assert on the stable parts only.
		const rendered = valid?.render(200).join("") ?? ""
		expect(rendered).toContain("glm-5.3-flash")
		expect(rendered).toContain("tokens")

		const malformed = render?.(
			{ type: "custom", customType: MODEL_WINDOW_SNAPSHOT_ENTRY, data: { version: 2 } } as never,
			{} as never,
			testTheme,
		)
		expect(malformed).toBeUndefined()
	})

	it("isModelWindowSnapshotEntry validates type and payload", () => {
		expect(
			isModelWindowSnapshotEntry({
				type: "custom",
				customType: MODEL_WINDOW_SNAPSHOT_ENTRY,
				data: { version: 1, provider: "p", modelId: "m", contextWindow: 1, maxTokens: 1, timestamp: 0 },
			} as never),
		).toBe(true)
		expect(isModelWindowSnapshotEntry({ type: "custom", customType: "other", data: {} } as never)).toBe(false)
	})
})
