/* THE ICONS OF THIS PAGE: the set Parley carries (Lucide, copied there with
 * its version and licence; clavarium-parley, ui/parley-icons.js), the chat's and
 * this page's own, one style. Given to the classic scripts (app.js,
 * links.js) as window.clavariumIcons; they draw a plain sign until it is
 * there, and are told when it is. */
import { icon, fileIcon } from './vendor/parley-icons.js';

window.clavariumIcons = { icon, fileIcon };
window.dispatchEvent(new Event('clavarium-icons-ready'));
