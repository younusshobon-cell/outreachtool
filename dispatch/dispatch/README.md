# Dispatch — SaaS early access

Live: https://outreachtool.younusshobon.workers.dev

Each signup creates a private workspace. Application login uses email + password
(minimum 12 characters), salted PBKDF2 hashes, hashed server-side session tokens,
Secure HttpOnly cookies, same-origin mutations and rate limits. Recovery uses a
one-time recovery code shown at signup/reset. Email verification and emailed reset
links are not enabled yet; a signup email is an identifier, not proof of ownership.

Workspace tables carry tenant_id. Every application query is scoped from the
server-authenticated session; users cannot supply that context. OAuth state is
single use, expires after ten minutes, and is bound to the user, session and provider.
PKCE is used. OAuth tokens and SMTP passwords are encrypted using MAILBOX_SECRET
with the workspace ID as authenticated additional data.

## User connections

Connections → Gmail / Google Workspace or Outlook / Microsoft 365 → provider login
and consent → return to workspace. Users never provide your developer Client ID
or Secret. Disabled providers display “Not available yet”; users do not see setup
instructions. One Gmail and one Outlook account per workspace are supported in
this beta. Custom SMTP supports up to 20 mailboxes, TLS 465 / STARTTLS 587, and
AUTH LOGIN. SMTP is send-only; manually record replies and bounces.

A selected sender is captured when a campaign is created. Switching the active
sender does not reroute queued campaigns. Workspace daily limit is capped at 100;
provider quotas still apply. Schedulers start paused; no email sends at signup or
OAuth connection. The cron processes authenticated workspaces only.

## Owner-only provider setup (outside the customer app)

### Google
1. Create/select a Google Cloud project; enable Gmail API.
2. Configure Google Auth Platform branding, audience, scopes and consent screen.
3. Create a Web application OAuth client.
4. Register exactly `https://outreachtool.younusshobon.workers.dev/auth/google/callback`.
5. Store `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as Cloudflare Worker secrets.
6. In testing, add permitted test users. Before public Gmail onboarding, complete
   Google's applicable OAuth verification, including restricted-scope requirements
   for Gmail read/compose access and any applicable security assessment.

Google docs: https://developers.google.com/identity/protocols/oauth2/web-server

### Microsoft
1. Register an application in Microsoft Entra ID supporting organizational and
   personal Microsoft accounts (the application uses the common endpoint).
2. Add Web redirect URI exactly
   `https://outreachtool.younusshobon.workers.dev/auth/microsoft/callback`.
3. Configure delegated User.Read, Mail.Send, Mail.ReadWrite and offline_access.
4. Create a client secret and store `MICROSOFT_CLIENT_ID` and
   `MICROSOFT_CLIENT_SECRET` as Worker secrets.
5. Complete publisher/consent requirements applicable to your customers' tenants.

Microsoft docs: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow

Use the dashboard's secure secret input or `wrangler secret put NAME` locally.
Never place secrets in git, browser JavaScript, or chat. MAILBOX_SECRET already
exists on this deployment; preserve it. Rotating it requires re-encryption.

## Migration and release

Source: dispatch/dispatch. Keep existing D1 and Worker bindings.
For the existing v1 database, apply migrations/0004_saas.sql **once**, atomically.
For a fresh database use schema.sql instead. Do not reapply older migrations.

The migration preserves old shared records under the zero tenant ID and retains
legacy settings/mailbox/token tables. Those records are not assigned to the first
signup. A verified owner can request a controlled legacy import later. Old shared
schedules do not run after the migration.

Run `npm ci`, `npm test` and `npm run build:embedded`. dist/modules.json is a
complete module upload for the content API (main_module worker.js). It embeds
public assets and preserves existing Cloudflare bindings. `wrangler deploy` uses
native assets instead; both run the same application handler. Deploying code does
not configure external OAuth clients or grant consent.

## What is not launch-complete

This is an early-access foundation, not a paid public launch. Before marketing:
- Enable and live-test Google/Microsoft provider credentials and verification.
- Set the product domain and register its callback URLs with providers.
- Publish approved Privacy Policy / Terms and support contact under the actual
  operating entity. No legal details have been invented.
- Add verified-email delivery/reset, anti-abuse onboarding and operator controls.
- Choose a billing provider and pricing before enabling subscriptions. No billing
  charges, subscriptions or invented pricing are implemented.
- Direct Drive/Sheets sync is not implemented; CSV import/export works.
- Review scaling: cron currently walks active workspaces sequentially; move to
  queue-based per-workspace jobs before significant traffic.

No test sends a real email. Integration tests cover tenant CRUD isolation, OAuth
state replay/cross-session rejection, recovery/session invalidation, migration,
campaign pacing, sequence suppression and mocked SMTP transport. Live OAuth
consent/send/refresh cannot be proven without the owner's provider app setup.
