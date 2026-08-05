import type { Metadata } from "next";
import AdminShell from "@/app/admin/AdminShell";

// Server component on purpose — `metadata` exports only work from a
// Server Component, and the actual admin UI (auth check, nav, sign-out)
// needs client-side hooks (useRouter/useState/etc.), so that logic lives
// in AdminShell below and stays untouched here. This split is the only
// change from before: same shell, now wrapped so the admin section can
// advertise its own installable-PWA manifest (icons, brand colors) instead
// of inheriting the public site's /site.webmanifest — see
// public/admin/manifest.json. Admin PWA install + the asset-caching
// service worker registration (public/admin/sw.js, wired up inside
// AdminShell) are scoped to "/admin" only; the public site is untouched.
export const metadata: Metadata = {
  manifest: "/admin/manifest.json",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
