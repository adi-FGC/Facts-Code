# Session handling

How mini-shop manages signed-in users.

## Lifecycle

1. `POST /auth/login` verifies credentials and mints a session token.
2. Every authenticated request *touches* the session; a session idle longer
   than the timeout is dropped and the client must log in again.
3. `POST /auth/logout` revokes the token immediately.

## Operational notes

- Sessions live in memory; a process restart signs everyone out. Acceptable
  for the fixture, unacceptable for production — see the persistence TODO.
- The idle timeout has generated support tickets from mobile users whose
  devices sleep mid-checkout. Before raising it, measure how many sessions
  per day actually expire within five minutes of their last request.
- Tokens are opaque strings with no embedded claims; everything resolves
  through the store, so revocation is instant and global.

## Open questions

- Should the timeout differ per client type (web vs mobile)?
- Do we need a "remember me" long-lived refresh token, or is re-login fine?
