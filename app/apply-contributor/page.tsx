"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { BrandLockup } from "@/components/Brand";

const PLATFORMS = [
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "x", label: "X" },
  { value: "threads", label: "Threads" },
] as const;

export default function ApplyContributorPage() {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]["value"]>("instagram");
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== repeatPassword) {
      setError("Passwords don't match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setLoading(true);

    // Standard client-side signup — no service role needed. The account
    // exists right away (so login/password-reset work normally), but the
    // /contributor dashboard stays locked behind `status = 'pending'` until
    // an admin approves the application below.
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/contributor/login` },
    });
    if (signUpError || !signUpData.user) {
      setLoading(false);
      setError(signUpError?.message ?? "Sign up failed.");
      return;
    }

    const { error: insertError } = await supabase.from("contributors").insert({
      user_id: signUpData.user.id,
      name,
      social_platform: platform,
      social_handle: handle,
      email,
    });
    setLoading(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    setSubmitted(true);
  }

  if (submitted) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="lv-card-flush max-w-sm w-full p-8 text-center space-y-4">
          <BrandLockup className="justify-center" imgClassName="h-10 w-auto" />
          <p className="text-lg font-semibold">Application submitted</p>
          <p className="text-sm text-white/60">
            An admin will review your application. You'll be able to sign in at{" "}
            <a href="/contributor/login" className="text-signal hover:underline">
              /contributor
            </a>{" "}
            once approved.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12">
      <form onSubmit={handleSubmit} className="lv-card-flush max-w-sm w-full p-8 space-y-5">
        <div className="space-y-3">
          <BrandLockup className="justify-center" imgClassName="h-12 w-auto" />
          <p className="text-sm text-white/50 text-center uppercase tracking-widest text-[11px]">
            Apply as contributor
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-white/50">Name</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>

        <div className="flex gap-2">
          <div className="space-y-1 shrink-0">
            <label className="text-xs text-white/50">Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as typeof platform)}
              className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
            >
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1 flex-1">
            <label className="text-xs text-white/50">Handle</label>
            <input
              required
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="@yourhandle"
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-white/50">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-white/50">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-white/50">Repeat password</label>
          <input
            type="password"
            required
            value={repeatPassword}
            onChange={(e) => setRepeatPassword(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button type="submit" disabled={loading} className="lv-btn-primary w-full !py-2.5">
          {loading ? "Submitting..." : "Submit application"}
        </button>
      </form>
    </main>
  );
}
