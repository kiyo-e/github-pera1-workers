/**
 * Environment bindings for Cloudflare Workers OAuth Provider
 *
 * Required environment variables:
 * - GITHUB_CLIENT_ID: GitHub OAuth App client ID
 * - GITHUB_CLIENT_SECRET: GitHub OAuth App client secret
 * - OAUTH_KV: KV namespace for storing OAuth tokens and client registrations
 */
import type { KVNamespace } from "@cloudflare/workers-types";

export type EnvBindings = {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OAUTH_KV: KVNamespace;
};

export function hasGithubOAuth(env: Partial<EnvBindings>): boolean {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.OAUTH_KV);
}
