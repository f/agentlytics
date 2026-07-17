const path = require('path');
const fs = require('fs');

const name = 'gsd';
const labels = { gsd: 'GSD Workflow' };

// ============================================================
// Helpers
// ============================================================

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function statSafe(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function countFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => !f.startsWith('.')).length; } catch { return 0; }
}

/**
 * Parse YAML frontmatter from STATE.md.
 * Returns { status, milestone, stoppedAt, progress } or null.
 */
function parseStateMd(content) {
  if (!content) return null;
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const yaml = m[1];
  function get(key) {
    const r = yaml.match(new RegExp(`^${key}:\\s*(.+)`, 'm'));
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : null;
  }
  function getInt(key) { const v = get(key); return v ? parseInt(v) : null; }
  const progressBlock = yaml.match(/^progress:\s*\n((?:[ \t]+.+\n?)*)/m);
  let progress = null;
  if (progressBlock) {
    const pb = progressBlock[1];
    function pgGet(key) {
      const r = pb.match(new RegExp(`${key}:\\s*(\\d+)`));
      return r ? parseInt(r[1]) : null;
    }
    progress = {
      total_phases: pgGet('total_phases'),
      completed_phases: pgGet('completed_phases'),
      total_plans: pgGet('total_plans'),
      completed_plans: pgGet('completed_plans'),
    };
  }
  return {
    status: get('status'),
    milestone: get('milestone'),
    stoppedAt: get('stopped_at'),
    lastUpdated: get('last_updated'),
    progress,
  };
}

/**
 * Parse ROADMAP.md phase checkboxes into a map of phase_number → completed.
 * Phase lines look like: - [x] **Phase 1: Name** or - [ ] Phase 2: Name
 */
function parseRoadmapPhaseStatus(content) {
  if (!content) return new Map();
  const statusMap = new Map(); // phase_number (int) → 'completed' | 'planned'
  for (const line of content.split('\n')) {
    const cbMatch = line.match(/^[-*]\s+\[([x ])\]\s+(.+)/i);
    if (!cbMatch) continue;
    const text = cbMatch[2];
    if (/\d+-\d+-PLAN\.md/i.test(text) || /PLAN\.md\s*[—–-]/i.test(text)) continue;
    // Extract phase number from patterns: "Phase 1:", "Phase 01:", "**Phase 2:**"
    const numMatch = text.match(/phase\s+(\d+)/i);
    if (!numMatch) continue;
    const num = parseInt(numMatch[1]);
    if (!isNaN(num)) {
      statusMap.set(num, cbMatch[1].toLowerCase() === 'x' ? 'completed' : 'planned');
    }
  }
  return statusMap;
}

/**
 * Parse PROJECT.md — first # heading = project name, rest = description.
 */
function parseProjectMd(content) {
  if (!content) return { name: null, description: null };
  const lines = content.split('\n');
  let projectName = null;
  const descLines = [];
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    if (h1 && !projectName) {
      projectName = h1[1].trim();
      continue;
    }
    if (projectName && line.trim()) descLines.push(line.trim());
  }
  return {
    name: projectName,
    description: descLines.slice(0, 3).join(' ').substring(0, 300) || null,
  };
}

/**
 * Parse ROADMAP.md for phase completion.
 * Supports: - [ ] **Phase N: Name** ...  and  - [x] **Phase N: Name** ...
 * Also supports emoji: ✅ completed, 🚧 in-progress, □ planned
 */
function parseRoadmapMd(content) {
  if (!content) return [];
  const phases = [];
  for (const line of content.split('\n')) {
    // Checkbox style: - [ ] or - [x]
    // Only count lines that look like phase entries, NOT plan file listings (e.g. "01-01-PLAN.md")
    const cbMatch = line.match(/^[-*]\s+\[([x ])\]\s+(.+)/i);
    if (cbMatch) {
      const text = cbMatch[2];
      // Skip plan file entries like "01-01-PLAN.md — description"
      if (/\d+-\d+-PLAN\.md/i.test(text) || /PLAN\.md\s*[—–-]/i.test(text)) continue;
      phases.push({ text: text.replace(/\*\*/g, '').trim(), completed: cbMatch[1].toLowerCase() === 'x' });
      continue;
    }
    // Emoji style: ✅ completed, 🚧 in-progress (milestone-level)
    const emojiMatch = line.match(/^[-*]\s+(✅|🚧|⬜|□)\s+(.+)/);
    if (emojiMatch) {
      phases.push({ text: emojiMatch[2].replace(/\*\*/g, '').trim(), completed: emojiMatch[1] === '✅' });
    }
  }
  return phases;
}

/**
 * Detect the currently active milestone name from ROADMAP.md.
 * Looks for 🚧 milestone entries or the first uncompleted milestone block.
 */
function detectActiveMilestone(content) {
  if (!content) return null;
  for (const line of content.split('\n')) {
    const m = line.match(/🚧\s+\*?\*?([^*\n-]+)/);
    if (m) return m[1].trim().split(' - ')[0].trim();
    // Also handle "in progress" text
    if (/in.progress/i.test(line)) {
      const nm = line.match(/\*?\*?([vV][\d.]+[^*]*)\*?\*?/);
      if (nm) return nm[1].trim();
    }
  }
  return null;
}

/**
 * Extract phase number prefix from a phase directory name.
 * e.g. "01-auth-ve-giris" → "01"
 * e.g. "999.1-backlog-item" → "999.1"
 */
function extractPhasePrefix(dirName) {
  const m = dirName.match(/^(\d+(?:\.\d+)?)-/);
  return m ? m[1] : null;
}

/**
 * Parse checkbox tasks from a PLAN.md file.
 */
function parseCheckboxes(content) {
  if (!content) return { total: 0, completed: 0, tasks: [] };
  const tasks = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^[-*]\s+\[([x ])\]\s+(.+)/i);
    if (!m) continue;
    tasks.push({ name: m[2].trim(), completed: m[1].toLowerCase() === 'x' });
  }
  return { total: tasks.length, completed: tasks.filter(t => t.completed).length, tasks };
}

// ============================================================
// Public API
// ============================================================

/**
 * Scan known project folders for GSD .planning/ directories.
 * Returns project-level summary for each GSD project found.
 */
function getGSDProjects(knownFolders) {
  const results = [];

  for (const folder of knownFolders) {
    if (!folder) continue;
    const planningDir = path.join(folder, '.planning');
    if (!fs.existsSync(planningDir)) continue;

    // Must have at least PROJECT.md or ROADMAP.md to be a GSD project
    const hasProject = fs.existsSync(path.join(planningDir, 'PROJECT.md'));
    const hasRoadmap = fs.existsSync(path.join(planningDir, 'ROADMAP.md'));
    if (!hasProject && !hasRoadmap) continue;

    const projectContent = readFileSafe(path.join(planningDir, 'PROJECT.md'));
    const roadmapContent = readFileSafe(path.join(planningDir, 'ROADMAP.md'));
    const stateContent = readFileSafe(path.join(planningDir, 'STATE.md'));
    const stateData = parseStateMd(stateContent);

    const { name: projectName, description } = parseProjectMd(projectContent);

    // Use filesystem as source of truth for phase counts
    // Filter out malformed directory names (e.g. dirs with JSON content in name)
    const phases = getGSDPhases(folder, roadmapContent);
    const validPhases = phases.filter(ph => ph.number !== null);

    const totalPhases = validPhases.length;
    const completedPhases = validPhases.filter(p => p.status === 'completed').length;
    const firstIncomplete = validPhases.find(p => p.status !== 'completed');
    const activePhase = stateData?.stoppedAt || (firstIncomplete ? firstIncomplete.name : null);

    // Prefer STATE.md milestone, fallback to ROADMAP detection
    const activeMilestone = stateData?.milestone || detectActiveMilestone(roadmapContent);

    // Count todos/seeds/quick (common GSD directories)
    const todos = countFiles(path.join(planningDir, 'todos'))
      + countFiles(path.join(planningDir, 'seeds'));
    const notes = countFiles(path.join(planningDir, 'quick'));
    const backlog = countFiles(path.join(planningDir, 'backlog'));

    const planStat = statSafe(planningDir);
    const lastModified = planStat ? Math.round(planStat.mtimeMs) : null;

    results.push({
      folder,
      name: projectName || path.basename(folder),
      description,
      milestone: activeMilestone,
      totalPhases,
      completedPhases,
      activePhase,
      todos,
      backlog,
      notes,
      lastModified,
    });
  }

  return results;
}

/**
 * Return phase details for a single GSD project.
 * Phases live in .planning/phases/<phaseDir>/
 * roadmapContent is optionally passed to cross-reference checkbox status.
 */
function getGSDPhases(folder, roadmapContent) {
  if (roadmapContent === undefined) {
    roadmapContent = readFileSafe(path.join(folder, '.planning', 'ROADMAP.md'));
  }
  const roadmapStatus = parseRoadmapPhaseStatus(roadmapContent);
  const phasesDir = path.join(folder, '.planning', 'phases');
  let phaseDirs;
  try {
    phaseDirs = fs.readdirSync(phasesDir)
      .filter(f => {
        try { return fs.statSync(path.join(phasesDir, f)).isDirectory(); } catch { return false; }
      })
      .sort((a, b) => {
        // Sort by numeric prefix (supports decimals like 999.1)
        const na = parseFloat(extractPhasePrefix(a) || '9999');
        const nb = parseFloat(extractPhasePrefix(b) || '9999');
        return na - nb;
      });
  } catch { return []; }

  const phases = [];
  for (const phaseDir of phaseDirs) {
    const phaseFullDir = path.join(phasesDir, phaseDir);
    const prefix = extractPhasePrefix(phaseDir);

    // Phase name: everything after the leading number prefix
    const nameRaw = phaseDir.replace(/^\d+(?:\.\d+)?-/, '').replace(/-/g, ' ');
    const phaseName = nameRaw.length > 0 ? nameRaw : phaseDir;

    // Phase number (numeric value for display)
    const phaseNumber = prefix ? parseFloat(prefix) : null;

    // Detect artifact files using the phase prefix pattern
    let hasPlan = false, hasResearch = false, hasVerification = false;
    let planCount = 0, summaryCount = 0;
    let latestMtime = 0;

    try {
      const files = fs.readdirSync(phaseFullDir);
      for (const f of files) {
        const fPath = path.join(phaseFullDir, f);
        const st = statSafe(fPath);
        if (st && st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;

        // PLAN files: {prefix}-{n}-PLAN.md
        if (f.match(/PLAN\.md$/i)) { hasPlan = true; planCount++; }
        // SUMMARY files: indicates a plan was executed
        if (f.match(/SUMMARY\.md$/i)) summaryCount++;
        // VERIFICATION
        if (f.match(/VERIFICATION\.md$/i)) hasVerification = true;
        // RESEARCH
        if (f.match(/RESEARCH\.md$/i)) hasResearch = true;
      }
    } catch { /* skip */ }

    // Determine status: file-based first, then cross-reference ROADMAP.md checkboxes
    let status = 'planned';
    if (hasVerification) {
      status = 'completed';
    } else if (roadmapStatus.get(phaseNumber) === 'completed') {
      // ROADMAP.md marks this phase [x] even without VERIFICATION.md
      status = 'completed';
    } else if (summaryCount > 0) {
      status = 'executing';
    } else if (hasPlan) {
      status = 'planned';
    }

    phases.push({
      phaseDir,
      number: phaseNumber,
      name: phaseName,
      status,
      tasks: { total: planCount, completed: summaryCount },
      hasVerification,
      hasPlan,
      hasResearch,
      lastModified: latestMtime || null,
    });
  }

  return phases;
}

/**
 * Return combined PLAN.md content for a phase.
 * Aggregates all *-PLAN.md files in order.
 */
function getGSDPlanDetail(folder, phaseDir) {
  const phaseFullDir = path.join(folder, '.planning', 'phases', phaseDir);
  if (!fs.existsSync(phaseFullDir)) return null;

  let files;
  try { files = fs.readdirSync(phaseFullDir).filter(f => f.match(/PLAN\.md$/i)).sort(); }
  catch { return null; }
  if (files.length === 0) return null;

  const sections = [];
  const allTasks = [];

  for (const f of files) {
    const content = readFileSafe(path.join(phaseFullDir, f));
    if (!content) continue;
    sections.push(`## ${f}\n\n${content}`);
    const { tasks } = parseCheckboxes(content);
    allTasks.push(...tasks);
  }

  return { content: sections.join('\n\n---\n\n'), tasks: allTasks };
}

module.exports = {
  name,
  labels,
  getGSDProjects,
  getGSDPhases,
  getGSDPlanDetail,
};
