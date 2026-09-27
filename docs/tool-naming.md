# Automatic Tool Naming

Tracefinity can optionally name traced polygons before you save them to the tool library. This is disabled by default and uses the existing polygon label, so the trace page and saved tool names stay in sync.

## Local Ollama naming

Automatic naming supports a local Ollama vision model. It sends one cropped image per still-generic traced polygon to Ollama, validates the returned short JSON name, and keeps the generic `tool N` label when Ollama is unavailable or returns an unusable name.

```bash
ollama pull qwen3-vl:4b
TOOL_LABEL_PROVIDER=ollama
TOOL_LABEL_MODEL=qwen3-vl:4b
TOOL_LABEL_OLLAMA_URL=http://localhost:11434
TOOL_LABEL_TIMEOUT_SECONDS=30
TOOL_LABEL_MAX_CROP_PX=512
```

## OpenRouter naming

For setups without a local Ollama server (or without GPU headroom to run one), naming can go through OpenRouter's chat completions API instead. Same per-crop flow as Ollama: one cropped image per still-generic polygon, same JSON label parsing and validation, generic label kept on failure. As with the remote (`gemini`) tracer, each cropped tool image is sent to OpenRouter's API to be named.

```bash
TOOL_LABEL_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_LABEL_MODEL=google/gemini-2.0-flash-001
```

The endpoint is not tied to OpenRouter. Any OpenAI-compatible chat completions API that accepts `image_url` content parts works, so a self-hosted router or another hosted one can stand in:

```bash
OPENROUTER_URL=https://your-router.example/v1/chat/completions
```

The same endpoint serves the `gemini` tracer when it runs through `OPENROUTER_API_KEY`. Mask generation there needs OpenRouter's image output format, which a plain OpenAI-compatible proxy may not provide.

`OPENROUTER_LABEL_MODEL` accepts a **comma-separated list** of models, tried in order:

```bash
OPENROUTER_LABEL_MODEL=google/gemma-4-31b-it:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
```

This is aimed at OpenRouter's free-tier (`:free` suffix) models, which share a 20 req/min pool *per model, across all OpenRouter users* — not a per-account limit. A popular free model can return `429 Too Many Requests` under third-party load that has nothing to do with your own usage. Each model in the list gets a couple of quick retries (honoring `Retry-After` when present) before falling through to the next one, so a congested first choice doesn't fail the whole trace's naming pass. A single model (no comma) works the same as before.

## ChatGPT Codex subscription naming

Set `TOOL_LABEL_PROVIDER=codex` to name each crop with the official Codex Python SDK. It reuses the active `codex` CLI login: run `codex login` if needed, and check `codex login status` to confirm ChatGPT sign-in for plan usage. API-key sign-in uses API billing instead. Tracefinity does not read or copy Codex credentials.

```bash
TOOL_LABEL_PROVIDER=codex
# Optional; unset uses the Codex account's configured default model.
TOOL_LABEL_CODEX_MODEL=gpt-6-luna
```

Each isolated crop is sent to OpenAI through the Codex account. Requests use ephemeral, read-only Codex threads; failures or timeouts keep the generic label. Enable this only in a trusted local installation, not a service exposed to untrusted users.

To start the backend with `uv` (from the repository root):

```bash
cd backend
TOOL_LABEL_PROVIDER=codex uv run --no-project \
  --with-requirements requirements.txt -- \
  uvicorn app.main:app --reload --port 8000
```

This starts the API only. Start the frontend separately with `cd frontend && pnpm run dev`.

## Configuration

| Variable | Default | Description |
|-|-|-|
| `TOOL_LABEL_PROVIDER` | `none` | Set to `ollama`, `openrouter`, or `codex` to enable automatic naming |
| `TOOL_LABEL_CODEX_MODEL` | unset | Optional Codex model override (`codex` provider only) |
| `TOOL_LABEL_MODEL` | `qwen3-vl:4b` | Ollama vision model used for naming (`ollama` provider only) |
| `TOOL_LABEL_OLLAMA_URL` | `http://localhost:11434` | Ollama server URL (`ollama` provider only) |
| `TOOL_LABEL_TIMEOUT_SECONDS` | `30` | Timeout for each naming request (all providers) |
| `TOOL_LABEL_MAX_CROP_PX` | `512` | Maximum long edge for each isolated tool crop (all providers) |
| `OPENROUTER_API_KEY` | unset | Required for the `openrouter` provider |
| `OPENROUTER_URL` | `https://openrouter.ai/api/v1/chat/completions` | Chat completions endpoint for the `openrouter` provider. Any OpenAI-compatible API that accepts image inputs |
| `OPENROUTER_LABEL_MODEL` | `google/gemini-2.0-flash-001` | Model, or comma-separated fallback list, for the `openrouter` provider |

## Behavior

- Naming runs after contour extraction and before the trace result is saved.
- When enabled, naming runs synchronously and can add up to `TOOL_LABEL_TIMEOUT_SECONDS` for each attempted generic polygon crop.
- Only still-generic labels, such as `tool 1`, are replaced.
- Naming failures are non-fatal and keep generic labels.
- Manual label edits remain ordinary polygon edits and are saved through the existing trace workflow.
