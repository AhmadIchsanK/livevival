// Shared Groq vision-model selection for the AI layout / analyze-frame /
// match-state routes. Groq's vision lineup shifts (models get deprecated and
// per-account access varies — a hard-coded id periodically starts returning
// 404 "model does not exist or you do not have access"). So instead of one
// fixed default, callers try an ordered CANDIDATE LIST and fall through to the
// next id whenever Groq reports the current one is unusable. An operator can
// still pin an exact model with GROQ_VISION_MODEL; it's tried first.

// Ordered vision-capable candidates. env override first, then the current
// Llama 4 vision models as fallbacks (Maverick after Scout). De-duplicated,
// empties dropped.
export function groqVisionModelCandidates(): string[] {
  const envModel = process.env.GROQ_VISION_MODEL?.trim();
  const defaults = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
  ];
  return [...new Set([envModel, ...defaults].filter(Boolean) as string[])];
}

// True when a Groq error response means THIS model id is unusable for the
// account (missing, deprecated, or no access) — the signal to try the next
// candidate rather than surfacing the error. A 429/500/timeout is NOT this: it
// means the chosen model is fine but momentarily unavailable, so we stop and
// report it instead of burning through every candidate on a transient blip.
export function isGroqModelUnavailable(status: number, bodyText: string): boolean {
  if (status === 404) return true;
  return /model_not_found|does not exist|do not have access|decommissioned|has been deprecated|not supported/i.test(bodyText);
}
