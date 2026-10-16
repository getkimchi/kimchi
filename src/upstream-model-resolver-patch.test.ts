// The package exports map does not expose dist/core/model-resolver.js; load
// the module by file URL like the other upstream contract tests do.
const resolverModuleUrl = new URL(
	"../node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js",
	import.meta.url,
)
const { resolveModelReference, resolveModelScopeFromModels } = await import(resolverModuleUrl.href)

import { describe, expect, it } from "vitest"

/**
 * Contract for the `selectReference` canonical-match hunk in
 * patches/@earendil-works__pi-coding-agent@1.3.0.patch.
 *
 * Pi 1.3.0's resolver rewrite (earendil-works/pi#10913) splits a provider
 * reference at the FIRST '/'. Kimchi's gateway provider ids contain a '/'
 * themselves ("kimchi-dev/anthropic", "kimchi-dev/bedrock"), so a pattern
 * like "kimchi-dev/anthropic/claude-opus-5-5" anchored on "kimchi-dev" (a
 * real registered provider) and never resolved — 0.85.1 handled it through
 * a canonical `${provider}/${id}` full-string pass. The patch restores that
 * pass (single exact canonical match wins) before any splitting.
 *
 * When the hunk is lost (e.g. after re-generating the patch), the exact
 * canonical cases below regress to `not-found`.
 */

// resolveModelReference's public types live in the patched package's d.ts;
// the runtime is untyped JS, so narrow only what these tests touch.
type FakeModel = { provider: string; id: string; name: string }
type ResolveResult =
	| { status: "resolved"; model: FakeModel; thinkingLevel?: string }
	| { status: "not-found" | "ambiguous" }
const resolveRef = resolveModelReference as unknown as (
	request: { text: string; thinkingSuffix: string; fuzzy: boolean },
	models: FakeModel[],
	usable: (provider: string) => boolean,
) => ResolveResult
const resolveScope = resolveModelScopeFromModels as unknown as (
	patterns: string[],
	models: FakeModel[],
) => { scopedModels: { model: FakeModel }[]; diagnostics: { type: string }[] }

function makeModel(provider: string, id: string): FakeModel {
	return { id, name: id, provider } as unknown as FakeModel
}

const POOL: FakeModel[] = [
	// The steal-prone first segment IS a registered provider with its own models.
	makeModel("kimchi-dev", "auto"),
	makeModel("kimchi-dev", "kimi-k3"),
	makeModel("kimchi-dev/anthropic", "claude-opus-5-5"),
	makeModel("kimchi-dev/anthropic", "claude-sonnet-5-5"),
	makeModel("kimchi-dev/anthropic", "claude-haiku-4-5"),
	makeModel("kimchi-dev/bedrock", "claude-sonnet-5-5"),
	// Upstream-shaped reference: slug provider + slash-containing model id.
	makeModel("openrouter", "anthropic/claude-opus-5.5"),
]

const usable = (): boolean => true

describe("upstream patch contract — model resolver multi-segment provider ids", () => {
	it("resolves a canonical multi-segment provider reference", () => {
		const r = resolveRef(
			{ text: "kimchi-dev/anthropic/claude-opus-5-5", thinkingSuffix: "sharp", fuzzy: false },
			POOL,
			usable,
		)
		expect(r.status).toBe("resolved")
		if (r.status === "resolved") {
			expect(r.model.provider).toBe("kimchi-dev/anthropic")
			expect(r.model.id).toBe("claude-opus-5-5")
		}
	})

	it("multi-segment provider resolution survives a thinking suffix", () => {
		const r = resolveRef(
			{ text: "kimchi-dev/anthropic/claude-opus-5-5:high", thinkingSuffix: "sharp", fuzzy: false },
			POOL,
			usable,
		)
		expect(r.status).toBe("resolved")
		if (r.status === "resolved") expect(r.thinkingLevel).toBe("high")
	})

	it("scope resolution (scope/enabledModels path) matches multi-segment providers", () => {
		const { scopedModels, diagnostics } = resolveScope(
			["kimchi-dev/anthropic/claude-opus-5-5", "kimchi-dev/anthropic/claude-sonnet-5-5"],
			POOL,
		)
		expect(diagnostics.filter((d: { type: string }) => d.type === "warning")).toHaveLength(0)
		expect(scopedModels.map((s: { model: FakeModel }) => s.model.provider)).toEqual([
			"kimchi-dev/anthropic",
			"kimchi-dev/anthropic",
		])
	})

	it("upstream slug-provider + slash-id references keep their semantics", () => {
		const r = resolveRef(
			{ text: "openrouter/anthropic/claude-opus-5.5", thinkingSuffix: "sharp", fuzzy: false },
			POOL,
			usable,
		)
		expect(r.status).toBe("resolved")
		if (r.status === "resolved") expect(r.model.provider).toBe("openrouter")
	})

	it("the named provider's exact id still wins for first-segment providers", () => {
		// "kimchi-dev/auto" must stay the auto model under the bare "kimchi-dev"
		// provider — the canonical pass must not shunt it elsewhere.
		const r = resolveRef({ text: "kimchi-dev/auto", thinkingSuffix: "sharp", fuzzy: false }, POOL, usable)
		expect(r.status).toBe("resolved")
		if (r.status === "resolved") expect(r.model.id).toBe("auto")
	})
})
