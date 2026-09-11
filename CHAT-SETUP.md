# Slurp Lounge — chat setup and security notes

The chat in `docs/index.html` is anonymous public chat zones on Firebase
Realtime Database. There is no backend, no Cloud Functions, and the project
sits on the free Spark plan.

**The client alone is not the security boundary.** Everything that actually
stops abuse lives in `database.rules.json`, and that file does nothing until
you deploy it. Read the deploy section before you ship.

---

## 1. Deploy the rules

```bash
npm install -g firebase-tools     # once
firebase login
firebase use ramen-routes
firebase deploy --only database
```

Or paste `database.rules.json` into Firebase console → Realtime Database →
Rules → Publish.

Then seed the two admin-only nodes. Clients can read `config` but never write
it, so this has to come from the console or the CLI:

```bash
firebase database:set /config '{"chatEnabled": true}'
```

`/config/chatEnabled` is a kill switch. Set it to `false` and every message
write in the project is refused within seconds, no redeploy needed.

### Verify before you trust it

Do not test this by hand in production. Run the emulator:

```bash
firebase emulators:start --only database
```

The two assumptions worth confirming there, because the rate limiter depends
on them:

1. A single `serverTimestamp()` sentinel used at two paths of one `update()`
   resolves to the same value, and that value equals what rules see as `now`.
2. A message write that omits the paired `rate/<uid>` path is rejected.

If (1) turns out false in your project and every send fails with
`PERMISSION_DENIED`, relax the two `=== now` clauses to a tolerance window:

```
".validate": "newData.isNumber() && newData.val() <= now && newData.val() > now - 5000"
```

That is slightly weaker — a client could backdate a message by up to five
seconds — but it keeps the flood limit intact.

---

## 2. What the rules enforce

| Guarantee | How |
|---|---|
| Only signed-in users touch anything | `auth != null` at every write; root defaults to deny |
| You cannot forge someone else's message | `u` must equal `auth.uid` |
| History is append-only | `!data.exists()` on create; no rule permits overwrite |
| Nobody can wipe `/msg` | There is deliberately no `.write` at or above `/msg/$zone` |
| Reads cannot drain your bandwidth | `.read` requires `query.limitToLast <= 60` |
| One message per 3 seconds per account | `/rate/$uid` must advance by 3000 ms, and the message must be written atomically with it |
| Timestamps cannot be forged | `t` must equal `now`, the server's clock |
| No oversized or extra fields | Per-field length caps plus `"$other": { ".validate": false }` |
| Presence is yours alone | `who/$zone/$uid` writable only when `$uid === auth.uid` |
| Banned accounts cannot post | `!root.child('banned').child(auth.uid).exists()` |

Two structural details that are easy to break by accident:

- **Read and write rules cascade downward and cannot be revoked deeper.**
  Adding `".write": "auth != null"` at `msg/$zone` would hand every visitor
  the ability to null the entire zone. The rule belongs on `$id`, not `$zone`.
- **`root` and `data` are the pre-write tree; `newData` is the merged result.**
  The rate-limit check has to reach the merged tree via
  `newData.parent().parent().parent()`. Writing it as `root.child('rate')`
  looks correct and silently rejects every message.

### Banning someone

Messages carry the author's `uid`. Find it in the console, then:

```bash
firebase database:set /banned/<uid> true
```

Be realistic about what this buys you: anonymous auth means clearing site data
mints a fresh uid. A ban is friction against a casual nuisance, not a wall.

---

## 3. What the rules cannot do

Worth knowing before you assume the chat is hardened.

- **Per-person rate limiting is impossible.** The 3-second throttle is per
  account, and an account costs one `signInAnonymously()` call. The real
  ceiling is Firebase's own limit of 100 new accounts per hour per IP.
- **Reads cannot be rate limited at all.** A read performs no write, so there
  is nothing to record. Somebody authenticated can page backwards through
  history 60 messages at a time and burn egress. Keeping history short is the
  defence, not rules.
- **There is no moderation.** `.rat` mutes locally and says so plainly rather
  than pretending a report went somewhere.
- **Client-side length checks and the nickname filter are cosmetic.** Only the
  `.validate` rules are enforced.

### If you want a real ceiling on abuse: App Check

App Check works with Realtime Database, is free on Spark, and needs no
backend. Use `ReCaptchaEnterpriseProvider` — the classic reCAPTCHA v3
integration was auto-migrated and API access is locked for unmigrated keys as
of Q1 2026, so v3 tutorials are out of date.

Enabling App Check on **Firebase Auth** (service `identitytoolkit`, currently
Preview) is the piece that actually closes the "mint unlimited uids" hole.
Roll it out in monitor mode first, and register the exact Pages host
(`<user>.github.io`), never the bare `github.io` apex.

### Spark plan limits that bite

| Resource | Limit | Consequence |
|---|---|---|
| Simultaneous connections | **100** | One open tab with a listener holds one slot for its whole life |
| Downloaded | 10 GB/month | An unbounded read of a long history is ~1 MB per page load |
| Stored | 1 GB | Not the binding constraint |

There is no billing risk on Spark because there is no billing — exhausting a
quota takes the chat offline until the window resets, it does not cost money.
Staying on Spark is itself the mitigation against a billing denial-of-service.

The client is built around the connection cap: the socket is not opened until
somebody presses **Connect**, `goOffline()` runs after the tab has been hidden
for a minute, and an idle session disconnects after 15 minutes.

---

## 4. Retention

Realtime Database has **no TTL feature** — this gets asked constantly and the
answer has always been no. Firestore has server-side TTL policies; RTDB does
not.

The rules therefore permit any signed-in client to delete messages older than
12 hours, and presence rows older than 3 minutes. That makes trimming
server-enforced rather than merely suggested: the worst a malicious client can
do is apply your own retention policy early. What it does not give you is
liveness — a zone nobody visits keeps its history.

If that matters, add a scheduled job. A GitHub Actions cron with
`firebase-admin` is the natural fit for a repo already on Pages; admin
credentials bypass rules, so it can enforce any window you like. Keep the
service-account JSON in GitHub Secrets, and use OAuth2 access tokens rather
than the deprecated `?auth=<secret>` database secrets.

---

## 5. Data model

Short keys are deliberate: RTDB transmits and stores every key name on every
record, so `{u,n,c,x,t,m,k}` instead of spelled-out names saves roughly 10–15%
of each payload.

```
/msg/{zone}/{pushId}   { u: uid, n: nick, c: '#rrggbb', x: text,
                         t: serverTimestamp, m?: mood, k?: 'me'|'buzz' }
/who/{zone}/{uid}      { n, c, t, m?: mood, s?: status }
/rate/{uid}            serverTimestamp        — flood ledger
/banned/{uid}          true                   — console-written only
/config/chatEnabled    true                   — console-written only
```

Zone names must match `^[a-z0-9][a-z0-9-]{1,23}$`, enforced both client-side
and in the rules. Anyone can create a zone by joining it, which is how MXit's
numbered overflow rooms worked.

This replaces the old flat `/chatMessages` and `/presence` nodes. The old data
is orphaned rather than migrated — it had no `uid` field, so no rule could ever
verify who wrote it. Delete it when convenient:

```bash
firebase database:remove /chatMessages
firebase database:remove /presence
```

---

## 6. Client-side safety

- **No `innerHTML` for remote content, anywhere.** Message bodies, nicknames
  and status lines are built as DOM text nodes; emoticons become sibling
  `<span>` elements. There is no string-concatenation path from a payload into
  markup, which is a stronger guarantee than escaping correctly every time.
- **URLs are not auto-linkified.** Cheaper, and it removes a whole class of
  `javascript:` and spam-link problems.
- **Control characters are stripped** from nicknames and message text, so
  nobody can smuggle in line breaks or bidi overrides.
- **`guest_` is a reserved nickname prefix**, so a user cannot impersonate an
  anonymous handle.
- **Ignore lists are local** and stated as local in the UI, so nobody assumes
  a report reached a moderator.
- **The nickname lives in `localStorage` only.** No account, no email, no
  recovery — clearing site data is a full reset, which is the honest trade for
  requiring no signup.
