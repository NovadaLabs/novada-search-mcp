#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";

// ─── Configuration ───────────────────────────────────────────────────────────

const API_KEY = process.env.NOVADA_API_KEY;
const SCRAPER_API_BASE = "https://scraperapi.novada.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

// ─── Utility Functions ───────────────────────────────────────────────────────

/** Normalize a URL for deduplication: strip trailing slash, www, fragment, sort params */
function normalizeUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    u.hash = "";
    u.hostname = u.hostname.replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, "") || "/";
    u.pathname = path;
    u.searchParams.sort();
    return u.toString();
  } catch {
    return urlStr;
  }
}

/** Filter out boilerplate links (assets, tracking, auth, etc.) */
function isContentLink(href: string, pageHostname: string): boolean {
  try {
    const u = new URL(href);
    const ext = u.pathname.split(".").pop()?.toLowerCase() || "";
    const assetExts = [
      "css", "js", "png", "jpg", "jpeg", "gif", "svg", "ico", "woff", "woff2",
      "ttf", "eot", "map", "xml", "rss", "atom", "json",
    ];
    if (assetExts.includes(ext)) return false;

    const boilerplateHosts = [
      "fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net",
      "cdnjs.cloudflare.com", "unpkg.com", "ajax.googleapis.com",
      "github.githubassets.com", "avatars.githubusercontent.com",
      "collector.github.com", "api.github.com",
      "googletagmanager.com", "google-analytics.com", "facebook.com",
      "twitter.com", "linkedin.com",
    ];
    if (boilerplateHosts.some((h) => u.hostname.includes(h))) return false;

    // Skip login/auth/settings paths
    const skipPaths = ["/login", "/signup", "/auth", "/oauth", "/settings"];
    if (skipPaths.some((p) => u.pathname.startsWith(p))) return false;

    return true;
  } catch {
    return false;
  }
}

/** Extract main content using a readability-like approach */
function extractMainContent(html: string): string {
  // Remove non-content elements
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Try to find main content area
  const contentSelectors = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*(?:class|id)=["'][^"']*(?:content|article|post|entry|main|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let mainContent = "";
  for (const selector of contentSelectors) {
    const match = cleaned.match(selector);
    if (match && match[1] && match[1].length > 200) {
      mainContent = match[1];
      break;
    }
  }

  // Fallback: remove nav, header, footer, sidebar, then use body
  if (!mainContent) {
    mainContent = cleaned
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
      .replace(/<div[^>]*(?:class|id)=["'][^"']*(?:sidebar|menu|nav|footer|header|cookie|banner|popup|modal|ad-|advertisement)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "");
  }

  // Convert some HTML to markdown-like text
  mainContent = mainContent
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => {
      const prefix = "#".repeat(parseInt(level));
      return `\n${prefix} ${text.replace(/<[^>]+>/g, "").trim()}\n`;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => `- ${text.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, text) => `\n${text.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return mainContent.slice(0, 8000);
}

/** HTTP request with exponential backoff retry */
async function fetchWithRetry(
  url: string,
  options: Partial<AxiosRequestConfig> = {},
  retries: number = MAX_RETRIES
): Promise<AxiosResponse> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, {
        headers: { "User-Agent": USER_AGENT },
        timeout: 30000,
        maxRedirects: 5,
        ...options,
      });
    } catch (error) {
      if (attempt === retries) throw error;
      const isRetryable =
        error instanceof AxiosError &&
        (error.response?.status === 429 ||
          error.response?.status === 503 ||
          !error.response);
      if (!isRetryable) throw error;
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`Failed after ${retries + 1} attempts: ${url}`);
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "novada_search",
    description:
      "Search the web using Novada's Scraper API. Returns structured search results from Google, Bing, and other engines. Use for finding current information, news, facts, or data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query string",
        },
        engine: {
          type: "string",
          description: "Search engine to use. Google is recommended for best relevance. Bing results may vary in quality.",
          enum: ["google", "bing", "duckduckgo", "yahoo", "yandex"],
          default: "google",
        },
        num: {
          type: "number",
          description: "Number of results to return (1-20)",
          default: 10,
          minimum: 1,
          maximum: 20,
        },
        country: {
          type: "string",
          description:
            "Country code for localized results (e.g., 'us', 'uk', 'de')",
          default: "",
        },
        language: {
          type: "string",
          description: "Language code for results (e.g., 'en', 'zh', 'de')",
          default: "",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "novada_extract",
    description:
      "Extract content from a single URL. Returns the page title, description, main text content, and meaningful links. Uses readability-based extraction to get article body, not boilerplate. Note: works best with server-rendered pages; JavaScript-heavy SPAs may return incomplete content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to extract content from",
        },
        format: {
          type: "string",
          description: "Output format for the extracted content",
          enum: ["text", "markdown", "html"],
          default: "markdown",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "novada_crawl",
    description:
      "Crawl a website starting from a seed URL. Discovers and extracts content from multiple pages following links on the same domain. Note: static HTML crawling — JavaScript-rendered pages may return incomplete content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The seed URL to start crawling from",
        },
        max_pages: {
          type: "number",
          description: "Maximum number of pages to crawl (1-20)",
          default: 5,
          minimum: 1,
          maximum: 20,
        },
        strategy: {
          type: "string",
          description:
            "Crawl strategy: bfs (breadth-first) explores more pages at the same depth, dfs (depth-first) follows links deeper",
          enum: ["bfs", "dfs"],
          default: "bfs",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "novada_research",
    description:
      "Conduct multi-step web research on a topic. Generates diverse search queries, performs multiple searches, deduplicates sources, and returns a comprehensive report. Best for complex questions that need information from multiple angles.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description:
            "The research question or topic to investigate (minimum 5 characters)",
        },
        depth: {
          type: "string",
          description:
            "Research depth: 'quick' does 3 searches, 'deep' does 5-6 searches with more diverse angles",
          enum: ["quick", "deep"],
          default: "quick",
        },
      },
      required: ["question"],
    },
  },
];

// ─── Tool Parameter Types ────────────────────────────────────────────────────

interface SearchParams {
  query: string;
  engine?: string;
  num?: number;
  country?: string;
  language?: string;
}

interface ExtractParams {
  url: string;
  format?: string;
}

interface CrawlParams {
  url: string;
  max_pages?: number;
  strategy?: string;
}

interface ResearchParams {
  question: string;
  depth?: string;
}

// ─── Tool Implementations ────────────────────────────────────────────────────

async function novadaSearch(params: SearchParams): Promise<string> {
  if (!API_KEY) {
    throw new Error(
      "NOVADA_API_KEY is not set. Get your API key at https://www.novada.com and set it as an environment variable."
    );
  }

  const engine = params.engine || "google";
  const searchParams = new URLSearchParams({
    q: params.query,
    api_key: API_KEY,
    engine,
    num: String(params.num || 10),
  });

  // Fix Bing: force English locale to avoid irrelevant localized results
  if (engine === "bing") {
    searchParams.set("country", params.country || "us");
    searchParams.set("language", params.language || "en");
    searchParams.set("mkt", params.language ? `${params.language}-${(params.country || "us").toUpperCase()}` : "en-US");
  } else {
    if (params.country) searchParams.set("country", params.country);
    if (params.language) searchParams.set("language", params.language);
  }

  const response = await fetchWithRetry(
    `${SCRAPER_API_BASE}/search?${searchParams.toString()}`,
    {
      headers: {
        "User-Agent": USER_AGENT,
        Origin: "https://www.novada.com",
        Referer: "https://www.novada.com/",
      },
    }
  );

  const data = response.data;

  if (data.code && data.code !== 200 && data.code !== 0) {
    throw new Error(
      `Novada API error (code ${data.code}): ${data.msg || "Unknown error"}`
    );
  }

  const results = data.data?.organic_results || data.organic_results || [];
  if (results.length === 0) {
    return "No results found for this query.";
  }

  // Clean URLs: unwrap Bing redirect wrappers
  return results
    .map((r: any, i: number) => {
      let url = r.url || r.link || "N/A";
      // Bing wraps URLs in redirect or base64 encoding
      if (url.includes("bing.com/ck/a") || url.includes("r.bing.com")) {
        try {
          const u = new URL(url);
          const realUrl = u.searchParams.get("r") || u.searchParams.get("u");
          if (realUrl) {
            const cleaned = realUrl.replace(/^a1/, "");
            // Try base64 decode first, then URI decode
            try {
              url = Buffer.from(cleaned, "base64").toString("utf8");
              if (!url.startsWith("http")) url = decodeURIComponent(cleaned);
            } catch {
              url = decodeURIComponent(cleaned);
            }
          }
        } catch { /* keep original URL */ }
      }
      // Handle raw base64-encoded URLs (no wrapper)
      if (!url.startsWith("http") && /^[A-Za-z0-9+/=]+$/.test(url) && url.length > 20) {
        try {
          const decoded = Buffer.from(url, "base64").toString("utf8");
          if (decoded.startsWith("http")) url = decoded;
        } catch { /* keep original */ }
      }
      return `${i + 1}. **${r.title || "Untitled"}**\n   URL: ${url}\n   ${r.description || r.snippet || "No description"}`;
    })
    .join("\n\n");
}

async function novadaExtract(params: ExtractParams): Promise<string> {
  if (!API_KEY) {
    throw new Error(
      "NOVADA_API_KEY is not set. Get your API key at https://www.novada.com"
    );
  }

  const response = await fetchWithRetry(params.url);
  const html: string = response.data;

  if (typeof html !== "string") {
    throw new Error("Response is not HTML. The URL may return JSON or binary data.");
  }

  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "Untitled";
  const description =
    html.match(
      /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i
    )?.[1] || "";

  if (params.format === "html") {
    return html.slice(0, 10000);
  }

  // Use readability-based content extraction
  const mainContent = extractMainContent(html);

  // Extract meaningful links only (no CSS, JS, tracking, assets)
  const pageHostname = new URL(params.url).hostname;
  const linkMatches = html.matchAll(/href=["'](https?:\/\/[^"'#]+)["']/gi);
  const allLinks = [...linkMatches].map((m) => m[1]);
  const meaningfulLinks = [
    ...new Set(allLinks.filter((href) => isContentLink(href, pageHostname))),
  ].slice(0, 20);

  // Plain text: strip markdown formatting
  if (params.format === "text") {
    const plainContent = mainContent
      .replace(/^#{1,6}\s+/gm, "")  // remove markdown headers
      .replace(/^\- /gm, "  * ")     // convert list markers
      .replace(/\*\*([^*]+)\*\*/g, "$1"); // remove bold
    const linksText = meaningfulLinks.length > 0
      ? `\nLinks:\n${meaningfulLinks.map((l) => `  ${l}`).join("\n")}`
      : "";
    return `${title}\n${description ? description + "\n" : ""}\n${plainContent}${linksText}`;
  }

  // Markdown (default)
  return [
    `# ${title}`,
    description ? `\n> ${description}` : "",
    `\n## Content\n\n${mainContent}`,
    meaningfulLinks.length > 0
      ? `\n## Links (${meaningfulLinks.length})\n\n${meaningfulLinks.map((l) => `- ${l}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function novadaCrawl(params: CrawlParams): Promise<string> {
  if (!API_KEY) {
    throw new Error(
      "NOVADA_API_KEY is not set. Get your API key at https://www.novada.com"
    );
  }

  const maxPages = Math.min(params.max_pages || 5, 20);
  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [
    { url: params.url, depth: 0 },
  ];
  const results: {
    url: string;
    title: string;
    text: string;
    depth: number;
    wordCount: number;
  }[] = [];
  const baseUrl = new URL(params.url);
  const baseHostname = baseUrl.hostname.replace(/^www\./, "");

  while (queue.length > 0 && results.length < maxPages) {
    const item =
      params.strategy === "dfs" ? queue.pop()! : queue.shift()!;

    // Normalize URL for dedup
    const normalizedUrl = normalizeUrl(item.url);
    if (visited.has(normalizedUrl)) continue;
    visited.add(normalizedUrl);

    try {
      const response = await fetchWithRetry(item.url, { timeout: 15000, maxRedirects: 3 });
      const html = response.data;
      if (typeof html !== "string") continue;

      const title =
        html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "Untitled";

      const text = extractMainContent(html).slice(0, 3000);
      const wordCount = text.split(/\s+/).filter(Boolean).length;

      // Skip near-empty pages
      if (wordCount < 20) continue;

      results.push({ url: item.url, title, text, depth: item.depth, wordCount });

      // Discover links on same domain
      const linkMatches = html.matchAll(
        /href=["'](https?:\/\/[^"'#]+)["']/gi
      );
      for (const match of linkMatches) {
        try {
          const linkUrl = new URL(match[1]);
          const linkHostname = linkUrl.hostname.replace(/^www\./, "");
          const normalizedLink = normalizeUrl(linkUrl.href);
          if (
            linkHostname === baseHostname &&
            !visited.has(normalizedLink) &&
            isContentLink(linkUrl.href, baseHostname)
          ) {
            queue.push({ url: linkUrl.href, depth: item.depth + 1 });
          }
        } catch {
          // Invalid URL, skip
        }
      }
    } catch {
      // Failed to fetch, skip this page
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

async function novadaResearch(params: ResearchParams): Promise<string> {
  if (!API_KEY) {
    throw new Error(
      "NOVADA_API_KEY is not set. Get your API key at https://www.novada.com"
    );
  }

  if (params.question.length < 5) {
    throw new Error("Research question must be at least 5 characters long.");
  }

  const isDeep = params.depth === "deep";
  const queries = generateSearchQueries(params.question, isDeep);

  // Execute searches in parallel (max 3 concurrent)
  const allResults = await Promise.all(
    queries.map(async (query): Promise<{ query: string; results: any[] }> => {
      try {
        const searchParams = new URLSearchParams({
          q: query,
          api_key: API_KEY,
          engine: "google",
          num: "5",
        });

        const response = await fetchWithRetry(
          `${SCRAPER_API_BASE}/search?${searchParams.toString()}`,
          {
            headers: {
              "User-Agent": USER_AGENT,
              Origin: "https://www.novada.com",
              Referer: "https://www.novada.com/",
            },
          }
        );

        const data = response.data;
        const results =
          data.data?.organic_results || data.organic_results || [];
        return { query, results };
      } catch {
        return { query, results: [] };
      }
    })
  );

  const totalResults = allResults.reduce(
    (sum, r) => sum + r.results.length,
    0
  );
  const uniqueSources = new Map<
    string,
    { title: string; url: string; snippet: string }
  >();

  for (const { results } of allResults) {
    for (const r of results) {
      const url = normalizeUrl(r.url || r.link || "");
      if (url && !uniqueSources.has(url)) {
        uniqueSources.set(url, {
          title: r.title || "Untitled",
          url: r.url || r.link,
          snippet: r.description || r.snippet || "",
        });
      }
    }
  }

  const sources = [...uniqueSources.values()].slice(0, 15);

  return [
    `# Research Report: ${params.question}`,
    `\n**Depth:** ${params.depth || "quick"} | **Searches:** ${queries.length} | **Results found:** ${totalResults} | **Unique sources:** ${sources.length}\n`,
    `## Search Queries Used\n`,
    ...queries.map((q, i) => `${i + 1}. ${q}`),
    `\n## Key Findings\n`,
    ...sources.map(
      (s, i) =>
        `${i + 1}. **${s.title}**\n   ${s.url}\n   ${s.snippet}\n`
    ),
    `\n## Sources\n`,
    ...sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`),
    `\n---\n*Research conducted via Novada API. For deeper analysis, extract individual sources using novada_extract.*`,
  ].join("\n");
}

/** Generate diverse search queries instead of just appending suffixes */
function generateSearchQueries(question: string, deep: boolean): string[] {
  const queries: string[] = [question];
  const words = question.toLowerCase().split(/\s+/);
  const topic = question.replace(/[?!.]+$/, "").trim();

  // Extract key noun phrases (simple heuristic)
  const stopWords = new Set([
    "what", "how", "why", "when", "where", "who", "which", "is", "are", "do",
    "does", "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
    "and", "or", "but", "can", "will", "should", "would", "could",
  ]);
  const keywords = words.filter((w) => !stopWords.has(w) && w.length > 2);
  const keyPhrase = keywords.slice(0, 4).join(" ");

  if (words.length > 3) {
    // Rephrase for different angles
    queries.push(`${keyPhrase} overview explained`);
    queries.push(`${keyPhrase} vs alternatives comparison`);
    if (deep) {
      queries.push(`${keyPhrase} best practices real world`);
      queries.push(`${keyPhrase} challenges limitations`);
      queries.push(`"${keywords[0]}" "${keywords[1] || keywords[0]}" site:reddit.com OR site:news.ycombinator.com`);
    }
  } else {
    queries.push(`"${topic}" explained overview`);
    queries.push(`${topic} vs alternatives`);
    if (deep) {
      queries.push(`${topic} examples use cases`);
      queries.push(`${topic} review experience`);
      queries.push(`${topic} site:reddit.com OR site:news.ycombinator.com`);
    }
  }

  return queries;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

class NovadaMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: "novada-mcp", version: "0.2.0" },
      { capabilities: { tools: {} } }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result: string;

        switch (name) {
          case "novada_search":
            result = await novadaSearch(args as unknown as SearchParams);
            break;
          case "novada_extract":
            result = await novadaExtract(args as unknown as ExtractParams);
            break;
          case "novada_crawl":
            result = await novadaCrawl(args as unknown as CrawlParams);
            break;
          case "novada_research":
            result = await novadaResearch(args as unknown as ResearchParams);
            break;
          default:
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown tool: ${name}. Available tools: novada_search, novada_extract, novada_crawl, novada_research`,
                },
              ],
              isError: true,
            };
        }

        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (error) {
        const message =
          error instanceof AxiosError
            ? `HTTP ${error.response?.status || "error"}: ${error.response?.data?.msg || error.message}`
            : error instanceof Error
              ? error.message
              : String(error);

        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Novada MCP server v0.2.0 running on stdio");
  }
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--list-tools")) {
  for (const tool of TOOLS) {
    console.log(`  ${tool.name} — ${tool.description.split(".")[0]}`);
  }
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`novada-mcp v0.2.0 — MCP Server for Novada web data API

Usage:
  npx novada-mcp              Start the MCP server (stdio transport)
  npx novada-mcp --list-tools Show available tools
  npx novada-mcp --help       Show this help

Environment:
  NOVADA_API_KEY  Your Novada API key (required)
                  Get one at https://www.novada.com

Connect to Claude Code:
  claude mcp add novada -e NOVADA_API_KEY=your_key -- npx -y novada-mcp

Tools:
  novada_search    Search the web via Google, Bing, and more
  novada_extract   Extract content from any URL (static HTML)
  novada_crawl     Crawl a website (BFS/DFS, static HTML)
  novada_research  Multi-step web research with synthesis
`);
  process.exit(0);
}

const server = new NovadaMCPServer();
server.run().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
