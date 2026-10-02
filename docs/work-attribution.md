# Work attribution

Kimchi keeps a local record of the model requests, file edits, plans and commits that belong to the same work. A `workId` connects them, even when planning and implementation happen in different sessions or repositories.

The result is `~/.config/kimchi/harness/work/<workId>/work.json` in the user's home directory. Kimchi uses the GitHub CLI to find PRs for recorded commits and saves those links in the same file. Calculating costs and uploading these records come later.

## Where the files live

**`work.json` is stored per user, outside the project.** All projects use the same `~/.config/kimchi/harness/` directory, with a separate folder for each work ID. `~` means the home directory of the user running Kimchi.

```text
# Project: editable plan
~/src/example/.kimchi/plans/add-search.md

# User: summary and retained plan versions
~/.config/kimchi/harness/work/<workId>/work.json
~/.config/kimchi/harness/work/<workId>/plans/add-search-<content-hash>.md

# User: source history used to rebuild summaries and match later commits
~/.config/kimchi/harness/work-attribution/<session-id>.jsonl
~/.config/kimchi/harness/work-attribution/transitions/<repo-worktree-hash>.jsonl
~/.config/kimchi/harness/work-attribution/ref-tips/<snapshot-hash>.json
```

For example, work `6f102360-39a9-4d6e-8ac7-984c97c0e313` is saved at:

```text
~/.config/kimchi/harness/work/6f102360-39a9-4d6e-8ac7-984c97c0e313/work.json
```

Deleting a worktree removes its editable plan but leaves the user-level summary and retained native plan copies. To continue elsewhere, name the **absolute retained path** shown when Kimchi saved the plan. Ordinary Markdown files, such as ADRs written through a skill, are not copied into this plan folder.

## The usual flow

```mermaid
flowchart LR
    A["Session A: plan"] -->|save native plan or write Markdown| P["Saved planning evidence"]
    P -->|name its path or continue recent branch work| B["Fresh session B: implement"]
    A -->|requests| W["Local work.json"]
    B -->|requests and commits| W
```

1. **Start working.** Kimchi creates a work ID and records model requests under it.
2. **Save a plan or write an ADR.** Native plans get retained copies. A Markdown file written through Kimchi's native write/edit tools keeps its work identity in the local edit journal.
3. **Continue in a fresh session.** Name the saved file, for example `Implement docs/adr/search.md`. If you omit the path, Kimchi can continue the one recent work on that feature branch under the rules below. Use `/work new` first when starting an unrelated task.
4. **Implement and commit.** Kimchi adds requests, edits and linked commits to the work's summary. For a native plan in a deleted worktree, use its retained absolute path.

## How Kimchi matches things

### 1. Choose the work ID before the request

CLI and Studio choose the work before sending the request:

```mermaid
flowchart LR
    P["User message"] --> E{"Fresh session, no explicit choice,<br/>and no work output?"}
    E -->|No| K["Keep current ID"]
    E -->|Yes| N{"Names a Markdown path?"}
    N -->|Yes| I{"Saved plan ID or unchanged file<br/>with one recorded owner?"}
    I -->|Missing or conflicting| K
    I -->|Yes| A["Use saved work ID"]
    N -->|No| B{"First input, known feature branch,<br/>one recent work with unchanged Markdown?"}
    B -->|No| K
    B -->|Yes| H["Use recent work ID<br/>and record branch inference"]
    K --> R["Record next request"]
    A --> R
    H --> R
```

- **Named native plan:** reads the work ID saved at the top of the file. Its retained copy works after deleting the original worktree.
- **Named Markdown file:** requires one recorded work owner and the same current Git blob and file mode as the saved edit. A committed ADR can therefore continue work from another worktree. Conflicting or unknown paths prevent automatic selection.
- **No path:** only the first input in a fresh session can use branch inference. Kimchi requires a known non-default branch, exactly one work with recorded edits in that worktree and branch during the last 24 hours, and unchanged Markdown with no competing owner.
- **Keep an explicit choice:** `/work new`, a reopened session, local children and extension-injected input do not automatically switch work. Existing work output also prevents switching. A skill's template paths do not count as user references.

Branch inference is a guess based on recent local activity. An unrelated first message on the same branch can meet those rules, so use `/work new` to keep it separate. The summary records whether continuation came from a saved plan, a named artifact or recent branch activity.

Naming one eligible file can select its work even when asking to compare it. Reading a file through a tool or pasting its contents does not itself establish a link; a fresh session may still qualify for the separate branch rule.

Other cases use these rules:

| Case | Work ID used |
| --- | --- |
| New session with no matching saved work | Creates a new ID. |
| Reopen a session | Restores its current ID. |
| Create a local child or branch the conversation | Inherits the parent's ID when the child is created, or the ID at the branch point. |
| Resume a saved Ferment | Uses the Ferment's saved ID before inference. **Leave paused** keeps the current ID. |
| Choose explicitly | `/work <plan path>` selects that plan's work; `/work new` creates separate work in the same chat. `/work` shows the current ID, PR links and lookup errors. |

Kimchi does not detect later task changes or search other worktrees by filename. One work can span several sessions; one session can contribute to several works.

### 2. Connect each file edit to its model request

```mermaid
flowchart LR
    R["Model request with requestId"] --> A["Assistant returns tool calls"]
    A --> T["Native write or edit"]
    T --> F["fileTransitions: requestId,<br/>toolCallId, repository and path"]
    F --> W["Same work.json"]
```

One request can produce edits in several repositories. Each edit keeps the ID of the request that produced its tool call, even if another request runs before the file write finishes. The request's `cwd` remains the session's working directory; each edit records the repository and worktree it actually changed.

`fileTransitions` contains these edits in the summary. Old records can have no `requestId`; Kimchi does not invent one. These links support later cost allocation, but edit counts do not determine a price split.

### 3. Link commits to the work that produced them

There are two routes. A commit made through Bash is linked when the command finishes. Background checks find supported external commits in all repositories already known through local edit journals. They run at startup and every 30 seconds while a top-level Kimchi process remains open; reopening the original worktree is not required.

**During a Bash call**

```mermaid
flowchart LR
    B["Commit created through Bash"] --> R{"Rebase or cherry-pick?"}
    R -->|No| C["Save under Bash call's workId"]
    R -->|Yes| O{"Original linked<br/>to this work?"}
    O -->|Yes| W["Save new hash<br/>and rewrittenFrom"]
    O -->|No| X["Leave copy unlinked"]
```

**During background checks**

```mermaid
flowchart LR
    F["Check each file's saved edits"] --> M{"Exact edit chain<br/>from one work?"}
    M -->|Yes| T["Save file-chain evidence"]
    M -->|No| B{"New reachable commit changes path<br/>to the same blob and mode,<br/>with one recorded work owner?"}
    B -->|Yes| P["Save weaker path-blob evidence"]
    B -->|No| U["Leave file unmatched"]
```

- **Bash route:** covers new commits, reverts and non-fast-forward merges. Rebase and cherry-pick copies keep the original hash in `rewrittenFrom`.
- **Exact matching is per file.** `file-chain` requires a complete chain from the file's state before the edits to its committed state, with one work owning that chain. Other files in the commit can remain unmatched.
- **Rewritten history has a separate match type.** `path-blob` can find the same resulting file after a rebase, squash, checkout or stash changes its parent history. It requires a new reachable commit that changes that path to the recorded blob and mode, and rejects competing work. Equal content is weaker evidence than an observed edit chain, so the method stays visible in `fileMatches`.
- **`transitionIds` points to the saved edits used as evidence.** For example, Kimchi changes a file from A to B, then you commit it after closing Kimchi. The later scan links that exact change and lists its edit IDs.
- **A commit can have several contributions.** File matches keep each work, session and matched paths. Repeating a commit hash does not create another commit or imply another charge.

New edit records reference a snapshot of the visible Git references and worktree heads to exclude commits that already existed before the edit. Edits share a saved snapshot while those references stay the same. Matching can survive removal of the original linked worktree while the repository and new commit remain available. It cannot recover a repository that was deleted entirely.

### 4. Find PRs for recorded commits

Create the PR through Kimchi, a browser or another tool. Kimchi checks for it at startup and every 30 seconds while open. Install `gh` and sign in with `gh auth login` if you have not already done so.

The match starts with a **repository and commit hash** already saved by work tracking. For example, if work A contains commit `abc123` and GitHub returns PR #7 for that commit, Kimchi saves PR #7 under work A. One commit can belong to several PRs; Kimchi keeps every association GitHub returns.

```mermaid
flowchart TD
    C["Work A contains commit abc123"] --> G["Ask GitHub: which PRs contain abc123?"]
    G -->|PR #7 found| L["Save PR #7 and its state under work A"]
    G -->|No PR found| P["Keep the commit waiting"]
    G -->|Check failed| E["Keep saved links and show the reason"]
```

Later checks retry waiting commits and failures. Once a PR is known, Kimchi also checks it by PR number to update its state.

| Case | How Kimchi finds or keeps the link |
| --- | --- |
| A PR is opened in a browser or another tool | GitHub returns it for the recorded commit on a later check. |
| A PR merges while Kimchi is closed | The next launch catches up, including regular and squash merges. |
| A commit is rewritten or removed | Kimchi still checks a saved PR by number. An empty commit lookup does not erase the link. |
| Several PRs contain the commit | All returned PRs are saved, across every result page. |
| Another Kimchi process does the lookup | This session reads the saved result and updates its footer too. |

The footer shows `PR: waiting`, a linked PR such as `PR: #7 open`, or `PR: check /work` when lookup fails. The PR number is a terminal hyperlink to GitHub; use your terminal's link gesture, usually Cmd-click or Ctrl-click. `/work` lists the current work's PR URLs, states, pending commits and errors. ACP clients receive the same status and notifications; how they display them depends on the client.

Each commit keeps two extra fields:

| Field | Meaning |
| --- | --- |
| `prLookup.status` | `pending` when no PR was found, `linked` after a successful lookup with links, or `error` when the lookup failed. A new commit has no lookup result yet. |
| `prLookup.checkedAt` / `error` | Time of the last lookup and its error, when present. |
| `pullRequests[]` | Confirmed links, with repository, host, PR number, URL and current state. Links are kept even if a later lookup fails. |
| `headSha` / `mergeCommitSha` | The PR's head commit and GitHub's merge hash. Before a PR is merged, the latter may be a test-merge hash. Use `state` and `mergedAt` to identify an actual merge. |
| `mergedAt` / `closedAt` / `checkedAt` | GitHub's merge/close times and when Kimchi last checked that PR. |

Lookup uses no model calls. With work tracking present, commit discovery runs under the existing background worker's lease, with a separate time budget from local Git matching. Deleting the original worktree is supported while the repository's shared Git directory remains available.

Work tracking and PR discovery load as separate extensions. Work tracking saves the commits; PR discovery adds their GitHub links. Without the PR extension, local work recording and Git matching still run. Without the work-tracking extension, PR discovery shows the current branch's PR. That branch lookup runs its own read-only check; it does not create work records or link costs. Both load by default; this change adds no setting to disable tracking. Removing the work-tracking extension alone would still leave direct tracking calls in other parts of Kimchi.

GitHub's commit-to-PR endpoint may omit a PR that was closed before Kimchi ever found it. Known closed PRs are rechecked so reopening is detected. This lookup currently supports GitHub repositories accessible through `gh`.

### 5. Build the local summary

Before sending a covered model request, Kimchi saves and flushes its request ID, work ID and session ID. It then sends `X-Request-Id`. This also works with telemetry disabled.

Records with the same work ID go into the same `work.json`. Requests are deduplicated by request ID; commit records keep the contributing sessions. `fileTransitions` keeps the recorded edits, and `continuations` explains why another session adopted the work. IDs identify records; array positions have no meaning.

A request record describes an attempt. It does not prove a successful response or give its cost. The work records and retained plan text stay local; `work.json` contains paths, request metadata and PR links, with no prompts, file contents or prices. PR lookup sends repository and commit identifiers to GitHub through your existing CLI access.

<details>
<summary>Local files and recovery</summary>

All paths below are inside the agent directory.

| File | What it is for |
| --- | --- |
| `work/<workId>/work.json` | Readable summary of sessions, request attempts, plans, file edits, continuation evidence, commits and PR links. |
| `work/<workId>/plans/<name>-<content-hash>.md` | Saved plan versions that survive worktree deletion. Identical content reuses the same copy. |
| `work-attribution/<session-id>.jsonl` | Append-only history used to rebuild the summary. |
| `work-attribution/transitions/*.jsonl` | Edit evidence: request/tool IDs, repository paths, Git blobs and file modes before and after each native edit/write change. |
| `work-attribution/ref-tips/*.json` | Shared snapshots of the commit references and worktree heads visible when an edit was saved. `historyBoundaryId` identifies the snapshot. |

- Each plan record has `path` for the editable file and `snapshotPath` for its retained version. If saving the retained copy fails, Kimchi warns and leaves the local plan usable.
- Kimchi flushes source records before updating `work.json`. Writers merge under a lock and replace the summary atomically. Shutdown waits for queued summary writes.
- Recovery saves the time of its last successful scan plus each summary's size and modification time. It reads source logs changed since then and skips writing unchanged results.
- A missing or invalid known summary triggers a full replay of the source logs, including edit journals. A failed log read or summary write leaves the checkpoint unchanged. Older summaries remain readable when the new collections are absent.

</details>

<details>
<summary>Request coverage and matching limits</summary>

**Model requests**

- Covers the main model, compaction, permission classification, image descriptions, Ferment evaluation and session naming.
- Background memory capture can combine several sessions, so it is not assigned to one work.
- If saving attribution fails, Kimchi warns and continues. Permission checks still apply, but the records can have gaps.

**Bash commits**

- A conflicted rebase or cherry-pick can continue after a restart. Kimchi caches Git's state-file paths per working directory and reads the files before each Bash call. Continuing through another repository's `git -C` can remain unmatched.
- Missing or changed Git history, ambiguous concurrent commands and oversized traces can prevent a match.

**Background commit matching**

- Partial staging, later human edits, competing work, Bash/MCP-only edits, unsupported filters and symlinks can leave files unmatched.
- The scan checks up to 512 recent commits within a time budget. Files, journals and logs have 8 MiB limits. Finished candidates are checkpointed; changed evidence allows another attempt.
- `historyBoundaryId` connects an edit to its saved Git reference snapshot. Large snapshots share the journal's size limits; when the required history is unavailable, Kimchi leaves the weaker match unresolved. Old journals can only use the history they actually recorded.
- Top-level sessions in one process share a worker. Separate processes take turns through a nonblocking lease. Children neither start scans nor wait for a parent's scan at shutdown. Closing the last owning session stops its worker; no separate daemon runs after Kimchi exits.

The implementation uses Pi's existing hooks and native Git tracing. It adds no dependency or upstream patch.

</details>

## What still needs work

- **PR costs:** join requests to billing, then decide how to split one work's cost across several PRs.
- **Backend IDs:** verify that the proxy saves the request/session IDs needed for the billing join. The client records do not yet prove that link.
- **Account and repository IDs:** add account IDs and stable repository IDs from the Git provider.
- **Remote agents:** link their requests and returned commits to the local work. Remote sessions are outside this MVP.

<details>
<summary>Current billing and remote-agent limits</summary>

- With telemetry enabled, main requests send the stored Pi session ID as `X-Session-Id`. Session naming, permission classification and image-description calls do not explicitly send that header.
- Matching by session and time still needs verified proxy storage, header coverage for those calls and a way to separate overlapping work in one session. Client request IDs do not yet have a verified match to streaming backend billing rows.
- Remote ACP requests carry a parent-session tag but no work ID. Returned commits bypass Bash tracing. Both are absent from the parent's work summary.

</details>
