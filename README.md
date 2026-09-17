# CramBot

CramBot is a private, local-first exam study system with two parts:

1. A Chrome/Edge extension that reveals and captures questions, images, vote data, and complete threaded discussions from a question page you open.
2. An installable study web app that imports those captures and tracks explicit mastery labels.

Open the hosted app at **https://ryuohk.github.io/**.

The extension does not read or store credentials or cookies and does not bypass access controls. It captures only pages available in the tab you select. Automatic capture follows that exam's own **Next Questions** links only after you explicitly start it; progress is kept in extension storage until the combined download is prepared. Check the site's current terms before using automated extraction, and keep captured material private.

## Current capabilities

- User-initiated capture of the current page or every remaining page in the selected exam
- Page-load, DOM-stability, and image waits before each automatic capture
- Automatic click-and-wait for hidden `Reveal Solution` answers
- Correct-answer, most-voted-answer, vote distribution, explanation, and portable embedded image extraction
- Complete discussions with comment IDs, reply relationships, authors, timestamps, selected answers, upvotes, badges, and links
- Multiple-answer keys such as `AE`
- Duplicate-safe imports that preserve mastery labels
- Captured discussions shown as collapsible reply threads when an answer is revealed, with authors, dates, selected answers, upvotes, badges, and links
- Multiple exams held side by side, with an exam filter that scopes study sets, the library, progress figures, label resets, and bulk deletes
- Searchable question library with single, multi-select, and delete-all controls
- Offline IndexedDB storage and an installable PWA shell
- Optional invite-only cloud sync: a shared question library with private per-person mastery progress
- Mastery sets that draw only from questions not labeled Easy
- A focused Again + Hard pool for targeted remediation
- Configurable question counts for Mastery sets and Easy reviews
- Easy-only review ordered by the least recently practiced questions
- Relabeling during Easy review sends questions back to future Mastery sessions
- One-button reset of mastery labels for all exams or for one selected exam, without deleting questions or rating history
- Selectable answer choices plus Space and 1–4 keyboard shortcuts
- Full-library backup and restore for questions, ratings, notes, and mastery settings

## Install dependencies and build

Requirements: Node.js 22 or later.

```powershell
npm install
npm run build:icons
npm run check
```

Build outputs:

- Browser extension: `apps/extension/dist`
- Deployable web app: `apps/web/dist`

## Load the browser extension

Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `apps/extension/dist` folder.

Edge:

1. Open `edge://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `apps/extension/dist` folder.

After rebuilding the extension, use **Reload** on its extensions page.

## Capture exam questions

1. Sign in to the question site yourself and open the viewer page where capture should begin. Later pages of an exam typically use `/view/2/`, `/view/3/`, and so on.
2. Open the CramBot extension and select **Choose output folder**. The extension remembers this folder for later runs. After restarting Chrome or Edge, select **Restore _folder name_** once if the browser asks to renew write access.
3. Select **Capture this page** for one page, or **Capture all remaining pages** to continue through the exam automatically.
4. Keep that tab open. Automatic mode waits for the page and its images to settle, captures each complete question/discussion pair, then follows the same exam's **Next Questions** link.
5. The extension saves one combined `.crambot.json` file into the selected folder when capture finishes.

Use **Stop automatic capture** to interrupt immediately. Every question whose complete discussion was already captured is retained and written to a partial JSON file; an in-progress pair is excluded. If folder access expires before the file can be written, choose the folder again and select **Save retained capture data**.

Question and answer images are embedded in the capture so they remain available offline and after transfer to another device. The original image URL is retained as a fallback when embedded image data is unavailable. Image-heavy pages produce larger JSON files; if an image cannot be downloaded, the export keeps its URL and records a warning instead of failing the whole page.

If an answer does not appear within four seconds, the export records the timeout and does not invent an answer. Importing that question produces a visible `missing answer` warning card so it can be recaptured.

## Run the study app locally

```powershell
npm run dev:web
```

Open the URL Vite prints, normally `http://localhost:5173`. In CramBot, open **Import** and select one or more downloaded page captures in the same file-picker operation. CramBot combines and deduplicates them during import; no separate merge step is required. Import a full-library backup by itself. A synthetic test capture is available at `fixtures/sample-capture.crambot.json`.

Local development is suitable for desktop testing. Phone installation requires the production `apps/web/dist` directory to be hosted over HTTPS.

## Question equality and existing libraries

Duplicate detection uses normalized content, not supplied question IDs. Previously, imports trusted supplied IDs (allowing identical content under different IDs) and generated IDs omitted correct answers (allowing answer variants to overwrite one another). There was no content cleanup for an existing library.

The conservative equality policy for TASK-0003 is:

- Keep different exam codes, prompts, ordered choices, correct-answer sets, community-answer sets, vote distributions, explanations, discussion counts, and discussion content separate. Text case and punctuation matter. Existing whitespace normalization trims text, collapses repeated spaces and blank lines, and preserves line breaks; this does not compare rendered HTML or visually equivalent text.
- Ignore question IDs, source-page URLs, question numbers, topics, and capture timestamps. Discussion IDs and source-page URLs are ignored; reply relationships are compared by comment position. All other discussion fields, including authors, dates, relative times, votes, badges, and reference links, matter. A refreshed discussion can therefore remain a separate entry.
- Images are ordered and include role and alt text. Compare exact embedded data URLs when available, otherwise exact source URLs. Equal embedded data at different URLs consolidates; different bytes at the same URL stays separate. Embedded versus URL-only images remain separate because equality is unverified. Different encodings of visually identical images are not decoded or compared.
- Legacy cards with different displayed fronts, answers, explanations, images, types, or answer confidence remain separate even if their question records match.

Cleanup covers new captures and imports, existing libraries on load, restored backups, and cloud pulls. The library and study pools show one entry per equality group. Saved groups and session queues map old IDs to the retained card, with duplicate queue positions removed; previous attempts remain in history. Intentional repetition after **Not yet** is unchanged.

Existing records are consolidated as a **non-destructive view**, not physically deleted from IndexedDB or the shared server. Backups and sync retain every original ID and rating record, protecting other members' private progress. The earliest-created card (then ID as a tie-breaker) represents a group. Its visible progress comes from the most recent rating or explicit reset; distinct note blocks and flags are combined, as are topic tags. Original metadata and notes remain in the backing records. Re-imports reuse the matching card ID and preserve its creation time and study data. Deleting a consolidated entry explicitly deletes all its backing cards, subject to the existing ownership checks.

## Install on a phone

Deploy `apps/web/dist` to an HTTPS static host, then open its URL on the phone once while online.

- **iPhone/iPad:** open the URL in Safari, select **Share**, then **Add to Home Screen**.
- **Android:** open the URL in Chrome, open the browser menu, then select **Install app** or **Add to Home screen**.

The installed app works offline after its first successful load. Study data stays in that device's browser storage; use **Export backup** and **Import** to move it between devices.

## Invite-only shared library

CramBot runs in one of two modes, decided at build time by whether Supabase credentials are present.

**Local-only** (no credentials): the default. No sign-in, no network, everything stays in one browser. The Supabase client is tree-shaken out of the bundle entirely.

**Shared** (credentials set): the app opens on a sign-in screen. Only addresses on the invite list can get in. Invited people share one question library and keep their own private mastery labels, rating history, notes, and flags.

Setup is a one-time job documented in **[SETUP-CLOUD.md](SETUP-CLOUD.md)**, including how to change who has access later.

Access is enforced by Postgres row-level security, not by the interface. A signed-out visitor and an uninvited account both read nothing, whatever they send to the API.

## Move a library between devices manually

Cloud sync handles this automatically, but export still works and needs no network:

1. On the first device, select **Export backup**.
2. Transfer the resulting `crambot-library-YYYY-MM-DD.json` file privately.
3. On the second device, open **Import** and select the library backup.

This merges the cards and review records into that browser.

## Verification

```powershell
npm run check
```

The check runs core schema/card tests, DOM parser tests, import/backup tests, scheduling tests, TypeScript compilation, extension bundling, and the production PWA build.

The live page DOM remains the final selector test because authenticated subscription pages are not available to automated test runners. Do not commit real captures; `*.crambot.json` is ignored.
