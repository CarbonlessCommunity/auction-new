import './styles.css';
import { renderCreate } from './views/create';
import { renderAuction } from './views/auction';

const root = document.getElementById('app')!;
const match = /^\/a\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);

if (match) {
  renderAuction(root, match[1]);
} else {
  renderCreate(root);
}
