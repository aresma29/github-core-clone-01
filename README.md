# github-core-clone

A GitHub-compatible git forge in one Node process, standard library only
(no npm dependencies, no git binary, no outside service). Built for the
make.fun competition github-core-clone-01.

## Run

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port (port 0 on 0.0.0.0), registers it with
the trial environment at `$MAKEFUN_ENV_URL/register`, then long-polls
`$MAKEFUN_ENV_URL/done` and exits 0 when the trial is over. The trial
bearer token comes from `$MAKEFUN_SHOP_TOKEN`; requests to the API surfaces
without it are 401.

## Surfaces

- **Git smart HTTP** — `/{owner}/{repo}.git`: `info/refs` (v0 with the
  `# service=` preamble, v2 advertisement), `git-upload-pack` (v2
  `ls-refs`/`fetch` with shallow and deepen, and v0 fetch), and
  `git-receive-pack` (v0 with report-status). Packfiles are built and read
  by hand (SHA-1 objects, no delta entries); non-fast-forward pushes are
  rejected with `ng <ref> non-fast-forward`.
- **REST v3** — `/api/v3`: root, meta, user, user repos (paginated with
  `Link` headers), repository CRUD, branches, commits, git refs, contents
  (create/update/delete with blob-sha conflict detection), labels, issues,
  comments, pull requests (files diff, squash merge with conflict
  detection).
- **GraphQL v4** — `/api/graphql`: a small parser and executor for
  `viewer`, `repository`, `node`, issue/pull-request connections, the
  `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations, and `__type` / `__schema`
  introspection. Unknown fields answer HTTP 200 with an `errors` array.
- **MCP** — `/mcp`: JSON-RPC 2.0 over Streamable HTTP, protocol revision
  2026-07-28 (`server/discover`, legacy `initialize`, `tools/list`,
  `tools/call` for create/get/list repos, issues and pull requests, and
  squash merge). Tools share the store with REST and GraphQL.

## Store

Everything lives in memory in `store.ts`: repositories, refs, git objects,
issues, comments, pull requests and labels. Object ids are the git object
ids themselves; GraphQL global ids are opaque base64 `Kind:scope:id`
values. Timestamps come from a logical counter starting at the 2025-01-01
epoch, so repeated runs are deterministic; there is no wall clock and no
randomness anywhere in the entry.

## Local grade

`makefun grade-local --kit <kit> --bot repo --driver process --instances 3`
under Node v22.21.0 (the server runs v22.23.4):

| trial | feature | agent | perf | score | replay |
|---|---|---|---|---|---|
| 0 | 600 | 200 | 131 | 931 | matched byte for byte |
| 1 | 600 | 200 | 140 | 940 | matched byte for byte |
| 2 | 600 | 200 | 149 | 949 | matched byte for byte |
| **mean** | **600** | **200** | **140** | **940** | — |

120/120 checks pass on every trial; each live pass exits 0 on its own
when the env answers `{"done": true}`. Perf is harness-bound on this VM
(the loopback round-trip alone is ~0.5 ms/request): push ~41–43, clone
~28–30, read ~38–39, write ~32–36 points per trial.

## Layout

- `main.ts` — lifecycle only: bind, register, poll `/done`, exit 0.
- `server.ts` — HTTP routing, auth, REST v3 handlers, git smart HTTP.
- `graphql.ts` — GraphQL parser, executor and schema table.
- `mcp.ts` — MCP endpoint and the tool implementations.
- `gitwire.ts` — pkt-line codec, SHA-1 object hashing, pack read/write,
  reachability.
- `store.ts` — the in-memory store: repos, refs, issues, PRs, tree maps,
  commit and diff helpers.
