const assert = require('assert/strict');
const path = require('path');
const test = require('node:test');

const kimi = require('../../editors/kimi');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'kimi');

function withShareDir(fixtureName, fn) {
  const previous = process.env.KIMI_SHARE_DIR;
  process.env.KIMI_SHARE_DIR = path.join(FIXTURES_DIR, fixtureName);
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.KIMI_SHARE_DIR;
    else process.env.KIMI_SHARE_DIR = previous;
  }
}

test('reads Kimi sessions from KIMI_SHARE_DIR and resolves hashed folders', () => {
  withShareDir('base', () => {
    const chats = kimi.getChats();
    assert.equal(chats.length, 1);

    const chat = chats[0];
    assert.equal(chat.source, 'kimi-cli');
    assert.equal(chat.composerId, 'session-main');
    assert.equal(chat.mode, 'kimi');
    assert.equal(chat.folder, '/Users/test/project-a');
    assert.equal(chat.name, 'Inspect the repository status and summarize the next step');
    assert.equal(chat.createdAt, 1700000000125);
    assert.equal(chat.lastUpdatedAt, 1700000020750);
    assert.equal(chat.bubbleCount, 5);
  });
});

test('merges archived and live context files, preserving transcript order', () => {
  withShareDir('base', () => {
    const chat = kimi.getChats()[0];
    const messages = kimi.getMessages(chat);

    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'tool', 'user', 'assistant']
    );
    assert.equal(messages[0].content, 'Inspect the repository status and summarize the next step');
    assert.match(messages[1].content, /\[thinking\] I should inspect the repo first\./);
    assert.match(messages[1].content, /\[tool-call: ReadFile\(path\)\]/);
    assert.match(messages[2].content, /^\[ReadFile\] 2 lines read from file starting from line 1\./);
    assert.equal(messages[3].content, 'Now tell me the deployment risk');
    assert.equal(messages[4].content, 'The main risk is missing environment validation.');
  });
});

test('extracts Kimi tool calls and sequential StatusUpdate token usage', () => {
  withShareDir('base', () => {
    const chat = kimi.getChats()[0];
    const messages = kimi.getMessages(chat);
    const assistants = messages.filter((message) => message.role === 'assistant');

    assert.deepEqual(assistants[0]._toolCalls, [
      { name: 'ReadFile', args: { path: 'package.json' } },
    ]);
    assert.equal(assistants[0]._model, 'kimi-code/kimi-for-coding');
    assert.equal(assistants[0]._inputTokens, 1200);
    assert.equal(assistants[0]._outputTokens, 300);
    assert.equal(assistants[0]._cacheRead, 80);
    assert.equal(assistants[0]._cacheWrite, 10);

    assert.equal(assistants[1]._model, 'kimi-code/kimi-for-coding');
    assert.equal(assistants[1]._inputTokens, 900);
    assert.equal(assistants[1]._outputTokens, 250);
    assert.equal(assistants[1]._cacheRead, 40);
    assert.equal(assistants[1]._cacheWrite, undefined);
  });
});

test('drops token attribution when StatusUpdate counts do not match assistant turns', () => {
  withShareDir('mismatch', () => {
    const chat = kimi.getChats()[0];
    const assistants = kimi.getMessages(chat).filter((message) => message.role === 'assistant');

    assert.equal(assistants.length, 2);
    for (const assistant of assistants) {
      assert.equal(assistant._inputTokens, undefined);
      assert.equal(assistant._outputTokens, undefined);
      assert.equal(assistant._cacheRead, undefined);
      assert.equal(assistant._cacheWrite, undefined);
      assert.equal(assistant._model, 'kimi-code/kimi-for-coding');
    }
  });
});

test('falls back safely when wire.jsonl is missing and config.toml is absent', () => {
  withShareDir('no-config', () => {
    const chat = kimi.getChats()[0];
    const messages = kimi.getMessages(chat);

    assert.equal(chat.folder, '/Users/test/project-a');
    assert.equal(chat.createdAt > 0, true);
    assert.equal(chat.lastUpdatedAt > 0, true);
    assert.equal(messages[1]._model, undefined);
    assert.equal(messages[3]._model, undefined);
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'user', 'assistant']
    );
  });
});

test('keeps folder null when kimi.json does not map the session hash', () => {
  withShareDir('no-mapping', () => {
    const chats = kimi.getChats();
    assert.equal(chats.length, 1);
    assert.equal(chats[0].folder, null);
  });
});
