import { fetchWithRetry, extractMainContent, extractTitle, normalizeUrl, isContentLink } from "../utils/index.js";
import type { CrawlParams } from "./types.js";

const CRAWL_CONCURRENCY = 3;

interface CrawlResult {
  url: string;
  title: string;
  text: string;
  depth: number;
  wordCount: number;
}

async function fetchPage(url: string): Promise<{ html: string; url: string } | null> {
  try {
    const response = await fetchWithRetry(url, { timeout: 15000, maxRedirects: 3 });
    if (typeof response.data !== "string") return null;
    return { html: response.data, url };
  } catch {
    return null;
  }
}

export async function novadaCrawl(params: CrawlParams): Promise<string> {
  const maxPages = Math.min(params.max_pages || 5, 20);
  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [
    { url: params.url, depth: 0 },
  ];
  const results: CrawlResult[] = [];
  const baseHostname = new URL(params.url).hostname.replace(/^www\./, "");

  while (queue.length > 0 && results.length < maxPages) {
    // Take up to CRAWL_CONCURRENCY items from queue
    const batch: { url: string; depth: number }[] = [];
    while (batch.length < CRAWL_CONCURRENCY && queue.length > 0 && results.length + batch.length < maxPages) {
      const item = params.strategy === "dfs" ? queue.pop()! : queue.shift()!;
      const normalizedUrl = normalizeUrl(item.url);
      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);
      batch.push(item);
    }

    if (batch.length === 0) break;

    // Fetch pages concurrently
    const pages = await Promise.all(batch.map((item) => fetchPage(item.url)));

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (!page) continue;

      const title = extractTitle(page.html);
      const text = extractMainContent(page.html).slice(0, 3000);
      const wordCount = text.split(/\s+/).filter(Boolean).length;

      if (wordCount < 20) continue;

      results.push({ url: batch[i].url, title, text, depth: batch[i].depth, wordCount });

      // Discover same-domain content links
      const linkMatches = page.html.matchAll(/href=["'](https?:\/\/[^"'#]+)["']/gi);
      for (const match of linkMatches) {
        try {
          const linkUrl = new URL(match[1]);
          const linkHostname = linkUrl.hostname.replace(/^www\./, "");
          const normalizedLink = normalizeUrl(linkUrl.href);
          if (
            linkHostname === baseHostname &&
            !visited.has(normalizedLink) &&
            isContentLink(linkUrl.href)
          ) {
            queue.push({ url: linkUrl.href, depth: batch[i].depth + 1 });
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }
  }

  if (results.length === 0) {
    return `Failed to crawl ${params.url}. The site may be unreachable or blocking automated access.`;
  }

  const totalWords = results.reduce((sum, r) => sum + r.wordCount, 0);
  const stoppedEarly = results.length < maxPages;
  const stopReason = stoppedEarly
    ? queue.length === 0
      ? "No more same-domain links to follow."
      : "Remaining links were filtered (assets, auth pages, or already visited)."
    : "";

  return [
    `# Crawl Results for ${params.url}`,
    `\nPages crawled: ${results.length}/${maxPages} | Strategy: ${params.strategy || "bfs"} | Total words: ${totalWords}`,
    stoppedEarly ? `\n*Stopped early: ${stopReason}*\n` : "\n",
    ...results.map(
      (r) =>
        `## ${r.title}\n**URL:** ${r.url} | **Depth:** ${r.depth} | **Words:** ${r.wordCount}\n\n${r.text}\n`
    ),
  ].join("\n");
}
