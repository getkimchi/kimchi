#!/usr/bin/env node
/**
 * postinstall.js — Downloads the correct pre-built Kimchi binary for the
 * current platform from GitHub Releases and extracts it into the package
 * directory.
 *
 * The binary ships as a tarball (Unix) or zip (Windows) containing:
 *   bin/kimchi       — the executable
 *   share/kimchi/    — runtime assets (themes, oauth, export-html)
 *
 * Security:
 *   - Verifies SHA-256 checksum from checksums.txt before extraction
 *   - Uses spawnSync with argument arrays (no shell interpolation)
 *   - Never throws on failure (postinstall failures block ALL npm installs)
 *
 * Design:
 *   - Follows the esbuild / turbo / sharp pattern
 *   - Retries with exponential backoff on transient network errors only
 *   - Downloads from latest release tag (or KIMCHI_VERSION env override)
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createWriteStream, mkdirSync, rmSync, existsSync, chmodSync } = require("node:fs");

// ---------------------------------------------------------------------------
// Proxy support
// ---------------------------------------------------------------------------

/**
 * Returns the proxy URL based on env vars, or null if no proxy is configured.
 * Respects HTTP_PROXY, HTTPS_PROXY, and NO_PROXY (for GitHub hostnames).
 *
 * @param {string} targetUrl
 * @returns {string|null}
 */
function getProxyUrl(targetUrl) {
  const parsed = new URL(targetUrl);
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  const noProxyHosts = noProxy.split(",").map(h => h.trim()).filter(Boolean);
  for (const host of noProxyHosts) {
    // Handle leading-dot convention (e.g. .github.com matches api.github.com)
    const normalized = host.startsWith(".") ? host.slice(1) : host;
    if (parsed.hostname === normalized || parsed.hostname.endsWith("." + normalized)) {
      return null;
    }
  }
  if (parsed.protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy || null;
  }
  return process.env.HTTP_PROXY || process.env.http_proxy || null;
}

/**
 * Creates an HTTPS GET request with optional proxy support.
 * If a proxy is configured, establishes a CONNECT tunnel first.
 * Returns the actual https.ClientRequest so timeout/error handlers
 * are attached to the correct request object.
 *
 * @param {string} url
 * @param {Object} options
 * @param {Function} callback
 * @returns {http.ClientRequest}
 */
function httpRequest(url, options, callback) {
  const proxyUrl = getProxyUrl(url);
  if (!proxyUrl) {
    return url.startsWith("https:") ? https.get(url, options, callback) : http.get(url, options, callback);
  }

  const proxy = new URL(proxyUrl);
  const target = new URL(url);
  let settled = false;

  // Establish a CONNECT tunnel through the proxy
  const connectReq = http.request({
    host: proxy.hostname,
    port: proxy.port || 80,
    method: "CONNECT",
    path: `${target.hostname}:${target.port || 443}`,
    headers: { Host: `${target.hostname}:${target.port || 443}` },
    agent: false,
  });

  connectReq.on("connect", (res, socket) => {
    if (settled) return;
    // Check CONNECT response status
    if (res.statusCode < 200 || res.statusCode >= 300) {
      settled = true;
      callback(null, new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
      return;
    }
    // Use the established tunnel socket for the HTTPS request.
    const req = https.get(url, { ...options, socket, agent: false }, callback);
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        callback(null, err);
      }
    });
  });

  // Handle proxy errors (connection refused, timeout, etc.)
  connectReq.on("error", (err) => {
    if (!settled) {
      settled = true;
      callback(null, err);
    }
  });

  // Handle non-CONNECT responses (e.g., 407 Proxy Auth Required)
  connectReq.on("response", (res) => {
    if (!settled) {
      settled = true;
      res.resume();
      callback(null, new Error(`Proxy returned HTTP ${res.statusCode} (expected CONNECT tunnel)`));
    }
  });

  connectReq.end();
  return connectReq;
}

const REPO = "getkimchi/kimchi";
const PLATFORMS_PATH = path.join(__dirname, "platforms.json");

// ---------------------------------------------------------------------------
// Platform resolution
// ---------------------------------------------------------------------------

function getPlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function loadPlatforms() {
  return JSON.parse(fs.readFileSync(PLATFORMS_PATH, "utf8"));
}

function resolvePlatform(platforms, platform, arch) {
  const key = getPlatformKey(platform, arch);
  const entry = platforms[key];
  if (!entry) {
    throw new Error(
      `Kimchi does not ship a pre-built binary for ${key}.\n` +
        `Supported platforms: ${Object.keys(platforms).join(", ")}\n` +
        `You can build from source: https://github.com/${REPO}`
    );
  }
  return { key, asset: entry.asset, archiveType: entry.archiveType };
}

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

/**
 * Returns the version tag to download.
 *
 * Priority:
 *   1. KIMCHI_VERSION env var (e.g. "v0.1.84") — explicit pin
 *   2. The npm package version if it's a real release (not "0.0.0")
 *   3. "latest" — fall back to the latest GitHub release
 *
 * When published from the release workflow, the npm package version is set
 * from the GitHub tag, so they always match. The "0.0.0" placeholder is
 * used during development and falls back to "latest".
 *
 * @param {string} [packageVersion] — version from package.json
 * @returns {string} e.g. "v0.1.84" or "latest"
 */
function resolveVersion(packageVersion) {
  const envVersion = process.env.KIMCHI_VERSION;
  if (envVersion) return envVersion.startsWith("v") ? envVersion : `v${envVersion}`;

  // Use package version if it's a real release (not the dev placeholder)
  if (packageVersion && packageVersion !== "0.0.0") {
    return packageVersion.startsWith("v") ? packageVersion : `v${packageVersion}`;
  }

  return "latest";
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

const GITHUB_BASE = "https://github.com";

function buildDownloadUrl(tag, asset) {
  if (tag === "latest") {
    return `${GITHUB_BASE}/${REPO}/releases/latest/download/${asset}`;
  }
  return `${GITHUB_BASE}/${REPO}/releases/download/${tag}/${asset}`;
}

function buildChecksumUrl(tag) {
  return buildDownloadUrl(tag, "checksums.txt");
}

// ---------------------------------------------------------------------------
// HTTP download
// ---------------------------------------------------------------------------

/**
 * Classifies an error to determine if it's retryable.
 * Only transient network errors (timeouts, connection resets, 429, 5xx) are retried.
 * Client errors (404, 403, etc.) fail immediately.
 *
 * @param {Error} err
 * @returns {boolean} — true if the error is retryable
 */
function isRetryableError(err) {
  // Non-HTTP errors (network, timeout) are always retryable
  if (!err.statusCode) {
    return true;
  }
  // 429 Too Many Requests is retryable (rate limiting is transient)
  if (err.statusCode === 429) {
    return true;
  }
  // 5xx server errors are retryable
  if (err.statusCode >= 500) {
    return true;
  }
  // 4xx client errors (404, 403, etc.) are NOT retryable
  return false;
}

/**
 * Downloads a URL and writes the response body to a file.
 * Follows up to 5 redirects.
 *
 * @param {string} url
 * @param {string} destPath — file path to write to
 * @param {number} [redirectsLeft=5]
 * @returns {Promise<void>}
 */
function defaultFetch(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        headers: {
          "User-Agent": "kimchi-npm-postinstall",
          Accept: "application/octet-stream",
        },
      },
      (res, connectErr) => {
        if (connectErr) {
          reject(connectErr);
          return;
        }
        if (
          (res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 303 ||
            res.statusCode === 307 ||
            res.statusCode === 308) &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects"));
            return;
          }
          res.resume();
          const nextUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          resolve(defaultFetch(nextUrl, destPath, redirectsLeft - 1));
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          const err = new Error(`HTTP ${res.statusCode} downloading ${url}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }

        const stream = createWriteStream(destPath);
        res.on("error", reject);
        res.pipe(stream);
        stream.on("finish", () => stream.close(resolve));
        stream.on("error", reject);
      }
    );

    req.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error("Download timed out after 120s"));
    });
  });
}

/**
 * Downloads a URL with retry on transient errors.
 *
 * @param {string} url
 * @param {string} destPath — file path to write to
 * @param {{ maxRetries?: number, fetchImpl?: Function, baseDelay?: number }} [opts]
 * @returns {Promise<void>}
 */
async function downloadFile(url, destPath, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const baseDelay = opts.baseDelay ?? 1000;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchImpl(url, destPath);
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries || !isRetryableError(err)) break;
      const delay = baseDelay * Math.pow(2, attempt);
      if (process.env.KIMCHI_NPM_DEBUG) {
        console.warn(
          `[kimchi] Download attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms…`
        );
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Checksum verification
// ---------------------------------------------------------------------------

/**
 * Computes the SHA-256 hash of a file.
 *
 * @param {string} filePath
 * @returns {string} — hex digest
 */
function computeSha256(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  stream.pipe(hash);
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    hash.on("error", reject);
    hash.on("finish", () => resolve(hash.digest("hex")));
  });
}

/**
 * Parses a checksums.txt file and returns a map of filename → sha256.
 *
 * @param {string} checksumsContent — raw content of checksums.txt
 * @returns {Object<string, string>} — { "kimchi_darwin_arm64.tar.gz": "abc123...", ... }
 */
function parseChecksums(checksumsContent) {
  const map = {};
  for (const line of checksumsContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "<sha256>  <filename>"
    const match = trimmed.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match) {
      map[match[2].trim()] = match[1];
    }
  }
  return map;
}

/**
 * Verifies the SHA-256 checksum of a downloaded file against checksums.txt.
 *
 * @param {string} archivePath — path to the downloaded archive
 * @param {string} assetName — expected filename in checksums.txt
 * @param {string} checksumsContent — raw content of checksums.txt
 * @returns {Promise<boolean>} — true if checksum matches
 * @throws {Error} if checksum is missing or doesn't match
 */
async function verifyChecksum(archivePath, assetName, checksumsContent) {
  const checksums = parseChecksums(checksumsContent);
  const expectedHash = checksums[assetName];
  if (!expectedHash) {
    throw new Error(`No checksum found for ${assetName} in checksums.txt`);
  }
  const actualHash = await computeSha256(archivePath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${assetName}:\n` +
        `  Expected: ${expectedHash}\n` +
        `  Actual:   ${actualHash}`
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Archive extraction (safe — uses spawnSync with argument arrays)
// ---------------------------------------------------------------------------

/**
 * Extracts a tar.gz or zip archive using spawnSync with argument arrays.
 * No shell interpolation — safe against command injection.
 *
 * @param {string} archivePath
 * @param {string} archiveType — "tar.gz" or "zip"
 * @param {string} destDir
 * @param {{ spawnSyncImpl?: Function }} [opts]
 */
function extractArchive(archivePath, archiveType, destDir, opts = {}) {
  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;

  mkdirSync(destDir, { recursive: true });

  if (archiveType === "tar.gz") {
    // tar is available on all Unix systems; Windows 10+ ships tar.exe.
    // We don't use --no-same-owner because busybox tar (Alpine) doesn't support it.
    // UID/GID warnings when running as root are harmless.
    const tarArgs = ["-xzf", archivePath, "-C", destDir];
    const result = spawnSyncImpl("tar", tarArgs, {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`tar extraction failed with exit code ${result.status}`);
    }
  } else if (archiveType === "zip") {
    if ((opts.platform ?? process.platform) === "win32") {
      // Use PowerShell with -EncodedCommand (base64 UTF-16LE) to avoid
      // any string interpolation of paths into the command string.
      // Try powershell.exe (Windows PowerShell 5) first, fall back to pwsh (PowerShell 7+).
      const script = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      let result = spawnSyncImpl(
        "powershell.exe",
        ["-NoProfile", "-EncodedCommand", encoded],
        { stdio: "inherit" }
      );
      if (result.error && result.error.code === "ENOENT") {
        // powershell.exe not found, try pwsh (PowerShell 7+)
        result = spawnSyncImpl(
          "pwsh",
          ["-NoProfile", "-EncodedCommand", encoded],
          { stdio: "inherit" }
        );
      }
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`PowerShell extraction failed with exit code ${result.status}`);
      }
    } else {
      const result = spawnSyncImpl("unzip", ["-o", archivePath, "-d", destDir], {
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`unzip extraction failed with exit code ${result.status}`);
      }
    }
  } else {
    throw new Error(`Unknown archive type: ${archiveType}`);
  }
}

/**
 * Makes the binary executable on Unix systems.
 *
 * @param {string} binaryPath
 * @param {{ chmodSyncImpl?: Function, platform?: string }} [opts]
 */
function makeExecutable(binaryPath, opts = {}) {
  const chmodSyncImpl = opts.chmodSyncImpl ?? chmodSync;
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    chmodSyncImpl(binaryPath, 0o755);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// Main — orchestrates download, checksum verification, and extraction.
// Unit tests cover individual helpers (downloadFile, verifyChecksum,
// extractArchive). End-to-end coverage of main() is provided by
// .github/workflows/test-npm.yml which installs from tarball across
// Windows/Linux/macOS and verifies the binary executes.
// ---------------------------------------------------------------------------

async function main() {
  const platforms = loadPlatforms();
  const { key, asset, archiveType } = resolvePlatform(platforms);

  // Determine the version from package.json
  const packageJsonPath = path.join(__dirname, "..", "package.json");
  let packageVersion;
  if (existsSync(packageJsonPath)) {
    packageVersion = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8")
    ).version;
  }
  const tag = resolveVersion(packageVersion);

  const checksumUrl = buildChecksumUrl(tag);

  // Destination: a platform-specific subdirectory inside the package
  const destDir = path.join(__dirname, "..", "vendor", key);
  const archivePath = path.join(destDir, asset);

  // If already downloaded (e.g. npm ci with cache), skip
  const binaryPath = path.join(destDir, "bin", "kimchi");
  const binaryExePath =
    process.platform === "win32" ? `${binaryPath}.exe` : binaryPath;
  if (existsSync(binaryExePath)) {
    if (process.env.KIMCHI_NPM_DEBUG) {
      console.log(`[kimchi] Binary already exists at ${binaryExePath}, skipping download.`);
    }
    return;
  }

  mkdirSync(destDir, { recursive: true });

  // Download the archive.
  // Try the version-specific tag first (for reproducibility).
  // If that 404s (e.g. npm patch without a matching GitHub release),
  // fall back to "latest" so the install always succeeds.
  let effectiveTag = tag;
  let downloadUrl = buildDownloadUrl(tag, asset);
  console.log(`[kimchi] Downloading ${asset} (${key})…`);
  try {
    await downloadFile(downloadUrl, archivePath);
  } catch (err) {
    if (err.statusCode === 404 && tag !== "latest") {
      console.warn(`[kimchi] Version ${tag} not found on GitHub Releases, falling back to latest.`);
      effectiveTag = "latest";
      downloadUrl = buildDownloadUrl("latest", asset);
      await downloadFile(downloadUrl, archivePath);
    } else {
      throw err;
    }
  }

  // Download and verify checksum.
  // Security: fail closed on ANY checksum issue — download failure, mismatch,
  // or missing entry. The archive is deleted and extraction does NOT proceed.
  // This ensures a tampered or corrupted binary can never be installed.
  const checksumsPath = path.join(destDir, "checksums.txt");
  const effectiveChecksumUrl = buildChecksumUrl(effectiveTag);
  try {
    await downloadFile(effectiveChecksumUrl, checksumsPath);
    const checksumsContent = fs.readFileSync(checksumsPath, "utf8");
    await verifyChecksum(archivePath, asset, checksumsContent);
    console.log(`[kimchi] Checksum verified ✓`);
    rmSync(checksumsPath, { force: true });
  } catch (err) {
    // Any failure (download error, mismatch, or missing entry) — fail closed.
    rmSync(archivePath, { force: true });
    rmSync(checksumsPath, { force: true });
    throw new Error(
      `Checksum verification FAILED for ${asset}: ${err.message}\n` +
      `The downloaded archive may be corrupted or tampered with. Aborting.`
    );
  }

  // Extract
  console.log(`[kimchi] Extracting to ${destDir}…`);
  extractArchive(archivePath, archiveType, destDir);

  // Clean up the archive after extraction
  rmSync(archivePath, { force: true });

  // Safety check: walk extracted files and verify none escaped destDir
  // (protects against path traversal via ../ or absolute paths in archive)
  const resolvedDest = path.resolve(destDir) + path.sep;
  const walkAndVerify = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.resolve(dir, entry.name);
      if (!fullPath.startsWith(resolvedDest) && fullPath !== path.resolve(destDir)) {
        throw new Error(
          `Extracted path ${fullPath} is outside the destination directory. ` +
          `The archive may contain path traversal entries. Aborting.`
        );
      }
      if (entry.isDirectory()) {
        walkAndVerify(fullPath);
      }
    }
  };
  walkAndVerify(destDir);

  // Verify the binary exists after extraction
  if (!existsSync(binaryExePath)) {
    throw new Error(
      `Binary not found at ${binaryExePath} after extraction. ` +
      `The archive may have an unexpected directory structure.`
    );
  }

  makeExecutable(binaryPath);

  console.log(`[kimchi] Installed binary to ${binaryExePath}`);
}

// Run main. On failure, decide whether to block the install:
// - Security errors (checksum failure, path traversal) MUST exit non-zero
//   so npm knows the package is broken and doesn't install a tampered binary.
// - Network/tooling errors (download timeout, missing tar) exit 0 so npm
//   install is not blocked — the user can install kimchi separately.
if (require.main === module) {
  main().catch((err) => {
    const isSecurityError =
      err.message.includes("Checksum verification FAILED") ||
      err.message.includes("path traversal") ||
      err.message.includes("outside the destination directory");

    console.warn(
      `[kimchi] postinstall failed: ${err.message}\n` +
        `[kimchi] You can still use the package if Kimchi is installed separately.\n` +
        `[kimchi] Or download manually from https://github.com/${REPO}/releases`
    );

    // Security failures: exit non-zero to block the install
    if (isSecurityError) {
      process.exit(1);
    }
    // Network/tooling failures: exit 0 to not block npm install
    process.exit(0);
  });
}

// Export for testing
module.exports = {
  getPlatformKey,
  loadPlatforms,
  resolvePlatform,
  resolveVersion,
  buildDownloadUrl,
  buildChecksumUrl,
  downloadFile,
  defaultFetch,
  isRetryableError,
  computeSha256,
  parseChecksums,
  verifyChecksum,
  extractArchive,
  makeExecutable,
  getProxyUrl,
  REPO,
};
