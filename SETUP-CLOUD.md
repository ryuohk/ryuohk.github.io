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

Password login does not use emailed links or require editable email templates.
These URL settings remain useful for any future email-recovery setup.

## 4. Create private password accounts (before deployment)

1. In **Authentication → Sign In / Providers**, disable **Allow new users to sign up**.
   Also keep anonymous sign-ins disabled. Removing a signup button alone is not
   sufficient: the public API must reject new registrations.
2. Keep **Confirm Email** enabled. Only an administrator should explicitly confirm
   accounts after checking the intended person's identity; do not allow anyone to
   claim an address on an approved domain without proof.
3. Add the person's email to `allowed_emails` before creating their account, or use
   the existing approved-domain rule. Membership and row-level security still
   control library access independently of whether login succeeds.
4. In **Authentication → Users → Add user → Create new user**, create the account
   with a unique temporary password of at least 12 characters and enable
   **Auto confirm user** for that approved person. Use **Create**, not **Invite**,
   which sends an email link. Do not grant readers Supabase organization access.
5. Give the password to the intended person through a trusted private channel.
   They sign in with email/password and use **Change password** in CramBot.

For an existing account that has no password, or a forgotten password, an admin can
set a temporary password with `supabase.auth.admin.updateUserById`. Preserve the
existing user ID so private progress and membership stay attached to the account.
For example, run the following with the Supabase SDK only in a trusted local admin
environment, never in the browser or frontend build:

```js
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const { error } = await admin.auth.admin.updateUserById(process.env.CRAMBOT_USER_ID,
  { password: process.env.CRAMBOT_TEMP_PASSWORD, email_confirm: true });
if (error) throw error;
```

Use temporary local environment variables; do not commit passwords or privileged
keys, put them in `VITE_*` variables, or share them in chat. Clear them afterward.
Normal sign-in and password changes do not depend on SMTP. If Supabase's secure
password-change policy requires email reauthentication for an old session, sign out
and sign in with the current password before changing it. Forgotten passwords are
reset by the administrator until a reliable email-recovery flow is configured.

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

Enter your email and the password set by the administrator. Use **Change password**
to replace a temporary password. CramBot then loads, empty, with a **Synced** badge
in the top right.

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
2. Sign in with the same email and password. No email link is needed.
3. The badge shows **Syncing…** while it downloads the library. First pull is the slow
   one; do it on wi-fi.
4. Once it settles on **Synced**, the card count matches your desktop.
5. Install it: iPhone → **Share → Add to Home Screen**. Android → **menu → Install app**.

From then on it opens like a normal app, works offline, and any device you sign into
picks up the same library.

Your friend does exactly the same thing. They get all 286 questions with Unrated
mastery labels of their own; your rating history stays yours.

## 10. Lock the door behind you

Confirm **Allow new users to sign up** is still disabled as configured in step 4.
Keep it disabled when adding people: create their accounts as an administrator.
The membership checks and database policies remain a second access boundary.

---

## Changing who has access

The invite list is the `allowed_emails` table. No client can read or modify it; use the
SQL Editor.

Add someone:

```sql
insert into public.allowed_emails (email, note) values ('new@example.com', 'why');
```

Create their password account as described in step 4. A trigger grants membership
when the account is created. For an existing account, backfill membership using the
migration rather than deleting and recreating the account.

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
- **No password / forgotten password**: ask the administrator to set a temporary
  password as described in step 4. Password login does not send an email.
- **Badge stuck on "Sync problem"**: hover it for the error. Usually a missing redirect
  URL from step 3 or an expired session; sign out and back in.
- **Badge says "queued"**: normal offline behavior. Changes drain on reconnect.
