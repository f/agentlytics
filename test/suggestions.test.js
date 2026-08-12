const test = require('node:test');
const assert = require('node:assert/strict');

const cursor = require('../suggestions/cursor');
const claude = require('../suggestions/claude-code');

function cursorUsage(overrides = {}) {
  return {
    cursorSessions: 6,
    cursorSessionsByFolder: new Map(),
    cursorToolNames: new Set(),
    cursorToolNamesByFolder: new Map(),
    cursorSessionsLast30d: 6,
    messageMcpMentions: new Set(),
    messageMcpMentionsByFolder: new Map(),
    otherEditorMcpTools: new Map(),
    retryLoops: [],
    mcpToolInvocationCount: new Map(),
    pricing: { estimated: true },
    ...overrides,
  };
}

test('recognizes MCP tool names without matching unrelated servers', () => {
  assert.equal(cursor.toolMatchesServer('mcp-github-user-github-search_issues', 'github'), true);
  assert.equal(cursor.toolMatchesServer('mcp__github__search_issues', 'github'), true);
  assert.equal(cursor.toolMatchesServer('mcp-github-user-github-search_issues', 'git'), false);
  assert.equal(cursor.toolMatchesServer('read_file', 'github'), false);

  assert.equal(claude.toolMatchesServer('mcp__github__search_issues', 'github'), true);
  assert.equal(claude.toolMatchesServer('mcp__plugin_acme_github__search_issues', 'github'), true);
  assert.equal(claude.toolMatchesServer('mcp__github__search_issues', 'git'), false);
});

test('reports never-called heavy MCP schemas as recurring context overhead', () => {
  const config = {
    global: {
      mcpServers: [{ name: 'github', disabled: false }],
      mcpToolSchemas: new Map([[
        'github',
        new Map([
          ['search_issues', { tokens: 120, chars: 480 }],
          ['create_pull_request', { tokens: 420, chars: 1680 }],
        ]),
      ]]),
      skills: [],
      cliConfig: null,
    },
    projects: [],
  };
  const usage = cursorUsage({
    cursorToolNames: new Set(['mcp__github__search_issues']),
    mcpToolInvocationCount: new Map([['mcp__github__search_issues', 4]]),
  });

  const findings = cursor.analyze(config, usage);
  const finding = findings.find(f => f.id === 'mcp-tools-weight:github');

  assert.ok(finding);
  assert.equal(finding.category, 'mcp');
  assert.equal(finding.impact.tokensPerRequest, 420);
  assert.match(finding.title, /uncalled\/rare tools/);
  assert.match(finding.detail, /create_pull_request/);
  assert.doesNotMatch(finding.detail, /Never called .*search_issues/s);
  assert.deepEqual(finding.fix.disabledTools, ['create_pull_request']);
});
