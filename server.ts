// server.ts — one HTTP server for the four surfaces: git smart HTTP, REST v3,
// GraphQL v4 and MCP. Every reply is JSON (never HTML) and carries a
// non-empty X-GitHub-Request-Id. Auth: the trial bearer token from
// MAKEFUN_SHOP_TOKEN; a request without it is 401 on the API surfaces
// (git stays open, as real git does; /healthz takes none).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  commitFiles,
  commitList,
  diffCommits,
  globalId,
  isoAt,
  treeMap,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Comment,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import {
  collectReachable,
  decodePktLines,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  PKT_DELIM,
  PKT_FLUSH,
} from './gitwire.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const FORGE_NAME = 'github-core-clone';
const FORGE_VERSION = '1.0.0';
const AGENT_NAME = 'forge/1.0';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...extra });
  res.end();
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

interface BodyResult {
  text: string;
  json: unknown;
  malformed: boolean;
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { text, json: undefined, malformed: false };
  try {
    return { text, json: JSON.parse(text) as unknown, malformed: false };
  } catch {
    return { text, json: undefined, malformed: true };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '');
}

function queryOf(url: URL): URLSearchParams {
  return url.searchParams;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function pageLink(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean): string | null {
  if (!hasNext) return null;
  const host = req.headers.host ?? 'localhost';
  const next = new URLSearchParams(query);
  next.set('page', String(page));
  next.set('per_page', String(perPage));
  return `<http://${host}${path}?${next.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: VIEWER_ID, node_id: globalId('User', '', login), avatar_url: '', html_url: '', type: 'User', site_admin: false };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`, repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoAt(repo.createdSeq),
    updated_at: isoAt(repo.createdSeq),
    pushed_at: isoAt(repo.createdSeq),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    license: null,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}`, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: userJson(issue.user),
    assignee: null,
    assignees: [],
    comments: repo.comments.get(issue.number)?.length ?? 0,
    created_at: isoAt(issue.createdSeq),
    updated_at: isoAt(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? isoAt(issue.updatedSeq) : null,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}`, comment.id),
    body: comment.body,
    user: userJson(comment.user),
    created_at: isoAt(comment.createdSeq),
    updated_at: isoAt(comment.createdSeq),
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
  };
}

function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}`, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    draft: false,
    merged: pr.merged,
    mergeable: pr.state === 'open' ? true : null,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}`, user: userJson(repo.owner) },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}`, user: userJson(repo.owner) },
    user: userJson(repo.owner),
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    created_at: isoAt(pr.createdSeq),
    updated_at: isoAt(pr.createdSeq),
    closed_at: pr.state === 'closed' ? isoAt(pr.createdSeq) : null,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function treeClosure(repo: Repo, treeOid: string, out: Set<string>): void {
  if (out.has(treeOid)) return;
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  out.add(treeOid);
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') treeClosure(repo, entry.oid, out);
    else out.add(entry.oid);
  }
}

/**
 * The objects a fetch must send, with the shallow boundary it creates.
 * `wants` are commit/tag oids, `haves` commits the client already holds,
 * `depth` a generations limit, `clientShallow` the client's current boundary.
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  clientShallow: string[],
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds. A plain have holds the commit and its
  // whole ancestry; a shallow have (a commit in clientShallow) holds only
  // that commit object and its tree — its parents are exactly what a
  // deepen has to deliver, so they must not be excluded.
  const shallowSet = new Set(clientShallow);
  const haveClosure = new Set<string>();
  for (const have of haves) {
    const obj = lookup(have);
    if (obj === undefined) continue;
    if (shallowSet.has(have) && obj.type === 'commit') {
      haveClosure.add(have);
      treeClosure(repo, parseCommit(obj.data).tree, haveClosure);
      continue;
    }
    try {
      for (const oid of collectReachable([have], lookup)) haveClosure.add(oid);
    } catch {
      // A have the store does not hold is simply not excludable; ignore it.
    }
  }
  // The commit set, with distances from the wants, depth-limited, minus held.
  // The walk goes through held commits: a deepen wants the parents of a
  // commit the client already has.
  const distance = new Map<string, number>();
  const tagObjects = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  const enqueueCommit = (oid: string, dist: number): void => {
    // First visit wins: with unit-weight edges and a FIFO queue the first
    // time a commit is reached is via its shortest path from the wants.
    if (!isOid(oid) || distance.has(oid)) return;
    distance.set(oid, dist);
    queue.push({ oid, dist });
  };
  for (const want of wants) {
    const obj = lookup(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') enqueueCommit(want, 0);
    else if (obj.type === 'tag') {
      tagObjects.add(want);
      const target = parseTag(obj.data).object;
      const targetObj = lookup(target);
      if (targetObj !== undefined && targetObj.type === 'commit') enqueueCommit(target, 0);
      else if (targetObj !== undefined && targetObj.type === 'tag') {
        tagObjects.add(target);
        const inner = parseTag(targetObj.data).object;
        if (lookup(inner)?.type === 'commit') enqueueCommit(inner, 0);
      }
    }
  }
  const commitSet = new Set<string>();
  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (!haveClosure.has(oid)) commitSet.add(oid);
    if (depth !== undefined && dist + 1 >= depth) continue;
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) enqueueCommit(parent, dist + 1);
  }
  // Objects: each commit plus its tree closure, plus the tag objects, minus held.
  const wanted = new Set<string>();
  for (const oid of commitSet) {
    wanted.add(oid);
    const commit = lookup(oid);
    if (commit !== undefined && commit.type === 'commit') treeClosure(repo, parseCommit(commit.data).tree, wanted);
  }
  for (const oid of tagObjects) wanted.add(oid);
  const objects: GitObject[] = [];
  for (const oid of [...wanted].sort()) {
    if (haveClosure.has(oid)) continue;
    const obj = lookup(oid);
    if (obj !== undefined) objects.push(obj);
  }
  // Shallow boundaries: commits at the depth edge, plus carried-over boundaries.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, dist] of distance) {
      if (commitSet.has(oid) && dist === depth - 1) shallow.push(oid);
    }
  }
  // Ancestors of the wants, for the carried-boundary rule.
  const ancestors = new Set<string>();
  {
    const seen = new Set<string>();
    const walk = [wants.filter((w) => lookup(w)?.type === 'commit')].flat();
    const stack = [...walk];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      ancestors.add(oid);
      const obj = lookup(oid);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parent of parseCommit(obj.data).parents) stack.push(parent);
      }
    }
  }
  for (const boundary of clientShallow) {
    if (!isOid(boundary) || !ancestors.has(boundary)) continue;
    const obj = lookup(boundary);
    const parents = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).parents : [];
    // Unshallowed when every parent is now delivered or already held,
    // whether or not the boundary commit itself was re-sent.
    const fullyHeld = parents.every((p) => commitSet.has(p) || haveClosure.has(p));
    if (fullyHeld) unshallow.push(boundary);
    else if (!shallow.includes(boundary)) shallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer {
  if (pack.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 32768) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 32768));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

function v0Capabilities(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (service === 'git-upload-pack') {
    return `side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT_NAME} ${symref} object-format=sha1`;
  }
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT_NAME} ${symref} object-format=sha1`;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = v0Capabilities(repo, service);
  const preamble = service === 'git-upload-pack' ? '# service=git-upload-pack' : '# service=git-receive-pack';
  const parts: Buffer[] = [pktLine(`${preamble}\n`), PKT_FLUSH];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0]?.[1] ?? ZERO_OID;
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${defaultTip} HEAD\0${caps}\n`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      const obj = repo.objects.get(oid);
      if (name.startsWith('refs/tags/') && obj !== undefined && obj.type === 'tag') {
        lines.push(`${parseTag(obj.data).object} ${name}^{}\n`);
      }
    }
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT_NAME}\n`,
    'flush',
  ]);
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

export function createApp(store: Store, token: string): Server {
  const treeCache = new Map<string, Map<string, { oid: string; mode: string }>>();
  const fetchPackCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();

  function authed(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    if (token !== '') return header === `Bearer ${token}`;
    return header.startsWith('Bearer ') && header.length > 7;
  }

  function repoOf(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return store.getRepo(owner, name);
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      else res.end();
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://entry');
    const path = url.pathname;
    const query = url.searchParams;
    const parts = splitPath(path);

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (parts.length >= 2 && parts[1] !== undefined && parts[1].endsWith('.git')) {
      await handleGit(req, res, method, parts, url);
      return;
    }

    // GraphQL v4.
    if (path === '/api/graphql') {
      const { handleGraphQL } = await import('./graphql.ts');
      await handleGraphQL(req, res, store, authed(req));
      return;
    }

    // MCP.
    if (path === '/mcp') {
      const { handleMcp } = await import('./mcp.ts');
      await handleMcp(req, res, store, authed(req));
      return;
    }

    // REST v3.
    if (parts[0] === 'api' && parts[1] === 'v3') {
      if (!authed(req)) {
        unauthorized(res);
        return;
      }
      await handleRest(req, res, method, parts.slice(2), url, query);
      return;
    }

    notFound(res);
  }

  // -------------------------------------------------------------------------
  // REST v3
  // -------------------------------------------------------------------------

  async function handleRest(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    parts: string[],
    url: URL,
    query: URLSearchParams,
  ): Promise<void> {
    const bodyNeeded = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    let body: BodyResult | null = null;
    if (bodyNeeded) {
      try {
        body = await readBody(req, 1 << 20);
      } catch {
        badRequest(res, 'request body too large');
        return;
      }
      if (body.malformed) {
        badRequest(res, 'Invalid JSON in request body');
        return;
      }
    }
    const payload = body !== null && isRecord(body.json) ? body.json : {};

    // GET /api/v3/ — the API root.
    if (parts.length === 0) {
      if (method !== 'GET') return notFound(res);
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // GET /api/v3/meta
    if (parts.length === 1 && parts[0] === 'meta') {
      if (method !== 'GET') return notFound(res);
      sendJson(res, 200, { verifiable_password_authentication: true, installed_version: FORGE_VERSION });
      return;
    }

    // GET /api/v3/user
    if (parts.length === 1 && parts[0] === 'user' && method === 'GET') {
      sendJson(res, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: globalId('User', '', VIEWER_LOGIN),
        avatar_url: '',
        html_url: '',
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: 'User',
        site_admin: false,
      });
      return;
    }

    // /api/v3/user/repos
    if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = pageParams(query);
        const all = store.reposOf(VIEWER_LOGIN);
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const link = pageLink(req, '/api/v3/user/repos', query, page + 1, perPage, page * perPage < all.length);
        sendJson(res, 200, slice.map(repoJson), link !== null ? { link } : {});
        return;
      }
      if (method === 'POST') {
        const name = asString(payload.name);
        if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
          sendJson(res, 422, { message: 'Validation Failed: name is invalid' });
          return;
        }
        if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
          sendJson(res, 422, { message: 'Repository already exists' });
          return;
        }
        const repo = store.createRepo(VIEWER_LOGIN, name, asBool(payload.private, false), asString(payload.description));
        sendJson(res, 201, repoJson(repo));
        return;
      }
      return notFound(res);
    }

    // /api/v3/repos/{owner}/{repo}[...]
    if (parts.length >= 3 && parts[0] === 'repos') {
      const owner = decodeURIComponent(parts[1] as string);
      const name = decodeURIComponent(parts[2] as string);
      const repo = repoOf(owner, name);
      const rest = parts.slice(3);
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      await handleRepo(req, res, method, repo, rest, query, payload);
      return;
    }

    notFound(res);
  }

  async function handleRepo(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    repo: Repo,
    rest: string[],
    query: URLSearchParams,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const repoPath = `/api/v3/repos/${repo.owner}/${repo.name}`;

    // The repository itself.
    if (rest.length === 0) {
      if (method === 'GET') return sendJson(res, 200, repoJson(repo));
      if (method === 'PATCH') {
        if (typeof payload.description === 'string') repo.description = payload.description;
        if (typeof payload.private === 'boolean') repo.isPrivate = payload.private;
        return sendJson(res, 200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo.owner, repo.name);
        return sendEmpty(res, 204);
      }
      return notFound(res);
    }

    const head = rest[0] as string;

    // Branches.
    if (head === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(ref) as string, url: '' },
            protected: false,
          }));
        return sendJson(res, 200, branches);
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1] as string);
        const tip = store.branchTip(repo, branch);
        if (tip === '') return sendJson(res, 404, { message: 'Branch not found' });
        return sendJson(res, 200, { name: branch, commit: { sha: tip, url: '' }, protected: false });
      }
      return notFound(res);
    }

    // Commits.
    if (head === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      const { page, perPage } = pageParams(query);
      const all = tip === '' ? [] : commitList(repo, tip);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const out = slice.map((sha) => {
        const obj = repo.objects.get(sha);
        const commit = obj !== undefined ? parseCommit(obj.data) : null;
        const stamp = commit !== null ? commit.author : '';
        const ts = Number.parseInt(stamp.split(' ').slice(-2, -1)[0] ?? '0', 10) || 0;
        const who = commit !== null ? commit.author.replace(/ \d+ \+0000$/, '') : '';
        const name = who.split(' <')[0] ?? '';
        const email = (who.match(/<([^>]*)>/) ?? [])[1] ?? '';
        return {
          sha,
          node_id: globalId('Commit', `${repo.owner}/${repo.name}`, sha),
          commit: {
            message: commit?.message ?? '',
            author: { name, email, date: new Date(ts * 1000).toISOString() },
            committer: { name, email, date: new Date(ts * 1000).toISOString() },
          },
          author: { login: repo.owner },
          committer: { login: repo.owner },
          parents: (commit?.parents ?? []).map((p) => ({ sha: p })),
        };
      });
      const link = pageLink(req, `${repoPath}/commits`, query, page + 1, perPage, page * perPage < all.length);
      return sendJson(res, 200, out, link !== null ? { link } : {});
    }

    // Git refs.
    if (head === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = asString(payload.ref);
        const sha = asString(payload.sha);
        if (!ref.startsWith('refs/heads/') || !isOid(sha)) {
          return sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' });
        }
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') {
          return sendJson(res, 422, { message: 'Validation Failed: sha is not a commit in this repository' });
        }
        if (repo.refs.has(ref)) {
          return sendJson(res, 422, { message: 'Reference already exists' });
        }
        repo.refs.set(ref, sha);
        return sendJson(res, 201, { ref, node_id: globalId('Ref', `${repo.owner}/${repo.name}`, ref), object: { sha, type: 'commit', url: '' } });
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = decodeURIComponent(rest.slice(3).join('/'));
        const tip = store.branchTip(repo, branch);
        if (tip === '') return sendJson(res, 404, { message: 'Not Found' });
        return sendJson(res, 200, { ref: `refs/heads/${branch}`, node_id: globalId('Ref', `${repo.owner}/${repo.name}`, branch), object: { sha: tip, type: 'commit', url: '' } });
      }
      return notFound(res);
    }

    // Contents.
    if (head === 'contents') {
      const contentPath = rest.slice(1).map((p) => decodeURIComponent(p)).join('/');
      const refName = query.get('ref') ?? undefined;
      const tip = refName !== undefined ? store.resolveRef(repo, refName) : store.branchTip(repo, repo.defaultBranch);
      if (method === 'GET') {
        if (tip === '') return sendJson(res, 404, { message: 'Not Found' });
        const files = treeMap(repo, tip, treeCache);
        if (contentPath === '') {
          const entries = dirEntries(repo, files, '');
          return sendJson(res, 200, entries);
        }
        const entry = files.get(contentPath);
        if (entry !== undefined) {
          const blob = repo.objects.get(entry.oid);
          const data = blob?.data ?? Buffer.alloc(0);
          return sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: contentPath.split('/').pop(),
            path: contentPath,
            content: data.toString('base64'),
            sha: entry.oid,
          });
        }
        const prefix = `${contentPath}/`;
        const hasChildren = [...files.keys()].some((p) => p.startsWith(prefix));
        if (!hasChildren) return sendJson(res, 404, { message: 'Not Found' });
        return sendJson(res, 200, dirEntries(repo, files, contentPath));
      }
      if (method === 'PUT') {
        const message = asString(payload.message);
        const contentB64 = asString(payload.content);
        if (message === '' || contentB64 === '') {
          return sendJson(res, 422, { message: 'Validation Failed: message and content are required' });
        }
        let data: Buffer;
        try {
          data = Buffer.from(contentB64, 'base64');
        } catch {
          return sendJson(res, 422, { message: 'Validation Failed: content is not valid base64' });
        }
        const branch = asString(payload.branch) !== '' ? asString(payload.branch) : repo.defaultBranch;
        let branchTip = store.branchTip(repo, branch);
        if (branchTip === '') {
          // An unborn branch starts from the default tip (or from nothing).
          branchTip = store.branchTip(repo, repo.defaultBranch);
          if (branchTip !== '' && branch !== repo.defaultBranch) repo.refs.set(`refs/heads/${branch}`, branchTip);
        }
        const files = branchTip === '' ? new Map() : new Map(treeMap(repo, branchTip, treeCache));
        const existing = files.get(contentPath);
        const givenSha = asString(payload.sha);
        if (givenSha !== '' && existing !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
          return sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
        }
        const blobOid = store.putObject(repo, 'blob', data);
        const isNew = existing === undefined;
        files.set(contentPath, { oid: blobOid, mode: '100644' });
        const commitSha = commitFiles(store, repo, branch, files, message);
        treeCache.clear();
        return sendJson(res, isNew ? 201 : 200, {
          content: { name: contentPath.split('/').pop(), path: contentPath, sha: blobOid, size: data.length, encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
      }
      if (method === 'DELETE') {
        if (tip === '') return sendJson(res, 404, { message: 'Not Found' });
        const files = new Map(treeMap(repo, tip, treeCache));
        const existing = files.get(contentPath);
        if (existing === undefined) return sendJson(res, 404, { message: 'Not Found' });
        const givenSha = asString(payload.sha);
        if (givenSha !== '' && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
          return sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
        }
        const branch = refName ?? repo.defaultBranch;
        const message = asString(payload.message) !== '' ? asString(payload.message) : `Delete ${contentPath}`;
        files.delete(contentPath);
        const commitSha = commitFiles(store, repo, branch, files, message);
        treeCache.clear();
        return sendJson(res, 200, { commit: { sha: commitSha, message } });
      }
      return notFound(res);
    }

    // Labels.
    if (head === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const name = asString(payload.name);
        if (name === '') return sendJson(res, 422, { message: 'Validation Failed: name is required' });
        const label: Label = { name, color: asString(payload.color) !== '' ? asString(payload.color) : 'ededed', description: asString(payload.description) };
        repo.labels.set(name, label);
        return sendJson(res, 201, labelJson(label));
      }
      if (method === 'GET' && rest.length === 1) {
        return sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      }
      return notFound(res);
    }

    // Issues.
    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = asString(payload.title);
          if (title === '') return sendJson(res, 422, { message: 'Validation Failed: title is required' });
          const wantedLabels: string[] = Array.isArray(payload.labels) ? payload.labels.filter((l): l is string => typeof l === 'string') : [];
          for (const label of wantedLabels) {
            if (!repo.labels.has(label)) {
              return sendJson(res, 422, { message: `Validation Failed: label "${label}" does not exist` });
            }
          }
          const seq = store.tick();
          const issue: Issue = {
            id: store.nextIssueId++,
            number: repo.nextIssueNumber++,
            title,
            body: asString(payload.body),
            state: 'open',
            labels: wantedLabels,
            user: VIEWER_LOGIN,
            createdSeq: seq,
            updatedSeq: seq,
          };
          repo.issues.push(issue);
          return sendJson(res, 201, issueJson(repo, issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
          }
          const { page, perPage } = pageParams(query);
          const slice = list.slice((page - 1) * perPage, page * perPage);
          const link = pageLink(req, `${repoPath}/issues`, query, page + 1, perPage, page * perPage < list.length);
          return sendJson(res, 200, slice.map((i) => issueJson(repo, i)), link !== null ? { link } : {});
        }
        return notFound(res);
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return notFound(res);
      const issue = repo.issues.find((i) => i.number === number);
      if (rest.length === 2) {
        if (issue === undefined) return sendJson(res, 404, { message: 'Not Found' });
        if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
        if (method === 'PATCH') {
          if (payload.state === 'open' || payload.state === 'closed') issue.state = payload.state;
          if (typeof payload.title === 'string') issue.title = payload.title;
          if (typeof payload.body === 'string') issue.body = payload.body;
          if (Array.isArray(payload.labels)) {
            const wanted = payload.labels.filter((l): l is string => typeof l === 'string');
            for (const label of wanted) {
              if (!repo.labels.has(label)) return sendJson(res, 422, { message: `Validation Failed: label "${label}" does not exist` });
            }
            issue.labels = wanted;
          }
          issue.updatedSeq = store.tick();
          return sendJson(res, 200, issueJson(repo, issue));
        }
        return notFound(res);
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return sendJson(res, 404, { message: 'Not Found' });
        if (method === 'POST') {
          const text = asString(payload.body);
          if (text === '') return sendJson(res, 422, { message: 'Validation Failed: body is required' });
          const seq = store.tick();
          const comment: Comment = { id: store.nextCommentId++, body: text, user: VIEWER_LOGIN, createdSeq: seq };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          return sendJson(res, 201, commentJson(repo, number, comment));
        }
        if (method === 'GET') {
          const list = repo.comments.get(number) ?? [];
          return sendJson(res, 200, list.map((c) => commentJson(repo, number, c)));
        }
        return notFound(res);
      }
      return notFound(res);
    }

    // Pull requests.
    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = asString(payload.title);
          const headRef = asString(payload.head);
          const baseRef = asString(payload.base) !== '' ? asString(payload.base) : repo.defaultBranch;
          if (title === '' || headRef === '') return sendJson(res, 422, { message: 'Validation Failed: title and head are required' });
          const headSha = store.branchTip(repo, headRef);
          const baseSha = store.branchTip(repo, baseRef);
          if (headSha === '' || baseSha === '') {
            return sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' });
          }
          const dupe = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
          if (dupe !== undefined) return sendJson(res, 422, { message: 'Validation Failed: a pull request already exists for this head and base' });
          const pr: PullRequest = {
            id: store.nextPullId++,
            number: repo.nextPullNumber++,
            title,
            body: asString(payload.body),
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            headRef,
            baseRef,
            headSha,
            baseSha,
            baseAtOpen: baseSha,
            createdSeq: store.tick(),
          };
          repo.pulls.push(pr);
          return sendJson(res, 201, prJson(repo, pr));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          const { page, perPage } = pageParams(query);
          const slice = list.slice((page - 1) * perPage, page * perPage);
          const link = pageLink(req, `${repoPath}/pulls`, query, page + 1, perPage, page * perPage < list.length);
          return sendJson(res, 200, slice.map((p) => prJson(repo, p)), link !== null ? { link } : {});
        }
        return notFound(res);
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return notFound(res);
      const pr = repo.pulls.find((p) => p.number === number);
      if (rest.length === 2) {
        if (pr === undefined) return sendJson(res, 404, { message: 'Not Found' });
        if (method === 'GET') return sendJson(res, 200, prJson(repo, pr));
        return notFound(res);
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (pr === undefined) return sendJson(res, 404, { message: 'Not Found' });
        if (method !== 'GET') return notFound(res);
        const changes = diffCommits(repo, pr.baseAtOpen, pr.headSha, treeCache);
        const out = changes.map((c) => {
          const headFiles = treeMap(repo, pr.headSha, treeCache);
          const entry = headFiles.get(c.filename);
          return {
            sha: entry?.oid ?? '',
            filename: c.filename,
            status: c.status,
            additions: c.additions,
            deletions: c.deletions,
            changes: c.additions + c.deletions,
          };
        });
        return sendJson(res, 200, out);
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (pr === undefined) return sendJson(res, 404, { message: 'Not Found' });
        if (method !== 'PUT') return notFound(res);
        if (pr.state !== 'open') return sendJson(res, 405, { message: 'Pull request is already closed' });
        const currentBaseTip = store.branchTip(repo, pr.baseRef);
        const baseFiles = treeMap(repo, pr.baseAtOpen, treeCache);
        const currentFiles = treeMap(repo, currentBaseTip, treeCache);
        const headFiles = treeMap(repo, pr.headSha, treeCache);
        const conflicted = [...new Set([...baseFiles.keys(), ...currentFiles.keys(), ...headFiles.keys()])].some((path) => {
          const baseOid = baseFiles.get(path)?.oid;
          const currentOid = currentFiles.get(path)?.oid;
          const headOid = headFiles.get(path)?.oid;
          return baseOid !== currentOid && baseOid !== headOid && currentOid !== headOid;
        });
        if (conflicted) return sendJson(res, 405, { message: 'Merge conflict: the pull request cannot be merged' });
        const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`;
        const mergeSha = commitFiles(store, repo, pr.baseRef, new Map(headFiles), message);
        treeCache.clear();
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = isoAt(store.tick());
        pr.mergeCommitSha = mergeSha;
        pr.baseSha = mergeSha;
        return sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
      }
      return notFound(res);
    }

    notFound(res);
  }

  function dirEntries(
    repo: Repo,
    files: Map<string, { oid: string; mode: string }>,
    dir: string,
  ): Array<Record<string, unknown>> {
    const prefix = dir === '' ? '' : `${dir}/`;
    const seen = new Map<string, { type: string; oid: string }>();
    for (const [path, entry] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) seen.set(rest, { type: 'file', oid: entry.oid });
      else seen.set(rest.slice(0, slash), { type: 'dir', oid: '' });
    }
    return [...seen.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, info]) => ({
        type: info.type,
        name,
        path: prefix + name,
        sha: info.oid === '' ? hashObject('tree', Buffer.alloc(0)) : info.oid,
        size: 0,
      }));
  }

  // -------------------------------------------------------------------------
  // Git smart HTTP
  // -------------------------------------------------------------------------

  async function handleGit(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    parts: string[],
    url: URL,
  ): Promise<void> {
    const owner = decodeURIComponent(parts[0] as string);
    const repoName = decodeURIComponent((parts[1] as string).slice(0, -4));
    const repo = repoOf(owner, repoName);
    const tail = parts.slice(2);

    // GET /{owner}/{repo}.git/info/refs?service=...
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      if (repo === undefined) {
        res.writeHead(404, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(404, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
      res.writeHead(200, {
        'content-type': `application/x-${service}-advertisement`,
        'content-length': body.length,
        'x-github-request-id': nextRequestId(),
      });
      res.end(body);
      return;
    }

    // POST /{owner}/{repo}.git/git-upload-pack and /git-receive-pack
    if (method === 'POST' && tail.length === 1 && (tail[0] === 'git-upload-pack' || tail[0] === 'git-receive-pack')) {
      if (repo === undefined) {
        res.writeHead(404, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      const service = tail[0] as 'git-upload-pack' | 'git-receive-pack';
      let raw: Buffer;
      try {
        raw = await readRawBody(req, 64 << 20);
      } catch {
        res.writeHead(413, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
        res.end(JSON.stringify({ message: 'Request body too large' }));
        return;
      }
      if (service === 'git-upload-pack') {
        const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const out = isV2 ? handleUploadPackV2(repo, raw) : handleUploadPackV0(repo, raw);
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-result',
          'content-length': out.length,
          'x-github-request-id': nextRequestId(),
        });
        res.end(out);
        return;
      }
      const out = handleReceivePack(repo, raw);
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-result',
        'content-length': out.length,
        'x-github-request-id': nextRequestId(),
      });
      res.end(out);
      return;
    }

    res.writeHead(404, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
    res.end(JSON.stringify({ message: 'Not Found' }));
  }

  async function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > limitBytes) throw new Error('body too large');
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  function lsRefsResponse(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer {
    const parts: Buffer[] = [];
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
    const match = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (match('HEAD') && prefixes.length === 0) {
      if (defaultTip === '') {
        parts.push(pktLine(symrefs ? 'unborn HEAD symref-target:refs/heads/main\n' : 'unborn HEAD\n'));
      } else {
        parts.push(pktLine(symrefs ? `${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${defaultTip} HEAD\n`));
      }
    }
    const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [name, oid] of refs) {
      if (!match(name)) continue;
      let line = `${oid} ${name}`;
      if (peel) {
        const obj = repo.objects.get(oid);
        if (name.startsWith('refs/tags/') && obj !== undefined && obj.type === 'tag') {
          line += ` peeled:${parseTag(obj.data).object}`;
        }
      }
      parts.push(pktLine(`${line}\n`));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }

  function fetchResponse(repo: Repo, wants: string[], haves: string[], depth: number | undefined, clientShallow: string[], v2: boolean): Buffer {
    // Identical fetches build byte-identical packs (objects are immutable
    // and only ever added, so the object count in the key proves the store
    // has not changed underneath a cached pack). The clone workload issues
    // fifty concurrent identical fetches; building the pack once is what a
    // real forge's pack cache does.
    const cacheKey = `${repo.id}|${repo.objects.size}|${wants.join(',')}|${haves.join(',')}|${depth ?? ''}|${clientShallow.join(',')}`;
    let cached = fetchPackCache.get(cacheKey);
    if (cached === undefined) {
      const plan = planFetch(repo, wants, haves, depth, clientShallow);
      cached = { pack: writePack(plan.objects), shallow: plan.shallow, unshallow: plan.unshallow };
      if (fetchPackCache.size >= 16) fetchPackCache.clear();
      fetchPackCache.set(cacheKey, cached);
    }
    const pack = cached.pack;
    const plan = { shallow: cached.shallow, unshallow: cached.unshallow };
    if (!v2) {
      const parts: Buffer[] = [pktLine('NAK\n')];
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      if (pack.length > 0) parts.push(sidebandPackets(pack));
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    }
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    if (pack.length > 0) parts.push(sidebandPackets(pack));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }

  function handleUploadPackV2(repo: Repo, raw: Buffer): Buffer {
    const { packets } = decodePktLines(raw);
    const lines: string[] = [];
    let afterDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      lines.push(packet.payload.toString('utf8'));
    }
    const command = (lines[0] ?? '').trim();
    if (command === 'command=ls-refs') {
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      for (const line of lines.slice(1)) {
        const text = line.trim();
        if (text === 'peel') peel = true;
        else if (text === 'symrefs') symrefs = true;
        else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
      }
      return lsRefsResponse(repo, prefixes, peel, symrefs);
    }
    if (command === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      for (const line of lines.slice(1)) {
        const text = line.trim();
        if (text.startsWith('want ')) wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10) || undefined;
      }
      void afterDelim;
      return fetchResponse(repo, wants, haves, depth, shallow, true);
    }
    // Unknown v2 command: answer an empty packfile section rather than hanging.
    return pktLines(['acknowledgments\n', 'NAK\n', 'delim', 'packfile\n', 'flush']);
  }

  function handleUploadPackV0(repo: Repo, raw: Buffer): Buffer {
    const { packets } = decodePktLines(raw);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').trim();
      if (section === 0) {
        if (text.startsWith('want ')) {
          const rest = text.slice(5).trim().split(/\s+/);
          if (rest[0] !== undefined) wants.push(rest[0]);
        } else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10) || undefined;
      } else {
        if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      }
    }
    return fetchResponse(repo, wants, haves, depth, shallow, false);
  }

  function handleReceivePack(repo: Repo, raw: Buffer): Buffer {
    const { packets, offset } = decodePktLines(raw);
    interface Command {
      oldOid: string;
      newOid: string;
      ref: string;
    }
    const commands: Command[] = [];
    let wantSideband = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      const head = nul >= 0 ? text.slice(0, nul) : text;
      if (nul >= 0) {
        const caps = text.slice(nul + 1);
        if (caps.includes('side-band-64k')) wantSideband = true;
      }
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(head);
      if (match !== null) {
        commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
      }
    }
    const packBytes = raw.subarray(offset);
    let unpackOk = true;
    let unpackDetail = 'ok';
    let incoming: Map<string, GitObject> = new Map();
    if (packBytes.length > 0) {
      try {
        incoming = readPack(packBytes);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
    if (unpackOk) {
      for (const [oid, obj] of incoming) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    }
    const lines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
    for (const command of commands) {
      if (!unpackOk) {
        lines.push(`ng ${command.ref} unpack failed\n`);
        continue;
      }
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === ZERO_OID) {
          lines.push(`ng ${command.ref} no such ref\n`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          lines.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(command.ref);
          lines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      const exists = repo.objects.has(command.newOid);
      if (!exists) {
        lines.push(`ng ${command.ref} missing object\n`);
        continue;
      }
      if (current === ZERO_OID) {
        if (command.oldOid !== ZERO_OID) {
          lines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        lines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (command.oldOid !== current) {
        lines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
      if (!isAncestor(current, command.newOid, lookup)) {
        lines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}\n`);
    }
    treeCache.clear();
    const report = pktLines([...lines, 'flush']);
    if (!wantSideband) return report;
    const parts: Buffer[] = [];
    for (let off = 0; off < report.length; off += 32768) {
      const chunk = report.subarray(off, Math.min(report.length, off + 32768));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }

  return server;
}

// Re-exported for the entrypoint's health: the module's only public surface.
export { FORGE_NAME, FORGE_VERSION };
