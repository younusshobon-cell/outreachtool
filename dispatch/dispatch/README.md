# Dispatch — scheduled outreach mail on Cloudflare

Personalised cold email that goes out on a schedule, from your own Gmail,
with your laptop switched off.

- **Cloudflare Workers** hosts the app and runs the scheduler
- **Cloudflare D1** stores businesses, letters, campaigns and the mail queue
- **Gmail API** does the actual sending, as you
- **Cron Triggers** wake the Worker every 5 minutes to send whatever is due

Free tier covers all of it.

---

## What it does

| | |
|---|---|
| Businesses | Prospect list — name, owner, email, website, city, notes. CSV import. |
| Letters | Templates with `{{business}}`, `{{first_name\|there}}`, `{{city}}` … plus an optional follow-up. |
| Campaigns | Letter + selected businesses + start time. Sends are spaced out automatically. |
| Outbox | Everything queued, sent, failed or cancelled. |
| Replies | Watches your sent threads. A reply cancels that person's pending follow-up. |
| Setup | Daily cap, gap between sends, send window, weekdays-only, draft vs send mode. |

> **Weekend note.** "Weekdays only" skips Saturday and Sunday. Bangladesh's
> weekend is Friday and Saturday, so if that matters, either turn the switch off
> or change the day check in `src/scheduler.js` → `insideWindow()`
> (`l.day === 0 || l.day === 6` → `l.day === 5 || l.day === 6`).

**Draft mode is the default.** Mail lands in your Gmail drafts instead of going
out, so you can read a few before trusting it. Switch to send mode in Setup.

---

## Push it to GitHub first

```bash
git init
git add .
git commit -m "Dispatch — outreach mail on Cloudflare"
git branch -M main
git remote add origin https://github.com/<you>/dispatch.git
git push -u origin main
```

`.gitignore` already keeps `node_modules/`, `.wrangler/` and `.dev.vars` out of
the repo. Secrets never live in the code — they go in `wrangler secret put`
(step 5 below), so the repo is safe to make public if you want.

You can connect the repo to Cloudflare for automatic deploys on push
(**Workers & Pages → your Worker → Settings → Build**), or just run
`npm run deploy` from your machine. Both work; the cron keeps running either way.

---

## Setup

You need: a Google account, a Cloudflare account, Node 18+, and about 20 minutes.

### 1. Get the code running locally

```bash
npm install
```

### 2. Create the database

```bash
npx wrangler login
npx wrangler d1 create dispatch
```

It prints a `database_id`. Paste it into `wrangler.toml` where it says
`PASTE_YOUR_DATABASE_ID_HERE`, then create the tables:

```bash
npm run db:init
```

### 3. Deploy once, to get your URL

```bash
npm run deploy
```

Wrangler prints something like `https://dispatch.<your-subdomain>.workers.dev`.
Note it down — Google needs the exact address in the next step.

### 4. Google Cloud: enable Gmail and make OAuth credentials

1. Go to <https://console.cloud.google.com/> → create a project (any name).
2. **APIs & Services → Library** → search **Gmail API** → Enable.
3. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - Fill in app name, your email for support and developer contact
   - **Scopes**: add `gmail.send`, `gmail.compose`, `gmail.readonly`
   - **Test users**: add your own Gmail address
   - Leave it in **Testing** — that is fine for personal use. (Tokens in testing
     mode expire after 7 days; publish the app when you get tired of
     reconnecting. Publishing without verification is fine while you are the
     only user.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorised redirect URI:
     `https://dispatch.<your-subdomain>.workers.dev/auth/google/callback`
   - Copy the **Client ID** and **Client secret**.

> Using a custom domain later? Add its callback URL here too.

### 5. Set the secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put APP_PASSWORD      # the password you type to open the app
npx wrangler secret put SESSION_SECRET    # any long random string
npx wrangler secret put CRON_SECRET       # only if you use an external cron service
```

### 6. Deploy again and open it

```bash
npm run deploy
```

Open the URL, enter your `APP_PASSWORD`, go to **Setup → Connect Gmail**,
approve the consent screen. You will see "Connected as you@gmail.com".

### 7. Send something

1. **Businesses** → add one (use your own second email address first).
2. **Letters** → write one with `{{business}}` and `{{first_name|there}}` in it.
3. **Campaigns** → schedule it, start time a minute or two out.
4. Press **Start** in the top bar, then **Run now** to not wait for the cron.
5. Check your Gmail drafts. Happy with it? Setup → mode → **Send for real**.

---

## The scheduling, in one paragraph

`wrangler.toml` registers `*/5 * * * *`. Every five minutes Cloudflare runs the
Worker's `scheduled()` handler on its own machines. That calls `tick()`, which
checks whether the scheduler is on, whether the clock is inside your send
window, whether today's cap is spent, and whether enough minutes have passed
since the last send. If all of that is clear, it takes the oldest due mail,
personalises it, sends it through the Gmail API, queues the follow-up and
records the result. Your computer is not involved anywhere in that sentence.

### Not using Cloudflare's cron?

Every Workers plan includes cron triggers, so you probably do not need this.
But if you ever want an outside heartbeat, set `CRON_SECRET` and point
<https://cron-job.org> (free) at:

```
https://your-worker-url/cron?key=YOUR_CRON_SECRET
```

---

## Sending limits, honestly

Gmail's own ceiling for a free account is around 500 messages a day, and
Workspace around 2 000 — but cold outreach is judged on engagement, not just
volume. Sending a few hundred unsolicited mails a day from a personal Gmail is
how an address gets flagged. The defaults here (25/day, 12 minutes apart,
business hours, weekdays) are deliberately slow. If you need real volume, move
to a sending service like Resend or Amazon SES with your own domain, SPF, DKIM
and DMARC set up.

Also: cold email is regulated. CAN-SPAM, GDPR and friends want an honest From
line, a real postal identity and a working way to opt out. Put an unsubscribe
line in your signature and honour it — Dispatch has an `unsubscribed` status
on each business for exactly that.

---

## Local development

```bash
npm run db:init:local
npm run dev
```

`wrangler dev` serves on `http://localhost:8787`. For the OAuth round trip to
work locally, add `http://localhost:8787/auth/google/callback` as a second
authorised redirect URI in Google Cloud, and put your secrets in a `.dev.vars`
file (copy `.dev.vars.example`).

Cron triggers can be fired locally with:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

---

## Project layout

```
.
├── wrangler.toml        Worker config — D1 binding, assets, cron schedule
├── schema.sql           D1 tables and default settings
├── src/
│   ├── index.js         Router, login, OAuth routes, scheduled() handler
│   ├── auth.js          App password + signed session cookie
│   ├── google.js        OAuth dance and access-token refresh
│   ├── gmail.js         Gmail REST calls: send, draft, read threads
│   ├── scheduler.js     tick() — the rules about who goes out when
│   ├── api.js           JSON API for the UI
│   └── util.js          ids, base64url, token substitution, logging
└── public/
    ├── index.html       App shell
    ├── styles.css       Design tokens, light and dark
    └── app.js           Views: outbox, replies, businesses, letters, campaigns
```

## Troubleshooting

**"Gmail is not connected"** — Setup → Connect Gmail. If it fails, the redirect
URI in Google Cloud has to match your Worker URL character for character.

**Reconnecting every week** — your OAuth consent screen is still in Testing
mode. Publish it.

**Cron seems dead** — `npx wrangler tail` and watch, or press **Run now** in
the app. The Activity view logs every run.

**Nothing sends but nothing errors** — check the top bar says *sending* and not
*paused* or *waiting for window*. The send window and weekdays-only switch are
in Setup.
