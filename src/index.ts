#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosError } from "axios";

// ─── Configuration ───────────────────────────────────────────────────────────

const API_KEY = process.env.NOVADA_API_KEY;
const SCRAPER_API_BASE = "https://scraperapi.novada.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
          description: "Search engine to use",
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
      "Extract content from a single URL. Returns the page title, description, main text content, and links. Useful for reading articles, documentation, or any web page.",
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
      "Crawl a website starting from a seed URL. Discovers and extracts content from multiple pages following links. Useful for mapping site structure or collecting content from an entire section.",
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
      "Conduct multi-step web research on a topic. Performs multiple searches, synthesizes findings, and returns a comprehensive report with sources. Best for complex questions that need information from multiple sources.",
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
            "Research depth: 'quick' does 2-3 searches, 'deep' does 5-8 searches for more thorough coverage",
          enum: ["quick", "deep"],
          default: "quick",
        },
      },
      required: ["question"],
    },
  },
];

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function novadaSearch(params: {
  query: string;
  engine?: string;
  num?: number;
  country?: string;
  language?: string;
}): Promise<string> {
  if (!API_KEY) {
    throw new Error(
      "NOVADA_API_KEY is not set. Get your API key at https://www.novada.com and set it as an environment variable."
    );
  }

  const searchParams = new URLSearchParams({
    q: params.query,
    api_key: API_KEY,
    engine: params.engine || "google",
    num: String(params.num || 10),
  });

  if (params.country) searchParams.set("country", params.country);
  if (params.language) searchParams.set("language", params.language);

  const response = await axios.get(
    `${SCRAPER_API_BASE}/search?${searchParams.toString()}`,
    {
      headers: {
        "User-Agent": USER_AGENT,
        Origin: "https://www.novada.com",
        Referer: "https://www.novada.com/",
      },
      timeout: 30000,
    }
  );

  const data = response.data;

  // Novada always returns HTTP 200; check data.code
  if (data.code && data.code !== 200 && data.code !== 0) {
    throw new Error(
      `Novada API error (code ${data.code}): ${data.msg || "Unknown error"}`
    );
  }

  const results = data.data?.organic_results || data.organic_results || [];
  if (results.length === 0) {
    return "No results found for this query.";
  }

  return results
    .map(
      (r: any, i: number) =>
        `${i + 1}. **${r.title || "Untitled"}**\n   URL: ${r.url || r.link || "N/A"}\n   ${r.description || r.snippet || "No description"}`
    )
    .join("\n\n");
}

async function novadaExtract(params: {
  url: string;
  format?: string;
}): Promise<string> {
  if (!API_KEY) {
    throw new Error(
      "NOVADA_API_KEY is not set. Get your API key at https://www.novada.com"
    );
  }

  // Use HTTP fetch for extraction (Browser API WSS is optional premium feature)
  const response = await axios.get(params.url, {
    headers: {
      "User-Agent": USER_AGENT,
    },
    timeout: 30000,
    maxRedirects: 5,
  });

  const html = response.data;
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "Untitled";
  const description =
    html.match(
      /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i
    )?.[1] || "";

  // Strip HTML tags for text extraction
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);

  // Extract links
  const linkMatches = html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi);
  const links = [...new Set([...linkMatches].map((m) => m[1]).slice(0, 20))];

  if (params.format === "html") {
    return html.slice(0, 10000);
  }

  return [
    `# ${title}`,
    description ? `\n> ${description}` : "",
    `\n## Content\n\n${textContent}`,
    links.length > 0
      ? `\n## Links (${links.length})\n\n${links.map((l) => `- ${l}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function novadaCrawl(params: {
  url: string;
  max_pages?: number;
  strategy?: string;
}): Promise<string> {
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
  }[] = [];

  while (queue.length > 0 && visited.size < maxPages) {
    const item =
      params.strategy === "dfs" ? queue.pop()! : queue.shift()!;

    if (visited.has(item.url)) continue;
    visited.add(item.url);

    try {
      const response = await axios.get(item.url, {
        headers: { "User-Agent": USER_AGENT },
        timeout: 15000,
        maxRedirects: 3,
      });

      const html = response.data;
      if (typeof html !== "string") continue;

      const title =
        html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "Untitled";
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2000);

      results.push({ url: item.url, title, text, depth: item.depth });

      // Discover links on same domain
      const baseUrl = new URL(params.url);
      const linkMatches = html.matchAll(
        /href=["'](https?:\/\/[^"'#]+)["']/gi
      );
      for (const match of linkMatches) {
        try {
          const linkUrl = new URL(match[1]);
          if (
            linkUrl.hostname === baseUrl.hostname &&
            !visited.has(linkUrl.href) &&
            visited.size + queue.length < maxPages * 2
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

  return [
    `# Crawl Results for ${params.url}`,
    `\nPages crawled: ${results.length} | Strategy: ${params.strategy || "bfs"}\n`,
    ...results.map(
      (r) =>
        `## ${r.title}\n**URL:** ${r.url} | **Depth:** ${r.depth}\n\n${r.text}\n`
    ),
  ].join("\n");
}

async function novadaResearch(params: {
  question: string;
  depth?: string;
}): Promise<string> {
  if (!API_KEY) {
    throw new Error(
      "NOVADA_API_KEY is not set. Get your API key at https://www.novada.com"
    );
  }

  if (params.question.length < 5) {
    throw new Error("Research question must be at least 5 characters long.");
  }

  const numSearches = params.depth === "deep" ? 5 : 3;
  const allResults: { query: string; results: any[] }[] = [];

  // Generate search queries from the research question
  const queries = generateSearchQueries(params.question, numSearches);

  // Execute searches
  for (const query of queries) {
    try {
      const searchParams = new URLSearchParams({
        q: query,
        api_key: API_KEY,
        engine: "google",
        num: "5",
      });

      const response = await axios.get(
        `${SCRAPER_API_BASE}/search?${searchParams.toString()}`,
        {
          headers: {
            "User-Agent": USER_AGENT,
            Origin: "https://www.novada.com",
            Referer: "https://www.novada.com/",
          },
          timeout: 30000,
        }
      );

      const data = response.data;
      const results =
        data.data?.organic_results || data.organic_results || [];
      allResults.push({ query, results });
    } catch {
      allResults.push({ query, results: [] });
    }
  }

  // Compile research report
  const totalResults = allResults.reduce(
    (sum, r) => sum + r.results.length,
    0
  );
  const uniqueSources = new Map<string, { title: string; url: string; snippet: string }>();

  for (const { results } of allResults) {
    for (const r of results) {
      const url = r.url || r.link;
      if (url && !uniqueSources.has(url)) {
        uniqueSources.set(url, {
          title: r.title || "Untitled",
          url,
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

function generateSearchQueries(question: string, count: number): string[] {
  const queries = [question];

  // Generate variations for broader coverage
  const words = question.toLowerCase().split(/\s+/);
  if (words.length > 3) {
    queries.push(`${question} latest 2025 2026`);
    queries.push(`${question} comparison review`);
    if (count >= 4) queries.push(`${question} alternatives`);
    if (count >= 5) queries.push(`${question} best practices guide`);
  } else {
    queries.push(`what is ${question}`);
    queries.push(`${question} explained`);
    if (count >= 4) queries.push(`${question} examples`);
    if (count >= 5) queries.push(`${question} tutorial`);
  }

  return queries.slice(0, count);
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

class NovadaMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: "novada-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result: string;

        switch (name) {
          case "novada_search":
            result = await novadaSearch(args as any);
            break;
          case "novada_extract":
            result = await novadaExtract(args as any);
            break;
          case "novada_crawl":
            result = await novadaCrawl(args as any);
            break;
          case "novada_research":
            result = await novadaResearch(args as any);
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
    console.error("Novada MCP server running on stdio");
  }
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--list-tools")) {
  console.log("Available tools:");
  for (const tool of TOOLS) {
    console.log(`  ${tool.name} — ${tool.description.split(".")[0]}`);
  }
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`novada-mcp — MCP Server for Novada web data API

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
  novada_extract   Extract content from any URL
  novada_crawl     Crawl a website (BFS/DFS)
  novada_research  Multi-step web research with synthesis
`);
  process.exit(0);
}

const server = new NovadaMCPServer();
server.run().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
