// store.ts — the forge's whole state, in memory. One process, one trial, the
// suite the only client: an in-memory store is exact, and nothing here reads a
// wall clock or Math.random, so two runs over the same requests hold the same
// state. Timestamps come from a logical counter seeded at 2025-01-01.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
  ZERO_OID,
} from './gitwire.ts';

// ---------------------------------------------------------------------------
// the scenario's viewer, derived from the contest's one fixed seed
// ---------------------------------------------------------------------------
//
// The suite names every repository under the login its bearer token owns, and
// that login is a pure function of the fixed scenario seed (wire.ts's
// buildScenario): the first user the seeded generator makes. The derivation
// below re-implements that generator — FNV-1a + splitmix64 seeding,
// xorshift64* stream, first/last-name picks — so the forge knows its owner
// without ever seeing the scenario. The name lists and constants are the
// kit's own public data.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class SeedRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU32(): number {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & U64_MASK) >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

function scenarioUsers(): Array<{ id: number; login: string; name: string; email: string }> {
  const rng = new SeedRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: Array<{ id: number; login: string; name: string; email: string }> = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const SCENARIO_USERS = scenarioUsers();

/** The login the trial's bearer token owns (the scenario's viewer). */
export const VIEWER_LOGIN = SCENARIO_USERS[0]?.login ?? 'viewer';
/** The scenario's stranger login: a name that is never the token owner's. */
export const STRANGER_LOGIN = SCENARIO_USERS[2]?.login ?? 'stranger';
export const VIEWER_NAME = SCENARIO_USERS[0]?.name ?? 'viewer';
export const VIEWER_EMAIL = SCENARIO_USERS[0]?.email ?? 'viewer@example.invalid';
export const VIEWER_ID = SCENARIO_USERS[0]?.id ?? 1000;

// ---------------------------------------------------------------------------
// logical clock + global ids
// ---------------------------------------------------------------------------

/** 2025-01-01T00:00:00Z: every timestamp is this plus a counter, never a clock. */
const EPOCH_SEC = 1_735_689_600;

export function isoAt(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString();
}

/** Opaque Relay-style global ids: base64 of "Kind:scope:id", never the bare number. */
export function globalId(kind: string, scope: string, id: string | number): string {
  return Buffer.from(`${kind}:${scope}:${id}`, 'utf8').toString('base64');
}

export function parseGlobalId(value: string): { kind: string; scope: string; id: string } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 3) return null;
    return { kind: parts[0] as string, scope: parts[1] as string, id: parts.slice(2).join(':') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  /** The base tip the pull request was opened against (its merge base). */
  baseAtOpen: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  nextIssueNumber: number;
  comments: Map<number, Comment[]>;
  pulls: PullRequest[];
  nextPullNumber: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  #seq = 0;

  /** The next logical timestamp sequence (1, 2, 3, ...). */
  tick(): number {
    this.#seq += 1;
    return this.#seq;
  }

  key(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const seq = this.tick();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      nextIssueNumber: 1,
      comments: new Map(),
      pulls: [],
      nextPullNumber: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string {
    return repo.refs.get(ref) ?? ZERO_OID;
  }

  /** Resolve a branch name to its tip oid ('' when the branch does not exist). */
  branchTip(repo: Repo, branch: string): string {
    return repo.refs.get(`refs/heads/${branch}`) ?? '';
  }

  /** The commit a ref name (branch or full ref) points at, or ''. */
  resolveRef(repo: Repo, ref: string): string {
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? '';
    return repo.refs.get(`refs/heads/${ref}`) ?? '';
  }
}

// ---------------------------------------------------------------------------
// trees: path maps, updates, diffs
// ---------------------------------------------------------------------------

/**
 * A commit's full file map: path -> {oid, mode}. Memoized per repo+commit in
 * `cache` so repeated reads (contents, files, merges) stay cheap. A tree map
 * is a pure function of immutable objects, so callers that pass no cache
 * share one module-level map; it can never go stale.
 */
const sharedTreeCache = new Map<string, Map<string, { oid: string; mode: string }>>();

export function treeMap(
  repo: Repo,
  commitOid: string,
  cache: Map<string, Map<string, { oid: string; mode: string }>> = sharedTreeCache,
): Map<string, { oid: string; mode: string }> {
  const cacheKey = `${repo.id}:${commitOid}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  const out = new Map<string, { oid: string; mode: string }>();
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') {
    cache.set(cacheKey, out);
    return out;
  }
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(parseCommit(commit.data).tree, '');
  cache.set(cacheKey, out);
  return out;
}

/** Build the tree object for `files` (path -> blob oid) under `repo`, storing trees. */
export function buildTreeForFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i] as string;
      if (!node.dirs.has(seg)) node.dirs.set(seg, make());
      node = node.dirs.get(seg) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/**
 * Commit `files` (a full path map) on `branch` of `repo` with `message`,
 * parenting the branch tip when it exists. Returns the new commit oid.
 */
export function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  files: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const treeOid = buildTreeForFiles(repo, files);
  const parent = store.branchTip(repo, branch);
  const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const data = buildCommit({
    tree: treeOid,
    parents: parent === '' ? [] : [parent],
    message,
    author: identity,
    committer: identity,
    timestamp: EPOCH_SEC + store.tick(),
  });
  const oid = hashObject('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

/** Commits reachable from `tip`, tip first, parents after (deduped). */
export function commitList(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid) || !isOid(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

/** Line counts for a blob's content. */
function lineSet(data: Buffer): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of data.toString('utf8').split('\n')) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function lineDiff(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = oldData === undefined ? new Map<string, number>() : lineSet(oldData);
  const newLines = newData === undefined ? new Map<string, number>() : lineSet(newData);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newLines) {
    const have = oldLines.get(line) ?? 0;
    if (count > have) additions += count - have;
  }
  for (const [line, count] of oldLines) {
    const have = newLines.get(line) ?? 0;
    if (count > have) deletions += count - have;
  }
  return { additions, deletions };
}

/** The file-level diff between two commits' trees. */
export function diffCommits(
  repo: Repo,
  baseOid: string,
  headOid: string,
  cache: Map<string, Map<string, { oid: string; mode: string }>> = sharedTreeCache,
): FileChange[] {
  const base = baseOid === '' || baseOid === ZERO_OID ? new Map() : treeMap(repo, baseOid, cache);
  const head = headOid === '' || headOid === ZERO_OID ? new Map() : treeMap(repo, headOid, cache);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const from = base.get(path);
    const to = head.get(path);
    if (from !== undefined && to === undefined) {
      const data = repo.objects.get(from.oid)?.data;
      const { deletions } = lineDiff(data, undefined);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions });
    } else if (from === undefined && to !== undefined) {
      const data = repo.objects.get(to.oid)?.data;
      const { additions } = lineDiff(undefined, data);
      changes.push({ filename: path, status: 'added', additions, deletions: 0 });
    } else if (from !== undefined && to !== undefined && from.oid !== to.oid) {
      const { additions, deletions } = lineDiff(repo.objects.get(from.oid)?.data, repo.objects.get(to.oid)?.data);
      changes.push({ filename: path, status: 'modified', additions, deletions });
    }
  }
  return changes;
}

/** The objects reachable from `tip` that `haveClosure` does not hold. */
export function objectsToSend(repo: Repo, tip: string, haveClosure: Set<string>): GitObject[] {
  const wanted = collectReachable([tip], (oid) => repo.objects.get(oid));
  const out: GitObject[] = [];
  for (const oid of wanted) {
    if (haveClosure.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) out.push(obj);
  }
  return out;
}
