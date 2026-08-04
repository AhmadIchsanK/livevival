"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { BrandLockup } from "@/components/Brand";

// Landing page for a Supabase invite/recovery email link. detectSessionInUrl
// (on by default for the browser client) turns the link's tokens into a
// session automatically on load — this just waits for that via
// onAuthStateChange, then lets the user pick a password with no
// "current password" field (unlike ChangePasswordForm, which is for an
// already-authenticated user who knows their old one).
export function SetPasswordForm({ redirectTo, loginHref }: { redirectTo: string; loginHref: string }) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) setHasSession(true);
      setChecking(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      if (session) {
        setHasSession(true);
        setChecking(false);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

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
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }
    router.push(redirectTo);
    router.refresh();
  }

  if (checking) {
    return (
      <main className="min-h-screen flex items-center justify-center text-white/50 text-sm">
        Checking link...
      </main>
    );
  }

  if (!hasSession) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-3 text-white text-sm text-center px-6">
        <p>This link is invalid or has expired.</p>
        <a href={loginHref} className="text-signal hover:underline">
          Back to sign in
        </a>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <form onSubmit={handleSubmit} className="lv-card-flush max-w-sm w-full p-8 space-y-5">
        <div className="space-y-3">
          <BrandLockup className="justify-center" imgClassName="h-12 w-auto" />
          <p className="text-sm text-white/50 text-center uppercase tracking-widest text-[11px]">
            Set your password
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-white/50">New password</label>
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
          {loading ? "Saving..." : "Set password"}
        </button>
      </form>
    </main>
  );
}
