// "Everything in every plan": one renderer for the store's Compare page and the terminal's Catalog page.
// Reads window.A3 (assets/catalog.js). A3compare.html({ billing }) → HTML string.
(function () {
  const { C, TIERS, PLANS, price, money } = window.A3;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yes = '<span class="cmp-yes" title="Included">✓</span>', no = '<span class="cmp-no" title="Not included">—</span>';
  const chip = id => C.chips.find(c => c.id === id) || {};
  const people = n => n == null ? 'No limit' : n === 1 ? '1 person' : `${n} people`;

  function priceRows(billing) {
    return PLANS.map(pl => `<tr><th>${esc(C.plans[pl].name)}<small>${esc(C.plans[pl].blurb)}</small></th>${TIERS.map(t => {
      const p = price(pl, t, billing);
      return `<td>${p.quote ? `<b>Quote</b><small>from ${money(p.from)}/mo · ${people(p.seats)}</small>` : `<b>${money(p.amount)}</b><small>/${billing === 'year' ? 'yr' : 'mo'} · ${people(p.seats)}</small>`}</td>`;
    }).join('')}</tr>`).join('');
  }
  function modelRows() {
    return Object.keys(C.families).flatMap(f => {
      const F = C.families[f];
      return [`<tr class="cmp-group"><th colspan="${TIERS.length + 1}">${esc(F.name)}<small>${esc(F.about)}</small></th></tr>`].concat(F.models.map(m => `<tr><th class="cmp-model">${esc(m)}</th>${TIERS.map(t => {
        if (F.free) return `<td>${yes}<small>free for everyone</small></td>`;
        if (C.tiers[t].families.includes(f)) return `<td>${yes}<small>unlimited</small></td>`;
        const lim = C.tiers[t].limits?.[F.name];
        return `<td>${lim ? `<span class="cmp-part">${esc(lim)}</span>` : no}</td>`;
      }).join('')}</tr>`));
    }).join('');
  }
  function rows(label, fn, sub = '') { return `<tr><th>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</th>${TIERS.map(t => `<td>${fn(t)}</td>`).join('')}</tr>`; }

  function html({ billing = 'month' } = {}) {
    const head = `<tr><th></th>${TIERS.map(t => `<th class="cmp-tier ${C.tiers[t].popular ? 'pop' : ''}">${esc(C.tiers[t].name)}<small>${esc(C.tiers[t].tagline)}</small></th>`).join('')}</tr>`;
    const tbl = `<div class="cmp-wrap"><table class="cmp"><thead>${head}</thead><tbody>
      <tr class="cmp-group"><th colspan="${TIERS.length + 1}">Price and people</th></tr>${priceRows(billing)}
      <tr class="cmp-group"><th colspan="${TIERS.length + 1}">Agents</th></tr>
      ${rows('Paragon', t => esc(C.tiers[t].limits?.Paragon || '—'), 'the agent that can act for you')}
      ${rows('Axiom bonus', t => esc(C.tiers[t].limits?.['Axiom bonus'] || '—'), 'only for select people')}
      ${rows('Quouk chip', t => `<b>${esc(C.tiers[t].chip)}</b>`)}
      ${rows('Agent steps per task', t => esc(chip(C.tiers[t].chip).steps))}
      ${rows('Swarm workers', t => esc(chip(C.tiers[t].chip).swarm))}
      ${rows('Operations at once', t => esc(chip(C.tiers[t].chip).ops))}
      <tr class="cmp-group"><th colspan="${TIERS.length + 1}">Models</th></tr>${modelRows()}
      <tr class="cmp-group"><th colspan="${TIERS.length + 1}">Extras</th></tr>
      ${['Early features', 'Support priority', 'Phone answers'].map(k => rows(k, t => esc(C.tiers[t].extras?.[k] || '—'))).join('')}
      ${rows('LentOS themes', () => yes, 'Sonoma or Horizon, your pick')}
      ${rows('Share with your team', t => esc(PLANS.filter(p => !C.plans[p].quote).map(p => `${C.plans[p].name}: ${people(C.plans[p].seats[t])}`).join(' · ')))}
      </tbody></table></div>`;
    const os = `<div class="cmp-cards">${C.os.map(o => `<div class="cmp-card"><b>${esc(o.id)}</b><span class="pill ${o.family === 'Horizon' ? 'vio' : 'warn'} chip">${esc(o.family)}</span><p>${esc(o.about)}</p></div>`).join('')}</div>`;
    const conn = `<div class="cmp-cards">${C.connections.map(o => `<div class="cmp-card"><b>${esc(o.id)}</b><p>${esc(o.about)}</p></div>`).join('')}</div>`;
    const chips = `<div class="cmp-wrap"><table class="cmp cmp-small"><thead><tr><th>Chip</th><th>Agent steps</th><th>Swarm workers</th><th>Operations at once</th><th>Comes with</th></tr></thead><tbody>
      ${C.chips.map(c => `<tr><th>${esc(c.id)}<small>${esc(c.about)}</small></th><td>${c.steps}</td><td>${c.swarm}</td><td>${c.ops}</td><td>${esc(c.id === 'No order' ? 'Everyone' : TIERS.filter(t => C.tiers[t].chip === c.id).map(t => C.tiers[t].name).join(', '))}</td></tr>`).join('')}</tbody></table></div>`;
    const plans = `<div class="cmp-wrap"><table class="cmp cmp-small"><thead><tr><th>Plan</th>${TIERS.map(t => `<th>${esc(C.tiers[t].name)}</th>`).join('')}</tr></thead><tbody>
      ${PLANS.map(p => `<tr><th>${esc(C.plans[p].name)}<small>${esc(C.plans[p].blurb)}</small></th>${TIERS.map(t => `<td>${people(C.plans[p].seats[t])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    return { table: tbl, os, connections: conn, chips, plans };
  }
  window.A3compare = { html };
})();
