import { execFileSync } from "node:child_process"
import { beforeAll, expect, it } from "vitest"
import golden from "./protocol-golden.json" with { type: "json" }

let actual: {
	events: { body: string; hash: string }[]
	batches: { body: string; hash: string }[]
	stableId: string
	unknown: { body: string; hash: string }
	times: string[]
	errors: string[]
	unicode: string
}

beforeAll(() => {
	const moduleUrl = new URL("./protocol.ts", import.meta.url).href
	actual = JSON.parse(
		execFileSync(
			"bun",
			[
				"--eval",
				`import { encodeEvent, encodeBatch, eventHash, batchHash, stableID, canonicalTime } from ${JSON.stringify(moduleUrl)};
const fixture = await Bun.stdin.json();
const unknown = structuredClone(fixture.events[1].input);
delete unknown.usage.raw.cacheReadTokens;
const invalid = [
  { ...unknown, revision: 1 },
  { ...unknown, revision: "9223372036854775808" },
  { ...unknown, usage: { ...unknown.usage, raw: { inputTokens: "1e3" } } },
  { ...unknown, usage: { ...unknown.usage, attemptsComplete: "true" } },
  { ...unknown, usage: { ...unknown.usage, raw: { cacheWrites: "invalid" } } },
  { ...unknown, sourceVersion: 3 },
  { ...unknown, repository: "invalid" },
  { ...unknown, observeTime: [] },
  { ...unknown, correction: { id: "correction", revision: 1.5, recordedAt: unknown.observeTime, source: "explicit" } },
  { ...unknown, correction: { id: "correction", revision: 2147483648, recordedAt: unknown.observeTime, source: "explicit" } },
  { ...unknown, correction: { id: "correction", revision: -2147483649, recordedAt: unknown.observeTime, source: "explicit" } },
  { ...unknown, usage: { ...unknown.usage, raw: { cacheWrites: [{ttlSeconds: 2147483648, tokens: "0"}] } } },
  { ...unknown, usage: undefined, pullRequest: {id: "pr", number: 2147483648, uri: "https://example.com/pr/1", state: "open"} },
  { ...unknown, observeTime: "+010000-01-01T00:00:00Z" },
  { ...unknown, observeTime: "-000001-01-01T00:00:00Z" }
];
const unicode = structuredClone(fixture.events[0].input);
unicode.work.title = "\\ud800 <>&\\u2028";
console.log(JSON.stringify({
  events: fixture.events.map(({input}) => ({body: encodeEvent(input), hash: eventHash(input)})),
  batches: fixture.batches.map(({input}) => ({body: encodeBatch(input), hash: batchHash(input)})),
  stableId: stableID(...fixture.stableParts),
  unknown: {body: encodeEvent(unknown), hash: eventHash(unknown)},
  times: ["2026-10-23T12:30:40.123400000+00:00", "2026-10-23T12:30:40.123400000+02:30", "2026-10-23T12:30:40.000Z"].map(canonicalTime),
  errors: invalid.map((event) => { try { encodeEvent(event); return "accepted" } catch (error) { return error.name } }),
  unicode: encodeEvent(unicode)
}));`,
			],
			{ encoding: "utf8", input: JSON.stringify(golden), timeout: 30_000 },
		),
	)
})

it("rejects wrong scalar and collection types or overflowing integer values", () => {
	expect(actual.errors).toEqual(Array(15).fill("TypeError"))
})

it("uses Go-compatible UTF8 replacement and HTML escaping", () => {
	expect(JSON.parse(actual.unicode).work.title).toBe("\ufffd <>&\u2028")
	expect(actual.unicode).toContain("\\u003c\\u003e\\u0026\\u2028")
})

it("matches Go bytes and hashes for all native payloads and Kimchi claim extensions", () => {
	expect(actual.events).toEqual(golden.events.map(({ body, hash }) => ({ body, hash })))
	expect(actual.batches).toEqual(golden.batches.map(({ body, hash }) => ({ body, hash })))
	expect(actual.batches[0].hash).toBe(golden.oracle.nativeV1BatchHash)
	expect(actual.stableId).toBe(golden.stableId)
})

it("keeps unknown counters distinct from reported zero and omits absent claim extensions", () => {
	expect(actual.unknown.hash).not.toBe(actual.events[1].hash)
	expect(JSON.parse(actual.unknown.body).usage.raw).not.toHaveProperty("cacheReadTokens")
	expect(JSON.parse(actual.events[1].body).usage.raw.cacheReadTokens).toBe("0")
	for (const key of ["allocation", "claimState", "correction", "startedAt"])
		expect(JSON.parse(actual.events[8].body)).not.toHaveProperty(key)
	const claim = JSON.parse(actual.events[9].body)
	expect(claim.revision).toBe("1")
	expect(claim.correction.revision).toBe(3)
	expect(Object.keys(claim).slice(-4)).toEqual(["allocation", "claimState", "correction", "startedAt"])
})

it("preserves nanoseconds and offsets while canonicalizing zero offsets and trailing zeros", () => {
	expect(JSON.parse(actual.events[0].body).observeTime).toBe("2026-10-23T12:30:40.123456789Z")
	expect(actual.times).toEqual(["2026-10-23T12:30:40.1234Z", "2026-10-23T12:30:40.1234+02:30", "2026-10-23T12:30:40Z"])
})
