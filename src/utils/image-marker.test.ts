import { describe, expect, it } from "vitest"
import {
	buildImageMarker,
	leadingImageMarker,
	parseImageMarkers,
	stripImageMarkers,
	trailingImageMarker,
} from "./image-marker.js"

describe("buildImageMarker", () => {
	it("renders the canonical marker format", () => {
		expect(buildImageMarker(1)).toBe("[Image #1]")
		expect(buildImageMarker(42)).toBe("[Image #42]")
	})
})

describe("parseImageMarkers", () => {
	it("finds every marker id, deduped", () => {
		expect(parseImageMarkers("[Image #2] and [Image #1] and [Image #2]")).toEqual(new Set([2, 1]))
	})

	it("returns an empty set when there are no markers", () => {
		expect(parseImageMarkers("no images here")).toEqual(new Set())
	})

	it("does not match lookalikes that are not the canonical format", () => {
		expect(parseImageMarkers("[Image#1] [Image  #2] [image #3]")).toEqual(new Set())
	})
})

describe("stripImageMarkers", () => {
	it("removes the marker and one trailing space for the given ids", () => {
		expect(stripImageMarkers("[Image #1] hello [Image #2] again", [1, 2])).toBe("hello again")
	})

	it("leaves markers for other ids untouched", () => {
		expect(stripImageMarkers("[Image #1] hello [Image #2] again", [2])).toBe("[Image #1] hello again")
	})

	it("removes only the marker plus ONE trailing space at string end", () => {
		expect(stripImageMarkers("[Image #1] hello [Image #2]", [2])).toBe("[Image #1] hello ")
	})

	it("is a no-op for an empty id list", () => {
		expect(stripImageMarkers("[Image #1] hi", [])).toBe("[Image #1] hi")
	})
})

describe("trailingImageMarker", () => {
	it("matches a full marker anchored at string end", () => {
		expect(trailingImageMarker("fix [Image #1]")).toBe("[Image #1]")
	})

	it("returns null when the marker is partial or not at the end", () => {
		expect(trailingImageMarker("fix [Image #1")).toBeNull()
		expect(trailingImageMarker("[Image #1] tail")).toBeNull()
	})
})

describe("leadingImageMarker", () => {
	it("matches a full marker anchored at string start", () => {
		expect(leadingImageMarker("[Image #12] tail")).toBe("[Image #12]")
	})

	it("returns null when the marker is partial or not at the start", () => {
		expect(leadingImageMarker("[Image #1")).toBeNull()
		expect(leadingImageMarker("x[Image #1]")).toBeNull()
	})
})
