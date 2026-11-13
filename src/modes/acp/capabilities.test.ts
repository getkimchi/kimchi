import { expect, it } from "vitest"
import { getClientOptedIntoPRMonitoring } from "./capabilities.js"

it.each([
	{ flags: undefined, allowed: false },
	{ flags: {}, allowed: false },
	{ flags: { backgroundRuns: true }, allowed: false },
	{ flags: { prMonitoring: true }, allowed: false },
	{ flags: { backgroundRuns: true, prMonitoring: false }, allowed: false },
	{ flags: { backgroundRuns: false, prMonitoring: true }, allowed: false },
	{ flags: { backgroundRuns: true, prMonitoring: true }, allowed: true },
])("requires both PR monitoring and background-run support: $flags", ({ flags, allowed }) => {
	expect(getClientOptedIntoPRMonitoring(flags ? { _meta: { "kimchi.dev": flags } } : undefined)).toBe(allowed)
})
