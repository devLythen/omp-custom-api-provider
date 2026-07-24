/**
 * Custom API Provider Extension for Oh My Pi
 *   /custom-api add | list | edit <id> | remove <id> | reload
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
import { loadConfigs, saveConfigs, type CustomApiConfig } from "./store";

const KEYS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const SRC = "custom-api";
const keyMem = new Map<string, string>();

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
    return keyMem.get(c.id) ?? (c.apiKeyEnvVar ? process.env[c.apiKeyEnvVar] : undefined);
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

  async function fetchModels(url: string, key: string) {
    try {
      const response = await fetch(url.replace(/\/+$/, "") + "/models", {
        headers: { Authorization: "Bearer " + key },
      });
      if (!response.ok) return [] as { id: string; name: string }[];
      const body = (await response.json()) as { data?: { id: string }[] };
      return body.data?.filter((m) => m.id).map((m) => ({ id: m.id, name: m.id })) ?? [];
    } catch {
      return [] as { id: string; name: string }[];
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
    handler: async (args, ctx) => {
      const parts = split(args);
      const cmd = parts[0]?.toLowerCase();
      if (cmd === "add") await add(ctx);
      else if (cmd === "list" || cmd === "ls") list();
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

  async function add(ctx: Record<string, unknown>) {
    const ui = getUi(ctx);
    if (!ui) return;
    cfgs = loadConfigsSafe();

    const id = (await ui.input("Provider ID", "my-gateway")) as string | undefined;
    if (!id) return;
    if (cfgs.some((c) => c.id === id)) {
      ui.notify('"' + id + '" exists.', "error");
      return;
    }
    const name = (await ui.input("Display name", "My Gateway")) as string | undefined;
    if (!name) return;
    const api = (await ui.select("API protocol", [...KEYS])) as string | undefined;
    if (!api) return;
    const baseUrl = (await ui.input("Base URL (include /v1)", "https://api.example.com/v1")) as string | undefined;
    if (!baseUrl) return;
    const rawKey = (await ui.input("API key", "sk-... or ENV_VAR")) as string | undefined;

    let apiKeyEnvVar: string | undefined;
    let storedKey: string | undefined;
    if (rawKey) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey)) apiKeyEnvVar = rawKey;
      else {
        storedKey = rawKey;
        keyMem.set(id, rawKey);
      }
    }

    const key = storedKey ?? (apiKeyEnvVar ? process.env[apiKeyEnvVar] : undefined);
    const models = key ? await fetchModels(baseUrl, key) : [];
    if (models.length > 0) ui.notify("Found " + models.length + " model(s).", "info");

    const cfg: CustomApiConfig = {
      id,
      name,
      baseUrl,
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
      msg("No providers.");
      return;
    }
    msg(
      "Providers:\n" +
        cfgs
          .map(
            (c) =>
              "  " +
              c.id +
              " " +
              c.name +
              " " +
              c.baseUrl +
              " " +
              (c.apiKey || c.apiKeyEnvVar ? "✓" : "✗"),
          )
          .join("\n"),
    );
  }

  async function edit(ctx: Record<string, unknown>, args: string[]) {
    const ui = getUi(ctx);
    if (!ui) return;
    const id = args[0];
    if (!id) {
      ui.notify("Usage: /custom-api edit <id>", "error");
      return;
    }
    const cfg = cfgs.find((c) => c.id === id);
    if (!cfg) {
      ui.notify('"' + id + '" not found.', "error");
      return;
    }

    const baseUrl = (await ui.input("Base URL", cfg.baseUrl)) as string | undefined;
    if (baseUrl) cfg.baseUrl = baseUrl;

    const rawKey = (await ui.input("API key", "sk-... or ENV_VAR")) as string | undefined;
    if (rawKey) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey)) {
        cfg.apiKeyEnvVar = rawKey;
        cfg.apiKey = undefined;
        keyMem.delete(id);
      } else {
        cfg.apiKey = rawKey;
        cfg.apiKeyEnvVar = undefined;
        keyMem.set(id, rawKey);
      }
    }

    const key = resolveKey(cfg);
    const models = key ? await fetchModels(cfg.baseUrl, key) : [];
    if (models.length > 0) {
      cfg.models = models;
      ui.notify("Found " + models.length + " model(s).", "info");
    }
    saveConfigs(cfgs);
    await installProvider(ctx, cfg);
    list();
  }

  async function rem(ctx: Record<string, unknown>, args: string[]) {
    const ui = getUi(ctx);
    const id = args[0];
    if (!id) {
      ui?.notify?.("Usage: /custom-api remove <id>", "error");
      return;
    }
    const index = cfgs.findIndex((c) => c.id === id);
    if (index === -1) {
      ui?.notify?.('"' + id + '" not found.', "error");
      return;
    }
    const ok =
      !!ctx.hasUI && ui
        ? ((await ui.confirm("Remove", 'Delete "' + cfgs[index].name + '"?')) as boolean)
        : true;
    if (!ok) return;
    cfgs.splice(index, 1);
    saveConfigs(cfgs);
    keyMem.delete(id);
    await uninstallProvider(ctx, id);
    list();
  }

  function help() {
    msg("/custom-api add | list | edit <id> | remove <id> | reload");
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
