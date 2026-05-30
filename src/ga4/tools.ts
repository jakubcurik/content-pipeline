import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthProvider } from '../shared/auth/types.js';
import { GOOGLE_API_HINTS } from '../shared/auth/google-auth.js';
import { authenticatedRequest, handleApiError } from '../shared/http-client.js';
import { asJson, renderPayload, truncationMessage } from '../shared/response-format.js';
import { CHARACTER_LIMIT } from '../shared/constants.js';
import { ResponseFormat } from '../shared/schemas/common.js';
import { GA4_ADMIN_API_BASE, GA4_DATA_API_BASE } from './constants.js';
import {
  GetMetadataInputSchema,
  GetPropertyInputSchema,
  ListAccountSummariesInputSchema,
  ListPropertiesInputSchema,
  RunRealtimeReportInputSchema,
  RunReportInputSchema,
  type GetMetadataInput,
  type GetPropertyInput,
  type ListAccountSummariesInput,
  type ListPropertiesInput,
  type RunRealtimeReportInput,
  type RunReportInput,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePropertyId(propertyId: string): string {
  return propertyId.replace(/^properties\//, '');
}

function normalizeAccountId(accountId: string): string {
  return accountId.replace(/^accounts\//, '');
}

interface RawReportResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: {
    dimensionValues?: { value?: string }[];
    metricValues?: { value?: string }[];
  }[];
  totals?: { metricValues?: { value?: string }[] }[];
  rowCount?: number;
  metadata?: Record<string, unknown>;
}

interface FlatReport {
  dimensions: string[];
  metrics: { name: string; type: string }[];
  rows: Record<string, string>[];
  totals: Record<string, string> | null;
  total_row_count: number;
}

function flattenReport(raw: RawReportResponse): FlatReport {
  const dimensionNames = (raw.dimensionHeaders ?? []).map((h) => h.name);
  const metricHeaders = (raw.metricHeaders ?? []).map((h) => ({
    name: h.name,
    type: h.type ?? 'TYPE_UNSPECIFIED',
  }));
  const metricNames = metricHeaders.map((m) => m.name);

  const rows = (raw.rows ?? []).map((row) => {
    const out: Record<string, string> = {};
    (row.dimensionValues ?? []).forEach((dv, i) => {
      out[dimensionNames[i] ?? `dim_${i}`] = dv.value ?? '';
    });
    (row.metricValues ?? []).forEach((mv, i) => {
      out[metricNames[i] ?? `metric_${i}`] = mv.value ?? '';
    });
    return out;
  });

  let totals: Record<string, string> | null = null;
  if (raw.totals && raw.totals.length > 0) {
    totals = {};
    (raw.totals[0]?.metricValues ?? []).forEach((mv, i) => {
      totals![metricNames[i] ?? `metric_${i}`] = mv.value ?? '';
    });
  }

  return {
    dimensions: dimensionNames,
    metrics: metricHeaders,
    rows,
    totals,
    total_row_count: raw.rowCount ?? rows.length,
  };
}

function reportToMarkdown(args: {
  title: string;
  property_id: string;
  date_range_label?: string;
  flat: FlatReport;
}): string {
  const { title, property_id, date_range_label, flat } = args;
  const columns = [...flat.dimensions, ...flat.metrics.map((m) => m.name)];
  const lines: string[] = [`# ${title}`, '', `**Property:** ${property_id}`];
  if (date_range_label) lines.push(`**Date range:** ${date_range_label}`);
  lines.push(`**Rows returned:** ${flat.rows.length} of ${flat.total_row_count}`, '');

  if (columns.length === 0 || flat.rows.length === 0) {
    lines.push('_No data._');
    return lines.join('\n');
  }

  lines.push(`| ${columns.join(' | ')} |`);
  lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
  for (const row of flat.rows) {
    lines.push(`| ${columns.map((c) => row[c] ?? '').join(' | ')} |`);
  }

  if (flat.totals) {
    lines.push('', '**Totals:**');
    for (const [k, v] of Object.entries(flat.totals)) {
      lines.push(`- ${k}: ${v}`);
    }
  }
  return lines.join('\n');
}

function buildReportBody(input: RunReportInput | RunRealtimeReportInput, includeDateRanges: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    dimensions: input.dimensions,
    metrics: input.metrics,
    limit: String(input.limit), // GA4 expects string for int64
  };
  if (includeDateRanges && 'date_ranges' in input) {
    body.dateRanges = input.date_ranges.map((r) => ({
      startDate: r.start_date,
      endDate: r.end_date,
      ...(r.name ? { name: r.name } : {}),
    }));
  }
  if ('offset' in input && input.offset > 0) body.offset = String(input.offset);
  if ('keep_empty_rows' in input && input.keep_empty_rows) body.keepEmptyRows = true;
  if (input.dimension_filter) body.dimensionFilter = input.dimension_filter;
  if (input.metric_filter) body.metricFilter = input.metric_filter;
  if (input.order_bys && input.order_bys.length > 0) {
    body.orderBys = input.order_bys.map((ob) => {
      const entry: Record<string, unknown> = { desc: ob.desc };
      if (ob.metric_name) entry.metric = { metricName: ob.metric_name };
      if (ob.dimension_name) entry.dimension = { dimensionName: ob.dimension_name };
      return entry;
    });
  }
  return body;
}

function maybeTruncateReport(rendered: string, flat: FlatReport, format: ResponseFormat): string {
  if (rendered.length <= CHARACTER_LIMIT) return rendered;
  // Halve the rows until under the limit, with a hard floor of 1.
  let rows = flat.rows;
  let attempt = rendered;
  while (attempt.length > CHARACTER_LIMIT && rows.length > 1) {
    rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
    const reduced: FlatReport = { ...flat, rows };
    if (format === ResponseFormat.MARKDOWN) {
      attempt = reportToMarkdown({
        title: 'GA4 Report',
        property_id: '',
        flat: reduced,
      });
    } else {
      attempt = asJson(reduced);
    }
  }
  const note = truncationMessage({
    returned: rows.length,
    total: flat.total_row_count,
    suggestion: 'Reduce dimensions, narrow the date range, add filters, or use json format with a smaller limit.',
  });
  return `${attempt}\n\n[TRUNCATED] ${note}`;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGa4Tools(server: McpServer, auth: AuthProvider): void {
  // -------------------------------------------------------------------------
  server.registerTool(
    'ga4_list_account_summaries',
    {
      title: 'GA4 – list account summaries',
      description: `List all GA4 accounts the authenticated user can access, together with their properties. The tool auto-paginates the Admin API so accounts past the first 200 are not silently dropped.

This is the recommended starting point when the user has not yet specified a property: every account and property is returned in one response, so you can pick the right property_id for subsequent tools. Use name_contains to jump straight to a specific client without enumerating every account.

Args:
  - name_contains (string, optional): case-insensitive substring filter on account OR property display_name. Accounts with no matching property are dropped.
  - limit (number, default 50): max number of account summaries returned to you.
  - offset (number, default 0): pagination offset (applied client-side after filtering).
  - response_format ('markdown' | 'json', default 'markdown')

Returns:
  JSON shape:
  {
    "total": number,          // total accounts (after filter, before limit/offset)
    "total_before_filter": number, // total accounts fetched from the API
    "count": number,          // accounts in this response
    "offset": number,
    "accounts": [
      {
        "account_id": "12345678",
        "display_name": "Account name",
        "properties": [
          { "property_id": "987654321", "display_name": "Property name", "type": "PROPERTY_TYPE_ORDINARY" }
        ]
      }
    ]
  }

Examples:
  - "List all my GA4 accounts" → call with no parameters.
  - "Find the GA4 property for Nejlepší kočárky" → call with name_contains="kočárky".

Errors:
  - 403: the Google account has no Analytics access, or the Analytics Admin API is disabled.`,
      inputSchema: ListAccountSummariesInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      const input = ListAccountSummariesInputSchema.parse(rawInput) as ListAccountSummariesInput;
      try {
        // Auto-paginate: follow nextPageToken up to a safety cap of 50 pages × 200 = 10000 accounts.
        const aggregated: any[] = [];
        let pageToken: string | undefined;
        for (let pages = 0; pages < 50; pages++) {
          const data = await authenticatedRequest<{ accountSummaries?: any[]; nextPageToken?: string }>(
            auth,
            `${GA4_ADMIN_API_BASE}/accountSummaries`,
            { query: { pageSize: 200, ...(pageToken ? { pageToken } : {}) } },
          );
          if (data.accountSummaries) aggregated.push(...data.accountSummaries);
          if (!data.nextPageToken) break;
          pageToken = data.nextPageToken;
        }
        type AccountSummary = {
          account_id: string;
          display_name: string;
          properties: { property_id: string; display_name: string; type: string }[];
        };
        const all: AccountSummary[] = aggregated.map((s: any) => ({
          account_id: normalizeAccountId(s.account ?? ''),
          display_name: s.displayName ?? '',
          properties: (s.propertySummaries ?? []).map((p: any) => ({
            property_id: normalizePropertyId(p.property ?? ''),
            display_name: p.displayName ?? '',
            type: p.propertyType ?? '',
          })),
        }));

        let filtered: AccountSummary[] = all;
        if (input.name_contains) {
          const needle = input.name_contains.toLocaleLowerCase();
          filtered = all
            .map((acc): AccountSummary | null => {
              const accountMatches = acc.display_name.toLocaleLowerCase().includes(needle);
              const matchingProps = acc.properties.filter((p) =>
                p.display_name.toLocaleLowerCase().includes(needle),
              );
              if (accountMatches) return acc; // keep all properties when account itself matches
              if (matchingProps.length > 0) return { ...acc, properties: matchingProps };
              return null;
            })
            .filter((acc): acc is AccountSummary => acc !== null);
        }

        const sliced = filtered.slice(input.offset, input.offset + input.limit);
        const payload = {
          total: filtered.length,
          total_before_filter: all.length,
          count: sliced.length,
          offset: input.offset,
          accounts: sliced,
        };
        const text = renderPayload(payload, input.response_format, () => {
          if (sliced.length === 0) {
            if (input.name_contains) {
              return `_No GA4 account or property matches \`${input.name_contains}\` (scanned ${all.length} accounts)._`;
            }
            return '_No GA4 accounts accessible by this Google account._';
          }
          const headerSuffix = input.name_contains
            ? ` matching \`${input.name_contains}\` (${sliced.length} of ${filtered.length}, scanned ${all.length})`
            : ` (${sliced.length} of ${filtered.length})`;
          const lines: string[] = [`# GA4 Accounts${headerSuffix}`, ''];
          for (const acc of sliced) {
            lines.push(`## ${acc.display_name} (\`${acc.account_id}\`)`);
            if (acc.properties.length === 0) {
              lines.push('_No properties._');
            } else {
              for (const p of acc.properties) {
                lines.push(`- **${p.display_name}** – \`${p.property_id}\` (${p.type})`);
              }
            }
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
    'ga4_list_properties',
    {
      title: 'GA4 – list properties for an account',
      description: `List GA4 properties owned by a single account.

Use ga4_list_account_summaries first if you don't know the account_id. Use this tool when you need full property metadata (timezone, currency, industry, create time) that account summaries do not include.

Args:
  - account_id (string, required): GA4 account ID, with or without "accounts/" prefix
  - show_deleted (boolean, default false): include soft-deleted properties
  - limit (number, default 50)
  - offset (number, default 0)
  - response_format ('markdown' | 'json', default 'markdown')

Returns:
  {
    "total": number,
    "properties": [
      { "property_id": "...", "display_name": "...", "time_zone": "...", "currency_code": "...", "industry_category": "...", "create_time": "..." }
    ]
  }`,
      inputSchema: ListPropertiesInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (rawInput) => {
      const input = ListPropertiesInputSchema.parse(rawInput) as ListPropertiesInput;
      try {
        const filter = `parent:accounts/${normalizeAccountId(input.account_id)}`;
        const data = await authenticatedRequest<{ properties?: any[] }>(auth, `${GA4_ADMIN_API_BASE}/properties`, {
          query: { filter, showDeleted: input.show_deleted, pageSize: 200 },
        });
        const all = (data.properties ?? []).map((p: any) => ({
          property_id: normalizePropertyId(p.name ?? ''),
          display_name: p.displayName ?? '',
          time_zone: p.timeZone ?? '',
          currency_code: p.currencyCode ?? '',
          industry_category: p.industryCategory ?? '',
          create_time: p.createTime ?? '',
          property_type: p.propertyType ?? '',
        }));
        const sliced = all.slice(input.offset, input.offset + input.limit);
        const payload = { total: all.length, count: sliced.length, offset: input.offset, properties: sliced };
        const text = renderPayload(payload, input.response_format, () => {
          if (sliced.length === 0) return '_No properties found for this account._';
          const lines: string[] = [`# GA4 Properties – account ${normalizeAccountId(input.account_id)}`, ''];
          for (const p of sliced) {
            lines.push(`## ${p.display_name} (\`${p.property_id}\`)`);
            lines.push(`- Timezone: ${p.time_zone}`);
            lines.push(`- Currency: ${p.currency_code}`);
            if (p.industry_category) lines.push(`- Industry: ${p.industry_category}`);
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
    'ga4_get_property',
    {
      title: 'GA4 – get property metadata',
      description: `Fetch full metadata for a single GA4 property: display name, parent account, timezone, currency code, industry category, create time, property type.

Use this when you need to confirm a property's timezone or currency before interpreting report data.

Args:
  - property_id (string, required)
  - response_format ('markdown' | 'json', default 'markdown')`,
      inputSchema: GetPropertyInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (rawInput) => {
      const input = GetPropertyInputSchema.parse(rawInput) as GetPropertyInput;
      try {
        const id = normalizePropertyId(input.property_id);
        const data = await authenticatedRequest<any>(auth, `${GA4_ADMIN_API_BASE}/properties/${id}`);
        const payload = {
          property_id: id,
          display_name: data.displayName ?? '',
          parent: data.parent ?? '',
          time_zone: data.timeZone ?? '',
          currency_code: data.currencyCode ?? '',
          industry_category: data.industryCategory ?? '',
          property_type: data.propertyType ?? '',
          create_time: data.createTime ?? '',
          update_time: data.updateTime ?? '',
        };
        const text = renderPayload(payload, input.response_format, () => {
          const lines = [
            `# GA4 Property: ${payload.display_name} (\`${payload.property_id}\`)`,
            '',
            `- Parent: ${payload.parent}`,
            `- Timezone: ${payload.time_zone}`,
            `- Currency: ${payload.currency_code}`,
          ];
          if (payload.industry_category) lines.push(`- Industry: ${payload.industry_category}`);
          if (payload.property_type) lines.push(`- Type: ${payload.property_type}`);
          if (payload.create_time) lines.push(`- Created: ${payload.create_time}`);
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
    'ga4_run_report',
    {
      title: 'GA4 – run a custom analytics report',
      description: `Run an arbitrary GA4 report against the Data API (the workhorse tool for analytics questions).

You combine dimensions and metrics across one or more date ranges, optionally filter and order, and the API returns aggregated rows. The tool flattens the GA4 response into a simple list of objects keyed by dimension/metric name.

Args:
  - property_id (string, required): GA4 property to query
  - dimensions (array of {name}, default []): up to 9 dimensions, e.g. [{"name":"date"},{"name":"country"}]
  - metrics (array of {name}, required): 1-10 metrics, e.g. [{"name":"sessions"},{"name":"totalUsers"},{"name":"bounceRate"}]
  - date_ranges (array, required): 1-4 ranges, each {start_date, end_date, name?}; dates are YYYY-MM-DD or "today" / "yesterday" / "NdaysAgo"
  - dimension_filter (object, optional): GA4 FilterExpression on dimensions
  - metric_filter (object, optional): GA4 FilterExpression on metrics
  - order_bys (array, optional): each {metric_name | dimension_name, desc}
  - limit (number, default 100, max 100000)
  - offset (number, default 0)
  - keep_empty_rows (boolean, default false)
  - response_format ('markdown' | 'json', default 'markdown')

Returns (json):
  {
    "property_id": "...",
    "date_ranges": [...],
    "dimensions": ["date", "country"],
    "metrics": [{ "name": "sessions", "type": "TYPE_INTEGER" }, ...],
    "rows": [{ "date": "20250101", "country": "United States", "sessions": "123" }, ...],
    "totals": { "sessions": "1000" },
    "total_row_count": 42,
    "row_count_returned": 42,
    "truncated": false
  }

Examples:
  - "Sessions by day for the last 30 days":
      dimensions=[{"name":"date"}], metrics=[{"name":"sessions"}], date_ranges=[{"start_date":"30daysAgo","end_date":"yesterday"}]
  - "Top 20 landing pages by sessions yesterday":
      dimensions=[{"name":"landingPage"}], metrics=[{"name":"sessions"}], date_ranges=[{"start_date":"yesterday","end_date":"yesterday"}], order_bys=[{"metric_name":"sessions","desc":true}], limit=20
  - "Czechia traffic only":
      Add dimension_filter: {"filter":{"fieldName":"country","stringFilter":{"value":"Czechia"}}}

Errors:
  - 400: invalid dimension/metric name → use ga4_get_metadata to discover valid names.
  - 403: no access to property → verify property_id and that the Google account has a role on it.

Truncation:
  Large responses are truncated to fit ~25000 characters; the tool reports total_row_count vs row_count_returned.`,
      inputSchema: RunReportInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (rawInput) => {
      const input = RunReportInputSchema.parse(rawInput) as RunReportInput;
      try {
        const id = normalizePropertyId(input.property_id);
        const body = buildReportBody(input, true);
        const raw = await authenticatedRequest<RawReportResponse>(
          auth,
          `${GA4_DATA_API_BASE}/properties/${id}:runReport`,
          { method: 'POST', body },
        );
        const flat = flattenReport(raw);
        const dateRangeLabel = input.date_ranges.map((r) => `${r.start_date} → ${r.end_date}`).join(', ');
        const payload = {
          property_id: id,
          date_ranges: input.date_ranges,
          dimensions: flat.dimensions,
          metrics: flat.metrics,
          rows: flat.rows,
          totals: flat.totals,
          total_row_count: flat.total_row_count,
          row_count_returned: flat.rows.length,
          truncated: false,
        };
        const initial = renderPayload(payload, input.response_format, () =>
          reportToMarkdown({ title: 'GA4 Report', property_id: id, date_range_label: dateRangeLabel, flat }),
        );
        const finalText = maybeTruncateReport(initial, flat, input.response_format);
        return { content: [{ type: 'text', text: finalText }], structuredContent: payload };
      } catch (error) {
        return { content: [{ type: 'text', text: handleApiError(error, GOOGLE_API_HINTS) }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    'ga4_run_realtime_report',
    {
      title: 'GA4 – run a realtime report',
      description: `Query GA4 realtime data (events from the last 30 minutes).

Use this for "right now" questions: active users by country, top events firing now, traffic from a campaign that just launched. For historical analysis, use ga4_run_report instead.

Args:
  - property_id (string, required)
  - dimensions (array of {name}, default []): realtime-supported dimensions, e.g. [{"name":"country"},{"name":"deviceCategory"}]
  - metrics (array of {name}, required): typically [{"name":"activeUsers"}]
  - dimension_filter, metric_filter, order_bys: same shape as ga4_run_report
  - limit (number, default 100)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: same shape as ga4_run_report (without date_ranges).`,
      inputSchema: RunRealtimeReportInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (rawInput) => {
      const input = RunRealtimeReportInputSchema.parse(rawInput) as RunRealtimeReportInput;
      try {
        const id = normalizePropertyId(input.property_id);
        const body = buildReportBody(input, false);
        const raw = await authenticatedRequest<RawReportResponse>(
          auth,
          `${GA4_DATA_API_BASE}/properties/${id}:runRealtimeReport`,
          { method: 'POST', body },
        );
        const flat = flattenReport(raw);
        const payload = {
          property_id: id,
          dimensions: flat.dimensions,
          metrics: flat.metrics,
          rows: flat.rows,
          totals: flat.totals,
          total_row_count: flat.total_row_count,
          row_count_returned: flat.rows.length,
          truncated: false,
        };
        const initial = renderPayload(payload, input.response_format, () =>
          reportToMarkdown({ title: 'GA4 Realtime Report', property_id: id, flat }),
        );
        const finalText = maybeTruncateReport(initial, flat, input.response_format);
        return { content: [{ type: 'text', text: finalText }], structuredContent: payload };
      } catch (error) {
        return { content: [{ type: 'text', text: handleApiError(error, GOOGLE_API_HINTS) }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    'ga4_get_metadata',
    {
      title: 'GA4 – list available dimensions and metrics',
      description: `List all dimensions and metrics available for a GA4 property, including custom definitions.

Use this before ga4_run_report when you're unsure whether a dimension/metric exists or what its exact API name is. Custom dimensions/metrics are property-specific and only appear here for the queried property.

Args:
  - property_id (string, required): use "0" or "properties/0" for the universal (default) metadata
  - response_format ('markdown' | 'json', default 'markdown')

Returns:
  {
    "property_id": "...",
    "dimensions": [
      { "api_name": "country", "ui_name": "Country", "description": "...", "category": "Geography", "custom_definition": false }
    ],
    "metrics": [
      { "api_name": "sessions", "ui_name": "Sessions", "type": "TYPE_INTEGER", "category": "...", "custom_definition": false }
    ]
  }`,
      inputSchema: GetMetadataInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (rawInput) => {
      const input = GetMetadataInputSchema.parse(rawInput) as GetMetadataInput;
      try {
        const id = normalizePropertyId(input.property_id);
        const data = await authenticatedRequest<any>(auth, `${GA4_DATA_API_BASE}/properties/${id}/metadata`);
        const dimensions = (data.dimensions ?? []).map((d: any) => ({
          api_name: d.apiName,
          ui_name: d.uiName ?? '',
          description: d.description ?? '',
          category: d.category ?? '',
          custom_definition: Boolean(d.customDefinition),
        }));
        const metrics = (data.metrics ?? []).map((m: any) => ({
          api_name: m.apiName,
          ui_name: m.uiName ?? '',
          description: m.description ?? '',
          type: m.type ?? '',
          category: m.category ?? '',
          custom_definition: Boolean(m.customDefinition),
        }));
        const payload = { property_id: id, dimensions, metrics };
        const text = renderPayload(payload, input.response_format, () => {
          const lines: string[] = [`# GA4 Metadata for property \`${id}\``, ''];
          lines.push(`## Dimensions (${dimensions.length})`, '');
          for (const d of dimensions) {
            lines.push(`- \`${d.api_name}\` (${d.ui_name})${d.custom_definition ? ' [custom]' : ''} – ${d.category}`);
          }
          lines.push('', `## Metrics (${metrics.length})`, '');
          for (const m of metrics) {
            lines.push(`- \`${m.api_name}\` (${m.ui_name}, ${m.type})${m.custom_definition ? ' [custom]' : ''} – ${m.category}`);
          }
          return lines.join('\n');
        });
        // Metadata responses can be large; apply a simple truncation.
        if (text.length > CHARACTER_LIMIT) {
          const half = Math.max(20, Math.floor(dimensions.length / 2));
          const halfM = Math.max(20, Math.floor(metrics.length / 2));
          const reduced = {
            ...payload,
            dimensions: dimensions.slice(0, half),
            metrics: metrics.slice(0, halfM),
          };
          const note = truncationMessage({
            returned: half + halfM,
            total: dimensions.length + metrics.length,
            suggestion: 'Re-run with response_format="json" or filter results client-side.',
          });
          return {
            content: [{ type: 'text', text: `${asJson(reduced)}\n\n[TRUNCATED] ${note}` }],
            structuredContent: payload,
          };
        }
        return { content: [{ type: 'text', text }], structuredContent: payload };
      } catch (error) {
        return { content: [{ type: 'text', text: handleApiError(error, GOOGLE_API_HINTS) }], isError: true };
      }
    },
  );
}
