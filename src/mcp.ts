/**
 * MCP Server Module
 *
 * Provides the MCP server and /mcp endpoint.
 * GitHub access token is received via ctx.props from OAuthProvider.
 *
 * Related modules:
 * - index.ts: OAuthProvider entry point that wraps this module
 * - github.ts: GitHub API interaction and file processing
 */
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { processGitHubRepository } from "./github";
import type { EnvBindings } from "./env";

// Props passed from OAuthProvider after authorization
export type AuthProps = {
  githubAccessToken: string;
};

export function createMcpApp(getAuthProps?: () => AuthProps | undefined) {
  const app = new Hono<{ Bindings: EnvBindings }>();

  const mcpServer = new McpServer({
    name: "github-pera1-mcp-server",
    version: "2.0.0",
  });

  mcpServer.registerTool(
    "fetch_github_code",
    {
      title: "GitHub Code Fetcher",
      description: "Fetch code from GitHub repositories with flexible filtering options",
      inputSchema: {
        url: z.string().describe("GitHub repository URL (e.g., https://github.com/owner/repo)"),
        dir: z.string().optional().describe("Filter by directory path (optional)"),
        ext: z.string().optional().describe("Filter by file extensions (optional)"),
        branch: z.string().optional().describe("Git branch name (optional)"),
        file: z.string().optional().describe("Specific file to fetch (optional)"),
        mode: z.enum(["tree", "full"]).optional().describe("Display mode (optional)"),
      },
    },
    async (args, ctx) => {
      // OAuthProvider passes props containing githubAccessToken
      const props = getAuthProps ? getAuthProps() : undefined;
      const githubToken = props?.githubAccessToken ?? null;

      try {
        if (!args || typeof args !== "object") {
          throw new Error("Arguments are required");
        }

        if (!args.url) {
          throw new Error(
            "URL parameter is required. Please provide a GitHub repository URL (e.g., https://github.com/owner/repo)",
          );
        }

        if (typeof args.url !== "string" || args.url.trim() === "") {
          throw new Error("URL must be a non-empty string");
        }

        const result = await processGitHubRepository(args, githubToken);

        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (error) {
        throw new Error(
          `Failed to fetch GitHub code: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
  );

  app.all("/mcp", async (c) => {
    const transport = new StreamableHTTPTransport();
    await mcpServer.connect(transport);
    return transport.handleRequest(c);
  });

  return app;
}
