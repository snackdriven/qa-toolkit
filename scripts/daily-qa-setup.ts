#!/usr/bin/env tsx

/**
 * Automated Daily QA Setup
 *
 * Fetches assigned QA tickets from Jira, sends parent ticket data to Claude
 * for AC atomization + LOE analysis, and generates HTML test plans.
 *
 * Usage:
 *   npx tsx daily-qa-setup.ts [date] [options]
 *
 * Options:
 *   --date YYYY-MM-DD   Override date (default: today)
 *   --dry-run           Fetch + analyze but don't write HTML
 *   --fresh             Ignore saved state, start from scratch
 *   --from-state        Skip Jira + Claude, regenerate HTML from existing state
 *   --quiet             Suppress progress logs (errors still shown)
 *   --open              Open browser after generating
 *   --ticket KEY        Analyze a specific parent ticket (bypasses JQL search)
 *
 * Required env vars (in .env or exported):
 *   JIRA_EMAIL        Your Jira login email
 *   JIRA_API_TOKEN    Jira API token (generate at id.atlassian.com/manage-profile/security)
 *   JIRA_BASE_URL     e.g. https://yourcompany.atlassian.net
 *   ANTHROPIC_API_KEY Your Anthropic API key
 *
 * Optional env vars:
 *   QA_OUTPUT_DIR     Where to write HTML files (default: ./qa-output)
 *   JIRA_LABEL        Label shown in the HTML header (e.g. "Sprint 42")
 */

import 'dotenv/config';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// ========================================
// Types
// ========================================

interface CliOptions {
  date: string;
  dryRun: boolean;
  fresh: boolean;
  fromState: boolean;
  quiet: boolean;
  open: boolean;
  ticketKey?: string;
}

interface JiraSubtask {
  key: string;
  parentKey: string;
  status: string;
  summary: string;
  comments: JiraComment[];
}

interface JiraComment {
  author: string;
  created: string;
  body: string; // plain text extracted from ADF
}

interface ParentTicketData {
  key: string;
  summary: string;
  status: string;
  issuetype: string; // e.g. "Bug", "Story", "Task"
  priority: string; // e.g. "High", "Medium", "Low"
  description: string; // plain text
  acceptanceCriteria: string; // plain text from JIRA_FIELDS.acceptanceCriteria
  testCases: string; // plain text from JIRA_FIELDS.testCases
  developerNotes: string; // plain text from JIRA_FIELDS.developerNotes
  designsUrl: string; // JIRA_FIELDS.designs — Figma/design links
  estimatedPoints: number | null; // JIRA_FIELDS.estimatedPoints
  labels: string[];
  components: string[];
  fixVersions: string[];
  comments: JiraComment[];
  subtasks: Array<{ key: string; status: string; comments: JiraComment[] }>;
  jiraUpdated: string; // ISO timestamp from Jira, used for cache invalidation
}

interface AcItem {
  id: string;
  section: string;
  text: string;
}

interface TicketAnalysis {
  ticketKey: string;
  summary: string;
  loe: number;
  loeReasoning: string;
  isKickedBack: boolean;
  kickBackContext: string;
  contextNotes: string[];
  scopeExclusions: string[];
  acceptanceCriteria: AcItem[];
}

interface TestingOrderItem {
  ticketKey: string;
  reason: string;
  carryForward: string;
}

interface OverlapItem {
  tickets: string[];
  sharedContext: string;
  recommendation: string;
}

interface QaSetupResult {
  tickets: TicketAnalysis[];
  testingOrder: TestingOrderItem[];
  overlapAnalysis: OverlapItem[];
}

interface SetupState {
  phase: 'jira-fetch' | 'claude-analysis' | 'html-generation' | 'complete';
  date: string;
  subtasks?: JiraSubtask[];
  parents?: ParentTicketData[];
  analysis?: QaSetupResult;
  generatedFiles?: string[];
}

// ========================================
// Constants
// ========================================

const BASE_DIR = process.env.QA_OUTPUT_DIR ?? './qa-output';
const JIRA_LABEL = process.env.JIRA_LABEL ?? '';
const MODEL = 'claude-sonnet-4-6';

// ─── JIRA CONFIGURATION ────────────────────────────────────────────────────
// Adjust these constants to match your Jira instance.

/**
 * The base URL for Jira ticket links.
 * Format: https://<your-domain>.atlassian.net/browse/
 */
const JIRA_URL_BASE = `${stripTrailingSlash(process.env.JIRA_BASE_URL ?? 'https://yourcompany.atlassian.net')}/browse/`;

/**
 * Workflow statuses to include in the daily QA fetch.
 * Update these to match the status names in your Jira project.
 */
const QA_STATUSES = {
  active:   'QA Testing',    // ticket is actively being tested
  kickBack: 'QA Kick Back',  // ticket was sent back by QA for fixes
  ready:    'Ready for QA',  // ticket is queued and ready to start
} as const;

/**
 * Custom field IDs for your Jira instance.
 * To find yours: GET /rest/api/3/field on your Jira instance (returns all fields with IDs).
 * Alternatively, open a ticket in Jira, click "..." > "Export" > view the JSON.
 */
const JIRA_FIELDS = {
  acceptanceCriteria: 'customfield_10062', // Acceptance Criteria
  testCases:          'customfield_10064', // Test Cases / Test Steps
  designs:            'customfield_10066', // Designs / Figma links
  developerNotes:     'customfield_10039', // Developer Notes
  estimatedPoints:    'customfield_10024', // Estimated Story Points
} as const;
// ───────────────────────────────────────────────────────────────────────────

let quiet = false;
function log(...args: unknown[]): void {
  if (!quiet) console.log(...args);
}

// ========================================
// Utilities (self-contained, duplicated from other scripts)
// ========================================

function validateConfig(): void {
  const required = ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_BASE_URL', 'ANTHROPIC_API_KEY'];
  const missing = required.filter(k => !process.env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}\nAdd them to .env or export them.`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Environment variable ${name} is required. Add it to .env or export it.`);
  }
  return value.trim();
}

function buildAuthHeader(email: string, token: string): string {
  const credentials = Buffer.from(`${email}:${token}`).toString('base64');
  return `Basic ${credentials}`;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

async function fetchWithRetry(url: string, opts: RequestInit, retries = 3, timeoutMs = 30_000): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
        console.warn(`  ⚠ Rate limited — waiting ${retryAfter}s (attempt ${i + 1}/${retries})`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (res.ok || res.status < 500) return res;
      console.warn(`  ⚠ Request failed (${res.status}), attempt ${i + 1}/${retries}`);
    } catch (e) {
      clearTimeout(timer);
      if (i === retries - 1) throw e;
      console.warn(`  ⚠ Request error, attempt ${i + 1}/${retries}: ${(e as Error).message}`);
    }
    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error(`Max retries exceeded for ${url}`);
}

async function jiraFetch<T>(baseUrl: string, path: string, authHeader: string, query?: Record<string, string>): Promise<T> {
  const url = new URL(`${stripTrailingSlash(baseUrl)}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetchWithRetry(url.toString(), {
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Jira API error: ${response.status} ${response.statusText} — ${text.slice(0, 200)}`);
  }

  return (await response.json()) as T;
}

// ADF → plain text extraction (from update-ticket-log.cjs pattern)
function extractTextFromADF(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';

  const n = node as Record<string, unknown>;

  if (n.type === 'text') return (n.text as string) || '';
  if (n.type === 'mention') return '@user';
  if (n.type === 'emoji') {
    const attrs = n.attrs as Record<string, string> | undefined;
    return attrs?.shortName || ':emoji:';
  }
  if (n.type === 'hardBreak') return '\n';

  if (n.type === 'tableRow') {
    const cells = Array.isArray(n.content) ? n.content.map(extractTextFromADF).join(' | ') : '';
    return cells + '\n';
  }
  if (n.type === 'codeBlock') {
    const code = Array.isArray(n.content) ? n.content.map(extractTextFromADF).join('') : '';
    return '```\n' + code + '\n```\n';
  }
  if (n.type === 'blockquote') {
    const inner = Array.isArray(n.content) ? n.content.map(extractTextFromADF).join('') : '';
    return inner.split('\n').filter(Boolean).map(l => '> ' + l).join('\n') + '\n';
  }

  let text = '';
  if (Array.isArray(n.content)) {
    for (const child of n.content) {
      text += extractTextFromADF(child);
    }
  }

  // Add spacing for block elements
  if (['paragraph', 'heading', 'bulletList', 'orderedList'].includes(n.type as string) && text) {
    text += '\n';
  }
  if (n.type === 'listItem' && text) {
    text = '- ' + text;
  }

  return text;
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function loeBadgeClass(loe: number): string {
  if (loe <= 0.25) return 'simple';
  if (loe <= 0.5) return 'medium';
  if (loe <= 1) return 'complex';
  return 'epic';
}

function loeBadgeLabel(loe: number): string {
  if (loe <= 0.25) return 'Simple';
  if (loe <= 0.5) return 'Medium';
  if (loe <= 1) return 'Complex';
  return 'Epic';
}

// ========================================
// CLI parsing
// ========================================

function parseCli(args: string[]): CliOptions {
  const options: CliOptions = {
    date: new Date().toISOString().split('T')[0],
    dryRun: false,
    fresh: false,
    fromState: false,
    quiet: false,
    open: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--fresh') {
      options.fresh = true;
    } else if (arg === '--from-state') {
      options.fromState = true;
    } else if (arg === '--ticket') {
      const key = args[++i];
      if (!key || !/^[A-Z]+-\d+$/.test(key)) {
        throw new Error(`--ticket requires a valid parent ticket key (e.g. PROJ-1234). Use --help for usage.`);
      }
      options.ticketKey = key;
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
    } else if (arg === '--open') {
      options.open = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npx tsx scripts/daily-qa-setup.ts [date] [options]

Options:
  --dry-run           Fetch + analyze but don't write HTML
  --fresh             Ignore saved state, start from scratch
  --from-state        Skip Jira + Claude, regenerate HTML from existing state
  --ticket <key>      Analyze a specific parent ticket by key (bypasses JQL search)
  --open              Auto-open the main checklist in the default browser after generating
  -q, --quiet         Suppress progress output — only show the final file list
  -h, --help          Show this message

Env vars:
  QA_OUTPUT_DIR       Override output directory (default: ./qa-output)
  JIRA_LABEL          Environment label shown in HTML headers (e.g. "Sprint 42", "UAT")
  QA_LOE_WARN_HOURS   Warn if total LOE exceeds this many hours (default: 8)

Examples:
  npx tsx scripts/daily-qa-setup.ts
  npx tsx scripts/daily-qa-setup.ts 2026-03-05
  npx tsx scripts/daily-qa-setup.ts --dry-run
  npx tsx scripts/daily-qa-setup.ts --ticket PROJ-1234
  npx tsx scripts/daily-qa-setup.ts --open --quiet`);
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
        throw new Error(`Invalid date format "${arg}". Use YYYY-MM-DD.`);
      }
      options.date = arg;
    } else {
      throw new Error(`Unknown option "${arg}". Use --help for usage.`);
    }
  }

  return options;
}

// ========================================
// State management
// ========================================

function stateFilePath(date: string): string {
  return join(BASE_DIR, 'dailies', date, '.qa-setup-state.json');
}

function loadState(date: string): SetupState | null {
  const path = stateFilePath(date);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SetupState;
  } catch {
    return null;
  }
}

function saveState(state: SetupState): void {
  const dir = join(BASE_DIR, 'dailies', state.date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFilePath(state.date), JSON.stringify(state, null, 2));
}

// ========================================
// LOE history
// ========================================

function appendLoeHistory(date: string, tickets: TicketAnalysis[]): void {
  const entry = {
    date,
    tickets: tickets.map(t => ({ key: t.ticketKey, loe: t.loe, numACs: t.acceptanceCriteria.length })),
    totalLoe: tickets.reduce((sum, t) => sum + t.loe, 0),
  };
  const historyPath = join(BASE_DIR, 'loe-history.jsonl');
  appendFileSync(historyPath, JSON.stringify(entry) + '\n');
}

function printLoeHistorySummary(): void {
  const historyPath = join(BASE_DIR, 'loe-history.jsonl');
  if (!existsSync(historyPath)) return;
  try {
    const lines = readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-3).reverse().map(l => JSON.parse(l) as { date: string; totalLoe: number });
    if (recent.length === 0) return;
    const parts = recent.map(r => `${r.totalLoe} (${r.date})`);
    const avg = (recent.reduce((s, r) => s + r.totalLoe, 0) / recent.length).toFixed(2);
    console.log(`📊 Recent LOE: ${parts.join(', ')} — avg ${avg}/day\n`);
  } catch { /* best-effort */ }
}

// ========================================
// Jira data cache
// ========================================

interface JiraCacheEntry {
  updated: string;
  data: ParentTicketData;
}

function loadJiraCache(): Record<string, JiraCacheEntry> {
  const cachePath = join(BASE_DIR, '.jira-cache.json');
  if (!existsSync(cachePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, JiraCacheEntry>;
    // Prune entries older than 30 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const pruned: Record<string, JiraCacheEntry> = {};
    for (const [key, entry] of Object.entries(raw)) {
      if (new Date(entry.updated) > cutoff) pruned[key] = entry;
    }
    return pruned;
  } catch {
    return {};
  }
}

function saveJiraCache(cache: Record<string, JiraCacheEntry>): void {
  writeFileSync(join(BASE_DIR, '.jira-cache.json'), JSON.stringify(cache, null, 2));
}

// ========================================
// Phase 1: Jira fetch
// ========================================

type JiraSearchIssue = {
  key: string;
  fields: {
    parent?: { key: string };
    status: { name: string };
    summary: string;
    comment?: { comments: Array<{ author: { displayName: string }; created: string; body: unknown }> };
  };
};

async function* paginateJiraSearch(
  baseUrl: string,
  authHeader: string,
  jql: string,
  fields: string,
  pageSize = 50
): AsyncGenerator<JiraSearchIssue> {
  let startAt = 0;
  while (true) {
    const result = await jiraFetch<{ total: number; issues: JiraSearchIssue[] }>(
      baseUrl, '/rest/api/3/search/jql', authHeader,
      { jql, fields, maxResults: String(pageSize), startAt: String(startAt) }
    );
    yield* result.issues;
    startAt += result.issues.length;
    if (result.issues.length === 0 || startAt >= result.total) break;
  }
}

async function fetchQaSubtasks(baseUrl: string, authHeader: string): Promise<JiraSubtask[]> {
  // Get current user's accountId (Basic auth + currentUser() is unreliable)
  const myself = await jiraFetch<{ accountId: string }>(baseUrl, '/rest/api/3/myself', authHeader);
  const accountId = myself.accountId;
  log(`  ✓ Authenticated as ${accountId}`);

  const jql = `assignee = "${accountId}" AND status in ("${QA_STATUSES.active}", "${QA_STATUSES.kickBack}", "${QA_STATUSES.ready}") ORDER BY priority DESC`;

  const subtasks: JiraSubtask[] = [];
  for await (const issue of paginateJiraSearch(baseUrl, authHeader, jql, 'key,parent,status,summary,comment')) {
    if (!issue.fields.parent?.key) {
      console.warn(`  ⚠ Skipping ${issue.key} — no parent ticket`);
      continue;
    }
    const allComments = issue.fields.comment?.comments || [];
    const recentComments = allComments.slice(-5).map(c => ({
      author: c.author.displayName,
      created: c.created.split('T')[0],
      body: typeof c.body === 'string' ? c.body : extractTextFromADF(c.body).trim(),
    }));
    subtasks.push({
      key: issue.key,
      parentKey: issue.fields.parent.key,
      status: issue.fields.status.name,
      summary: issue.fields.summary,
      comments: recentComments,
    });
  }

  return subtasks;
}

async function fetchParentTickets(
  baseUrl: string,
  authHeader: string,
  subtasks: JiraSubtask[],
  fresh = false
): Promise<ParentTicketData[]> {
  const parentKeys = [...new Set(subtasks.map(s => s.parentKey))];
  const fullFields = [
    'summary', 'description', 'status', 'issuetype', 'priority',
    'labels', 'components', 'fixVersions', 'comment', 'updated',
    JIRA_FIELDS.acceptanceCriteria,
    JIRA_FIELDS.testCases,
    JIRA_FIELDS.designs,
    JIRA_FIELDS.developerNotes,
    JIRA_FIELDS.estimatedPoints,
  ].join(',');

  const cache = fresh ? {} : loadJiraCache();
  let cacheHits = 0;

  const results = await Promise.allSettled(
    parentKeys.map(async (parentKey): Promise<ParentTicketData> => {
      try {
        // Check cache validity with a lightweight updated-field fetch
        if (!fresh && cache[parentKey]) {
          const check = await jiraFetch<{ fields: { updated: string } }>(
            baseUrl, `/rest/api/3/issue/${parentKey}`, authHeader, { fields: 'updated' }
          );
          if (check.fields.updated === cache[parentKey].updated) {
            cacheHits++;
            return cache[parentKey].data;
          }
        }

        const result = await jiraFetch<{
          fields: {
            summary: string;
            description: unknown;
            status: { name: string };
            issuetype: { name: string };
            priority: { name: string };
            labels: string[];
            components: Array<{ name: string }>;
            fixVersions: Array<{ name: string }>;
            comment: { comments: Array<{ author: { displayName: string }; created: string; body: unknown }> };
            updated: string;
            [key: string]: unknown; // custom fields — accessed via JIRA_FIELDS constants
          };
        }>(baseUrl, `/rest/api/3/issue/${parentKey}`, authHeader, { fields: fullFields });

        const f = result.fields;
        const description = extractTextFromADF(f.description).trim();
        const acceptanceCriteria = extractTextFromADF(f[JIRA_FIELDS.acceptanceCriteria]).trim();
        const allComments = f.comment?.comments || [];
        const recentComments = allComments.slice(-5).map(c => ({
          author: c.author.displayName,
          created: c.created.split('T')[0],
          body: typeof c.body === 'string' ? c.body : extractTextFromADF(c.body).trim(),
        }));

        const data: ParentTicketData = {
          key: parentKey,
          summary: f.summary,
          status: f.status.name,
          issuetype: f.issuetype?.name ?? 'Story',
          priority: f.priority?.name ?? 'Medium',
          description,
          acceptanceCriteria,
          testCases: extractTextFromADF(f[JIRA_FIELDS.testCases]).trim(),
          developerNotes: extractTextFromADF(f[JIRA_FIELDS.developerNotes]).trim(),
          designsUrl: extractTextFromADF(f[JIRA_FIELDS.designs]).trim(),
          estimatedPoints: (f[JIRA_FIELDS.estimatedPoints] as number | null) ?? null,
          labels: f.labels || [],
          components: (f.components || []).map(c => c.name),
          fixVersions: (f.fixVersions || []).map(v => v.name),
          comments: recentComments,
          subtasks: subtasks.filter(s => s.parentKey === parentKey).map(s => ({ key: s.key, status: s.status, comments: s.comments })),
          jiraUpdated: f.updated,
        };

        cache[parentKey] = { updated: f.updated, data };
        return data;
      } catch (e) {
        throw { parentKey, error: e };
      }
    })
  );

  const parents: ParentTicketData[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      parents.push(r.value);
    } else {
      const reason = r.reason as { parentKey?: string; error?: Error };
      console.warn(`  ⚠ Failed to fetch ${reason.parentKey ?? 'unknown'} — ${reason.error?.message ?? String(r.reason)}`);
    }
  }

  if (parents.length === 0) throw new Error('All parent ticket fetches failed.');

  saveJiraCache(cache);
  if (cacheHits > 0) console.log(`  ✓ Using cached data for ${cacheHits} ticket(s)`);

  return parents;
}

// ========================================
// Phase 2: Claude analysis
// ========================================

const SYSTEM_PROMPT = `You are a QA test plan generator for a SaaS application.
You receive Jira parent ticket data and produce structured analysis for daily QA setup.

<rules>
<ac_atomization>
Split acceptance criteria into atomic, independently testable clauses. One verifiable condition = one AC.

Splitting rules:
- "Add X and Y" → separate ACs for X and Y (field existence, display, behavior — each is distinct)
- "IF A OR B THEN C" → 2 ACs: "IF A THEN C", "IF B THEN C"
- Lists of N items → N ACs, one per item
- Field existence vs field behavior → separate ACs
- Success state vs error state → separate ACs
- Different triggers for the same outcome → separate ACs per trigger
- Each role in RBAC rules → separate AC per role
- Date boundary logic → separate AC for each boundary (before/within/after)
- Multi-step flows → separate AC per step
- Negative conditions → always include ("NOT shown when...", "does NOT appear when...", "field is disabled when...")

NEVER write: "Fields display correctly" — name each field explicitly.
NEVER write: "Validation works as expected" — specify each validation rule as its own AC.
NEVER merge separate behaviors to reduce AC count.
NEVER invent requirements not stated in the ticket description or ACs.
</ac_atomization>

<loe_rubric>
LOE = COMPLEXITY, not AC count.
0.25 = Single page, 1-3 checks, no setup needed, obvious pass/fail
0.5  = Single page, 4-8 checks, minor setup, mostly straightforward navigation
1    = Multiple pages OR states, setup required, 8-15 checks, conditional logic
2    = Cross-page flows, extensive setup, 15+ checks, edge cases, multiple user roles

Factors that INCREASE LOE: state machines, date-dependent logic, role-based access control,
cross-page verification, test data setup requirements, conditional sub-states, environment-specific behavior.

Factors that do NOT increase LOE: AC count alone, simple field additions, cosmetic changes.
A ticket with 20 ACs that are all simple field-existence checks = 0.5 LOE.
A ticket with 6 ACs involving state machine transitions across 3 pages = 1 LOE.
</loe_rubric>

<kicked_back_detection>
A ticket is kicked back if: the subtask status is "QA Kick Back", OR comments indicate prior QA failure,
OR description references a previous test failure.
Set isKickedBack: true and populate kickBackContext with a 1-2 sentence summary of what failed and what was fixed.
Kicked-back tickets go first in testing order — they are usually fast rechecks of a specific known failure.
</kicked_back_detection>

<overlap_detection>
Look for shared work across all tickets in this batch:
- Same page or feature area → combine into one navigation/recording session
- Same test data needed → setup once, reuse across tickets
- Carry-forward: if testing ticket A creates state needed by ticket B, flag it explicitly
- Group by page to minimize context-switching during the QA session
</overlap_detection>

<testing_order>
Default priority:
1. Kicked-back tickets first (fast recheck of known failure scenario)
2. Setup tickets before their dependents (if A creates state for B, test A first)
3. Group by page/feature area (minimize navigation across the app)
4. High-LOE complex tickets last (freshest focus time for dense test work)
</testing_order>

<scope_parsing>
Read comments carefully — they often contain:
- Scope reductions ("descoped X for this sprint")
- Clarifications that change AC interpretation
- Blockers or known issues ("backend not ready, skip Y")
- Notes from PM or dev that override the written ACs

Capture these as contextNotes. If something is explicitly out of scope, add it to scopeExclusions.
</scope_parsing>

<common_mistakes>
- Merging ACs to reduce count ("fields display correctly") — always name each one explicitly
- Deriving LOE from AC count — complexity drives LOE, not quantity
- Ignoring comments — comments contain scope changes, clarifications, and blockers
- Adding invented requirements — only use what is in the ticket description and ACs
- Missing negation tests — if something should NOT appear, write that AC explicitly
- Assigning LOE 2 for any ticket with many ACs without checking if they are all simple
</common_mistakes>
</rules>

<example_1>
Input AC: "Add start and end date fields to the authorization section. When authorization status
is 'Received', validate that current date falls within the start/end range and remaining balance > 0."

Atomic ACs:
1. Start date field exists in authorization section
2. End date field exists in authorization section
3. Auth status = Received + current date within range → no billing flag raised
4. Auth status = Received + current date outside range → billing flag raised
5. Auth status = Received + remaining balance > 0 → no billing flag raised
6. Auth status = Received + remaining balance ≤ 0 → billing flag raised

LOE: 1 — multiple conditional states, cross-field validation, test data setup required
</example_1>

<example_2>
Input AC: "Add 'Last Updated By' to case header showing who last saved any section.
Field should update automatically when any section is saved. Should NOT appear on closed cases."

Atomic ACs:
1. 'Last Updated By' field is visible in case header on open cases
2. 'Last Updated By' displays the name of the user who most recently saved any section
3. Value updates when Demographics section is saved
4. Value updates when Clinical section is saved
5. 'Last Updated By' does NOT appear on closed cases

LOE: 0.5 — one page, clear behavior, minor setup. Closed-case check is a fast navigation step,
not a complex state machine. Despite 5 ACs, total test time is under 30 minutes.
</example_2>

<example_3>
Kicked-back scenario: Subtask is in "QA Kick Back". Dev comment: "Fixed null pointer on auth_status
field — null value no longer causes 500 error."

isKickedBack: true
kickBackContext: "Previously failed because auth_status = NULL threw a 500 error. Fix applied;
recheck that null auth_status no longer crashes and the page renders correctly."
Testing order: first — fast targeted recheck of the specific null case that was failing.
</example_3>`;

const qaSetupSchema = {
  type: 'object' as const,
  properties: {
    tickets: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          ticketKey: { type: 'string' as const },
          summary: { type: 'string' as const },
          loe: { type: 'number' as const, enum: [0.25, 0.5, 1, 2] },
          loeReasoning: { type: 'string' as const },
          isKickedBack: { type: 'boolean' as const },
          kickBackContext: { type: 'string' as const },
          contextNotes: { type: 'array' as const, items: { type: 'string' as const } },
          scopeExclusions: { type: 'array' as const, items: { type: 'string' as const } },
          acceptanceCriteria: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                id: { type: 'string' as const },
                section: { type: 'string' as const },
                text: { type: 'string' as const },
              },
              required: ['id', 'section', 'text'] as const,
              additionalProperties: false,
            },
          },
        },
        required: ['ticketKey', 'summary', 'loe', 'loeReasoning', 'isKickedBack',
                    'kickBackContext', 'contextNotes', 'scopeExclusions', 'acceptanceCriteria'] as const,
        additionalProperties: false,
      },
    },
    testingOrder: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          ticketKey: { type: 'string' as const },
          reason: { type: 'string' as const },
          carryForward: { type: 'string' as const },
        },
        required: ['ticketKey', 'reason', 'carryForward'] as const,
        additionalProperties: false,
      },
    },
    overlapAnalysis: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          tickets: { type: 'array' as const, items: { type: 'string' as const } },
          sharedContext: { type: 'string' as const },
          recommendation: { type: 'string' as const },
        },
        required: ['tickets', 'sharedContext', 'recommendation'] as const,
        additionalProperties: false,
      },
    },
  },
  required: ['tickets', 'testingOrder', 'overlapAnalysis'] as const,
  additionalProperties: false,
};

function buildUserPrompt(parents: ParentTicketData[]): string {
  const ticketXml = parents.map(p => {
    // Parent ticket comments: requirements context, scope changes, dev notes
    const commentsBlock = p.comments.length > 0
      ? `<comments recent="${p.comments.length}">\n${p.comments.map(c => `[${c.created} - ${escapeXml(c.author)}]: ${escapeXml(c.body)}`).join('\n')}\n</comments>`
      : '';

    // QA subtask comments: QA-side notes, issues found during testing, dev responses to QA
    // These inform context/kickback status but do NOT drive LOE or AC derivation
    const allSubtaskComments = p.subtasks.flatMap(s => s.comments);
    const qaNotesBlock = allSubtaskComments.length > 0
      ? `<qa_notes note="these are QA subtask comments — use for kickback context and QA notes only, not for LOE or AC derivation">\n${allSubtaskComments.map(c => `[${c.created} - ${escapeXml(c.author)}]: ${escapeXml(c.body)}`).join('\n')}\n</qa_notes>`
      : '';

    const acSource = p.acceptanceCriteria
      ? `<acceptance_criteria>\n${escapeXml(p.acceptanceCriteria)}\n</acceptance_criteria>`
      : `<acceptance_criteria source="description">\n${escapeXml(p.description)}\n</acceptance_criteria>`;

    const testCasesBlock = p.testCases ? `<test_cases>\n${escapeXml(p.testCases)}\n</test_cases>` : '';
    const devNotesBlock = p.developerNotes ? `<developer_notes>\n${escapeXml(p.developerNotes)}\n</developer_notes>` : '';
    const designsBlock = p.designsUrl ? `<designs>${escapeXml(p.designsUrl)}</designs>` : '';

    return `<ticket key="${p.key}" subtask="${p.subtasks[0]?.key || ''}" subtask_status="${escapeXml(p.subtasks[0]?.status || '')}">
<summary>${escapeXml(p.summary)}</summary>
<status>${escapeXml(p.status)}</status>
<issuetype>${escapeXml(p.issuetype)}</issuetype>
<priority>${escapeXml(p.priority)}</priority>
${p.estimatedPoints != null ? `<estimated_story_points>${p.estimatedPoints}</estimated_story_points>` : ''}
<labels>${escapeXml(p.labels.join(', ') || 'none')}</labels>
<components>${escapeXml(p.components.join(', ') || 'none')}</components>
<fix_versions>${escapeXml(p.fixVersions.join(', ') || 'none')}</fix_versions>
<description>
${escapeXml(p.description || '(no description)')}
</description>
${acSource}
${testCasesBlock}
${devNotesBlock}
${designsBlock}
${commentsBlock}
${qaNotesBlock}
</ticket>`;
  }).join('\n\n');

  return `<tickets>
${ticketXml}
</tickets>

<task>
For each ticket above, produce:
1. Atomic acceptance criteria (split every compound condition)
2. LOE score with reasoning
3. Context notes (scope changes from comments, special setup needs)
4. Scope exclusions (anything explicitly out of scope)
5. Whether this is a kicked-back ticket needing recheck

Then produce an overall testing order and overlap analysis across all tickets.
</task>`;
}

function validateQaSetupResult(data: unknown): QaSetupResult {
  if (!data || typeof data !== 'object') throw new Error('Claude returned non-object result');
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.tickets)) throw new Error('Claude result missing tickets array');
  if (!Array.isArray(d.testingOrder)) throw new Error('Claude result missing testingOrder array');
  if (!Array.isArray(d.overlapAnalysis)) throw new Error('Claude result missing overlapAnalysis array');
  for (const t of d.tickets as unknown[]) {
    const ticket = t as Record<string, unknown>;
    if (!ticket.ticketKey || typeof ticket.loe !== 'number') {
      throw new Error(`Invalid ticket entry: ${JSON.stringify(ticket).slice(0, 100)}`);
    }
    if (!ticket.summary || !ticket.loeReasoning || !Array.isArray(ticket.acceptanceCriteria)) {
      throw new Error(`Incomplete ticket entry for ${ticket.ticketKey}: missing summary, loeReasoning, or acceptanceCriteria`);
    }
  }
  return data as QaSetupResult;
}

async function runClaudeAnalysis(parents: ParentTicketData[]): Promise<QaSetupResult> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const userPrompt = buildUserPrompt(parents);

  log(`  → Sending ${parents.length} ticket(s) to ${MODEL}...`);

  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16384,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
      tools: [{
        name: 'report_qa_analysis',
        description: 'Return structured QA setup analysis',
        input_schema: qaSetupSchema,
      }],
      tool_choice: { type: 'tool', name: 'report_qa_analysis' },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Claude API error: ${response.status} — ${errorText.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string; input?: unknown; name?: string }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    stop_reason?: string;
  };

  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude response truncated (hit max_tokens). Try reducing ticket count or increasing max_tokens.');
  }

  if (data.usage) {
    const { input_tokens, output_tokens } = data.usage;
    const cacheRead = data.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = data.usage.cache_creation_input_tokens ?? 0;
    const cost = (
      (input_tokens * 3 + output_tokens * 15 + cacheWrite * 3.75 + cacheRead * 0.30) / 1_000_000
    ).toFixed(4);
    const cacheInfo = cacheRead > 0 ? ` (${cacheRead} cached)` : cacheWrite > 0 ? ` (cache written)` : '';
    console.log(`  ✓ Claude: ${input_tokens} in / ${output_tokens} out (~$${cost}${cacheInfo})`);
  }

  const toolBlock = data.content?.find(c => c.type === 'tool_use');
  if (!toolBlock?.input) throw new Error('Claude returned no tool_use block');
  return validateQaSetupResult(toolBlock.input);
}

// ========================================
// Phase 3: HTML generation
// ========================================

function generateSharedCSS(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.6; color: #ECEFF4; background: #2E3440; padding: 20px;
    }
    .container {
      max-width: 1400px; margin: 0 auto; background: #1e1e2e;
      padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.4);
    }
    .header { border-bottom: 2px solid #89b4fa; padding-bottom: 20px; margin-bottom: 30px; }
    h1 { color: #89dceb; font-size: 28px; margin-bottom: 10px; }
    h2 { color: #89b4fa; font-size: 18px; margin-bottom: 15px; padding-bottom: 10px;
      border-bottom: 1px solid #313244; cursor: pointer; display: flex;
      align-items: center; gap: 10px; user-select: none; }
    h2:hover { color: #74c7ec; }
    h3 { color: #ffffff; font-size: 16px; margin: 20px 0 15px 0; }
    a { color: #89b4fa; text-decoration: none; }
    a:hover { color: #b4befe; text-decoration: underline; }
    .summary {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 15px; margin: 20px 0;
    }
    .summary-card {
      background: #313244; padding: 15px; border-radius: 6px; border-left: 3px solid #89b4fa;
    }
    .summary-label {
      color: #9ca3af; font-size: 12px; text-transform: uppercase; font-weight: 600; margin-bottom: 5px;
    }
    .summary-value { color: #ECEFF4; font-size: 24px; font-weight: 700; }
    .progress-bar {
      width: 100%; height: 10px; background: #313244; border-radius: 5px;
      margin: 20px 0; overflow: hidden;
    }
    .progress-fill {
      height: 100%; background: linear-gradient(90deg, #89b4fa, #74c7ec);
      width: 0%; transition: width 0.3s ease;
    }
    .progress-text { text-align: center; color: #9ca3af; font-size: 14px; margin-top: 5px; }
    .ticket {
      background: #313244; border: 1px solid #3a3a3a; border-radius: 6px;
      padding: 20px; margin-bottom: 20px;
    }
    .ticket-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
    .ticket-title { display: flex; align-items: center; gap: 10px; }
    .ticket-checkbox { width: 24px; height: 24px; cursor: pointer; }
    .ticket-key { font-weight: 700; color: #89b4fa; font-size: 16px; text-decoration: none; }
    .ticket-key:hover { color: #b4befe; text-decoration: underline; }
    .ticket-summary { color: #ECEFF4; font-size: 16px; }
    .badge { padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .badge.simple { background: #a6e3a1; color: #1e1e2e; }
    .badge.medium { background: #f9e2af; color: #1e1e2e; }
    .badge.complex { background: #fab387; color: #1e1e2e; }
    .badge.epic { background: #f38ba8; color: #1e1e2e; }
    .badge.kicked-back { background: #f38ba8; color: #1e1e2e; }
    .badge.testing { background: #89b4fa; color: #1e1e2e; }
    .ticket-meta { display: flex; gap: 15px; margin-top: 10px; font-size: 14px; color: #9ca3af; flex-wrap: wrap; }
    .ticket-link { color: #89b4fa; text-decoration: none; font-size: 14px; margin-top: 10px; display: inline-block; }
    .ticket-link:hover { text-decoration: underline; }
    .test-item {
      background: #313244; padding: 15px; margin-bottom: 12px;
      border-radius: 6px; border-left: 3px solid #89b4fa;
    }
    .test-item.completed { border-left-color: #a6e3a1; opacity: 0.7; }
    .test-checkbox { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; }
    input[type="checkbox"] { margin-top: 4px; width: 18px; height: 18px; cursor: pointer; flex-shrink: 0; }
    .test-label { flex: 1; color: #ECEFF4; }
    .test-details { margin-top: 10px; padding-left: 30px; color: #9ca3af; font-size: 14px; }
    .note { background: #313244; padding: 12px; border-radius: 4px; margin-top: 10px; border-left: 3px solid #cba6f7; font-size: 14px; color: #9ca3af; }
    .warning { background: #313244; padding: 12px; border-radius: 4px; margin-top: 10px; border-left: 3px solid #f9e2af; font-size: 14px; color: #f9e2af; }
    .info-box { background: #313244; padding: 15px; border-radius: 6px; margin: 15px 0; border-left: 3px solid #89b4fa; }
    .overlap-box { background: #313244; padding: 15px; border-radius: 6px; margin: 15px 0; border-left: 3px solid #74c7ec; }
    .collapse-icon { font-size: 16px; transition: transform 0.3s ease; }
    .collapse-icon.collapsed { transform: rotate(-90deg); }
    .section-content { transition: max-height 0.3s ease, opacity 0.3s ease; overflow: hidden; }
    .section-content.collapsed { max-height: 0; opacity: 0; }
    .section { margin-bottom: 30px; }
    .meta { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 15px; }
    .link-section { background: #313244; padding: 15px; border-radius: 6px; margin-top: 20px; }
    .overview-box { background: #313244; padding: 15px; border-radius: 6px; margin-bottom: 20px; border-left: 3px solid #89b4fa; }
    .test-note {
      display: block; width: 100%; background: transparent; border: none;
      border-top: 1px solid #45475a; color: #9ca3af; font-size: 13px;
      font-family: inherit; padding: 8px 0 0 30px; resize: none;
      overflow: hidden; margin-top: 6px; transition: color 0.2s, border-color 0.2s;
      line-height: 1.5;
    }
    .test-note:focus { outline: none; color: #ECEFF4; border-top-color: #89b4fa; }
    .test-note::placeholder { color: #585b70; }
    .action-btn {
      padding: 7px 14px; background: #313244; border: 1px solid #45475a;
      border-radius: 6px; cursor: pointer; font-size: 13px; font-family: inherit;
      transition: border-color 0.15s, color 0.15s;
    }
    .action-btn:hover { border-color: #89b4fa; color: #89b4fa; }
    .copy-btn { color: #89b4fa; border-color: #89b4fa; }
    .copy-btn:hover { background: #1e3a5f; }
    .copy-output {
      display: none; margin-top: 10px; background: #1e1e2e; padding: 12px;
      border-radius: 6px; font-size: 12px; white-space: pre-wrap; color: #ECEFF4;
      border: 1px solid #45475a; font-family: 'SF Mono', 'Fira Code', monospace;
    }
    @media print {
      body { background: white; color: black; padding: 0; }
      .container { box-shadow: none; max-width: 100%; padding: 15px; }
      .progress-bar, .progress-text { display: none; }
      .test-item.completed { opacity: 1; }
      input[type="checkbox"] { appearance: auto; }
      a { color: black; text-decoration: underline; }
      .badge { border: 1px solid currentColor; background: transparent !important; color: black !important; }
      .test-note { border: 1px solid #ccc; padding: 4px; color: black; border-top-width: 1px; }
      .action-btn, .copy-output { display: none !important; }
      h1, h2, h3 { color: black !important; }
      .ticket, .test-item, .info-box, .overlap-box, .overview-box, .note, .warning { background: white !important; border-color: #ccc !important; }
      .ticket-key, a { color: black !important; }
    }`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ticketUrl(key: string): string {
  return `${JIRA_URL_BASE}${key}`;
}

function generateMainChecklist(date: string, analysis: QaSetupResult, parents: ParentTicketData[], relativePaths = false, sharedCss = ''): string {
  const totalTickets = analysis.tickets.length;
  const totalLoe = analysis.tickets.reduce((sum, t) => sum + t.loe, 0);
  const formattedDate = formatDate(date);

  // Build fix version display
  const allVersions = [...new Set(parents.flatMap(p => p.fixVersions))];
  const versionDisplay = allVersions.length > 0 ? allVersions[0] : 'TBD';

  // Ticket cards
  const ticketCards = analysis.testingOrder.map((order, idx) => {
    const ticket = analysis.tickets.find(t => t.ticketKey === order.ticketKey);
    if (!ticket) return '';

    const parent = parents.find(p => p.subtasks.some(s => s.key === ticket.ticketKey) || p.key === ticket.ticketKey);
    const parentKey = parent?.key || '';
    const acCount = ticket.acceptanceCriteria.length;

    const kickedBadge = ticket.isKickedBack
      ? `<span class="badge kicked-back">Kicked Back</span>` : '';
    const loeBadge = `<span class="badge ${loeBadgeClass(ticket.loe)}">${loeBadgeLabel(ticket.loe)} (${ticket.loe})</span>`;

    const carryNote = order.carryForward
      ? `<div style="margin-top: 8px; padding: 8px; background: #1e1e2e; border-radius: 4px; border-left: 2px solid #74c7ec; font-size: 13px; color: #74c7ec;">↪ Carry forward: ${escapeHtml(order.carryForward)}</div>`
      : '';

    return `
        <div class="ticket">
          <div class="ticket-header">
            <div class="ticket-title">
              <input type="checkbox" class="ticket-checkbox" data-ticket="${ticket.ticketKey}">
              <a href="${ticketUrl(ticket.ticketKey)}" class="ticket-key" target="_blank">${ticket.ticketKey}</a>
              <span class="ticket-summary">${escapeHtml(ticket.summary)}</span>
            </div>
            ${loeBadge} ${kickedBadge}
          </div>
          <div class="ticket-meta">
            <span>📋 Parent: <a href="${ticketUrl(parentKey)}" target="_blank">${parentKey}</a></span>
            <span>✅ ${acCount} ACs</span>
            <span>📊 #${idx + 1} in order — ${escapeHtml(order.reason)}</span>
            <span data-ac-progress="${ticket.ticketKey}" style="display: none; color: #a6e3a1; font-size: 13px;"></span>
          </div>
          ${carryNote}
          <a href="${relativePaths ? '' : `dailies/${date}/`}${ticket.ticketKey}-qa-ticket.html" class="ticket-link" target="_blank">📝 View Test Plan</a>
        </div>`;
  }).join('\n');

  // Overlap section
  const overlapHtml = analysis.overlapAnalysis.length > 0
    ? analysis.overlapAnalysis.map(o => `
        <div class="overlap-box">
          <strong style="color: #74c7ec;">🔗 ${o.tickets.map(t => `<a href="${ticketUrl(t)}" target="_blank">${t}</a>`).join(' + ')}</strong>
          <div style="margin-top: 8px; color: #9ca3af;">${escapeHtml(o.sharedContext)}</div>
          <div style="margin-top: 5px; color: #a6e3a1; font-size: 14px;">💡 ${escapeHtml(o.recommendation)}</div>
        </div>`).join('\n')
    : '<p style="color: #9ca3af;">No overlaps detected.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QA Testing Checklist - ${formattedDate}</title>
  <style>${sharedCss || generateSharedCSS()}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎯 QA Testing Checklist - ${formattedDate}${JIRA_LABEL ? ` <span class="badge" style="font-size: 14px; padding: 4px 10px; margin-left: 8px; vertical-align: middle;">${escapeHtml(JIRA_LABEL)}</span>` : ''}</h1>
      <p style="color: #9ca3af;">Auto-generated daily QA setup</p>
      <div style="margin-top: 12px;">
        <button onclick="window.print()" class="action-btn" style="color: #9ca3af;">Print</button>
      </div>
    </div>

    <div class="summary">
      <div class="summary-card">
        <div class="summary-label">Total Tickets</div>
        <div class="summary-value">${totalTickets}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">Total LOE</div>
        <div class="summary-value">${totalLoe}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">Target</div>
        <div class="summary-value">${escapeHtml(versionDisplay)}</div>
      </div>
    </div>

    <div class="progress-bar">
      <div class="progress-fill" id="progressBar"></div>
    </div>
    <div class="progress-text" id="progressText">0 of ${totalTickets} tickets completed (0%)</div>

    ${analysis.overlapAnalysis.length > 0 ? `
    <div style="margin: 20px 0;">
      <h3 style="color: #74c7ec; margin-bottom: 10px;">🔗 Overlap Analysis</h3>
      ${overlapHtml}
    </div>` : ''}

    <div class="tickets">
      ${ticketCards}
    </div>
  </div>

  <script>
    const QA_DATE = '${date}';

    function loadState() {
      const checkboxes = document.querySelectorAll('.ticket-checkbox');
      checkboxes.forEach(checkbox => {
        const ticketId = checkbox.dataset.ticket;
        const isChecked = localStorage.getItem('ticket-' + QA_DATE + '-' + ticketId) === 'true';
        checkbox.checked = isChecked;
      });
      updateProgress();
    }

    function saveState(ticketId, isChecked) {
      localStorage.setItem('ticket-' + QA_DATE + '-' + ticketId, isChecked);
    }

    function updateProgress() {
      const checkboxes = document.querySelectorAll('.ticket-checkbox');
      const total = checkboxes.length;
      const completed = Array.from(checkboxes).filter(cb => cb.checked).length;
      const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
      document.getElementById('progressBar').style.width = percentage + '%';
      document.getElementById('progressText').textContent =
        completed + ' of ' + total + ' tickets completed (' + percentage + '%)';
      updateTabTitle(completed, total);
    }

    function updateTabTitle(completed, total) {
      document.title = completed === total && total > 0
        ? '✅ QA Done — ${formattedDate}'
        : completed + '/' + total + ' QA — ${formattedDate}';
    }

    document.querySelectorAll('.ticket-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', function() {
        saveState(this.dataset.ticket, this.checked);
        updateProgress();
      });
    });

    loadState();

    // Poll for AC progress updates when window is in background (cross-tab support, Chrome-primary)
    setInterval(() => { if (document.hidden) { refreshAcProgress(); } }, 10000);

    function getAcProgress(ticketKey) {
      const key = QA_DATE + '-' + ticketKey.toLowerCase() + '-test-progress';
      const saved = localStorage.getItem(key);
      if (!saved) return null;
      const progress = JSON.parse(saved);
      const keys = Object.keys(progress);
      const done = keys.filter(k => progress[k]).length;
      return { done, total: keys.length };
    }

    function refreshAcProgress() {
      document.querySelectorAll('[data-ac-progress]').forEach(el => {
        const ticketKey = el.dataset.acProgress;
        const prog = getAcProgress(ticketKey);
        if (prog && prog.total > 0) {
          el.textContent = '| ✅ ' + prog.done + '/' + prog.total + ' ACs';
          el.style.display = 'inline';
        }
      });
    }

    window.addEventListener('storage', refreshAcProgress);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshAcProgress();
    });
    refreshAcProgress();
  </script>
</body>
</html>`;
}

function generateTestPlan(
  date: string,
  ticket: TicketAnalysis,
  parent: ParentTicketData | undefined,
  sharedCss = ''
): string {
  const parentKey = parent?.key || '';
  const storageKey = `${date}-${ticket.ticketKey.toLowerCase()}`;

  const kickedBadge = ticket.isKickedBack
    ? `<span class="badge kicked-back">Kicked Back</span>` : '';

  // Context notes + scope exclusions (consolidated into single block)
  const contextParts: string[] = [];
  if (ticket.contextNotes.length > 0) {
    contextParts.push(`<strong>📌 Context:</strong> ${ticket.contextNotes.map(n => escapeHtml(n)).join('. ').replace(/\.\./g, '.')}`);
  }
  if (ticket.scopeExclusions.length > 0) {
    contextParts.push(`<strong>⚠️ Out of scope:</strong> ${ticket.scopeExclusions.map(e => escapeHtml(e)).join('. ').replace(/\.\./g, '.')}`);
  }
  const contextHtml = contextParts.length > 0
    ? `<div class="note" style="line-height: 1.8;">${contextParts.join('<br><br>')}</div>`
    : '';

  // Group ACs by section
  const sections = new Map<string, AcItem[]>();
  for (const ac of ticket.acceptanceCriteria) {
    const existing = sections.get(ac.section) || [];
    existing.push(ac);
    sections.set(ac.section, existing);
  }

  let testIdx = 0;
  const sectionHtml = [...sections.entries()].map(([sectionName, acs]) => {
    const items = acs.map(ac => {
      testIdx++;
      return `
          <div class="test-item">
            <label class="test-checkbox">
              <input type="checkbox" data-test-id="test-${testIdx}" data-ac-id="${escapeHtml(ac.id)}" data-ac-section="${escapeHtml(ac.section)}">
              <div class="test-label">
                ${escapeHtml(ac.text)}
              </div>
            </label>
            <textarea class="test-note" data-note-id="test-${testIdx}" rows="1"
              placeholder="Notes (bug ref, screenshot URL, edge case found...)"></textarea>
          </div>`;
    }).join('\n');

    return `<h3>${escapeHtml(sectionName)}</h3>\n${items}`;
  }).join('\n');

  const totalItems = testIdx;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${ticket.ticketKey}: ${escapeHtml(ticket.summary)} - QA Test Plan</title>
  <style>${sharedCss || generateSharedCSS()}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><a href="${ticketUrl(ticket.ticketKey)}" target="_blank" style="color: #89dceb; text-decoration: none;">${ticket.ticketKey}</a>: ${escapeHtml(ticket.summary)}</h1>
      <div class="meta">
        <span class="badge ${loeBadgeClass(ticket.loe)}">LOE ${ticket.loe} — ${loeBadgeLabel(ticket.loe)}</span>
        ${kickedBadge}
        <span class="badge testing">${escapeHtml(parent?.subtasks[0]?.status || QA_STATUSES.active)}</span>
        ${JIRA_LABEL ? `<span class="badge" style="padding: 4px 10px;">${escapeHtml(JIRA_LABEL)}</span>` : ''}
      </div>
      ${parent ? `
      <div style="margin-top: 15px; padding: 12px; background: #313244; border-radius: 6px;">
        <strong style="color: #a6e3a1;">Parent:</strong>
        <a href="${ticketUrl(parentKey)}" target="_blank">${parentKey}</a> — ${escapeHtml(parent.summary)}
        | <strong style="color: #89b4fa;">Status:</strong> ${escapeHtml(parent.status)}
      </div>` : ''}

      <div class="overview-box" style="margin-top: 15px;">
        <strong style="color: #89dceb;">LOE Reasoning:</strong> ${escapeHtml(ticket.loeReasoning)}
      </div>

      ${contextHtml}

      ${ticket.isKickedBack && ticket.kickBackContext ? `
      <div style="background: #313244; padding: 12px; border-radius: 4px; margin-top: 10px; border-left: 3px solid #f38ba8; font-size: 14px; color: #f38ba8;">
        🔄 <strong>Kicked back:</strong> ${escapeHtml(ticket.kickBackContext)}
      </div>` : ''}

      <div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
        <button id="copy-btn" class="action-btn copy-btn">Copy for Jira</button>
        <button onclick="window.print()" class="action-btn" style="color: #9ca3af;">Print</button>
      </div>
      <pre id="copy-output" class="copy-output"></pre>

      <div class="progress-bar">
        <div class="progress-fill" id="progressBar"></div>
      </div>
      <div class="progress-text" id="progressText">0 of ${totalItems} items completed (0%)</div>
    </div>

    <div class="section">
      <h2 onclick="toggleSection('scenarios')">
        <span class="collapse-icon" id="scenarios-icon">▼</span>
        🎯 Test Scenarios (${totalItems} checks)
      </h2>
      <div class="section-content" id="scenarios-content">
        ${sectionHtml}
      </div>
    </div>

    <div class="section">
      <h2 onclick="toggleSection('links')">
        <span class="collapse-icon" id="links-icon">▼</span>
        🔗 Related Links
      </h2>
      <div class="section-content" id="links-content">
        <div class="link-section">
          <strong>Jira:</strong><br>
          <a href="${ticketUrl(ticket.ticketKey)}" target="_blank">${ticket.ticketKey}: QA Ticket</a><br>
          ${parentKey ? `<a href="${ticketUrl(parentKey)}" target="_blank">${parentKey}: Parent Story</a><br>` : ''}
          <br>
          <strong>Main Checklist:</strong><br>
          <a href="testing-steps-${date}.html">Today's Testing Checklist →</a>
        </div>
      </div>
    </div>
  </div>

  <script>
    const STORAGE_KEY = '${storageKey}-test-progress';
    const NOTES_KEY = STORAGE_KEY + '-notes';
    const COLLAPSE_KEY = '${storageKey}-collapse';

    function toggleSection(sectionId) {
      const content = document.getElementById(sectionId + '-content');
      const icon = document.getElementById(sectionId + '-icon');
      const collapseState = loadCollapseState();
      if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        icon.classList.remove('collapsed');
        collapseState[sectionId] = false;
      } else {
        content.classList.add('collapsed');
        icon.classList.add('collapsed');
        collapseState[sectionId] = true;
      }
      saveCollapseState(collapseState);
    }

    function loadCollapseState() {
      const saved = localStorage.getItem(COLLAPSE_KEY);
      return saved ? JSON.parse(saved) : {};
    }
    function saveCollapseState(state) {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state));
    }

    function loadProgress() {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    }
    function saveProgress(progress) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    }

    function loadNotes() {
      const saved = localStorage.getItem(NOTES_KEY);
      return saved ? JSON.parse(saved) : {};
    }
    function saveNotes(notes) {
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
    }

    function updateProgressBar() {
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      const checked = document.querySelectorAll('input[type="checkbox"]:checked');
      const pct = checkboxes.length > 0 ? (checked.length / checkboxes.length) * 100 : 0;
      document.getElementById('progressBar').style.width = pct + '%';
      document.getElementById('progressText').textContent =
        checked.length + ' of ' + checkboxes.length + ' items completed (' + Math.round(pct) + '%)';
    }

    function buildJiraComment() {
      const date = new Date().toISOString().split('T')[0];
      const header = ${JSON.stringify(`*Test Plan: ${ticket.ticketKey} — ${ticket.summary}*`)};
      const lines = [header, 'Tested: ' + date, ''];
      let passed = 0, failed = 0, skipped = 0;

      document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        const acId = cb.dataset.acId || cb.dataset.testId;
        const section = cb.dataset.acSection || 'General';
        const labelEl = cb.closest('.test-checkbox') && cb.closest('.test-checkbox').querySelector('.test-label');
        const label = labelEl ? labelEl.textContent.trim() : '(unknown)';
        const noteEl = document.querySelector('[data-note-id="' + cb.dataset.testId + '"]');
        const note = noteEl && noteEl.value ? noteEl.value.trim() : '';

        let symbol;
        if (cb.checked) { symbol = '\\u2705'; passed++; }
        else if (note) { symbol = '\\u274C'; failed++; }
        else { symbol = '\\u2B1C'; skipped++; }

        lines.push(symbol + ' ' + acId + ' (' + section + '): ' + label);
        if (note) lines.push('   > ' + note);
      });

      lines.push('');
      const total = passed + failed + skipped;
      let summary = 'Result: ' + passed + '/' + total + ' passed';
      if (failed > 0) summary += ', ' + failed + ' failed';
      if (skipped > 0) summary += ', ' + skipped + ' skipped';
      lines.push(summary);
      return lines.join('\\n');
    }

    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      } else {
        fallbackCopy(text);
      }
    }

    function fallbackCopy(text) {
      const box = document.getElementById('copy-output');
      if (box) { box.textContent = text; box.style.display = 'block'; }
    }

    document.getElementById('copy-btn').addEventListener('click', () => {
      const text = buildJiraComment();
      copyToClipboard(text);
      const btn = document.getElementById('copy-btn');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    });

    function autoResizeTextarea(ta) {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    }

    function init() {
      const collapseState = loadCollapseState();
      const progress = loadProgress();
      const notes = loadNotes();
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');

      ['scenarios', 'links'].forEach(id => {
        if (collapseState[id]) {
          const c = document.getElementById(id + '-content');
          const i = document.getElementById(id + '-icon');
          if (c && i) { c.classList.add('collapsed'); i.classList.add('collapsed'); }
        }
      });

      checkboxes.forEach(checkbox => {
        const testId = checkbox.dataset.testId;
        if (progress[testId]) {
          checkbox.checked = true;
          checkbox.closest('.test-item').classList.add('completed');
        }
        checkbox.addEventListener('change', () => {
          const p = loadProgress();
          p[testId] = checkbox.checked;
          saveProgress(p);
          checkbox.closest('.test-item').classList.toggle('completed', checkbox.checked);
          updateProgressBar();
        });
      });

      document.querySelectorAll('.test-note').forEach(ta => {
        const noteId = ta.dataset.noteId;
        if (notes[noteId]) {
          ta.value = notes[noteId];
          autoResizeTextarea(ta);
        }
        ta.addEventListener('input', () => {
          autoResizeTextarea(ta);
          const n = loadNotes();
          n[noteId] = ta.value;
          saveNotes(n);
        });
      });

      updateProgressBar();
    }

    init();
  </script>
</body>
</html>`;
}

// ========================================
// Main orchestrator
// ========================================

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const { date, dryRun, fresh, fromState, ticketKey, open } = options;
  quiet = options.quiet;

  if (fresh && fromState) {
    throw new Error('--fresh and --from-state are mutually exclusive.');
  }

  if (!fromState) validateConfig();

  log(`\n🎯 Daily QA Setup — ${date}\n`);
  printLoeHistorySummary();

  const dailyDir = join(BASE_DIR, 'dailies', date);
  mkdirSync(dailyDir, { recursive: true });

  // Load or create state
  let state: SetupState | null = fresh ? null : loadState(date);

  // --from-state: just regenerate HTML
  if (fromState) {
    state = loadState(date);
    if (!state?.analysis) {
      throw new Error('No saved state with analysis found. Run without --from-state first.');
    }
    if (!state.parents) {
      throw new Error('State is missing parent ticket data. Re-run without --from-state to re-fetch Jira data.');
    }
    log('📄 Regenerating HTML from saved state...');
    const files = writeHtmlFiles(date, state.analysis, state.parents);
    state.phase = 'complete';
    state.generatedFiles = files;
    saveState(state);
    sendNotification('QA test plans ready', `${state.analysis.tickets.length} ticket(s) regenerated`);
    console.log(`\n✅ Done! ${files.length} files regenerated.`);
    files.forEach(f => console.log(`  → ${f}`));
    const fromStateLoe = state.analysis.tickets.reduce((sum, t) => sum + t.loe, 0);
    if (fromStateLoe > 6) {
      console.warn(`\n⚠ High LOE day: ${fromStateLoe} hours total.`);
    }
    if (open && files.length > 0) {
      const mainFile = files.find(f => f.includes('testing-steps-')) || files[0];
      try { execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [mainFile], { stdio: 'ignore' }); } catch { /* best-effort */ }
    }
    return;
  }

  // Phase 1: Jira fetch
  if (!state || state.phase === 'jira-fetch' || !state.subtasks) {
    log('📡 Phase 1: Fetching QA tickets from Jira...');
    const baseUrl = requireEnv('JIRA_BASE_URL');
    const authHeader = buildAuthHeader(requireEnv('JIRA_EMAIL'), requireEnv('JIRA_API_TOKEN'));

    let subtasks: JiraSubtask[];
    if (ticketKey) {
      log(`  → --ticket override: analyzing ${ticketKey} directly`);
      subtasks = [{ key: ticketKey, parentKey: ticketKey, status: QA_STATUSES.active, summary: '', comments: [] }];
    } else {
      subtasks = await fetchQaSubtasks(baseUrl, authHeader);
      log(`  ✓ Found ${subtasks.length} QA ticket(s)`);
    }

    if (subtasks.length === 0) {
      log('\n🎉 No QA tickets assigned today. Nothing to do.');
      sendNotification('No QA tickets today', `No tickets in ${QA_STATUSES.active} / ${QA_STATUSES.kickBack} / ${QA_STATUSES.ready}`);
      return;
    }

    log('  → Fetching parent tickets...');
    const parents = await fetchParentTickets(baseUrl, authHeader, subtasks, fresh);
    log(`  ✓ Fetched ${parents.length} parent ticket(s)`);

    state = { phase: 'claude-analysis', date, subtasks, parents };
    saveState(state);
  } else {
    log('📡 Phase 1: Skipped (using saved Jira data)');
  }

  // Phase 2: Claude analysis
  if (state.phase === 'claude-analysis' || !state.analysis) {
    log('\n🤖 Phase 2: Running Claude analysis...');
    const analysis = await runClaudeAnalysis(state.parents!);
    log(`  ✓ Analysis complete: ${analysis.tickets.length} ticket(s) analyzed`);

    state.analysis = analysis;
    state.phase = 'html-generation';
    saveState(state);

    if (dryRun) {
      console.log('\n📋 Dry run — analysis result:');
      console.log(JSON.stringify(analysis, null, 2));
      return;
    }
  } else {
    log('\n🤖 Phase 2: Skipped (using saved analysis)');
    if (dryRun) {
      console.log('\n📋 Dry run — saved analysis:');
      console.log(JSON.stringify(state.analysis, null, 2));
      return;
    }
  }

  // Phase 3: HTML generation
  log('\n📄 Phase 3: Generating HTML files...');
  const files = writeHtmlFiles(date, state.analysis!, state.parents!);

  state.phase = 'complete';
  state.generatedFiles = files;
  saveState(state);

  console.log(`\n✅ Done! Generated ${files.length} files:`);
  files.forEach(f => console.log(`  → ${f}`));

  const totalLoe = state.analysis!.tickets.reduce((sum, t) => sum + t.loe, 0);
  if (totalLoe > 6) {
    console.warn(`\n⚠ High LOE day: ${totalLoe} hours total.`);
  }

  if (open && files.length > 0) {
    const mainFile = files.find(f => f.includes('testing-steps-')) || files[0];
    try { execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [mainFile], { stdio: 'ignore' }); } catch { /* best-effort */ }
  }

  sendNotification('QA test plans ready', `${state.analysis!.tickets.length} ticket(s) — open testing-steps-${date}.html`);
}

function writeHtmlFiles(date: string, analysis: QaSetupResult, parents: ParentTicketData[]): string[] {
  const files: string[] = [];
  const dailyDir = join(BASE_DIR, 'dailies', date);
  mkdirSync(dailyDir, { recursive: true });

  const css = generateSharedCSS();

  // Main checklist (project root)
  const mainPath = join(BASE_DIR, `testing-steps-${date}.html`);
  writeFileSync(mainPath, generateMainChecklist(date, analysis, parents, false, css));
  files.push(mainPath);
  log(`  ✓ ${mainPath}`);

  // Also put a copy in dailies for archival (relative paths since test plans are in same dir)
  const dailyMainPath = join(dailyDir, `testing-steps-${date}.html`);
  writeFileSync(dailyMainPath, generateMainChecklist(date, analysis, parents, true, css));
  files.push(dailyMainPath);

  // Per-ticket test plans
  for (const ticket of analysis.tickets) {
    if (!/^[A-Z]+-\d+$/.test(ticket.ticketKey)) {
      console.warn(`  ⚠ Skipping ticket with invalid key "${ticket.ticketKey}" — possible state corruption`);
      continue;
    }
    const parent = parents.find(p => p.subtasks.some(s => s.key === ticket.ticketKey) || p.key === ticket.ticketKey);
    const planPath = join(dailyDir, `${ticket.ticketKey}-qa-ticket.html`);
    writeFileSync(planPath, generateTestPlan(date, ticket, parent, css));
    files.push(planPath);
    log(`  ✓ ${planPath}`);
  }

  appendLoeHistory(date, analysis.tickets);

  return files;
}

function sendNotification(title: string, message: string): void {
  if (process.platform !== 'darwin') return; // macOS only
  try {
    const safe = (s: string) => s.replace(/"/g, '\\"').replace(/[\r\n]/g, ' ').slice(0, 200);
    execFileSync('osascript', [
      '-e',
      `display notification "${safe(message)}" with title "${safe(title)}" sound name "Glass"`,
    ], { stdio: 'ignore' });
  } catch { /* best-effort */ }
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : 'Unexpected error';
  console.error(`\n❌ ${msg}`);
  sendNotification('Daily QA Setup Failed', msg.slice(0, 100));
  process.exit(1);
});
