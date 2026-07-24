/** Palette carried over from the original `UsersController`. */
export const BIDDER_COLORS = [
  '#8dd3c7', '#fdb462', '#bebada', '#fb8072', '#80b1d3', '#b3de69',
  '#fccde5', '#bc80bd', '#ccebc5', '#ffed6f', '#d9d9d9', '#ffffb3',
];

export function bidderColor(publicKey: string): string {
  const index = Number(publicKey);
  return BIDDER_COLORS[(Number.isFinite(index) ? index : 0) % BIDDER_COLORS.length];
}

/** M:SS, clamped at zero. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const money = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatValue(value: number): string {
  return money.format(value);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const host = document.getElementById('toasts');
  if (!host) return;

  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  host.append(node);

  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3500);
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
