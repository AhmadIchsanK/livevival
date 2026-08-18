// Provider-agnostic config for the AI vision/text routes (AI layout,
// analyze-frame, match-state, draft-analysis). Everything speaks the
// OpenAI-compatible chat-completions shape, so ANY compatible provider works by
// setting env vars — no code change:
//
//   AI_BASE_URL   OpenAI-compatible base, e.g.
//                   Groq       https://api.groq.com/openai/v1      (default)
//                   Gemini     https://generativelanguage.googleapis.com/v1beta/openai
//                   OpenRouter https://openrouter.ai/api/v1
//   AI_API_KEY    the provider's key (falls back to GROQ_API_KEY for back-compat)
//   AI_VISION_MODEL / AI_TEXT_MODEL   that provider's model ids
//
// The GROQ_* equivalents still work (tried when the AI_* ones are unset), so
// existing Groq deployments keep running untouched. Callers try an ordered
// CANDIDATE LIST and fall through to the next id whenever the provider reports
// the current one is unusable (deprecated / no access / 404).

// OpenAI-compatible base URL for all AI calls. Trailing slash stripped so
// callers can append "/chat/completions" cleanly.
export function aiBaseUrl(): string {
  return (process.env.AI_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
}

// The API key for the configured provider (AI_API_KEY, else GROQ_API_KEY).
export function aiApiKey(): string | undefined {
  return process.env.AI_API_KEY ?? process.env.GROQ_API_KEY;
}

// Ordered vision-capable candidates. The configured override first
// (AI_VISION_MODEL, else GROQ_VISION_MODEL), then the Groq Llama 4 vision models
// as fallbacks (only useful on Groq — other providers should set the override).
export function groqVisionModelCandidates(): string[] {
  const envModel = (process.env.AI_VISION_MODEL ?? process.env.GROQ_VISION_MODEL)?.trim();
  const defaults = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
  ];
  return [...new Set([envModel, ...defaults].filter(Boolean) as string[])];
}

// Ordered TEXT (non-vision) candidates for the draft-analysis route. Configured
// override first (AI_TEXT_MODEL, else GROQ_TEXT_MODEL), then Groq general models.
export function groqTextModelCandidates(): string[] {
  const envModel = (process.env.AI_TEXT_MODEL ?? process.env.GROQ_TEXT_MODEL)?.trim();
  const defaults = [
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-120b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
  ];
  return [...new Set([envModel, ...defaults].filter(Boolean) as string[])];
}

// True when a provider error means THIS model id is unusable for the account
// (missing, deprecated, or no access) — the signal to try the next candidate
// rather than surfacing the error. A 429/500/timeout is NOT this: the chosen
// model is fine but momentarily unavailable, so we stop and report it instead
// of burning through every candidate on a transient blip.
export function isGroqModelUnavailable(status: number, bodyText: string): boolean {
  if (status === 404) return true;
  return /model_not_found|does not exist|do not have access|decommissioned|has been deprecated|not supported|not found/i.test(bodyText);
}

// Strip a reasoning model's <think>…</think> block from its visible content —
// some models (and some providers) emit reasoning inline and only the remainder
// is the real answer. Safe to run on any content.
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ── Multi-provider text fallback ────────────────────────────────────────────
// A single quota (429) on the primary provider used to kill the whole feature.
// Now you can configure a CHAIN of providers, tried in order, and each provider
// can list SEVERAL models (comma- or newline-separated). The runner below falls
// through to the next model, then the next provider, on quota (429),
// model-unavailable (404/deprecated/no-access), an empty answer (a reasoning
// model that spent its whole budget thinking), a network error, or any other
// non-2xx — so it keeps going until something answers.
//
//   Primary   AI_BASE_URL   AI_API_KEY (or GROQ_API_KEY)   AI_TEXT_MODEL
//   Backup 2  AI_BASE_URL_2 AI_API_KEY_2                   AI_TEXT_MODEL_2
//   Backup 3  AI_BASE_URL_3 AI_API_KEY_3                   AI_TEXT_MODEL_3
//
// AI_TEXT_MODEL (and _2/_3) may be a list, e.g.
//   AI_TEXT_MODEL="gemini-2.5-flash, gemini-2.5-flash-lite, gemini-3-flash"
// so even within ONE provider a depleted model rolls over to a fresh one.

export type AiProvider = { baseUrl: string; apiKey: string; models: string[] };

function parseModelList(s: string | undefined): string[] {
  return [...new Set((s ?? "").split(/[,\n]+/).map((x) => x.trim()).filter(Boolean))];
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Ordered text-provider chain from the numbered env groups. A slot is included
// only when it has a key; its base URL defaults to Groq for the primary slot
// only, and its model list defaults to the Groq text models for the primary
// slot only (backup slots must name their own models). GROQ_TEXT_MODEL is still
// honoured as the primary override for back-compat.
export function aiTextProviders(): AiProvider[] {
  const DEFAULT_BASE = "https://api.groq.com/openai/v1";
  const DEFAULT_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "meta-llama/llama-4-scout-17b-16e-instruct"];
  const slots = [
    { base: process.env.AI_BASE_URL, key: process.env.AI_API_KEY ?? process.env.GROQ_API_KEY, models: process.env.AI_TEXT_MODEL ?? process.env.GROQ_TEXT_MODEL, primary: true },
    { base: process.env.AI_BASE_URL_2, key: process.env.AI_API_KEY_2, models: process.env.AI_TEXT_MODEL_2, primary: false },
    { base: process.env.AI_BASE_URL_3, key: process.env.AI_API_KEY_3, models: process.env.AI_TEXT_MODEL_3, primary: false },
  ];
  const providers: AiProvider[] = [];
  for (const slot of slots) {
    const apiKey = slot.key?.trim();
    if (!apiKey) continue;
    const baseUrl = (slot.base?.trim() || (slot.primary ? DEFAULT_BASE : "")).replace(/\/+$/, "");
    if (!baseUrl) continue;
    let models = parseModelList(slot.models);
    if (models.length === 0) models = slot.primary ? DEFAULT_MODELS : [];
    if (models.length === 0) continue;
    providers.push({ baseUrl, apiKey, models });
  }
  return providers;
}

export type TextCompletionResult =
  | { ok: true; content: string; endpoint: string; model: string }
  | { ok: false; status: number; message: string; endpointsTried: string[] };

// Run an OpenAI-compatible chat completion across the whole provider chain,
// returning the first non-empty answer (reasoning stripped). Falls through on
// EVERY failure mode so a depleted provider is transparently backed up by the
// next. Returns a friendly, actionable error only once the whole chain is spent.
export async function runTextCompletion(opts: {
  messages: unknown;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<TextCompletionResult> {
  const providers = aiTextProviders();
  const endpointsTried: string[] = [];
  if (providers.length === 0) {
    return { ok: false, status: 503, message: "AI isn't configured — set AI_API_KEY (or GROQ_API_KEY) and AI_TEXT_MODEL.", endpointsTried };
  }
  let lastStatus = 502;
  let lastErr = "";
  let sawQuota = false;
  let sawAuth = false;
  for (const p of providers) {
    const host = safeHost(p.baseUrl);
    for (const model of p.models) {
      endpointsTried.push(`${host}:${model}`);
      let res: Response;
      try {
        res = await fetch(`${p.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify({
            model,
            temperature: opts.temperature ?? 0.4,
            max_tokens: opts.maxTokens ?? 1200,
            messages: opts.messages,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
        });
      } catch (err) {
        lastStatus = 502;
        lastErr = (err as Error).message;
        continue; // network/timeout → next candidate
      }
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
        const content = stripReasoning(data?.choices?.[0]?.message?.content || "");
        if (content) return { ok: true, content, endpoint: host, model };
        lastStatus = 502;
        lastErr = "the model returned an empty answer";
        continue; // reasoning ate the budget → next candidate
      }
      lastStatus = res.status;
      lastErr = await res.text().catch(() => "");
      if (res.status === 429) sawQuota = true;
      if (res.status === 401 || res.status === 403) sawAuth = true;
      continue; // any error → next candidate (quota, unavailable, bad key, …)
    }
  }
  const message = sawQuota
    ? `Every configured AI provider is rate/quota limited or spent (tried ${endpointsTried.length} model${endpointsTried.length === 1 ? "" : "s"}). Add a backup provider — AI_BASE_URL_2 / AI_API_KEY_2 / AI_TEXT_MODEL_2 — or list more models in AI_TEXT_MODEL, then redeploy. Otherwise wait for a daily cap to reset.`
    : sawAuth
    ? `AI auth failed (${lastStatus}) on one or more providers — check the API key(s). Tried: ${endpointsTried.join(", ")}.`
    : `AI request failed (${lastStatus}) across all providers: ${lastErr.slice(0, 160)}. Tried: ${endpointsTried.join(", ")}.`;
  return { ok: false, status: sawQuota ? 429 : lastStatus, message, endpointsTried };
}
