import { expect, it } from "vitest"
import {
	getClientOptedIntoArtifacts,
	getClientOptedIntoMcpOAuthTurn,
	getClientOptedIntoPRMonitoring,
	getClientOptedIntoSessionMessages,
} from "./capabilities.js"

it.each([
	{ flags: undefined, allowed: false },
	{ flags: {}, allowed: false },
	{ flags: { artifacts: false }, allowed: false },
	{ flags: { artifacts: true }, allowed: true },
])("requires an explicit artifact opt-in: $flags", ({ flags, allowed }) => {
	expect(getClientOptedIntoArtifacts(flags ? { _meta: { "kimchi.dev": flags } } : undefined)).toBe(allowed)
})

it.each([
	{ flags: undefined, allowed: false },
	{ flags: {}, allowed: false },
	{ flags: { backgroundRuns: true }, allowed: false },
	{ flags: { mcpOAuthTurn: false }, allowed: false },
	{ flags: { mcpOAuthTurn: "true" }, allowed: false },
	{ flags: { mcpOAuthTurn: true }, allowed: true },
])("requires explicit MCP OAuth turn opt-in: $flags", ({ flags, allowed }) => {
	expect(getClientOptedIntoMcpOAuthTurn(flags ? { _meta: { "kimchi.dev": flags } } : undefined)).toBe(allowed)
})

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

it.each([
	{ flags: undefined, allowed: false },
	{ flags: { backgroundRuns: true }, allowed: false },
	{ flags: { sessionMessages: true }, allowed: false },
	{ flags: { backgroundRuns: true, sessionMessages: false }, allowed: false },
	{ flags: { backgroundRuns: true, sessionMessages: true }, allowed: true },
])("requires both session messages and background-run support: $flags", ({ flags, allowed }) => {
	expect(getClientOptedIntoSessionMessages(flags ? { _meta: { "kimchi.dev": flags } } : undefined)).toBe(allowed)
})
