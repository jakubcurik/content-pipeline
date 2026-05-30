import { z } from 'zod';

/** Output format option exposed on every tool that returns data. */
export enum ResponseFormat {
  MARKDOWN = 'markdown',
  JSON = 'json',
}

export const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Output format: 'markdown' for human-readable rendering (default) or 'json' for machine-readable structured data.",
  );

/** Pagination shape used by list-style tools. */
export const PaginationFields = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(50)
    .describe('Maximum number of items to return (1-1000, default 50).'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Number of items to skip for pagination (default 0).'),
};

/** Strict YYYY-MM-DD date matcher (used by GSC, Google Ads, Meta Ads). */
export const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GA4 also accepts relative dates such as `7daysAgo`, `yesterday`, `today`.
 * Tools targeting GA4 should reuse this looser matcher.
 */
export const ga4DateRegex = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/;
