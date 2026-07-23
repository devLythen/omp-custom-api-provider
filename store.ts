// Persistent storage for custom API provider configurations.
// Reads/writes ~/.omp/agent/custom-apis.json (outside this package).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".omp", "agent", "custom-apis.json");

export interface CustomApiConfig {
  /** Unique provider id (registerProvider key, /login id) */
  id: string;
  /** Display name in /login and model selector */
  name: string;
  /** API base URL (include /v1 when the OpenAI path is under /v1) */
  baseUrl: string;
  /** Optional env var name for the API key (preferred over storing the key) */
  apiKeyEnvVar?: string;
  /**
   * Optional literal API key persisted to disk.
   * Prefer apiKeyEnvVar for production; this file is user-local under ~/.omp.
   */
  apiKey?: string;
  /** Wire API: openai-completions | openai-responses | anthropic-messages | google-generative-ai */
  api: string;
  /** Extra HTTP headers on every request */
  headers?: Record<string, string>;
  /**
   * Models discovered from GET {baseUrl}/models (id + name only).
   * contextWindow / maxTokens / thinking are filled by OMP when the id matches
   * the bundled catalog; otherwise OMP defaults apply.
   */
  models: CustomModelConfig[];
  /** Send Authorization: Bearer <key> */
  authHeader?: boolean;
  createdAt: string;
}

export interface CustomModelConfig {
  id: string;
  name: string;
  /** Optional; when omitted at registration, build() sets reasoning: true */
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
}

function ensureDir(): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadConfigs(): CustomApiConfig[] {
  ensureDir();
  if (!existsSync(CONFIG_PATH)) return [];
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as CustomApiConfig[];
  } catch {
    return [];
  }
}

export function saveConfigs(configs: CustomApiConfig[]): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(configs, null, 2), "utf-8");
}

export function configPath(): string {
  return CONFIG_PATH;
}
