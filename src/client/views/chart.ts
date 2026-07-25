import Chart from 'chart.js/auto';
import type { AuctionAggregate } from '../../shared/aggregate';
import { beatsBest } from '../../shared/rules';

const LOT_COLORS = ['#2f6df6', '#e04b1f', '#1a9e5c', '#a855f7', '#d98200', '#0891b2', '#db2777', '#65a30d'];

/**
 * Live chart of how the leading bid moved over the auction. Replaces the
 * nvd3/D3 `GraphController`, and updates in place rather than being rebuilt.
 */
export class BidChart {
  private chart: Chart;

  constructor(canvas: HTMLCanvasElement) {
    const muted = getComputedStyle(document.body).getPropertyValue('--muted').trim() || '#666';
    Chart.defaults.color = muted;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

    this.chart = new Chart(canvas, {
      type: 'line',
      data: { datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 200 },
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'duration (seconds)' },
            grid: { color: 'rgba(128,128,128,0.15)' },
          },
          y: {
            grid: { color: 'rgba(128,128,128,0.15)' },
          },
        },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8 } },
        },
      },
    });
  }

  /** Redraws every contract term's leading price; false when nothing has been bid yet. */
  update(agg: AuctionAggregate): boolean {
    const start = agg.startTime;

    const datasets = [...agg.lots.values()]
      .sort((a, b) => a.insertionOrder - b.insertionOrder)
      .map((lot, index) => {
        const points: Array<{ x: number; y: number }> = [];
        let best: number | null = null;

        // Only bids that actually took the lead move the line.
        for (const bid of agg.bidsForLot(lot.id).sort((a, b) => a.time - b.time)) {
          if (!beatsBest(bid.value, best, agg.config)) continue;
          best = bid.value;
          points.push({ x: start === null ? 0 : +(bid.time - start).toFixed(1), y: bid.value });
        }

        const color = LOT_COLORS[index % LOT_COLORS.length];
        return {
          label: lot.name,
          data: points,
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          pointRadius: 2.5,
        };
      });

    this.chart.data.datasets = datasets;
    this.chart.update();

    return datasets.some((dataset) => dataset.data.length > 0);
  }

  destroy(): void {
    this.chart.destroy();
  }
}
