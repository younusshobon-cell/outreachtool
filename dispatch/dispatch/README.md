# OutreachLead — SaaS early access

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

Connections keeps Gmail, Outlook and custom SMTP and adds HubSpot, Clay,
Listkit, LeadMagic and OutboundSync. Connections are private to each workspace.

- **Gmail / Outlook:** users can provide OAuth access tokens, refresh token +
  matching client ID/secret, or their own OAuth app and complete PKCE sign-in.
  Access-token-only connections expire; background sending requires renewal.
  Ordinary API keys and normal mailbox passwords do not authorize these APIs.
  Google tokens are checked for send/compose/read scopes and mailbox identity.
  Microsoft access-token mode verifies identity/read access; send permissions are
  checked by Graph at send time. Refresh mode checks returned delegated scopes.
- **Gmail app passwords / SMTP:** TLS authentication test, send-only. Gmail app
  password availability depends on account settings. Up to 20 SMTP mailboxes.
- **HubSpot:** user-supplied private app token with contacts read permission;
  validate credentials and import 100 contacts per click with cursor pagination,
  duplicate detection and suppression. No automatic CRM writeback or marketplace
  certification. Public HubSpot onboarding needs a registered OAuth integration.
- **Clay:** generate a dedicated one-time-visible import token, then configure a
  Clay HTTP API action to POST JSON to `/integrations/leads` with a Bearer header.
  Maximum 100 leads/request, 30 requests/min/workspace, 256 KB payload. Tokens are
  hashed, revocable and cannot read data or send mail. Connected status distinguishes
  endpoint-ready from a real received request. Fields: email, name, owner, website,
  city, notes; body `{ "leads": [...] }` or a single lead.
- **Listkit:** CSV adapter with common Listkit column aliases. No native API sync.
- **LeadMagic:** validates API key through the free credits endpoint. Explicit
  per-lead verification uses the customer's credits and persists verification
  status. Invalid addresses are blocked. No bulk paid jobs run automatically.
- **OutboundSync:** verified API key + read-only account/CRM readiness status.
  This does NOT forward Dispatch campaign activity or claim native two-way sync.

Only fixed provider API hosts receive stored credentials. Provider requests have
20-second timeouts and bounded JSON responses. User tokens never appear in state,
connection metadata, logs or workspace export. There is one Gmail and one Outlook
connection per workspace; use SMTP for additional compatible mailboxes.

Campaigns support optional two-letter A/B first-touch tests (alternating recipients),
variant-level sent/failed/reply results, preflight checks, content snapshots, and
cross-campaign queue deduplication. A/B testing is not enabled for sequences yet.
Every campaign email includes a private unsubscribe link; GET shows confirmation
and POST suppresses the address and cancels pending mail. This is a confirmation
page, not RFC 8058 one-click unsubscribe. Blocklists survive contact deletion and
re-import. Manual blocks, invalid-email results and unsubscribe outcomes persist.
Send failures with uncertain delivery are not automatically replayed.

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
For an existing SaaS beta-1 database, apply migrations/0005_campaign_connectors.sql once.
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
campaign pacing, sequence suppression and mocked SMTP transport. Mocked provider contract tests cover BYO credentials, imports, token rotation,
suppression and A/B snapshots. Real OAuth consent/send/refresh and third-party
account operations still need a live credential-based acceptance test.

## Public website and performance

`/` is the public OutreachLead homepage; `/login` and `/signup` lead to the authenticated `/app` workspace. Existing root hash bookmarks redirect to `/app`. Public assets bypass database and credential work, use versioned cache headers, and contain no external fonts. Workspace HTML and API responses remain private/no-store. State queries run concurrently and include sequences to avoid a second request.

Intended custom domain: outreachlead.io (not yet connected). Preserve the existing Worker name, D1 bindings, cookie name and encryption secrets. A universal 300 ms load time is not guaranteed; measure actual cold and repeat visits on target networks after deployment.
