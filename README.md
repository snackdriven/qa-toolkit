# qa-toolkit

Scripts I built to stop doing the same QA work manually. Each one started as a specific annoyance.

The full toolkit is 14 scripts. Two are here. The rest touch PHI-adjacent workflows or are too tightly coupled to internal Jira structure to extract cleanly. HIPAA-adjacent data doesn't sanitize well.

## Scripts

### `gemini-video-analyze.ts`

Sends a QA screen recording to Gemini and gets back a structured markdown report: timestamps, UI state transitions, errors, dropdown final values, GraphQL activity. Frame extraction by default (reads actual UI text). Pass `--video-mode` if you just want a quick look and don't need accuracy.

Built because scrubbing through recordings to write HIPAA audit evidence was eating an hour per ticket.

```bash
npx tsx scripts/gemini-video-analyze.ts recording.mov --ticket PROJ-123
npx tsx scripts/gemini-video-analyze.ts recording.mov --detail exhaustive
npx tsx scripts/gemini-video-analyze.ts recording.mov --video-mode  # fast, less accurate
```

Requires: `GEMINI_API_KEY`
Cost: ~$0.05–0.10 per 60–90s video in frame mode (default), ~$0.02–0.04 in video mode. Free tier covers most usage.

---

### `jira-release-notes.ts`

Fetches all issues in a Jira release by version URL, categorizes them (features / bugs / breaking / other), and outputs formatted markdown. Pass `--create-calendar-event` to also drop a day-before-release calendar event with a QA checklist in the description.

Built because I was rewriting the same release doc from scratch every cycle.

```bash
npx tsx scripts/jira-release-notes.ts https://yourco.atlassian.net/projects/FOO/versions/12345
npx tsx scripts/jira-release-notes.ts <url> --output RELEASE_NOTES.md
npx tsx scripts/jira-release-notes.ts <url> --sections features,fixes --create-calendar-event
```

Requires: `JIRA_EMAIL`, `JIRA_API_TOKEN`
Optional: `GOOGLE_CALENDAR_TOKEN`, `WORK_CALENDAR_ID`, `JIRA_PAGE_SIZE`, `CHECKLIST_PATH`

---

## Setup

```bash
npm install
cp .env.example .env
# fill in .env
```

Both scripts use `dotenv` so credentials load from `.env` automatically.

## Requirements

- Node.js 18+
- `tsx` (installed via devDependencies)
- ffmpeg (required for frame extraction mode in `gemini-video-analyze.ts`)
