# Turning on the shared, invite-only library

CramBot works two ways. Built with no Supabase credentials it is exactly what it was
before: everything lives in one browser, no sign-in, no cloud. Built with credentials
it becomes invite-only, and the two invited people share one question library while
keeping their own review progress private.

This is the one-time setup for the second mode. Run the commands from the repository
root in PowerShell. Everything used here is on Supabase's free tier.

The Supabase organization already exists from the earlier session:
**`jvggdoisqonqaxspxtxp`** (named CramBot).

---

## 1. Create the project

```powershell
npx supabase projects create crambot --org-id jvggdoisqonqaxspxtxp --region us-west-1
```

It prompts for a database password. Pick a strong one and save it in your password
manager. You need it again in step 2, and there is no way to recover it later.

Then get the project reference, a 20-character string:

```powershell
npx supabase projects list
```

Everything below writes it as `<REF>`.

## 2. Apply the schema

The schema migrations are in `supabase/migrations/`. Apply them in filename order.

**Easiest way:** open the project in the Supabase dashboard, go to **SQL Editor**,
paste each migration file in filename order, and run it. Existing installations only
need migrations they have not applied yet.

**CLI way**, if you prefer:

```powershell
npx supabase init          # add --force if it objects to the existing supabase/ folder
npx supabase link --project-ref <REF>
npx supabase db push
```

Either way, check the Table Editor afterwards. You should see `questions`, `cards`,
`card_progress`, `reviews`, `deletions`, `library_members` and `allowed_emails`.

## 2b. Add the invite list

The migration ships with an empty invite list on purpose, because real addresses do not
belong in a public repository. In the **SQL Editor**, run this with your own addresses
substituted:

```sql
insert into public.allowed_emails (email, note) values
  ('you@example.com',    'owner'),
  ('friend@example.com', 'friend')
on conflict (email) do nothing;
```

Until at least one address is in that table, nobody can reach the library, including
you. Keep this snippet somewhere private; you need the same addresses in step 4.

## 3. Point auth at the live site

In the dashboard under **Authentication → URL Configuration**:

- **Site URL:** `https://ryuohk.github.io`
- **Redirect URLs:** add `https://ryuohk.github.io/**` and, for local development,
  `http://localhost:5173/**`

Sign-in links that come back to any other address are rejected, so this step is not
optional.

## 4. Make sure your friend can actually receive the email

This is the one part that bites people. Supabase's built-in email service **refuses to
send to anyone who is not a member of your Supabase organization**, and it is rate
limited to a handful of messages per hour. Left alone, your own sign-in link would
arrive and your friend's would fail with "Email address not authorized."

Pick one:

**Option A, free and instant.** In the dashboard, **Organization → Team → Invite**, and
invite your friend's address with the read-only role. Supabase's mailer will then
deliver to that address. The trade-off is that they can see the project dashboard. For
two friends sharing a study app that is usually fine.

**Option B, better long term.** Set up custom SMTP under **Authentication → Emails →
SMTP Settings**. Brevo's free tier sends 300 messages a day and only needs a verified
sender address, no domain purchase. This removes both the recipient restriction and the
rate limit, and your friend needs no Supabase access at all.

Sessions persist and refresh themselves, so a sign-in link is only needed on a new
device. Option A is enough to get going; move to Option B if email starts feeling
flaky.

## 5. Feed the keys to the build

```powershell
npx supabase projects api-keys --project-ref <REF>
```

Copy the **anon** key (not `service_role`, which bypasses every security policy and
must never leave your machine). Then:

```powershell
gh variable set VITE_SUPABASE_URL --body "https://<REF>.supabase.co"
gh variable set VITE_SUPABASE_ANON_KEY --body "<the anon key>"
```

Both values are public by design. The anon key only reaches the API layer, and every
table is guarded by row-level security plus the invite list, so a stranger holding it
reads nothing.

For local development, copy `apps/web/.env.example` to `apps/web/.env.local` and put the
same two values there.

## 6. Deploy

```powershell
git add -A
git commit -m "Add invite-only shared library"
git push
```

GitHub Actions rebuilds and redeploys. Watch it with `gh run watch`.

## 7. First sign-in, on your desktop

Wait for the deploy to finish, then open <https://ryuohk.github.io/> in your desktop
browser. You should get a sign-in screen instead of the app.

If you still see the old app, the previous service worker is serving its cache. Reload
once more, or press Ctrl+Shift+R.

Enter your own address, then open the emailed link **in the same browser**. Opening
it elsewhere fails, because the sign-in exchange is tied to the browser that asked.
CramBot then loads, empty, with a **Synced** badge in the top right.

## 8. Upload your question library

Do this from the desktop, where the capture files already live.

1. Go to **Import**.
2. Select **Choose one or more captures**.
3. Pick the combined `*-combined-repaired.crambot.json` in your capture folder.

The combined file holds every question already de-duplicated. You can instead select all
the individual capture files at once and CramBot will merge them, but the combined file
is faster and produces the same library.

Importing writes to your browser first, so the card count jumps immediately. Uploading
happens behind it: the badge changes to **Syncing… N left** and counts down as pages of
cards land. It is moving roughly 35 MB, since every question carries its diagram inline
and the card copies it, so give it a few minutes on a normal connection.

Leave the tab open until the badge reads **Synced**. If you close it early nothing is
lost; the queue resumes where it stopped next time you open the app.

Confirm it landed by checking **Table Editor → cards** in the Supabase dashboard. You
should see 286 rows, and **Reports → Database** should show roughly 35 MB used of your
500 MB.

## 9. Open it on your phone

1. Go to <https://ryuohk.github.io/> in Safari (iPhone) or Chrome (Android).
2. Sign in with the same address. Open the emailed link on the phone itself.
3. The badge shows **Syncing…** while it downloads the library. First pull is the slow
   one; do it on wi-fi.
4. Once it settles on **Synced**, the card count matches your desktop.
5. Install it: iPhone → **Share → Add to Home Screen**. Android → **menu → Install app**.

From then on it opens like a normal app, works offline, and any device you sign into
picks up the same library.

Your friend does exactly the same thing. They get all 286 questions with Unrated
mastery labels of their own; your rating history stays yours.

## 10. Lock the door behind you

Once you have both signed in at least once, go to **Authentication → Sign In / Providers
→ Email** and turn off **Allow new users to sign up**. After that, not even an
accidental signup is possible.

You can skip this and still be safe: an uninvited account gets no membership row, so
row-level security hands it an empty library and rejects every write. This step just
removes the possibility entirely.

---

## Changing who has access

The invite list is the `allowed_emails` table. No client can read or modify it; use the
SQL Editor.

Add someone:

```sql
insert into public.allowed_emails (email, note) values ('new@example.com', 'why');
```

They then sign in normally and a trigger grants membership.

Remove someone:

```sql
delete from public.library_members where email = 'old@example.com';
delete from public.allowed_emails  where email = 'old@example.com';
```

Their next request reads nothing and writes nothing. Anything already synced to their
device stays there, the same as any file you have already shared with a person.

## What is shared and what is not

| Data | Shared |
| --- | --- |
| Imported questions, choices, images, explanations | Yes |
| Card content and corrections | Yes |
| Card deletions | Yes, they disappear for both of you |
| Mastery labels and rating history | No, private per person |
| Personal notes and card flags | No, private per person |
| Mastery settings and active session | No, they stay in each browser |

Deleting cards now affects both of you, and the confirmation dialog says so. Re-importing
a capture brings deleted cards back for everyone.

## Cost and limits

The free tier gives 500 MB of database space. Captured questions carry their images
inline as base64, so image-heavy exams use it faster than you would expect. Check
**Reports → Database** now and then. If it fills up, the fix is to move images into
Supabase Storage instead of the question rows.

Free projects also pause after a week with no activity. Opening the app wakes it, and
studying regularly keeps it awake.

## If something goes wrong

Nothing here can lose your data: IndexedDB stays the source of truth on each device and
**Export backup** still works offline.

- **"Not on the invite list"** after signing in: the address is not in `allowed_emails`,
  or it was added after the account was created. Add it, then run the backfill statement
  at the bottom of the migration.
- **No email arrives**: see step 4. Check **Authentication → Logs** in the dashboard.
- **Badge stuck on "Sync problem"**: hover it for the error. Usually a missing redirect
  URL from step 3 or an expired session; sign out and back in.
- **Badge says "queued"**: normal offline behavior. Changes drain on reconnect.
