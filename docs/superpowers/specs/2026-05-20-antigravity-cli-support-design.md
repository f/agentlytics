# Design Spec: Antigravity CLI Support for Agentlytics

## Goal
Add support for the **Antigravity CLI** to Agentlytics, allowing users to track, analyze, and view their terminal-based agent sessions alongside their IDE-based sessions.

## Context
Antigravity CLI (released May 2026) is a terminal-native agentic assistant from Google DeepMind. It stores its session data in a structured format in the user's home directory, distinct from the Antigravity IDE.

## Proposed Changes

### 1. New Editor Adapter: `editors/antigravity-cli.js`
A new adapter will be created to handle Antigravity CLI data. It will implement the standard `agentlytics` editor interface:
- `name`: `'antigravity-cli'`
- `labels`: `{ 'antigravity-cli': 'Antigravity CLI' }`
- `getChats()`: Scans for sessions.
- `getMessages(chat)`: Loads messages for a specific session.
- `getArtifacts(folder)`: Scans for session-related artifacts.

### 2. Session Discovery (`getChats`)
The adapter will:
1.  Locate the app data directory: `~/.gemini/antigravity-cli`.
2.  Read the `history.jsonl` file. Each line represents a session:
    - `conversationId`: Unique ID.
    - `display`: Initial user prompt (title).
    - `workspace`: Local project folder.
    - `timestamp`: Creation time.
3.  Normalize this data into the `agentlytics` chat format.

### 3. Message Parsing (`getMessages`)
For a given session, the adapter will:
1.  Read the `transcript.jsonl` from `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
2.  Iterate through the JSON log steps and map them:
    - `USER_INPUT` / `USER_EXPLICIT` → `role: 'user'`
    - `PLANNER_RESPONSE` → `role: 'assistant'` (including `tool_calls`)
    - `TOOL_EXECUTION` / `RUN_COMMAND` / etc. → `role: 'tool'`
    - `SYSTEM` / `ERROR_MESSAGE` → `role: 'system'`
3.  Extract metadata like model name and token counts if available in the log steps.

### 4. Integration
- Register the new adapter in `editors/index.js`.
- Add "Antigravity CLI" to the supported editors list in `README.md`.

## Data Mapping

| CLI Log Field | Agentlytics Message Field |
|---------------|---------------------------|
| `content`     | `content`                 |
| `tool_calls`  | `_toolCalls`              |
| `created_at`  | `timestamp`               |
| `source`      | (used to determine role)  |

## Verification Plan

### Manual Verification
1.  Run `npx agentlytics --collect` to ensure the new sessions are indexed without errors.
2.  Start the Agentlytics dashboard and verify that "Antigravity CLI" appears in the editor list.
3.  Open an Antigravity CLI session and verify that the conversation history, tool calls, and project context are correctly displayed.
