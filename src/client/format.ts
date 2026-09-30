/** Palette carried over from the original `UsersController`. */
export const BIDDER_COLORS = [
  '#8dd3c7', '#fdb462', '#bebada', '#fb8072', '#80b1d3', '#b3de69',
  '#fccde5', '#bc80bd', '#ccebc5', '#ffed6f', '#d9d9d9', '#ffffb3',
];

/**
 * A supplier's colour, from the palette slot they were handed when the
 * auctioneer signed them up. Colour and label ("Supplier C") are the whole of
 * a rival's public identity, so both are assigned once and never move.
 */
export function bidderColor(colorIndex: number): string {
  const index = Number.isFinite(colorIndex) ? Math.max(0, Math.trunc(colorIndex)) : 0;
  return BIDDER_COLORS[index % BIDDER_COLORS.length];
}

/** M:SS, clamped at zero. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Bids are quoted in whatever unit the auction trades in, and the two ends of
 * that range need different precision: energy is priced per kWh to five
 * decimals (0.05376), where rounding to cents would collapse a whole auction
 * into one number, while a freight lane or a bulk lot is quoted in currency
 * units. Sub-unit prices therefore keep five decimals — trailing zeros and
 * all, so the ladder stays aligned — and anything larger keeps two.
 */
export function formatValue(value: number): string {
  const decimals = Math.abs(value) < 1 && value !== 0 ? 5 : 2;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** "just now", "40s ago", "3 min ago", "2 hr ago" — for a last-seen stamp. */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} hr ago`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

export function toast(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  const host = document.getElementById('toasts');
  if (!host) return;

  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  host.append(node);

  setTimeout(() => node.remove(), kind === 'info' ? 3500 : 6000);
}

/**
 * Replaces a container's markup while keeping the user's typing intact —
 * necessary because a rival's bid can re-render the board mid-keystroke.
 */
export function patch(container: HTMLElement, html: string): void {
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active && container.contains(active) ? active.getAttribute('data-k') : null;
  const caret = active instanceof HTMLInputElement ? active.selectionStart : null;

  const values = new Map<string, string>();
  for (const input of container.querySelectorAll<HTMLInputElement>('input[data-k]')) {
    if (input.value) values.set(input.dataset.k!, input.value);
  }

  container.innerHTML = html;

  for (const input of container.querySelectorAll<HTMLInputElement>('input[data-k]')) {
    const previous = values.get(input.dataset.k!);
    if (previous !== undefined) input.value = previous;
  }

  if (focusKey) {
    const restored = container.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`);
    restored?.focus();
    if (restored instanceof HTMLInputElement && caret !== null) restored.setSelectionRange(caret, caret);
  }
}
