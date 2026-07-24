# omp-custom-api-provider

Oh My Pi (`omp`) extension that registers **multiple custom AI API backends** as first-class providers.

You configure:

- provider **id** / display **name**
- **base URL** (include `/v1` when required)
- **API key** (literal or env-var name)
- **wire protocol** (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`)

Models are discovered from `GET {baseUrl}/models`. Thinking / reasoning effort is **not** configured via a custom request body — it reuses OMP’s built-in `/model` thinking selector once models are registered with `reasoning: true`.

## Install

```bash
# User extensions directory (recommended)
cp -r . ~/.omp/agent/extensions/custom-api-provider

# Or point config at a path
# ~/.omp/agent/config.yml
# extensions:
#   - /path/to/omp-custom-api-provider
```

Restart `omp`.

## Commands

| Command | Description |
|---------|-------------|
| `/custom-api add` | Interactive wizard: id, name, protocol, base URL, API key; fetches `/models` and registers |
| `/custom-api list` | List configured providers and whether a key is present |
| `/custom-api edit <id>` | Update base URL / key; re-fetch models; re-register live |
| `/custom-api remove <id>` | Delete config and clear runtime registration (`clearSourceRegistrations`) |
| `/custom-api reload` | Re-read disk and re-`pi.registerProvider` (startup-style) |

## Usage order

1. `/custom-api add`
   - **Provider ID** — internal id (`my-gateway` → `my-gateway/<model-id>`, `/login my-gateway`)
   - **Display name** — human label in selectors
   - **API protocol** — wire format OMP uses for requests
   - **Base URL** — e.g. `https://api.example.com/v1` (path matters for `/models`)
   - **API key** — either a secret string **or** an env var name like `MY_GATEWAY_KEY`
2. Wait for “Found N model(s)” if the key works and `/models` is OpenAI-compatible.
3. Open `/model` — provider + models should appear after live `modelRegistry.registerProvider`.
4. Pick a model and set **thinking level** in the same UI (`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`) when the model supports reasoning.
5. Optional: `/login <id>` surfaces the provider in the built-in login list via the registered `oauth.login` callback (key still comes from this extension’s store / env).

After restart, configs load from disk and `pi.registerProvider` runs at extension load so providers return without re-adding.

## What is reused from OMP

| Concern | This extension | OMP |
|---------|----------------|-----|
| Provider registration | `pi.registerProvider` (startup), `ctx.modelRegistry.registerProvider` (live) | Model registry, auth wiring |
| Model list | `GET {baseUrl}/models` → `{ id, name }` | — |
| contextWindow / maxTokens / thinking map | Not hard-coded when id matches catalog | `finalizeCustomModel` + bundled reference index |
| Thinking effort UI | Sets `reasoning: true` on models | `/model` selector + request shaping (`reasoning_effort`, etc.) |
| Unregister | `clearSourceRegistrations("custom-api:<id>")` | Registry cleanup |
| Credential storage | `~/.omp/agent/custom-apis.json` (+ optional env var) | `authStorage` login api_key + config override (Task/subagent) |
| `/login` list entry | `oauth.login` returns stored/env key | Built-in provider picker |

## Configuration storage

Runtime config is **not** in this package:

```text
~/.omp/agent/custom-apis.json
```

It may contain literal API keys. Prefer env-var names in the wizard when possible. This path is outside the package repository.

## Example

```text
/custom-api add
  Provider ID: my-gateway
  Display name: My Gateway
  API protocol: openai-completions
  Base URL: https://api.example.com/v1
  API key: <secret or ENV_NAME>
```

Then `/model` → select `my-gateway/<model-id>` and a thinking level if offered.

## Files

```text
custom-api-provider/
├── package.json   # omp.extensions: ["./index.ts"]
├── index.ts       # Extension factory, slash command, registration
├── store.ts       # Load/save ~/.omp/agent/custom-apis.json
└── README.md
```

## Notes / limitations

- Live registration depends on `ctx.modelRegistry` in interactive command context.
- `/models` must be OpenAI-style `{ "data": [ { "id": "..." } ] }`.
- Unknown model ids fall back to OMP defaults (e.g. 128k context) when not in the bundled catalog.
- Removing a provider clears that provider’s source id; a full process restart is still the safest way to drop every transient registration if something else re-registered it.
