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

/**
 * Both exports carry the anonymous label next to the firm, so the auctioneer
 * can reconcile their sheet against the board the suppliers were looking at.
 * `name` falls back to the label for any identity the exporter could not read,
 * so an observer's export is anonymous rather than wrong.
 */
export function exportResultsCsv(agg: AuctionAggregate): void {
  const rows = [['lot', 'winner', 'winner_label', 'winning_bid', 'bid_count']];
  for (const { lot, winner, bid, bidCount } of agg.results()) {
    rows.push([
      lot.name,
      winner?.name ?? '',
      winner?.label ?? '',
      bid ? String(bid.value) : '',
      String(bidCount),
    ]);
  }
  download(`${slug(agg.name)}-results.csv`, rows);
}

export function exportBidsCsv(agg: AuctionAggregate): void {
  const rows = [['seq', 'lot', 'bidder', 'bidder_label', 'value', 'seconds_into_auction', 'cancelled']];
  for (const bid of agg.bids) {
    const lot = agg.lots.get(bid.lotId);
    const bidder = agg.users.get(bid.bidder);
    const offset = agg.startTime === null ? '' : (bid.time - agg.startTime).toFixed(1);
    rows.push([
      String(bid.seq),
      lot?.name ?? bid.lotId,
      bidder?.name ?? bid.bidder,
      bidder?.label ?? '',
      String(bid.value),
      offset,
      agg.cancelledBids.has(bid.seq) ? 'yes' : 'no',
    ]);
  }
  download(`${slug(agg.name)}-bids.csv`, rows);
}
