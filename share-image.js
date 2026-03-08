/**
 * Generates a shareable SVG stats card from cached data.
 * Accepts an `opts` object to toggle sections on/off.
 */

function fmt(n) {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function fmtCost(n) {
  if (n == null || n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  if (n >= 100) return '$' + Math.round(n);
  return '$' + n.toFixed(2);
}

const EDITOR_COLORS = {
  'cursor': '#f59e0b',
  'windsurf': '#06b6d4',
  'windsurf-next': '#22d3ee',
  'antigravity': '#a78bfa',
  'claude-code': '#f97316',
  'claude': '#f97316',
  'vscode': '#3b82f6',
  'vscode-insiders': '#60a5fa',
  'zed': '#10b981',
  'opencode': '#ec4899',
  'codex': '#0f766e',
  'gemini-cli': '#4285f4',
  'kimi-cli': '#84cc16',
  'copilot-cli': '#8957e5',
  'cursor-agent': '#f59e0b',
  'commandcode': '#e11d48',
};

const EDITOR_LABELS = {
  'cursor': 'Cursor',
  'windsurf': 'Windsurf',
  'windsurf-next': 'WS Next',
  'antigravity': 'Antigravity',
  'claude-code': 'Claude Code',
  'claude': 'Claude Code',
  'vscode': 'VS Code',
  'vscode-insiders': 'VS Code Ins.',
  'zed': 'Zed',
  'opencode': 'OpenCode',
  'codex': 'Codex',
  'gemini-cli': 'Gemini CLI',
  'kimi-cli': 'Kimi CLI',
  'copilot-cli': 'Copilot CLI',
  'cursor-agent': 'Cursor Agent',
  'commandcode': 'Cmd Code',
};

/**
 * @param {object} overview  — from getCachedOverview()
 * @param {object} stats     — from getCachedDashboardStats()
 * @param {object} costs     — from getCostBreakdown()
 * @param {object} [opts]    — toggle sections
 * @param {boolean} [opts.showEditors=true]
 * @param {boolean} [opts.showModels=true]
 * @param {boolean} [opts.showCosts=true]
 * @param {boolean} [opts.showTokens=true]
 * @param {boolean} [opts.showHours=true]
 * @param {boolean} [opts.showProjects=true]
 * @param {string}  [opts.username]
 * @param {string}  [opts.theme='dark'] — 'dark' or 'light'
 */
const THEMES = {
  dark: {
    bg: '#09090f', bg2: '#111118', card: '#111', border: '#1e1e2a',
    text: '#fff', text2: '#888', text3: '#666', text4: '#555', text5: '#444',
    titleText: '#555',
    hourHigh: '#818cf8', hourMed: '#6366f1', hourLow: '#4f46e5', hourMin: '#1e1b4b',
  },
  light: {
    bg: '#f8f8fa', bg2: '#eeeef2', card: '#e8e8ee', border: '#d0d0d8',
    text: '#111', text2: '#555', text3: '#888', text4: '#999', text5: '#aaa',
    titleText: '#888',
    hourHigh: '#6366f1', hourMed: '#818cf8', hourLow: '#a5b4fc', hourMin: '#e0e7ff',
  },
};

function generateShareSvg(overview, stats, costs, opts = {}) {
  const show = {
    editors:  opts.showEditors  !== false,
    models:   opts.showModels   !== false,
    costs:    opts.showCosts    !== false,
    tokens:   opts.showTokens   !== false,
    hours:    opts.showHours    !== false,
  };
  const username = opts.username || '';
  const t = THEMES[opts.theme] || THEMES.dark;
  const projectFolder = opts.folder || '';
  const projectName = projectFolder ? projectFolder.split(/[/\\]/).pop() : '';

  const W = 1200;
  const H_FIXED = 675;
  const F = "\"'Menlo','Monaco','Cascadia Code','Courier New',monospace\"";
  const editors = overview.editors || [];
  const tk = stats.tokens || {};
  const streaks = stats.streaks || {};
  const topModels = (stats.topModels || []).slice(0, 5);
  const costData = costs || {};
  const totalCost = costData.totalCost || 0;
  const costByEditor = (costData.byEditor || []).slice(0, 6);
  const totalTokens = (tk.input || 0) + (tk.output || 0);
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // ── Compute layout ──
  let y = 0;
  const pad = 28;

  // Title bar
  y += 40;
  // Header area (prompt + branding)
  y += 54;
  // KPI row
  y += 80;
  // Sections
  const midSections = [];
  if (show.editors) midSections.push('editors');
  if (show.costs && totalCost > 0) midSections.push('costs');
  if (show.hours) midSections.push('hours');
  if (show.models && topModels.length > 0) midSections.push('models');

  // Layout: 2 columns, each section ~row
  const leftSections = [];
  const rightSections = [];
  midSections.forEach((s, i) => {
    if (i % 2 === 0) leftSections.push(s);
    else rightSections.push(s);
  });

  function sectionHeight(name) {
    if (name === 'editors') return Math.max(editors.slice(0, 8).length * 26 + 34, 70);
    if (name === 'costs') return Math.max(costByEditor.length * 26 + 34, 70);
    if (name === 'hours') return 110;
    if (name === 'models') return topModels.length * 22 + 34;
    return 70;
  }

  // Mid-section pairs: compute max height of each row
  const rowCount = Math.max(leftSections.length, rightSections.length);
  let midHeight = 0;
  for (let i = 0; i < rowCount; i++) {
    const lh = leftSections[i] ? sectionHeight(leftSections[i]) : 0;
    const rh = rightSections[i] ? sectionHeight(rightSections[i]) : 0;
    midHeight += Math.max(lh, rh) + 8;
  }

  // Token footer
  const tokenFooterH = show.tokens ? 44 : 0;
  // Footer
  const footerH = 36;

  const naturalH = y + midHeight + tokenFooterH + footerH + 20;
  // Stretch: if content is shorter than 675, distribute extra space into sections
  const extraSpace = Math.max(0, H_FIXED - naturalH);
  const extraPerRow = rowCount > 0 ? extraSpace / rowCount : 0;

  // ── KPI cards ──
  const kpiY = 94;
  const kpiCards = [];
  const kpiItems = [
    { label: 'sessions', value: fmt(overview.totalChats) },
    { label: 'tokens', value: fmt(totalTokens) },
    { label: 'active days', value: String(streaks.totalDays || 0) },
    { label: 'streak', value: `${streaks.current || 0}d` },
  ];
  if (show.costs && totalCost > 0) {
    kpiItems.push({ label: 'est. cost', value: fmtCost(totalCost) });
  }
  const kpiW = (W - pad * 2 - (kpiItems.length - 1) * 8) / kpiItems.length;
  kpiItems.forEach((item, i) => {
    const x = pad + i * (kpiW + 8);
    kpiCards.push(`
      <rect x="${x}" y="${kpiY}" width="${kpiW}" height="64" rx="6" fill="${t.card}"/>
      <text x="${x + 14}" y="${kpiY + 22}" fill="${t.text3}" font-size="11" font-family=${F}>${esc(item.label)}</text>
      <text x="${x + 14}" y="${kpiY + 50}" fill="${t.text}" font-size="24" font-weight="bold" font-family=${F}>${esc(item.value)}</text>
    `);
  });

  // ── Editor bar chart ──
  const colW = (W - pad * 2 - 20) / 2;
  const maxBarW = colW - 120 - 60;
  const maxEditorCount = Math.max(...editors.map(e => e.count), 1);
  const editorBarsArr = editors.slice(0, 8).map((e, i) => {
    const barW = Math.max((e.count / maxEditorCount) * maxBarW, 4);
    const color = EDITOR_COLORS[e.id] || '#6b7280';
    const label = (EDITOR_LABELS[e.id] || e.id);
    return { label, barW, color, count: e.count };
  });

  // ── Cost bar chart ──
  const maxCostVal = costByEditor.length > 0 ? Math.max(...costByEditor.map(c => c.cost), 0.01) : 1;
  const costBarsArr = costByEditor.map(c => {
    const barW = Math.max((c.cost / maxCostVal) * maxBarW, 4);
    const color = EDITOR_COLORS[c.editor] || '#6b7280';
    const label = EDITOR_LABELS[c.editor] || c.editor;
    return { label, barW, color, value: fmtCost(c.cost) };
  });

  // ── Hourly sparkline ──
  const hourly = stats.hourly || new Array(24).fill(0);
  const maxHourly = Math.max(...hourly, 1);

  // ── Build sections ──
  let curY = kpiY + 64 + 18;
  const sectionSvgs = [];

  for (let row = 0; row < rowCount; row++) {
    const lName = leftSections[row];
    const rName = rightSections[row];
    const lh = lName ? sectionHeight(lName) : 0;
    const rh = rName ? sectionHeight(rName) : 0;
    const rowH = Math.max(lh, rh) + Math.round(extraPerRow);

    if (lName) sectionSvgs.push(renderSection(lName, pad, curY, colW, rowH));
    if (rName) sectionSvgs.push(renderSection(rName, pad + colW + 20, curY, colW, rowH));

    curY += rowH + 10;
  }

  function renderSection(name, sx, sy, sw, sh) {
    let out = '';
    if (name === 'editors') {
      out += `<text x="${sx}" y="${sy + 14}" fill="${t.text4}" font-size="11" font-family=${F}># editors</text>`;
      editorBarsArr.forEach((e, i) => {
        const by = sy + 26 + i * 26;
        out += `<text x="${sx}" y="${by + 14}" fill="${t.text2}" font-size="12" font-family=${F}>${esc(e.label)}</text>`;
        out += `<rect x="${sx + 120}" y="${by + 1}" width="${e.barW}" height="16" rx="3" fill="${e.color}" opacity="0.85"/>`;
        out += `<text x="${sx + 128 + e.barW}" y="${by + 14}" fill="${t.text3}" font-size="11" font-family=${F}>${e.count}</text>`;
      });
    } else if (name === 'costs') {
      out += `<text x="${sx}" y="${sy + 14}" fill="${t.text4}" font-size="11" font-family=${F}># est. costs by editor</text>`;
      costBarsArr.forEach((c, i) => {
        const by = sy + 26 + i * 26;
        out += `<text x="${sx}" y="${by + 14}" fill="${t.text2}" font-size="12" font-family=${F}>${esc(c.label)}</text>`;
        out += `<rect x="${sx + 120}" y="${by + 1}" width="${c.barW}" height="16" rx="3" fill="${c.color}" opacity="0.85"/>`;
        out += `<text x="${sx + 128 + c.barW}" y="${by + 14}" fill="${t.text3}" font-size="11" font-family=${F}>${c.value}</text>`;
      });
    } else if (name === 'hours') {
      out += `<text x="${sx}" y="${sy + 14}" fill="${t.text4}" font-size="11" font-family=${F}># peak hours</text>`;
      const sparkW = sw - 8;
      const sparkH = 56;
      const baseY = sy + 28;
      const barW = sparkW / 24 - 1;
      hourly.forEach((v, i) => {
        const bh = Math.max((v / maxHourly) * sparkH, 1);
        const bx = sx + i * (barW + 1);
        const by = baseY + sparkH - bh;
        const intensity = v / maxHourly;
        const color = intensity > 0.75 ? t.hourHigh : intensity > 0.5 ? t.hourMed : intensity > 0.25 ? t.hourLow : t.hourMin;
        out += `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="1" fill="${color}" opacity="0.9"/>`;
      });
      out += `<text x="${sx}" y="${baseY + sparkH + 14}" fill="${t.text5}" font-size="9" font-family=${F}>00</text>`;
      out += `<text x="${sx + sparkW / 4}" y="${baseY + sparkH + 14}" fill="${t.text5}" font-size="9" font-family=${F}>06</text>`;
      out += `<text x="${sx + sparkW / 2}" y="${baseY + sparkH + 14}" fill="${t.text5}" font-size="9" font-family=${F}>12</text>`;
      out += `<text x="${sx + sparkW * 3 / 4}" y="${baseY + sparkH + 14}" fill="${t.text5}" font-size="9" font-family=${F}>18</text>`;
      out += `<text x="${sx + sparkW - 8}" y="${baseY + sparkH + 14}" fill="${t.text5}" font-size="9" font-family=${F}>23</text>`;
    } else if (name === 'models') {
      out += `<text x="${sx}" y="${sy + 14}" fill="${t.text4}" font-size="11" font-family=${F}># top models</text>`;
      topModels.forEach((m, i) => {
        const my = sy + 32 + i * 22;
        const mName = m.name.length > 28 ? m.name.substring(0, 28) + '…' : m.name;
        out += `<text x="${sx}" y="${my}" fill="${t.text2}" font-size="11" font-family=${F}>${esc(mName)}</text>`;
        out += `<text x="${sx + sw - 4}" y="${my}" fill="${t.text4}" font-size="11" font-family=${F} text-anchor="end">${m.count}</text>`;
      });
    }
    return out;
  }

  // ── Token footer line ──
  let tokenLine = '';
  if (show.tokens) {
    const ty = curY + 4;
    const tkPairs = [
      ['input', fmt(tk.input)],
      ['output', fmt(tk.output)],
      ['cache read', fmt(tk.cacheRead)],
      ['cache write', fmt(tk.cacheWrite)],
      ['tools', fmt(stats.totalToolCalls || 0)],
      ['editors', String(editors.length)],
    ];
    let tkX = pad;
    let tkSvg = `<line x1="${pad}" y1="${ty}" x2="${W - pad}" y2="${ty}" stroke="${t.border}" stroke-width="1"/>`;
    tkPairs.forEach(([label, val]) => {
      tkSvg += `<text x="${tkX}" y="${ty + 20}" fill="${t.text5}" font-size="10" font-family=${F}>${label}</text>`;
      tkSvg += `<text x="${tkX}" y="${ty + 34}" fill="${t.text2}" font-size="12" font-weight="600" font-family=${F}>${val}</text>`;
      tkX += (W - pad * 2) / tkPairs.length;
    });
    tokenLine = tkSvg;
    curY = ty + tokenFooterH;
  }

  // ── Final footer — pin to bottom of canvas ──
  const footerY = H_FIXED - 28;

  const usernameText = username ? `<text x="${W / 2}" y="${footerY + 14}" fill="${t.text5}" font-size="11" font-family=${F} text-anchor="middle">${esc(username)}</text>` : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 ${W} ${H_FIXED}">
  <defs>
    <linearGradient id="accentGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#818cf8"/>
      <stop offset="50%" stop-color="#a78bfa"/>
      <stop offset="100%" stop-color="#c084fc"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H_FIXED}" rx="12" fill="${t.bg}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H_FIXED - 1}" rx="12" fill="none" stroke="${t.border}" stroke-width="1"/>

  <!-- Title bar -->
  <rect x="1" y="1" width="${W - 2}" height="38" rx="12" fill="${t.bg2}"/>
  <rect x="1" y="22" width="${W - 2}" height="17" fill="${t.bg2}"/>
  <circle cx="20" cy="20" r="5" fill="#ef4444" opacity="0.7"/>
  <circle cx="36" cy="20" r="5" fill="#f59e0b" opacity="0.7"/>
  <circle cx="52" cy="20" r="5" fill="#22c55e" opacity="0.7"/>
  <text x="${W / 2}" y="25" fill="${t.text2}" font-size="13" font-weight="600" font-family=${F} text-anchor="middle">agentlytics.io</text>

  <!-- Accent line -->
  <rect x="${pad}" y="44" width="60" height="2" rx="1" fill="url(#accentGrad)"/>

  <!-- Branding -->
  <g transform="translate(${pad}, 52) scale(0.8)" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>
  </g>
  <text x="${pad + 26}" y="68" fill="${t.text}" font-size="16" font-weight="bold" font-family=${F}>Agentlytics</text>
  <text x="${pad + 148}" y="68" fill="${t.text4}" font-size="13" font-family=${F}>${projectName ? esc(projectName) : 'Your AI coding stats'}</text>
  <text x="${W - pad}" y="68" fill="${t.text5}" font-size="12" font-family=${F} text-anchor="end">${esc(dateStr)}</text>

  <!-- Divider -->
  <line x1="${pad}" y1="78" x2="${W - pad}" y2="78" stroke="${t.border}" stroke-width="1"/>

  <!-- KPI cards -->
  ${kpiCards.join('')}

  <!-- Sections -->
  ${sectionSvgs.join('')}

  <!-- Token footer -->
  ${tokenLine}

  <!-- Footer -->
  <line x1="${pad}" y1="${footerY}" x2="${W - pad}" y2="${footerY}" stroke="${t.border}" stroke-width="1"/>
  <text x="${pad}" y="${footerY + 14}" fill="${t.text5}" font-size="11" font-family=${F}>github.com/f/agentlytics</text>
  ${usernameText}
  <text x="${W - pad}" y="${footerY + 14}" fill="${t.text5}" font-size="11" font-family=${F} text-anchor="end">npx agentlytics</text>
</svg>`;

  return svg;
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { generateShareSvg };
