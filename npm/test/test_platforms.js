/**
 * Unit tests for platform detection and platforms.json mapping.
 * Run with: node --test test/test_platforms.js
 */

const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");

const platformsPath = path.join(__dirname, "..", "bin", "platforms.json");
const platforms = JSON.parse(fs.readFileSync(platformsPath, "utf8"));

// Import the real function from postinstall.js
const { getPlatformKey } = require("../bin/postinstall");

const SUPPORTED_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
];

describe("platforms.json structure", () => {
  test("contains exactly 5 supported platform+arch combos", () => {
    assert.strictEqual(
      Object.keys(platforms).length,
      5,
      "Expected exactly 5 platform entries"
    );
  });

  test("has all required keys", () => {
    for (const key of SUPPORTED_KEYS) {
      assert.ok(key in platforms, `Missing platform key: ${key}`);
    }
  });

  test("each entry has asset and archiveType", () => {
    for (const [key, entry] of Object.entries(platforms)) {
      assert.ok(entry.asset, `${key} missing "asset" field`);
      assert.ok(entry.archiveType, `${key} missing "archiveType" field`);
      assert.ok(
        ["tar.gz", "zip"].includes(entry.archiveType),
        `${key} has invalid archiveType: ${entry.archiveType}`
      );
    }
  });

  test("Windows asset is a zip", () => {
    assert.strictEqual(platforms["win32-x64"].archiveType, "zip");
    assert.ok(platforms["win32-x64"].asset.endsWith(".zip"));
  });

  test("non-Windows assets are tar.gz", () => {
    for (const [key, entry] of Object.entries(platforms)) {
      if (key.startsWith("win32")) continue;
      assert.strictEqual(entry.archiveType, "tar.gz", `${key} should be tar.gz`);
      assert.ok(entry.asset.endsWith(".tar.gz"), `${key} asset should end with .tar.gz`);
    }
  });

  test("no Windows arm64 build exists", () => {
    assert.ok(!("win32-arm64" in platforms), "Windows arm64 should not be supported yet");
  });
});

describe("platform key resolution", () => {

  test("darwin arm64 resolves to correct key", () => {
    const key = getPlatformKey("darwin", "arm64");
    assert.ok(key in platforms, `${key} should be in platforms.json`);
    assert.strictEqual(platforms[key].asset, "kimchi_darwin_arm64.tar.gz");
  });

  test("darwin x64 resolves to correct key", () => {
    const key = getPlatformKey("darwin", "x64");
    assert.ok(key in platforms, `${key} should be in platforms.json`);
    assert.strictEqual(platforms[key].asset, "kimchi_darwin_amd64.tar.gz");
  });

  test("linux arm64 resolves to correct key", () => {
    const key = getPlatformKey("linux", "arm64");
    assert.ok(key in platforms, `${key} should be in platforms.json`);
    assert.strictEqual(platforms[key].asset, "kimchi_linux_arm64.tar.gz");
  });

  test("linux x64 resolves to correct key", () => {
    const key = getPlatformKey("linux", "x64");
    assert.ok(key in platforms, `${key} should be in platforms.json`);
    assert.strictEqual(platforms[key].asset, "kimchi_linux_amd64.tar.gz");
  });

  test("win32 x64 resolves to correct key", () => {
    const key = getPlatformKey("win32", "x64");
    assert.ok(key in platforms, `${key} should be in platforms.json`);
    assert.strictEqual(platforms[key].asset, "kimchi_windows_amd64.zip");
  });

  test("unsupported platform key is not in platforms.json", () => {
    const key = getPlatformKey("freebsd", "x64");
    assert.ok(!(key in platforms), "freebsd should not be supported");
  });

  test("current runtime platform is supported", () => {
    const currentKey = getPlatformKey(process.platform, process.arch);
    assert.ok(
      currentKey in platforms,
      `Current platform (${currentKey}) must be in platforms.json — if this fails, the package doesn't support your OS/arch`
    );
  });
});
