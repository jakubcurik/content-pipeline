import { GOOGLE_OAUTH_TOKEN_URL } from '../constants.js';
import type { AuthProvider } from './types.js';
import type { ErrorHints } from '../http-client.js';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch milliseconds
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /**
   * Extra headers to include in every authenticated request built on top of
   * this provider – used by the Google Ads server to inject `developer-token`
   * and the optional `login-customer-id` for MCC access.
   */
  extraHeaders?: Record<string, string>;
}

/**
 * Google OAuth 2.0 refresh-token-grant provider. Caches access tokens in
 * memory until 60 seconds before their expiry. Safe to share across tool
 * calls inside a single MCP server process.
 */
export class GoogleAuthProvider implements AuthProvider {
  private cached: CachedToken | null = null;
  private readonly opts: GoogleAuthOptions;

  constructor(opts: GoogleAuthOptions) {
    this.opts = opts;
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && Date.now() < this.cached.expiresAt - 60_000) {
      return this.cached.accessToken;
    }

    const { clientId, clientSecret, refreshToken } = this.opts;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Google OAuth token refresh failed (${response.status}): ${text}. ` +
          'Check the client ID, client secret, and refresh token. The refresh token may be revoked – re-run animato-oauth to generate a new one.',
      );
    }

    const data = (await response.json()) as TokenResponse;
    this.cached = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return this.cached.accessToken;
  }

  invalidate(): void {
    this.cached = null;
  }

  extraHeaders(): Record<string, string> {
    return this.opts.extraHeaders ?? {};
  }
}

/** Error hints tailored for Google APIs (GA4, GSC, Google Ads). */
export const GOOGLE_API_HINTS: ErrorHints = {
  unauthorized:
    'Error: Authentication failed. The Google refresh token may be invalid or revoked. Re-run animato-oauth to generate a new one.',
  forbidden:
    'Confirm that your Google account has access to the requested resource and that the relevant API is enabled in Google Cloud Console.',
  service: 'Google API',
};
