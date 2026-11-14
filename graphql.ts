// graphql.ts — a small GraphQL v4 executor for the exact surface the suite
// exercises: viewer/repository/node, issue and pull-request connections,
// createIssue/closeIssue/createPullRequest/mergePullRequest/addComment, and
// __type/__schema introspection. No dependencies; the parser and executor
// are written fresh for this entry. Unknown fields produce HTTP 200 with an
// errors array naming the field, as real GitHub does.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitFiles,
  diffCommits,
  globalId,
  isoAt,
  parseGlobalId,
  treeMap,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestCounter}`,
  });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<{ value: unknown; malformed: boolean }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { value: undefined, malformed: false };
  try {
    return { value: JSON.parse(text) as unknown, malformed: false };
  } catch {
    return { value: undefined, malformed: true };
  }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():[]=|&@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '{' || c === '}' || c === '(' || c === ')') {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: Selection[];
}

interface FragmentSpreadSelection {
  kind: 'spread';
  name: string;
}

interface InlineFragmentSelection {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSpreadSelection | InlineFragmentSelection;

interface VariableDefinition {
  name: string;
  type: string;
  defaultValue: ValueNode | null;
}

interface OperationDefinition {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDefinition[];
  selections: Selection[];
}

interface FragmentDefinition {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: Selection[];
}

type Definition = OperationDefinition | FragmentDefinition;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" but got ${token.kind} ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name but got ${token.kind} ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`Expected "${value}" but got "${token.value}"`);
    return token.value;
  }

  parseDocument(): Definition[] {
    const definitions: Definition[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): Definition {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVariableDefinitions() : [];
      const selections = this.parseSelectionSet();
      return { kind: 'operation', operation, name, variables, selections };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', name, typeCondition, selections };
    }
    throw new Error(`Unexpected ${token.kind} ${JSON.stringify(token.value)} at document level`);
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const defs: VariableDefinition[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): string {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    const name = this.expectName();
    let out = name;
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name: fieldName, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected ${token.kind} ${JSON.stringify(token.value)} in value position`);
  }
}

// ---------------------------------------------------------------------------
// Schema table (for introspection)
// ---------------------------------------------------------------------------

interface TypeRefObj {
  kind: string;
  name: string | null;
  ofType: TypeRefObj | null;
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);
const ENUMS = new Set(['IssueState', 'PullRequestState', 'MergeableState', 'RepositoryPermission', 'SearchType', '__TypeKind', '__DirectiveLocation']);

function parseTypeRef(text: string): TypeRefObj {
  if (text.endsWith('!')) {
    return { kind: 'NON_NULL', name: null, ofType: parseTypeRef(text.slice(0, -1)) };
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return { kind: 'LIST', name: null, ofType: parseTypeRef(text.slice(1, -1)) };
  }
  const kind = SCALARS.has(text) ? 'SCALAR' : ENUMS.has(text) ? 'ENUM' : 'OBJECT';
  return { kind, name: text, ofType: null };
}

interface FieldDef {
  name: string;
  description?: string;
  args?: Array<{ name: string; type: string; defaultValue?: string }>;
  type: string;
}

interface TypeDef {
  kind: string;
  name: string;
  description?: string;
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: FieldDef[];
  possibleTypes?: string[];
}

function f(name: string, type: string, args?: Array<{ name: string; type: string }>): FieldDef {
  return { name, type, args };
}

const TYPE_TABLE: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    name: 'Query',
    fields: [
      f('viewer', 'User'),
      f('repository', 'Repository', [{ name: 'owner', type: 'String!' }, { name: 'name', type: 'String!' }]),
      f('node', 'Node', [{ name: 'id', type: 'ID!' }]),
      f('__type', '__Type', [{ name: 'name', type: 'String!' }]),
      f('__schema', '__Schema'),
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    name: 'Mutation',
    fields: [
      f('createIssue', 'CreateIssuePayload', [{ name: 'input', type: 'CreateIssueInput!' }]),
      f('closeIssue', 'CloseIssuePayload', [{ name: 'input', type: 'CloseIssueInput!' }]),
      f('createPullRequest', 'CreatePullRequestPayload', [{ name: 'input', type: 'CreatePullRequestInput!' }]),
      f('mergePullRequest', 'MergePullRequestPayload', [{ name: 'input', type: 'MergePullRequestInput!' }]),
      f('addComment', 'AddCommentPayload', [{ name: 'input', type: 'AddCommentInput!' }]),
    ],
  },
  Repository: {
    kind: 'OBJECT',
    name: 'Repository',
    fields: [
      f('id', 'ID!'),
      f('databaseId', 'Int'),
      f('name', 'String!'),
      f('nameWithOwner', 'String!'),
      f('owner', 'User!'),
      f('description', 'String'),
      f('url', 'String!'),
      f('isPrivate', 'Boolean!'),
      f('defaultBranchRef', 'Ref'),
      f('viewerPermission', 'RepositoryPermission'),
      f('hasIssuesEnabled', 'Boolean!'),
      f('issue', 'Issue', [{ name: 'number', type: 'Int!' }]),
      f('issues', 'IssueConnection', [{ name: 'first', type: 'Int' }, { name: 'states', type: '[IssueState!]' }, { name: 'orderBy', type: 'IssueOrder' }]),
      f('pullRequest', 'PullRequest', [{ name: 'number', type: 'Int!' }]),
      f('pullRequests', 'PullRequestConnection', [{ name: 'first', type: 'Int' }, { name: 'states', type: '[PullRequestState!]' }, { name: 'orderBy', type: 'PullRequestOrder' }]),
    ],
  },
  Issue: {
    kind: 'OBJECT',
    name: 'Issue',
    fields: [
      f('id', 'ID!'),
      f('number', 'Int!'),
      f('title', 'String!'),
      f('body', 'String'),
      f('state', 'IssueState!'),
      f('url', 'String!'),
      f('createdAt', 'DateTime!'),
      f('updatedAt', 'DateTime!'),
      f('author', 'User'),
      f('labels', 'LabelConnection'),
      f('comments', 'IssueCommentConnection'),
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    name: 'PullRequest',
    fields: [
      f('id', 'ID!'),
      f('number', 'Int!'),
      f('title', 'String!'),
      f('body', 'String'),
      f('state', 'PullRequestState!'),
      f('merged', 'Boolean!'),
      f('mergeable', 'MergeableState!'),
      f('headRefName', 'String!'),
      f('baseRefName', 'String!'),
      f('headRefOid', 'String'),
      f('baseRefOid', 'String'),
      f('url', 'String!'),
      f('createdAt', 'DateTime!'),
      f('updatedAt', 'DateTime!'),
      f('mergedAt', 'DateTime'),
      f('author', 'User'),
      f('files', 'PullRequestChangedFileConnection', [{ name: 'first', type: 'Int' }]),
    ],
  },
  User: {
    kind: 'OBJECT',
    name: 'User',
    fields: [
      f('id', 'ID!'),
      f('databaseId', 'Int'),
      f('login', 'String!'),
      f('name', 'String'),
      f('email', 'String'),
      f('url', 'String!'),
    ],
  },
  Ref: {
    kind: 'OBJECT',
    name: 'Ref',
    fields: [f('id', 'ID!'), f('name', 'String!'), f('prefix', 'String!'), f('target', 'GitObject')],
  },
  Commit: {
    kind: 'OBJECT',
    name: 'Commit',
    fields: [f('oid', 'String!'), f('abbreviatedOid', 'String!'), f('message', 'String')],
  },
  IssueConnection: {
    kind: 'OBJECT',
    name: 'IssueConnection',
    fields: [f('nodes', '[Issue]'), f('edges', '[IssueEdge]'), f('pageInfo', 'PageInfo!'), f('totalCount', 'Int!')],
  },
  IssueEdge: {
    kind: 'OBJECT',
    name: 'IssueEdge',
    fields: [f('node', 'Issue'), f('cursor', 'String!')],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    name: 'PullRequestConnection',
    fields: [f('nodes', '[PullRequest]'), f('edges', '[PullRequestEdge]'), f('pageInfo', 'PageInfo!'), f('totalCount', 'Int!')],
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    name: 'PullRequestEdge',
    fields: [f('node', 'PullRequest'), f('cursor', 'String!')],
  },
  LabelConnection: {
    kind: 'OBJECT',
    name: 'LabelConnection',
    fields: [f('nodes', '[Label]'), f('edges', '[LabelEdge]'), f('pageInfo', 'PageInfo!'), f('totalCount', 'Int!')],
  },
  LabelEdge: {
    kind: 'OBJECT',
    name: 'LabelEdge',
    fields: [f('node', 'Label'), f('cursor', 'String!')],
  },
  Label: {
    kind: 'OBJECT',
    name: 'Label',
    fields: [f('id', 'ID!'), f('name', 'String!'), f('color', 'String!'), f('description', 'String')],
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    name: 'IssueCommentConnection',
    fields: [f('nodes', '[IssueComment]'), f('edges', '[IssueCommentEdge]'), f('pageInfo', 'PageInfo!'), f('totalCount', 'Int!')],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    name: 'IssueCommentEdge',
    fields: [f('node', 'IssueComment'), f('cursor', 'String!')],
  },
  IssueComment: {
    kind: 'OBJECT',
    name: 'IssueComment',
    fields: [f('id', 'ID!'), f('body', 'String!'), f('author', 'User'), f('createdAt', 'DateTime!')],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    name: 'PullRequestChangedFileConnection',
    fields: [f('nodes', '[PullRequestChangedFile]'), f('edges', '[PullRequestChangedFileEdge]'), f('pageInfo', 'PageInfo!'), f('totalCount', 'Int!')],
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    name: 'PullRequestChangedFileEdge',
    fields: [f('node', 'PullRequestChangedFile'), f('cursor', 'String!')],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    name: 'PullRequestChangedFile',
    fields: [f('path', 'String!'), f('additions', 'Int!'), f('deletions', 'Int!'), f('changeType', 'String!')],
  },
  PageInfo: {
    kind: 'OBJECT',
    name: 'PageInfo',
    fields: [f('hasNextPage', 'Boolean!'), f('hasPreviousPage', 'Boolean!'), f('startCursor', 'String'), f('endCursor', 'String')],
  },
  IssueState: { kind: 'ENUM', name: 'IssueState', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', name: 'PullRequestState', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', name: 'MergeableState', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', name: 'RepositoryPermission', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', name: 'SearchType', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'] },
  __Type: {
    kind: 'OBJECT',
    name: '__Type',
    fields: [
      f('kind', '__TypeKind!'),
      f('name', 'String'),
      f('description', 'String'),
      f('fields', '[__Field!]', [{ name: 'includeDeprecated', type: 'Boolean' }]),
      f('enumValues', '[__EnumValue!]', [{ name: 'includeDeprecated', type: 'Boolean' }]),
      f('inputFields', '[__InputValue!]'),
      f('possibleTypes', '[__Type!]'),
      f('interfaces', '[__Type!]'),
      f('ofType', '__Type'),
    ],
  },
  __Field: {
    kind: 'OBJECT',
    name: '__Field',
    fields: [f('name', 'String!'), f('description', 'String'), f('args', '[__InputValue!]!'), f('type', '__Type!'), f('isDeprecated', 'Boolean!'), f('deprecationReason', 'String')],
  },
  __InputValue: {
    kind: 'OBJECT',
    name: '__InputValue',
    fields: [f('name', 'String!'), f('description', 'String'), f('type', '__Type!'), f('defaultValue', 'String')],
  },
  __EnumValue: {
    kind: 'OBJECT',
    name: '__EnumValue',
    fields: [f('name', 'String!'), f('description', 'String'), f('isDeprecated', 'Boolean!'), f('deprecationReason', 'String')],
  },
  __Schema: {
    kind: 'OBJECT',
    name: '__Schema',
    fields: [f('queryType', '__Type'), f('mutationType', '__Type'), f('subscriptionType', '__Type'), f('types', '[__Type!]!'), f('directives', '[__Directive!]!')],
  },
  __Directive: {
    kind: 'OBJECT',
    name: '__Directive',
    fields: [f('name', 'String!'), f('description', 'String'), f('locations', '[__DirectiveLocation!]!'), f('args', '[__InputValue!]!')],
  },
  __TypeKind: { kind: 'ENUM', name: '__TypeKind', enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
  __DirectiveLocation: { kind: 'ENUM', name: '__DirectiveLocation', enumValues: ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] },
  DateTime: { kind: 'SCALAR', name: 'DateTime' },
  Node: { kind: 'INTERFACE', name: 'Node', possibleTypes: ['Repository', 'Issue', 'PullRequest', 'User'], fields: [f('id', 'ID!')] },
  GitObject: { kind: 'INTERFACE', name: 'GitObject', possibleTypes: ['Commit'], fields: [f('oid', 'String!')] },
  CreateIssueInput: { kind: 'INPUT_OBJECT', name: 'CreateIssueInput', inputFields: [f('repositoryId', 'ID!'), f('title', 'String!'), f('body', 'String'), f('labelIds', '[ID!]'), f('clientMutationId', 'String')] },
  CloseIssueInput: { kind: 'INPUT_OBJECT', name: 'CloseIssueInput', inputFields: [f('issueId', 'ID!'), f('clientMutationId', 'String')] },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', name: 'CreatePullRequestInput', inputFields: [f('repositoryId', 'ID!'), f('baseRefName', 'String!'), f('headRefName', 'String!'), f('title', 'String!'), f('body', 'String'), f('draft', 'Boolean'), f('clientMutationId', 'String')] },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', name: 'MergePullRequestInput', inputFields: [f('pullRequestId', 'ID!'), f('mergeMethod', 'MergeMethod'), f('clientMutationId', 'String')] },
  AddCommentInput: { kind: 'INPUT_OBJECT', name: 'AddCommentInput', inputFields: [f('subjectId', 'ID!'), f('body', 'String!'), f('clientMutationId', 'String')] },
  MergeMethod: { kind: 'ENUM', name: 'MergeMethod', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  IssueOrder: { kind: 'INPUT_OBJECT', name: 'IssueOrder', inputFields: [f('field', 'IssueOrderField!'), f('direction', 'OrderDirection!')] },
  PullRequestOrder: { kind: 'INPUT_OBJECT', name: 'PullRequestOrder', inputFields: [f('field', 'PullRequestOrderField!'), f('direction', 'OrderDirection!')] },
  IssueOrderField: { kind: 'ENUM', name: 'IssueOrderField', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestOrderField: { kind: 'ENUM', name: 'PullRequestOrderField', enumValues: ['CREATED_AT', 'UPDATED_AT'] },
  OrderDirection: { kind: 'ENUM', name: 'OrderDirection', enumValues: ['ASC', 'DESC'] },
  CreateIssuePayload: { kind: 'OBJECT', name: 'CreateIssuePayload', fields: [f('issue', 'Issue'), f('clientMutationId', 'String')] },
  CloseIssuePayload: { kind: 'OBJECT', name: 'CloseIssuePayload', fields: [f('issue', 'Issue'), f('clientMutationId', 'String')] },
  CreatePullRequestPayload: { kind: 'OBJECT', name: 'CreatePullRequestPayload', fields: [f('pullRequest', 'PullRequest'), f('clientMutationId', 'String')] },
  MergePullRequestPayload: { kind: 'OBJECT', name: 'MergePullRequestPayload', fields: [f('pullRequest', 'PullRequest'), f('clientMutationId', 'String')] },
  AddCommentPayload: { kind: 'OBJECT', name: 'AddCommentPayload', fields: [f('commentEdge', 'IssueCommentEdge'), f('clientMutationId', 'String')] },
};

// ---------------------------------------------------------------------------
// Execution context and views
// ---------------------------------------------------------------------------

interface Context {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDefinition>;
}

type AnyView = Record<string, unknown> & { __typename: string };

function userView(login: string): AnyView {
  return {
    __typename: 'User',
    id: globalId('User', '', login),
    databaseId: login === VIEWER_LOGIN ? VIEWER_ID : 0,
    login,
    name: login === VIEWER_LOGIN ? VIEWER_NAME : null,
    email: login === VIEWER_LOGIN ? VIEWER_EMAIL : null,
    url: '',
  };
}

function repoView(repo: Repo): AnyView {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: globalId('Repository', `${repo.owner}/${repo.name}`, repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userView(repo.owner),
    description: repo.description,
    url: '',
    isPrivate: repo.isPrivate,
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`)
      ? { __typename: 'Ref', id: globalId('Ref', `${repo.owner}/${repo.name}`, repo.defaultBranch), name: repo.defaultBranch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: repo.refs.get(`refs/heads/${repo.defaultBranch}`) as string, abbreviatedOid: (repo.refs.get(`refs/heads/${repo.defaultBranch}`) as string).slice(0, 7), message: '' } }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueView(repo: Repo, issue: Issue): AnyView {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: globalId('Issue', `${repo.owner}/${repo.name}`, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: '',
    createdAt: isoAt(issue.createdSeq),
    updatedAt: isoAt(issue.updatedSeq),
    author: userView(issue.user),
  };
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prMergeable(repo: Repo, pr: PullRequest): string {
  if (pr.state !== 'open') return 'UNKNOWN';
  const baseFiles = treeMap(repo, pr.baseAtOpen);
  const currentFiles = treeMap(repo, repo.refs.get(`refs/heads/${pr.baseRef}`) ?? '');
  const headFiles = treeMap(repo, pr.headSha);
  const conflicted = [...new Set([...baseFiles.keys(), ...currentFiles.keys(), ...headFiles.keys()])].some((path) => {
    const baseOid = baseFiles.get(path)?.oid;
    const currentOid = currentFiles.get(path)?.oid;
    const headOid = headFiles.get(path)?.oid;
    return baseOid !== currentOid && baseOid !== headOid && currentOid !== headOid;
  });
  return conflicted ? 'CONFLICTING' : 'MERGEABLE';
}

function prView(repo: Repo, pr: PullRequest): AnyView {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pr: pr,
    id: globalId('PullRequest', `${repo.owner}/${repo.name}`, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: prState(pr),
    merged: pr.merged,
    mergeable: prMergeable(repo, pr),
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    headRefOid: pr.headSha,
    baseRefOid: pr.baseSha,
    url: '',
    createdAt: isoAt(pr.createdSeq),
    updatedAt: isoAt(pr.createdSeq),
    mergedAt: pr.mergedAt,
    author: userView(repo.owner),
  };
}

function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  const match = /^cursor-(\d+)$/.exec(cursor);
  return match !== null ? Number.parseInt(match[1] as string, 10) : -1;
}

interface PageArgs {
  after?: unknown;
  before?: unknown;
  first?: unknown;
  last?: unknown;
}

/** A Relay-style connection over an already-ordered list, with cursor paging. */
function connection(typename: string, edgeType: string, all: AnyView[], args: PageArgs): AnyView {
  let start = 0;
  let end = all.length;
  const afterIdx = cursorIndex(args.after);
  if (afterIdx >= 0) start = Math.min(afterIdx + 1, all.length);
  const beforeIdx = cursorIndex(args.before);
  if (beforeIdx >= 0) end = Math.max(beforeIdx, 0);
  if (typeof args.first === 'number' && args.first >= 0) end = Math.min(end, start + args.first);
  if (typeof args.last === 'number' && args.last >= 0) start = Math.max(start, end - args.last);
  const nodes = all.slice(start, end);
  return {
    __typename: typename,
    nodes,
    edges: nodes.map((node, i) => ({ __typename: edgeType, node, cursor: `cursor-${start + i}` })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < all.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? `cursor-${start}` : null,
      endCursor: nodes.length > 0 ? `cursor-${end - 1}` : null,
    },
    totalCount: all.length,
  };
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const list = [...issues];
  const order = (orderBy as Record<string, unknown> | null) ?? null;
  const direction = order?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => direction * (a.createdSeq - b.createdSeq || a.number - b.number));
  return list;
}

function valueOf(node: ValueNode, ctx: Context): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = ctx.variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int': return Number.parseInt(node.value, 10);
    case 'float': return Number.parseFloat(node.value);
    case 'string': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => valueOf(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldSelection, ctx: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx);
  return out;
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function typeRefView(type: string): AnyView {
  const ref = parseTypeRef(type);
  const toView = (r: TypeRefObj): AnyView => ({
    __typename: '__Type',
    kind: r.kind,
    name: r.name,
    description: null,
    ofType: r.ofType !== null ? toView(r.ofType) : null,
    fields: null,
    enumValues: null,
    inputFields: null,
    possibleTypes: null,
    interfaces: null,
  });
  return toView(ref);
}

function typeView(def: TypeDef): AnyView {
  const view: AnyView = {
    __typename: '__Type',
    kind: def.kind,
    name: def.name,
    description: def.description ?? null,
    ofType: null,
    fields: null,
    enumValues: null,
    inputFields: null,
    possibleTypes: null,
    interfaces: null,
  };
  if (def.fields !== undefined) {
    view.fields = def.fields.map((field) => ({
      __typename: '__Field',
      name: field.name,
      description: field.description ?? null,
      args: (field.args ?? []).map((arg) => ({
        __typename: '__InputValue',
        name: arg.name,
        description: null,
        type: typeRefView(arg.type),
        defaultValue: arg.defaultValue ?? null,
      })),
      type: typeRefView(field.type),
      isDeprecated: false,
      deprecationReason: null,
    }));
  }
  if (def.enumValues !== undefined) {
    view.enumValues = def.enumValues.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null }));
  }
  if (def.inputFields !== undefined) {
    view.inputFields = def.inputFields.map((field) => ({
      __typename: '__InputValue',
      name: field.name,
      description: field.description ?? null,
      type: typeRefView(field.type),
      defaultValue: field.defaultValue ?? null,
    }));
  }
  if (def.possibleTypes !== undefined) view.possibleTypes = def.possibleTypes.map((name) => typeView(TYPE_TABLE[name] as TypeDef));
  return view;
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const [owner, name] = parsed.scope.split('/');
  if (owner === undefined || name === undefined) return null;
  return store.getRepo(owner, name) ?? null;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [owner, name] = parsed.scope.split('/');
  if (owner === undefined || name === undefined) return null;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  const issue = repo.issues.find((i) => String(i.number) === parsed.id);
  return issue === undefined ? null : { repo, issue };
}

function findPrByGlobalId(store: Store, id: string): { repo: Repo; pr: PullRequest } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [owner, name] = parsed.scope.split('/');
  if (owner === undefined || name === undefined) return null;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  const pr = repo.pulls.find((p) => String(p.number) === parsed.id);
  return pr === undefined ? null : { repo, pr };
}

function resolveField(typename: string, value: AnyView, field: FieldSelection, ctx: Context): unknown {
  const args = argsOf(field, ctx);

  if (field.name === '__typename') return typename;

  // Root query.
  if (typename === 'Query') {
    if (field.name === 'viewer') return userView(VIEWER_LOGIN);
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoView(repo);
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoByGlobalId(ctx.store, id);
        return repo === null ? null : repoView(repo);
      }
      if (parsed.kind === 'Issue') {
        const found = findIssueByGlobalId(ctx.store, id);
        return found === null ? null : issueView(found.repo, found.issue);
      }
      if (parsed.kind === 'PullRequest') {
        const found = findPrByGlobalId(ctx.store, id);
        return found === null ? null : prView(found.repo, found.pr);
      }
      if (parsed.kind === 'User') return userView(parsed.id);
      return null;
    }
    if (field.name === '__type') {
      const def = TYPE_TABLE[String(args.name ?? '')];
      return def === undefined ? null : typeView(def);
    }
    if (field.name === '__schema') {
      return {
        __typename: '__Schema',
        queryType: typeView(TYPE_TABLE.Query as TypeDef),
        mutationType: typeView(TYPE_TABLE.Mutation as TypeDef),
        subscriptionType: null,
        types: Object.values(TYPE_TABLE).map((def) => typeView(def)),
        directives: [],
      };
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
    return null;
  }

  // Mutations.
  if (typename === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
    if (field.name === 'createIssue') {
      const repo = findRepoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
        return null;
      }
      const title = String(input.title ?? '');
      if (title === '') {
        ctx.errors.push({ message: 'Could not create issue: title is required.' });
        return null;
      }
      const seq = ctx.store.tick();
      const issue: Issue = {
        id: ctx.store.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        user: VIEWER_LOGIN,
        createdSeq: seq,
        updatedSeq: seq,
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: issueView(repo, issue), clientMutationId };
    }
    if (field.name === 'closeIssue') {
      const found = findIssueByGlobalId(ctx.store, String(input.issueId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.updatedSeq = ctx.store.tick();
      return { __typename: 'CloseIssuePayload', issue: issueView(found.repo, found.issue), clientMutationId };
    }
    if (field.name === 'createPullRequest') {
      const repo = findRepoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = ctx.store.branchTip(repo, headRef);
      const baseSha = ctx.store.branchTip(repo, baseRef);
      if (headSha === '' || baseSha === '') {
        ctx.errors.push({ message: 'Could not create pull request: head or base branch does not exist.' });
        return null;
      }
      const pr: PullRequest = {
        id: ctx.store.nextPullId++,
        number: repo.nextPullNumber++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        baseAtOpen: baseSha,
        createdSeq: ctx.store.tick(),
      };
      repo.pulls.push(pr);
      return { __typename: 'CreatePullRequestPayload', pullRequest: prView(repo, pr), clientMutationId };
    }
    if (field.name === 'mergePullRequest') {
      const found = findPrByGlobalId(ctx.store, String(input.pullRequestId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
        return null;
      }
      const { repo, pr } = found;
      if (pr.state !== 'open') {
        ctx.errors.push({ message: 'Could not merge pull request: it is already closed.' });
        return null;
      }
      if (prMergeable(repo, pr) === 'CONFLICTING') {
        ctx.errors.push({ message: 'Could not merge pull request: merge conflict.' });
        return null;
      }
      const headFiles = treeMap(repo, pr.headSha);
      const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`;
      const mergeSha = commitFiles(ctx.store, repo, pr.baseRef, new Map(headFiles), message);
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = isoAt(ctx.store.tick());
      pr.mergeCommitSha = mergeSha;
      pr.baseSha = mergeSha;
      return { __typename: 'MergePullRequestPayload', pullRequest: prView(repo, pr), clientMutationId };
    }
    if (field.name === 'addComment') {
      const found = findIssueByGlobalId(ctx.store, String(input.subjectId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        return null;
      }
      const body = String(input.body ?? '');
      if (body === '') {
        ctx.errors.push({ message: 'Could not add comment: body is required.' });
        return null;
      }
      const seq = ctx.store.tick();
      const comment = { id: ctx.store.nextCommentId++, body, user: VIEWER_LOGIN, createdSeq: seq };
      const list = found.repo.comments.get(found.issue.number) ?? [];
      list.push(comment);
      found.repo.comments.set(found.issue.number, list);
      const node: AnyView = {
        __typename: 'IssueComment',
        id: globalId('IssueComment', `${found.repo.owner}/${found.repo.name}`, comment.id),
        body,
        author: userView(VIEWER_LOGIN),
        createdAt: isoAt(seq),
      };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: 'cursor-0' }, clientMutationId };
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
    return null;
  }

  // Repository fields.
  if (typename === 'Repository') {
    const repo = value._repo as Repo;
    if (field.name === 'issue') {
      const number = Number(args.number);
      const issue = repo.issues.find((i) => i.number === number);
      return issue === undefined ? null : issueView(repo, issue);
    }
    if (field.name === 'issues') {
      let list = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
        list = list.filter((i) => wanted.has(i.state));
      }
      list = sortIssues(list, args.orderBy);
      return connection('IssueConnection', 'IssueEdge', list.map((i) => issueView(repo, i)), args);
    }
    if (field.name === 'pullRequest') {
      const number = Number(args.number);
      const pr = repo.pulls.find((p) => p.number === number);
      return pr === undefined ? null : prView(repo, pr);
    }
    if (field.name === 'pullRequests') {
      let list = [...repo.pulls];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : 'merged')));
        list = list.filter((p) => wanted.has(prState(p) === 'MERGED' ? 'merged' : p.state));
      }
      const direction = ((args.orderBy as Record<string, unknown> | undefined)?.direction ?? 'DESC') === 'ASC' ? 1 : -1;
      list.sort((a, b) => direction * (a.createdSeq - b.createdSeq || a.number - b.number));
      return connection('PullRequestConnection', 'PullRequestEdge', list.map((p) => prView(repo, p)), args);
    }
    if (field.name in value) return value[field.name];
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
    return null;
  }

  // Issue fields.
  if (typename === 'Issue') {
    const repo = value._repo as Repo;
    const issue = value._issue as Issue;
    if (field.name === 'labels') {
      const nodes = issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return {
          __typename: 'Label',
          id: globalId('Label', `${repo.owner}/${repo.name}`, name),
          name,
          color: label?.color ?? 'ededed',
          description: label?.description ?? '',
        };
      });
      return connection('LabelConnection', 'LabelEdge', nodes, args);
    }
    if (field.name === 'comments') {
      const list = repo.comments.get(issue.number) ?? [];
      const nodes = list.map((comment) => ({
        __typename: 'IssueComment',
        id: globalId('IssueComment', `${repo.owner}/${repo.name}`, comment.id),
        body: comment.body,
        author: userView(comment.user),
        createdAt: isoAt(comment.createdSeq),
      }));
      return connection('IssueCommentConnection', 'IssueCommentEdge', nodes, args);
    }
    if (field.name in value) return value[field.name];
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Issue".` });
    return null;
  }

  // PullRequest fields.
  if (typename === 'PullRequest') {
    const repo = value._repo as Repo;
    const pr = value._pr as PullRequest;
    if (field.name === 'files') {
      const changes = diffCommits(repo, pr.baseAtOpen, pr.headSha);
      const nodes = changes.map((change) => ({
        __typename: 'PullRequestChangedFile',
        path: change.filename,
        additions: change.additions,
        deletions: change.deletions,
        changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      return connection('PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', nodes, args);
    }
    if (field.name in value) return value[field.name];
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".` });
    return null;
  }

  // Generic object: plain property access (User, Ref, Commit, connections,
  // edges, PageInfo, payloads, __Type, __Field, __InputValue, __EnumValue,
  // __Schema, __Directive, Label, IssueComment, PullRequestChangedFile).
  if (field.name in value) return value[field.name];
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}".` });
  return null;
}

function executeSelectionSet(typename: string, value: AnyView | null, selections: Selection[], ctx: Context): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      const nested = executeSelectionSet(typename, value, fragment.selections, ctx);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== typename) continue;
      const nested = executeSelectionSet(typename, value, selection.selections, ctx);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const resolved = resolveField(typename, value, selection, ctx);
    out[key] = completeValue(typename, selection, resolved, ctx);
  }
  return out;
}

function completeValue(parentType: string, field: FieldSelection, resolved: unknown, ctx: Context): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (field.selections.length === 0) return resolved;
  if (Array.isArray(resolved)) {
    return resolved.map((item) => {
      if (item !== null && typeof item === 'object' && '__typename' in item) {
        return executeSelectionSet((item as AnyView).__typename, item as AnyView, field.selections, ctx);
      }
      return item;
    });
  }
  if (typeof resolved === 'object' && '__typename' in (resolved as AnyView)) {
    return executeSelectionSet((resolved as AnyView).__typename, resolved as AnyView, field.selections, ctx);
  }
  return resolved;
}

function executeOperation(operation: OperationDefinition, definitions: Definition[], variables: Record<string, unknown>, store: Store): Record<string, unknown> {
  const ctx: Context = {
    store,
    variables: { ...variables },
    errors: [],
    fragments: new Map(definitions.filter((d): d is FragmentDefinition => d.kind === 'fragment').map((d) => [d.name, d])),
  };
  for (const def of operation.variables) {
    if (ctx.variables[def.name] === undefined && def.defaultValue !== null) {
      ctx.variables[def.name] = valueOf(def.defaultValue, ctx);
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyView = { __typename: rootType };
  const data = executeSelectionSet(rootType, root, operation.selections, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store, authed: boolean): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authed) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const { value, malformed } = await readJsonBody(req);
  if (malformed) {
    sendJson(res, 400, { message: 'Invalid JSON in request body' });
    return;
  }
  const requests = Array.isArray(value) ? value : [value];
  const results: Array<Record<string, unknown>> = [];
  for (const request of requests) {
    if (typeof request !== 'object' || request === null || typeof (request as Record<string, unknown>).query !== 'string') {
      results.push({ data: null, errors: [{ message: 'A GraphQL query string is required.' }] });
      continue;
    }
    const query = (request as Record<string, unknown>).query as string;
    const variables = ((request as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    const operationName = ((request as Record<string, unknown>).operationName ?? null) as string | null;
    let definitions: Definition[];
    try {
      definitions = new Parser(lex(query)).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] });
      continue;
    }
    const operations = definitions.filter((d): d is OperationDefinition => d.kind === 'operation');
    let operation: OperationDefinition | undefined;
    if (operationName !== null) operation = operations.find((op) => op.name === operationName);
    else operation = operations[0];
    if (operation === undefined) {
      results.push({ data: null, errors: [{ message: operationName !== null ? `Unknown operation named "${operationName}".` : 'No operation found in document.' }] });
      continue;
    }
    results.push(executeOperation(operation, definitions, variables, store));
  }
  sendJson(res, 200, Array.isArray(value) ? results : results[0]);
}
