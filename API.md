# API Reference

Agentlytics exposes a read-only REST API at `http://localhost:4637`. All endpoints return JSON.

## `GET /api/overview`

Dashboard summary with KPIs, editor breakdown, mode distribution, monthly trend, and top projects.

**Query params:**
- `editor` — filter by editor source ID (e.g. `cursor`, `devin`, `devin-next`)

**Response:**

```json
{
  "totalSessions": 660,
  "totalProjects": 45,
  "editors": { "cursor": 320, "devin": 120, "devin-next": 60, "claude-code": 160 },
  "modes": { "agent": 500, "chat": 100, "edit": 60 },
  "monthlyTrend": [{ "month": "2025-01", "count": 80 }],
  "topProjects": [{ "folder": "/Users/dev/Code/myapp", "count": 45 }],
  "dailyAvg": 5.2,
  "currentMonth": 42,
  "firstDate": "2024-06-15",
  "lastDate": "2025-03-07"
}
```

---

## `GET /api/daily-activity`

Daily session counts for the activity heatmap. Returns one entry per day.

**Query params:**
- `editor` — filter by editor source ID

**Response:**

```json
[
  { "date": "2025-03-01", "count": 8 },
  { "date": "2025-03-02", "count": 3 }
]
```

---

## `GET /api/dashboard-stats`

Detailed analytics: hourly distribution, weekday patterns, session depth, token economy, coding streaks, monthly trends by editor, conversation velocity, top models, and top tools.

**Query params:**
- `editor` — filter by editor source ID

**Response:**

```json
{
  "hourlyDistribution": [{ "hour": 14, "count": 45 }],
  "weekdayPattern": [{ "day": 1, "label": "Mon", "count": 120 }],
  "sessionDepth": [{ "bucket": "1-5", "count": 200 }],
  "tokenEconomy": {
    "totalInput": 5000000,
    "totalOutput": 2000000,
    "totalCacheRead": 800000,
    "totalCacheWrite": 100000,
    "avgInputPerSession": 7500,
    "avgOutputPerSession": 3000,
    "cacheHitRate": 0.35,
    "outputInputRatio": 0.4,
    "totalUserChars": 150000,
    "totalAssistantChars": 2500000
  },
  "streaks": {
    "currentStreak": 5,
    "longestStreak": 21,
    "activeDays": 180,
    "totalDays": 270,
    "avgSessionsPerActiveDay": 3.6
  },
  "monthlyTrendByEditor": [
    { "month": "2025-01", "editor": "cursor", "count": 40 }
  ],
  "conversationVelocity": [
    { "month": "2025-01", "avgMessages": 12.5 }
  ],
  "topModels": [{ "model": "claude-sonnet-4-20250514", "count": 200 }],
  "topTools": [{ "tool": "edit_file", "count": 1500 }]
}
```

---

## `GET /api/chats`

Paginated list of chat sessions.

**Query params:**
- `editor` — filter by editor source ID
- `folder` — filter by project directory
- `named` — `true` (default) to show only named chats, `false` for all
- `limit` — page size (default: `200`)
- `offset` — pagination offset (default: `0`)

**Response:**

```json
{
  "total": 660,
  "chats": [
    {
      "id": "abc-123",
      "source": "cursor",
      "name": "Implement auth flow",
      "mode": "agent",
      "folder": "/Users/dev/Code/myapp",
      "createdAt": 1709827200000,
      "lastUpdatedAt": 1709830800000,
      "encrypted": false,
      "bubbleCount": 24
    }
  ]
}
```

---

## `GET /api/chats/:id`

Full chat detail including messages, stats, and tool calls.

**Response:**

```json
{
  "chat": {
    "id": "abc-123",
    "source": "cursor",
    "name": "Implement auth flow",
    "mode": "agent",
    "folder": "/Users/dev/Code/myapp",
    "created_at": 1709827200000,
    "last_updated_at": 1709830800000
  },
  "stats": {
    "total_messages": 24,
    "user_messages": 8,
    "assistant_messages": 16,
    "tool_calls": "[\"edit_file\",\"read_file\"]",
    "models": "[\"claude-sonnet-4-20250514\"]",
    "total_input_tokens": 50000,
    "total_output_tokens": 20000
  },
  "messages": [
    {
      "seq": 0,
      "role": "user",
      "content": "Add JWT authentication",
      "model": null,
      "input_tokens": null,
      "output_tokens": null
    }
  ]
}
```

---

## `GET /api/projects`

All projects with aggregated analytics.

**Response:**

```json
[
  {
    "folder": "/Users/dev/Code/myapp",
    "sessions": 45,
    "editors": { "cursor": 30, "claude-code": 15 },
    "totalMessages": 600,
    "totalInputTokens": 500000,
    "totalOutputTokens": 200000,
    "models": ["claude-sonnet-4-20250514", "gpt-4"],
    "tools": ["edit_file", "read_file"],
    "lastActive": 1709830800000
  }
]
```

---

## `GET /api/deep-analytics`

Aggregated tool call frequency, model distribution, and token breakdown.

**Query params:**
- `editor` — filter by editor source ID
- `folder` — filter by project directory
- `limit` — max tool/model entries (default: `500`, max: `5000`)

**Response:**

```json
{
  "tools": [{ "name": "edit_file", "count": 1500 }],
  "models": [{ "name": "claude-sonnet-4-20250514", "count": 200 }],
  "tokens": {
    "totalInput": 5000000,
    "totalOutput": 2000000,
    "totalCacheRead": 800000,
    "totalCacheWrite": 100000
  }
}
```

---

## `GET /api/costs`

Estimated API costs based on token usage and model pricing.

**Query params:**
- `editor` — filter by editor source
- `folder` — filter by project directory
- `chatId` — filter by specific chat session
- `dateFrom` / `dateTo` — Unix ms timestamps

**Response:**

```json
{
  "totalCost": 12.45,
  "byModel": [
    { "model": "claude-sonnet-4-20250514", "inputTokens": 5000000, "outputTokens": 2000000, "cacheRead": 800000, "cacheWrite": 100000, "cost": 10.50 },
    { "model": "gpt-4o", "inputTokens": 500000, "outputTokens": 200000, "cacheRead": 0, "cacheWrite": 0, "cost": 1.95 }
  ],
  "unknownModels": ["custom-model-v1"]
}
```

---

## `GET /api/tool-calls`

Individual tool call instances for a specific tool.

**Query params:**
- `name` — tool name *(required)*
- `folder` — filter by project directory
- `limit` — max results (default: `200`, max: `1000`)

**Response:**

```json
[
  {
    "chat_id": "abc-123",
    "tool_name": "edit_file",
    "args_json": "{\"file_path\":\"/src/auth.js\",\"old_string\":\"...\",\"new_string\":\"...\"}",
    "source": "cursor",
    "folder": "/Users/dev/Code/myapp",
    "timestamp": 1709828000000
  }
]
```

---

## `GET /api/refetch`

Server-Sent Events (SSE) stream that wipes the cache and rescans all editors.

**Response:** `text/event-stream`

```
data: {"scanned":10,"analyzed":5,"skipped":5,"total":660}
data: {"scanned":20,"analyzed":15,"skipped":5,"total":660}
...
data: {"done":true,"total":660,"analyzed":205}
```

Connect with `EventSource`:

```javascript
const es = new EventSource('/api/refetch');
es.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.done) es.close();
};
```
