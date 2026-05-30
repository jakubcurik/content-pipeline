import { z } from 'zod';
import { ga4DateRegex, PaginationFields, ResponseFormatSchema } from '../shared/schemas/common.js';

/**
 * GA4 property identifier. Accepts either bare `123456789` or the prefixed
 * form `properties/123456789` for convenience.
 */
export const PropertyIdSchema = z
  .string()
  .min(1)
  .regex(/^(properties\/)?\d+$/, 'property_id must be a numeric GA4 property ID (with or without "properties/" prefix)')
  .describe('GA4 property ID, e.g. "123456789" or "properties/123456789".');

const Ga4DateString = z
  .string()
  .regex(
    ga4DateRegex,
    'Date must be YYYY-MM-DD or a relative form like "today", "yesterday", or "NdaysAgo".',
  );

const Ga4DateRangeSchema = z
  .object({
    start_date: Ga4DateString.describe(
      'Start date – YYYY-MM-DD, "today", "yesterday", or "NdaysAgo" (e.g. "7daysAgo").',
    ),
    end_date: Ga4DateString.describe('End date in the same formats as start_date (inclusive).'),
    name: z.string().optional().describe('Optional label for this date range (used in comparison reports).'),
  })
  .strict();

const NamedItemSchema = z.object({ name: z.string().min(1) }).strict();

const Ga4OrderBySchema = z
  .object({
    metric_name: z.string().optional().describe('Order by this metric.'),
    dimension_name: z.string().optional().describe('Order by this dimension (mutually exclusive with metric_name).'),
    desc: z.boolean().default(false).describe('Sort descending if true (default false).'),
  })
  .strict()
  .refine(
    (v) => Boolean(v.metric_name) !== Boolean(v.dimension_name),
    'Provide exactly one of metric_name or dimension_name.',
  );

/**
 * Pass-through GA4 FilterExpression JSON. Supports the same shape as the GA4
 * Data API: { andGroup }, { orGroup }, { notExpression }, or { filter: { ... } }.
 * See https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/FilterExpression.
 */
const FilterExpressionSchema: z.ZodType<Record<string, unknown>> = z.record(z.unknown());

export const RunReportInputSchema = z
  .object({
    property_id: PropertyIdSchema,
    dimensions: z
      .array(NamedItemSchema)
      .max(9)
      .default([])
      .describe('Dimensions to break down by, e.g. [{ "name": "country" }]. Up to 9.'),
    metrics: z
      .array(NamedItemSchema)
      .min(1)
      .max(10)
      .describe('Metrics to retrieve, e.g. [{ "name": "sessions" }, { "name": "totalUsers" }]. 1-10 required.'),
    date_ranges: z
      .array(Ga4DateRangeSchema)
      .min(1)
      .max(4)
      .describe('One to four date ranges. Most reports use a single range.'),
    dimension_filter: FilterExpressionSchema.optional().describe(
      'GA4 FilterExpression on dimensions. Example: {"filter": {"fieldName": "country", "stringFilter": {"value": "Czechia"}}}.',
    ),
    metric_filter: FilterExpressionSchema.optional().describe(
      'GA4 FilterExpression on metrics. Example: {"filter": {"fieldName": "sessions", "numericFilter": {"operation": "GREATER_THAN", "value": {"int64Value": "10"}}}}.',
    ),
    order_bys: z
      .array(Ga4OrderBySchema)
      .max(10)
      .optional()
      .describe('Sort order. Default is no sort (API returns rows in arbitrary order).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(100)
      .describe('Maximum rows to return per page (default 100, max 100000).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Row offset for pagination (default 0).'),
    keep_empty_rows: z
      .boolean()
      .default(false)
      .describe('If true, return rows with all-zero metric values (default false).'),
    response_format: ResponseFormatSchema,
  })
  .strict();

export type RunReportInput = z.infer<typeof RunReportInputSchema>;

export const RunRealtimeReportInputSchema = z
  .object({
    property_id: PropertyIdSchema,
    dimensions: z
      .array(NamedItemSchema)
      .max(9)
      .default([])
      .describe('Realtime dimensions, e.g. [{ "name": "country" }, { "name": "deviceCategory" }].'),
    metrics: z
      .array(NamedItemSchema)
      .min(1)
      .max(10)
      .describe('Realtime metrics, e.g. [{ "name": "activeUsers" }].'),
    dimension_filter: FilterExpressionSchema.optional().describe('GA4 FilterExpression on dimensions.'),
    metric_filter: FilterExpressionSchema.optional().describe('GA4 FilterExpression on metrics.'),
    order_bys: z.array(Ga4OrderBySchema).max(10).optional().describe('Sort order.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(100)
      .describe('Maximum rows to return (default 100).'),
    response_format: ResponseFormatSchema,
  })
  .strict();

export type RunRealtimeReportInput = z.infer<typeof RunRealtimeReportInputSchema>;

export const ListAccountSummariesInputSchema = z
  .object({
    name_contains: z
      .string()
      .optional()
      .describe(
        'Optional case-insensitive substring filter applied to both account display_name and property display_name. Accounts with no matching properties are dropped; partial matches at the property level keep the account but list only matching properties. Applied client-side after fetching up to 200 summaries.',
      ),
    ...PaginationFields,
    response_format: ResponseFormatSchema,
  })
  .strict();

export type ListAccountSummariesInput = z.infer<typeof ListAccountSummariesInputSchema>;

export const ListPropertiesInputSchema = z
  .object({
    account_id: z
      .string()
      .regex(/^(accounts\/)?\d+$/, 'account_id must be numeric (with or without "accounts/" prefix).')
      .describe('GA4 account ID, e.g. "12345678" or "accounts/12345678".'),
    show_deleted: z
      .boolean()
      .default(false)
      .describe('Include soft-deleted properties (default false).'),
    ...PaginationFields,
    response_format: ResponseFormatSchema,
  })
  .strict();

export type ListPropertiesInput = z.infer<typeof ListPropertiesInputSchema>;

export const GetPropertyInputSchema = z
  .object({
    property_id: PropertyIdSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

export type GetPropertyInput = z.infer<typeof GetPropertyInputSchema>;

export const GetMetadataInputSchema = z
  .object({
    property_id: PropertyIdSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

export type GetMetadataInput = z.infer<typeof GetMetadataInputSchema>;
