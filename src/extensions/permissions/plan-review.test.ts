import { describe, expect, it } from "vitest"
import { isSimplePlan, reviewPlan } from "./plan-review.js"

describe("isSimplePlan", () => {
	it("returns true for a very short 1-chunk plan with no structured sections", () => {
		const plan = "## Chunk 1\nJust one chunk."
		expect(isSimplePlan(plan)).toBe(true)
	})

	it("returns true for a very short unstructured plan", () => {
		const plan = "Fix the typo in login.js"
		expect(isSimplePlan(plan)).toBe(true)
	})

	it("returns false for a multi-chunk plan", () => {
		const plan = `
## Goal
Add feature X and Y.

## Chunk 1: Feature X
Do X.

## Chunk 2: Feature Y
Do Y.
`
		expect(isSimplePlan(plan)).toBe(false)
	})

	it("returns false for a plan with structured sections (Goal / Verification)", () => {
		const plan = `
## Goal
Refactor auth.

## Verification
Check tests.
`
		expect(isSimplePlan(plan)).toBe(false)
	})

	it("returns true when plan is under 5 lines and has no structured sections", () => {
		const plan = "Short thing\nOne more line"
		expect(isSimplePlan(plan)).toBe(true)
	})

	it("returns false when plan has Accept When criteria even if short", () => {
		const plan = "## Chunk 1\nDo it.\nAccept When: done."
		expect(isSimplePlan(plan)).toBe(false)
	})
})

describe("reviewPlan", () => {
	it("approves a simple plan (bypasses checks)", () => {
		const plan = "## Chunk 1\nJust one chunk."
		const result = reviewPlan(plan)
		expect(result.approved).toBe(true)
		expect(result.issues).toHaveLength(0)
		expect(result.simple).toBe(true)
	})

	it("approves a well-structured complex plan", () => {
		const plan = `
## Goal
Add user authentication.

## Chunk 1: Implement login
- Add auth module
Accept When: login works with valid credentials

## Chunk 2: Add tests
- Test auth flows
Accept When: all tests pass

## Verification Strategy
Run the test suite and verify login flow manually.

<!-- PLAN_COMPLETE -->
`
		const result = reviewPlan(plan)
		expect(result.approved).toBe(true)
		expect(result.issues).toHaveLength(0)
		expect(result.simple).toBe(false)
	})

	it("rejects a plan missing Goal", () => {
		const plan = `
## Chunk 1: Do the thing
Do the thing.

## Verification
Run tests.

Accept When: it works.
`
		const result = reviewPlan(plan)
		expect(result.approved).toBe(false)
		expect(result.issues.some((i: string) => i.includes("Goal"))).toBe(true)
	})

	it("rejects a plan missing Verification", () => {
		const plan = `
## Goal
Add feature.

## Chunk 1: Do it
Step by step.

Accept When: done.

<!-- PLAN_COMPLETE -->
`
		const result = reviewPlan(plan)
		expect(result.approved).toBe(false)
		expect(result.issues.some((i: string) => i.includes("Verification"))).toBe(true)
	})

	it("rejects a plan missing Accept When criteria", () => {
		const plan = `
## Goal
Refactor service.

## Chunk 1: Update service
Change the code.

## Verification
Check the build passes.
`
		const result = reviewPlan(plan)
		expect(result.approved).toBe(false)
		expect(result.issues.some((i: string) => i.includes("Accept") || i.includes("Acceptance"))).toBe(true)
	})

	it("returns all issues at once for a plan missing multiple sections", () => {
		const plan = `
## Chunk 1
Just a chunk.

Some extra lines
to make it non-simple.
More content here.
`
		const result = reviewPlan(plan)
		expect(result.approved).toBe(false)
		expect(result.issues.length).toBeGreaterThan(1)
	})

	it("handles case-insensitive section names", () => {
		const plan = `
## GOAL
Add something.

## chunk 1
Do it.

## VERIFICATION
Check it.

### Step 1
Done.
Accept When: it works.
`
		const result = reviewPlan(plan)
		expect(result.approved).toBe(true)
		expect(result.issues).toHaveLength(0)
	})

	it("rejects empty plan", () => {
		const result = reviewPlan("")
		expect(result.approved).toBe(false)
		expect(result.issues.some((i: string) => i.includes("empty"))).toBe(true)
	})

	it("accepts plan with Goals (plural) section", () => {
		const plan = `
## Goals
- Goal one
- Goal two

## Chunk 1
Do it.
Accept When: done.

## Verification
Check.
`
		const result = reviewPlan(plan)
		expect(result.approved).toBe(true)
	})
})
