# Bug fix pass — 8 September 2026

Everything below was reproduced first, then fixed, then re-tested against a running API, a real
PostgreSQL database and a real browser. The protocol suites (`iec104-loopback`, `ai-guardrails`,
27 checks) still pass unchanged.

پیش از هر اصلاح، ایراد بازتولید شد و پس از اصلاح دوباره روی سرور و مرورگر واقعی آزمایش شد.

---

## 1. "Invalid or expired token" — the reported error

**What happened.** The access token lives two hours. The login response had always included a
refresh token, but nothing could redeem it: `POST /api/auth/refresh` did not exist, and the browser
threw the refresh token away at login. After two hours the session was dead with no way back except
clearing browser storage by hand. Because most read endpoints are open in demo mode, the pages kept
rendering normally and the failure only appeared at the moment you pressed a button.

**Fixed.**
- Added `POST /api/auth/refresh`. It re-reads the user row rather than trusting the token, so a
  deactivated account or a changed role takes effect at the next refresh, and it rotates the refresh
  token.
- The browser now stores both tokens, and renews the access token **before** a request when it is
  expired or within a minute of expiring — so the error never reaches the screen.
- If renewal genuinely fails, you are sent to the sign-in page instead of being shown a raw error.
- Parallel requests share one refresh; six requests on page load no longer start six refreshes.

**Verified in a browser:** `401 → POST /api/auth/refresh 200 → request retried and succeeded`, and
after the proactive fix the 401 does not occur at all.

## 2. Security: refresh tokens could be used as access tokens

Found while testing the above. Access and refresh tokens were signed with the same key, so a
**30-day refresh token passed `requireAuth`** and authenticated a request as a user whose `id` and
`role` were undefined — an authentication bypass on every endpoint protected by `requireAuth` alone,
and a route to audit rows written with no user id. The WebSocket feed accepted them too.

Fixed by signing refresh tokens with a separate key (derived from `JWT_SECRET`, so no new
configuration is required) and checking an explicit token `type` on both paths. Verified: a refresh
token now returns 401 where it previously reached the role check.

> **Everyone is signed out once** when you deploy this, because the signing changed. Sign in again
> and the session then lasts as it should. No data is affected.

## 3. The map showed one dot instead of the fleet

The map opened on the whole world. At that zoom every Iranian city fell inside the 30-pixel cluster
radius and merged into a **single circle** — 21 cities drawn as one dot, which is why the screen
looked empty. The clustering itself was right; the starting view was wrong.

The map now opens fitted to wherever your panels actually are: a fleet in one country opens on that
country, and the view widens on its own once panels exist on more than one continent. The World and
Iran buttons still override it. **Verified: 16 markers drawn where 1 was drawn before.**

## 4. A failed load was displayed as good news

Nine screens had no error handling on their fetches. When the API was unreachable they did not say
so — they rendered an empty list. The alarms screen showed *"No alarms in this filter."* and the
work-orders screen *"No work orders in this filter."* An operations console reporting an unreachable
API as a quiet, healthy fleet is the most dangerous failure in this list, because it is believable.

All nine now distinguish "nothing to show" from "could not ask", with a retry. The row counters show
`—` rather than `0` while the answer is unknown. The executive dashboard also had an uncaught
30-second refresh loop that sat on "Loading…" forever while throwing an error every 30 seconds.

## 5. Clicking two things quickly showed the wrong one

On the map, drill-down had no cancellation. Clicking relay A then relay B, if A's response arrived
last, left the panel showing **relay A's comm status, breaker status and trip count under relay B's
breadcrumb**, with nothing to indicate it. The same pattern let a previous project's figures render
under a new selection with the loading indicator already cleared.

Every drill-down now carries a sequence number and only the newest response may write to the screen.
The same fix covers the search and filter boxes on the projects, relays, faults, alarms and
work-order lists, where typing "TEH" could leave the table showing the results for "T". Free-text
search is also debounced.

## 6. Smaller defects

| Screen | Problem | Fix |
|---|---|---|
| Fault detail | "Analyze" failing did nothing at all — no message, silent rejection | Errors are shown |
| Alarms | Double-click acknowledge → 409, alarm-not-found alert right after succeeding | Button disabled while in flight; errors inline, not `alert()` |
| AI copilot | Second send while the first was open created a **second chat session**, permanently splitting the stored conversation | One request at a time; Send and suggestion chips disabled |
| Live feed | Failed history load sat on "Waiting for events…", indistinguishable from a quiet network | Says it could not load, and that this is not an all-clear |
| Relay detail | `.map()` on lists the API could omit | Defaulted to empty |
| Project detail | One failing sub-panel blanked the whole page | Panels fail independently |

## 7. Welcome screen duration

Each stage now holds for at least 900 ms and the finished state holds for 1.2 s — about five seconds
in total instead of one. The bar still reports real work, so a slow API only makes it longer, never
shorter. Both values are configurable without touching code:

```
NEXT_PUBLIC_WELCOME_STAGE_MS=900    # per stage
NEXT_PUBLIC_WELCOME_HOLD_MS=1200    # hold at 100%
```

The Skip button is still there.

---

## Deploying

Web and API code only — **no database migration is needed**.

```
docker compose up -d --build
```

Everyone signs in once more afterwards (see §2).

## One thing to decide before the demo

`REQUIRE_AUTH_FOR_READS` is currently **off**, which is why all read screens are browsable without
signing in. That is deliberate for evaluation, but it means the app looks signed-in when it is not.
Set `REQUIRE_AUTH_FOR_READS=true` in `.env` before showing this as a secured system.
