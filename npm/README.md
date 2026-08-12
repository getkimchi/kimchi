# @getkimchi/kimchi

A coding agent CLI powered by [Kimchi](https://kimchi.dev/). Built on the [pi-mono](https://github.com/badlogic/pi-mono) coding agent SDK, Kimchi gives you an AI-powered development assistant in your terminal that connects to Kimchi's LLM infrastructure.

## Install

```bash
npm install -g @getkimchi/kimchi
```

Or use without installing:

```bash
npx @getkimchi/kimchi
```

Then:

```bash
kimchi setup   # one-time interactive setup
kimchi         # launch the coding agent
```

## How It Works

This package downloads the correct pre-built binary from [GitHub Releases](https://github.com/getkimchi/kimchi/releases) at install time — same pattern as [esbuild](https://github.com/evanw/esbuild) and [turbo](https://github.com/vercel/turborepo).

## Supported Platforms

| OS      | Architecture   |
|---------|----------------|
| macOS   | arm64, x64     |
| Linux   | arm64, x64     |
| Windows | x64            |

Requires Node.js ≥ 18.

## License

Apache License 2.0 — see [LICENSE](https://github.com/getkimchi/kimchi/blob/master/LICENSE).
