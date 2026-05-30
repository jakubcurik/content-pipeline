import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthProvider } from '../shared/auth/types.js';
import { GOOGLE_API_HINTS } from '../shared/auth/google-auth.js';
import { authenticatedRequest, handleApiError } from '../shared/http-client.js';
import { asJson, renderPayload, truncationMessage } from '../shared/response-format.js';
import { CHARACTER_LIMIT } from '../shared/constants.js';
import { ResponseFormat } from '../shared/schemas/common.js';
import { GSC_API_BASE } from './constants.js';
import {
  GetSitemapInputSchema,
  InspectUrlInputSchema,
  ListSitemapsInputSchema,
  ListSitesInputSchema,
  QuerySearchAnalyticsInputSchema,
  QuerySearchAnalyticsInputShape,
  type GetSitemapInput,
  type InspectUrlInput,
  type ListSitemapsInput,
  type ListSitesInput,
  type QuerySearchAnalyticsInput,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeSiteUrl(siteUrl: string): string {
  return encodeURIComponent(siteUrl);
}

interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
}

function flattenSearchAnalytics(
  raw: SearchAnalyticsResponse,
  dimensions: string[],
): {
  rows: Array<Record<string, string | number>>;
  total_rows: number;
  aggregation_type: string;
} {
  const rows = (raw.rows ?? []).map((r) => {
    const out: Record<string, string | number> = {};
    (r.keys ?? []).forEach((value, i) => {
      out[dimensions[i] ?? `dim_${i}`] = value;
    });
    out.clicks = r.clicks ?? 0;
    out.impressions = r.impressions ?? 0;
    out.ctr = round(r.ctr ?? 0, 4);
    out.position = round(r.position ?? 0, 2);
    return out;
  });
  return {
    rows,
    total_rows: rows.length,
    aggregation_type: raw.responseAggregationType ?? 'unknown',
  };
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function searchAnalyticsToMarkdown(
  args: {
    site_url: string;
    start_date: string;
    end_date: string;
    dimensions: string[];
    rows: Array<Record<string, string | number>>;
    aggregation_type: string;
  },
): string {
  const { site_url, start_date, end_date, dimensions, rows, aggregation_type } = args;
  const lines: string[] = [
    `# GSC Search Analytics – ${site_url}`,
    '',
    `**Date range:** ${start_date} → ${end_date}`,
    `**Aggregation:** ${aggregation_type}`,
    `**Rows:** ${rows.length}`,
    '',
  ];
  if (rows.length === 0) {
    lines.push('_No rows for this query._');
    return lines.join('\n');
  }
  const headers = [...dimensions, 'clicks', 'impressions', 'ctr', 'position'];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(
      `| ${headers
        .map((h) => {
          const v = row[h];
          if (h === 'ctr' && typeof v === 'number') return `${(v * 100).toFixed(2)}%`;
          return v ?? '';
        })
        .join(' | ')} |`,
    );
  }
  return lines.join('\n');
}

function maybeTruncateAnalytics(
  rendered: string,
  payload: {
    rows: Array<Record<string, string | number>>;
    [key: string]: unknown;
  },
  format: ResponseFormat,
  toMarkdown: (rows: typeof payload.rows) => string,
): string {
  if (rendered.length <= CHARACTER_LIMIT) return rendered;
  let rows = payload.rows;
  let attempt = rendered;
  const total = rows.length;
  while (attempt.length > CHARACTER_LIMIT && rows.length > 1) {
    rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
    attempt =
      format === ResponseFormat.MARKDOWN
        ? toMarkdown(rows)
        : asJson({ ...payload, rows, row_count_returned: rows.length });
  }
  const note = truncationMessage({
    returned: rows.length,
    total,
    suggestion: 'Reduce dimensions, narrow the date range, add a dimension_filter, or fetch fewer rows with row_limit.',
  });
  return `${attempt}\n\n[TRUNCATED] ${note}`;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGscTools(server: McpServer, auth: AuthProvider): void {
  // -------------------------------------------------------------------------
  server.registerTool(
    'gsc_list_sites',
    {
      title: 'GSC – list verified sites',
      description: `List every Search Console site/property the authenticated user has access to, along with their permission level.

Use this when the user has not specified a site_url yet, or to discover the exact site URL string (which must be URL-prefix form like "https://example.com/" or domain form "sc-domain:example.com").

Args:
  - response_format ('markdown' | 'json', default 'markdown')

Returns:
  {
    "total": number,
    "sites": [
      { "site_url": "https://example.com/", "permission_level": "siteOwner" }
    ]
  }`,
      inputSchema: ListSitesInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (rawInput) => {
      const input = ListSitesInputSchema.parse(rawInput) as ListSitesInput;
      try {
        const data = await authenticatedRequest<{ siteEntry?: any[] }>(auth, `${GSC_API_BASE}/webmasters/v3/sites`);
        const sites = (data.siteEntry ?? []).map((s: any) => ({
          site_url: s.siteUrl ?? '',
          permission_level: s.permissionLevel ?? '',
        }));
        const payload = { total: sites.length, sites };
        const text = renderPayload(payload, input.response_format, () => {
          if (sites.length === 0) return '_No verified sites for this Google account._';
          const lines = [`# Search Console Sites (${sites.length})`, ''];
          for (const s of sites) {
            lines.push(`- \`${s.site_url}\` – ${s.permission_level}`);
          }
          return lines.join('\n');
        });
        return { content: [{ type: 'text', text }], structuredContent: payload };
      } catch (error) {
        return { content: [{ type: 'text', text: handleApiError(error, GOOGLE_API_HINTS) }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    'gsc_query_search_analytics',
    {
      title: 'GSC – query search analytics (clicks, impressions, CTR, position)',
      description: `The workhorse Search Console tool. Returns clicks, impressions, CTR, and average position for the requested time period, optionally broken down by query, page, country, device, searchAppearance, or date.

Note: GSC data has a 2-3 day reporting lag – the most recent days may be missing or partial.

Args:
  - site_url (string, required): "https://example.com/" or "sc-domain:example.com"
  - start_date (YYYY-MM-DD, required), end_date (YYYY-MM-DD, required, inclusive)
  - dimensions (array, default []): subset of "query", "page", "country", "device", "searchAppearance", "date"
  - type ("web"|"image"|"video"|"news"|"discover"|"googleNews", default "web")
  - dimension_filter_groups (array, optional): each {group_type:"and", filters:[{dimension, operator, expression}]}
      operators: equals, notEquals, contains, notContains, includingRegex, excludingRegex
      country dimension uses ISO-3166-1 alpha-3 lower-case codes (e.g. "cze", "usa")
  - aggregation_type ("auto"|"byPage"|"byProperty"|"byNewsShowcasePanel", default "auto")
  - row_limit (1-25000, default 1000)
  - start_row (default 0): pagination offset
  - response_format ('markdown' | 'json', default 'markdown')

Returns (json):
  {
    "site_url": "...",
    "start_date": "...", "end_date": "...",
    "dimensions": ["query"],
    "aggregation_type": "byProperty",
    "rows": [
      { "query": "claude code", "clicks": 123, "impressions": 4567, "ctr": 0.0269, "position": 8.45 }
    ],
    "row_count_returned": 1000
  }

Examples:
  - "Top 25 queries last 28 days":
      dimensions=["query"], start_date="28daysAgo equivalent date", end_date=today minus 3 days, row_limit=25
  - "Pages getting impressions but few clicks (low CTR)":
      dimensions=["page"], add a metric_filter client-side after fetch.
  - "Czech Republic traffic only":
      dimension_filter_groups=[{filters:[{dimension:"country", operator:"equals", expression:"cze"}]}]

Errors:
  - 403: no access – verify the site_url string matches an entry from gsc_list_sites exactly.`,
      inputSchema: QuerySearchAnalyticsInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (rawInput: unknown) => {
      const input = QuerySearchAnalyticsInputSchema.parse(rawInput) as QuerySearchAnalyticsInput;
      try {
        const body: Record<string, unknown> = {
          startDate: input.start_date,
          endDate: input.end_date,
          dimensions: input.dimensions,
          type: input.type,
          aggregationType: input.aggregation_type,
          rowLimit: input.row_limit,
          startRow: input.start_row,
        };
        if (input.dimension_filter_groups && input.dimension_filter_groups.length > 0) {
          body.dimensionFilterGroups = input.dimension_filter_groups.map((g) => ({
            groupType: g.group_type,
            filters: g.filters.map((f) => ({
              dimension: f.dimension,
              operator: f.operator,
              expression: f.expression,
            })),
          }));
        }
        const url = `${GSC_API_BASE}/webmasters/v3/sites/${encodeSiteUrl(input.site_url)}/searchAnalytics/query`;
        const raw = await authenticatedRequest<SearchAnalyticsResponse>(auth, url, { method: 'POST', body });
        const flat = flattenSearchAnalytics(raw, input.dimensions);
        const payload = {
          site_url: input.site_url,
          start_date: input.start_date,
          end_date: input.end_date,
          dimensions: input.dimensions,
          aggregation_type: flat.aggregation_type,
          rows: flat.rows,
          row_count_returned: flat.rows.length,
        };
        const initial = renderPayload(payload, input.response_format, () =>
          searchAnalyticsToMarkdown({
            site_url: input.site_url,
            start_date: input.start_date,
            end_date: input.end_date,
            dimensions: input.dimensions,
            rows: flat.rows,
            aggregation_type: flat.aggregation_type,
          }),
        );
        const finalText = maybeTruncateAnalytics(initial, payload, input.response_format, (rows) =>
          searchAnalyticsToMarkdown({
            site_url: input.site_url,
            start_date: input.start_date,
            end_date: input.end_date,
            dimensions: input.dimensions,
            rows,
            aggregation_type: flat.aggregation_type,
          }),
        );
        return { content: [{ type: 'text', text: finalText }], structuredContent: payload };
      } catch (error) {
        return { content: [{ type: 'text', text: handleApiError(error, GOOGLE_API_HINTS) }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    'gsc_list_sitemaps',
    {
      title: 'GSC – list submitted sitemaps for a site',
      description: `List sitemaps submitted to Search Console for a given site, with submission status, error/warning counts, and last-submitted/last-downloaded timestamps.

Args:
  - site_url (string, required)
  - sitemap_index (string, optional): only list sitemaps inside this sitemap-index URL
  - response_format ('markdown' | 'json', default 'markdown')

Returns:
  {
    "site_url": "...",
    "total": 3,
    "sitemaps": [
      {
        "path": "https://example.com/sitemap.xml",
        "type": "sitemap",
        "is_pending": false,
        "is_sitemap_index": false,
        "last_submitted": "2025-01-01T...",
        "last_downloaded": "2025-01-15T...",
        "errors": 0, "warnings": 2,
        "contents": [{ "type": "web", "submitted": "1234", "indexed": "0" }]
      }
    ]
  }`,
      inputSchema: ListSitemapsInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (rawInput) => {
      const input = ListSitemapsInputSchema.parse(rawInput) as ListSitemapsInput;
      try {
        const url = `${GSC_API_BASE}/webmasters/v3/sites/${encodeSiteUrl(input.site_url)}/sitemaps`;
        const data = await authenticatedRequest<{ sitemap?: any[] }>(auth, url, {
          query: input.sitemap_index ? { sitemapIndex: input.sitemap_index } : undefined,
        });
        const sitemaps = (data.sitemap ?? []).map((s: any) => ({
          path: s.path ?? '',
          type: s.type ?? '',
          is_pending: Boolean(s.isPending),
          is_sitemap_index: Boolean(s.isSitemapsIndex),
          last_submitted: s.lastSubmitted ?? '',
          last_downloaded: s.lastDownloaded ?? '',
          errors: Number(s.errors ?? 0),
          warnings: Number(s.warnings ?? 0),
          contents: s.contents ?? [],
        }));
        const payload = { site_url: input.site_url, total: sitemaps.length, sitemaps };
        const text = renderPayload(payload, input.response_format, () => {
          if (sitemaps.length === 0) return '_No sitemaps submitted for this site._';
          const lines = [`# Sitemaps for ${input.site_url} (${sitemaps.length})`, ''];
          for (const s of sitemaps) {
            lines.push(`## \`${s.path}\``);
            lines.push(`- Type: ${s.type}${s.is_sitemap_index ? ' (index)' : ''}`);
            if (s.last_submitted) lines.push(`- Last submitted: ${s.last_submitted}`);
            if (s.last_downloaded) lines.push(`- Last downloaded: ${s.last_downloaded}`);
            lines.push(`- Errors: ${s.errors}, Warnings: ${s.warnings}`);
            if (s.is_pending) lines.push('- Status: pending');
            lines.push('');
          }
          return lines.join('\n');
        });
        return { content: [{ type: 'text', text }], structuredContent: payload };
      } catch (error) {
        return { content: [{ type: 'text', text: handleApiError(error, GOOGLE_API_HINTS) }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    'gsc_get_sitemap',
    {
      title: 'GSC – get details of a single sitemap',
      description: `Get full status for a single submitted sitemap (errors, warnings, contents breakdown by type, last submitted/downloaded).

Args:
  - site_url (string, required)
  - sitemap_url (string, required): full sitemap URL as it appears in gsc_list_sitemaps
  - response_format ('markdown' | 'json', default 'markdown')`,
      inputSchema: GetSitemapInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (rawInput) => {
      const input = GetSitemapInputSchema.parse(rawInput) as GetSitemapInput;
      try {
        const url = `${GSC_API_BASE}/webmasters/v3/sites/${encodeSiteUrl(input.site_url)}/sitemaps/${encodeURIComponent(input.sitemap_url)}`;
        const data = await authenticatedRequest<any>(auth, url);
        const payload = {
          site_url: input.site_url,
          sitemap: {
            path: data.path ?? '',
            type: data.type ?? '',
            is_pending: Boolean(data.isPending),
            is_sitemap_index: Boolean(data.isSitemapsIndex),
            last_submitted: data.lastSubmitted ?? '',
            last_downloaded: data.lastDownloaded ?? '',
            errors: Number(data.errors ?? 0),
            warnings: Number(data.warnings ?? 0),
            contents: data.contents ?? [],
          },
        };
        const text = renderPayload(payload, input.response_format, () => {
          const s = payload.sitemap;
          const lines = [`# Sitemap: \`${s.path}\``, ''];
          lines.push(`- Type: ${s.type}${s.is_sitemap_index ? ' (index)' : ''}`);
          if (s.last_submitted) lines.push(`- Last submitted: ${s.last_submitted}`);
          if (s.last_downloaded) lines.push(`- Last downloaded: ${s.last_downloaded}`);
          lines.push(`- Errors: ${s.errors}, Warnings: ${s.warnings}`);
          if (s.is_pending) lines.push('- Status: pending');
          if (Array.isArray(s.contents) && s.contents.length > 0) {
            lines.push('', '**Contents:**');
            for (const c of s.contents) {
              lines.push(`- ${c.type ?? 'unknown'}: submitted=${c.submitted ?? '?'}, indexed=${c.indexed ?? '?'}`);
            }
          }
          return lines.join('\n');
        });
        return { content: [{ type: 'text', text }], structuredContent: payload };
      } catch (error) {
        return { content: [{ type: 'text', text: handleApiError(error, GOOGLE_API_HINTS) }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    'gsc_inspect_url',
    {
      title: 'GSC – inspect indexing status of a URL',
      description: `Inspect a single URL's indexing status in Google Search Console (URL Inspection API).

Returns the index status, last crawl, robots.txt verdict, mobile usability, AMP status, rich-results presence, and any indexing/crawl errors.

Args:
  - site_url (string, required): the property the URL belongs to
  - inspection_url (string, required): full URL to inspect
  - language_code (string, default "en-US"): BCP-47 language for human-readable strings
  - response_format ('markdown' | 'json', default 'markdown')

Returns:
  {
    "site_url": "...",
    "inspection_url": "...",
    "verdict": "PASS" | "FAIL" | "NEUTRAL",
    "coverage_state": "...",
    "robots_txt_state": "...",
    "indexing_state": "...",
    "last_crawl_time": "...",
    "page_fetch_state": "...",
    "google_canonical": "...",
    "user_canonical": "...",
    "crawled_as": "...",
    "mobile_usability": { "verdict": "...", "issues": [...] },
    "amp_result": { "verdict": "...", "issues": [...] },
    "rich_results": { "verdict": "...", "detected_items": [...] }
  }

Errors:
  - 400: URL not in property → confirm the inspection_url begins with the site_url's URL prefix.`,
      inputSchema: InspectUrlInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (rawInput) => {
      const input = InspectUrlInputSchema.parse(rawInput) as InspectUrlInput;
      try {
        const body = {
          inspectionUrl: input.inspection_url,
          siteUrl: input.site_url,
          languageCode: input.language_code,
        };
        const data = await authenticatedRequest<any>(auth, `${GSC_API_BASE}/v1/urlInspection/index:inspect`, {
          method: 'POST',
          body,
        });
        const idx = data.inspectionResult?.indexStatusResult ?? {};
        const mob = data.inspectionResult?.mobileUsabilityResult ?? {};
        const amp = data.inspectionResult?.ampResult ?? {};
        const rich = data.inspectionResult?.richResultsResult ?? {};
        const payload = {
          site_url: input.site_url,
          inspection_url: input.inspection_url,
          inspection_result_link: data.inspectionResult?.inspectionResultLink ?? '',
          verdict: idx.verdict ?? '',
          coverage_state: idx.coverageState ?? '',
          robots_txt_state: idx.robotsTxtState ?? '',
          indexing_state: idx.indexingState ?? '',
          last_crawl_time: idx.lastCrawlTime ?? '',
          page_fetch_state: idx.pageFetchState ?? '',
          google_canonical: idx.googleCanonical ?? '',
          user_canonical: idx.userCanonical ?? '',
          crawled_as: idx.crawledAs ?? '',
          referring_urls: idx.referringUrls ?? [],
          sitemaps: idx.sitemap ?? [],
          mobile_usability: { verdict: mob.verdict ?? '', issues: mob.issues ?? [] },
          amp_result: { verdict: amp.verdict ?? '', issues: amp.issues ?? [] },
          rich_results: {
            verdict: rich.verdict ?? '',
            detected_items: rich.detectedItems ?? [],
          },
        };
        const text = renderPayload(payload, input.response_format, () => {
          const lines = [
            `# URL Inspection: ${payload.inspection_url}`,
            '',
            `**Verdict:** ${payload.verdict}`,
            `**Coverage:** ${payload.coverage_state}`,
            `**Indexing state:** ${payload.indexing_state}`,
            `**Robots.txt:** ${payload.robots_txt_state}`,
            `**Page fetch:** ${payload.page_fetch_state}`,
          ];
          if (payload.last_crawl_time) lines.push(`**Last crawl:** ${payload.last_crawl_time}`);
          if (payload.crawled_as) lines.push(`**Crawled as:** ${payload.crawled_as}`);
          if (payload.user_canonical) lines.push(`**User canonical:** ${payload.user_canonical}`);
          if (payload.google_canonical) lines.push(`**Google canonical:** ${payload.google_canonical}`);
          if (payload.mobile_usability.verdict) {
            lines.push('', `**Mobile usability:** ${payload.mobile_usability.verdict}`);
            for (const i of payload.mobile_usability.issues as any[]) {
              lines.push(`- ${i.issueType ?? ''}: ${i.message ?? ''}`);
            }
          }
          if (payload.amp_result.verdict) {
            lines.push('', `**AMP:** ${payload.amp_result.verdict}`);
          }
          if (payload.rich_results.verdict) {
            lines.push('', `**Rich results:** ${payload.rich_results.verdict}`);
            for (const item of payload.rich_results.detected_items as any[]) {
              lines.push(`- ${item.richResultType ?? ''} (${(item.items ?? []).length} items)`);
            }
          }
          if (payload.inspection_result_link) {
            lines.push('', `[Open in Search Console](${payload.inspection_result_link})`);
          }
          return lines.join('\n');
        });
        return { content: [{ type: 'text', text }], structuredContent: payload };
      } catch (error) {
        return { content: [{ type: 'text', text: handleApiError(error, GOOGLE_API_HINTS) }], isError: true };
      }
    },
  );
}
