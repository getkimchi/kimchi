/**
 * Unit tests for kimchi.js — the Node.js wrapper.
 * Run with: node --test test/test_wrapper.js
 */

"use strict";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { resolveBinaryPath, runKimchi } = require("../bin/kimchi");

// ---------------------------------------------------------------------------
// resolveBinaryPath
// ---------------------------------------------------------------------------

describe("resolveBinaryPath", () => {
  const origEnvBin = process.env.KIMCHI_BIN_PATH;

  afterEach(() => {
    if (origEnvBin === undefined) delete process.env.KIMCHI_BIN_PATH;
    else process.env.KIMCHI_BIN_PATH = origEnvBin;
  });

  test("returns KIMCHI_BIN_PATH when set and file exists", () => {
    process.env.KIMCHI_BIN_PATH = "/custom/path/to/kimchi";
    const result = resolveBinaryPath({
      existsSync: (p) => p === "/custom/path/to/kimchi",
      statSync: () => ({ isFile: () => true }),
    });
    assert.strictEqual(result, "/custom/path/to/kimchi");
  });

  test("ignores KIMCHI_BIN_PATH when file does not exist", () => {
    process.env.KIMCHI_BIN_PATH = "/nonexistent/path";
    const result = resolveBinaryPath({
      existsSync: () => false,
    });
    assert.strictEqual(result, null);
  });

  test("returns vendor binary path when it exists", () => {
    delete process.env.KIMCHI_BIN_PATH;
    const result = resolveBinaryPath({
      platform: "darwin",
      arch: "arm64",
      existsSync: (p) => p.replace(/\\/g, "/").includes("vendor/darwin-arm64/bin/kimchi"),
      statSync: () => ({ isFile: () => true }),
    });
    assert.ok(result.replace(/\\/g, "/").includes("vendor/darwin-arm64/bin/kimchi"));
  });

  test("returns null when neither env nor vendor binary exists", () => {
    delete process.env.KIMCHI_BIN_PATH;
    const result = resolveBinaryPath({
      platform: "linux",
      arch: "x64",
      existsSync: () => false,
    });
    assert.strictEqual(result, null);
  });

  test("uses .exe extension on Windows", () => {
    delete process.env.KIMCHI_BIN_PATH;
    const result = resolveBinaryPath({
      platform: "win32",
      arch: "x64",
      existsSync: (p) => p.replace(/\\/g, "/").includes("vendor/win32-x64/bin/kimchi.exe"),
      statSync: () => ({ isFile: () => true }),
    });
    assert.ok(result.endsWith("kimchi.exe"));
  });

  test("no .exe extension on Unix", () => {
    delete process.env.KIMCHI_BIN_PATH;
    const result = resolveBinaryPath({
      platform: "linux",
      arch: "arm64",
      existsSync: (p) => p.replace(/\\/g, "/").includes("vendor/linux-arm64/bin/kimchi"),
      statSync: () => ({ isFile: () => true }),
    });
    assert.ok(result.endsWith("kimchi"));
    assert.ok(!result.endsWith(".exe"));
  });
});

// ---------------------------------------------------------------------------
// runKimchi (mocked spawn)
// ---------------------------------------------------------------------------

describe("runKimchi", () => {
  test("spawns binary with passed arguments", async () => {
    let spawnBin, spawnArgs, spawnOpts;
    const mockSpawn = (bin, args, opts) => {
      spawnBin = bin;
      spawnArgs = args;
      spawnOpts = opts;
      return {
        on: (event, cb) => {
          if (event === "close") setTimeout(() => cb(0), 0);
        },
      };
    };

    const code = await runKimchi(["--version"], {
      spawnImpl: mockSpawn,
      binaryPath: "/path/to/kimchi",
    });

    assert.strictEqual(code, 0);
    assert.strictEqual(spawnBin, "/path/to/kimchi");
    assert.deepStrictEqual(spawnArgs, ["--version"]);
    assert.strictEqual(spawnOpts.stdio, "inherit");
  });

  test("forwards all argv arguments", async () => {
    let spawnArgs;
    const mockSpawn = (bin, args) => {
      spawnArgs = args;
      return {
        on: (event, cb) => {
          if (event === "close") setTimeout(() => cb(0), 0);
        },
      };
    };

    await runKimchi(["--print", "hello world", "--model", "kimi"], {
      spawnImpl: mockSpawn,
      binaryPath: "/path/to/kimchi",
    });

    assert.deepStrictEqual(spawnArgs, ["--print", "hello world", "--model", "kimi"]);
  });

  test("exits with binary's exit code (0)", async () => {
    const mockSpawn = () => ({
      on: (event, cb) => {
        if (event === "close") setTimeout(() => cb(0, null), 0);
      },
    });

    const code = await runKimchi(["--help"], {
      spawnImpl: mockSpawn,
      binaryPath: "/path/to/kimchi",
    });
    assert.strictEqual(code, 0);
  });

  test("exits with binary's exit code (non-zero)", async () => {
    const mockSpawn = () => ({
      on: (event, cb) => {
        if (event === "close") setTimeout(() => cb(1, null), 0);
      },
    });

    const code = await runKimchi(["--bad-flag"], {
      spawnImpl: mockSpawn,
      binaryPath: "/path/to/kimchi",
    });
    assert.strictEqual(code, 1);
  });

  test("exits with 128+signal when killed by signal", async () => {
    const mockSpawn = () => ({
      on: (event, cb) => {
        if (event === "close") setTimeout(() => cb(null, "SIGTERM"), 0);
      },
    });

    const code = await runKimchi([], {
      spawnImpl: mockSpawn,
      binaryPath: "/path/to/kimchi",
    });
    assert.strictEqual(code, 128 + os.constants.signals.SIGTERM);
  });

  test("exits with 128+signal for SIGKILL", async () => {
    const mockSpawn = () => ({
      on: (event, cb) => {
        if (event === "close") setTimeout(() => cb(null, "SIGKILL"), 0);
      },
    });

    const code = await runKimchi([], {
      spawnImpl: mockSpawn,
      binaryPath: "/path/to/kimchi",
    });
    assert.strictEqual(code, 128 + os.constants.signals.SIGKILL);
  });

  test("exits with 1 for unknown signal", async () => {
    const mockSpawn = () => ({
      on: (event, cb) => {
        if (event === "close") setTimeout(() => cb(null, "SIGFAKE"), 0);
      },
    });

    const code = await runKimchi([], {
      spawnImpl: mockSpawn,
      binaryPath: "/path/to/kimchi",
    });
    assert.strictEqual(code, 1);
  });

  test("returns exit code 1 on ENOENT (binary not found)", async () => {
    const mockSpawn = () => ({
      on: (event, cb) => {
        if (event === "error")
          setTimeout(() => cb({ code: "ENOENT", message: "not found" }), 0);
      },
    });

    const code = await runKimchi(["--version"], {
      spawnImpl: mockSpawn,
      binaryPath: "/nonexistent/kimchi",
    });
    assert.strictEqual(code, 1);
  });

  test("returns exit code 1 on other spawn errors", async () => {
    const mockSpawn = () => ({
      on: (event, cb) => {
        if (event === "error")
          setTimeout(() => cb({ code: "EACCES", message: "permission denied" }), 0);
      },
    });

    const code = await runKimchi(["--version"], {
      spawnImpl: mockSpawn,
      binaryPath: "/path/to/kimchi",
    });
    assert.strictEqual(code, 1);
  });

  test("falls back to system 'kimchi' when binaryPath is null", async () => {
    let spawnBin;
    const mockSpawn = (bin) => {
      spawnBin = bin;
      return {
        on: (event, cb) => {
          if (event === "close") setTimeout(() => cb(0, null), 0);
        },
      };
    };

    // Suppress console.warn during this test using try/finally
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const code = await runKimchi(["--version"], {
        spawnImpl: mockSpawn,
        binaryPath: null,
      });

      assert.strictEqual(code, 0);
      assert.strictEqual(spawnBin, "kimchi");
    } finally {
      console.warn = origWarn;
    }
  });
});
