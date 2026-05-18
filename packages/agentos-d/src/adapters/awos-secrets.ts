/**
 * Provider-secret loader for the daemon.
 *
 * Reads API keys for upstream model providers (Kimi/Moonshot, OpenAI,
 * Minimax, Ollama Cloud, etc.) from the daemon environment first, then
 * from a key=value file at AWOS_SECRETS_PATH (default
 * ~/.agentworks/secrets.env).
 *
 * Operators are expected to manage that file out of band - chmod 600,
 * keep it out of git, mount it as a Docker secret or bind into /config.
 */
import { existsSync, readFileSync } from "node:fs";

const DEFAULT_AWOS_SECRETS_PATH = `${process.env.HOME}/.agentworks/secrets.env`;

interface ProviderKeyOptions {
  /**
   * Environment variable names to try in order. The first one that
   * resolves to a non-empty string wins.
   */
  envNames: string[];
  /**
   * Path to the AWOS secrets env file. Defaults to AWOS_SECRETS_PATH or
   * ~/.agentworks/secrets.env.
   */
  awosSecretsPath?: string;
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match?.[1]) continue;
    out[match[1]] = (match[2] ?? "").replace(/^['"]|['"]$/g, "");
  }
  return out;
}

/**
 * Resolve an API key for an upstream provider. Throws with a remediation
 * hint if no source has a value.
 */
export function loadAwosProviderKey(opts: ProviderKeyOptions): string {
  for (const name of opts.envNames) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }

  const awosSecretsPath =
    opts.awosSecretsPath ?? process.env.AWOS_SECRETS_PATH ?? DEFAULT_AWOS_SECRETS_PATH;
  const awosSecrets = parseEnvFile(awosSecretsPath);
  for (const name of opts.envNames) {
    const value = awosSecrets[name];
    if (value && value.length > 0) return value;
  }

  throw new Error(
    `${opts.envNames.join("/")} missing. Set one of those in the daemon ` +
      `environment, or write the value into ${awosSecretsPath} as ` +
      `KEY=value (chmod 600).`,
  );
}

/**
 * Look up a base URL for an upstream provider in the AWOS secrets file
 * or env. Returns null when no value is set; callers fall back to the
 * provider's documented default.
 */
export function readAwosProviderBaseUrl(provider: string): string | null {
  const envName = `${provider.toUpperCase()}_BASE_URL`;
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const awosSecretsPath = process.env.AWOS_SECRETS_PATH ?? DEFAULT_AWOS_SECRETS_PATH;
  const secrets = parseEnvFile(awosSecretsPath);
  return secrets[envName] ?? null;
}
