/**
 * Unit tests for postinstall.js — binary download and extraction logic.
 * Run with: node --test test/test_postinstall.js
 */

"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const {
  getPlatformKey,
  loadPlatforms,
  resolvePlatform,
  resolveVersion,
  buildDownloadUrl,
  buildChecksumUrl,
  downloadFile,
  isRetryableError,
  computeSha256,
  parseChecksums,
  verifyChecksum,
  extractArchive,
  makeExecutable,
  getProxyUrl,
  REPO,
} = require("../bin/postinstall");

const platforms = loadPlatforms();

// ---------------------------------------------------------------------------
// resolvePlatform
// ---------------------------------------------------------------------------

describe("resolvePlatform", () => {
  test("resolves darwin-arm64", () => {
    const result = resolvePlatform(platforms, "darwin", "arm64");
    assert.strictEqual(result.key, "darwin-arm64");
    assert.strictEqual(result.asset, "kimchi_darwin_arm64.tar.gz");
    assert.strictEqual(result.archiveType, "tar.gz");
  });

  test("resolves linux-x64 (maps to amd64 asset)", () => {
    const result = resolvePlatform(platforms, "linux", "x64");
    assert.strictEqual(result.key, "linux-x64");
    assert.strictEqual(result.asset, "kimchi_linux_amd64.tar.gz");
  });

  test("resolves win32-x64", () => {
    const result = resolvePlatform(platforms, "win32", "x64");
    assert.strictEqual(result.key, "win32-x64");
    assert.strictEqual(result.asset, "kimchi_windows_amd64.zip");
    assert.strictEqual(result.archiveType, "zip");
  });

  test("throws on unsupported platform", () => {
    assert.throws(
      () => resolvePlatform(platforms, "freebsd", "x64"),
      /does not ship a pre-built binary/
    );
  });

  test("throws on unsupported arch (arm64 Windows)", () => {
    assert.throws(
      () => resolvePlatform(platforms, "win32", "arm64"),
      /does not ship a pre-built binary/
    );
  });

  test("error message includes supported platforms list", () => {
    assert.throws(
      () => resolvePlatform(platforms, "aix", "ppc64"),
      (err) => {
        assert.ok(err.message.includes("darwin-arm64"));
        assert.ok(err.message.includes("win32-x64"));
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// resolveVersion
// ---------------------------------------------------------------------------

describe("resolveVersion", { concurrency: 1 }, () => {
  const origEnv = process.env.KIMCHI_VERSION;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.KIMCHI_VERSION;
    else process.env.KIMCHI_VERSION = origEnv;
  });

  test("uses KIMCHI_VERSION env var when set", () => {
    process.env.KIMCHI_VERSION = "v0.1.80";
    assert.strictEqual(resolveVersion("0.1.84"), "v0.1.80");
  });

  test("prepends 'v' to KIMCHI_VERSION if missing", () => {
    process.env.KIMCHI_VERSION = "0.1.80";
    assert.strictEqual(resolveVersion("0.1.84"), "v0.1.80");
  });

  test("uses package version when it's a real release", () => {
    delete process.env.KIMCHI_VERSION;
    assert.strictEqual(resolveVersion("0.1.84"), "v0.1.84");
  });

  test("falls back to 'latest' when version is 0.0.0 (dev placeholder)", () => {
    delete process.env.KIMCHI_VERSION;
    assert.strictEqual(resolveVersion("0.0.0"), "latest");
  });

  test("falls back to 'latest' when no version available", () => {
    delete process.env.KIMCHI_VERSION;
    assert.strictEqual(resolveVersion(undefined), "latest");
  });
});

// ---------------------------------------------------------------------------
// buildDownloadUrl & buildChecksumUrl
// ---------------------------------------------------------------------------

describe("buildDownloadUrl", () => {
  test("builds correct URL for tagged version", () => {
    const url = buildDownloadUrl("v0.1.84", "kimchi_darwin_arm64.tar.gz");
    assert.strictEqual(
      url,
      "https://github.com/getkimchi/kimchi/releases/download/v0.1.84/kimchi_darwin_arm64.tar.gz"
    );
  });

  test("builds correct URL for 'latest'", () => {
    const url = buildDownloadUrl("latest", "kimchi_linux_amd64.tar.gz");
    assert.strictEqual(
      url,
      "https://github.com/getkimchi/kimchi/releases/latest/download/kimchi_linux_amd64.tar.gz"
    );
  });

  test("builds correct URL for Windows zip", () => {
    const url = buildDownloadUrl("v0.1.84", "kimchi_windows_amd64.zip");
    assert.ok(url.endsWith("kimchi_windows_amd64.zip"));
  });
});

describe("buildChecksumUrl", () => {
  test("builds checksum URL for tagged version", () => {
    const url = buildChecksumUrl("v0.1.84");
    assert.strictEqual(
      url,
      "https://github.com/getkimchi/kimchi/releases/download/v0.1.84/checksums.txt"
    );
  });

  test("builds checksum URL for 'latest'", () => {
    const url = buildChecksumUrl("latest");
    assert.strictEqual(
      url,
      "https://github.com/getkimchi/kimchi/releases/latest/download/checksums.txt"
    );
  });
});

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe("isRetryableError", () => {
  test("retries on network errors (no statusCode)", () => {
    const err = new Error("ECONNRESET");
    assert.strictEqual(isRetryableError(err), true);
  });

  test("retries on 500 server errors", () => {
    const err = new Error("HTTP 500");
    err.statusCode = 500;
    assert.strictEqual(isRetryableError(err), true);
  });

  test("retries on 503 service unavailable", () => {
    const err = new Error("HTTP 503");
    err.statusCode = 503;
    assert.strictEqual(isRetryableError(err), true);
  });

  test("retries on 429 too many requests", () => {
    const err = new Error("HTTP 429");
    err.statusCode = 429;
    assert.strictEqual(isRetryableError(err), true);
  });

  test("does NOT retry on 404", () => {
    const err = new Error("HTTP 404");
    err.statusCode = 404;
    assert.strictEqual(isRetryableError(err), false);
  });

  test("does NOT retry on 403", () => {
    const err = new Error("HTTP 403");
    err.statusCode = 403;
    assert.strictEqual(isRetryableError(err), false);
  });

  test("does NOT retry on 401", () => {
    const err = new Error("HTTP 401");
    err.statusCode = 401;
    assert.strictEqual(isRetryableError(err), false);
  });
});

// ---------------------------------------------------------------------------
// downloadFile (mocked fetch)
// ---------------------------------------------------------------------------

describe("downloadFile", () => {
  test("calls fetchImpl with correct URL and dest path", async () => {
    let calledUrl, calledDest;
    const mockFetch = async (url, dest) => {
      calledUrl = url;
      calledDest = dest;
    };

    await downloadFile("https://example.com/test.tar.gz", "/tmp/test.tar.gz", {
      fetchImpl: mockFetch,
    });

    assert.strictEqual(calledUrl, "https://example.com/test.tar.gz");
    assert.strictEqual(calledDest, "/tmp/test.tar.gz");
  });

  test("retries on transient network errors", async () => {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
      if (attempts < 2) {
        const err = new Error("ECONNRESET");
        throw err;
      }
      // succeeds on 2nd attempt
    };

    await downloadFile("https://example.com/test", "/tmp/test", {
      fetchImpl: mockFetch,
      maxRetries: 5,
      baseDelay: 1,
    });
    assert.strictEqual(attempts, 2);
  });

  test("does NOT retry on 404 (fails immediately)", async () => {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
      const err = new Error("HTTP 404");
      err.statusCode = 404;
      throw err;
    };

    await assert.rejects(
      downloadFile("https://example.com/test", "/tmp/test", {
        fetchImpl: mockFetch,
        maxRetries: 5,
        baseDelay: 1,
      }),
      /HTTP 404/
    );
    assert.strictEqual(attempts, 1); // no retries
  });

  test("throws after maxRetries exhausted", async () => {
    const mockFetch = async () => {
      const err = new Error("ECONNRESET");
      throw err;
    };

    await assert.rejects(
      downloadFile("https://example.com/test", "/tmp/test", {
        fetchImpl: mockFetch,
        maxRetries: 2,
        baseDelay: 1,
      }),
      /ECONNRESET/
    );
  });

  test("does not retry on first success", async () => {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
    };

    await downloadFile("https://example.com/test", "/tmp/test", {
      fetchImpl: mockFetch,
      maxRetries: 5,
    });
    assert.strictEqual(attempts, 1);
  });
});

// ---------------------------------------------------------------------------
// Checksum verification
// ---------------------------------------------------------------------------

describe("parseChecksums", () => {
  test("parses checksums.txt format", () => {
    const content = `aabbccdd11223344556677889900112233445566778899001122334455667788  kimchi_darwin_arm64.tar.gz\nffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100  kimchi_linux_amd64.tar.gz\n`;
    const result = parseChecksums(content);
    assert.strictEqual(result["kimchi_darwin_arm64.tar.gz"], "aabbccdd11223344556677889900112233445566778899001122334455667788");
    assert.strictEqual(result["kimchi_linux_amd64.tar.gz"], "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100");
  });

  test("ignores empty lines", () => {
    const content = `\naabbccdd11223344556677889900112233445566778899001122334455667788  file.tar.gz\n\n`;
    const result = parseChecksums(content);
    assert.strictEqual(Object.keys(result).length, 1);
  });

  test("returns empty map for empty content", () => {
    const result = parseChecksums("");
    assert.strictEqual(Object.keys(result).length, 0);
  });
});

describe("verifyChecksum", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimchi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns true when checksum matches", async () => {
    const tmpFile = path.join(tmpDir, "checksum.txt");
    fs.writeFileSync(tmpFile, "test content");

    const hash = await computeSha256(tmpFile);
    const checksumsContent = `${hash}  checksum.txt\n`;

    const result = await verifyChecksum(tmpFile, "checksum.txt", checksumsContent);
    assert.strictEqual(result, true);
  });

  test("throws when checksum doesn't match", async () => {
    const tmpFile = path.join(tmpDir, "checksum-bad.txt");
    fs.writeFileSync(tmpFile, "different content");

    const checksumsContent = `0000000000000000000000000000000000000000000000000000000000000000  checksum-bad.txt\n`;

    await assert.rejects(
      async () => verifyChecksum(tmpFile, "checksum-bad.txt", checksumsContent),
      /Checksum mismatch/
    );
  });

  test("throws when asset not in checksums", async () => {
    const tmpFile = path.join(tmpDir, "checksum-missing.txt");
    fs.writeFileSync(tmpFile, "content");

    await assert.rejects(
      async () => verifyChecksum(tmpFile, "nonexistent-asset.tar.gz", "otherhash  other.tar.gz\n"),
      /No checksum found/
    );
  });
});

describe("computeSha256", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimchi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("computes consistent hash", async () => {
    const tmpFile = path.join(tmpDir, "hash.txt");
    fs.writeFileSync(tmpFile, "hello world");

    const hash1 = await computeSha256(tmpFile);
    const hash2 = await computeSha256(tmpFile);

    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64); // SHA-256 hex
  });
});

// ---------------------------------------------------------------------------
// extractArchive (uses spawnSync with argument arrays — no shell injection)
// ---------------------------------------------------------------------------

describe("extractArchive", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimchi-extract-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("calls tar with argument array for tar.gz", () => {
    const archivePath = path.join(tmpDir, "test.tar.gz");
    const destDir = path.join(tmpDir, "dest");
    let calledBin, calledArgs;
    const mockSpawn = (bin, args) => {
      calledBin = bin;
      calledArgs = args;
      return { status: 0 };
    };

    extractArchive(archivePath, "tar.gz", destDir, {
      spawnSyncImpl: mockSpawn,
    });

    assert.strictEqual(calledBin, "tar");
    assert.deepStrictEqual(calledArgs, ["-xzf", archivePath, "-C", destDir]);
  });

  test("calls unzip with argument array on non-Windows", () => {
    const archivePath = path.join(tmpDir, "test.zip");
    const destDir = path.join(tmpDir, "dest");
    let calledBin, calledArgs;
    const mockSpawn = (bin, args) => {
      calledBin = bin;
      calledArgs = args;
      return { status: 0 };
    };

    extractArchive(archivePath, "zip", destDir, {
      spawnSyncImpl: mockSpawn,
      platform: "darwin",
    });

    assert.strictEqual(calledBin, "unzip");
    assert.deepStrictEqual(calledArgs, ["-o", archivePath, "-d", destDir]);
  });

  test("calls powershell.exe with argument array on Windows", () => {
    const archivePath = path.join(tmpDir, "test.zip");
    const destDir = path.join(tmpDir, "dest");
    let calledBin, calledArgs;
    const mockSpawn = (bin, args) => {
      calledBin = bin;
      calledArgs = args;
      return { status: 0 };
    };

    extractArchive(archivePath, "zip", destDir, {
      spawnSyncImpl: mockSpawn,
      platform: "win32",
    });

    assert.strictEqual(calledBin, "powershell.exe");
    assert.ok(Array.isArray(calledArgs));
    assert.ok(calledArgs.includes("-NoProfile"));
  });

  test("throws on unknown archive type", () => {
    assert.throws(
      () => extractArchive(path.join(tmpDir, "test.rar"), "rar", tmpDir),
      /Unknown archive type/
    );
  });

  test("throws when tar exits non-zero", () => {
    const archivePath = path.join(tmpDir, "test.tar.gz");
    const destDir = path.join(tmpDir, "dest");
    const mockSpawn = () => ({ status: 2 });
    assert.throws(
      () => extractArchive(archivePath, "tar.gz", destDir, {
        spawnSyncImpl: mockSpawn,
      }),
      /tar extraction failed/
    );
  });
});

// ---------------------------------------------------------------------------
// makeExecutable
// ---------------------------------------------------------------------------

describe("makeExecutable", () => {
  test("calls chmodSync on non-Windows", () => {
    let chmodCalled = false;
    let chmodPath, chmodMode;
    const mockChmod = (p, mode) => {
      chmodCalled = true;
      chmodPath = p;
      chmodMode = mode;
    };

    makeExecutable("/path/to/kimchi", { chmodSyncImpl: mockChmod, platform: "linux" });

    assert.ok(chmodCalled);
    assert.strictEqual(chmodPath, "/path/to/kimchi");
    assert.strictEqual(chmodMode, 0o755);
  });

  test("does not call chmod on Windows", () => {
    let chmodCalled = false;
    const mockChmod = () => {
      chmodCalled = true;
    };

    makeExecutable("C:\\path\\to\\kimchi.exe", { chmodSyncImpl: mockChmod, platform: "win32" });

    assert.ok(!chmodCalled);
  });
});

// ---------------------------------------------------------------------------
// getPlatformKey
// ---------------------------------------------------------------------------

describe("getPlatformKey", () => {
  test("formats platform-arch correctly", () => {
    assert.strictEqual(getPlatformKey("darwin", "arm64"), "darwin-arm64");
    assert.strictEqual(getPlatformKey("linux", "x64"), "linux-x64");
    assert.strictEqual(getPlatformKey("win32", "x64"), "win32-x64");
  });

  test("uses process defaults when no args given", () => {
    const key = getPlatformKey();
    assert.strictEqual(key, `${process.platform}-${process.arch}`);
  });
});

// ---------------------------------------------------------------------------
// Proxy support
// ---------------------------------------------------------------------------

describe("getProxyUrl", { concurrency: 1 }, () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
      if (key in origEnv) process.env[key] = origEnv[key];
      else delete process.env[key];
    }
  });

  test("returns null when no proxy env vars are set", () => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    assert.strictEqual(getProxyUrl("https://github.com/test"), null);
  });

  test("returns HTTPS_PROXY for https URLs", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:8080";
    assert.strictEqual(getProxyUrl("https://github.com/test"), "http://proxy.example.com:8080");
  });

  test("returns HTTP_PROXY for http URLs", () => {
    process.env.HTTP_PROXY = "http://proxy.example.com:8080";
    delete process.env.HTTPS_PROXY;
    assert.strictEqual(getProxyUrl("http://github.com/test"), "http://proxy.example.com:8080");
  });

  test("respects NO_PROXY for exact hostname match", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:8080";
    process.env.NO_PROXY = "github.com";
    assert.strictEqual(getProxyUrl("https://github.com/test"), null);
  });

  test("respects NO_PROXY for subdomain match", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:8080";
    process.env.NO_PROXY = "github.com";
    assert.strictEqual(getProxyUrl("https://api.github.com/test"), null);
  });

  test("returns proxy when hostname not in NO_PROXY", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:8080";
    process.env.NO_PROXY = "other.com";
    assert.strictEqual(getProxyUrl("https://github.com/test"), "http://proxy.example.com:8080");
  });
});
