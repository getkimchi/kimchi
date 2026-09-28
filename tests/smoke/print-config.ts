/**
 * Shared print-mode smoke-test setup: isolated kimchi HOME config pointing the
 * "fake" provider at the fake OpenAI server. Extracted from
 * print-exit-code.test.ts so print smoke tests can parametrize the model list
 * (e.g. a custom context window for compaction scenarios) instead of copying
 * the fixture.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type FakeModel, resolveModels } from "../e2e/tui/support/fake-openai-server.js"

export function writeKimchiConfig(homeDir: string, fakeBaseUrl: string, models?: FakeModel[]): void {
	const configDir = join(homeDir, ".config", "kimchi")
	const harnessDir = join(configDir, "harness")
	mkdirSync(harnessDir, { recursive: true })
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ apiKey: "fake", llmEndpoint: fakeBaseUrl, skillPaths: [], migrationState: "done" }),
	)
	writeFileSync(
		join(harnessDir, "settings.json"),
		JSON.stringify({
			multiModel: false,
			resources: {},
			retry: { maxRetries: 1, baseDelayMs: 10 },
		}),
	)
	writeFileSync(
		join(harnessDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: `${fakeBaseUrl}/openai/v1`,
					apiKey: "fake",
					api: "openai-completions",
					authHeader: true,
					models: resolveModels(models).map((model) => ({
						id: model.slug,
						name: model.displayName,
						reasoning: model.reasoning,
						input: model.input,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				},
			},
		}),
	)
}
