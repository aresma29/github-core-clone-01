// mcp.ts — the MCP surface at /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Modern era (protocol revision 2026-07-28) with server/discover, plus the
// legacy initialize handshake. Tools act on the same in-memory store as the
// REST and GraphQL surfaces, so an object created through MCP is readable
// through REST with the same id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitFiles,
  globalId,
  isoAt,
  treeMap,
  VIEWER_LOGIN,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestCounter}`,
  });
  res.end(text);
}

async function readRawBody(req: IncomingMessage): Promise<{ text: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return { text: Buffer.concat(chunks).toString('utf8') };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name, or by full_name (owner/repo).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        issue_number: { type: 'integer', description: 'The number of the issue.' },
        number: { type: 'integer', description: 'Alias for issue_number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        state: { type: 'string', description: 'Pull request state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
        number: { type: 'integer', description: 'Alias for pull_number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'create_branch',
    description: 'Create a branch in a repository from an existing branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        branch: { type: 'string', description: 'The name of the branch to create.' },
        from_branch: { type: 'string', description: 'The branch to start from (defaults to the default branch).' },
      },
      required: ['owner', 'repo', 'branch'],
    },
  },
];

function toolResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || name === '') && typeof args.full_name === 'string') {
    const [o, n] = args.full_name.split('/');
    if (o !== undefined && n !== undefined) {
      owner = o;
      name = n;
    }
  }
  if (owner === '' || name === '') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`, repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}`, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: { login: issue.user },
    created_at: isoAt(issue.createdSeq),
    updated_at: isoAt(issue.updatedSeq),
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
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    created_at: isoAt(pr.createdSeq),
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((t) => t.name === name);
  if (def === undefined) {
    return { error: { code: -32601, message: `Method not found: no tool named "${name}"` } };
  }
  for (const required of def.inputSchema.required) {
    const hasIt = args[required] !== undefined && args[required] !== null && args[required] !== '';
    const aliased = required === 'issue_number' && (args.number !== undefined || args.pull_number !== undefined);
    const aliasedPr = required === 'pull_number' && args.number !== undefined;
    const aliasedRepo = (required === 'owner' || required === 'repo') && typeof args.full_name === 'string' && args.full_name !== '';
    if (!hasIt && !aliased && !aliasedPr && !aliasedRepo) {
      return { result: toolResult(`Error: missing required argument "${required}" for tool "${name}".`, true) };
    }
  }

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return { result: toolResult(`Error: repository "${repoName}" already exists.`, true) };
      }
      const repo = store.createRepo(VIEWER_LOGIN, repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { result: toolResult(JSON.stringify(repoJson(repo))) };
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Error: repository not found.', true) };
      return { result: toolResult(JSON.stringify(repoJson(repo))) };
    }
    case 'list_repos': {
      const repos = store.reposOf(VIEWER_LOGIN);
      return { result: toolResult(JSON.stringify(repos.map(repoJson))) };
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Error: repository not found.', true) };
      const seq = store.tick();
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextIssueNumber++,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        user: VIEWER_LOGIN,
        createdSeq: seq,
        updatedSeq: seq,
      };
      repo.issues.push(issue);
      return { result: toolResult(JSON.stringify(issueJson(repo, issue))) };
    }
    case 'get_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Error: repository not found.', true) };
      const number = Number(args.issue_number ?? args.number);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) return { result: toolResult(`Error: issue #${number} not found.`, true) };
      return { result: toolResult(JSON.stringify(issueJson(repo, issue))) };
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Error: repository not found.', true) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return { result: toolResult(JSON.stringify(list.map((i) => issueJson(repo, i)))) };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Error: repository not found.', true) };
      const headRef = String(args.head ?? '');
      const baseRef = String(args.base ?? repo.defaultBranch);
      const headSha = store.branchTip(repo, headRef);
      const baseSha = store.branchTip(repo, baseRef);
      if (headSha === '' || baseSha === '') {
        return { result: toolResult('Error: head or base branch does not exist.', true) };
      }
      const pr: PullRequest = {
        id: store.nextPullId++,
        number: repo.nextPullNumber++,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
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
      return { result: toolResult(JSON.stringify(prJson(repo, pr))) };
    }
    case 'list_pull_requests': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Error: repository not found.', true) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? repo.pulls : repo.pulls.filter((p) => p.state === state);
      return { result: toolResult(JSON.stringify(list.map((p) => prJson(repo, p)))) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Error: repository not found.', true) };
      const number = Number(args.pull_number ?? args.number);
      const pr = repo.pulls.find((p) => p.number === number);
      if (pr === undefined) return { result: toolResult(`Error: pull request #${number} not found.`, true) };
      if (pr.state !== 'open') return { result: toolResult(`Error: pull request #${number} is already closed.`, true) };
      const baseFiles = treeMap(repo, pr.baseAtOpen);
      const currentFiles = treeMap(repo, repo.refs.get(`refs/heads/${pr.baseRef}`) ?? '');
      const headFiles = treeMap(repo, pr.headSha);
      const conflicted = [...new Set([...baseFiles.keys(), ...currentFiles.keys(), ...headFiles.keys()])].some((path) => {
        const baseOid = baseFiles.get(path)?.oid;
        const currentOid = currentFiles.get(path)?.oid;
        const headOid = headFiles.get(path)?.oid;
        return baseOid !== currentOid && baseOid !== headOid && currentOid !== headOid;
      });
      if (conflicted) return { result: toolResult(`Error: pull request #${number} has merge conflicts.`, true) };
      const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`;
      const mergeSha = commitFiles(store, repo, pr.baseRef, new Map(headFiles), message);
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = isoAt(store.tick());
      pr.mergeCommitSha = mergeSha;
      pr.baseSha = mergeSha;
      return { result: toolResult(JSON.stringify({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' })) };
    }
    case 'create_branch': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolResult('Error: repository not found.', true) };
      const branch = String(args.branch ?? '');
      const fromBranch = typeof args.from_branch === 'string' && args.from_branch !== '' ? args.from_branch : repo.defaultBranch;
      const tip = store.branchTip(repo, fromBranch);
      if (tip === '') return { result: toolResult(`Error: branch "${fromBranch}" does not exist.`, true) };
      if (repo.refs.has(`refs/heads/${branch}`)) return { result: toolResult(`Error: branch "${branch}" already exists.`, true) };
      repo.refs.set(`refs/heads/${branch}`, tip);
      return { result: toolResult(JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } })) };
    }
    default:
      return { error: { code: -32601, message: `Method not found: no tool named "${name}"` } };
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store, authed: boolean): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authed) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const { text } = await readRawBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id as string | number | null | undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get a bare 202.
  if (id === undefined || id === null) {
    if (method.startsWith('notifications/')) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }

  const result = (value: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result: value });
  const failure = (code: number, message: string): void => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'server/discover') {
    result({
      protocolVersion: '2026-07-28',
      supportedVersions: [...SUPPORTED_VERSIONS],
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
    });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'ping') {
    result({});
    return;
  }
  if (method === 'tools/list') {
    result({ tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const rawArgs = params.arguments ?? {};
    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
      failure(-32602, 'Invalid params: arguments must be an object.');
      return;
    }
    const args = rawArgs as Record<string, unknown>;
    if (name === '') {
      failure(-32602, 'Invalid params: tool name is required.');
      return;
    }
    const outcome = callTool(store, name, args);
    if ('error' in outcome) {
      const err = outcome.error as { code: number; message: string };
      failure(err.code, err.message);
      return;
    }
    result(outcome.result);
    return;
  }
  if (method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  failure(-32601, `Method not found: ${method}`);
}
