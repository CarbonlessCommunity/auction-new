import type { AuctionAggregate } from '../shared/aggregate';

/**
 * Owner CSV exports, ported from the server's `/results.csv` / `/bids.csv`
 * routes now that there is no server: same row shapes, generated from the
 * locally-folded aggregate and downloaded as a Blob.
 */

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'auction';
}

function download(filename: string, rows: string[][]): void {
  const body = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function exportResultsCsv(agg: AuctionAggregate): void {
  const rows = [['lot', 'winner', 'winning_bid', 'bid_count']];
  for (const { lot, winner, bid, bidCount } of agg.results()) {
    rows.push([lot.name, winner?.name ?? '', bid ? String(bid.value) : '', String(bidCount)]);
  }
  download(`${slug(agg.name)}-results.csv`, rows);
}

export function exportBidsCsv(agg: AuctionAggregate): void {
  const rows = [['seq', 'lot', 'bidder', 'value', 'seconds_into_auction', 'cancelled']];
  for (const bid of agg.bids) {
    const lot = agg.lots.get(bid.lotId);
    const offset = agg.startTime === null ? '' : (bid.time - agg.startTime).toFixed(1);
    rows.push([
      String(bid.seq),
      lot?.name ?? bid.lotId,
      agg.users.get(bid.bidder)?.name ?? bid.bidder,
      String(bid.value),
      offset,
      agg.cancelledBids.has(bid.seq) ? 'yes' : 'no',
    ]);
  }
  download(`${slug(agg.name)}-bids.csv`, rows);
}
