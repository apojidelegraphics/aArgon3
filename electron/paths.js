// Small pure helpers for main.js (kept apart so the tests can load them without Electron).
const path = require('path');

// Only the app's own web files can be served; never electron/, supabase/, tests, scripts or node_modules.
function resolveFile(root, urlPath) {
  let p; try { p = decodeURIComponent(urlPath || '/'); } catch { return null; }
  if (p === '/' || !p) p = '/terminal/index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root + path.sep)) return null;
  if (/^[\\/](electron|node_modules|supabase|test|scripts|build|dist|\.github|\.git)([\\/]|$)/.test(file.slice(root.length))) return null;
  if (/[\\/]\.[^\\/]+$/.test(file) || /\.(json|md|sql|yml|toml)$/i.test(file)) return null;   // no dotfiles, package.json, notes
  return file;
}

// is release tag a newer than version b? ("v2.1.0" vs "2.0.3")
function newer(a, b) {
  const x = String(a).replace(/^v/, '').split(/[.-]/).map(Number), y = String(b).replace(/^v/, '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
module.exports = { resolveFile, newer };
