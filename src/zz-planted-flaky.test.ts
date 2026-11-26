import { expect, it } from "vitest"

it.runIf(process.env.CI)("zz-planted-flaky passes only after a retry", ({ task }) => {
	expect(task.result?.retryCount ?? 0).toBeGreaterThan(0)
})
