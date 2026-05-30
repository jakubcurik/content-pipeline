#!/usr/bin/env node
/**
 * Marketing MCP – GA4 server entry point.
 *
 * Registers GA4 tools and connects to a stdio transport so it can be spawned
 * by Claude Code (or any other MCP client) as a subprocess.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GoogleAuthProvider } from '../shared/auth/google-auth.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { registerGa4Tools } from './tools.js';

const REQUIRED_ENV_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'] as const;

function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    process.stderr.write(
      `[${SERVER_NAME}] Missing required environment variables: ${missing.join(', ')}\n` +
        `[${SERVER_NAME}] When running as a Claude Code plugin these are wired from your plugin user-config.\n` +
        `[${SERVER_NAME}] To generate GOOGLE_REFRESH_TOKEN run the content-pipeline OAuth helper: node bin/google-oauth.js .\n`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  validateEnv();

  const auth = new GoogleAuthProvider({
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
  });

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerGa4Tools(server, auth);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[${SERVER_NAME}] v${SERVER_VERSION} ready (stdio)\n`);
}

main().catch((error) => {
  process.stderr.write(
    `[${SERVER_NAME}] Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
