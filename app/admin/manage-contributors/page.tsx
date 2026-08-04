"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Contributor = {
  id: string;
  name: string;
  email: string;
  social_platform: string;
  social_handle: string;
  status: "pending" | "approved" | "rejected";
  applied_at: string;
};

export default function ManageContributorsPage() {
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase
      .from("contributors")
      .select("id, name, email, social_platform, social_handle, status, applied_at")
      .eq("status", "approved")
      .order("applied_at", { ascending: false });
    setContributors((data as Contributor[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function revoke(id: string, name: string) {
    if (!confirm(`Revoke "${name}"'s contributor access? This removes their account entirely — they'd need to reapply from scratch.`)) return;
    setError(null);

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setError("Not authenticated.");
      return;
    }

    const res = await fetch("/api/admin/revoke-contributor", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ contributorId: id }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "Failed to revoke.");
      return;
    }
    load();
  }

  return (
    <div className="text-white space-y-6 max-w-3xl">
      <h1 className="text-xl font-semibold">Manage Contributors</h1>
      <p className="text-sm text-white/60">
        Approved contributors. New applications are reviewed under{" "}
        <a href="/admin/contributor-requests" className="text-signal hover:underline">
          Contributor Requests
        </a>
        .
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="text-white/40 text-sm">Loading...</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-white/40 border-b border-white/10">
              <th className="py-2">Name</th>
              <th className="py-2">Email</th>
              <th className="py-2">Social</th>
              <th className="py-2">Applied</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {contributors.map((c) => (
              <tr key={c.id} className="border-b border-white/5">
                <td className="py-2">{c.name}</td>
                <td className="py-2 text-white/60">{c.email}</td>
                <td className="py-2 text-white/60 capitalize">
                  {c.social_platform} · {c.social_handle}
                </td>
                <td className="py-2 text-white/40">{new Date(c.applied_at).toLocaleDateString()}</td>
                <td className="py-2 text-right">
                  <button onClick={() => revoke(c.id, c.name)} className="text-red-400 hover:text-red-300 text-xs">
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
            {contributors.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-white/30 text-center">
                  No approved contributors yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
