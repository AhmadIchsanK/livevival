import { createClient } from "@supabase/supabase-js";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const supabase = createClient(
  required("SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY")
);

export const config = {
  groqApiKey: required("GROQ_API_KEY"),
  groqVisionModel: process.env.GROQ_VISION_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct",
  pollIntervalLiveSeconds: Number(process.env.POLL_INTERVAL_LIVE_SECONDS ?? 5),
  pollIntervalIdleSeconds: Number(process.env.POLL_INTERVAL_IDLE_SECONDS ?? 30),
  winnerConfirmationFrames: Number(process.env.WINNER_CONFIRMATION_FRAMES ?? 3),
  screenshotBucket: process.env.SCREENSHOT_BUCKET ?? "key-moment-screenshots",
};
