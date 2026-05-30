/**
 * Interactive CLI helper that walks the user through Google's OAuth 2.0
 * installed-application flow and prints a refresh token suitable for the
 * Marketing MCP plugin's `google_refresh_token` user config value.
 *
 * The refresh token covers the union of scopes across every Google-backed
 * service in this plugin (GA4, GSC, Google Ads). Individual servers only need
 * a token that includes the scopes they actually consume; generating one
 * token with all scopes means the user only runs this CLI once.
 *
 * Flow:
 *   1. Prompt for GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (or read from env).
 *   2. Build the consent URL with scopes (analytics.readonly, webmasters.readonly, adwords).
 *   3. Open the user's default browser at that URL.
 *   4. Spin up a localhost server on port 8085 to capture the callback.
 *   5. Exchange the authorization code for a refresh token.
 *   6. Print the refresh token and exit.
 */

import { createInterface } from 'node:readline';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { GOOGLE_OAUTH_AUTH_URL, GOOGLE_OAUTH_TOKEN_URL } from './shared/constants.js';

const REDIRECT_PORT = 8085;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

/** Google OAuth scopes for content-pipeline: GSC + GA4, read-only. One token covers both. */
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
];

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '""', url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Fall through; URL was already printed for manual opening.
  }
}

function buildConsentUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}

interface AuthCodeResult {
  code: string;
  error?: string;
}

function waitForAuthCode(): Promise<AuthCodeResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end('Bad request');
        return;
      }
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.statusCode = 400;
        res.end(`OAuth error: ${error}. You can close this tab.`);
        server.close();
        resolve({ code: '', error });
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.end('Missing authorization code.');
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><html lang="cs"><body style="font-family:system-ui;padding:2rem;max-width:520px;margin:auto">` +
          `<h1>Hotovo!</h1>` +
          `<p>Refresh token byl vygenerován. Vrať se do terminálu, kde běží google-oauth helper.</p>` +
          `<p>Tuto záložku můžeš zavřít.</p>` +
          `</body></html>`,
      );
      server.close();
      resolve({ code });
    });

    server.on('error', (err) => reject(err));
    server.listen(REDIRECT_PORT, '127.0.0.1');
  });
}

async function exchangeCodeForRefreshToken(args: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<{ refreshToken: string; scope: string }> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { refresh_token?: string; scope?: string };
  if (!data.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Re-run the flow with prompt=consent (this script already does, so the OAuth client may be a Web app instead of a Desktop app).',
    );
  }
  return { refreshToken: data.refresh_token, scope: data.scope ?? '' };
}

async function main(): Promise<void> {
  console.log('');
  console.log('==============================================================');
  console.log('  content-pipeline – Google OAuth helper');
  console.log('==============================================================');
  console.log('');
  console.log('This tool generates a Google OAuth refresh token for the content-pipeline plugin.');
  console.log('It covers Search Console + Analytics with a single token.');
  console.log('You need a Google Cloud project with a Desktop OAuth Client and these APIs enabled:');
  console.log('  - Google Search Console API');
  console.log('  - Google Analytics Data API');
  console.log('');

  const clientId = process.env.GOOGLE_CLIENT_ID || (await prompt('Google OAuth Client ID: '));
  if (!clientId) {
    console.error('Client ID is required.');
    process.exit(1);
  }
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || (await prompt('Google OAuth Client Secret: '));
  if (!clientSecret) {
    console.error('Client Secret is required.');
    process.exit(1);
  }

  const consentUrl = buildConsentUrl(clientId);
  console.log('');
  console.log('Opening the Google consent screen in your default browser…');
  console.log('If it does not open, copy this URL manually:');
  console.log('');
  console.log(consentUrl);
  console.log('');
  console.log(`Waiting for the callback on ${REDIRECT_URI} …`);

  openBrowser(consentUrl);

  const authResult = await waitForAuthCode();
  if (authResult.error || !authResult.code) {
    console.error(`OAuth flow failed: ${authResult.error ?? 'no code received'}`);
    process.exit(1);
  }

  console.log('Authorization code received. Exchanging for refresh token…');
  const { refreshToken, scope } = await exchangeCodeForRefreshToken({
    clientId,
    clientSecret,
    code: authResult.code,
  });

  console.log('');
  console.log('==============================================================');
  console.log('  SUCCESS – your Google OAuth refresh token:');
  console.log('==============================================================');
  console.log('');
  console.log(refreshToken);
  console.log('');
  console.log(`Scopes granted: ${scope}`);
  console.log('');
  console.log('Next step:');
  console.log('  Paste this token into the content-pipeline plugin config as `google_refresh_token`.');
  console.log('  In Claude Code: /plugin → content-pipeline → Configure options');
  console.log('');
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
