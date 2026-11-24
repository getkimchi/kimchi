import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

interface AcpWorkflow {
	on: {
		push?: { branches?: string[] }
		merge_group?: unknown
	}
}

describe("ACP integration workflow", () => {
	it("runs against the tree entering master, not only individual PR heads", () => {
		const path = fileURLToPath(new URL("../../../.github/workflows/acp-e2e.yml", import.meta.url))
		const workflow = parseYaml(readFileSync(path, "utf8")) as AcpWorkflow

		expect(workflow.on.push?.branches).toEqual(["master"])
		expect(workflow.on).toHaveProperty("merge_group")
	})
})
