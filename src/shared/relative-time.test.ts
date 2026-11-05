import { describe, expect, it } from "vitest"
import { formatRelativeTime } from "./relative-time.js"

const now = new Date("2026-11-05T12:00:00Z")
const ago = (ms: number) => new Date(now.getTime() - ms)

describe("formatRelativeTime", () => {
	it("renders future and sub-minute timestamps as just now", () => {
		expect(formatRelativeTime(new Date(now.getTime() + 60_000), now)).toBe("just now")
		expect(formatRelativeTime(ago(30_000), now)).toBe("just now")
	})

	it("renders minutes, hours, yesterday, and days", () => {
		expect(formatRelativeTime(ago(5 * 60_000), now)).toBe("5m ago")
		expect(formatRelativeTime(ago(2 * 3_600_000), now)).toBe("2h ago")
		expect(formatRelativeTime(ago(26 * 3_600_000), now)).toBe("yesterday")
		expect(formatRelativeTime(ago(3 * 86_400_000), now)).toBe("3d ago")
	})
})
