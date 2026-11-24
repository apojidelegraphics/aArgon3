// Copies Nexus's shared look (profile frames, name styles, fonts) into aARgon3 so Nexus pictures and frames look the same here.
// Run from this folder with the Nexus-28 repo next to it (~/Developer/Nexus-28):  npm run sync:apoji
const fs = require('fs'), path = require('path');
const from = path.resolve(__dirname, '..', '..', process.argv[2] || 'Nexus-28', 'renderer'), to = path.resolve(__dirname, '..', 'assets');
if (!fs.existsSync(path.join(from, 'cosmetics.js'))) { console.error(`No Nexus-28 next to this folder (looked in ${from}).`); process.exit(1); }
fs.copyFileSync(path.join(from, 'cosmetics.js'), path.join(to, 'cosmetics.js'));
fs.mkdirSync(path.join(to, 'fonts'), { recursive: true });
for (const f of fs.readdirSync(path.join(from, 'fonts'))) fs.copyFileSync(path.join(from, 'fonts', f), path.join(to, 'fonts', f));
console.log('Copied cosmetics.js and fonts from Nexus-28.');
