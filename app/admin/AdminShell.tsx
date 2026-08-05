"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { BrandMark } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";

type AdminInfo = { email: string; role: "super_admin" | "moderator" };

// The live console (/admin/matches/[id]/live) is the one page under this
// admin-only layout that an approved contributor also needs to reach —
// they submit finished-match correction requests through that same page
// component in contributor mode (see its own actorType handling), rather
// than a separate cloned route. Every other /admin/* page stays admin-only.
const CONTRIBUTOR_LIVE_CONSOLE = /^\/admin\/matches\/[^/]+\/live/;

// Static-asset cache for the admin PWA — a SEPARATE worker from
// public/sw.js (registered from lib/webPush.ts for Web Push, scope "/").
// This one lives at /admin/sw.js, which makes "/admin/" its default scope
// with no Service-Worker-Allowed header needed, so it only ever controls
// pages under /admin — it never intercepts a single public-site request.
// Two workers can be registered on the same origin at once: the more
// specific "/admin/" scope wins for controlling admin pages, and Web Push
// still fires on whichever registration owns the subscription (the root
// one), so this doesn't touch or interfere with push at all. See
// public/admin/sw.js for exactly what it does and doesn't cache — short
// version: build output + icons only, via an allowlist, never API/Supabase
// responses or page navigations.
function useRegisterAdminServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/admin/sw.js", { scope: "/admin/" }).catch(() => {
      // Non-critical — the console works identically without it, just
      // without the faster-repeat-load caching. No user-facing surface
      // for this failing (unsupported browser, blocked by an extension,
      // etc.) since it changes nothing about correctness.
    });
  }, []);
}

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);
  const [admin, setAdmin] = useState<AdminInfo | null>(null);
  const [isApprovedContributor, setIsApprovedContributor] = useState(false);

  useRegisterAdminServiceWorker();

  useEffect(() => {
    let active = true;

    async function check() {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;

      if (!session) {
        if (active && pathname !== "/admin/login") router.push("/admin/login");
        if (active) setChecking(false);
        return;
      }

      const { data: adminRow } = await supabase
        .from("admins")
        .select("email, role")
        .eq("user_id", session.user.id)
        .maybeSingle();

      if (!adminRow) {
        const { data: contributorRow } = await supabase
          .from("contributors")
          .select("id")
          .eq("user_id", session.user.id)
          .eq("status", "approved")
          .maybeSingle();
        if (active) setIsApprovedContributor(Boolean(contributorRow));
      }

      if (active) {
        setAdmin(adminRow as AdminInfo | null);
        setChecking(false);
      }
    }

    check();
    return () => {
      active = false;
    };
  }, [pathname, router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/admin/login");
  }

  if (pathname === "/admin/login" || pathname === "/admin/set-password") return <>{children}</>;

  if (checking) {
    return (
      <main className="min-h-screen flex items-center justify-center text-white/50 text-sm">
        Checking access...
      </main>
    );
  }

  if (!admin) {
    // An approved contributor reaching the live console gets the page
    // itself (no admin nav/header wrapper) — it renders its own
    // contributor-mode UI and route guard (finished matches only). Any
    // other /admin/* path stays fully blocked for a non-admin.
    if (isApprovedContributor && CONTRIBUTOR_LIVE_CONSOLE.test(pathname ?? "")) {
      return <>{children}</>;
    }
    return (
      <main className="min-h-screen flex items-center justify-center text-white text-sm text-center px-6">
        {isApprovedContributor
          ? "Contributors can only reach the live console for a finished match — use the link from your dashboard."
          : "Not authorized. This account has no admin role assigned."}
      </main>
    );
  }

  const navItems = [
    { href: "/admin/tournaments", label: "Tournaments" },
    { href: "/admin/teams", label: "Teams" },
    { href: "/admin/players", label: "Players" },
    { href: "/admin/heroes", label: "Heroes" },
    { href: "/admin/matches", label: "Matches" },
    { href: "/admin/streams", label: "Streams" },
    { href: "/admin/moment-templates", label: "Moment Templates" },
    { href: "/admin/telegram-notifications", label: "Telegram Notifications" },
    { href: "/admin/data-sync", label: "Data Sync" },
    { href: "/admin/manage-contributors", label: "Manage Contributors" },
    { href: "/admin/contributor-requests", label: "Contributor Requests" },
    { href: "/admin/change-log", label: "Change Log" },
    { href: "/admin/change-password", label: "Change Password" },
    // Add Admin is the one thing that distinguishes super_admin from admin
    // per the confirmed scope — every other tab is identical for both.
    ...(admin.role === "super_admin" ? [{ href: "/admin/manage-admins", label: "Manage Admins" }] : []),
  ];

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-6 py-3.5 border-b border-white/10 bg-ink/80 backdrop-blur sticky top-0 z-20">
        <div className="flex items-center gap-8">
          <a href="/admin" className="flex items-center gap-2 shrink-0">
            <BrandMark className="h-6 w-6" />
            <span className="font-display font-light text-sm tracking-tight text-paper hidden sm:inline">
              LIVE<span className="text-signal">VIVAL</span>{" "}
              <span className="text-white/30 text-[10px] uppercase tracking-widest align-middle ml-1">Admin</span>
            </span>
          </a>
          <nav className="flex gap-5 flex-wrap">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={`lv-nav-link ${pathname?.startsWith(item.href) ? "text-signal" : ""}`}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-white/40 hidden md:inline">
            {admin.email} · <span className="text-white/25">{admin.role}</span>
          </span>
          {/* The admin header only ever linked back to /admin itself —
              no way back to the public site without editing the URL bar. */}
          <a href="/" className="lv-nav-link" target="_blank" rel="noopener noreferrer">
            View site ↗
          </a>
          <ThemeToggle />
          <button onClick={handleLogout} className="lv-btn-ghost">
            Sign out
          </button>
        </div>
      </header>
      <div className="p-6">{children}</div>
    </div>
  );
}
