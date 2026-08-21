# Hot Match OCR Fixes & Changelog

## 📅 Tanggal: 21 Agustus 2026

---

## 🎯 Ringkasan Masalah (Issue Summary)
Pada admin control **Hot Match Live Console** (`/admin/matches/[id]/live`), angka **Team Kills** kerap mengalami lonjakan tiba-tiba ke angka yang salah/sangat besar (*fabricated/inflated kills*), atau naik-turun secara tidak wajar saat OCR membaca frame video broadcast.

---

## 🔍 Root Cause Analysis (Penyebab Utama)

Terdapat konflik logika antara 2 lapisan validasi di [`app/admin/matches/[id]/live/page.tsx`](file:///d:/livevival/app/admin/matches/%5Bid%5D/live/page.tsx):

1. **Lapisan Observasi (`teamKillObservation`)**:
   - Berfungsi mendeteksi validitas pembacaan angka kill (aturan monotonik: kills hanya bertambah naik).
   - Ketika OCR membaca angka yang lebih rendah dari nilai terkonfirmasi saat ini (`normalized < confirmed`), fungsi ini menandai `accepted: false` (*suspicious / not overwritten*).
   - Namun, fungsi tetap mengembalikan nilai angka `normalized` (bukan `null`).

2. **Lapisan Konsensus (`teamKillConsensusRef`)**:
   - Kode sebelumnya hanya mengecek:
     ```ts
     if (kills == null) { ... }
     ```
   - Kode **tidak memeriksa `obs.accepted`**.
   - Akibatnya, pembacaan noisy/salah yang ditandai `accepted: false` tetap masuk ke dalam buffer konsensus sebagai vote penurunan atau perubahan.
   - Setelah 2 tick berturut-turut membaca frame noise yang sama (misalnya angka kill "4" bercampur grafis HUD lain menjadi "48"), sistem langsung meng-commit nilai 48 ke database (`team_a_kills_override` / `team_b_kills_override`).
   - Begitu nilai 48 tersimpan, aturan monotonik mengunci nilai tersebut sehingga tidak bisa turun lagi secara otomatis via OCR.

---

## 🛠️ Perubahan & Solusi yang Diterapkan

### 1. File yang Dimodifikasi:
- [`app/admin/matches/[id]/live/page.tsx`](file:///d:/livevival/app/admin/matches/%5Bid%5D/live/page.tsx#L4994-L5010)

### 2. Perubahan Kode:
```diff
             const kills = obs.normalized;
 
             // ── Consensus decision ────────────────────────────────────────
             let decisionReason = obs.reason;
-            if (kills == null) {
+            if (kills == null || !obs.accepted) {
+              // null  → blank / merged / implausible — keep last confirmed.
+              // !accepted → below confirmed: teamKillObservation already flagged
+              // this as suspicious ("kills only go up"). Do NOT buffer it as a
+              // downward-consensus vote.
               decisionReason = obs.reason;
             } else {
               shadowReads.teamKills[sideTeamId] = kills;
```

### 3. Cara Kerja Setelah Perbaikan:
- **Pembacaan Valid & Naik**: Tetap melalui konsensus 2 tick sebelum di-commit secara aman.
- **Pembacaan Mencurigakan / Turun**: Langsung diabaikan (`accepted: false`), tidak mengganggu buffer konsensus, dan tidak akan mengubah skor kill.
- **Koreksi Manual**: Jika operator admin memang ingin menurunkan angka kill karena kesalahan input, tombol **Manual Override / Set Kill Count** di UI admin tetap bekerja secara prioritas dan melewati filter OCR selama masa cooldown.

---

## 🚀 Status Deployment
- Branch: `main`
- Commit: `a6b2c42` & `3b6c01a`
- Status: Siap dan aktif di production Vercel.
