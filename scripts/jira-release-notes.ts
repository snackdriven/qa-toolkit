#!/usr/bin/env tsx

/**
 * Jira Release Notes Generator
 *
 * Fetches all issues in a Jira release, categorizes them (features/bugs/breaking/other),
 * and outputs markdown. Optionally creates a day-before-release calendar event.
 *
 * Usage:
 *   npx tsx scripts/jira-release-notes.ts <release-url> [options]
 *
 * Options:
 *   --output <file>              Write to file instead of stdout
 *   --sections <list>            Comma-separated sections (features,fixes,breaking,other)
 *   --include-descriptions       Include issue descriptions in output
 *   --status <list>              Filter by status (Done,Closed)
 *   --format <json|markdown>     Output format (default: markdown)
 *   --create-calendar-event      Create day-before-release calendar event (requires GOOGLE_CALENDAR_TOKEN)
 *   --skip-calendar-event        Skip calendar event creation
 *
 * Requires: JIRA_EMAIL, JIRA_API_TOKEN
 * Optional: JIRA_BASE_URL, JIRA_PAGE_SIZE, GOOGLE_CALENDAR_TOKEN, WORK_CALENDAR_ID, CHECKLIST_PATH, TIMEZONE
 */

import 'dotenv/config';
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

interface CliOptions {
  releaseUrl?: string;
  output?: string;
  sections?: string[];
  includeDescriptions?: boolean;
  statusFilter?: string[];
  format: 'markdown' | 'json';
  pageSize?: number;
  createCalendarEvent?: boolean;
}

type JiraIssueFields = Record<string, unknown>

interface JiraReleaseVersion {
  id: string;
  name: string;
  description?: string;
  released: boolean;
  archived: boolean;
  releaseDate?: string;
  projectId?: string;
  projectKey?: string;
  url: string;
}

interface JiraIssueSummary {
  id: string;
  key: string;
  summary: string;
  status: string;
  issueType: string;
  priority?: string;
  url: string;
  description?: string;
  labels?: string[];
  components?: Array<{ name: string }>;
  estimatedStoryPoints?: number;
  actualStoryPoints?: number;
  additionalFields?: JiraIssueFields;
}

interface FetchReleaseIssuesResult {
  version: JiraReleaseVersion;
  issues: JiraIssueSummary[];
}

interface CategorizedIssues {
  features: JiraIssueSummary[];
  fixes: JiraIssueSummary[];
  breaking: JiraIssueSummary[];
  other: JiraIssueSummary[];
}

const DEFAULT_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'priority',
  'description',
  'labels',
  'components',
  'customfield_10024',  // Estimated Story Points
  'customfield_10367',  // Actual Story Points
];
const MAX_RESULTS_PER_REQUEST = 100;
const DEFAULT_SECTIONS = ['features', 'fixes', 'breaking', 'other'];

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));

  if (!options.releaseUrl) {
    printUsage();
    process.exit(1);
    return;
  }

  try {
    const result = await fetchReleaseIssues({
      releaseUrl: options.releaseUrl,
      additionalFields: ['description', 'labels'],
      pageSize: options.pageSize,
    });

    // Filter by status if specified
    let filteredIssues = result.issues;
    if (options.statusFilter && options.statusFilter.length > 0) {
      const statusFilter = options.statusFilter;
      filteredIssues = result.issues.filter((issue) =>
        statusFilter.includes(issue.status)
      );
    }

    const categorized = categorizeIssues(filteredIssues);

    if (options.format === 'json') {
      const output = {
        version: result.version,
        categorized,
        total: filteredIssues.length,
      };
      console.log(JSON.stringify(output, undefined, 2));
      return;
    }

    const markdown = generateMarkdown(
      result.version,
      categorized,
      options.sections || DEFAULT_SECTIONS,
      options.includeDescriptions || false
    );

    if (options.output) {
      await writeFile(options.output, markdown, 'utf-8');
      console.log(`[done] Release notes written to ${options.output}`);
    } else {
      console.log(markdown);
    }

    // Create calendar event for day before release (if enabled and release is in the future)
    const shouldCreateCalendarEvent = options.createCalendarEvent === true;
    if (shouldCreateCalendarEvent && result.version.releaseDate) {
      // Append local time component so YYYY-MM-DD parses as local midnight, not UTC midnight
      const releaseDate = new Date(result.version.releaseDate + 'T00:00:00');
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (releaseDate >= today) {
        try {
          await createDayBeforeReleaseEvent(result.version, filteredIssues.length);
          console.log(`[done] Calendar event created for day before release`);
        } catch (calError) {
          const err = calError as Error;
          console.warn(`[warn] Could not create calendar event: ${err.message}`);
          console.warn('   (Set GOOGLE_CALENDAR_TOKEN to enable calendar integration)');
        }
      }
    }
  } catch (error) {
    const err = error as Error & {
      response?: { status: number; statusText: string; data?: unknown };
    };
    console.error('[error] Failed to generate release notes.');
    if (err.response) {
      console.error(`HTTP ${err.response.status} ${err.response.statusText}`);
      if (err.response.data) {
        console.error(JSON.stringify(err.response.data, undefined, 2));
      }
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

function categorizeIssues(issues: JiraIssueSummary[]): CategorizedIssues {
  const result: CategorizedIssues = {
    features: [],
    fixes: [],
    breaking: [],
    other: [],
  };

  for (const issue of issues) {
    // Check for breaking changes first (via labels)
    const labels = issue.labels || [];
    if (labels.some((label) => /breaking/i.test(label))) {
      result.breaking.push(issue);
      continue;
    }

    // Categorize by issue type
    const type = issue.issueType.toLowerCase();
    if (type === 'story' || type === 'epic' || type === 'feature') {
      result.features.push(issue);
    } else if (type === 'bug' || type === 'defect') {
      result.fixes.push(issue);
    } else {
      result.other.push(issue);
    }
  }

  // Sort each category by priority (if available) then by key
  const priorityOrder: Record<string, number> = {
    highest: 0,
    high: 1,
    medium: 2,
    low: 3,
    lowest: 4,
  };

  const sortFn = (a: JiraIssueSummary, b: JiraIssueSummary) => {
    const aPriority = priorityOrder[a.priority?.toLowerCase() || ''] ?? 5;
    const bPriority = priorityOrder[b.priority?.toLowerCase() || ''] ?? 5;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    return a.key.localeCompare(b.key);
  };

  result.features.sort(sortFn);
  result.fixes.sort(sortFn);
  result.breaking.sort(sortFn);
  result.other.sort(sortFn);

  return result;
}

function generateMarkdown(
  version: JiraReleaseVersion,
  categorized: CategorizedIssues,
  sections: string[],
  includeDescriptions: boolean
): string {
  const lines: string[] = [];

  // Header
  const releaseDate = version.releaseDate || new Date().toISOString().split('T')[0];
  lines.push(`# Release: ${version.name} (${releaseDate})`);
  lines.push('');
  lines.push(`**Project:** ${version.projectKey || 'Unknown'}`);

  const totalIssues = Object.values(categorized).reduce((sum, arr) => sum + arr.length, 0);
  lines.push(`**Total Issues:** ${totalIssues}`);
  lines.push('');

  if (version.description) {
    lines.push(`**Description:** ${version.description}`);
    lines.push('');
  }

  // Table of contents
  lines.push('## Table of Contents');
  lines.push('');
  const sectionMeta: Record<string, { emoji: string; title: string; key: keyof CategorizedIssues }> = {
    features: { emoji: '', title: 'Features', key: 'features' },
    fixes: { emoji: '', title: 'Bug Fixes', key: 'fixes' },
    breaking: { emoji: '', title: 'Breaking Changes', key: 'breaking' },
    other: { emoji: '', title: 'Other Changes', key: 'other' },
  };

  for (const section of sections) {
    const meta = sectionMeta[section];
    if (!meta) continue;
    const count = categorized[meta.key].length;
    if (count > 0) {
      lines.push(`- [${meta.title}](#${meta.title.toLowerCase().replace(/\s+/g, '-')}) (${count})`);
    }
  }
  lines.push('');

  // Sections
  for (const section of sections) {
    const meta = sectionMeta[section];
    if (!meta) continue;
    const issues = categorized[meta.key];
    if (issues.length === 0) continue;

    lines.push(`## ${meta.title}`);
    lines.push('');

    for (const issue of issues) {
      lines.push(`- [${issue.key}](${issue.url}) ${issue.summary}`);

      if (includeDescriptions && issue.description) {
        const desc = issue.description.trim();
        if (desc) {
          // Indent description
          const descLines = desc.split('\n').map((line) => `  ${line}`);
          lines.push(...descLines);
        }
      }
    }
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push(`*Generated on ${new Date().toISOString().split('T')[0]}*`);

  return lines.join('\n');
}

function parseCli(args: string[]): CliOptions {
  const options: CliOptions = { format: 'markdown' };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (options.releaseUrl) {
        throw new Error(`Unexpected argument "${arg}". Only one release URL should be provided.`);
      }
      options.releaseUrl = arg;
      continue;
    }

    switch (arg) {
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      case '--output':
      case '-o':
        options.output = readStringArg(args, ++i, arg);
        break;
      case '--sections':
        options.sections = readStringArg(args, ++i, arg)
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        break;
      case '--include-descriptions':
        options.includeDescriptions = true;
        break;
      case '--create-calendar-event':
        options.createCalendarEvent = true;
        break;
      case '--skip-calendar-event':
        options.createCalendarEvent = false;
        break;
      case '--status':
        options.statusFilter = readStringArg(args, ++i, arg)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--format':
        options.format = readStringArg(args, ++i, arg).toLowerCase() as 'markdown' | 'json';
        if (!['markdown', 'json'].includes(options.format)) {
          throw new Error(`Invalid format "${options.format}". Use "markdown" or "json".`);
        }
        break;
      case '--page-size': {
        const pageSizeValue = Number.parseInt(readStringArg(args, ++i, arg), 10);
        if (Number.isNaN(pageSizeValue) || pageSizeValue < 1) {
          throw new Error('Page size must be a positive integer.');
        }
        options.pageSize = pageSizeValue;
        break;
      }
      default:
        throw new Error(`Unknown option "${arg}". Use --help for usage.`);
    }
  }

  return options;
}

function readStringArg(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`Expected a value after ${flag}.`);
  }
  return value;
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx scripts/jira-release-notes.ts <release-url> [options]

Options:
  --output, -o <file>          Write to file instead of stdout
  --sections <list>            Comma-separated sections (default: features,fixes,breaking,other)
  --include-descriptions       Include issue descriptions in output
  --status <list>              Filter by status (e.g., Done,Closed)
  --format <markdown|json>     Output format (default: markdown)
  --page-size <number>         Items per page when querying JIRA (default: 100)
  --create-calendar-event      Create day-before-release calendar event
  --skip-calendar-event        Skip calendar event creation
  -h, --help                   Show this message

Environment:
  JIRA_EMAIL, JIRA_API_TOKEN must be set. JIRA_BASE_URL overrides the host if needed.
  JIRA_PAGE_SIZE (optional) default page size for issue fetching (default: 100, max: 100).
  GOOGLE_CALENDAR_TOKEN (optional) enables day-before-release calendar events.
  WORK_CALENDAR_ID (optional) specifies work calendar (defaults to primary).
  CHECKLIST_PATH (optional) path to qa-release-checklist.md (defaults to cwd).

Examples:
  # Generate release notes to stdout
  npx tsx scripts/jira-release-notes.ts https://jira.example.com/projects/FOO/versions/12345

  # Write to file with descriptions
  npx tsx scripts/jira-release-notes.ts <url> --output RELEASE_NOTES.md --include-descriptions

  # Only features and fixes
  npx tsx scripts/jira-release-notes.ts <url> --sections features,fixes

  # Filter by status
  npx tsx scripts/jira-release-notes.ts <url> --status Done,Closed
`);
}

// ========================================
// JIRA API Functions
// ========================================

async function fetchReleaseIssues(options: {
  releaseUrl: string;
  additionalFields?: string[];
  pageSize?: number;
}): Promise<FetchReleaseIssuesResult> {
  const { releaseUrl, additionalFields, pageSize } = options;

  const email = requireEnv('JIRA_EMAIL');
  const apiToken = requireEnv('JIRA_API_TOKEN');

  const parsedUrl = parseReleaseUrl(releaseUrl);
  const versionId = extractVersionId(parsedUrl);
  const baseUrl = determineBaseUrl(parsedUrl);
  const authHeader = buildAuthHeader(email, apiToken);
  const resolvedPageSize = resolvePageSize(pageSize);

  const version = await fetchVersion({ baseUrl, versionId, releaseUrl, authHeader });
  const fields = buildFieldsParam(additionalFields);

  const issues = await fetchIssues({ baseUrl, versionId, fields, authHeader, pageSize: resolvedPageSize });

  return { version, issues };
}

function requireEnv(name: 'JIRA_EMAIL' | 'JIRA_API_TOKEN'): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Environment variable ${name} is required. Set it in your .env file or export it before running this script.`,
    );
  }
  return value.trim();
}

function parseReleaseUrl(candidate: string): URL {
  try {
    return new URL(candidate);
  } catch {
    throw new Error(`Invalid release URL provided: ${candidate}`);
  }
}

function extractVersionId(url: URL): string {
  const pathMatch = url.pathname.match(/\/versions\/(\d+)/);
  if (pathMatch) {
    return pathMatch[1];
  }

  const queryMatch = url.searchParams.get('selectedVersion');
  if (queryMatch && /^\d+$/.test(queryMatch)) {
    return queryMatch;
  }

  throw new Error('Unable to determine version id from the provided URL.');
}

function determineBaseUrl(releaseUrl: URL): string {
  const envBase = process.env.JIRA_BASE_URL?.trim();
  if (envBase) {
    return stripTrailingSlash(envBase);
  }
  return `${releaseUrl.protocol}//${releaseUrl.host}`;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function buildAuthHeader(email: string, token: string): string {
  const credentials = Buffer.from(`${email}:${token}`).toString('base64');
  return `Basic ${credentials}`;
}

function resolvePageSize(pageSize?: number): number {
  if (typeof pageSize === 'number' && Number.isFinite(pageSize)) {
    return clampPageSize(pageSize);
  }

  const fallback = process.env.JIRA_PAGE_SIZE;
  if (fallback) {
    const parsed = Number.parseInt(fallback, 10);
    if (!Number.isNaN(parsed)) {
      return clampPageSize(parsed);
    }
  }

  return MAX_RESULTS_PER_REQUEST;
}

function clampPageSize(candidate: number): number {
  if (candidate < 1) {
    return 1;
  }
  if (candidate > MAX_RESULTS_PER_REQUEST) {
    return MAX_RESULTS_PER_REQUEST;
  }
  return candidate;
}

async function fetchVersion(options: {
  baseUrl: string;
  versionId: string;
  releaseUrl: string;
  authHeader: string;
}): Promise<JiraReleaseVersion> {
  const { baseUrl, versionId, releaseUrl, authHeader } = options;
  const response = await jiraFetch<{
    id: string;
    name?: string;
    description?: string;
    released?: boolean;
    archived?: boolean;
    releaseDate?: string;
    projectId?: string | number;
    projectKey?: string;
  }>({
    baseUrl,
    path: `/rest/api/3/version/${versionId}`,
    authHeader,
  });

  return {
    id: response.id,
    name: response.name ?? '',
    description: response.description ?? undefined,
    released: Boolean(response.released),
    archived: Boolean(response.archived),
    releaseDate: response.releaseDate ?? undefined,
    projectId: response.projectId !== undefined ? String(response.projectId) : undefined,
    projectKey: response.projectKey ?? extractProjectKeyFromUrl(releaseUrl),
    url: releaseUrl,
  };
}

function extractProjectKeyFromUrl(releaseUrl: string): string | undefined {
  try {
    const parsed = new URL(releaseUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const index = parts.findIndex((segment) => segment === 'projects');
    if (index >= 0 && parts[index + 1]) {
      return parts[index + 1];
    }
  } catch {
    // ignore errors; project key is optional
  }
  return undefined;
}

async function fetchIssues(options: {
  baseUrl: string;
  versionId: string;
  fields: string;
  authHeader: string;
  pageSize: number;
}): Promise<JiraIssueSummary[]> {
  const { baseUrl, versionId, fields, authHeader, pageSize } = options;
  const jql = `fixVersion = ${versionId}`;

  const results: JiraIssueSummary[] = [];
  let startAt = 0;

  // Pagination loop: fetch until no more issues returned
  const MAX_PAGES = 100;
  let pageCount = 0;
  while (pageCount < MAX_PAGES) {
    pageCount++;
    const payload = await jiraFetch<{
      issues?: Array<{ id: string; key: string; fields?: JiraIssueFields }>;
      total?: number;
    }>({
      baseUrl,
      path: '/rest/api/3/search/jql',
      authHeader,
      query: {
        jql,
        fields,
        startAt: String(startAt),
        maxResults: String(pageSize),
      },
    });

    const issues = payload.issues ?? [];
    if (issues.length === 0) {
      break;
    }

    for (const issue of issues) {
      results.push(mapIssue(issue, baseUrl, fields));
    }

    startAt += issues.length;
    const total = payload.total ?? issues.length;
    if (startAt >= total) {
      break;
    }
  }

  return results;
}

function mapIssue(
  issue: { id: string; key: string; fields?: JiraIssueFields },
  baseUrl: string,
  fieldsParam: string
): JiraIssueSummary {
  const fields = (issue.fields ?? {}) as {
    summary?: string;
    issuetype?: { name?: string };
    status?: { name?: string };
    priority?: { name?: string };
    description?: string;
    labels?: string[];
    components?: Array<{ name?: string }>;
    customfield_10024?: number;
    customfield_10367?: number;
    [key: string]: unknown;
  };

  const additionalFields = collectAdditionalFields(fields, fieldsParam);

  return {
    id: issue.id,
    key: issue.key,
    summary: String(fields.summary ?? '').trim(),
    status: String(fields.status?.name ?? '').trim(),
    issueType: String(fields.issuetype?.name ?? '').trim(),
    priority:
      fields.priority && typeof fields.priority === 'object'
        ? String(fields.priority.name ?? '').trim() || undefined
        : undefined,
    url: `${stripTrailingSlash(baseUrl)}/browse/${issue.key}`,
    description: typeof fields.description === 'string' ? fields.description.trim() : undefined,
    labels: Array.isArray(fields.labels) ? fields.labels : undefined,
    components: Array.isArray(fields.components)
      ? fields.components.map(c => ({ name: String(c?.name ?? '') })).filter(c => c.name)
      : undefined,
    estimatedStoryPoints: typeof fields.customfield_10024 === 'number' ? fields.customfield_10024 : undefined,
    actualStoryPoints: typeof fields.customfield_10367 === 'number' ? fields.customfield_10367 : undefined,
    additionalFields: Object.keys(additionalFields).length > 0 ? additionalFields : undefined,
  };
}

function collectAdditionalFields(fields: Record<string, unknown>, fieldsParam: string): JiraIssueFields {
  const requested = new Set(
    fieldsParam
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean),
  );

  for (const defaultField of DEFAULT_FIELDS) {
    requested.delete(defaultField);
  }

  const additional: JiraIssueFields = {};
  for (const fieldName of Array.from(requested)) {
    if (fieldName in fields) {
      additional[fieldName] = fields[fieldName];
    }
  }
  return additional;
}

function buildFieldsParam(additionalFields?: string[]): string {
  const allFields = new Set(DEFAULT_FIELDS);
  if (additionalFields) {
    for (const field of additionalFields) {
      allFields.add(field);
    }
  }
  return Array.from(allFields).join(',');
}

async function jiraFetch<T>({
  baseUrl,
  path,
  authHeader,
  query,
}: {
  baseUrl: string;
  path: string;
  authHeader: string;
  query?: Record<string, string>;
}): Promise<T> {
  const url = new URL(`${stripTrailingSlash(baseUrl)}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    let data: unknown;

    try {
      data = contentType.includes('application/json') ? await response.json() : await response.text();
    } catch {
      data = undefined;
    }

    const error = new Error(`Jira request failed: ${response.status} ${response.statusText}`);
    (error as Error & { response?: { status: number; statusText: string; data?: unknown } }).response = {
      status: response.status,
      statusText: response.statusText,
      data,
    };
    throw error;
  }

  return (await response.json()) as T;
}

// ========================================
// Google Calendar Functions
// ========================================

const WORK_CALENDAR_ID = process.env.WORK_CALENDAR_ID || 'primary';
const DAY_BEFORE_CHECKLIST_PATH = process.env.CHECKLIST_PATH || join(process.cwd(), 'qa-release-checklist.md');

async function createDayBeforeReleaseEvent(version: JiraReleaseVersion, issueCount: number): Promise<void> {
  const token = process.env.GOOGLE_CALENDAR_TOKEN;
  if (!token || !token.trim()) {
    throw new Error('GOOGLE_CALENDAR_TOKEN environment variable not set');
  }

  if (!version.releaseDate) {
    throw new Error('Release version has no release date');
  }

  // Calculate day before release (event appears on day before)
  const releaseDate = new Date(version.releaseDate);
  const dayBefore = new Date(releaseDate);
  dayBefore.setDate(dayBefore.getDate() - 1);

  // Read day-before checklist
  const dayBeforeChecklist = await readDayBeforeChecklist();

  // Build event description
  const projectName = version.projectKey || 'Unknown';
  const eventSummary = `Day Before Release: ${projectName} ${releaseDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })}`;

  const description = `${dayBeforeChecklist}

## Release Info

- **Release Date**: ${releaseDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
- **Version**: ${version.name}
- **Issues**: ${issueCount} total

See: testing-steps-${projectName.toLowerCase()}-${releaseDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }).replace(/\//g, '-')}.md`;

  // Create all-day event (start at midnight, end at midnight next day)
  const startDateTime = formatDateForCalendar(dayBefore);
  const endDate = new Date(dayBefore);
  endDate.setDate(endDate.getDate() + 1);
  const endDateTime = formatDateForCalendar(endDate);

  await createGoogleCalendarEvent({
    calendarId: WORK_CALENDAR_ID,
    summary: eventSummary,
    description,
    startDateTime,
    endDateTime,
    token,
  });
}

async function readDayBeforeChecklist(): Promise<string> {
  try {
    const content = await readFile(DAY_BEFORE_CHECKLIST_PATH, 'utf-8');
    const lines = content.split('\n');
    const dayBeforeStart = lines.findIndex((line) => line.includes('## Day Before'));

    if (dayBeforeStart === -1) {
      return '## Day Before\n\n- [ ] Test the release\n- [ ] Run regression suite\n- [ ] Generate release notes';
    }

    // Extract lines from "## Day Before" until the next ## heading
    const dayBeforeSection: string[] = [];
    for (let i = dayBeforeStart; i < lines.length; i += 1) {
      const line = lines[i];
      if (i > dayBeforeStart && line.startsWith('## ')) {
        break;
      }
      dayBeforeSection.push(line);
    }

    return dayBeforeSection.join('\n').trim();
  } catch {
    // Fallback if file doesn't exist
    return '## Day Before\n\n- [ ] Test the release\n- [ ] Run regression suite\n- [ ] Generate release notes';
  }
}

function formatDateForCalendar(date: Date): string {
  // Date-only format for all-day events — avoids timezone offset issues
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface CreateCalendarEventOptions {
  calendarId: string;
  summary: string;
  description: string;
  startDateTime: string;
  endDateTime: string;
  token: string;
}

async function createGoogleCalendarEvent(options: CreateCalendarEventOptions): Promise<void> {
  const { calendarId, summary, description, startDateTime, endDateTime, token } = options;

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

  const eventData = {
    summary,
    description,
    start: {
      date: startDateTime,
    },
    end: {
      date: endDateTime,
    },
    reminders: {
      useDefault: true,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(eventData),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Calendar API error: ${response.status} ${response.statusText} - ${errorText}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unexpected error occurred.';
  if (message) {
    console.error(`[error] ${message}`);
  } else {
    console.error('[error] Unexpected error occurred.');
  }
  process.exit(1);
});
