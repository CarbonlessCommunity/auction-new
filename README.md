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

Open the printed URL, fill in the auction settings, and you land on the board as
the auctioneer. The People panel gives you one invite link per participant: open
one in a private window and you can drive both sides of a live auction on one
machine.

Then: **Add contract term** → **Start auction** → place bids as the suppliers →
watch the clock cross into Extended Time and Last Call → **Release results** →
**Export results**.

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
[`firestore.rules`](firestore.rules)). The project needs **Anonymous** sign-in
enabled under Authentication → Sign-in method; every participant is an anonymous
uid bound to one invite.

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

### Identity

There are three roles — `owner` (the auctioneer), `bidder` (a supplier), and
`viewer` (a client watching) — and the UI renames itself per role rather than
showing internal vocabulary.

The auctioneer creates a slot per participant and gets a link carrying an invite
id. The first browser to open that link binds its anonymous uid to the slot,
write-once; after that the link is spent. A `claims/{uid}` document mirrors the
binding so the security rules can resolve "who is this uid" with a single read,
since rules cannot run queries.

### The rules

| Setting | Default | Meaning |
| --- | --- | --- |
| `bidDirection` | `reverse` | `reverse` = lowest bid leads; `forward` = highest leads |
| `auctionLengthSec` | 360 | How long the clock runs, Last Call included |
| `extendedTimeThresholdSec` | 150 | A leading bid inside this window pushes the clock back out to it |
| `lastCallSec` | 60 | The final blind window |
| `lastCallBidders` | 2 | How many leaders per term may bid in that window |
| `minBidStep` | 0 | How far a bid must beat the leader by |

The defaults are the energy-auction house rules: a 5:00 clock counting into a
60-second Last Call, with the Extended Time mark at 1:30. The auctioneer can
change all of them before starting; once the auction is running they are frozen,
by the rules as well as the UI. Up to 12 suppliers and 5 contract terms.

**Terms are ranked independently but share one clock.** One board, one countdown,
a separate leader per term.

**Extended Time.** A new leading bid with, say, 100s left on a 150s threshold
pushes the clock back out to 150s. The recomputed length is written onto the bid
event itself, so replaying the log reproduces the clock exactly rather than
depending on when the replay happens.

**Last Call.** In the final window, only each term's leading suppliers may bid,
and bids placed by *other* people are hidden — you see your own, and the
auctioneer sees everything. Bids placed before the window stay on the board. When
the auctioneer releases results, everything becomes visible at once.

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
- a supplier can bid only as itself, and cannot forge the `placedBy` marker that
  denotes an auctioneer bidding on someone's behalf;
- events are append-only and gapless — no overwrite, no delete, no seq gaps;
- a supplier's paired clock bump is bounded, so it can neither end the auction
  early nor stall it;
- a slot can only ever be claimed once, by a matching invite.

What they cannot enforce, and what is therefore **cosmetic rather than secret**:

- **Blind Last Call.** Rules cannot filter documents per reader, so a technical
  participant can read the event collection directly and see hidden bids. The
  client hides them at render time only.
- **Anonymity.** Participant names are readable by anyone signed in.
- **Bid arithmetic.** Beats-current-best, Extended Time and `minBidStep` are
  client-enforced. A hand-crafted write can place an illegal bid — visibly, in
  the append-only log, but it will land.

Closing those three needs a trusted writer: a Cloud Function (Blaze plan) taking
bids and running `validateInbound` server-side, with clients denied direct write
access to `events`. The shared code is already structured for it — `validation.ts`
has no browser dependencies. Until then, treat the auction as **auditable rather
than sealed**, which is fine among identified counterparties and not fine against
a motivated adversary.

`npm run test:rules` asserts each guarantee above, and documents the three gaps
as explicit tests so a future change that closes one is noticed.

## What changed from the original

| | Original | This version |
| --- | --- | --- |
| Runtime | Python 2.7 on App Engine | Static TypeScript SPA, no server to run |
| Realtime | 2-second polling | Firestore snapshot listeners |
| Storage | `pickle`d validator state in the datastore | Firestore event log; state is always re-derivable |
| Auth | Private key in the URL | Anonymous Firebase uid bound write-once to an invite |
| Rules | Hardcoded constants in `validation.py` | Per-auction config, editable before start |
| Direction | Reverse only | Reverse or forward |
| Input | `window.prompt` / `window.confirm` | Inline forms, live validation |
| Frontend | AngularJS 1.2 + Foundation + nvd3 over HTTP CDNs | Vite + TypeScript SPA, Chart.js, no CDNs |
| Export | None | `results.csv` and `bids.csv`, auctioneer only |
| Enforcement | Server-side validator | Security rules + client validation (see above) |

## Layout

```
src/shared/     types, rules, config, schemas, aggregate, validation
src/client/     firebase, connection (transactional append + listeners),
                views (create, auction board, chart), export, format
firestore.rules the enforcement boundary — read the header comment
tests/          domain rules, bid comparison, validation
tests/rules/    security rules, against the emulator
```

## Notes

- **Email invitations are deliberately not built.** Invite links are shown in the
  auctioneer's People panel to copy out by hand.
- **Clock skew** is not corrected: countdowns come from each browser's own
  `Date.now()`, so a badly-set machine will disagree by its own offset. The
  security rules allow a 5-second grace window on the deadline for this reason.
- The bundle is ~1MB, most of it Chart.js and the Firestore SDK. It is a single
  eager chunk; splitting the chart out is the obvious win if that matters.
