"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/admin");
    router.refresh();
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6 font-mono">
      <form
        onSubmit={handleSubmit}
        className="max-w-sm w-full border border-white/10 rounded-lg p-8 space-y-5"
      >
        <div>
          <h1 className="text-xl font-bold text-white">Livevival admin</h1>
          <p className="text-sm text-white/50 mt-1">Moderator / super admin sign in</p>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-white/50">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-white/50">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-signal text-white rounded py-2 text-sm font-semibold disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
