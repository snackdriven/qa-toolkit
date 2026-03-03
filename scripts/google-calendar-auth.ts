#!/usr/bin/env tsx

/**
 * Google Calendar OAuth setup helper
 *
 * Gets a GOOGLE_CALENDAR_TOKEN for use with jira-release-notes.ts.
 * Run once, then add the printed export to your shell profile.
 *
 * Setup:
 * 1. Go to https://console.cloud.google.com/apis/credentials
 * 2. Create an OAuth 2.0 Client ID (Desktop app type)
 * 3. Download the credentials JSON
 * 4. Run: npx tsx scripts/google-calendar-auth.ts <credentials-file>
 *
 * Usage:
 *   npx tsx scripts/google-calendar-auth.ts <credentials-file>
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { createServer } from 'node:http';

interface OAuthCredentials {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

async function main(): Promise<void> {
  const credentialsPath = process.argv[2];

  if (!credentialsPath) {
    console.log(`
Google Calendar OAuth

Gets a GOOGLE_CALENDAR_TOKEN for use with jira-release-notes.ts.

SETUP:

1. Go to https://console.cloud.google.com/apis/credentials
2. Click "Create Credentials" > "OAuth client ID"
3. Choose "Desktop app" as application type
4. Download the JSON file
5. Run: npx tsx scripts/google-calendar-auth.ts <path-to-json>

Handles the OAuth callback on localhost and prints the export command.

QUICK TEST TOKEN (expires in 1 hour):

1. Go to https://developers.google.com/oauthplayground/
2. In "Step 1", select "Calendar API v3" > "https://www.googleapis.com/auth/calendar"
3. Authorize and sign in with your Google account
4. In "Step 2", click "Exchange authorization code for tokens"
5. Copy the "Access token" value
6. Run: export GOOGLE_CALENDAR_TOKEN="<paste-token-here>"

Use the OAuth client for anything that needs to last longer than an hour.
`);
    process.exit(1);
  }

  try {
    const credentialsContent = await readFile(credentialsPath, 'utf-8');
    const credentials = JSON.parse(credentialsContent) as OAuthCredentials;

    const config = credentials.installed || credentials.web;
    if (!config) {
      throw new Error('Invalid credentials file format');
    }

    const { client_id, client_secret, redirect_uris } = config;
    const redirectUri = redirect_uris[0] || 'http://localhost:3000/oauth2callback';
    const port = parseInt(new URL(redirectUri).port || '3000', 10);

    console.log('\n=== Google Calendar OAuth Setup ===\n');
    console.log(`Starting local server on http://localhost:${port}...\n`);

    const server = createServer(async (req, res) => {
      if (!req.url?.startsWith('/oauth2callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');

      if (!code) {
        res.writeHead(400);
        res.end('No authorization code received');
        return;
      }

      try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id,
            client_secret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
        });

        const tokens = (await tokenResponse.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
        };

        if (!tokens.access_token) {
          throw new Error('No access token received');
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body>
              <h1>Authorization complete</h1>
              <p>You can close this window and return to the terminal.</p>
            </body>
          </html>
        `);

        clearTimeout(authTimeout);
        console.log('\n[done] Authorization successful!\n');
        console.log('Add this to your environment:\n');
        console.log(`export GOOGLE_CALENDAR_TOKEN="${tokens.access_token}"`);
        console.log('\nOr add to your shell profile (~/.zshrc or ~/.bashrc):\n');
        console.log(`export GOOGLE_CALENDAR_TOKEN="${tokens.access_token}"`);

        if (tokens.refresh_token) {
          console.log('\nRefresh token (for long-term use):');
          console.log(tokens.refresh_token);
          console.log('\nStore it somewhere safe. It generates new access tokens without re-auth.');
        }

        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 1000);
      } catch (error) {
        const err = error as Error;
        res.writeHead(500);
        res.end(`Error exchanging code: ${err.message}`);
        console.error('Token exchange failed:', err.message);
        server.close();
        process.exit(1);
      }
    });

    const authTimeout = setTimeout(() => {
      console.error('\n[error] Timed out after 5 minutes. Run the script again to retry.');
      server.close();
      process.exit(1);
    }, 5 * 60 * 1000);
    authTimeout.unref();

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Close whatever is running on it and try again.`);
      } else {
        console.error('Server error:', err.message);
      }
      process.exit(1);
    });

    server.listen(port, () => {
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', client_id);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar');
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');

      console.log('Open this URL in your browser:\n');
      console.log(authUrl.toString());
      console.log('\nWaiting for authorization...\n');
    });
  } catch (error) {
    const err = error as Error;
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unexpected error occurred.';
  console.error(message);
  process.exit(1);
});
