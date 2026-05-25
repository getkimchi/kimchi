import { describe, expect, it } from "vitest"
import { parseTerminalArgs } from "./args.js"

describe("parseTerminalArgs", () => {
	it("parses simple host", () => {
		expect(parseTerminalArgs("example.com")).toEqual({
			host: "example.com",
			port: 22,
			user: undefined,
		})
	})

	it("parses user@host", () => {
		expect(parseTerminalArgs("user@example.com")).toEqual({
			host: "example.com",
			port: 22,
			user: "user",
		})
	})

	it("parses host with port", () => {
		expect(parseTerminalArgs("example.com:2222")).toEqual({
			host: "example.com",
			port: 2222,
			user: undefined,
		})
	})

	it("parses full user@host:port", () => {
		expect(parseTerminalArgs("admin@example.com:2222")).toEqual({
			host: "example.com",
			port: 2222,
			user: "admin",
		})
	})

	it("parses IPv6 host", () => {
		expect(parseTerminalArgs("[2001:db8::1]")).toEqual({
			host: "2001:db8::1",
			port: 22,
			user: undefined,
		})
	})

	it("parses IPv6 with port", () => {
		expect(parseTerminalArgs("[2001:db8::1]:2222")).toEqual({
			host: "2001:db8::1",
			port: 2222,
			user: undefined,
		})
	})

	it("throws on empty input", () => {
		expect(() => parseTerminalArgs("")).toThrow()
	})
})
