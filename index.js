/**
 * Package entry point.
 *
 * The implementation lives in [`lib/plugin.js`](lib/plugin.js) and the manifest points
 * `exports["."]` there; this file only re-exports it so a reader who reaches for
 * the conventional `index.js` finds the same Host plugin row.
 */
export { apply, inject, name } from './lib/plugin.js'

