# Authentication

Own JWT auth in the API (`apps/api/src/auth`), no external identity provider.

| Endpoint                             | Purpose                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `POST /api/auth/register`            | Create an account and sign in (409 if the email exists)                                         |
| `POST /api/auth/login`               | Sign in                                                                                         |
| `POST /api/auth/refresh`             | Rotate the refresh token, issue a new access token                                              |
| `GET /api/auth/refresh`              | Same rotation for browser navigations; `302` to `?next=` (relative paths only) or to `/login`   |
| `POST /api/auth/logout`              | Revoke the refresh-token family, clear the cookies                                              |
| `GET /api/auth/me`                   | The signed-in user (read from the database)                                                     |
| `POST /api/auth/verify-email`        | Confirm the address with the token from the confirmation email (public: the token is the proof) |
| `POST /api/auth/verify-email/resend` | Email a new confirmation link (`409` once confirmed; `RATE_VERIFY_EMAIL_PER_HOUR_USER`)         |

Register, login and refresh answer `{ user, accessToken, expiresIn }` and set two cookies. The access token
is also accepted as `Authorization: Bearer` (Swagger, tests, non-browser clients).

| Cookie  | Content                       | Attributes                               |
| ------- | ----------------------------- | ---------------------------------------- |
| `cd_at` | access JWT, 15 min            | `HttpOnly; SameSite=Lax; Path=/`         |
| `cd_rt` | opaque refresh token, 30 days | `HttpOnly; SameSite=Lax; Path=/api/auth` |

Both are `Secure` when `APP_ENV=staging`. The browser reaches the API same-origin through the web app's
`/api/*` rewrite, so the cookie paths match.

**Email confirmation.** Anybody can register any address, so an account proves that it owns its address before
a document can be shared with it. Registration emails a link to `/verify-email/<token>` (256 random bits, valid
for 48 hours, one per account, only its SHA-256 stored in `email_verifications`); opening the page confirms the
address (`users.email_verified_at`), with or without a session, and opening it again while it is valid says the
same. Sending a new link replaces the old one. Accepting a workspace invitation confirms the address too: its token
came by email to that address. Until then the account works normally, the app shows a notice with a button to send
the link again, and `POST /documents/:id/shares` answers `409` for it. Accounts that existed before confirmation
was introduced were marked confirmed by the migration (`0009_email_verification`).

For other modules: every route requires a valid access token unless it is marked `@Public()`; the user is
available through `@CurrentUser()` (`{ id, jti }`). The guard verifies the JWT locally and never touches the
database. The API issues and verifies the token with `@nestjs/jwt` (`AccessTokenService`, `JwtModule` configured
from `JWT_ACCESS_SECRET`). Next's Edge middleware cannot use it, so `verifyAccessToken()` in `@collab-docs/shared`
verifies the same token with `jose` (Web APIs only). The two implementations are tied together by a contract test
(`access-token.service.spec.ts`): a token from either side must verify on the other with the same claims, and
expired, tampered, wrong-audience, wrong-algorithm and incomplete tokens must be rejected by both. The collab
ticket stays on `jose` (`signCollabTicket`/`verifyCollabTicket`), because the API signs it and collab verifies
it with the same code, so there is no second implementation to keep in step.

## Auth design & rationale

**Why our own JWT instead of Auth.js.** The API is a separate NestJS service that also guards a WebSocket
gateway and server-to-server calls, so identity has to be verifiable outside Next. A signed access token that
any service can check with one shared secret does that; Auth.js sessions live inside the Next runtime. Owning
the flow also keeps rotation, reuse detection and rate limits in one place and testable at the HTTP level.

**Access + refresh.** The access JWT is short-lived (15 min; `sub`, `jti`, `aud=api`) and checked without a
database read. The refresh token is 256 random bits; only its SHA-256 is stored (`refresh_tokens.token_hash`),
so a database leak does not yield usable tokens. Passwords use argon2id (`@node-rs/argon2`; memory, time and
parallelism come from `ARGON2_*`, defaults follow the OWASP minimum). A wrong password and an unknown email
produce the same response and cost the same time.

**Rotation and the 10 s grace.** Each refresh replaces the token (`rotated_at`, `replaced_by`) inside one
family (`family_id`). The rotation claim is a single conditional `UPDATE ... WHERE rotated_at IS NULL`, so of
two parallel refreshes with the same token exactly one rotates. A rotated token that is presented again within
10 s **by the client that rotated it** (parallel requests, several tabs, a response lost on the wire) only yields
a new access token and no second rotation, so the user is not logged out by a race. The client is the SHA-256
of the User-Agent and the address the api resolves through its trusted proxies (`rotated_by`; nothing about the
client is stored in the clear). Presented by another client, or later, a rotated token means it was copied: the
whole family is revoked, the request gets `401`, and `auth.refresh_reuse_detected` is logged with the reason
(`other_client` or `after_grace`). Logout revokes the family too.

The trade-off: a thief who copied the cookie and also matches the victim's browser and address (the same network
behind one NAT) can still use it within those 10 s, and a phone that switches networks in the middle of a refresh
race is logged out. A shorter window would make the second case likelier without removing the first; binding the
token to a key held by the browser (DPoP) would remove both and is out of scope.

**CSRF.** `SameSite=Lax` plus a global guard: a state-changing request authenticated by cookies (`cd_at` or
`cd_rt`, so refresh and logout included) must carry an `Origin` that CORS admits with credentials (`WEB_ORIGIN`
and `CORS_ALLOWED_ORIGINS`, one list for both), otherwise `403 CSRF_REJECTED`. Bearer requests are exempt
(browsers do not attach that header on their own), as are requests without auth cookies such as login and
webhooks.

`GET /api/auth/refresh` rotates the session although it is a `GET`, deliberately: the edge middleware sends an
expired navigation there, including one that started on another site (a link in an email), so it cannot demand a
same-origin request. Another site can therefore make a browser rotate its own session with a top-level navigation,
and gains nothing by it: the new cookies go to that browser, the response is a redirect to a relative path, and a
second rotation within 10 s from that browser falls into the grace window instead of the reuse detection.

**Rate limits.** Login: 5/min per (client IP, email) and 20/min per IP; register: 10/h per IP (`RATE_*` in
`.env.example`). Both login counters are `@nestjs/throttler` guards: the per-IP preset of the global guard and
`LoginThrottlerGuard`, whose tracker is the IP plus a SHA-256 of the normalised email. Exceeding them returns `429 RATE_LIMITED` with `Retry-After`. The client IP is `req.ip`,
which honours `x-forwarded-for` only from `TRUSTED_PROXY_CIDRS`.

**HS256 vs ES256/JWKS.** HS256 with a dedicated secret (`JWT_ACCESS_SECRET`) is the simplest thing that works
for services we deploy together; every verifier holds the secret. The cost is that every verifier could also
mint tokens. To move to ES256 with a JWKS endpoint, the API would sign with a private key and publish the
public key; `AccessTokenService` and `verifyAccessToken` are the only places that change, and `jose` already supports
`createRemoteJWKSet`. Rotating keys then needs only a `kid`, with no secret redistribution.
