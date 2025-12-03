/**
 * Browser UI Module (Web App)
 *
 * Provides the browser-based UI for direct access to the service.
 * This is used when users access the service directly via browser
 * without going through ChatGPT connector.
 *
 * Related modules:
 * - index.ts: OAuthProvider entry point that falls back to this module
 * - github.ts: GitHub API interaction and file processing
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { GitHubFetchError, processGitHubRepository } from "./github";
import type { EnvBindings } from "./env";

const EXAMPLE_REPO = "https://github.com/kazuph/github-pera1-workers";

function createErrorResponse(
  c: Context,
  targetUrl: string,
  errorMessage: string,
  status: 400 | 403 | 404 | 500,
) {
  const host = c.req.header("host") || "";
  const protocol = c.req.url.startsWith("https") ? "https" : "http";
  const fullUrl = targetUrl
    ? `${protocol}://${host}/${targetUrl}`
    : `${protocol}://${host}/${EXAMPLE_REPO}`;

  return c.html(
    `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="icon" href="/favicon.svg" type="image/svg+xml">
      <title>github pera1</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 800px;
          margin: 0 auto;
          padding: 2rem;
        }
        h1 {
          color: #0366d6;
          margin-bottom: 1.5rem;
        }
        .error {
          color: #cb2431;
          background-color: #ffeef0;
          border: 1px solid #ffdce0;
          border-radius: 6px;
          padding: 1rem;
          margin-bottom: 1.5rem;
        }
        .example {
          margin-bottom: 1.5rem;
        }
        form {
          background-color: #f6f8fa;
          border: 1px solid #e1e4e8;
          border-radius: 6px;
          padding: 1.5rem;
          margin-bottom: 1.5rem;
        }
        .form-group {
          margin-bottom: 1rem;
        }
        label {
          display: block;
          margin-bottom: 0.5rem;
          font-weight: 600;
        }
        input, select {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid #e1e4e8;
          border-radius: 4px;
          font-family: inherit;
          font-size: 1rem;
        }
        .form-hint {
          font-size: 0.85rem;
          color: #586069;
          margin-top: 0.25rem;
        }
        button {
          background-color: #2ea44f;
          color: #fff;
          border: 1px solid rgba(27, 31, 35, 0.15);
          border-radius: 6px;
          padding: 0.5rem 1rem;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
        }
        button:hover {
          background-color: #2c974b;
        }
        code {
          background-color: #f6f8fa;
          padding: 0.2rem 0.4rem;
          border-radius: 3px;
          font-family: SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace;
          font-size: 0.85rem;
        }
      </style>
    </head>
    <body>
      <h1>github pera1</h1>

      ${errorMessage ? `<div class="error">Error: ${errorMessage}</div>` : ""}

      <div class="example">
        ${
          !targetUrl
            ? `<p>Example: <a href="${fullUrl}">${fullUrl}</a></p>`
            : `<p>URL: <a href="${fullUrl}">${fullUrl}</a></p>`
        }
      </div>

      <form action="" method="get" id="pera1-form">
        <h2>Set Parameters</h2>

        <div class="form-group">
          <label for="repo-url">GitHub Repository URL</label>
          <input type="text" id="repo-url" placeholder="https://github.com/username/repository" value="${targetUrl || ""}">
          <div class="form-hint">Enter full GitHub URL including https://</div>
        </div>

        <div class="form-group">
          <label for="dir">Directories (Optional)</label>
          <input type="text" id="dir" placeholder="src,components,lib" name="dir">
          <div class="form-hint">Filter files by directory paths (comma-separated)</div>
        </div>

        <div class="form-group">
          <label for="ext">Extensions (Optional)</label>
          <input type="text" id="ext" placeholder="ts,js,tsx" name="ext">
          <div class="form-hint">Filter files by extensions (comma-separated, without dots)</div>
        </div>

        <div class="form-group">
          <label for="mode">Display Mode</label>
          <select id="mode" name="mode">
            <option value="">Full Mode (default)</option>
            <option value="tree">Tree Mode (structure + README only)</option>
          </select>
        </div>

        <div class="form-group">
          <label for="branch">Branch (Optional)</label>
          <input type="text" id="branch" placeholder="main" name="branch">
          <div class="form-hint">Defaults to main or master if not specified</div>
        </div>

        <div class="form-group">
          <label for="file">Single File (Optional)</label>
          <input type="text" id="file" placeholder="src/App.js" name="file">
          <div class="form-hint">Retrieve only a specific file</div>
        </div>

        <button type="submit">Generate View</button>
      </form>

      <div>
        <h2>How to Use</h2>
        <p>This tool fetches code from GitHub repositories and combines files into a single view.</p>
        <p>Examples:</p>
        <ul>
          <li>Basic: <code>${protocol}://${host}/github.com/username/repo</code></li>
          <li>With branch: <code>${protocol}://${host}/github.com/username/repo/tree/branch-name</code></li>
          <li>With params: <code>${protocol}://${host}/github.com/username/repo?dir=src&ext=ts,tsx</code></li>
        </ul>
      </div>

      <script>
        document.getElementById('pera1-form').addEventListener('submit', function(e) {
          e.preventDefault();

          const repoUrl = document.getElementById('repo-url').value.trim();
          if (!repoUrl) {
            alert('Please enter a GitHub repository URL');
            return;
          }

          // Build the base URL (removing https:// if present)
          let baseUrl = repoUrl;
          if (baseUrl.startsWith('https://')) {
            baseUrl = baseUrl.substring(8);
          }

          // Build query parameters
          const params = new URLSearchParams();

          const dir = document.getElementById('dir').value.trim();
          if (dir) params.set('dir', dir);

          const ext = document.getElementById('ext').value.trim();
          if (ext) params.set('ext', ext);

          const mode = document.getElementById('mode').value;
          if (mode) params.set('mode', mode);

          const branch = document.getElementById('branch').value.trim();
          if (branch) params.set('branch', branch);

          const file = document.getElementById('file').value.trim();
          if (file) params.set('file', file);

          // Build the final URL
          let finalUrl = '${protocol}://${host}/' + baseUrl;
          const queryString = params.toString();
          if (queryString) {
            finalUrl += '?' + queryString;
          }

          window.location.href = finalUrl;
        });
      </script>
    </body>
    </html>
  `,
    status,
  );
}

function mapGitHubErrorToStatus(error: unknown): 400 | 403 | 404 | 500 {
  if (error instanceof GitHubFetchError) {
    if (error.status === 401 || error.status === 403) return 403;
    if (error.status === 404) return 404;
    return 500;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("invalid url") ||
    normalized.includes("invalid github repository url format") ||
    normalized.includes("arguments are required") ||
    normalized.includes("url parameter is required") ||
    normalized.includes("url must be a non-empty string")
  ) {
    return 400;
  }

  if (normalized.includes("file not found")) {
    return 404;
  }

  return 500;
}

export function createWebApp() {
  const app = new Hono<{ Bindings: EnvBindings }>();

  app.get("/*", async (c) => {
    let path = "";
    try {
      const url = new URL(c.req.url);
      path = url.pathname.slice(1);
      const params = url.searchParams;

      if (!path) {
        return createErrorResponse(c, "", "No repository URL provided", 400);
      }

      const args = {
        url: path.startsWith("http") ? path : `https://${path}`,
        dir: params.get("dir") ?? undefined,
        ext: params.get("ext") ?? undefined,
        branch: params.get("branch") ?? undefined,
        file: params.get("file") ?? undefined,
        mode: params.get("mode") ?? undefined,
      };

      // Browser direct access always uses no token
      const resultText = await processGitHubRepository(args, null);

      return c.text(resultText, 200);
    } catch (e) {
      const rawMessage = e instanceof Error ? e.message : "Unknown error";
      const status = mapGitHubErrorToStatus(e);
      const msgPrefix = status === 500 ? "Unexpected error" : "Request error";
      const msg = `${msgPrefix}: ${rawMessage}`;
      console.error(`[WebApp] ${msg}`);
      return createErrorResponse(c, path, msg, status);
    }
  });

  return app;
}
