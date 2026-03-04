# qa-toolkit

Scripts I built to stop doing the same QA work manually. Each one started as a specific annoyance.

The full toolkit is 14 scripts. Five are here. The rest touch PHI-adjacent workflows or are too tightly coupled to internal Jira structure to extract cleanly. HIPAA-adjacent data doesn't sanitize well.

## Scripts

### `daily-qa-setup.ts`

Spent 20-30 minutes every morning reading Jira, picking what to test first, and writing the same kinds of test plans. Built this to do that part instead. It pulls your assigned QA tickets and parent stories, sends them to Claude for AC atomization and LOE scoring, and writes per-ticket HTML test plans. Checkboxes save to localStorage. There's a "Copy for Jira" button that builds a pass/fail comment ready to paste directly into the ticket.

```bash
npx tsx scripts/daily-qa-setup.ts
npx tsx scripts/daily-qa-setup.ts 2026-03-05        # specific date
npx tsx scripts/daily-qa-setup.ts --dry-run          # analyze only, no HTML
npx tsx scripts/daily-qa-setup.ts --ticket PROJ-1234 # single ticket, bypass JQL
npx tsx scripts/daily-qa-setup.ts --from-state       # regenerate HTML, skip API calls
npx tsx scripts/daily-qa-setup.ts --open --quiet     # open browser, suppress logs
```

Requires: `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_BASE_URL`, `ANTHROPIC_API_KEY`
Optional: `QA_OUTPUT_DIR` (default: `./qa-output`), `JIRA_LABEL` (shown in HTML headers, e.g. `"Sprint 42"`)

Configure your Jira workflow status names and custom field IDs in the `QA_STATUSES` and `JIRA_FIELDS` constants near the top of the file. The defaults are examples, not universals.

---

### `gemini-video-analyze.ts`

Scrubbing through recordings to write HIPAA audit evidence was eating an hour per ticket. Now I just send the recording to Gemini. Structured markdown report back in minutes: timestamps, UI state transitions, errors, dropdown final values, GraphQL activity. Frame extraction by default (reads actual UI text). Pass `--video-mode` if you just want a quick look and don't need accuracy.

```bash
npx tsx scripts/gemini-video-analyze.ts recording.mov --ticket PROJ-123
npx tsx scripts/gemini-video-analyze.ts recording.mov --detail exhaustive
npx tsx scripts/gemini-video-analyze.ts recording.mov --video-mode  # fast, less accurate
```

Requires: `GEMINI_API_KEY`
Cost: ~$0.05–0.10 per 60–90s video in frame mode (default), ~$0.02–0.04 in video mode. Free tier covers most usage.

---

### `jira-release-notes.ts`

Every release cycle ended with rewriting the same doc from scratch. Pass a Jira version URL; get categorized markdown back: features, bugs, breaking changes, other. Pass `--create-calendar-event` to also drop a day-before-release calendar event with a QA checklist in the description.

```bash
npx tsx scripts/jira-release-notes.ts https://yourco.atlassian.net/projects/FOO/versions/12345
npx tsx scripts/jira-release-notes.ts <url> --output RELEASE_NOTES.md
npx tsx scripts/jira-release-notes.ts <url> --sections features,fixes --create-calendar-event
```

Requires: `JIRA_EMAIL`, `JIRA_API_TOKEN`
Optional: `GOOGLE_CALENDAR_TOKEN`, `WORK_CALENDAR_ID`, `JIRA_PAGE_SIZE`, `CHECKLIST_PATH`

---

### `transcribe-to-md.sh`

Runs WhisperX on a video or audio file and renames the output from `.txt` to `.md`. Accepts multiple files.

```bash
./scripts/transcribe-to-md.sh recording.mov
./scripts/transcribe-to-md.sh *.mov  # batch
```

Requires: `whisperx` installed and on PATH (`pip install whisperx`)

---

### `google-calendar-auth.ts`

One-time OAuth helper for `jira-release-notes.ts`. Google Calendar's OAuth flow has more steps than it should. This handles the server and callback, then prints the exact export command to run when it's done.

```bash
npx tsx scripts/google-calendar-auth.ts credentials.json
```

Requires: Google OAuth 2.0 credentials JSON (Desktop app type) from [Google Cloud Console](https://console.cloud.google.com/apis/credentials)

Note: the redirect URI in your credentials file must point to localhost. The script reads the port from it.

---

### `md-to-interactive-checklist.ts`

Flat markdown checklists are fine until you're mid-release and losing your place. Converts a markdown checklist to a self-contained interactive HTML file: checkboxes, per-block progress counters, localStorage so state survives a refresh. Optionally links Jira ticket IDs to your instance.

```bash
npx tsx scripts/md-to-interactive-checklist.ts release-checklist.md
npx tsx scripts/md-to-interactive-checklist.ts checklist.md --output out.html
npx tsx scripts/md-to-interactive-checklist.ts checklist.md --no-jira-links
```

Requires: nothing
Optional: `JIRA_BASE_URL` (for ticket links in the HTML output)

---

## Setup

```bash
npm install
cp .env.example .env
# fill in .env
```

The TypeScript scripts use `dotenv` so credentials load from `.env` automatically.

## Requirements

- Node.js 18+
- `tsx` (installed via devDependencies)
- ffmpeg (required for frame extraction mode in `gemini-video-analyze.ts`)
- whisperx (required for `transcribe-to-md.sh`)
