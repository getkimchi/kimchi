# Check PR cost accuracy

Compare a saved `costs.json` with an independent request inventory, billing receipts and human PR labels:

```sh
pnpm exec tsx src/extensions/work-attribution/accuracy-cli.ts report.json reference.json
```

The command reads these two files and prints the differences. It makes no network or model calls, reads no credentials and writes nothing. Keep real receipts and labels outside the repository.

## Prepare the reference before inspecting matcher output

Use provider or gateway receipts to list requests, their billing accounts and exact billed prices. Label which PR each request belongs to using the task history and Git evidence. Do not generate this reference from `work.json`, `costs.json`, matcher confidence or the allocator under test: that would repeat the same mistakes on both sides.

The version 1 reference has one entry per request:

```json
{
  "version": 1,
  "requests": [
    {
      "requestId": "request-1",
      "account": {
        "apiUrl": "https://api.example.test",
        "organizationId": "11111111-1111-4111-8111-111111111111",
        "userId": "22222222-2222-4222-8222-222222222222"
      },
      "costUsd": "1.000000001",
      "expected": {
        "kind": "pull-request",
        "pullRequestId": "github:github.com/acme/api#7"
      }
    }
  ]
}
```

- `requestId` joins the independent inventory to a recorded request.
- `account` identifies the billing API, organization and API-key owner from independent evidence. Use the recorded API base URL and both UUIDs. Do not copy them from the report or use today's login to fill a gap. The command validates these fields without contacting the provider.
- `costUsd` is the exact billed USD amount as a decimal string, with at most nine fractional digits. Use `null` when the receipt is missing; zero means a confirmed free request.
- `expected` is the human ownership label. Use the complete `provider:host/owner/repo#number` key from independent Git evidence; GitLab subgroup paths are allowed.

These ownership labels keep different cases separate:

| Label | Meaning |
| --- | --- |
| `{"kind":"pull-request","pullRequestId":"github:github.com/acme/api#7"}` | The request belongs exclusively to this merged PR. |
| `{"kind":"shared","pullRequestIds":["github:github.com/acme/api#7","github:github.com/acme/api#8"]}` | Both PRs share the request. Its charge stays in the shared bucket; the check does not divide it. |
| `{"kind":"no-pr","reason":"unlinked"}` | This request should have no PR allocation. `reason` defaults to `unlinked`; use `unmerged` or `post-merge` for those cases. |
| `{"kind":"unknown"}` | The human reviewer cannot decide. The result remains incomplete. |

Repeated labels are errors, even if identical. Conflicting accounts, ownership or prices are reported separately. Missing account evidence, a missing captured request, an unlabelled observed request or a missing price prevents a complete result.

## What gets checked

The report must contain the full `requests`, `pullRequests` and `unallocated` fields produced by the cost calculator. The check compares:

1. Request coverage in both directions, including requests that were never captured.
2. Each request's account and charge against its independent receipt.
3. Request ownership, including the complete shared PR set.
4. Each PR's exclusive total and request membership, plus its shared, inferred and unknown references.
5. The inferred, shared, unlinked, unmerged, post-merge and unknown aggregate buckets.

PR totals use the account and the complete PR key together. Two users billed for the same PR get separate output lines; a charge under the wrong account is a disagreement. Two totals for the same account and PR are malformed evidence.

With priced, exclusively labelled requests and no shared labels, a PR's expected final amount comes from the independent receipts. A reported open or closed state cannot turn that amount into unknown. This includes confirmed zero.

When no independently labelled request belongs exclusively to a PR, the command checks final totals against the report's provider state. An open or closed PR keeps an unknown final total; a merged PR with only post-merge requests has a confirmed zero exclusive total. Provider state itself is not independently verified by the offline command.

An `inferred` request has candidate PRs but no confirmed assignment. Its billed amount belongs in `unallocated.inferred`, and each candidate lists it in `inferredRequestIds`. The check verifies that these lists and amounts agree with the report's requests. These bookkeeping checks do not turn a candidate into a human ownership label: if the independent label expects one PR, the inferred request still counts as missed coverage.

Amounts use integer arithmetic. The check shows each PR's signed error and the sum of absolute PR errors. Overcharging one PR by USD 1 and undercharging another by USD 1 yields USD 2 of absolute error, not zero. Missing evidence makes full errors unavailable; unknown prices are never displayed as zero-dollar expectations.

A request marked `priced` must have a valid decimal-string `totalCostUsd`. Missing or malformed final amounts make the comparison incomplete. If a valid amount differs from its receipt, the diagnostic names the differing field.

## Read the metrics

**Wrong assignment** divides wrongly assigned spending by all confidently assigned, labelled spending. If USD 1 is assigned correctly and USD 3 of unrelated chat is assigned to a PR, the result is 75% wrong assignment.

**Correct coverage** divides correctly assigned spending by labelled spending expected exclusively on a PR. Inferred, unresolved or shared output misses a label that expects one exclusive PR. A confirmed assignment to the wrong account also misses that label and counts as wrong. Correctly shared requests are checked in their own bucket, outside this exclusive-coverage denominator.

Version 1 weights both metrics by independent receipt prices. The command also prints the same ratios by request count, so free or inexpensive requests remain visible. Zero denominators show `n/a`; incomplete comparisons suppress full percentages. Nine-decimal percentages are truncated, not rounded.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The version 1 reference is complete and all checked report values match. |
| 1 | The command cannot run: wrong arguments, unreadable or invalid JSON, or an unsupported top-level input shape. |
| 2 | Evidence is incomplete or malformed. Known amounts and the missing evidence are listed. |
| 3 | The evidence is complete, but prices, ownership or aggregate totals differ. |

An offline match proves agreement with the supplied reference. It does not establish that human labels are correct or represent ordinary usage. Keep held-out tasks separate from cases used to tune the matcher.

## Older label-only files

The command still accepts the previous array format:

```json
[
  { "requestId": "request-1", "expectedPullRequestId": "github:github.com/acme/api#7" },
  { "requestId": "request-2", "expectedPullRequestId": null }
]
```

This mode checks request ownership and label coverage using the report's own prices. Its output says that accounts, prices and aggregates were not independently checked. Exit 0 means the label comparison is complete, even when it found wrong assignments. Use a version 1 reference for a pass/fail check of full PR totals.

The label-only output includes observed, labelled, priced and scored request counts, known report spending, and scored spending. A USD 10 report with only USD 1 labelled is incomplete, including when the unlabelled requests were free.
