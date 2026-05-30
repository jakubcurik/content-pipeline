/**
 * Provider-agnostic authentication interface used by the shared HTTP client so
 * each MCP server in this plugin (GA4, GSC, Google Ads, Meta Ads, …) can plug
 * in whatever credential flow it needs.
 */
export interface AuthProvider {
  /**
   * Return a valid access token, refreshing it when needed. When
   * `forceRefresh` is true the provider MUST bypass any cache and produce a
   * fresh token – called by the HTTP client after a 401 response.
   */
  getAccessToken(forceRefresh?: boolean): Promise<string>;

  /** Drop cached credentials (called after a 401). A no-op is acceptable. */
  invalidate(): void;

  /**
   * Optional extra headers injected into every authenticated request (e.g.
   * Google Ads needs `developer-token` and `login-customer-id`). Returning an
   * empty object is equivalent to omitting the method.
   */
  extraHeaders?(): Record<string, string>;
}
