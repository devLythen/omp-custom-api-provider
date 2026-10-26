/**
 * Custom API Provider Extension for Oh My Pi
 *   /custom-api [add | list | models | test | edit | remove | reload]
 *
 * Pre-fetches models from /v1/models. contextWindow & maxTokens are auto-resolved
 * by OMP from its bundled catalog when model IDs match known models.
 * reasoning: true enables the built-in thinking level selector in /model.
 *
 * Keys are installed on the live ModelRegistry (config override) and persisted
 * through authStorage.login so Task/subagents reusing the parent registry can
 * resolve credentials without NO_API_KEY.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfigs, saveConfigs, type CustomApiConfig, type CustomModelConfig } from "./store";

const KEYS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const SRC = "custom-api";
const keyMem = new Map<string, string>();

interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
  hint?: string;
}

interface FetchResult {
  models: CustomModelConfig[];
  error?: string;
  durationMs: number;
}

type AuthStorageLike = {
  setConfigApiKey?(provider: string, apiKey: string): void;
  removeConfigApiKey?(provider: string): void;
  login?(
    provider: string,
    ctrl: {
      onAuth: (info: unknown) => void;
      onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
    },
  ): Promise<unknown>;
  logout?(provider: string): Promise<void>;
  store?: {
    saveApiKey?(provider: string, apiKey: string): void;
    deleteProvider?(provider: string): void;
  };
};

type MR = {
  registerProvider(p: string, c: object, s?: string): void;
  clearSourceRegistrations(s: string): void;
  authStorage?: AuthStorageLike;
};

/**
 * Accurately parses user input for API key vs environment variable name.
 * - Explicit prefixes: `$VAR_NAME` or `env:VAR_NAME`
 * - Present in process.env: treated as env var name
 * - Uppercase identifier convention (e.g. `OPENAI_API_KEY`, <= 32 chars): treated as env var name
 * - Everything else (hex, long hashes, tokens like `m365_...`, `sk-...`): treated as literal key
 */
function parseApiKeyInput(raw: string): { apiKey?: string; apiKeyEnvVar?: string; isEnv: boolean } {
  const s = raw.trim();
  if (!s) return { isEnv: false };
  if (s.startsWith("$")) {
    return { apiKeyEnvVar: s.slice(1).trim(), isEnv: true };
  }
  if (s.toLowerCase().startsWith("env:")) {
    return { apiKeyEnvVar: s.slice(4).trim(), isEnv: true };
  }
  if (process.env[s] !== undefined) {
    return { apiKeyEnvVar: s, isEnv: true };
  }
  if (/^[A-Z][A-Z0-9_]{1,31}$/.test(s) && !s.includes("sk-")) {
    return { apiKeyEnvVar: s, isEnv: true };
  }
  return { apiKey: s, isEnv: false };
}

export default function (pi: ExtensionAPI) {
  let cfgs = loadConfigsSafe();

  function loadConfigsSafe(): CustomApiConfig[] {
    try {
      return loadConfigs();
    } catch {
      return [];
    }
  }

  for (const c of cfgs) {
    if (c.apiKey) keyMem.set(c.id, c.apiKey);
    try {
      pi.registerProvider(c.id, build(c));
    } catch {
      /* pending registration may still succeed at session init */
    }
  }

  function resolveKey(c: CustomApiConfig): string | undefined {
    if (c.id && keyMem.has(c.id)) return keyMem.get(c.id);
    if (c.apiKey) return c.apiKey;
    if (c.apiKeyEnvVar) return process.env[c.apiKeyEnvVar];
    return undefined;
  }

  function build(c: CustomApiConfig) {
    const k = resolveKey(c);
    return {
      baseUrl: c.baseUrl,
      api: c.api,
      apiKey: k,
      authHeader: c.authHeader ?? true,
      headers: c.headers,
      models: c.models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: true,
        input: ["text"],
        cost: ZERO,
      })),
      oauth: {
        name: c.name,
        async login() {
          return resolveKey(c) ?? "";
        },
      },
    };
  }

  async function fetchModels(url: string, key: string): Promise<FetchResult> {
    const cleanUrl = url.replace(/\/+$/, "");
    const target = cleanUrl.endsWith("/models") ? cleanUrl : cleanUrl + "/models";
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(target, {
        headers: { Authorization: "Bearer " + key },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      if (!response.ok) {
        let detail = `HTTP ${response.status} ${response.statusText}`;
        try {
          const errJson: unknown = await response.json();
          let msg: unknown;
          if (errJson && typeof errJson === "object") {
            const rec = errJson as Record<string, unknown>;
            const errField = rec.error;
            msg =
              rec.message ??
              (errField && typeof errField === "object" ? (errField as Record<string, unknown>).message : undefined) ??
              rec.error ??
              rec.code;
          }
          if (msg) detail += ` (${typeof msg === "string" ? msg : JSON.stringify(msg)})`;
        } catch {
          const text = await response.text().catch(() => "");
          if (text) detail += ` (${text.slice(0, 100)})`;
        }
        return { models: [], error: detail, durationMs };
      }

      const body = (await response.json()) as { data?: { id?: string }[]; models?: { id?: string }[] };
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      const models: CustomModelConfig[] = list
        .filter((m) => m && typeof m.id === "string" && m.id.trim())
        .map((m) => ({ id: m.id!.trim(), name: m.id!.trim() }));

      return { models, durationMs };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const isAbort = err instanceof Error && err.name === "AbortError";
      const msg = isAbort ? "Request timeout (15s)" : err instanceof Error ? err.message : String(err);
      return { models: [], error: msg, durationMs };
    }
  }

  function getModelRegistry(ctx: Record<string, unknown>): MR | undefined {
    const candidate = ctx.modelRegistry;
    if (!candidate || typeof candidate !== "object") return undefined;
    return candidate as MR;
  }

  function getUi(ctx: Record<string, unknown>): Record<string, Function> | undefined {
    if (!ctx.hasUI) return undefined;
    const candidate = ctx.ui;
    if (!candidate || typeof candidate !== "object") return undefined;
    return candidate as Record<string, Function>;
  }

  async function installAuth(auth: AuthStorageLike | undefined, providerId: string, key: string) {
    auth?.setConfigApiKey?.(providerId, key);
    if (auth?.store?.saveApiKey) {
      auth.store.saveApiKey(providerId, key);
      return;
    }
    if (auth?.login) {
      await auth.login(providerId, {
        onAuth() {},
        onPrompt: async () => key,
      });
    }
  }

  async function uninstallAuth(auth: AuthStorageLike | undefined, providerId: string) {
    auth?.removeConfigApiKey?.(providerId);
    if (auth?.store?.deleteProvider) {
      auth.store.deleteProvider(providerId);
      return;
    }
    await auth?.logout?.(providerId);
  }

  async function installProvider(ctx: Record<string, unknown>, c: CustomApiConfig) {
    const registry = getModelRegistry(ctx);
    if (!registry) {
      pi.registerProvider(c.id, build(c));
      return;
    }
    registry.registerProvider(c.id, build(c), SRC + ":" + c.id);
    const key = resolveKey(c);
    if (key) await installAuth(registry.authStorage, c.id, key);
  }

  async function uninstallProvider(ctx: Record<string, unknown>, id: string) {
    const registry = getModelRegistry(ctx);
    if (!registry) return;
    registry.clearSourceRegistrations(SRC + ":" + id);
    await uninstallAuth(registry.authStorage, id);
  }

  // After session init drains pending providers, re-install on the live registry
  // so Task/subagents that reuse modelRegistry.authStorage can resolve keys.
  pi.on("session_start", async (_event, ctx) => {
    const record = ctx as unknown as Record<string, unknown>;
    for (const c of cfgs) {
      if (c.apiKey) keyMem.set(c.id, c.apiKey);
      await installProvider(record, c);
    }
  });

  pi.registerCommand("custom-api", {
    description: "Manage custom AI API providers",
    getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
      const trimmed = argumentPrefix.trimStart();
      const spaceIdx = trimmed.indexOf(" ");
      const subcommands: AutocompleteItem[] = [
        { label: "add", value: "add", description: "Interactive wizard to add a new provider" },
        { label: "list", value: "list", description: "List all configured providers and status" },
        { label: "models", value: "models ", description: "View registered models for a provider" },
        { label: "test", value: "test ", description: "Test connection and latency live" },
        { label: "edit", value: "edit ", description: "Edit a provider's URL, key, or models" },
        { label: "remove", value: "remove ", description: "Delete a provider configuration" },
        { label: "reload", value: "reload", description: "Reload configurations from disk and re-register" },
      ];

      // Typing subcommand name
      if (spaceIdx === -1) {
        const lower = trimmed.toLowerCase();
        const matches = subcommands.filter((s) => s.label.startsWith(lower));
        return matches.length > 0 ? matches : null;
      }

      // Typing provider ID for subcommands that take an ID
      const sub = trimmed.slice(0, spaceIdx).toLowerCase();
      const idPrefix = trimmed.slice(spaceIdx + 1).trimStart().toLowerCase();
      if (["edit", "remove", "rm", "models", "show", "test"].includes(sub)) {
        const matches = cfgs
          .filter((c) => c.id.toLowerCase().startsWith(idPrefix))
          .map((c) => ({
            label: c.id,
            value: `${sub} ${c.id}`,
            description: `${c.name} (${c.models.length} model${c.models.length === 1 ? "" : "s"})`,
          }));
        return matches.length > 0 ? matches : null;
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = split(args);
      const cmd = parts[0]?.toLowerCase();
      if (!cmd) {
        const ui = getUi(ctx);
        if (ui) {
          await interactiveMenu(ctx);
          return;
        }
        help();
        return;
      }
      if (cmd === "add") await add(ctx);
      else if (cmd === "list" || cmd === "ls") list();
      else if (cmd === "models" || cmd === "show") await showModels(ctx, parts.slice(1));
      else if (cmd === "test") await testProvider(ctx, parts.slice(1));
      else if (cmd === "edit") await edit(ctx, parts.slice(1));
      else if (cmd === "remove" || cmd === "rm") await rem(ctx, parts.slice(1));
      else if (cmd === "reload") {
        cfgs = loadConfigsSafe();
        for (const c of cfgs) {
          if (c.apiKey) keyMem.set(c.id, c.apiKey);
          await installProvider(ctx, c);
        }
        list();
      } else {
        help();
      }
    },
  });

  async function interactiveMenu(ctx: Record<string, unknown>) {
    const ui = getUi(ctx);
    if (!ui) {
      help();
      return;
    }
    const choice = (await ui.select("Custom AI Provider Manager", [
      { label: "List providers", description: `View all ${cfgs.length} provider(s)` },
      { label: "Add provider", description: "Interactive setup wizard for a new provider" },
      { label: "Edit provider", description: "Update base URL, API key, wire API, or models" },
      { label: "Test connection", description: "Test live /models endpoint and latency" },
      { label: "View models", description: "Inspect registered models for a provider" },
      { label: "Remove provider", description: "Delete a provider configuration" },
      { label: "Reload from disk", description: "Re-read ~/.omp/agent/custom-apis.json" },
    ])) as string | undefined;

    if (!choice) return;
    if (choice === "List providers") list();
    else if (choice === "Add provider") await add(ctx);
    else if (choice === "Edit provider") await edit(ctx, []);
    else if (choice === "Test connection") await testProvider(ctx, []);
    else if (choice === "View models") await showModels(ctx, []);
    else if (choice === "Remove provider") await rem(ctx, []);
    else if (choice === "Reload from disk") {
      cfgs = loadConfigsSafe();
      for (const c of cfgs) {
        if (c.apiKey) keyMem.set(c.id, c.apiKey);
        await installProvider(ctx, c);
      }
      list();
    }
  }

  async function add(ctx: Record<string, unknown>) {
    const ui = getUi(ctx);
    if (!ui) return;
    cfgs = loadConfigsSafe();

    const id = (await ui.input("Provider ID (lowercase identifier, e.g. my-gateway)", "my-gateway")) as string | undefined;
    if (!id) return;
    const cleanId = id.trim();
    if (cfgs.some((c) => c.id === cleanId)) {
      ui.notify(`"${cleanId}" already exists.`, "error");
      return;
    }

    const name = (await ui.input("Display name", cleanId)) as string | undefined;
    if (!name) return;

    const api = (await ui.select("API protocol", [...KEYS])) as string | undefined;
    if (!api) return;

    const baseUrl = (await ui.input("Base URL (include /v1)", "https://api.example.com/v1")) as string | undefined;
    if (!baseUrl) return;
    const cleanBaseUrl = baseUrl.trim();

    const rawKey = (await ui.input("API key (literal key, or $VAR_NAME for env var)", "sk-... or $MY_KEY")) as string | undefined;

    let apiKeyEnvVar: string | undefined;
    let storedKey: string | undefined;
    if (rawKey) {
      const parsed = parseApiKeyInput(rawKey);
      if (parsed.isEnv && parsed.apiKeyEnvVar) {
        apiKeyEnvVar = parsed.apiKeyEnvVar;
        ui.notify(`Using environment variable: $${apiKeyEnvVar}`, "info");
      } else if (parsed.apiKey) {
        storedKey = parsed.apiKey;
        keyMem.set(cleanId, storedKey);
        ui.notify("Stored literal API key.", "info");
      }
    }

    const key = storedKey ?? (apiKeyEnvVar ? process.env[apiKeyEnvVar] : undefined);
    let models: CustomModelConfig[] = [];
    if (key) {
      ui.notify("Connecting to discover models...", "info");
      const { models: fetched, error, durationMs } = await fetchModels(cleanBaseUrl, key);
      if (error) {
        ui.notify(`Model auto-discovery failed (${error})`, "warning");
      } else if (fetched.length > 0) {
        models = fetched;
        ui.notify(`Discovered ${models.length} model(s) in ${durationMs}ms.`, "info");
      }
    } else if (apiKeyEnvVar) {
      ui.notify(`$${apiKeyEnvVar} is not currently set in environment; skipping live discovery.`, "warning");
    }

    if (models.length === 0) {
      const manual = (await ui.input(
        "No models discovered. Enter model IDs manually (comma-separated, optional):",
        "",
      )) as string | undefined;
      if (manual) {
        const ids = manual.split(",").map((s) => s.trim()).filter(Boolean);
        for (const mId of ids) {
          models.push({ id: mId, name: mId });
        }
        if (models.length > 0) {
          ui.notify(`Registered ${models.length} manual model(s).`, "info");
        }
      }
    }

    if (models.length === 0) {
      ui.notify(
        `Warning: Provider "${cleanId}" has 0 models and will not appear in /model until models are added!`,
        "warning",
      );
    }

    const cfg: CustomApiConfig = {
      id: cleanId,
      name: name.trim(),
      baseUrl: cleanBaseUrl,
      api,
      apiKeyEnvVar,
      apiKey: storedKey,
      authHeader: true,
      models,
      createdAt: new Date().toISOString(),
    };
    cfgs.push(cfg);
    saveConfigs(cfgs);
    await installProvider(ctx, cfg);
    list();
  }

  function list() {
    if (cfgs.length === 0) {
      msg("No custom API providers configured. Run `/custom-api add` to add one.");
      return;
    }
    const lines: string[] = [
      `Custom AI API Providers (${cfgs.length}):`,
      "",
    ];
    for (const c of cfgs) {
      const keyInfo = c.apiKey
        ? "✓ stored"
        : c.apiKeyEnvVar
          ? `✓ env:$${c.apiKeyEnvVar} (${process.env[c.apiKeyEnvVar] ? "set" : "unset!"})`
          : "✗ missing key";

      const modelCount = c.models?.length ?? 0;
      const modelStatus =
        modelCount === 0
          ? "⚠️ 0 models (will NOT appear in /model! Run /custom-api test " + c.id + ")"
          : `${modelCount} model(s): ` +
            c.models.slice(0, 4).map((m) => m.id).join(", ") +
            (modelCount > 4 ? ` (+${modelCount - 4} more)` : "");

      lines.push(
        `  • ${c.id} (${c.name})`,
        `    Protocol: ${c.api} | Auth: ${keyInfo}`,
        `    Base URL: ${c.baseUrl}`,
        `    Models:   ${modelStatus}`,
        "",
      );
    }
    lines.push("Commands: /custom-api [add | list | models <id> | test <id> | edit <id> | remove <id> | reload]");
    msg(lines.join("\n"));
  }

  async function showModels(ctx: Record<string, unknown>, args: string[]) {
    let id = args[0]?.trim();
    const ui = getUi(ctx);
    if (!id && ui && cfgs.length > 0) {
      id = (await ui.select(
        "Select provider to view models",
        cfgs.map((c) => ({
          label: c.id,
          description: `${c.name} (${c.models.length} models)`,
        })),
      )) as string | undefined;
    }
    if (!id) {
      ui?.notify?.("Usage: /custom-api models <id>", "error");
      return;
    }
    const cfg = cfgs.find((c) => c.id === id);
    if (!cfg) {
      ui?.notify?.(`Provider "${id}" not found.`, "error");
      return;
    }
    if (!cfg.models || cfg.models.length === 0) {
      msg(
        `Provider "${cfg.id}" (${cfg.name}) has NO registered models.\n` +
          `It will not appear in the /model selector.\n` +
          `Run \`/custom-api test ${cfg.id}\` to fetch models from the API, or \`/custom-api edit ${cfg.id}\` to add them.`,
      );
      return;
    }
    const listStr = cfg.models.map((m, i) => `  ${(i + 1).toString().padStart(2, " ")}. ${m.id}`).join("\n");
    msg(`Models registered for "${cfg.id}" (${cfg.models.length} total):\n${listStr}`);
  }

  async function testProvider(ctx: Record<string, unknown>, args: string[]) {
    const ui = getUi(ctx);
    let id = args[0]?.trim();
    if (!id && ui && cfgs.length > 0) {
      id = (await ui.select(
        "Select provider to test",
        cfgs.map((c) => ({
          label: c.id,
          description: `${c.name} • ${c.baseUrl}`,
        })),
      )) as string | undefined;
    }
    if (!id) {
      ui?.notify?.("Usage: /custom-api test <id>", "error");
      return;
    }
    const cfg = cfgs.find((c) => c.id === id);
    if (!cfg) {
      ui?.notify?.(`Provider "${id}" not found.`, "error");
      return;
    }

    const key = resolveKey(cfg);
    if (!key) {
      ui?.notify?.(`No API key available for "${id}". Check config or env var.`, "error");
      return;
    }

    ui?.notify?.(`Testing connection to ${cfg.baseUrl}...`, "info");
    const { models, error, durationMs } = await fetchModels(cfg.baseUrl, key);
    if (error) {
      msg(`❌ Test failed for "${cfg.id}" (${durationMs}ms):\n  Error: ${error}`);
      ui?.notify?.(`Test failed: ${error}`, "error");
      return;
    }

    const sample = models.slice(0, 5).map((m) => m.id).join(", ");
    const extra = models.length > 5 ? ` (+${models.length - 5} more)` : "";
    msg(
      `✓ Connection successful for "${cfg.id}" (${durationMs}ms)!\n` +
        `  Found ${models.length} model(s): ${sample}${extra}\n` +
        `  Current config has ${cfg.models.length} model(s).`,
    );

    if (models.length > 0 && ui) {
      const update = (await ui.confirm(
        "Update Models",
        `Update "${cfg.id}" models from ${cfg.models.length} to ${models.length} discovered models?`,
      )) as boolean;
      if (update) {
        cfg.models = models;
        saveConfigs(cfgs);
        await installProvider(ctx, cfg);
        ui.notify(`Updated "${cfg.id}" with ${models.length} models.`, "info");
      }
    }
  }

  async function edit(ctx: Record<string, unknown>, args: string[]) {
    const ui = getUi(ctx);
    if (!ui) return;
    let id = args[0]?.trim();
    if (!id && cfgs.length > 0) {
      id = (await ui.select(
        "Select provider to edit",
        cfgs.map((c) => ({
          label: c.id,
          description: `${c.name} • ${c.baseUrl} • ${c.models.length} model(s)`,
        })),
      )) as string | undefined;
    }
    if (!id) {
      ui.notify("Usage: /custom-api edit <id>", "error");
      return;
    }
    const cfg = cfgs.find((c) => c.id === id);
    if (!cfg) {
      ui.notify(`Provider "${id}" not found.`, "error");
      return;
    }

    const name = (await ui.input("Display name", cfg.name)) as string | undefined;
    if (name) cfg.name = name.trim();

    const api = (await ui.select(`API protocol (current: ${cfg.api})`, [...KEYS])) as string | undefined;
    if (api) cfg.api = api;

    const baseUrl = (await ui.input("Base URL", cfg.baseUrl)) as string | undefined;
    if (baseUrl) cfg.baseUrl = baseUrl.trim();

    const currentKeyHint = cfg.apiKeyEnvVar ? `$${cfg.apiKeyEnvVar}` : cfg.apiKey ? "••••••••" : "";
    const rawKey = (await ui.input(`API key (current: ${currentKeyHint || "none"})`, currentKeyHint)) as string | undefined;
    if (rawKey && rawKey !== currentKeyHint) {
      const parsed = parseApiKeyInput(rawKey);
      if (parsed.isEnv && parsed.apiKeyEnvVar) {
        cfg.apiKeyEnvVar = parsed.apiKeyEnvVar;
        cfg.apiKey = undefined;
        keyMem.delete(id);
        ui.notify(`Using environment variable: $${cfg.apiKeyEnvVar}`, "info");
      } else if (parsed.apiKey) {
        cfg.apiKey = parsed.apiKey;
        cfg.apiKeyEnvVar = undefined;
        keyMem.set(id, parsed.apiKey);
        ui.notify("Stored literal API key.", "info");
      }
    }

    const key = resolveKey(cfg);
    if (key) {
      const shouldRefetch = (await ui.confirm(
        "Refetch Models",
        `Test connection and refetch models from ${cfg.baseUrl}/models?`,
      )) as boolean;
      if (shouldRefetch) {
        ui.notify("Connecting to discover models...", "info");
        const { models: fetched, error, durationMs } = await fetchModels(cfg.baseUrl, key);
        if (error) {
          ui.notify(`Model auto-discovery failed (${error}). Kept ${cfg.models.length} existing models.`, "warning");
        } else if (fetched.length > 0) {
          cfg.models = fetched;
          ui.notify(`Discovered and updated ${cfg.models.length} model(s) in ${durationMs}ms.`, "info");
        } else {
          ui.notify(`0 models returned by API. Kept ${cfg.models.length} existing models.`, "warning");
        }
      }
    }

    if (cfg.models.length === 0) {
      const manual = (await ui.input(
        "Provider has 0 models. Enter model IDs manually (comma-separated):",
        "",
      )) as string | undefined;
      if (manual) {
        const ids = manual.split(",").map((s) => s.trim()).filter(Boolean);
        cfg.models = ids.map((mId) => ({ id: mId, name: mId }));
        if (cfg.models.length > 0) {
          ui.notify(`Registered ${cfg.models.length} manual model(s).`, "info");
        }
      }
    }

    saveConfigs(cfgs);
    await installProvider(ctx, cfg);
    list();
  }

  async function rem(ctx: Record<string, unknown>, args: string[]) {
    const ui = getUi(ctx);
    let id = args[0]?.trim();
    if (!id && ui && cfgs.length > 0) {
      id = (await ui.select(
        "Select provider to remove",
        cfgs.map((c) => ({
          label: c.id,
          description: `${c.name} • ${c.baseUrl}`,
        })),
      )) as string | undefined;
    }
    if (!id) {
      ui?.notify?.("Usage: /custom-api remove <id>", "error");
      return;
    }
    const index = cfgs.findIndex((c) => c.id === id);
    if (index === -1) {
      ui?.notify?.(`Provider "${id}" not found.`, "error");
      return;
    }
    const ok =
      !!ctx.hasUI && ui
        ? ((await ui.confirm("Remove Provider", `Delete provider "${cfgs[index].name}" (${cfgs[index].id})?`)) as boolean)
        : true;
    if (!ok) return;
    cfgs.splice(index, 1);
    saveConfigs(cfgs);
    keyMem.delete(id);
    await uninstallProvider(ctx, id);
    ui?.notify?.(`Provider "${id}" removed.`, "info");
    list();
  }

  function help() {
    msg("/custom-api [add | list | models <id> | test <id> | edit <id> | remove <id> | reload]");
  }

  function msg(text: string) {
    pi.sendMessage(
      { customType: "ci", content: text, display: true, attribution: "user" },
      { triggerTurn: false },
    );
  }
}

function split(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of s) {
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
    } else if (inDouble) {
      if (ch === '"') inDouble = false;
      else cur += ch;
    } else if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === " " || ch === "\t") {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
