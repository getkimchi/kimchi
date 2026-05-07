/**
 * Tests for `buildBehaviours` — the parse + uniqueness validator that the
 * bundled registry uses at module load.
 *
 * The bundled `behaviours` array is not imported here: it transitively pulls
 * in markdown bodies via Bun's `with { type: "text" }` text imports, which
 * vitest/rollup cannot resolve without extra plugin config. Validating the
 * pure builder against synthetic sources covers the contract — the bundled
 * registry runs the same function on startup, so a duplicate or unreachable
 * triggered source would fail loudly at harness boot.
 */

import { describe, expect, it } from "vitest"
import { type BehaviourSource, buildBehaviours } from "./build.js"
import { tool } from "./triggers.js"

const validBody = (name: string) => `---
name: ${name}
description: ${name} body
---

content of ${name}
`

describe("buildBehaviours", () => {
	it("parses a single source and returns the corresponding Behaviour", () => {
		const sources: BehaviourSource[] = [{ raw: validBody("a"), kind: "baseline" }]
		const result = buildBehaviours(sources)
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("a")
		expect(result[0].kind).toBe("baseline")
		expect(result[0].body).toContain("content of a")
	})

	it("preserves source order in the output", () => {
		const sources: BehaviourSource[] = [
			{ raw: validBody("a"), kind: "baseline" },
			{ raw: validBody("b"), kind: "triggered", triggers: { tool: tool("bash") } },
			{ raw: validBody("c"), kind: "baseline" },
		]
		expect(buildBehaviours(sources).map((b) => b.name)).toEqual(["a", "b", "c"])
	})

	it("throws when two sources declare the same name", () => {
		const sources: BehaviourSource[] = [
			{ raw: validBody("dup"), kind: "baseline" },
			{ raw: validBody("dup"), kind: "triggered", triggers: { tool: tool("bash") } },
		]
		expect(() => buildBehaviours(sources)).toThrowError(/duplicate bundled behaviour name: dup/)
	})

	it("throws when two sources declare the same name even with different bodies", () => {
		const a = `---
name: shared
description: first
---

body a
`
		const b = `---
name: shared
description: second
---

body b
`
		expect(() =>
			buildBehaviours([
				{ raw: a, kind: "baseline" },
				{ raw: b, kind: "triggered", triggers: { tool: tool("bash") } },
			]),
		).toThrowError(/duplicate bundled behaviour name: shared/)
	})

	it("throws when a triggered source has no session probe and no tool matcher", () => {
		expect(() => buildBehaviours([{ raw: validBody("orphan"), kind: "triggered", triggers: {} }])).toThrowError(
			/triggered behaviour orphan has no session or tool trigger/,
		)
	})

	it("throws when a source has malformed frontmatter", () => {
		const malformed = "no frontmatter here"
		expect(() => buildBehaviours([{ raw: malformed, kind: "baseline" }])).toThrow()
	})

	it("returns an empty array for an empty source list", () => {
		expect(buildBehaviours([])).toEqual([])
	})
})
