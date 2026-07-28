# Auction Machine v2

A realtime **reverse auction** tool — suppliers bid *down* on contract terms, the
lowest bid leads, and a blind "Last Call" window decides it. It also runs
**forward** (highest bid wins) if you flip one setting.

This is a ground-up rewrite of [`auction-machine`](../auction-machine), a Python 2.7 /
Google App Engine / AngularJS app that can no longer be run. The rewrite keeps
what was genuinely good about the original — an event-sourced timeline with
**bidirectional validation** — and replaces everything that had aged out.

It runs as a **static site against Firestore**, with no backend of our own: no
server to operate, no database to back up, and Firestore's own realtime listeners
in place of the polling the original did. That choice has one significant
consequence, spelled out under [Trust model](#trust-model) below — read it before
running a real auction.

## Quickstart

```bash
npm install && npm run dev
```

Open the printed URL and fill in the auction settings. You confirm your email
address once — a sign-in link arrives, and clicking it creates the auction and
lands you on the board as the auctioneer. The People panel is where you invite
each supplier and client by email.

To drive both sides on one machine, run against the emulators
(`npm run dev:emulator`), where no mail is actually sent: the sign-in links are
served by the Auth emulator at
`http://127.0.0.1:9099/emulator/v1/projects/<project-id>/oobCodes`.

Then: **Add contract term** → **Start auction** → place bids as the suppliers →
watch the clock cross into Extended Time and Last Call → **Release results to
everyone** (which reveals the Last Call bids on every screen) → **Download
results** (which only saves a CSV here).

`npm run dev` talks to the live Firebase project. To work entirely offline,
start the emulator in one terminal and point the client at it in another:

```bash
npm run emulator
```

```bash
npm run dev:emulator
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on `:5173`, against the live Firebase project |
| `npm run dev:emulator` | The same, against the local Auth + Firestore emulators |
| `npm run emulator` | Firebase Auth (`:9099`) + Firestore (`:8080`) emulators, UI on `:4000` |
| `npm test` | Vitest: domain rules, blind bidding, validation. No services needed |
| `npm run test:rules` | Firestore security rules, against a throwaway emulator |
| `npm run build` | Bundles the client to `dist/client/` |
| `npm run deploy` | Builds, then deploys hosting + Firestore rules |

The emulator scripts need a Java runtime; they put Homebrew's `openjdk` on `PATH`
themselves, so `brew install openjdk` is the only setup.

Firebase config lives in [`src/client/firebase.ts`](src/client/firebase.ts) (a web
API key is not a secret — access is governed entirely by
[`firestore.rules`](firestore.rules)). The project needs **Email link
(passwordless sign-in)** enabled under Authentication → Sign-in method — open
the *Email/Password* provider and switch on "Email link" — and whatever domain
you serve from listed under Authentication → Settings → Authorized domains.
Every participant signs in with their own address; there is no other credential
in the system.

## How it works

State is never stored — it is **derived**. Every change is an event appended to
an immutable log, and the auction's state is a pure fold over that log
([`src/shared/aggregate.ts`](src/shared/aggregate.ts)). Replaying the log always
reproduces the same board, including the clock.

Firestore holds one document per event under `auctions/{id}/events/{seq}`, plus a
small mirror on the auction document (`nextSeq`, `startedAt`, `auctionLength`,
`showResults`) that the security rules need to reason about in isolation. Every
browser subscribes to the log and folds it locally, so all participants converge
on the same board without anything to broadcast.

Every event passes through validation in **both directions**
([`src/shared/validation.ts`](src/shared/validation.ts)):

- **inbound** — may this event be appended at all? (Is the auction running? Does
  this bid beat the leader? Is this person allowed to do this?)
- **outbound** — may *this particular viewer* see it, and in what form?

Appends are transactional: `submit()` reads `nextSeq`, writes the event at that
seq, and bumps the counter in one commit, so two simultaneous bids can never
share a sequence number or be folded in different orders on different screens.

### Three screens

There are three roles — `owner` (the auctioneer), `bidder` (a supplier), and
`viewer` (the client, watching) — and they are meant to look different. Each
screen says which one it is in the top-right corner.

| | Sees rival firms' names | Sees Last Call bids | Can do |
| --- | --- | --- | --- |
| **Auctioneer** | yes | yes, live | everything: run the clock, bid on a supplier's behalf, withdraw any bid, release results |
| **Client** | yes | only once results are released | nothing at all — no bidding, no withdrawing, no controls |
| **Supplier** | **never** — a rival is a colour | only their own | bid, and withdraw a bid of their own |

A supplier's own cards carry their own firm name, so they can find themselves on
the board; every other card is bare colour and a price. In Last Call a
supplier's board narrows to their own bids alone, so the final window is bid
blind from both directions.

Withdrawal is deliberately available to both ends: suppliers mistype bids, and
sometimes enter a wrong one on purpose to spoil an auction. A supplier can take
back only their own bid; the auctioneer can take back anyone's, for the mistakes
that go unnoticed long enough to distort the board.

### Identity

The UI renames each role rather than showing internal vocabulary.

**A participant's identity is their verified email address**, established by
Firebase's passwordless email-link sign-in. The auctioneer invites an address;
that writes a *seat* at `auctions/{id}/seats/{email}` naming the slot and role it
grants. A signed-in client's token carries the address, so `firestore.rules`
resolves "who is this" by reading that one document — no query, and no secret in
a URL.

Consequences worth stating plainly, because they are the point:

- **Nothing in a link grants access.** A forwarded invitation signs the
  forwarder in as themselves, which gets them nowhere.
- **A supplier can sign in again, on any device, as often as they like.** Losing
  a session mid-auction is a nuisance rather than a catastrophe; "send link"
  from the roster is the whole remedy.
- **Revoking is immediate.** Deleting the seat cuts access off on whatever
  device the person is already using, because every rule resolves through it.

The auctioneer's **People** panel is the operational view of this: every
participant, their address, whether they have actually signed in yet, and
buttons to resend a link, correct a mistyped address, or remove access.

(An earlier design bound a slot to the first browser that opened a bearer invite
link. It could not tell a supplier from whoever they forwarded the link to, and
a supplier who cleared their cookies was locked out with no recovery path at
all. Both problems are structural to bearer links, which is why this replaced
them rather than patching them.)

### Anonymity

**A supplier never learns who the other suppliers are — not before the auction,
not during it, and not after results are released.** What they take away is
market pricing: where their number sits against the field. Whose number it sits
against is not theirs to know, because a supplier who can attach a firm to a
price walks in with a view of what that firm charges.

So each supplier is assigned a colour when the auctioneer signs them up, and on
a rival's screen that colour is the *whole* of their identity — no name, no
label, nothing to attach a firm to. (They also carry a nondescript label,
`Supplier A`, `Supplier B`, … in signup order, but it never appears on a
bidder-facing screen; it exists so the CSV downloads have a stable anonymous
handle the auctioneer can hand to the client.)

This is structural, not a render-time filter:

- `validateInbound` strips the name and email off an `addUser` event and puts
  the label and colour on instead, so **real names are never in the event log**.
  The log is world-readable to anyone signed in; there is simply nothing in it
  to read.
- `auctions/{id}/users/{publicKey}` — readable by any signed-in client, because
  a viewer resolves their own slot there — carries only role, label and colour.
- Names and emails live in `auctions/{id}/identities/{publicKey}`, and
  `firestore.rules` scopes that collection to the auctioneer, observers on the
  buying side, and the participant themselves. A supplier reading Firestore by
  hand gets exactly as far as one using the UI.
- The seat table is scoped the same way. `{address → supplier}` is precisely the
  mapping the auction exists to hide, so a supplier may read only their own seat
  and only the auctioneer may enumerate them.

The auctioneer's screen is the only one where a price and a firm appear
together; the client's shows the same. Both CSV exports carry the anonymous
label alongside the name so the two views can be reconciled afterwards.
`npm run test:rules` asserts each of the reads above, in both directions.

### The rules

| Setting | Default | Meaning |
| --- | --- | --- |
| `bidDirection` | `reverse` | `reverse` = lowest bid leads; `forward` = highest leads |
| `auctionLengthSec` | 300 | The main bidding clock. Last Call runs *after* it, on top |
| `extendedTimeThresholdSec` | 90 | A mark on that clock: a leading bid under it pushes the clock back out to it |
| `lastCallSec` | 60 | The final blind window |
| `lastCallBidders` | 2 | How many leaders per term may bid in that window |
| `minBidStep` | 0 | How far a bid must beat the leader by |

**Every number is read off the clock on screen.** 300 + 90 + 60 means five
minutes of bidding, the Extended Time mark at 1:30 showing, then a minute of
Last Call — 6:00 end to end. (These used to be measured against the whole run
including Last Call, so a threshold of 90 put the mark at 0:30 and the setting
disagreed with the clock beside it.) The auctioneer can change all of them
before starting; once the auction is running they are frozen, by the rules as
well as the UI. Up to 12 suppliers and 5 contract terms.

**Terms are ranked independently but share one clock.** One board, one countdown,
a separate leader per term.

**Extended Time.** A new leading bid with 0:40 showing against a 90s threshold
pushes the clock back out to 1:30. The recomputed length is written onto the bid
event itself, so replaying the log reproduces the clock exactly rather than
depending on when the replay happens.

**Last Call.** In the final window, only each term's leading suppliers may bid
(2 by default; the auctioneer can set any number, and 0 leaves it open to
everyone). It is blind either way: a supplier's board narrows to their own bids
for the duration, the client's board freezes at the standings that stood when
the window opened, and only the auctioneer watches it live. When the auctioneer
releases results, everything becomes visible at once.

Inbound bids are validated against **what the bidder can actually see**, not the
true leader. That matters: if improvement were enforced against a hidden rival
bid, a rejection would tell the bidder that a better bid exists. Validating
against the visible best closes that channel. (There is a test for it.) The
accepted cost is that two Last Call bids can briefly coexist out of true order
until results are released.

**Bid comparison is quantised.** `minBidStep` is compared against a delta rounded
to 10 decimal places, because raw IEEE-754 subtraction of hand-typed decimals
lands just under a legal step about as often as just over it — `0.0701 - 0.07` is
`0.00009999999999998899`, which would refuse a bid that is exactly one step
better. See [`src/shared/rules.ts`](src/shared/rules.ts).

## Trust model

With no backend, the browser is the only thing running `validateInbound`, and
[`firestore.rules`](firestore.rules) is the only layer a participant cannot
bypass. The rules enforce what a client can *prove* from its own uid and document
reads:

- only the real owner can issue admin events;
- a supplier cannot read another supplier's name or email by any route;
- a supplier can bid only as itself, and cannot forge the `placedBy` marker that
  denotes an auctioneer bidding on someone's behalf;
- a supplier can withdraw only their own bid, and the watching client can write
  nothing at all;
- events are append-only and gapless — no overwrite, no delete, no seq gaps;
- a supplier's paired clock bump is bounded, so it can neither end the auction
  early nor stall it;
- only the auctioneer can seat or unseat anyone, a seat holder can change
  nothing about their own seat but the sign-in stamp, and an address that was
  never verified resolves to no seat at all.

What they cannot enforce, and what is therefore **cosmetic rather than secret**:

- **Blind Last Call.** Rules cannot filter documents per reader, so a technical
  participant can read the event collection directly and see hidden bids. The
  client hides them at render time only. (Taking a supplier's *pre*-Last-Call
  view off their board is presentation by nature — those prices were public
  while the main clock ran, and they had already seen them.)
- **Bid arithmetic.** Beats-current-best, Extended Time and `minBidStep` are
  client-enforced. A hand-crafted write can place an illegal bid — visibly, in
  the append-only log, but it will land.

Anonymity used to be on that list and no longer is — see below.

Closing the remaining two needs a trusted writer: a Cloud Function (Blaze plan) taking
bids and running `validateInbound` server-side, with clients denied direct write
access to `events`. The shared code is already structured for it — `validation.ts`
has no browser dependencies. Until then, treat the auction as **auditable rather
than sealed**, which is fine among identified counterparties and not fine against
a motivated adversary.

`npm run test:rules` asserts each guarantee above, and documents the two gaps
as explicit tests so a future change that closes one is noticed.

## What changed from the original

| | Original | This version |
| --- | --- | --- |
| Runtime | Python 2.7 on App Engine | Static TypeScript SPA, no server to run |
| Realtime | 2-second polling | Firestore snapshot listeners |
| Storage | `pickle`d validator state in the datastore | Firestore event log; state is always re-derivable |
| Auth | Private key in the URL | Firebase email-link sign-in; access keyed to the verified address |
| Rules | Hardcoded constants in `validation.py` | Per-auction config, editable before start |
| Direction | Reverse only | Reverse or forward |
| Input | `window.prompt` / `window.confirm` | Inline forms, live validation |
| Frontend | AngularJS 1.2 + Foundation + nvd3 over HTTP CDNs | Vite + TypeScript SPA, Chart.js, no CDNs |
| Export | None | `results.csv` and `bids.csv`, auctioneer only |
| Enforcement | Server-side validator | Security rules + client validation (see above) |

## Layout

```
src/shared/     types, rules, config, schemas, aggregate, validation
src/client/     firebase, auth (email-link sign-in), connection (transactional
                append + listeners + seats), views (sign-in, create, auction
                board, chart), export, format
firestore.rules the enforcement boundary — read the header comment
tests/          domain rules, bid comparison, validation
tests/rules/    security rules, against the emulator
```

## Notes

- **Invitations are sent by Firebase Auth**, not by the app: the "email" a
  participant receives is the sign-in link itself. There is no separate
  invitation message, and nothing to compose. The auctioneer's People panel
  triggers and re-triggers them.
- **Clock skew** is not corrected: countdowns come from each browser's own
  `Date.now()`, so a badly-set machine will disagree by its own offset. The
  security rules allow a 5-second grace window on the deadline for this reason.
- The bundle is ~1MB, most of it Chart.js and the Firestore SDK. It is a single
  eager chunk; splitting the chart out is the obvious win if that matters.
