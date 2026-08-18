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
