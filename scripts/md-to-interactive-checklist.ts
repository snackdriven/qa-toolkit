#!/usr/bin/env tsx

/**
 * Markdown to interactive checklist converter
 *
 * Converts a markdown checklist to a self-contained HTML file.
 * Checkboxes, per-block progress, state persists in localStorage.
 * Set JIRA_BASE_URL or pass --jira-base-url to get clickable ticket links.
 *
 * Usage:
 *   npx tsx scripts/md-to-interactive-checklist.ts <markdown-file> [options]
 *
 * Options:
 *   --output <file>          Output HTML file (default: same name as input, .html extension)
 *   --no-jira-links          Disable automatic Jira ticket linking
 *   --jira-base-url <url>    Jira base URL for ticket links (e.g. https://yourco.atlassian.net)
 *                            Falls back to JIRA_BASE_URL env var
 *
 * Examples:
 *   npx tsx scripts/md-to-interactive-checklist.ts release-checklist.md
 *   npx tsx scripts/md-to-interactive-checklist.ts checklist.md --output out.html
 *   npx tsx scripts/md-to-interactive-checklist.ts checklist.md --no-jira-links
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import * as dotenv from 'dotenv';

dotenv.config();

interface CliOptions {
  inputFile: string;
  output?: string;
  noJiraLinks: boolean;
  jiraBaseUrl?: string;
}

interface ChecklistMetadata {
  title: string;
  release?: string;
  type?: string;
  estimatedTime?: string;
  totalTickets?: string;
}

interface ChecklistBlock {
  title: string;
  timeEstimate?: string;
  stopPoint?: string;
  sections: ChecklistSection[];
  quickTest?: string;
}

interface ChecklistSection {
  heading?: string;
  rows: ChecklistRow[];
}

interface ChecklistRow {
  feature: string;
  ticket: string;
  status: string;
}

interface FinalCheck {
  text: string;
}

interface ChecklistData {
  metadata: ChecklistMetadata;
  blocks: ChecklistBlock[];
  finalChecks: FinalCheck[];
  adhdTips: string[];
}

function parseCliArgs(): CliOptions {
  const { values, positionals } = parseArgs({
    options: {
      output: { type: 'string' },
      'no-jira-links': { type: 'boolean', default: false },
      'jira-base-url': { type: 'string' },
    },
    allowPositionals: true,
  });

  if (positionals.length === 0) {
    console.error('Error: No input file specified');
    console.error('Usage: npx tsx scripts/md-to-interactive-checklist.ts <markdown-file> [options]');
    process.exit(1);
  }

  return {
    inputFile: positionals[0],
    output: values.output as string | undefined,
    noJiraLinks: values['no-jira-links'] as boolean,
    jiraBaseUrl: (values['jira-base-url'] as string | undefined) || process.env.JIRA_BASE_URL,
  };
}

function parseMetadata(content: string): ChecklistMetadata {
  const lines = content.split('\n');
  const metadata: ChecklistMetadata = { title: '' };

  for (const line of lines) {
    if (line.startsWith('# ') && !metadata.title) {
      metadata.title = line.replace(/^#\s+/, '').trim();
    }
    const metaMatch = line.match(/\*\*(.+?):\*\*\s*(.+)/);
    if (metaMatch) {
      const [, key, value] = metaMatch;
      const cleanValue = value.trim();
      if (key.includes('Release')) metadata.release = cleanValue;
      else if (key.includes('Type')) metadata.type = cleanValue;
      else if (key.includes('Time')) metadata.estimatedTime = cleanValue;
      else if (key.includes('Tickets')) metadata.totalTickets = cleanValue;
    }
  }

  return metadata;
}

function parseBlocks(content: string): ChecklistBlock[] {
  const blocks: ChecklistBlock[] = [];
  const rawSections = content.split(/^## /m).filter(s => s.trim());

  for (const section of rawSections) {
    const lines = section.split('\n');
    const firstLine = lines[0];

    if (firstLine.includes('Final Checks') || firstLine.includes('ADHD Tips')) {
      continue;
    }

    const timeMatch = firstLine.match(/\((\d+\s*min)\)/);
    const timeEstimate = timeMatch ? timeMatch[1] : undefined;
    const cleanTitle = firstLine.replace(/\(.+?\)/, '').trim();

    const stopPointMatch = section.match(/\*\*STOP POINT\*\*[:\s]*\S*\s*(.+?)$/m);
    const stopPoint = stopPointMatch ? stopPointMatch[1].trim() : undefined;

    const quickTestMatch = section.match(/\*\*Quick test:\*\*\s*(.+?)$/m);
    const quickTest = quickTestMatch ? quickTestMatch[1].trim() : undefined;

    const sections = parseSections(section);

    if (sections.length === 0) continue;

    blocks.push({
      title: cleanTitle,
      timeEstimate,
      stopPoint,
      sections,
      quickTest,
    });
  }

  return blocks;
}

function parseSections(blockContent: string): ChecklistSection[] {
  const sections: ChecklistSection[] = [];
  const parts = blockContent.split(/^### /m).filter(s => s.trim());

  if (parts.length > 1) {
    for (let i = 1; i < parts.length; i++) {
      const lines = parts[i].split('\n');
      const heading = lines[0].trim();
      const rows = parseTableRows(parts[i]);
      if (rows.length > 0) {
        sections.push({ heading, rows });
      }
    }
  } else {
    const rows = parseTableRows(blockContent);
    if (rows.length > 0) {
      sections.push({ rows });
    }
  }

  return sections;
}

function parseTableRows(content: string): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  const lines = content.split('\n');

  let inTable = false;
  for (const line of lines) {
    if (line.includes('|') && line.includes('---')) {
      inTable = true;
      continue;
    }

    if (inTable && line.includes('|')) {
      const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell);
      if (cells.length >= 3) {
        rows.push({
          feature: cells[0],
          ticket: cells[1],
          status: cells[2],
        });
      }
    } else if (inTable && !line.includes('|')) {
      inTable = false;
    }
  }

  return rows;
}

function parseFinalChecks(content: string): FinalCheck[] {
  const checks: FinalCheck[] = [];
  const finalSection = content.match(/## .*?Final Checks([\s\S]+?)(?=##|$)/);

  if (finalSection) {
    const lines = finalSection[1].split('\n');
    for (const line of lines) {
      const match = line.match(/^-\s*\[\s*\]\s*\*\*(.+?)\*\*/);
      if (match) {
        checks.push({ text: match[1] });
      }
    }
  }

  return checks;
}

function parseAdhdTips(content: string): string[] {
  const tips: string[] = [];
  const tipsSection = content.match(/### .*?ADHD Tips([\s\S]+?)$/);

  if (tipsSection) {
    const lines = tipsSection[1].split('\n');
    for (const line of lines) {
      const match = line.match(/^-\s*(.+)/);
      if (match) {
        tips.push(match[1].trim());
      }
    }
  }

  return tips;
}

const emojiPattern = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;

function stripEmoji(text: string): string {
  return text.replace(emojiPattern, '').trim();
}

function linkifyJiraTickets(text: string, options: CliOptions): string {
  const cleanText = stripEmoji(text);

  if (options.noJiraLinks || !options.jiraBaseUrl) return cleanText;

  return cleanText.replace(/\b([A-Z]+-\d+)\b/g, (match) => {
    return `<a href="${options.jiraBaseUrl}/browse/${match}" class="ticket-link" target="_blank">${match}</a>`;
  });
}

function generateHtml(data: ChecklistData, options: CliOptions): string {
  const { metadata, blocks, finalChecks } = data;
  const storageKey = `checklist-${basename(options.inputFile)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${stripEmoji(metadata.title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;padding:30px;max-width:700px;margin:0 auto;background:linear-gradient(to bottom,#0a0010,#000000);min-height:100vh;color:#e0e0e0}
.header{margin-bottom:30px;padding:20px;background:#1a1a1a;border-radius:6px}
.header h1{font-size:1.4em;margin-bottom:10px;color:#fff;font-weight:600}
.meta{font-size:0.9em;color:#999}
.block{margin-bottom:30px;padding:20px;background:#1a1a1a;border-radius:6px;border:1px solid #2a2a2a}
.block-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #2a2a2a}
.block-title{font-size:1.1em;font-weight:600;color:#fff}
.block-progress{font-size:0.85em;color:#888;font-weight:500}
.ticket-group{margin-bottom:16px;padding:12px;background:#222;border-radius:4px}
.ticket-header{font-size:0.85em;color:#888;margin-bottom:10px;font-family:monospace;font-weight:500}
.item{display:flex;align-items:flex-start;gap:10px;padding:6px 0;font-size:0.95em}
.item input[type="checkbox"]{margin-top:2px;width:16px;height:16px;cursor:pointer;flex-shrink:0}
.item label{cursor:pointer;user-select:none}
.ticket-link{color:#6b9bd1;text-decoration:none}
.ticket-link:hover{text-decoration:underline}
.block-footer{margin-top:16px;padding-top:12px;border-top:1px solid #3a3a3a;font-size:0.9em;color:#888}
.done{opacity:0.3;text-decoration:line-through}
</style>
</head>
<body>

<div class="content">
<div class="header">
<h1>${stripEmoji(metadata.title)}</h1>
${metadata.release ? `<div class="meta">${metadata.release}${metadata.estimatedTime ? `  ${metadata.estimatedTime}` : ''}${metadata.totalTickets ? `  ${metadata.totalTickets} tickets` : ''}</div>` : ''}
</div>

${blocks.map((block, blockIdx) => {
  const ticketGroups = new Map<string, string[]>();
  block.sections.forEach(section => {
    section.rows.forEach(row => {
      if (!ticketGroups.has(row.ticket)) {
        ticketGroups.set(row.ticket, []);
      }
      ticketGroups.get(row.ticket)!.push(row.feature);
    });
  });

  const blockId = `block-${blockIdx}`;
  let itemCounter = 0;

  return `
<div class="block" id="${blockId}">
<div class="block-header">
<div class="block-title">${stripEmoji(block.title)}${block.timeEstimate ? ` (${block.timeEstimate})` : ''}</div>
<div class="block-progress" id="${blockId}-progress">0/0</div>
</div>

${Array.from(ticketGroups.entries()).map(([ticket, features]) => `
<div class="ticket-group">
<div class="ticket-header">${linkifyJiraTickets(ticket, options)}</div>
${features.map(feature => {
  const itemId = `item-${blockIdx}-${itemCounter++}`;
  return `
<div class="item">
<input type="checkbox" id="${itemId}" onchange="update()">
<label for="${itemId}">${linkifyJiraTickets(feature, options)}</label>
</div>
`;
}).join('')}
</div>
`).join('')}

${block.quickTest || block.stopPoint ? `<div class="block-footer">${block.quickTest ? `Test: ${block.quickTest}` : ''}${block.quickTest && block.stopPoint ? '  ' : ''}${block.stopPoint ? `Stop: ${block.stopPoint}` : ''}</div>` : ''}
</div>
`;
}).join('')}

${finalChecks.length > 0 ? `
<div class="block" id="block-final">
<div class="block-header">
<div class="block-title">Final checks</div>
<div class="block-progress" id="block-final-progress">0/${finalChecks.length}</div>
</div>
${finalChecks.map((check, idx) => `
<div class="item">
<input type="checkbox" id="final-${idx}" onchange="update()">
<label for="final-${idx}">${check.text}</label>
</div>
`).join('')}
</div>
` : ''}

<script>
function update(){
const boxes=document.querySelectorAll('input[type="checkbox"]');

boxes.forEach(box=>{
const item=box.closest('.item');
if(item){item.classList.toggle('done',box.checked)}
});

document.querySelectorAll('.block').forEach(block=>{
const blockBoxes=block.querySelectorAll('input[type="checkbox"]');
const checked=Array.from(blockBoxes).filter(b=>b.checked).length;
const total=blockBoxes.length;
const progressEl=block.querySelector('.block-progress');
if(progressEl){progressEl.textContent=checked+'/'+total}
});

localStorage.setItem('${storageKey}',JSON.stringify(Array.from(boxes).map(b=>b.checked)));
}

function load(){
const saved=localStorage.getItem('${storageKey}');
if(saved){
const state=JSON.parse(saved);
const boxes=document.querySelectorAll('input[type="checkbox"]');
boxes.forEach((box,i)=>{if(state[i])box.checked=true});
update();
}
}
window.addEventListener('load',load);
</script>
</div>
</body>
</html>`;
}

async function main() {
  try {
    const options = parseCliArgs();

    const content = await readFile(options.inputFile, 'utf-8');

    const metadata = parseMetadata(content);
    const blocks = parseBlocks(content);
    const finalChecks = parseFinalChecks(content);
    const adhdTips = parseAdhdTips(content);

    const data: ChecklistData = { metadata, blocks, finalChecks, adhdTips };

    const html = generateHtml(data, options);

    const outputFile = options.output || options.inputFile.replace(/\.md$/, '.html');

    await writeFile(outputFile, html, 'utf-8');

    const mdSize = Buffer.byteLength(content, 'utf-8');
    const htmlSize = Buffer.byteLength(html, 'utf-8');
    const ratio = (htmlSize / mdSize).toFixed(1);

    console.log(`[done] ${outputFile}`);
    console.log(`[size] ${mdSize}b md → ${htmlSize}b html (${ratio}x)`);

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
