import { z } from 'zod';
import { isoDateRegex, ResponseFormatSchema } from '../shared/schemas/common.js';

/**
 * Search Console site URL. Accepts either a domain property
 * (`sc-domain:example.com`) or an URL-prefix property
 * (`https://example.com/`).
 */
export const SiteUrlSchema = z
  .string()
  .min(1)
  .describe(
    'Search Console site URL. Use the URL-prefix form ("https://example.com/") or the domain form ("sc-domain:example.com").',
  );

const IsoDate = z.string().regex(isoDateRegex, 'Date must be YYYY-MM-DD.');

const GscDimension = z.enum(['query', 'page', 'country', 'device', 'searchAppearance', 'date']);

const GscFilterOperator = z.enum([
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'includingRegex',
  'excludingRegex',
]);

const GscFilterSchema = z
  .object({
    dimension: GscDimension.describe('Dimension to filter on.'),
    operator: GscFilterOperator.default('equals').describe('Comparison operator (default "equals").'),
    expression: z.string().min(1).describe('Value to compare against (string or regex depending on operator).'),
  })
  .strict();

const GscFilterGroupSchema = z
  .object({
    group_type: z.enum(['and']).default('and').describe('Currently only "and" groups are supported by GSC.'),
    filters: z.array(GscFilterSchema).min(1).max(20).describe('Filters within this group (AND-joined).'),
  })
  .strict();

/**
 * Shape literal exposed for `registerTool({ inputSchema })`. The MCP SDK
 * expects a `ZodRawShape` (record of fields), not a wrapped ZodObject.
 */
export const QuerySearchAnalyticsInputShape = {
  site_url: SiteUrlSchema,
  start_date: IsoDate.describe('Start date (YYYY-MM-DD, inclusive). GSC data has a 2-3 day lag.'),
  end_date: IsoDate.describe('End date (YYYY-MM-DD, inclusive).'),
  dimensions: z
    .array(GscDimension)
    .max(6)
    .default([])
    .describe('Dimensions to break down by, in order. Empty array returns site-level totals.'),
  type: z
    .enum(['web', 'image', 'video', 'news', 'discover', 'googleNews'])
    .default('web')
    .describe('Search type (default "web").'),
  dimension_filter_groups: z
    .array(GscFilterGroupSchema)
    .max(5)
    .optional()
    .describe('Filter groups (AND-joined across groups, AND-joined within a group).'),
  aggregation_type: z
    .enum(['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'])
    .default('auto')
    .describe('How to aggregate when dimensions are limited.'),
  row_limit: z
    .number()
    .int()
    .min(1)
    .max(25_000)
    .default(1_000)
    .describe('Max rows per request (default 1000, max 25000).'),
  start_row: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Row offset for pagination (default 0).'),
  response_format: ResponseFormatSchema,
} as const;

/** Full schema (with cross-field refinement) used inside the tool handler. */
export const QuerySearchAnalyticsInputSchema = z
  .object(QuerySearchAnalyticsInputShape)
  .strict()
  .refine((v) => v.start_date <= v.end_date, 'start_date must be on or before end_date.');

export type QuerySearchAnalyticsInput = z.infer<typeof QuerySearchAnalyticsInputSchema>;

export const ListSitesInputSchema = z
  .object({
    response_format: ResponseFormatSchema,
  })
  .strict();

export type ListSitesInput = z.infer<typeof ListSitesInputSchema>;

export const ListSitemapsInputSchema = z
  .object({
    site_url: SiteUrlSchema,
    sitemap_index: z
      .string()
      .url()
      .optional()
      .describe('Optional sitemap index URL – list only sitemaps inside this index.'),
    response_format: ResponseFormatSchema,
  })
  .strict();

export type ListSitemapsInput = z.infer<typeof ListSitemapsInputSchema>;

export const GetSitemapInputSchema = z
  .object({
    site_url: SiteUrlSchema,
    sitemap_url: z.string().url().describe('Full sitemap URL (must be absolute http(s) URL).'),
    response_format: ResponseFormatSchema,
  })
  .strict();

export type GetSitemapInput = z.infer<typeof GetSitemapInputSchema>;

export const InspectUrlInputSchema = z
  .object({
    site_url: SiteUrlSchema,
    inspection_url: z.string().url().describe('URL to inspect (must belong to the site_url property).'),
    language_code: z
      .string()
      .min(2)
      .max(10)
      .default('en-US')
      .describe('BCP-47 language code for human-readable strings (default "en-US").'),
    response_format: ResponseFormatSchema,
  })
  .strict();

export type InspectUrlInput = z.infer<typeof InspectUrlInputSchema>;
