/**
 * Turning API responses into tool results that fit in a model's context.
 *
 * Lists are kept under CHARACTER_LIMIT by returning fewer items, and the footer
 * says exactly how to fetch the items left out. A single item or a non-list
 * response that is still too large is cut, with a marker saying so.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { MAX_DOWNLOAD_BYTES, type ApiResponse, type PaginationMeta } from "./api.js";

export const CHARACTER_LIMIT = 25_000;

export function text(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }] };
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 1);
}

function cut(body: string): string {
  if (body.length <= CHARACTER_LIMIT) return body;
  return `${body.slice(0, CHARACTER_LIMIT)}\n\n[Cut at ${CHARACTER_LIMIT} of ${body.length} characters. Ask for something narrower, e.g. one sub-resource.]`;
}

/**
 * The page/per_page to ask for next when only `shown` of this page's items were
 * returned: the largest per_page <= shown that puts a page boundary exactly at
 * the first item left out, so nothing is skipped or repeated.
 */
export function resumeAfterTrim(page: number, perPage: number, shown: number): { page: number; per_page: number } {
  const nextOffset = (page - 1) * perPage + shown;
  for (let n = Math.min(shown, 100); n >= 1; n--) {
    if (nextOffset % n === 0) return { page: nextOffset / n + 1, per_page: n };
  }
  return { page: nextOffset + 1, per_page: 1 };
}

function pageFooter(meta: PaginationMeta | undefined, shown: number, returned: number): string {
  const page = typeof meta?.page === "number" ? meta.page : undefined;
  const perPage = typeof meta?.per_page === "number" ? meta.per_page : undefined;
  const lines: string[] = [];
  if (page !== undefined) {
    const { total, total_pages } = meta!;
    lines.push(`Page ${page}${total_pages ? ` of ${total_pages}` : ""}${total !== undefined ? `, ${total} items in total` : ""}, ${perPage ?? "?"} per page.`);
  }
  if (shown < returned) {
    lines.push(`Only ${shown} of the ${returned} items on this page are shown, to stay within the size limit.`);
    if (page !== undefined && perPage !== undefined) {
      const next = resumeAfterTrim(page, perPage, shown);
      lines.push(`To continue without skipping any, call again with page=${next.page}, per_page=${next.per_page}.`);
    } else {
      lines.push("Ask for fewer results per page to see the rest.");
    }
  } else if (page !== undefined && meta?.total_pages && page < meta.total_pages) {
    lines.push(`More results: call again with page=${page + 1}.`);
  }
  return lines.join("\n");
}

/** Render any API response. */
export function render(res: ApiResponse, label: string): CallToolResult {
  if (res.kind === "json") {
    const { data, meta } = res;
    if (Array.isArray(data)) {
      if (data.length === 0) {
        const footer = pageFooter(meta, 0, 0);
        return text(`${label}: no results.${footer && meta?.total ? `\n${footer}` : ""}`);
      }
      let items = data;
      let body = stringify(items);
      while (items.length > 1 && body.length > CHARACTER_LIMIT) {
        items = items.slice(0, Math.ceil(items.length / 2));
        body = stringify(items);
      }
      const footer = pageFooter(meta, items.length, data.length);
      body = cut(body);
      return text(footer ? `${body}\n\n${footer}` : body);
    }
    const extra = meta && Object.keys(meta).length ? `\n\nmeta: ${JSON.stringify(meta)}` : "";
    return text(cut(stringify(data)) + extra);
  }

  if (res.kind === "text") {
    return text(cut(res.text) || `${label}: empty response (HTTP ${res.status}).`);
  }

  const name = res.filename ?? "download";
  if (res.tooLarge) {
    const size = res.size ? ` (${(res.size / 1024 / 1024).toFixed(1)} MB)` : "";
    return text(`${label}: ${name}${size} is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB, the most that can be returned through MCP.`);
  }
  const data = Buffer.from(res.bytes).toString("base64");
  const info = { type: "text" as const, text: `${label}: ${name} (${res.contentType}, ${(res.bytes.byteLength / 1024).toFixed(1)} KB)` };
  if (res.contentType.startsWith("image/")) {
    return { content: [info, { type: "image", data, mimeType: res.contentType }] };
  }
  return {
    content: [info, { type: "resource", resource: { uri: `freeitsm:///${encodeURIComponent(name)}`, mimeType: res.contentType, blob: data } }],
  };
}
