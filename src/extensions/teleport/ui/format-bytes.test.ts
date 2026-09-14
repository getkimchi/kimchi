import { describe, expect, it } from "vitest"
import { formatBytes, formatK8sBytes, formatK8sBytesPair, formatMillicores } from "./format-bytes.js"

describe("formatMillicores", () => {
	it.each<[number, string]>([
		[0, "0m"],
		[250, "250m"],
		[999, "999m"],
		[1000, "1000m"],
		[1500, "1500m"],
		[2000, "2000m"],
		[1234, "1234m"],
		[16000, "16000m"],
	])("formats %d millicores as %s", (millicores, expected) => {
		expect(formatMillicores(millicores)).toBe(expected)
	})
})

describe("formatK8sBytes", () => {
	it.each<[number, string]>([
		[0, "0"],
		[1000, "1000"],
		[1024, "1Ki"],
		[1048576, "1Mi"],
		[536870912, "512Mi"],
		[1073741824, "1Gi"],
		[1610612736, "1536Mi"],
		[10737418240, "10Gi"],
		[17179869184, "16Gi"],
	])("formats %d bytes as %s", (bytes, expected) => {
		expect(formatK8sBytes(bytes)).toBe(expected)
	})
})

describe("formatK8sBytesPair", () => {
	it.each<[number, number, string]>([
		// the unit comes from max; the current side may need decimals
		[1610612736, 128849018880, "1.5Gi/120Gi"],
		[536870912, 128849018880, "0.5Gi/120Gi"],
		[536870912, 1073741824, "0.5Gi/1Gi"],
		// max that is not a whole multiple of the larger unit keeps both sides smaller
		[1610612736, 1610612736, "1536Mi/1536Mi"],
		[10737418240, 21474836480, "10Gi/20Gi"],
		// below 1Ki both sides are plain bytes; non-divisible max falls back to the largest fitting unit
		[500, 1000, "500/1000"],
		[1048576, 1500000, "1Mi/1.43Mi"],
	])("formats %d/%d bytes as %s", (current, max, expected) => {
		expect(formatK8sBytesPair(current, max)).toBe(expected)
	})
})

describe("formatBytes", () => {
	it.each<[number, string]>([
		[0, "0 B"],
		[999, "999 B"],
		[1073741824, "1.07 GB"],
		[21474836480, "21.47 GB"],
	])("formats %d bytes as %s", (bytes, expected) => {
		expect(formatBytes(bytes)).toBe(expected)
	})
})
