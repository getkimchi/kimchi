# Code-RAG POC — demo guide

Local semantic code search for kimchi. The `poc/code-rag` branch adds an extension that registers:

- **`/index`** — builds (or incrementally updates) an embedding index of the current repo.
- **`code_search`** — a tool the model can call to find code by *meaning* ("where are permission prompts decided") rather than by exact string, returning `file:line-range` chunks ranked by relevance.

Everything runs locally: embeddings come from an OpenAI-compatible server on your machine (oMLX by default), and the index is a single gitignored JSON file at `.kimchi/code-rag/index.json`.

## Prerequisites

- macOS on Apple Silicon (for the default oMLX + MLX setup; any OpenAI-compatible embedding server works instead — see [Alternative servers](#alternative-embedding-servers)).
- This repo on the POC branch, with dependencies installed.
- A git repository to index — file discovery uses `git ls-files`, so `code_search` refuses to run outside a git repo.

## Setup

### 1. Check out the branch and install

```sh
git checkout poc/code-rag
pnpm install
```

### 2. Start a local embedding server (oMLX)

The POC defaults to oMLX serving `Qwen3-Embedding-0.6B-8bit` on `http://localhost:8000`.

Install oMLX (not on PyPI — install from GitHub as a uv tool; get uv from https://docs.astral.sh/uv/ if needed):

```sh
uv tool install git+https://github.com/jundot/omlx
```

Download the model into your model directory (uses uv's `uvx`, so no Hugging Face CLI install is needed):

```sh
uvx --from huggingface_hub hf download mlx-community/Qwen3-Embedding-0.6B-8bit \
  --local-dir ~/models/Qwen3-Embedding-0.6B-8bit
```

Then start the server:

```sh
omlx serve --model-dir ~/models
```

> **Why the 0.6B model?** Benchmarked on an M4 Pro: 0.6B-8bit embeds ~402 chunks/min vs ~42–48 for the 4B quants — roughly 9× faster for a modest retrieval loss that the hybrid lexical scoring mostly covers. (Note: oMLX's compiled path fails for all Qwen3-Embedding quants; it runs them on the eager path, which also serializes embed requests.)

### 3. Verify the server responds

```sh
curl -s http://localhost:8000/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model": "Qwen3-Embedding-0.6B-8bit", "input": "hello"}' | head -c 200
```

You should see a JSON response with an `embedding` array.

## Demo script

### 1. Launch kimchi from source in the repo you want to index

The easiest demo target is the kimchi repo itself:

```sh
pnpm run dev
```

### 2. Build the index

In the kimchi TUI, run:

```
/index
```

The build runs in the background — you can keep chatting while it works. The status line shows live progress with an ETA (`indexing 1280/6240 chunks (21%, ~12m left)`), and you get a summary notification when it finishes, e.g.:

```
Indexed 812 files / 6240 chunks in 940.2s (812 files re-embedded, 0 removed)
```

At ~400 chunks/min the first full build of a repo this size takes a while — good moment to explain the architecture (below). The build checkpoints every 512 chunks, so an interrupted build resumes from the last checkpoint instead of starting over. Re-running `/index` afterwards is near-instant: only changed files are re-embedded.

### 3. Semantic search

Ask kimchi something where you *don't* know the identifier, phrased by meaning:

> Where do we decide whether a bash command needs a permission prompt? Use code_search.

Watch the model call `code_search` and get back ranked chunks like:

```
src/permissions/bash-guard.ts:112-176 (score 0.734)
<chunk text…>
```

Other good demo queries:

- "retry logic for provider requests"
- "how does session resumption restore messages"
- "where are extension tools registered"

Contrast with grep: for an exact symbol you already know, grep wins (and the tool description tells the model so); `code_search` shines when you only know the *concept*.

### 4. Show incremental freshness

Edit a couple of files (or switch branches), then ask another `code_search` question **without** re-running `/index`. Every search first runs the same incremental update pass, capped at 24 changed files, so small edits are picked up automatically (the status line shows `refreshing index N/M chunks` while it does). Searches issued while an `/index` build is running skip this refresh and answer from the current snapshot, noting that results may be partially stale. If more than 24 files changed (e.g. a large rebase), the search answers from the stale index and appends a note telling the model to suggest `/index` — searches never block for long behind a big refresh.

Change detection is two-stage: mtime+size first, then a content hash — so touched-but-identical files (branch switches, no-op formatters) skip re-embedding.

## How it works (talking points)

- **Chunking** (`chunker.ts`): fixed 64-line windows with 12-line overlap, no AST awareness — deliberately simple for the POC. The file path + line range is prepended to the embedded text so path/name tokens participate in similarity.
- **Embeddings** (`embedder.ts`): Qwen3-Embedding is instruction-aware — queries carry a task instruction, documents are embedded raw. It's also Matryoshka-trained, so vectors are truncated to 1024 dims (from the native size) and L2-normalized, cutting the index to ~40% on disk with negligible retrieval loss; similarity at search time is a plain dot product.
- **Hybrid scoring** (`indexer.ts`): cosine similarity plus a small lexical bonus (+0.03 per exact query token found in the chunk or its path, capped at 0.12) — catches identifier lookups that pure embeddings famously miss.
- **Result shaping**: at most 2 chunks per file, default 6 results, so answers span files instead of dumping one file's every chunk.
- **Storage**: one JSON file at `.kimchi/code-rag/index.json`, vectors as base64 `Float32Array` (~4 KB/chunk); a few thousand chunks stays in the tens of MB. Decoded vectors are cached in memory keyed on the index file's mtime.
- **File selection**: `git ls-files` (tracked + untracked-not-ignored), filtered to ~40 code/config/doc extensions; skips lockfiles, minified files, binaries, files over 256 KB, and `.kimchi/` itself.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `KIMCHI_CODE_RAG_EMBED_HOST` | `http://localhost:8000` | Base URL of the OpenAI-compatible embedding server |
| `KIMCHI_CODE_RAG_EMBED_MODEL` | `Qwen3-Embedding-0.6B-8bit` | Embedding model name sent to the server |

Changing the model (or the index dimensionality) invalidates every stored vector — the next `/index` rebuilds from scratch.

## Alternative embedding servers

Anything that speaks `POST /v1/embeddings` works: llama.cpp (`llama-server --embedding`), LM Studio, vLLM, etc. Point `KIMCHI_CODE_RAG_EMBED_HOST` (and `KIMCHI_CODE_RAG_EMBED_MODEL`) at it.

## Troubleshooting

- **"No code index found for this project"** — the first build is always explicit: run `/index`. `code_search` only auto-refreshes an existing index.
- **Connection errors from `/index` or `code_search`** — the embedding server isn't up. Start it (`omlx serve --model-dir ~/models`) or set `KIMCHI_CODE_RAG_EMBED_HOST`.
- **Indexing seems slow** — expected with the 4B models (~9× slower); use the default 0.6B-8bit for demos. Transient server hiccups are retried once after 2 s automatically.
- **`code_search` errors about git** — the target directory must be a git repository.
