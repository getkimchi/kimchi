import type { Api, Model } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import { createModel, createModelRegistry, type ModelRegistryMock } from "../__mocks__/model-registry.js"
import {
	type FermentV2VerifierModelChoice,
	formatFermentV2EvaluatorModelWarning,
	resolveFermentV2VerifierModel,
} from "./verifier-model.js"

const implementer = createModel("glm-5.3", "kimchi-dev")
const independent = createModel("kimi-k3", "kimchi-dev")
const thirdModel = createModel("minimax-m2.7", "kimchi-dev")

/** Same canonical ref as the implementer, but a distinct registry entry (alias shape). */
function implementerAlias(): Model<Api> {
	return { ...implementer, name: "glm-5.3 (alias entry)" }
}

async function resolve(
	models: Model<Api>[],
	refs: readonly string[],
	sessionModel: Model<Api> | undefined,
	registry?: ModelRegistryMock,
): Promise<FermentV2VerifierModelChoice | undefined> {
	return resolveFermentV2VerifierModel(
		{ model: sessionModel, modelRegistry: registry ?? createModelRegistry(models) },
		refs,
	)
}

describe("resolveFermentV2VerifierModel", () => {
	it("uses a single configured model that differs from the implementer", async () => {
		const choice = await resolve([implementer, independent], ["kimchi-dev/kimi-k3"], implementer)
		expect(choice).toEqual({ model: independent, ref: "kimchi-dev/kimi-k3", sameAsImplementer: false })
	})

	it("still uses a single configured model that is the implementer, flagged", async () => {
		const choice = await resolve([implementer, independent], ["kimchi-dev/glm-5.3"], implementer)
		expect(choice).toEqual({ model: implementer, ref: "kimchi-dev/glm-5.3", sameAsImplementer: true })
		expect(choice?.fallback).toBeUndefined()
	})

	it("skips the implementer when several models are configured", async () => {
		const choice = await resolve([implementer, independent], ["kimchi-dev/glm-5.3", "kimchi-dev/kimi-k3"], implementer)
		expect(choice).toEqual({ model: independent, ref: "kimchi-dev/kimi-k3", sameAsImplementer: false })
	})

	it("recognizes an alias entry of the implementer by canonical ref and skips it", async () => {
		const alias = implementerAlias()
		const choice = await resolve([alias, independent], ["kimchi-dev/glm-5.3", "kimchi-dev/kimi-k3"], implementer)
		// The alias resolves (same canonical provider/id) but is the implementer, so
		// selection moves on to the independent model.
		expect(choice).toEqual({ model: independent, ref: "kimchi-dev/kimi-k3", sameAsImplementer: false })
	})

	it("flags a lone alias entry of the implementer as the implementer", async () => {
		const alias = implementerAlias()
		const choice = await resolve([alias, independent], ["kimchi-dev/glm-5.3"], implementer)
		expect(choice?.model).toBe(alias)
		expect(choice?.ref).toBe("kimchi-dev/glm-5.3")
		expect(choice?.sameAsImplementer).toBe(true)
	})

	it("uses the first usable entry when every usable entry is the implementer", async () => {
		const choice = await resolve([implementer, independent], ["kimchi-dev/glm-5.3", "kimchi-dev/glm-5.3"], implementer)
		expect(choice).toEqual({ model: implementer, ref: "kimchi-dev/glm-5.3", sameAsImplementer: true })
	})

	it("reports the unusable refs when a configured independent model cannot be resolved", async () => {
		const choice = await resolve([implementer], ["kimchi-dev/glm-5.3", "kimchi-dev/kimi-k3"], implementer)
		expect(choice).toEqual({
			model: implementer,
			ref: "kimchi-dev/glm-5.3",
			sameAsImplementer: true,
			unusableRefs: ["kimchi-dev/kimi-k3"],
		})
	})

	it("reports the unusable refs when a configured independent model fails auth", async () => {
		const registry = createModelRegistry([implementer, independent])
		vi.mocked(registry.getApiKeyAndHeaders)
			.mockResolvedValueOnce({ ok: true, apiKey: "test-key", headers: {} })
			.mockResolvedValueOnce({ ok: false, error: "no api key" })
		const choice = await resolve([], ["kimchi-dev/glm-5.3", "kimchi-dev/kimi-k3"], implementer, registry)
		expect(choice).toEqual({
			model: implementer,
			ref: "kimchi-dev/glm-5.3",
			sameAsImplementer: true,
			unusableRefs: ["kimchi-dev/kimi-k3"],
		})
	})

	it("skips refs that do not resolve in the registry", async () => {
		const registry = createModelRegistry([implementer, independent])
		const choice = await resolve([], ["missing/model", "kimchi-dev/kimi-k3"], implementer, registry)
		expect(choice).toEqual({
			model: independent,
			ref: "kimchi-dev/kimi-k3",
			sameAsImplementer: false,
			unusableRefs: ["missing/model"],
		})
	})

	it("skips resolvable models whose auth check fails", async () => {
		const registry = createModelRegistry([implementer, independent, thirdModel])
		vi.mocked(registry.getApiKeyAndHeaders).mockResolvedValueOnce({ ok: false, error: "no api key" })
		const choice = await resolve([], ["kimchi-dev/kimi-k3", "kimchi-dev/minimax-m2.7"], implementer, registry)
		expect(choice).toEqual({
			model: thirdModel,
			ref: "kimchi-dev/minimax-m2.7",
			sameAsImplementer: false,
			unusableRefs: ["kimchi-dev/kimi-k3"],
		})
	})

	it("skips resolvable models whose auth check rejects", async () => {
		const registry = createModelRegistry([implementer, independent, thirdModel])
		vi.mocked(registry.getApiKeyAndHeaders).mockRejectedValueOnce(new Error("auth service down"))
		const choice = await resolve([], ["kimchi-dev/kimi-k3", "kimchi-dev/minimax-m2.7"], implementer, registry)
		expect(choice).toEqual({
			model: thirdModel,
			ref: "kimchi-dev/minimax-m2.7",
			sameAsImplementer: false,
			unusableRefs: ["kimchi-dev/kimi-k3"],
		})
	})

	it("falls back to the session model when no configured model is usable", async () => {
		const choice = await resolve([implementer], ["missing/one", "kimchi-dev/kimi-k3"], implementer)
		expect(choice).toEqual({
			model: implementer,
			ref: "kimchi-dev/glm-5.3",
			sameAsImplementer: true,
			fallback: "session",
			unusableRefs: ["missing/one", "kimchi-dev/kimi-k3"],
		})
	})

	it("returns undefined when nothing is usable and there is no session model", async () => {
		const choice = await resolve([independent], ["missing/one"], undefined)
		expect(choice).toBeUndefined()
	})

	it("uses a usable configured model even without a session model to compare against", async () => {
		const choice = await resolve([independent, thirdModel], ["kimchi-dev/kimi-k3"], undefined)
		expect(choice).toEqual({ model: independent, ref: "kimchi-dev/kimi-k3", sameAsImplementer: false })
	})

	it("resolves the first usable non-implementer entry across unresolvable and unauthenticated refs", async () => {
		const alias = implementerAlias()
		const registry = createModelRegistry([alias, independent, thirdModel])
		vi.mocked(registry.getApiKeyAndHeaders).mockResolvedValueOnce({ ok: false, error: "no api key" })
		const choice = await resolve(
			[],
			["missing/model", "kimchi-dev/kimi-k3", "kimchi-dev/glm-5.3", "kimchi-dev/minimax-m2.7"],
			implementer,
			registry,
		)
		expect(choice).toEqual({
			model: thirdModel,
			ref: "kimchi-dev/minimax-m2.7",
			sameAsImplementer: false,
			unusableRefs: ["missing/model", "kimchi-dev/kimi-k3"],
		})
	})

	it("reads available models from the registry for every configured ref", async () => {
		const registry = createModelRegistry([independent])
		await resolveFermentV2VerifierModel({ model: implementer, modelRegistry: registry }, [
			"kimchi-dev/kimi-k3",
			"missing/model",
		])
		expect(registry.getAvailable).toHaveBeenCalledTimes(2)
	})
})

describe("formatFermentV2EvaluatorModelWarning", () => {
	it("names the only-one-model-configured cause for a single configured implementer model", () => {
		const warning = formatFermentV2EvaluatorModelWarning({
			ref: "kimchi-dev/glm-5.3",
			sameAsImplementer: true,
			configuredRefs: ["kimchi-dev/glm-5.3"],
		})
		expect(warning).toContain("kimchi-dev/glm-5.3")
		expect(warning).toContain("only one model configured")
		expect(warning).toContain("fermentV2.evaluatorModels")
	})

	it("names the every-configured-model cause when several models collapse to the implementer", () => {
		const warning = formatFermentV2EvaluatorModelWarning({
			ref: "kimchi-dev/glm-5.3",
			sameAsImplementer: true,
			configuredRefs: ["kimchi-dev/glm-5.3", "kimchi-dev/glm-5.3"],
		})
		expect(warning).toContain("every configured model is the implementer's model")
	})

	it("names the no-usable-independent-model cause when configured independent refs are unusable", () => {
		const warning = formatFermentV2EvaluatorModelWarning({
			ref: "kimchi-dev/glm-5.3",
			sameAsImplementer: true,
			configuredRefs: ["kimchi-dev/glm-5.3", "kimchi-dev/kimi-k3"],
			unusableRefs: ["kimchi-dev/kimi-k3"],
		})
		expect(warning).toContain("no usable independent model is available")
		expect(warning).toContain("kimchi-dev/kimi-k3")
		expect(warning).toContain("authentication")
		expect(warning).toContain("fermentV2.evaluatorModels")
		expect(warning).not.toContain("every configured model is the implementer's model")
	})

	it("names the no-configured-model-available cause for the session fallback", () => {
		const warning = formatFermentV2EvaluatorModelWarning({
			ref: "kimchi-dev/glm-5.3",
			sameAsImplementer: true,
			modelFallback: "session",
			configuredRefs: ["kimchi-dev/glm-5.3", "kimchi-dev/kimi-k3"],
		})
		expect(warning).toContain("no configured model available")
		expect(warning).toContain("fermentV2.evaluatorModels")
	})

	it("labels a missing ref as the session model", () => {
		const warning = formatFermentV2EvaluatorModelWarning({
			ref: undefined,
			modelFallback: "session",
			configuredRefs: [],
		})
		expect(warning).toContain("session model")
	})
})
