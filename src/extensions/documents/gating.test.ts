/**
 * Rollout gating for Phase 1: `extensions.documents` is an experimental
 * resource, off by default, restart-required — with the toggle off, nothing
 * is registered (no read_document, no read interception) and @file args are
 * untouched. Filter-level: enabledExtensionFactories drops the factory when
 * the settings file lacks the id.
 */

import { describe, expect, it } from "vitest"
import { STATIC_RESOURCE_DEFINITIONS } from "../../resources/definitions.js"
import { enabledExtensionFactories } from "../../resources/filter.js"
import { DOCUMENTS_RESOURCE_ID } from "./index.js"

describe("documents resource gating", () => {
	it("is registered as an experimental, off-by-default resource", () => {
		const def = STATIC_RESOURCE_DEFINITIONS.find((d) => d.id === DOCUMENTS_RESOURCE_ID)
		expect(def).toBeDefined()
		expect(def).toMatchObject({ kind: "extensions", experimental: true, defaultEnabled: false, restartRequired: true })
	})

	it("is filtered out when not enabled in resource settings", () => {
		// Default settings path has no documents entry (fresh env in tests).
		const factories = enabledExtensionFactories([{ id: DOCUMENTS_RESOURCE_ID, factory: () => {} }])
		expect(factories).toEqual([])
	})
})
