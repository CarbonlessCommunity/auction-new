# Auction Machine v2

A realtime **reverse auction** tool — suppliers bid *down* on lots, the lowest bid
leads, and a blind "Last Call" window decides it. It also runs **forward**
(highest bid wins) if you flip one setting.

This is a ground-up rewrite of [`auction-machine`](../auction-machine), a Python 2.7 /
Google App Engine / AngularJS app that can no longer be run. The rewrite keeps
what was genuinely good about the original — an event-sourced timeline with
**bidirectional validation** — and replaces everything that had aged out.

## Quickstart

```bash
npm install && npm run seed && npm run dev
```

`npm run seed` prints a set of sign-in links — one per participant. Open the
organiser's link in your normal window and a bidder's link in a private window,
and you can drive both sides of a live auction on one machine.

Then: **Add lot** → **Start** → place bids as the bidders → watch the clock cross
into Extended Time and Last Call → **Release results** → **Export CSV**.

| Command | What it does |
| --- | --- |
| `npm run dev` | API on `:8787`, Vite client on `:5173` (proxies `/api` and `/ws`) |
| `npm run seed` | Creates a demo auction; `-- --reset` wipes the database first |
| `npm test` | Vitest: domain rules, blind bidding, HTTP API, WebSocket room |
| `npm run build` | Compiles the server to `dist-server/` and the client to `dist/client/` |
| `npm start` | Runs the built app as a single process on `:8787` |

Environment: `API_PORT` (default `8787`), `AUCTION_DB` (default
`data/auction.sqlite`), `AUCTION_ORIGIN` (the origin the seed script prints).

## How it works

State is never stored — it is **derived**. Every change is an event appended to
an immutable log, and the auction's state is a pure fold over that log
([`src/shared/aggregate.ts`](src/shared/aggregate.ts)). Replaying the log always
reproduces the same board, including the clock.

Every event passes through validation in **both directions**
([`src/server/validation.ts`](src/server/validation.ts)):

- **inbound** — may this event be appended at all? (Is the auction running? Does
  this bid beat the leader? Is this person allowed to do this?)
- **outbound** — may *this particular viewer* see it, and in what form?

The outbound direction is what makes blind bidding and anonymity real rather
than cosmetic: two bidders connected to the same auction receive genuinely
different event streams, filtered per connection in
[`src/server/realtime.ts`](src/server/realtime.ts). A rival's Last Call bid is
never sent to the browser, so there is nothing to find in the network tab.

### The rules

| Setting | Default | Meaning |
| --- | --- | --- |
| `bidDirection` | `reverse` | `reverse` = lowest bid leads; `forward` = highest leads |
| `auctionLengthSec` | 360 | How long the clock runs |
| `extendedTimeThresholdSec` | 150 | A leading bid inside this window pushes the clock back out to it |
| `lastCallSec` | 60 | The final blind window |
| `minBidStep` | 0 | How far a bid must beat the leader by |

The defaults reproduce the original's hardcoded `6 * 60` / `150` / `60`. The
organiser can change all of them before starting; once the auction is running
the rules are locked.

**Extended Time.** A new leading bid with, say, 100s left on a 150s threshold
pushes the clock back out to 150s. The recomputed length is written onto the bid
event itself, so replaying the log reproduces the clock exactly rather than
depending on when the replay happens.

**Last Call.** In the final window, bids placed by *other* people become
invisible — you can see your own, and the organiser sees everything. Bids placed
before the window stay on the board. When the organiser releases results, the
whole room is re-synced and everything becomes visible at once.

Inbound bids are validated against **what the bidder can actually see**, not the
true leader. That matters: if the server enforced improvement against a hidden
rival bid, a rejection would tell the bidder that a better bid exists. Validating
against the visible best closes that channel. (There is a test for it.)

## What changed from the original

| | Original | This version |
| --- | --- | --- |
| Runtime | Python 2.7 on App Engine | Node + TypeScript, runs anywhere |
| Realtime | 2-second polling | WebSocket room per auction |
| Storage | `pickle`d validator state in the datastore | SQLite event log; state is always re-derivable |
| Auth | Private key in the URL | httpOnly session cookies, hashed invite tokens |
| Rules | Hardcoded constants in `validation.py` | Per-auction config, editable before start |
| Direction | Reverse only | Reverse or forward |
| Input | `window.prompt` / `window.confirm` | Inline forms, live validation |
| Frontend | AngularJS 1.2 + Foundation + nvd3 over HTTP CDNs | Vite + TypeScript SPA, Chart.js, no CDNs |
| Export | None | `results.csv` and `bids.csv`, organiser only |

The client folds the event log with the **same** `AuctionAggregate` class the
server uses. It's the client's view that has to match what the server believes
that client can see, and sharing the fold removes any chance of the two drifting
apart.

## Layout

```
src/shared/     types, rules, and the aggregate — run by both sides
src/server/     app, db (SQLite), auth, realtime (ws), routes, validation
src/client/     SPA: connection (ws + clock skew), views, chart
tests/          domain rules, HTTP API, realtime room
scripts/seed.ts demo auction
```

## Notes

- **Local-first.** No cloud, no Docker, no SMTP. Invite links are printed to the
  console and shown in the organiser's People panel instead of emailed. The
  structure (config via env, SPA served by Express in production) leaves room to
  deploy it later.
- **Clock skew** between browser and server is measured at connect time from the
  handshake midpoint, so countdowns agree across machines.
- Writes are serialised naturally: `better-sqlite3` is synchronous and Node is
  single-threaded, so `Repository.submit` runs to completion without
  interleaving — replacing the App Engine cross-group transaction the original
  needed.
