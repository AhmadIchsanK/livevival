"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Admin = { id: string; email: string; role: "super_admin" | "admin"; created_at: string };

export default function ManageAdminsPage() {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "super_admin">("admin");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadAdmins() {
    const { data } = await supabase.from("admins").select("id, email, role, created_at").order("created_at");
    setAdmins((data as Admin[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAdmins();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setSubmitting(false);
      setError("Not authenticated.");
      return;
    }

    const res = await fetch("/api/admin/create-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, role }),
    });
    const body = await res.json().catch(() => ({}));
    setSubmitting(false);

    if (!res.ok) {
      setError(body.error ?? "Failed to add admin.");
      return;
    }

    setNotice(`Invite sent to ${email}.`);
    setEmail("");
    setRole("admin");
    loadAdmins();
  }

  return (
    <div className="text-white space-y-6 max-w-xl">
      <h1 className="text-xl font-semibold">Manage Admins</h1>

      <form onSubmit={handleAdd} className="space-y-3 lv-card-flush p-4">
        <p className="text-sm text-white/60">
          Sends an email invite — the new admin sets their own password from the link.
        </p>
        <div className="flex gap-2 flex-wrap">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@example.com"
            className="flex-1 min-w-[220px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "super_admin")}
            className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
          >
            <option value="admin">Admin</option>
            <option value="super_admin">Super Admin</option>
          </select>
          <button type="submit" disabled={submitting} className="lv-btn-primary">
            {submitting ? "Inviting..." : "Add Admin"}
          </button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {notice && <p className="text-sm text-signal">{notice}</p>}
      </form>

      {loading ? (
        <p className="text-white/40 text-sm">Loading...</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-white/40 border-b border-white/10">
              <th className="py-2">Email</th>
              <th className="py-2">Role</th>
              <th className="py-2">Added</th>
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.id} className="border-b border-white/5">
                <td className="py-2">{a.email}</td>
                <td className="py-2 text-white/60">{a.role}</td>
                <td className="py-2 text-white/40">{new Date(a.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
