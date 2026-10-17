# Dispatch outreach tool

Shared workspace hosted at https://outreachtool.younusshobon.workers.dev.
There is no application password. Everyone with the URL shares the same businesses,
campaigns, mailboxes and settings. This is not an isolated multi-user SaaS.

## Add your domain mailboxes

Setup → Domain mailboxes → enter sender name, email, SMTP hostname, port,
username and mailbox/app password → Add mailbox → Test connection → Use as sender.
Repeat for each mailbox (up to 20). One sender is active for new queued messages;
follow-ups keep the mailbox that sent their first message. Connection tests only
authenticate; they do not send an email. Remove and re-add a mailbox to change its credentials.

SMTP supports port 465 with TLS and 587 with mandatory STARTTLS, using AUTH LOGIN.
This works with providers offering password/app-password SMTP authentication.
OAuth-only accounts require the provider’s OAuth integration; a universal SMTP
form cannot bypass that requirement. Cloudflare blocks SMTP port 25 and some destinations.

SMTP sends only. It does not save Gmail drafts, synchronize inboxes or automatically
detect replies. Switch Setup → Mode to Send for real when ready. The scheduler
starts paused; nothing sends until you start it. Draft mode keeps SMTP paused.
Existing Gmail OAuth integration remains available for Gmail draft/reply features.

Mailbox passwords are AES-GCM encrypted in D1, using a MAILBOX_SECRET Worker secret.
API responses never include saved passwords. Anyone using the shared workspace can
still manage these mailboxes and send campaigns through them.

## Deployment

App source is in dispatch/dispatch. Worker name: outreachtool. D1: outreachtool-db.

```sh
npm install
npx wrangler secret put MAILBOX_SECRET
npx wrangler d1 execute outreachtool-db --remote --file schema.sql
npm run deploy
```

Set MAILBOX_SECRET once to a strong random value and retain it; changing it makes
existing encrypted mailbox passwords unreadable. Do not commit it. Existing
installations from before mailbox support should apply migrations/0002_mailboxes.sql
instead of rerunning the initial schema (apply only once).

For Gmail OAuth set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets.
Redirect URI: https://outreachtool.younusshobon.workers.dev/auth/google/callback.

```sh
node --test tests/smtp.test.mjs
```

Native Workers assets must run the Worker first (configured in wrangler.toml).
GitHub push auto-deploy is not configured; deployment is manual unless connected
through Cloudflare Workers Builds.
