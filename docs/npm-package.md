# npm Package

Kimchi is available as an npm package: [`@getkimchi/kimchi`](https://www.npmjs.com/package/@getkimchi/kimchi).

## Install

```bash
npm install -g @getkimchi/kimchi
```

Or use without installing:

```bash
npx @getkimchi/kimchi
```

## How It Works

The npm package is a thin wrapper that downloads the correct pre-built Kimchi binary from [GitHub Releases](https://github.com/getkimchi/kimchi/releases) at install time. This follows the same pattern as [esbuild](https://github.com/evanw/esbuild) and [turbo](https://github.com/vercel/turborepo).

## Supported Platforms

| OS      | Architecture   | Requires  |
|---------|----------------|-----------|
| macOS   | arm64 (Silicon)| Node ≥ 18 |
| macOS   | x64 (Intel)    | Node ≥ 18 |
| Linux   | arm64          | Node ≥ 18 |
| Linux   | x64            | Node ≥ 18 |
| Windows | x64            | Node ≥ 18 |

## Environment Variables

| Variable            | Description                                          |
|---------------------|------------------------------------------------------|
| `KIMCHI_API_KEY`    | API key (alternative to `kimchi setup`)             |
| `KIMCHI_VERSION`    | Pin a specific version (e.g., `v0.1.84`)            |
| `KIMCHI_BIN_PATH`   | Override the binary path (skip download)            |

## Troubleshooting

### Binary download failed

The postinstall never blocks installation. If the download fails, install Kimchi separately:

```bash
# macOS / Linux
curl -fsSL https://github.com/getkimchi/kimchi/releases/latest/download/install.sh | bash

# Windows (PowerShell)
irm https://github.com/getkimchi/kimchi/releases/latest/download/install.ps1 | iex
```

### Binary not found after install

```bash
npm rebuild @getkimchi/kimchi
```

### `--ignore-scripts` environments

If your CI blocks postinstall scripts, the binary won't download. Run `npm rebuild @getkimchi/kimchi` afterward, or set `KIMCHI_BIN_PATH` to point to a system-installed `kimchi`.

## Provenance

Published packages are signed with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), linking each version to the exact GitHub Actions workflow run that produced it.

Verify:

```bash
npm view @getkimchi/kimchi --json | jq '.dist.attestations'
```

## License

Apache License 2.0 — see [LICENSE](https://github.com/getkimchi/kimchi/blob/master/LICENSE).
