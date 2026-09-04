import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withExperimentalFeatures } from "../experimental.js"
import { installAutoModelDiscoveryAdapter } from "./model-discovery.js"

describe("Auto model discovery adapter", () => {
	let tempDir: string
	let runtime: ModelRuntime

	beforeAll(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-auto-discovery-"))
		const modelsPath = join(tempDir, "models.json")
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"kimchi-dev": {
						baseUrl: "https://llm.kimchi.dev/openai/v1",
						apiKey: "test-key",
						api: "openai-completions",
						models: [
							{ id: "concrete", name: "Concrete" },
							{ id: "auto", name: "Auto (Kimchi Router)", api: "kimchi-auto" },
						],
					},
				},
			}),
		)
		installAutoModelDiscoveryAdapter()
		runtime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false })
	})

	afterAll(() => rmSync(tempDir, { recursive: true, force: true }))

	it("keeps Auto restorable but hides it from discovery without the flag", async () => {
		await withExperimentalFeatures(false, async () => {
			expect(runtime.getModel("kimchi-dev", "auto")?.id).toBe("auto")
			const snapshotRefs = runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`)
			expect(snapshotRefs).toContain("kimchi-dev/concrete")
			expect(snapshotRefs).not.toContain("kimchi-dev/auto")
			const providerRefs = (await runtime.getAvailable("kimchi-dev")).map((model) => `${model.provider}/${model.id}`)
			expect(providerRefs).toContain("kimchi-dev/concrete")
			expect(providerRefs).not.toContain("kimchi-dev/auto")
		})
	})

	it("exposes exactly kimchi-dev/auto when experimental features are enabled", async () => {
		await withExperimentalFeatures(true, async () => {
			expect(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`)).toContain(
				"kimchi-dev/auto",
			)
		})
	})
})
