# Vendored SheetJS fallback

`xlsx-0.20.3.tgz` is a byte copy of the CDN tarball that `package.json` pins
(`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`). The lockfile records
no integrity hash for that URL, so this file is the offline trust anchor.

- sha256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- Verify after download: `shasum -a 256 xlsx-0.20.3.tgz`
- To use (CDN unreachable, or hermetic/offline install): point the `xlsx`
  dependency in `package.json` at `file:vendor/sheetjs/xlsx-0.20.3.tgz` and
  run `pnpm install`, then commit the lockfile change.
- When upgrading SheetJS, re-download from the CDN, re-hash, and replace this
  file (and the pin) in the same commit.
