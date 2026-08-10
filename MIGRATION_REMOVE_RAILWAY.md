# Migration Guide: Remove Railway Worker

This guide walks through removing the Railway always-on worker and relying solely on GitHub Actions cron jobs for Liquipedia data syncing.

## Overview of Changes

**Before:**
- Vercel: Next.js website
- Supabase: Database
- GitHub: Code repo + 6-hourly cron
- Railway: **Always-on worker** (20-second Liquipedia polling)

**After:**
- Vercel: Next.js website
- Supabase: Database
- GitHub: Code repo + 6-hourly cron
- Railway: **Removed** ❌

## Impact Assessment

### What You Lose
- Real-time Liquipedia polling (20-second intervals)
- Automatic live score/pick/ban updates during broadcasts
- Immediate series result sync

### What You Keep
- All historical data backfill (6-hourly cron)
- Manual local OCR capture (admin console)
- Admin ability to manually override with `update_source = 'local_ocr'`
- Full website functionality

### Data Freshness
- **With Railway**: Updates every ~20 seconds during active matches
- **Without Railway**: Updates every 6 hours (scheduled cron)
- **With Local OCR**: Real-time (admin manual entry)

**Recommendation**: Acceptable if most broadcasts use manual OCR capture.

---

## Step 1: Verify Current GitHub Actions Cron

### Check existing Liquipedia import job

```bash
cat .github/workflows/liquipedia-import.yml
```

**Expected output**: A cron job that runs every 6 hours and syncs all Liquipedia data.

If this file doesn't exist or is misconfigured, create/fix it first before removing Railway.

### Verify it includes all necessary sync logic

The workflow should handle:
- ✅ Tournament discovery
- ✅ Team/hero roster backfill
- ✅ Match schedule updates
- ✅ Finished match sync (scores, picks/bans, VOD links)

**Action**: If any of these are missing, update the cron job before proceeding.

---

## Step 2: Audit Dependent Code

### Check if any Next.js code depends on real-time polling

Search for references to the worker:

```bash
grep -r "worker\|railway\|polling\|POLL_INTERVAL" app/ lib/ --include="*.ts" --include="*.tsx"
```

Expected: No matches (the worker is isolated in `/worker/`)

**If matches found**: Update those components to not expect 20-second updates.

### Check for Railway environment variables in Next.js

```bash
grep -r "RAILWAY\|POLL_INTERVAL\|RECENT_WINDOW\|IMMINENT_WINDOW" . --include=".env*" --include="*.ts" --include="*.tsx" | grep -v "worker/"
```

Expected: No matches outside `/worker/`

**If matches found**: Remove those variable references.

---

## Step 3: Remove Railway from Supabase (if using Supabase managed)

### Check if Railway has database write permissions

Railway uses `SUPABASE_SERVICE_ROLE_KEY` with full admin access. After removal, only the Next.js app will write to Supabase.

**Action**: In Supabase dashboard, revoke any Railway-specific credentials if they exist.

```sql
-- Optional: Verify who has written to tables recently
-- Run in Supabase SQL editor to see last modified timestamps
SELECT table_name, last_update FROM pg_stat_user_tables ORDER BY last_update DESC;
```

---

## Step 4: Delete Railway Worker Files

### Remove the entire worker directory

```bash
rm -rf worker/
```

This removes:
- `/worker/README.md`
- `/worker/liquipediaClient.mjs`
- `/worker/index.mjs`
- `/worker/package.json`
- `/worker/package-lock.json`

### Verify removal

```bash
ls worker/ 2>/dev/null && echo "❌ Worker directory still exists" || echo "✅ Worker directory removed"
```

---

## Step 5: Update Documentation

### Update root README.md

Replace this section:

```markdown
## Match automation (Groq vision worker)

`supabase/schema.sql` adds the tables/columns for automated match tracking...
`worker/` is a separate always-on Node process (deploy on Railway, not Vercel)...
```

With:

```markdown
## Match automation

The website supports two match data sources:

1. **Liquipedia** (`update_source = 'liquipedia'`): Synced every 6 hours via GitHub Actions cron job
   - Runs `.github/workflows/liquipedia-import.yml` automatically
   - Updates schedule, scores, picks/bans, VOD links
   - Historical data backfill

2. **Local OCR** (`update_source = 'local_ocr'`): Real-time manual capture via admin console
   - Admins use the live admin panel to enter data
   - OCR can auto-detect kills/moments with Tesseract.js
   - Full control over data accuracy
   - Can be toggled per-match as needed
```

### Update any deployment docs

Remove all references to Railway deployment from docs/

```bash
grep -r "railway\|Railway" docs/ --include="*.md"
# Update or remove any matching lines
```

---

## Step 6: Commit and Push Changes

### Stage the removal

```bash
git add -A
git commit -m "Remove Railway worker - rely on GitHub Actions cron for Liquipedia sync

- Delete /worker directory (always-on Node.js process)
- Remove Railway-specific documentation
- Keep 6-hourly Liquipedia import via GitHub Actions
- Local OCR capture remains available for real-time admin updates

Impact: Liquipedia updates change from ~20s to ~6h intervals.
Mitigation: Broadcasts can use manual OCR for real-time data entry.

No database migrations required - all existing data preserved."
```

### Push to GitHub

```bash
git push -u origin main
```

**Verify**: Visit GitHub repo to confirm commit appears.

---

## Step 7: Disable/Delete Railway Service

### Log into Railway dashboard

1. Go to https://railway.app
2. Navigate to your Livevival project
3. Select the worker service

### Option A: Delete the service (recommended)

1. Click **Settings** → **Delete Service**
2. Confirm deletion
3. Railway stops billing immediately

### Option B: Pause the service (if unsure)

1. Click **Settings** → **Pause**
2. Can be re-enabled anytime in next 30 days
3. After 30 days, it's deleted automatically

**Recommendation**: Use Option A (delete) since you won't need it anymore.

---

## Step 8: Verify GitHub Actions Cron Still Works

### Check cron job status

1. Go to your GitHub repo
2. Click **Actions** tab
3. Look for **Liquipedia Import** workflow
4. Check **Run History**

**Expected**: 
- ✅ Runs every 6 hours (or custom interval)
- ✅ Shows recent successful runs
- ✅ Latest run within last 6 hours

### Manual trigger to verify

```bash
# Go to GitHub repo > Actions > Liquipedia Import > Run workflow
# Click "Run workflow" button to test immediately
```

**Verify in Supabase**: Check if `matches`, `games`, `heroes`, `teams` tables were updated.

---

## Step 9: Test Admin Console Still Works

### Local OCR capture should still function

1. Go to admin console: `/admin/matches/[id]/live`
2. Check that **Local Capture** section is available
3. Verify OCR tracker is functional (if using local_ocr matches)

### Verify match data syncing

1. Pick a match with `update_source = 'liquipedia'`
2. Wait for next cron run (or trigger manually)
3. Verify picks/bans, scores, VOD links are updated in admin panel

---

## Step 10: Update Environment Variables

### Remove Railway-specific vars from CI/CD

If any GitHub Actions workflows reference Railway vars:

```yaml
# Remove these from .github/workflows/*.yml if present:
RAILWAY_API_TOKEN: ${{ secrets.RAILWAY_API_TOKEN }}
RAILWAY_PROJECT_ID: ${{ secrets.RAILWAY_PROJECT_ID }}
```

### No changes needed for:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Vercel deployment env vars

---

## Rollback Plan (if needed)

If you discover you need real-time Liquipedia polling:

### Option 1: Restore from Git

```bash
git revert <commit-hash>  # Reverts the removal commit
git push origin main
```

### Option 2: Re-enable Railway Service

1. Go to https://railway.app
2. In Livevival project, click **Create New Service**
3. Select "Deploy from repo"
4. Point to `worker/` directory (restore from git history)
5. Set environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `POLL_INTERVAL_SECONDS` (default: 20)
6. Deploy and monitor

---

## Verification Checklist

- [ ] Worker directory deleted (`ls worker/` returns error)
- [ ] Documentation updated (README.md)
- [ ] GitHub Actions cron job still runs every 6 hours
- [ ] Railway service deleted or paused
- [ ] Commit pushed to main
- [ ] Admin console still works
- [ ] Test match shows updated data after cron run
- [ ] No Railway references remain in code/docs

---

## FAQ

### Q: Will I lose any data?
**A**: No. All existing Liquipedia data stays in Supabase. The cron job syncs new data every 6 hours.

### Q: What about matches currently in progress?
**A**: 
- If using `update_source = 'liquipedia'`: Data updates at next cron run (max 6 hours)
- If using `update_source = 'local_ocr'`: Real-time updates via admin console

### Q: Can I add Railway back later?
**A**: Yes. Just restore `/worker/` from git history and redeploy to Railway.

### Q: What if Liquipedia data is critical in real-time?
**A**: Use local OCR capture (`update_source = 'local_ocr'`) for active broadcasts. Admins manually enter data as it happens.

### Q: Will this affect costs?
**A**: Yes, you'll save ~$5-7/month (Railway's always-on process cost).

### Q: What about the Groq vision stuff mentioned in old docs?
**A**: That was replaced by the Liquipedia worker. Now it's just a data sync worker (no vision/ML involved). After removal, only local OCR remains for moment detection.

---

## Migration Summary

| Component | Before | After | Status |
|-----------|--------|-------|--------|
| Vercel Next.js | ✅ | ✅ | Unchanged |
| Supabase DB | ✅ | ✅ | Unchanged |
| GitHub Cron | ✅ (6h) | ✅ (6h) | Unchanged |
| Railway Worker | ✅ (20s poll) | ❌ | Removed |
| Local OCR | ✅ | ✅ | Unchanged |
| Real-time updates | Via Railway | Via manual OCR | Changed |
| Data freshness | ~20s / 6h | 6h / Real-time | Slightly less fresh for Liquipedia |
| Monthly cost | ~$5-7 less | Lower | Savings |

---

## Next Steps

1. **Run this checklist** before proceeding
2. **Test on a non-critical match** if possible
3. **Keep a git branch** for rollback during first week
4. **Monitor Supabase** after first cron run
5. **Communicate to admins** that real-time Liquipedia sync is gone
6. **Recommend OCR capture** for time-sensitive broadcasts

For questions or issues, refer to:
- `/worker/README.md` (before deletion) - explains worker logic
- `.github/workflows/liquipedia-import.yml` - current cron job
- Admin console docs - local OCR capture setup
