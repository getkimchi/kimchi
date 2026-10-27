import { execFileSync } from "node:child_process"
import { beforeAll, expect, it } from "vitest"
import golden from "./protocol-golden.json" with { type: "json" }

let actual: {
	events: { body: string; hash: string }[]
	batches: string[]
	stableId: string
	unknown: { body: string; hash: string }
	times: string[]
	errors: string[]
	unicode: string
	validation: boolean[]
	invalidEvidence: boolean[]
	author: { body: string; hash: string; emptyBody: string }
	displayValidation: boolean[]
	target: { body: string; hash: string; invalid: boolean[] }
	hosts: boolean[]
	links: boolean[]
}

const hosts = {
	"gitlab.example.com": true,
	"gitlab.example.com:8443": true,
	"gitlab.example.com:1": true,
	"gitlab.example.com:65535": true,
	"gitlab.example.com:00080": false,
	"gitlab.example.com:08443": false,
	":8443": false,
	"gitlab.example.com:": false,
	"gitlab.example.com:0": false,
	"gitlab.example.com:65536": false,
	"gitlab.example.com:123456": false,
	"gitlab.example.com:80:1": false,
	"gitlab.example.com:8a": false,
	"gitlab.example.com:+80": false,
	"gitlab example.com": false,
	"gitlab.example.com/x": false,
	"user@gitlab.example.com": false,
	"gitlab.example.com:80#": false,
}

/** A repository host, its PR link, and whether they match. */
const links: [string, string, boolean][] = [
	["gitlab.example.com:8443", "https://gitlab.example.com:8443/team/repo/-/merge_requests/3", true],
	["GitLab.example.com:8443", "https://gitlab.EXAMPLE.com:8443/team/repo/-/merge_requests/3", true],
	["gitlab.example.com:8443", "https://gitlab.example.com/team/repo/-/merge_requests/3", false],
	["gitlab.example.com", "https://gitlab.example.com:8443/team/repo/-/merge_requests/3", false],
	["gitlab.example.com:8443", "https://gitlab.example.com:9443/team/repo/-/merge_requests/3", false],
]

beforeAll(() => {
	const moduleUrl = new URL("./protocol.ts", import.meta.url).href
	actual = JSON.parse(
		execFileSync(
			"bun",
			[
				"--eval",
				`import { encodeEvent, encodeBatch, eventHash, stableID, canonicalTime, validateEvent, validateBatch } from ${JSON.stringify(moduleUrl)};
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
const usage = fixture.events[1].input;
const claim = fixture.events[9].input;
const target = {...claim, allocation: {...claim.allocation, targetRepository: {provider: "github", host: "github.com", id: "42", name: "parent/repo"}}};
const pr = fixture.events[5].input;
const authored = {...pr, pullRequest: {...pr.pullRequest, author: "provider-user"}};
const display = [
  {title: "Title", author: ""},
  {title: "Title", author: "a".repeat(255)},
  {title: "Title", author: "界".repeat(255)},
  {title: "Title", author: "👩".repeat(255)},
  {title: "Title", author: "a".repeat(256)},
  {title: "Title", author: "界".repeat(256)},
  {title: "Title", author: "provider\\nuser"},
  {title: "a".repeat(1024)},
  {title: "界".repeat(1024)},
  {title: "👩".repeat(1024)},
  {title: "a".repeat(1025)},
  {title: "界".repeat(1025)},
  {title: "Title\\nbody"},
  {title: "Title", author: 123}
];
const rejects = (operation) => { try { operation(); return false } catch { return true } };
const badEvidence = [
  { ...usage, sourceVersion: "" },
  { ...usage, baseRevision: "0" },
  { ...usage, baseEventId: "" },
  { ...usage, usage: { ...usage.usage, raw: { inputTokens: "-1" } } },
  { ...usage, usage: { ...usage.usage, raw: { inputTokens: "1000000000001" } } },
  { ...usage, usage: { ...usage.usage, raw: { cacheWriteTokens: "9", cacheWrites: [{ttlSeconds: 300, tokens: "10"}] } } },
  { ...usage, usage: { ...usage.usage, raw: { outputTokens: "9", reasoningTokens: "10" } } },
  { ...usage, usage: { ...usage.usage, durationMs: "-1" } },
  { ...usage, usage: { ...usage.usage, durationMs: "86400001" } },
  { ...usage, work: fixture.events[0].input.work },
  { ...claim, usage: { ...claim.usage, requestId: "not-a-uuid" } },
  { ...claim, correction: { ...claim.correction, recordedAt: "1969-12-31T23:59:59.999999999Z" } },
  { ...claim, correction: { ...claim.correction, recordedAt: "2200-01-01T00:00:00Z" } },
  { ...claim, correction: { ...claim.correction, id: "00000000-0000-0000-0000-000000000000" } },
  { ...claim, correction: { ...claim.correction, source: "explicit" } },
  { ...claim, allocation: { ...claim.allocation, kind: "shared" } },
  { ...claim, allocation: { ...claim.allocation, pullRequestIds: ["pr", "pr"] } },
  { ...claim, allocation: { ...claim.allocation, kind: "unlinked" } },
  { ...claim, allocation: { ...claim.allocation, method: "guess" } },
  { ...claim, startedAt: "2026-10-23T13:44:23.715559001Z" },
  { ...claim, claimState: "withdrawn" },
  { ...usage, observeTime: "0001-01-01T00:00:00.000Z" },
  { ...fixture.events[7].input, coverage: { ...fixture.events[7].input.coverage,
    windowStartTime: "2026-10-01T00:00:00.000000002Z", windowEndTime: "2026-10-01T00:00:00.000000001Z" } },
  { ...fixture.events[5].input, pullRequest: { ...fixture.events[5].input.pullRequest, uri: "https://gitlab.com/team/repo/\\npull/1" } }
];
console.log(JSON.stringify({
  events: fixture.events.map(({input}) => ({body: encodeEvent(input), hash: eventHash(input)})),
  batches: fixture.batches.map(({input}) => encodeBatch(input)),
  stableId: stableID(...fixture.stableParts),
  unknown: {body: encodeEvent(unknown), hash: eventHash(unknown)},
  times: ["2026-10-23T12:30:40.123400000+00:00", "2026-10-23T12:30:40.123400000+02:30", "2026-10-23T12:30:40.000Z"].map(canonicalTime),
  errors: invalid.map((event) => { try { encodeEvent(event); return "accepted" } catch (error) { return error.name } }),
  unicode: encodeEvent(unicode),
  author: {body: encodeEvent(authored), hash: eventHash(authored), emptyBody: encodeEvent({...pr, pullRequest: {...pr.pullRequest, author: ""}})},
  displayValidation: display.map((fields) => !rejects(() => validateEvent({...pr, pullRequest: {...pr.pullRequest, ...fields}}))),
  target: {body: encodeEvent(target), hash: eventHash(target), invalid: ["invalid", {}, {provider: "other", host: "github.com", id: "42"}, {provider: "github", host: "secret@github.com", id: "42"}, {provider: "github", host: "github.com", id: "42", name: "repo?secret"}].map((targetRepository) => rejects(() => validateEvent({...claim, allocation: {...claim.allocation, targetRepository}})))},
  hosts: fixture.hosts.map((host) => !rejects(() => validateEvent({...claim, allocation: {...claim.allocation, targetRepository: {provider: "gitlab", host, id: "42"}}}))),
  links: fixture.links.map(([host, uri]) => !rejects(() => validateEvent({...pr, repository: {...pr.repository, host}, pullRequest: {...pr.pullRequest, uri}}))),
  validation: [...fixture.events.map(({input}) => { validateEvent(input); return true }), ...fixture.batches.map(({input}) => { validateBatch(input); return true })],
  invalidEvidence: [...badEvidence.map((event) => rejects(() => validateEvent(event))),
    rejects(() => validateBatch({...fixture.batches[0].input, events: [claim, claim]})),
    rejects(() => validateBatch({...fixture.batches[0].input, events: Array(501).fill(claim)}))]
}));`,
			],
			{ encoding: "utf8", input: JSON.stringify({ ...golden, hosts: Object.keys(hosts), links }), timeout: 30_000 },
		),
	)
})

it("rejects wrong scalar and collection types or overflowing integer values", () => {
	expect(actual.errors).toEqual(Array(15).fill("TypeError"))
})

it("appends and validates an independent allocation target without changing the old claim bytes", () => {
	const allocation = JSON.parse(actual.target.body).allocation
	expect(allocation.targetRepository).toEqual({ provider: "github", host: "github.com", id: "42", name: "parent/repo" })
	expect(Object.keys(allocation).at(-1)).toBe("targetRepository")
	expect(actual.target.hash).not.toBe(golden.events[9].hash)
	expect(actual.target.invalid).toEqual(Array(5).fill(true))
})

it("accepts a repository host with a port from 1 to 65535, no leading zero and nothing else after one colon", () => {
	expect(actual.hosts).toEqual(Object.values(hosts))
})

it("accepts a PR link only on its repository's host and port, in any case", () => {
	expect(actual.links).toEqual(links.map(([, , valid]) => valid))
})

it("uses Go-compatible UTF8 replacement and HTML escaping", () => {
	expect(JSON.parse(actual.unicode).work.title).toBe("\ufffd <>&\u2028")
	expect(actual.unicode).toContain("\\u003c\\u003e\\u0026\\u2028")
})

it("keeps the frozen bytes and local hashes of native payloads and Kimchi claim extensions", () => {
	expect(actual.events).toEqual(golden.events.map(({ body, hash }) => ({ body, hash })))
	expect(actual.batches).toEqual(golden.batches.map(({ body }) => body))
	expect(actual.stableId).toBe(golden.stableId)
	expect(actual.validation).toEqual(Array(13).fill(true))
})

it("rejects invalid usage, claim receipts, identity, CAS and batch bounds", () => {
	expect(actual.invalidEvidence).toEqual(Array(26).fill(true))
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

it("appends provider author with Go-compatible bytes and omits it when unknown", () => {
	expect(actual.author.body).toBe(`${golden.events[5].body.slice(0, -2)},"author":"provider-user"}}`)
	expect(actual.author.hash).toBe("1cf5ca11687791f75411668c102a695b9526c2fbaca3f2df102f2b5a321239f6")
	expect(actual.author.emptyBody).toBe(golden.events[5].body)
})

it("uses legacy Unicode display bounds while rejecting controls and invalid author types", () => {
	expect(actual.displayValidation).toEqual([
		true,
		true,
		true,
		true,
		false,
		false,
		false,
		true,
		true,
		true,
		false,
		false,
		false,
		false,
	])
})
