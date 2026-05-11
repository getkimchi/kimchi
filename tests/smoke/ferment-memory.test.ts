import { describe, expect, it } from "vitest"
import { runBinary } from "./harness.js"

describe("ferment-memory smoke", () => {
  it("writes and reads a memory entry back through two binary invocations", () => {
    const key = "ferment-smoke-1"
    
    // First invocation: write via kimchi memory set
    const writeResult = runBinary({
      args: ["memory", "set", key, "regression in test X", "--scope", "local"],
    })
    expect(writeResult.status).toBe(0)
    expect(writeResult.stdout).toContain("Written:")

    // Second invocation: read back via kimchi memory get
    const readResult = runBinary({
      args: ["memory", "get", key, "--scope", "local"],
    })
    expect(readResult.status).toBe(0)
    expect(readResult.stdout.trim()).toBe("regression in test X")
  })

  it("rejects path traversal in key argument", () => {
    const result = runBinary({
      args: ["memory", "get", "../../../etc/passwd"],
      throwOnError: false,
    })
    expect(result.status).not.toBe(0)
  })
})
