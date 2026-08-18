"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { BrandMark } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";

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

type IconName =
  | "home"
  | "trophy"
  | "users"
  | "user"
  | "shield"
  | "calendar"
  | "video"
  | "sparkles"
  | "bell"
  | "sync"
  | "userPlus"
  | "inbox"
  | "history"
  | "lock"
  | "shieldCheck"
  | "menu"
  | "close"
  | "chevronsLeft"
  | "chevronsRight";

// Small hand-drawn monoline icon set — kept dependency-free (no icon
// package in this repo) rather than pulling one in just for the sidebar.
// Purely decorative; every item still has a text label (or a title=
// tooltip when the sidebar is collapsed), so these carry no meaning on
// their own.
function Icon({ name, className = "w-[18px] h-[18px]" }: { name: IconName; className?: string }) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "home":
      return (
        <svg {...common}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
        </svg>
      );
    case "trophy":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M9 12 7 21l5-3 5 3-2-9" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6" />
          <circle cx="17" cy="9" r="2.3" />
          <path d="M16 14.2c2.4.4 3.8 2.1 3.8 5.8" />
        </svg>
      );
    case "user":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18" />
          <path d="M8 3v4" />
          <path d="M16 3v4" />
        </svg>
      );
    case "video":
      return (
        <svg {...common}>
          <rect x="3" y="6" width="13" height="12" rx="2" />
          <path d="M21 9l-5 3 5 3V9Z" />
        </svg>
      );
    case "sparkles":
      return (
        <svg {...common}>
          <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
        </svg>
      );
    case "bell":
      return (
        <svg {...common}>
          <path d="M6 10a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
      );
    case "sync":
      return (
        <svg {...common}>
          <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.6" />
          <path d="M4 4v4.6h4.6" />
          <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.4" />
          <path d="M20 20v-4.6h-4.6" />
        </svg>
      );
    case "userPlus":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2 21c0-4 3-7 7-7s7 3 7 7" />
          <path d="M19 8v6" />
          <path d="M16 11h6" />
        </svg>
      );
    case "inbox":
      return (
        <svg {...common}>
          <path d="M3 12h4l2 3h6l2-3h4" />
          <path d="M5 12 4 5h16l-1 7" />
          <path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
        </svg>
      );
    case "history":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" />
        </svg>
      );
    case "lock":
      return (
        <svg {...common}>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      );
    case "shieldCheck":
      return (
        <svg {...common}>
          <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case "menu":
      return (
        <svg {...common}>
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path d="M6 6l12 12" />
          <path d="M18 6 6 18" />
        </svg>
      );
    case "chevronsLeft":
      return (
        <svg {...common}>
          <path d="M11 17l-5-5 5-5" />
          <path d="M18 17l-5-5 5-5" />
        </svg>
      );
    case "chevronsRight":
      return (
        <svg {...common}>
          <path d="M13 17l5-5-5-5" />
          <path d="M6 17l5-5-5-5" />
        </svg>
      );
  }
}

type NavItem = { href: string; label: string; icon: IconName };
type NavGroup = { title: string; items: NavItem[] };

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);
  const [admin, setAdmin] = useState<AdminInfo | null>(null);
  const [isApprovedContributor, setIsApprovedContributor] = useState(false);

  // Desktop sidebar: icon-only collapsed state, remembered across visits.
  // Mobile never collapses — it's a full-width slide-out drawer instead.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("lv-admin-sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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

  // A link tap inside the mobile drawer navigates immediately — close the
  // drawer whenever the route changes instead of relying on every link's
  // onClick to remember to do it.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("lv-admin-sidebar-collapsed", next ? "1" : "0");
      } catch {
        // Non-critical — worst case the sidebar just forgets its state.
      }
      return next;
    });
  }

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

  // Same link set as before, just regrouped into sections for the sidebar
  // instead of one long horizontal row — nothing removed, nothing added
  // except an explicit "Dashboard" entry (previously only reachable via
  // the logo). "Manage Admins" stays the one super_admin-only item, per
  // the confirmed scope — every other item is identical for both roles.
  const navGroups: NavGroup[] = [
    { title: "Overview", items: [{ href: "/admin", label: "Dashboard", icon: "home" }] },
    {
      title: "Content",
      items: [
        { href: "/admin/tournaments", label: "Tournaments", icon: "trophy" },
        { href: "/admin/teams", label: "Teams", icon: "users" },
        { href: "/admin/players", label: "Players", icon: "user" },
        { href: "/admin/heroes", label: "Heroes", icon: "shield" },
        { href: "/admin/matches", label: "Matches", icon: "calendar" },
        { href: "/admin/streams", label: "Streams", icon: "video" },
      ],
    },
    {
      title: "Automation",
      items: [
        { href: "/admin/moment-templates", label: "Moment Templates", icon: "sparkles" },
        { href: "/admin/commentary", label: "Auto-commentary", icon: "sparkles" },
        { href: "/admin/telegram-notifications", label: "Telegram Notifications", icon: "bell" },
        { href: "/admin/data-sync", label: "Data Sync", icon: "sync" },
      ],
    },
    {
      title: "Community",
      items: [
        { href: "/admin/manage-contributors", label: "Manage Contributors", icon: "userPlus" },
        { href: "/admin/contributor-requests", label: "Contributor Requests", icon: "inbox" },
      ],
    },
    {
      title: "Account",
      items: [
        { href: "/admin/change-log", label: "Change Log", icon: "history" },
        { href: "/admin/change-password", label: "Change Password", icon: "lock" },
        ...(admin.role === "super_admin"
          ? [{ href: "/admin/manage-admins", label: "Manage Admins", icon: "shieldCheck" as IconName }]
          : []),
      ],
    },
  ];

  function isActive(href: string) {
    // "/admin" itself needs an exact match — every other admin path also
    // starts with "/admin", which would otherwise light up "Dashboard" on
    // every single page.
    if (href === "/admin") return pathname === "/admin";
    return pathname?.startsWith(href) ?? false;
  }

  function NavLinks({ showLabels }: { showLabels: boolean }) {
    return (
      <nav className="flex-1 overflow-y-auto py-3 space-y-4">
        {navGroups.map((group) => (
          <div key={group.title}>
            {showLabels && (
              <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-white/30">
                {group.title}
              </div>
            )}
            <div className="space-y-0.5 px-2">
              {group.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    title={showLabels ? undefined : item.label}
                    className={`flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors duration-150 ${
                      showLabels ? "" : "justify-center"
                    } ${
                      active
                        ? "bg-signal/15 text-signal-light"
                        : "text-white/60 hover:text-white hover:bg-white/[0.06]"
                    }`}
                  >
                    <Icon name={item.icon} />
                    {showLabels && <span className="truncate">{item.label}</span>}
                  </a>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    );
  }

  return (
    <div className="min-h-screen flex">
      {/* Desktop sidebar — collapses to an icon rail, state remembered in
          localStorage. Hidden entirely on mobile in favor of the drawer
          below. */}
      <aside
        className={`hidden md:flex flex-col shrink-0 border-r border-white/10 bg-ink/60 sticky top-0 h-screen transition-[width] duration-200 ${
          collapsed ? "w-[68px]" : "w-60"
        }`}
      >
        <a href="/admin" className={`flex items-center gap-2 px-4 py-3.5 border-b border-white/10 shrink-0 ${collapsed ? "justify-center px-0" : ""}`}>
          <BrandMark className="h-6 w-6 shrink-0" />
          {!collapsed && (
            <span className="font-display font-light text-sm tracking-tight text-paper truncate">
              LIVE<span className="text-signal">VIVAL</span>{" "}
              <span className="text-white/30 text-[10px] uppercase tracking-widest align-middle ml-1">Admin</span>
            </span>
          )}
        </a>
        <NavLinks showLabels={!collapsed} />
        <button
          onClick={toggleCollapsed}
          className="flex items-center justify-center gap-2 border-t border-white/10 py-3 text-white/40 hover:text-white transition-colors duration-150 shrink-0"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <Icon name={collapsed ? "chevronsRight" : "chevronsLeft"} className="w-4 h-4" />
          {!collapsed && <span className="text-xs">Collapse</span>}
        </button>
      </aside>

      {/* Mobile drawer + backdrop — only mounted when open. */}
      {mobileNavOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileNavOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-ink border-r border-white/10 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-white/10 shrink-0">
              <a href="/admin" className="flex items-center gap-2">
                <BrandMark className="h-6 w-6 shrink-0" />
                <span className="font-display font-light text-sm tracking-tight text-paper">
                  LIVE<span className="text-signal">VIVAL</span>{" "}
                  <span className="text-white/30 text-[10px] uppercase tracking-widest align-middle ml-1">Admin</span>
                </span>
              </a>
              <button onClick={() => setMobileNavOpen(false)} className="text-white/50 hover:text-white p-1" aria-label="Close menu">
                <Icon name="close" />
              </button>
            </div>
            <NavLinks showLabels={true} />
          </aside>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between px-4 md:px-6 py-3.5 border-b border-white/10 bg-ink/80 backdrop-blur sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="md:hidden text-white/60 hover:text-white p-1 -ml-1 shrink-0"
              aria-label="Open menu"
            >
              <Icon name="menu" />
            </button>
            <span className="md:hidden font-display font-light text-sm tracking-tight text-paper truncate">
              LIVE<span className="text-signal">VIVAL</span>
            </span>
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
            <LanguageToggle />
          <ThemeToggle />
            <button onClick={handleLogout} className="lv-btn-ghost">
              Sign out
            </button>
          </div>
        </header>
        <div className="p-4 md:p-6 min-w-0">{children}</div>
      </div>
    </div>
  );
}
