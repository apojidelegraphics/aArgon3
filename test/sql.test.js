// Runs supabase/aargon3-2.0.sql (twice) against a stand-in for the live database and checks the clock, orders and
// lockdown. Needs a scratch Postgres 15+: set A3_PG to psql's connection flags, e.g.
//   A3_PG="-h /tmp -p 54329 -U postgres" npm test
// Skipped when A3_PG isn't set (e.g. on GitHub Actions).
const test = require('node:test');
const { execFileSync } = require('child_process');
const path = require('path');

const flags = (process.env.A3_PG || '').split(/\s+/).filter(Boolean);
const f = p => path.join(__dirname, '..', p);
test('aargon3-2.0 → 2.6.sql', { skip: flags.length ? false : 'set A3_PG to run' }, () => {
  const psql = (...a) => execFileSync('psql', [...flags, '-v', 'ON_ERROR_STOP=1', '-q', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const db = 'a3_test_' + process.pid;
  psql('-d', 'postgres', '-c', `drop database if exists ${db}`, '-c', `create database ${db}`);
  try {
    psql('-d', db, '-f', f('test/sql/live-schema.sql'));
    psql('-d', db, '-f', f('supabase/aargon3-2.0.sql'));
    psql('-d', db, '-f', f('supabase/aargon3-2.0.sql'));   // safe to run again
    const out = psql('-d', db, '-f', f('test/sql/checks.sql'));
    if (!out.includes('ALL SQL CHECKS PASSED')) throw new Error(out);
    psql('-d', db, '-f', f('supabase/aargon3-2.1.sql'));
    psql('-d', db, '-f', f('supabase/aargon3-2.1.sql'));   // safe to run again
    const out2 = psql('-d', db, '-f', f('test/sql/checks-2.1.sql'));
    if (!out2.includes('ALL 2.1 CHECKS PASSED')) throw new Error(out2);
    psql('-d', db, '-f', f('supabase/aargon3-2.3.sql'));
    psql('-d', db, '-f', f('supabase/aargon3-2.3.sql'));   // safe to run again
    const out3 = psql('-d', db, '-f', f('test/sql/checks-2.3.sql'));
    if (!out3.includes('ALL 2.3 CHECKS PASSED')) throw new Error(out3);
    psql('-d', db, '-f', f('supabase/aargon3-2.4.sql'));
    psql('-d', db, '-f', f('supabase/aargon3-2.4.sql'));   // safe to run again
    const out4 = psql('-d', db, '-f', f('test/sql/checks-2.4.sql'));
    if (!out4.includes('ALL 2.4 CHECKS PASSED')) throw new Error(out4);
    psql('-d', db, '-f', f('supabase/aargon3-2.5.sql'));
    psql('-d', db, '-f', f('supabase/aargon3-2.5.sql'));   // safe to run again
    const out5 = psql('-d', db, '-f', f('test/sql/checks-2.5.sql'));
    if (!out5.includes('ALL 2.5 CHECKS PASSED')) throw new Error(out5);
    psql('-d', db, '-f', f('supabase/aargon3-2.5.1.sql'));
    psql('-d', db, '-f', f('supabase/aargon3-2.5.1.sql'));   // safe to run again
    const out6 = psql('-d', db, '-f', f('test/sql/checks-2.5.1.sql'));
    if (!out6.includes('ALL 2.5.1 CHECKS PASSED')) throw new Error(out6);
    psql('-d', db, '-f', f('supabase/aargon3-2.6.sql'));
    psql('-d', db, '-f', f('supabase/aargon3-2.6.sql'));   // safe to run again
    const out7 = psql('-d', db, '-f', f('test/sql/checks-2.6.sql'));
    if (!out7.includes('ALL 2.6 CHECKS PASSED')) throw new Error(out7);
  } finally { psql('-d', 'postgres', '-c', `drop database if exists ${db}`); }
});
