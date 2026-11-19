// The desktop app's file server and update check (no Electron needed).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveFile, newer } = require('../electron/paths');
const ROOT = path.join(__dirname, '..');

test('serves the app files, nothing else', () => {
  assert.strictEqual(resolveFile(ROOT, '/'), path.join(ROOT, 'terminal', 'index.html'));
  assert.strictEqual(resolveFile(ROOT, '/terminal/terminal.js'), path.join(ROOT, 'terminal', 'terminal.js'));
  assert.strictEqual(resolveFile(ROOT, '/assets/catalog.js'), path.join(ROOT, 'assets', 'catalog.js'));
  for (const bad of ['/electron/main.js', '/supabase/aargon3-2.0.sql', '/node_modules/x/index.js', '/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd',
    '/package.json', '/.github/workflows/release.yml', '/catalog.json', '/README.md', '/test/catalog.test.js', '/%E0%A4%A']) {
    assert.strictEqual(resolveFile(ROOT, bad), null, bad);
  }
});

test('update check compares versions', () => {
  assert.ok(newer('v2.1.0', '2.0.9')); assert.ok(newer('v10.0.0', '9.9.9')); assert.ok(newer('2.0.1', '2.0.0'));
  assert.ok(!newer('v2.0.0', '2.0.0')); assert.ok(!newer('v1.9.0', '2.0.0'));
});

test('desktop app ships every file the terminal loads', () => {
  const pkg = require('../package.json');
  const html = require('fs').readFileSync(path.join(ROOT, 'terminal', 'index.html'), 'utf8');
  const local = [...html.matchAll(/(?:src|href)="(\.\.\/[^"]+|[\w.-]+\.(?:js|css))"/g)].map(m => path.normalize(path.join('terminal', m[1])));
  assert.ok(local.length >= 5);
  for (const f of local) {
    assert.ok(require('fs').existsSync(path.join(ROOT, f)), `missing ${f}`);
    assert.ok(pkg.build.files.some(g => f.startsWith(g.replace('/**', '')) || f === g), `${f} isn't packaged`);
  }
});
