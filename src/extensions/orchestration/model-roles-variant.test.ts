/**
 * Tests for variant-scoped model role defaults:
 *   - resolveModelRolesForVariant precedence
 *   - DEFAULT_MODEL_ROLES invariant (adding minimax-m3 must NOT change it)
 *   - spicy variant defaults use minimax-m3, never minimax-m2.7
 *   - user settings.json overrides win over variant defaults
 *   - getModelRoles() production-path tests: variant is wired into the singleton
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PROMPT_VARIANT_ENV } from "../prompt-construction/variants/index.js"
import { SPICY, SPICY_NAME } from "../prompt-construction/variants/spicy.js"
import {
	DEFAULT_MODEL_ROLES,
	MODEL_ROLES_SETTINGS_PATH_ENV,
	getModelRoles,
	getModelRolesWarnings,
	normalizeRoleModels,
	resetModelRolesCache,
	resolveModelRolesForVariant,
} from "./model-roles.js"

// Nonexistent path (no user settings), isolates tests from ~/.config/kimchi/harness/settings.json
const NO_SETTINGS = join(tmpdir(), `kimchi-no-settings-prod-${process.pid}.json`)

afterEach(() => {
	resetModelRolesCache()
	delete process.env[PROMPT_VARIANT_ENV]
	delete process.env[MODEL_ROLES_SETTINGS_PATH_ENV]
})

// ---------------------------------------------------------------------------
// INVARIANT: DEFAULT_MODEL_ROLES are unchanged after adding minimax-m3
// ---------------------------------------------------------------------------

describe("DEFAULT_MODEL_ROLES invariant: minimax-m3 must not alter defaults", () => {
	it("orchestrator is still kimchi-dev/kimi-k2.6", () => {
		expect(DEFAULT_MODEL_ROLES.orchestrator).toBe("kimchi-dev/kimi-k2.6")
	})

	it("builder pool does NOT contain minimax-m3", () => {
		const builders = normalizeRoleModels(DEFAULT_MODEL_ROLES.builder)
		expect(builders).not.toContain("kimchi-dev/minimax-m3")
	})

	it("reviewer pool does NOT contain minimax-m3", () => {
		const reviewers = normalizeRoleModels(DEFAULT_MODEL_ROLES.reviewer)
		expect(reviewers).not.toContain("kimchi-dev/minimax-m3")
	})

	it("planner pool does NOT contain minimax-m3", () => {
		const planners = normalizeRoleModels(DEFAULT_MODEL_ROLES.planner)
		expect(planners).not.toContain("kimchi-dev/minimax-m3")
	})

	it("explorer pool does NOT contain minimax-m3", () => {
		const explorers = normalizeRoleModels(DEFAULT_MODEL_ROLES.explorer)
		expect(explorers).not.toContain("kimchi-dev/minimax-m3")
	})

	it("judge does NOT contain minimax-m3", () => {
		const judges = normalizeRoleModels(DEFAULT_MODEL_ROLES.judge)
		expect(judges).not.toContain("kimchi-dev/minimax-m3")
	})

	it("builder pool still contains kimchi-dev/minimax-m2.7", () => {
		const builders = normalizeRoleModels(DEFAULT_MODEL_ROLES.builder)
		expect(builders).toContain("kimchi-dev/minimax-m2.7")
	})

	it("explorer pool still contains kimchi-dev/nemotron-3-ultra-fp4", () => {
		const explorers = normalizeRoleModels(DEFAULT_MODEL_ROLES.explorer)
		expect(explorers).toContain("kimchi-dev/nemotron-3-ultra-fp4")
	})
})

// ---------------------------------------------------------------------------
// resolveModelRolesForVariant with no variant defaults -> byte-identical to defaults
// ---------------------------------------------------------------------------

describe("resolveModelRolesForVariant: no variant defaults", () => {
	// Use a nonexistent path to isolate from the real settings.json on disk.
	const nonexistentPath = join(tmpdir(), `kimchi-no-settings-base-${process.pid}.json`)

	it("returns DEFAULT_MODEL_ROLES when variantDefaults is undefined", () => {
		const { roles } = resolveModelRolesForVariant(undefined, nonexistentPath)
		expect(roles).toEqual(DEFAULT_MODEL_ROLES)
	})

	it("returns DEFAULT_MODEL_ROLES when variantDefaults is empty object", () => {
		const { roles } = resolveModelRolesForVariant({}, nonexistentPath)
		expect(roles).toEqual(DEFAULT_MODEL_ROLES)
	})
})

// ---------------------------------------------------------------------------
// resolveModelRolesForVariant: variant defaults applied when no user settings
// ---------------------------------------------------------------------------

describe("resolveModelRolesForVariant: variant defaults (no settings.json)", () => {
	const nonexistentPath = join(tmpdir(), `kimchi-no-settings-${process.pid}.json`)

	it("applies variant orchestrator default", () => {
		const { roles } = resolveModelRolesForVariant({ orchestrator: "kimchi-dev/minimax-m3" }, nonexistentPath)
		expect(roles.orchestrator).toBe("kimchi-dev/minimax-m3")
	})

	it("applies variant builder default, leaves other roles at DEFAULT_MODEL_ROLES", () => {
		const { roles } = resolveModelRolesForVariant({ builder: "kimchi-dev/minimax-m3" }, nonexistentPath)
		expect(roles.builder).toBe("kimchi-dev/minimax-m3")
		expect(roles.orchestrator).toBe(DEFAULT_MODEL_ROLES.orchestrator)
		expect(roles.explorer).toEqual(DEFAULT_MODEL_ROLES.explorer)
	})

	it("applies all spicy variant defaults at once", () => {
		const { roles } = resolveModelRolesForVariant(SPICY.modelRoleDefaults, nonexistentPath)
		expect(roles.orchestrator).toBe("kimchi-dev/minimax-m3")
		expect(roles.planner).toBe("kimchi-dev/minimax-m3")
		expect(roles.builder).toBe("kimchi-dev/minimax-m3")
		expect(roles.reviewer).toBe("kimchi-dev/minimax-m3")
		expect(roles.judge).toBe("kimchi-dev/claude-opus-4-6")
		expect(roles.explorer).toBe("kimchi-dev/nemotron-3-ultra-fp4")
	})
})

// ---------------------------------------------------------------------------
// SPICY variant: modelRoleDefaults uses minimax-m3, never minimax-m2.7
// ---------------------------------------------------------------------------

describe("SPICY variant modelRoleDefaults", () => {
	it("modelRoleDefaults is defined", () => {
		expect(SPICY.modelRoleDefaults).toBeDefined()
	})

	it("orchestrator is minimax-m3", () => {
		expect(SPICY.modelRoleDefaults?.orchestrator).toBe("kimchi-dev/minimax-m3")
	})

	it("planner is minimax-m3", () => {
		expect(SPICY.modelRoleDefaults?.planner).toBe("kimchi-dev/minimax-m3")
	})

	it("builder is minimax-m3", () => {
		expect(SPICY.modelRoleDefaults?.builder).toBe("kimchi-dev/minimax-m3")
	})

	it("reviewer is minimax-m3", () => {
		expect(SPICY.modelRoleDefaults?.reviewer).toBe("kimchi-dev/minimax-m3")
	})

	it("judge is claude-opus-4-6", () => {
		expect(SPICY.modelRoleDefaults?.judge).toBe("kimchi-dev/claude-opus-4-6")
	})

	it("explorer is nemotron (light, cheap, 1M-context)", () => {
		expect(SPICY.modelRoleDefaults?.explorer).toBe("kimchi-dev/nemotron-3-ultra-fp4")
	})

	it("does NOT reference minimax-m2.7 anywhere", () => {
		const values = Object.values(SPICY.modelRoleDefaults ?? {})
		for (const v of values) {
			for (const ref of Array.isArray(v) ? v : [v]) {
				expect(ref).not.toContain("minimax-m2.7")
			}
		}
	})
})

// ---------------------------------------------------------------------------
// Precedence: user settings.json wins over variant defaults
// ---------------------------------------------------------------------------

describe("resolveModelRolesForVariant: user settings.json wins over variant defaults", () => {
	const testDir = join(tmpdir(), `kimchi-variant-roles-test-${process.pid}`)
	const testPath = join(testDir, "settings.json")

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true })
		} catch {}
	})

	it("user orchestrator setting overrides variant default", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(testPath, JSON.stringify({ modelRoles: { orchestrator: "kimchi-dev/kimi-k2.5" } }, null, 2))

		const { roles } = resolveModelRolesForVariant({ orchestrator: "kimchi-dev/minimax-m3" }, testPath)
		expect(roles.orchestrator).toBe("kimchi-dev/kimi-k2.5")
	})

	it("user builder setting overrides variant default", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(testPath, JSON.stringify({ modelRoles: { builder: "kimchi-dev/gpt-5.1" } }, null, 2))

		const { roles } = resolveModelRolesForVariant({ builder: "kimchi-dev/minimax-m3" }, testPath)
		expect(roles.builder).toBe("kimchi-dev/gpt-5.1")
	})

	it("unset roles fall back to variant defaults, not hard defaults", () => {
		mkdirSync(testDir, { recursive: true })
		// User only sets orchestrator; builder should come from variant defaults
		writeFileSync(testPath, JSON.stringify({ modelRoles: { orchestrator: "kimchi-dev/kimi-k2.5" } }, null, 2))

		const { roles } = resolveModelRolesForVariant(
			{ orchestrator: "kimchi-dev/minimax-m3", builder: "kimchi-dev/minimax-m3" },
			testPath,
		)
		// User overrides orchestrator
		expect(roles.orchestrator).toBe("kimchi-dev/kimi-k2.5")
		// Variant default applies for builder (user did not set it)
		expect(roles.builder).toBe("kimchi-dev/minimax-m3")
	})

	it("all user settings win: full spicy defaults overridden by user settings", () => {
		mkdirSync(testDir, { recursive: true })
		const userRoles = {
			orchestrator: "kimchi-dev/kimi-k2.5",
			planner: "kimchi-dev/gpt-5.1",
			builder: "openai/gpt-5",
			reviewer: "openai/gpt-5",
			explorer: "openai/gpt-5",
			judge: "kimchi-dev/kimi-k2.5",
		}
		writeFileSync(testPath, JSON.stringify({ modelRoles: userRoles }, null, 2))

		const { roles } = resolveModelRolesForVariant(SPICY.modelRoleDefaults, testPath)
		expect(roles.orchestrator).toBe("kimchi-dev/kimi-k2.5")
		expect(roles.planner).toBe("kimchi-dev/gpt-5.1")
		expect(roles.builder).toBe("openai/gpt-5")
		expect(roles.reviewer).toBe("openai/gpt-5")
		expect(roles.explorer).toBe("openai/gpt-5")
		expect(roles.judge).toBe("kimchi-dev/kimi-k2.5")
	})

	it("returns no warnings when all settings are valid", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(testPath, JSON.stringify({ modelRoles: { orchestrator: "kimchi-dev/kimi-k2.5" } }, null, 2))

		const { warnings } = resolveModelRolesForVariant(SPICY.modelRoleDefaults, testPath)
		expect(warnings).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// PRODUCTION PATH: getModelRoles() is variant-aware (the wiring test)
// ---------------------------------------------------------------------------

describe("getModelRoles(): production singleton is variant-aware", () => {
	it("default variant: orchestrator is kimchi-dev/kimi-k2.6 (no m3)", () => {
		// No KIMCHI_PROMPT_VARIANT set, resolves to DEFAULT_VARIANT
		// Use NO_SETTINGS to isolate from user's ~/.config/kimchi/harness/settings.json
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		const roles = getModelRoles()
		expect(roles.orchestrator).toBe("kimchi-dev/kimi-k2.6")
		expect(roles).toEqual(DEFAULT_MODEL_ROLES)
	})

	it("default variant: minimax-m2.7 is present in builder pool", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		const builders = normalizeRoleModels(getModelRoles().builder)
		expect(builders).toContain("kimchi-dev/minimax-m2.7")
	})

	it("default variant: minimax-m3 does not appear in any role", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		const roles = getModelRoles()
		for (const value of Object.values(roles)) {
			for (const ref of normalizeRoleModels(value)) {
				expect(ref).not.toContain("minimax-m3")
			}
		}
	})

	it("spicy variant: orchestrator is kimchi-dev/minimax-m3", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		process.env[PROMPT_VARIANT_ENV] = SPICY_NAME
		expect(getModelRoles().orchestrator).toBe("kimchi-dev/minimax-m3")
	})

	it("spicy variant: builder is kimchi-dev/minimax-m3", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		process.env[PROMPT_VARIANT_ENV] = SPICY_NAME
		expect(getModelRoles().builder).toBe("kimchi-dev/minimax-m3")
	})

	it("spicy variant: reviewer is kimchi-dev/minimax-m3", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		process.env[PROMPT_VARIANT_ENV] = SPICY_NAME
		expect(getModelRoles().reviewer).toBe("kimchi-dev/minimax-m3")
	})

	it("spicy variant: planner is kimchi-dev/minimax-m3", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		process.env[PROMPT_VARIANT_ENV] = SPICY_NAME
		expect(getModelRoles().planner).toBe("kimchi-dev/minimax-m3")
	})

	it("spicy variant: judge is kimchi-dev/claude-opus-4-6", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		process.env[PROMPT_VARIANT_ENV] = SPICY_NAME
		expect(getModelRoles().judge).toBe("kimchi-dev/claude-opus-4-6")
	})

	it("spicy variant: explorer is nemotron (the light model)", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		process.env[PROMPT_VARIANT_ENV] = SPICY_NAME
		expect(getModelRoles().explorer).toBe("kimchi-dev/nemotron-3-ultra-fp4")
	})

	it("spicy variant: minimax-m2.7 does not appear anywhere", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		process.env[PROMPT_VARIANT_ENV] = SPICY_NAME
		const roles = getModelRoles()
		for (const value of Object.values(roles)) {
			for (const ref of normalizeRoleModels(value)) {
				expect(ref).not.toContain("minimax-m2.7")
			}
		}
	})

	it("getModelRolesWarnings() seeds same singleton as getModelRoles()", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		process.env[PROMPT_VARIANT_ENV] = SPICY_NAME
		// Accessing warnings first should seed the cache
		const warnings = getModelRolesWarnings()
		expect(warnings).toHaveLength(0)
		// getModelRoles() should return the already-seeded spicy roles
		expect(getModelRoles().orchestrator).toBe("kimchi-dev/minimax-m3")
	})

	it("resetModelRolesCache() causes re-resolution on next call", () => {
		process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = NO_SETTINGS
		process.env[PROMPT_VARIANT_ENV] = SPICY_NAME
		expect(getModelRoles().orchestrator).toBe("kimchi-dev/minimax-m3")

		resetModelRolesCache()
		delete process.env[PROMPT_VARIANT_ENV]

		expect(getModelRoles().orchestrator).toBe("kimchi-dev/kimi-k2.6")
	})

	it("user explicit settings.json wins over variant default", () => {
		const testDir = join(tmpdir(), `kimchi-prod-path-user-${process.pid}`)
		const testPath = join(testDir, "settings.json")
		try {
			mkdirSync(testDir, { recursive: true })
			writeFileSync(testPath, JSON.stringify({ modelRoles: { orchestrator: "kimchi-dev/kimi-k2.5" } }, null, 2))
			process.env[MODEL_ROLES_SETTINGS_PATH_ENV] = testPath
			process.env[PROMPT_VARIANT_ENV] = SPICY_NAME
			// User set orchestrator explicitly, beats variant default
			expect(getModelRoles().orchestrator).toBe("kimchi-dev/kimi-k2.5")
			// But builder (not in user settings) comes from spicy variant default
			expect(getModelRoles().builder).toBe("kimchi-dev/minimax-m3")
		} finally {
			rmSync(testDir, { recursive: true, force: true })
		}
	})
})
