import { CHARACTER_LIMIT } from './constants.js';
import { ResponseFormat } from './schemas/common.js';

/**
 * Render a structured payload according to the requested format.
 *
 * - `markdown`: invokes the supplied `toMarkdown` callback (allows tools to
 *   craft a tailored, human-readable view).
 * - `json`: pretty-prints the payload with 2-space indentation.
 */
export function renderPayload(
  payload: unknown,
  format: ResponseFormat,
  toMarkdown: () => string,
): string {
  return format === ResponseFormat.MARKDOWN ? toMarkdown() : asJson(payload);
}

/** Pretty-print a value as JSON with 2-space indentation. */
export function asJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/** True if a rendered response would overflow the per-tool character limit. */
export function exceedsLimit(text: string): boolean {
  return text.length > CHARACTER_LIMIT;
}

/**
 * Build a standard truncation note suitable for appending to a response or
 * embedding in the structured payload.
 */
export function truncationMessage(args: {
  returned: number;
  total: number;
  suggestion: string;
}): string {
  return `Response truncated: returned ${args.returned} of ${args.total} items. ${args.suggestion}`;
}
