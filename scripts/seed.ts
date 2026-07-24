/**
 * Creates a demo auction so the app has something to look at on first run.
 *
 *   npm run seed
 *
 * Prints one sign-in link per participant. Open them in separate browser
 * profiles (or private windows) to watch the realtime board from several sides
 * at once. Pass --reset to wipe the database first.
 */
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, Repository } from '../src/server/db';
import { parseConfig } from '../src/server/config';
import type { StoredUser } from '../src/shared/aggregate';

const DB_FILE = process.env.AUCTION_DB ?? resolve(process.cwd(), 'data/auction.sqlite');
const ORIGIN = process.env.AUCTION_ORIGIN ?? 'http://localhost:5173';

if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_FILE + suffix, { force: true });
  console.log(`wiped ${DB_FILE}`);
}

const repo = new Repository(openDatabase(DB_FILE));
const system: StoredUser = { publicKey: '__system__', role: 'owner', name: 'System' };
const id = randomBytes(6).toString('hex');

// A short clock so the whole lifecycle — live, extended time, blind last call —
// fits inside a couple of minutes of poking at it.
repo.createAuction(
  id,
  'Q3 Regional Haulage',
  parseConfig({
    bidDirection: 'reverse',
    auctionLengthSec: 300,
    extendedTimeThresholdSec: 90,
    lastCallSec: 45,
    minBidStep: 25,
  }),
);

repo.submit(id, { type: 'setName', name: 'Q3 Regional Haulage' }, system);

function add(name: string, role: 'owner' | 'bidder' | 'viewer'): string {
  const { result, inviteToken } = repo.submit(id, { type: 'addUser', name, role }, system);
  if (!result.ok) throw new Error(result.error);
  return `${ORIGIN}/api/invite/${inviteToken}`;
}

const links: Array<[string, string]> = [
  ['Olivia (organiser)', add('Olivia Reyes', 'owner')],
  ['Acme Freight (bidder)', add('Acme Freight', 'bidder')],
  ['Northwind Logistics (bidder)', add('Northwind Logistics', 'bidder')],
  ['Meridian Transport (bidder)', add('Meridian Transport', 'bidder')],
  ['Finance (viewer)', add('Finance Team', 'viewer')],
];

for (const lot of ['Route A — Depot to Leeds', 'Route B — Leeds to Bristol', 'Route C — Overnight express']) {
  const { result } = repo.submit(id, { type: 'addLot', name: lot }, system);
  if (!result.ok) throw new Error(result.error);
}

console.log(`\nDemo auction ready: ${ORIGIN}/a/${id}\n`);
console.log('Sign-in links (each one sets that person\'s session cookie):\n');
for (const [who, link] of links) console.log(`  ${who.padEnd(30)} ${link}`);
console.log(`
Rules: reverse auction, 5 minutes, bids must beat the leader by 25.
A leading bid with under 90s left pushes the clock back out to 90s.
The last 45s are blind — rivals' bids stay hidden until Olivia releases results.

Start the app with:  npm run dev
`);
