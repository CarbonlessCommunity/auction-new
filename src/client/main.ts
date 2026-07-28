import './styles.css';
import { completeSignIn, isSignInLink } from './auth';
import { renderConfirmEmail } from './views/signin';
import { renderCreate } from './views/create';
import { renderAuction } from './views/auction';
import { toast } from './format';

const root = document.getElementById('app')!;

function route(): void {
  const match = /^\/a\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  if (match) {
    renderAuction(root, match[1]);
  } else {
    renderCreate(root);
  }
}

/**
 * A click on an emailed sign-in link is redeemed before anything else renders:
 * the link is single-use, and letting a view start fetching under a session
 * that is one tick from changing only produces a flash of "access denied" for
 * someone who does in fact have access.
 */
async function start(): Promise<void> {
  if (!isSignInLink()) {
    route();
    return;
  }

  const result = await completeSignIn();
  if (result.needsEmail) {
    // The link was sent from someone else's browser — the auctioneer's roster.
    renderConfirmEmail(root, route);
    return;
  }
  if (!result.ok) toast(result.error ?? 'Could not sign in.', 'error');
  route();
}

void start();
