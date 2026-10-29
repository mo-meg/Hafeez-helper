# Publish Hafeez Helfer for free (GitHub Pages + Supabase accounts)

The app is static files, so GitHub Pages can host it for free. Accounts and the saved history of
each user live in a free Supabase project. Without Supabase settings the same code builds a
**local-only** app (no sign-in, data stays in the browser), which is also what you get when you run
it locally without a `.env` file.

You need: a GitHub account, a Supabase account (free plan), and about 15 minutes.

## 1. Put the code on GitHub

```bash
cd Hafiz
git add -A
git commit -m "Hafeez Helfer"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`node_modules/`, `dist/`, `.env` and downloaded Quran data are ignored by `.gitignore`.

## 2. Create the Supabase project

1. Go to <https://supabase.com>, create a free project (choose a region near your users and a
   strong database password; you will not need that password in the app).
2. **SQL Editor → New query**: paste the whole of [`supabase/schema.sql`](../supabase/schema.sql)
   and press **Run**. It creates one table, `user_records`, with Row Level Security so every user
   can only read and write their own rows, plus a `delete_my_account()` function used by
   Settings → Account → Delete account.
3. **Project Settings → API**: copy the **Project URL** (`https://xxxx.supabase.co`) and the
   **anon public** key. Both are meant to be public; never use the `service_role` key in the app.

## 3. Configure sign-in (Authentication settings)

* **Authentication → Sign In / Providers → Email**: keep *Email* enabled. *Confirm email* is
  recommended (users click a link before their first sign-in). Set the minimum password length to
  8 to match the app.
* **Authentication → URL Configuration**:
  * **Site URL**: your Pages address, e.g. `https://<you>.github.io/<repo>/`
  * **Redirect URLs**: add the same address (and `http://127.0.0.1:5173/` for local testing).
  Confirmation and password-reset emails return to this address; the app finishes the sign-in or
  asks for the new password.
* Optional: **Authentication → Emails** to translate the email templates into Arabic. The free
  plan sends a limited number of emails per hour; for real traffic add your own SMTP server under
  **Authentication → SMTP Settings**.

## 4. Turn on GitHub Pages and give the build the two values

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Repository **Settings → Secrets and variables → Actions → Variables → New repository variable**:
   * `HAFEEZ_SUPABASE_URL` = the Project URL
   * `HAFEEZ_SUPABASE_ANON_KEY` = the anon public key
3. **Actions → Deploy to GitHub Pages → Run workflow** (or push any commit). The workflow in
   `.github/workflows/deploy.yml` runs lint, typecheck and tests, builds `dist/` with the two
   values, and publishes it. The site address appears in the workflow summary.

Open the site: you should see the sign-in screen in Arabic. Create an account, mark a mistake,
then sign in on another device or browser: the mistake is there.

## Local development with accounts

Create `.env` in the project root (it is git-ignored):

```
HAFEEZ_SUPABASE_URL=https://xxxx.supabase.co
HAFEEZ_SUPABASE_ANON_KEY=eyJ...
```

Then `npm run build && npm start` and open <http://127.0.0.1:5173/>. Delete the two lines to go back
to local-only mode.

## How it works (short)

* Sign-in is email + password through Supabase Auth's HTTP API; no SDK is bundled.
* Each account has its own IndexedDB database on the device, so two people sharing a browser never
  see each other's data. The app works offline after the first sign-in; changes wait in an outbox
  and upload when the connection returns.
* Records (mistakes, answers, history events, plans, sessions, plus the preferences and reading
  position) are uploaded as JSON rows; downloads are incremental by a server-assigned counter.
  If the same record changed on two devices, the last upload wins; a change that has not been
  uploaded yet is never overwritten by an older server copy.
* History saved on a device before accounts were enabled can be added to the account once (the
  app asks after the first sign-in).
* Signing out removes the account's local copy from the device; the history stays in the account.
  Delete account removes the user and every row on the server.

## Costs and limits

GitHub Pages and the Supabase free plan cost nothing for a personal or small community project.
Supabase pauses free projects after a week without any requests; the next request wakes it.
Each user's data is small (a few kilobytes per hundred mistakes).
