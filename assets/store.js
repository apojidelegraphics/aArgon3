// The public store: plans, the "set up your system" sheet, and the trip to Stripe Checkout.
// Prices come from assets/catalog.js; the checkout function works them out again on the server, so nobody can change
// what they pay by editing this page.
(function () {
  const { C, TIERS, PLANS, price, money, describe } = window.A3;
  const CFG = window.A3_CONFIG;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const st = { plan: 'personal', billing: 'month' };
  const mailto = (subject, body = '') => `mailto:${C.contactEmail}?subject=${encodeURIComponent(subject)}${body ? '&body=' + encodeURIComponent(body) : ''}`;

  function toast(msg, kind = '') {
    const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('toasts').append(t);
    setTimeout(() => t.remove(), 6000);
  }

  // ---------- plans
  function renderPlanSeg() {
    $('planSeg').innerHTML = PLANS.map(p => `<button data-p="${p}" class="${p === st.plan ? 'on' : ''}">${esc(C.plans[p].name)}</button>`).join('');
    $('planSeg').querySelectorAll('button').forEach(b => b.onclick = () => { st.plan = b.dataset.p; renderPlanSeg(); renderTiers(); });
    $('billSeg').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.b === st.billing); b.onclick = () => { st.billing = b.dataset.b; renderPlanSeg(); renderTiers(); }; });
    $('billSeg').hidden = !!C.plans[st.plan].quote;
  }
  const people = n => n == null ? 'No set limit on people' : n === 1 ? '1 person' : `Up to ${n} people`;
  function renderTiers() {
    const plan = C.plans[st.plan];
    $('planBlurb').textContent = plan.blurb;
    $('tiers').innerHTML = TIERS.map(t => {
      const tier = C.tiers[t], p = price(st.plan, t, st.billing);
      const priceHtml = p.quote ? `<div class="price">Quote</div><div class="per">from ${money(p.from)}/month, by invoice</div>`
        : `<div class="price">${money(p.amount)}<small>/${p.interval === 'year' ? 'yr' : 'mo'}</small></div>
           <div class="per">${p.interval === 'year' ? `${money(Math.round(p.amount / 12 * 100) / 100)}/mo, billed yearly` : `or ${money(p.monthly * C.yearlyMonths)}/yr (2 months free)`}</div>`;
      return `<article class="tier ${tier.popular ? 'pop' : ''}">${tier.popular ? '<span class="flag">MOST POPULAR</span>' : ''}
        <h3>${esc(tier.name)}</h3><div class="tag">${esc(tier.tagline)}</div>${priceHtml}
        <div class="meta"><span class="pill info">${esc(people(p.seats))}</span><span class="pill vio chip">${esc(tier.chip)}</span></div>
        <ul>${tier.perks.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        ${p.quote ? `<a class="btn block" href="${mailto(`aARgon3 Enterprise · ${tier.name}`, `Hi! We'd like an aARgon3 Enterprise ${tier.name} quote.\n\nHow many people:\nCompany:\n`)}">Ask for a quote</a>`
                  : `<button class="btn ${tier.popular ? 'primary' : ''} block" data-t="${t}">Choose ${esc(tier.name)}</button>`}
      </article>`;
    }).join('');
    $('tiers').querySelectorAll('button[data-t]').forEach(b => b.onclick = () => openSetup(b.dataset.t));
  }

  // ---------- model families
  function renderFamilies() {
    const who = f => C.families[f].free ? 'Free for everyone' : (() => {
      const tiers = TIERS.filter(t => C.tiers[t].families.includes(f)).map(t => C.tiers[t].name);
      return tiers.length === TIERS.length ? 'Unlimited on every tier' : `Unlimited on ${tiers.join(' and ')}`;
    })();
    $('families').innerHTML = Object.keys(C.families).map(f => { const F = C.families[f];
      return `<div class="fam"><h3>${esc(F.name)}</h3><p>${esc(F.about)}</p><div class="chips">${F.models.map(m => `<span>${esc(m)}</span>`).join('')}</div><div class="who">${esc(who(f))}</div></div>`; }).join('')
      + `<div class="fam"><h3>Paragon</h3><p>The Nexus '28 agent that can act for you: tools, connectors and your Mac.</p><div class="chips"><span>Paragon</span></div><div class="who">10 a day on Pro · 25 a day on Max</div></div>`;
  }

  // ---------- set up your system → Stripe
  function openSetup(tier) {
    const sel = { plan: st.plan, tier, billing: st.billing, os: C.os[0].id, connection: C.connections[0].id };
    const p = price(sel.plan, tier, sel.billing);
    const radio = (name, list) => list.map((o, i) => `<label class="choice"><input type="radio" name="${name}" value="${esc(o.id)}" ${i === 0 ? 'checked' : ''}><div><b>${esc(o.id)}</b><span>${esc(o.about)}</span></div></label>`).join('');
    const wrap = document.createElement('div'); wrap.className = 'scrim';
    wrap.innerHTML = `<form class="sheet" id="setup">
      <div class="kicker">Set up your system</div>
      <h3>${esc(C.plans[sel.plan].name)} · ${esc(C.tiers[tier].name)}</h3>
      <div class="sum"><div><b>${esc(C.tiers[tier].chip)}</b> <span class="muted">· ${esc(people(p.seats))}</span></div><div class="amt">${money(p.amount)}<small>/${p.interval === 'year' ? 'year' : 'month'}</small></div></div>
      <label class="lbl">LentOS</label><div class="choices">${radio('os', C.os.slice(0, 3))}</div>
      <details class="more"><summary class="muted" style="cursor:pointer;font-size:14px;margin-top:8px">Older LentOS versions</summary><div class="choices" style="margin-top:8px">${C.os.slice(3).map(o => `<label class="choice"><input type="radio" name="os" value="${esc(o.id)}"><div><b>${esc(o.id)}</b><span>${esc(o.about)}</span></div></label>`).join('')}</div></details>
      <label class="lbl">Connection</label><div class="choices">${radio('connection', C.connections)}</div>
      <label class="lbl" for="em">Email for your receipt</label><input class="field" id="em" type="email" placeholder="you@example.com" autocomplete="email">
      <div class="err" id="er"></div>
      <div class="acts"><button type="button" class="btn quiet" id="x">Back</button><button class="btn primary" id="go">Continue to payment</button></div>
      <div class="secure">🔒 Secure payment by Stripe · your order number comes right after</div>
    </form>`;
    document.body.append(wrap);
    const close = () => wrap.remove();
    wrap.onclick = e => { if (e.target === wrap) close(); };
    wrap.querySelector('#x').onclick = close;
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
    wrap.querySelector('#setup').onsubmit = async e => {
      e.preventDefault();
      const f = e.target; sel.os = f.os.value; sel.connection = f.connection.value; sel.email = f.querySelector('#em').value.trim();
      const go = f.querySelector('#go'), er = f.querySelector('#er');
      go.disabled = true; go.innerHTML = '<span class="spin"></span> Opening Stripe…'; er.textContent = '';
      try {
        const r = await post('checkout', { action: 'start', ...sel });
        location.href = r.url;
      } catch (err) { er.textContent = err.message; go.disabled = false; go.textContent = 'Continue to payment'; }
    };
  }

  async function post(fn, body) {
    let res;
    try { res = await fetch(`${CFG.functions}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.storeKey }, body: JSON.stringify(body) }); }
    catch { throw new Error("Couldn't reach the store. Check your connection and try again."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (res.status === 404 ? "Checkout isn't open yet. Please try again soon." : `Something went wrong (${res.status}).`));
    return data;
  }
  window.A3store = { post };

  // ---------- links, orb
  document.querySelectorAll('a.mail').forEach(a => a.href = mailto('aARgon3'));
  if (CFG.portalUrl) { $('portalLink').href = CFG.portalUrl; $('portalLink').hidden = false; $('portalFaq').innerHTML = `<a href="${esc(CFG.portalUrl)}">Manage your subscription here</a> with the email you paid with.`; }
  if (new URLSearchParams(location.search).has('cancelled')) toast('Payment cancelled. Nothing was charged.');
  renderPlanSeg(); renderTiers(); renderFamilies();
  try {
    const orb = window.NexusOrb.create($('heroOrb'), { color: '#5ce1ff' });
    const colors = ['#5ce1ff', '#b18cff', '#3dffa0', '#ffd36b']; let i = 0;
    setInterval(() => { orb.setColor(colors[++i % colors.length]); orb.pulse(.5); }, 3200);
    setInterval(() => orb.setMode(Math.random() < .3 ? 'thinking' : 'idle'), 2200);
  } catch {}
})();
