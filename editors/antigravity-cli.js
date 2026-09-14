const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanArtifacts, parseMcpConfigFile } = require('./base');

const name = 'antigravity-cli';
const labels = { 'antigravity-cli': 'Antigravity CLI' };

function getChats() {
  const historyPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'history.jsonl');
  if (!fs.existsSync(historyPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(historyPath, 'utf-8');
    const lines = content.trim().split('\n');
    const chats = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.conversationId) {
          const transcriptPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', data.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
          let bubbleCount = 0;
          try {
            if (fs.existsSync(transcriptPath)) {
              const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
              bubbleCount = transcriptContent.trim().split('\n').length;
            }
          } catch {}

          chats.push({
            source: 'antigravity-cli',
            composerId: data.conversationId,
            name: data.display || 'Untitled Chat',
            createdAt: data.timestamp,
            lastUpdatedAt: data.timestamp,
            folder: data.workspace || null,
            mode: 'chat',
            bubbleCount,
            encrypted: false
          });
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }
    // Return unique chats by composerId, taking the latest one
    const uniqueChats = new Map();
    for (const chat of chats) {
      uniqueChats.set(chat.composerId, chat);
    }
    return Array.from(uniqueChats.values()).reverse();
  } catch (e) {
    return [];
  }
}

function getMessages(chat) {
  const transcriptPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', chat.composerId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');
    const messages = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const step = JSON.parse(line);
        let role = null;

        if (step.source === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
          role = 'user';
        } else if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
          role = 'assistant';
        } else if (step.source === 'SYSTEM') {
          role = 'system';
        } else if ([
          'TOOL_EXECUTION', 'RUN_COMMAND', 'VIEW_FILE', 'LIST_DIR', 'LIST_DIRECTORY',
          'READ_URL_CONTENT', 'SEARCH_WEB', 'GENERATE_IMAGE', 'GREP_SEARCH',
          'MULTI_REPLACE_FILE_CONTENT', 'REPLACE_FILE_CONTENT', 'WRITE_TO_FILE',
          'MANAGE_TASK', 'SCHEDULE', 'ASK_PERMISSION', 'ASK_QUESTION',
          'DEFINE_SUBAGENT', 'INVOKE_SUBAGENT', 'MANAGE_SUBAGENTS', 'SEND_MESSAGE',
          'CODE_ACTION', 'GENERIC'
        ].includes(step.type) || step.type.endsWith('_RESULT')) {
          role = 'tool';
        }

        if (role) {
          const msg = {
            role,
            content: step.content || '',
            timestamp: step.created_at
          };

          if (role === 'assistant') {
            if (step.tool_calls) {
              msg._toolCalls = step.tool_calls;
            }
            if (step.thinking) {
              msg.thinking = step.thinking;
            }
          }

          messages.push(msg);
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }
    return messages;
  } catch (e) {
    return [];
  }
}

function getArtifacts(folder) {
  return scanArtifacts(folder, {
    editor: name,
    label: labels[name],
    files: ['task.md', 'implementation_plan.md', 'walkthrough.md'],
    dirs: ['.antigravitycli']
  });
}

function getMCPServers() {
  const configPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
  return parseMcpConfigFile(configPath, {
    editor: name,
    label: labels[name],
    scope: 'global'
  });
}

module.exports = { name, labels, getChats, getMessages, getArtifacts, getMCPServers };

