#!/usr/bin/env node
import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/oauth-google.ts
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

// src/shared/constants.ts
var GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
var GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

// src/oauth-google.ts
var REDIRECT_PORT = 8085;
var REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
var GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly"
];
async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", '""', url];
  } else if (platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
  }
}
function buildConsentUrl(clientId) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_OAUTH_SCOPES.join(" ")
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}
function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end("Bad request");
        return;
      }
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.statusCode = 400;
        res.end(`OAuth error: ${error}. You can close this tab.`);
        server.close();
        resolve({ code: "", error });
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code.");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html lang="cs"><body style="font-family:system-ui;padding:2rem;max-width:520px;margin:auto"><h1>Hotovo!</h1><p>Refresh token byl vygenerov\xE1n. Vra\u0165 se do termin\xE1lu, kde b\u011B\u017E\xED google-oauth helper.</p><p>Tuto z\xE1lo\u017Eku m\u016F\u017Ee\u0161 zav\u0159\xEDt.</p></body></html>`
      );
      server.close();
      resolve({ code });
    });
    server.on("error", (err) => reject(err));
    server.listen(REDIRECT_PORT, "127.0.0.1");
  });
}
async function exchangeCodeForRefreshToken(args) {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI
  });
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Re-run the flow with prompt=consent (this script already does, so the OAuth client may be a Web app instead of a Desktop app)."
    );
  }
  return { refreshToken: data.refresh_token, scope: data.scope ?? "" };
}
async function main() {
  console.log("");
  console.log("==============================================================");
  console.log("  content-pipeline \u2013 Google OAuth helper");
  console.log("==============================================================");
  console.log("");
  console.log("This tool generates a Google OAuth refresh token for the content-pipeline plugin.");
  console.log("It covers Search Console + Analytics with a single token.");
  console.log("You need a Google Cloud project with a Desktop OAuth Client and these APIs enabled:");
  console.log("  - Google Search Console API");
  console.log("  - Google Analytics Data API");
  console.log("");
  const clientId = process.env.GOOGLE_CLIENT_ID || await prompt("Google OAuth Client ID: ");
  if (!clientId) {
    console.error("Client ID is required.");
    process.exit(1);
  }
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || await prompt("Google OAuth Client Secret: ");
  if (!clientSecret) {
    console.error("Client Secret is required.");
    process.exit(1);
  }
  const consentUrl = buildConsentUrl(clientId);
  console.log("");
  console.log("Opening the Google consent screen in your default browser\u2026");
  console.log("If it does not open, copy this URL manually:");
  console.log("");
  console.log(consentUrl);
  console.log("");
  console.log(`Waiting for the callback on ${REDIRECT_URI} \u2026`);
  openBrowser(consentUrl);
  const authResult = await waitForAuthCode();
  if (authResult.error || !authResult.code) {
    console.error(`OAuth flow failed: ${authResult.error ?? "no code received"}`);
    process.exit(1);
  }
  console.log("Authorization code received. Exchanging for refresh token\u2026");
  const { refreshToken, scope } = await exchangeCodeForRefreshToken({
    clientId,
    clientSecret,
    code: authResult.code
  });
  console.log("");
  console.log("==============================================================");
  console.log("  SUCCESS \u2013 your Google OAuth refresh token:");
  console.log("==============================================================");
  console.log("");
  console.log(refreshToken);
  console.log("");
  console.log(`Scopes granted: ${scope}`);
  console.log("");
  console.log("Next step:");
  console.log("  Paste this token into the content-pipeline plugin config as `google_refresh_token`.");
  console.log("  In Claude Code: /plugin \u2192 content-pipeline \u2192 Configure options");
  console.log("");
}
main().catch((error) => {
  console.error("Fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
