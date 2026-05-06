import { existsSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { getBundledPluginsRoot } from "./registry.js"

describe("bundled assets", () => {
	let root: string

	beforeAll(() => {
		process.env.PI_PACKAGE_DIR = "/Users/tautvydas/Desktop/castai/kimchi-dev"
		root = getBundledPluginsRoot()
	})

	const orchestratorFiles = [
		"plugin.json",
		"commands/development-workflow.md",
		"commands/dispatch-parallel-agents.md",
		"commands/explore-and-plan.md",
		"commands/finish-development.md",
		"commands/full-cycle.md",
		"commands/request-code-review.md",
		"commands/systematic-debugging-agentless.md",
		"commands/systematic-debugging.md",
		"commands/test-driven-development.md",
		"agents/architecture-analyzer.md",
		"agents/code-reviewer.md",
		"agents/debugger.md",
		"agents/expert-coder.md",
		"agents/file-mapper.md",
		"agents/test-writer.md",
		"agents/validator.md",
	]

	const docsCuratorFiles = [
		"plugin.json",
		"commands/docs-add.md",
		"commands/docs-list.md",
		"commands/docs-remove.md",
		"commands/docs-scaffold.md",
		"commands/docs-show.md",
		"commands/docs-update.md",
		"agents/docs-curator.md",
	]

	it.each(orchestratorFiles)("orchestrator-workflows/%s exists", (file) => {
		expect(existsSync(join(root, "orchestrator-workflows", file))).toBe(true)
	})

	it.each(docsCuratorFiles)("docs-curator/%s exists", (file) => {
		expect(existsSync(join(root, "docs-curator", file))).toBe(true)
	})
})
