"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

// Shared by /admin/change-password and /contributor/change-password — the
// SDK's updateUser() doesn't verify a "current password" itself (it just
// updates on an already-authenticated session), so this re-authenticates
// with signInWithPassword first and only proceeds if that succeeds.
export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (newPassword !== repeatPassword) {
      setError("New passwords don't match.");
      return;
    }
    if (newPassword.length < 6) {
      setError("New password must be at least 6 characters.");
      return;
    }

    setLoading(true);
    const { data: userData } = await supabase.auth.getUser();
    const email = userData.user?.email;
    if (!email) {
      setLoading(false);
      setError("Not signed in.");
      return;
    }

    const { error: reauthError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
    if (reauthError) {
      setLoading(false);
      setError("Current password is incorrect.");
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setLoading(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }

    setNotice("Password updated.");
    setCurrentPassword("");
    setNewPassword("");
    setRepeatPassword("");
  }

  async function handleForgotPassword() {
    setError(null);
    setNotice(null);
    const { data: userData } = await supabase.auth.getUser();
    const email = userData.user?.email;
    if (!email) {
      setError("Not signed in.");
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) {
      setError(error.message);
      return;
    }
    setNotice(`Password reset email sent to ${email}.`);
  }

  return (
    <form onSubmit={handleSubmit} className="text-white space-y-4 max-w-sm">
      <h1 className="text-xl font-semibold">Change Password</h1>
      <div className="space-y-1">
        <label className="text-xs text-white/50">Current password</label>
        <input
          type="password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-white/50">New password</label>
        <input
          type="password"
          required
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-white/50">Repeat new password</label>
        <input
          type="password"
          required
          value={repeatPassword}
          onChange={(e) => setRepeatPassword(e.target.value)}
          className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
        />
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-signal">{notice}</p>}
      <button type="submit" disabled={loading} className="lv-btn-primary w-full">
        {loading ? "Updating..." : "Update password"}
      </button>
      <button type="button" onClick={handleForgotPassword} className="text-xs text-white/40 hover:text-white/70 block mx-auto">
        Forgot your current password? Email me a reset link
      </button>
    </form>
  );
}
