import './styles.css';
import { renderAdmin } from './views/admin';
import { renderAuction } from './views/auction';

const root = document.getElementById('app')!;

/**
 * `/a/{id}` is a participant's (or an admin's) auction board; everything else is
 * the admin panel, which handles its own sign-in. There is no emailed sign-in
 * link to redeem anymore, so routing is a straight switch on the path.
 */
function route(): void {
  const match = /^\/a\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  if (match) renderAuction(root, match[1]);
  else renderAdmin(root);
}

route();
