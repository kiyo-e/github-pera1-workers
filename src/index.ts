/**
 * GitHub Repository Code Fetcher - Cloudflare Workers MCP Server with OAuth Provider
 *
 * Architecture:
 * - Workers acts as OAuth Provider for ChatGPT connector (MCP client)
 * - Workers performs GitHub OAuth to get user's GitHub access token
 * - GitHub access token is stored in props and passed to MCP tools
 * - Supports Protected Resource Metadata (RFC 9728) for MCP discovery
 *
 * Flow:
 * 1. ChatGPT → /mcp → 401 + WWW-Authenticate (resource_metadata)
 * 2. ChatGPT discovers Authorization Server via PRM
 * 3. ChatGPT → /authorize → Workers → GitHub OAuth → /github/callback
 * 4. Workers issues access token with props.githubAccessToken
 * 5. ChatGPT → /mcp with Bearer token → MCP tools use githubAccessToken
 *
 * Related modules:
 * - mcp.ts: MCP server and /mcp endpoint
 * - app.ts: Browser UI for direct access
 * - github.ts: GitHub API interaction and file processing
 * - env.ts: Environment variable type definitions
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpApp, type AuthProps } from "./mcp";
import { createWebApp } from "./app";
import type { EnvBindings } from "./env";

type Env = EnvBindings & {
  OAUTH_KV: KVNamespace;
};

/**
 * MCP API Handler - Called for authenticated /mcp requests
 * Receives props (including githubAccessToken) from OAuthProvider
 */
export class McpApiHandler extends WorkerEntrypoint<Env> {
  private mcpApp = createMcpApp();

  async fetch(request: Request): Promise<Response> {
    // Props from OAuthProvider are available via this.ctx.props
    return this.mcpApp.fetch(request, this.env, this.ctx);
  }
}

/**
 * Default Handler - Handles OAuth flow and browser UI
 */
const defaultHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // 1. ChatGPT → /authorize (OAuth authorization endpoint)
    if (url.pathname === "/authorize") {
      console.log("[/authorize] Query params:", Object.fromEntries(url.searchParams));

      // Parse the OAuth authorization request from ChatGPT
      const oauthReq = await (env as any).OAUTH_PROVIDER.parseAuthRequest(request);
      console.log("[/authorize] Parsed oauthReq:", JSON.stringify(oauthReq, null, 2));

      if (!oauthReq) {
        return new Response("Invalid OAuth request", { status: 400 });
      }

      // Store OAuth request in KV for later retrieval in callback
      const state = crypto.randomUUID();
      await env.OAUTH_KV.put(`oauthreq:${state}`, JSON.stringify(oauthReq), {
        expirationTtl: 600,
      });

      // Redirect to GitHub OAuth authorization
      const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
      githubAuthUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      githubAuthUrl.searchParams.set(
        "redirect_uri",
        `${url.origin}/github/callback`
      );
      githubAuthUrl.searchParams.set("state", state);
      githubAuthUrl.searchParams.set("scope", "repo");
      githubAuthUrl.searchParams.set("allow_signup", "false");

      return Response.redirect(githubAuthUrl.toString(), 302);
    }

    // 2. GitHub → /github/callback (OAuth callback from GitHub)
    if (url.pathname === "/github/callback") {
      console.log("[/github/callback] Query params:", Object.fromEntries(url.searchParams));

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return new Response("Missing code or state", { status: 400 });
      }

      // Retrieve stored OAuth request
      const stored = await env.OAUTH_KV.get(`oauthreq:${state}`);
      console.log("[/github/callback] Stored oauthReq from KV:", stored);

      if (!stored) {
        return new Response("Invalid or expired state", { status: 400 });
      }
      await env.OAUTH_KV.delete(`oauthreq:${state}`);

      const oauthReq = JSON.parse(stored);
      console.log("[/github/callback] Parsed oauthReq:", JSON.stringify(oauthReq, null, 2));

      // Exchange code for GitHub access token
      const tokenRes = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: `${url.origin}/github/callback`,
          }),
        }
      );

      if (!tokenRes.ok) {
        console.error(
          "Failed to fetch GitHub token:",
          tokenRes.status,
          tokenRes.statusText
        );
        return new Response("Failed to fetch GitHub token", { status: 500 });
      }

      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (tokenJson.error) {
        console.error("GitHub OAuth error:", tokenJson.error, tokenJson.error_description);
        return new Response(
          `GitHub OAuth error: ${tokenJson.error_description || tokenJson.error}`,
          { status: 500 }
        );
      }

      const githubAccessToken = tokenJson.access_token;
      if (!githubAccessToken) {
        return new Response("GitHub access_token missing in response", {
          status: 500,
        });
      }

      // Get GitHub user info to use as userId
      // IMPORTANT: userId must NOT contain colons (:) as it's used in authorization code format
      // Code format is userId:grantId:authCodeId - extra colons break parsing
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${githubAccessToken}`,
          "User-Agent": "Pera1-MCP-Server",
          Accept: "application/vnd.github.v3+json",
        },
      });

      let userId = `github_${state}`;
      if (userRes.ok) {
        const userJson = (await userRes.json()) as { id?: number; login?: string };
        if (userJson.id) {
          userId = `github_${userJson.id}`;
        }
      }
      console.log("[/github/callback] userId:", userId);

      // Complete authorization and issue our access token
      // The props will be available in McpApiHandler via this.ctx.props
      console.log("[/github/callback] Calling completeAuthorization with:", {
        request: oauthReq,
        userId,
        metadata: { provider: "github" },
        scope: oauthReq.scope,
      });

      const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
        request: oauthReq,
        userId,
        metadata: { provider: "github" },
        scope: oauthReq.scope,
        props: {
          githubAccessToken,
        } as AuthProps,
      });

      console.log("[/github/callback] completeAuthorization redirectTo:", redirectTo);
      return Response.redirect(redirectTo, 302);
    }

    // 3. Everything else → Browser UI (Web app)
    const webApp = createWebApp();
    return webApp.fetch(request, env, ctx);
  },
};

// Worker entry point with OAuthProvider wrapper
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["repo"],
});
