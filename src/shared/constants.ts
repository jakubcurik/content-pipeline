/**
 * Cross-server constants. Service-specific constants (API base URLs, server
 * names, API versions) live in each server's own `constants.ts`.
 */

/** Maximum size of a single tool response, in characters. */
export const CHARACTER_LIMIT = 25_000;

/** Google OAuth endpoints (used by the refresh-token grant and the CLI). */
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
