import { describe, expect, it } from "vitest"
import { prepareBillingTag } from "./request-tags.js"

const ID = "11111111-2222-4333-8444-555555555555"
const TAG = `kimchi-request:${ID}`

describe("per-attempt billing tags", () => {
	it("adds one tag while preserving every user tag and ignoring blank entries", () => {
		const headers = new Headers({ "X-Tags": " team:a , ,source:b ", "X-LiteLLM-Tags": "project:c" })
		const result = prepareBillingTag(headers, ["body:d", "   "], ID, () => false)
		expect(result.billingTag).toBe(TAG)
		expect(result.header).toBe(`team:a , ,source:b,${TAG}`)
		expect(headers.get("X-LiteLLM-Tags")).toBe("project:c")
	})
	it("counts combined entries before deduplication and uses only the final free slot", () => {
		const headers = new Headers({ "X-Tags": "team:a,team:a", "X-LiteLLM-Tags": "team:a,team:a" })
		expect(prepareBillingTag(headers, Array(5).fill("team:a"), ID, () => false).billingTag).toBe(TAG)
		expect(prepareBillingTag(headers, Array(6).fill("team:a"), ID, () => false)).toMatchObject({
			billingTagSkipped: "tag-limit",
		})
	})
	it.each(["body", "X-Tags", "X-LiteLLM-Tags"])("preserves a conflicting reserved key from %s", (location) => {
		const value = "kimchi-request:user-value"
		const headers = new Headers(location === "body" ? {} : { [location]: value })
		expect(prepareBillingTag(headers, location === "body" ? [value] : [], ID, () => false)).toMatchObject({
			billingTagSkipped: "reserved-tag",
		})
		if (location !== "body") expect(headers.get(location)).toBe(value)
	})
	it("replaces only a known prior retry header, including duplicated copies", () => {
		const old = "kimchi-request:22222222-2222-4333-8444-555555555555"
		const headers = new Headers({ "X-Tags": `team:a,${old},${old}` })
		const result = prepareBillingTag(headers, [], ID, (tag) => tag === old)
		expect(result.header).toBe(`team:a,${TAG}`)
		expect(headers.get("X-Tags")).toBe("team:a")
	})
	it("removes our old retry tag even when the new body cannot be inspected", () => {
		const old = "kimchi-request:22222222-2222-4333-8444-555555555555"
		const headers = new Headers({ "X-Tags": `team:a,${old}` })
		expect(prepareBillingTag(headers, undefined, ID, (tag) => tag === old)).toMatchObject({
			billingTagSkipped: "body-uninspectable",
		})
		expect(headers.get("X-Tags")).toBe("team:a")
	})
})
