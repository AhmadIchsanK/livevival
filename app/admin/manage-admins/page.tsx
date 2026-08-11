"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Admin = { id: string; email: string; role: "super_admin" | "admin"; created_at: string; user_id: string };
type Contributor = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  social_platform: string;
  social_handle: string;
  applied_at: string;
};

const PLATFORMS = ["instagram", "facebook", "x", "threads"] as const;

// Simple random password for throwaway/testing accounts — not meant to be
// cryptographically precious, just long enough to satisfy Supabase's min
// length and awkward enough that nobody would guess it.
function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function authedFetch(path: string, body: unknown) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) return { ok: false, error: "Not authenticated." };
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: json.error ?? "Request failed." };
  return { ok: true, data: json };
}

export default function ManageAdminsPage() {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Add Admin form
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminRole, setAdminRole] = useState<"admin" | "super_admin">("admin");
  const [addingAdmin, setAddingAdmin] = useState(false);
  const [createdAdminCreds, setCreatedAdminCreds] = useState<{ email: string; password: string } | null>(null);

  // Add Contributor form
  const [contribName, setContribName] = useState("");
  const [contribPlatform, setContribPlatform] = useState<(typeof PLATFORMS)[number]>("instagram");
  const [contribHandle, setContribHandle] = useState("");
  const [contribEmail, setContribEmail] = useState("");
  const [contribPassword, setContribPassword] = useState("");
  const [addingContrib, setAddingContrib] = useState(false);
  const [createdContribCreds, setCreatedContribCreds] = useState<{ email: string; password: string } | null>(null);

  // Inline contributor edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; social_platform: string; social_handle: string; email: string }>({
    name: "",
    social_platform: "instagram",
    social_handle: "",
    email: "",
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  async function loadAll() {
    const { data: sessionData } = await supabase.auth.getSession();
    setCurrentUserId(sessionData.session?.user.id ?? null);

    const [{ data: adminRows }, { data: contribRows }] = await Promise.all([
      supabase.from("admins").select("id, email, role, created_at, user_id").order("created_at"),
      supabase
        .from("contributors")
        .select("id, user_id, name, email, social_platform, social_handle, applied_at")
        .eq("status", "approved")
        .order("applied_at", { ascending: false }),
    ]);
    setAdmins((adminRows as Admin[]) ?? []);
    setContributors((contribRows as Contributor[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function handleAddAdmin(e: React.FormEvent) {
    e.preventDefault();
    setAddingAdmin(true);
    setError(null);
    setNotice(null);
    setCreatedAdminCreds(null);

    const result = await authedFetch("/api/admin/create-admin", {
      email: adminEmail,
      password: adminPassword || undefined,
      role: adminRole,
    });
    setAddingAdmin(false);
    if (!result.ok) {
      setError(result.error as string);
      return;
    }

    const wasPromoted = (result.data as { promoted?: boolean })?.promoted;
    if (wasPromoted) {
      setNotice(`${adminEmail} was already an approved contributor — promoted to ${adminRole}. They keep their existing password.`);
    } else {
      setCreatedAdminCreds({ email: adminEmail, password: adminPassword });
      setNotice(`Admin account created for ${adminEmail}. Copy the password below now — it won't be shown again.`);
    }
    setAdminEmail("");
    setAdminPassword("");
    setAdminRole("admin");
    loadAll();
  }

  async function handleChangeRole(adminId: string, role: "admin" | "super_admin") {
    setBusyId(adminId);
    setError(null);
    const result = await authedFetch("/api/admin/update-admin-role", { adminId, role });
    setBusyId(null);
    if (!result.ok) {
      setError(result.error as string);
      return;
    }
    loadAll();
  }

  async function handleDeleteAdmin(admin: Admin) {
    if (!confirm(`Delete admin "${admin.email}"? This removes their account entirely.`)) return;
    setBusyId(admin.id);
    setError(null);
    const result = await authedFetch("/api/admin/delete-admin", { adminId: admin.id });
    setBusyId(null);
    if (!result.ok) {
      setError(result.error as string);
      return;
    }
    loadAll();
  }

  async function handleAddContributor(e: React.FormEvent) {
    e.preventDefault();
    setAddingContrib(true);
    setError(null);
    setNotice(null);
    setCreatedContribCreds(null);

    const result = await authedFetch("/api/admin/create-contributor", {
      name: contribName,
      email: contribEmail,
      password: contribPassword,
      social_platform: contribPlatform,
      social_handle: contribHandle,
    });
    setAddingContrib(false);
    if (!result.ok) {
      setError(result.error as string);
      return;
    }

    setCreatedContribCreds({ email: contribEmail, password: contribPassword });
    setNotice(`Contributor account created for ${contribEmail}. Copy the password below now — it won't be shown again.`);
    setContribName("");
    setContribHandle("");
    setContribEmail("");
    setContribPassword("");
    loadAll();
  }

  function startEdit(c: Contributor) {
    setEditingId(c.id);
    setEditForm({ name: c.name, social_platform: c.social_platform, social_handle: c.social_handle, email: c.email });
  }

  async function saveEdit(id: string) {
    setBusyId(id);
    setError(null);
    const { error: updateError } = await supabase.from("contributors").update(editForm).eq("id", id);
    setBusyId(null);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setEditingId(null);
    loadAll();
  }

  async function handlePromote(c: Contributor) {
    const input = prompt(`Promote "${c.name}" to which role? Type "admin" or "super_admin".`, "admin");
    if (!input) return;
    const role = input.trim().toLowerCase();
    if (role !== "admin" && role !== "super_admin") {
      setError('Role must be "admin" or "super_admin".');
      return;
    }
    setBusyId(c.id);
    setError(null);
    const result = await authedFetch("/api/admin/promote-contributor", { contributorId: c.id, role });
    setBusyId(null);
    if (!result.ok) {
      setError(result.error as string);
      return;
    }
    loadAll();
  }

  async function handleDeleteContributor(c: Contributor) {
    if (!confirm(`Delete contributor "${c.name}"? This removes their account entirely — they'd need to reapply from scratch.`)) return;
    setBusyId(c.id);
    setError(null);
    const result = await authedFetch("/api/admin/revoke-contributor", { contributorId: c.id });
    setBusyId(null);
    if (!result.ok) {
      setError(result.error as string);
      return;
    }
    loadAll();
  }

  return (
    <div className="text-white space-y-10">
      <h1 className="text-xl font-semibold">Manage Admins</h1>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-signal">{notice}</p>}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Admins</h2>

        <form onSubmit={handleAddAdmin} className="space-y-3 lv-card-flush p-4">
          <p className="text-sm text-white/60">
            Creates the account active immediately with the password below — no invite email. Copy the password now, it's only
            shown once. If the email already belongs to an approved contributor, their account is promoted instead and keeps its
            existing password (leave the password field blank in that case).
          </p>
          <div className="flex gap-2 flex-wrap">
            <input
              type="email"
              required
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="email@example.com"
              className="flex-1 min-w-[220px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
            />
            <input
              type="text"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              placeholder="password"
              className="min-w-[160px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
            />
            <button
              type="button"
              onClick={() => setAdminPassword(generatePassword())}
              className="px-3 py-2 rounded border border-white/10 text-white/60 hover:bg-white/5 text-xs"
            >
              Generate
            </button>
            <select
              value={adminRole}
              onChange={(e) => setAdminRole(e.target.value as "admin" | "super_admin")}
              className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
            >
              <option value="admin">Admin</option>
              <option value="super_admin">Super Admin</option>
            </select>
            <button type="submit" disabled={addingAdmin} className="lv-btn-primary">
              {addingAdmin ? "Adding..." : "Add Admin"}
            </button>
          </div>
          {createdAdminCreds && (
            <div className="bg-white/5 border border-signal/30 rounded px-3 py-2 text-sm font-mono flex items-center justify-between gap-3">
              <span>
                {createdAdminCreds.email} / {createdAdminCreds.password}
              </span>
              <button
                type="button"
                onClick={() => setCreatedAdminCreds(null)}
                className="text-white/40 hover:text-white text-xs font-sans shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}
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
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id} className="border-b border-white/5">
                  <td className="py-2">{a.email}</td>
                  <td className="py-2">
                    <select
                      value={a.role}
                      disabled={busyId === a.id}
                      onChange={(e) => handleChangeRole(a.id, e.target.value as "admin" | "super_admin")}
                      className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs text-white"
                    >
                      <option value="admin">Admin</option>
                      <option value="super_admin">Super Admin</option>
                    </select>
                  </td>
                  <td className="py-2 text-white/40">{new Date(a.created_at).toLocaleDateString()}</td>
                  <td className="py-2 text-right">
                    {a.user_id !== currentUserId && (
                      <button
                        onClick={() => handleDeleteAdmin(a)}
                        disabled={busyId === a.id}
                        className="text-red-400 hover:text-red-300 text-xs"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Contributors</h2>

        <form onSubmit={handleAddContributor} className="space-y-3 lv-card-flush p-4">
          <p className="text-sm text-white/60">
            Add a contributor directly — skips the application step, status starts approved. Creates the account active
            immediately with the password below — no invite email. Copy it now, it's only shown once.
          </p>
          <div className="flex gap-2 flex-wrap">
            <input
              required
              value={contribName}
              onChange={(e) => setContribName(e.target.value)}
              placeholder="Name"
              className="min-w-[160px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
            />
            <select
              value={contribPlatform}
              onChange={(e) => setContribPlatform(e.target.value as (typeof PLATFORMS)[number])}
              className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              required
              value={contribHandle}
              onChange={(e) => setContribHandle(e.target.value)}
              placeholder="@handle"
              className="min-w-[140px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
            />
            <input
              type="email"
              required
              value={contribEmail}
              onChange={(e) => setContribEmail(e.target.value)}
              placeholder="email@example.com"
              className="flex-1 min-w-[220px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
            />
            <input
              type="text"
              required
              value={contribPassword}
              onChange={(e) => setContribPassword(e.target.value)}
              placeholder="password"
              className="min-w-[160px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
            />
            <button
              type="button"
              onClick={() => setContribPassword(generatePassword())}
              className="px-3 py-2 rounded border border-white/10 text-white/60 hover:bg-white/5 text-xs"
            >
              Generate
            </button>
            <button type="submit" disabled={addingContrib} className="lv-btn-primary">
              {addingContrib ? "Adding..." : "Add Contributor"}
            </button>
          </div>
          {createdContribCreds && (
            <div className="bg-white/5 border border-signal/30 rounded px-3 py-2 text-sm font-mono flex items-center justify-between gap-3">
              <span>
                {createdContribCreds.email} / {createdContribCreds.password}
              </span>
              <button
                type="button"
                onClick={() => setCreatedContribCreds(null)}
                className="text-white/40 hover:text-white text-xs font-sans shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}
        </form>

        {loading ? (
          <p className="text-white/40 text-sm">Loading...</p>
        ) : (
          <div className="space-y-2">
            {contributors.map((c) =>
              editingId === c.id ? (
                <div key={c.id} className="lv-card-flush p-4 space-y-2">
                  <div className="flex gap-2 flex-wrap">
                    <input
                      value={editForm.name}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className="min-w-[160px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
                    />
                    <select
                      value={editForm.social_platform}
                      onChange={(e) => setEditForm({ ...editForm, social_platform: e.target.value })}
                      className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
                    >
                      {PLATFORMS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <input
                      value={editForm.social_handle}
                      onChange={(e) => setEditForm({ ...editForm, social_handle: e.target.value })}
                      className="min-w-[140px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
                    />
                    <input
                      type="email"
                      value={editForm.email}
                      onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                      className="flex-1 min-w-[220px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => saveEdit(c.id)} disabled={busyId === c.id} className="lv-btn-primary !text-xs !py-1.5">
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-3 py-1.5 rounded border border-white/10 text-white/60 hover:bg-white/5 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div key={c.id} className="lv-card-flush p-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-semibold text-sm">{c.name}</p>
                    <p className="text-xs text-white/50">
                      {c.email} · {c.social_platform} {c.social_handle}
                    </p>
                  </div>
                  <div className="flex gap-3 shrink-0 text-xs">
                    <button onClick={() => startEdit(c)} className="text-white/60 hover:text-white">
                      Edit
                    </button>
                    <button onClick={() => handlePromote(c)} disabled={busyId === c.id} className="text-signal hover:text-signal/80">
                      Promote
                    </button>
                    <button onClick={() => handleDeleteContributor(c)} disabled={busyId === c.id} className="text-red-400 hover:text-red-300">
                      Delete
                    </button>
                  </div>
                </div>
              )
            )}
            {contributors.length === 0 && <p className="text-white/30 text-sm text-center py-4">No approved contributors yet.</p>}
          </div>
        )}
      </section>
    </div>
  );
}
