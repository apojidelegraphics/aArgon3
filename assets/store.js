// The public store: plans, the "set up your system" sheet, and the trip to Stripe Checkout.
// Prices come from assets/catalog.js; the checkout function works them out again on the server, so nobody can change
// what they pay by editing this page.
(function () {
  const A3 = window.A3, { C, TIERS, PLANS, price, money } = A3;
  const CFG = window.A3_CONFIG;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const st = { plan: 'personal', billing: 'month', closed: false, closedMsg: '' };
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
        ${p.quote ? `<button class="btn block" data-q="${t}">Ask for a quote</button>`
                  : `<button class="btn ${tier.popular ? 'primary' : ''} block" data-t="${t}">Choose ${esc(tier.name)}</button>`}
      </article>`;
    }).join('');
    $('tiers').querySelectorAll('button[data-t]').forEach(b => b.onclick = () => openSetup(b.dataset.t));
    $('tiers').querySelectorAll('button[data-q]').forEach(b => b.onclick = () => openQuote(b.dataset.q));
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

  // ---------- set up your system → your details → Stripe
  function sheet(html) {
    const wrap = document.createElement('div'); wrap.className = 'scrim'; wrap.innerHTML = html;
    document.body.append(wrap);
    const close = () => { wrap.remove(); document.removeEventListener('keydown', k); };
    const k = e => { if (e.key === 'Escape') close(); };
    wrap.onclick = e => { if (e.target === wrap) close(); };
    document.addEventListener('keydown', k);
    wrap.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
    return { wrap, close };
  }
  const radio = (name, list, n = list.length, checked = list[0]?.id) => list.slice(0, n).map(o => `<label class="choice"><input type="radio" name="${name}" value="${esc(o.id)}" ${o.id === checked ? 'checked' : ''}><div><b>${esc(o.id)}</b><span>${esc(o.about)}</span></div></label>`).join('');

  function openSetup(tier) {
    if (st.closed) return toast(st.closedMsg || 'The store is closed for now.', 'bad');
    const sel = { plan: st.plan, tier, billing: st.billing };
    const p = price(sel.plan, tier, sel.billing), per = p.interval === 'year' ? 'year' : 'month';
    let promo = null;
    const { wrap, close } = sheet(`<form class="sheet" id="setup" novalidate>
      <div class="kicker">Step 1 of 2 · Your system</div>
      <h3>${esc(C.plans[sel.plan].name)} · ${esc(C.tiers[tier].name)}</h3>
      <div class="sum"><div><b>${esc(C.tiers[tier].chip)}</b> <span class="muted">· ${esc(people(p.seats))}</span></div><div class="amt" id="amt">${money(p.amount)}<small>/${per}</small></div></div>
      <label class="lbl">LentOS</label><div class="choices">${radio('os', C.os, 3)}</div>
      <details class="more"><summary class="muted" style="cursor:pointer;font-size:14px;margin-top:8px">Older LentOS versions</summary><div class="choices" style="margin-top:8px">${C.os.slice(3).map(o => `<label class="choice"><input type="radio" name="os" value="${esc(o.id)}"><div><b>${esc(o.id)}</b><span>${esc(o.about)}</span></div></label>`).join('')}</div></details>
      <label class="lbl">Connection</label><div class="choices">${radio('connection', C.connections)}</div>
      <div class="acts"><button type="button" class="btn quiet" data-close>Back</button><button class="btn primary">Next: your details</button></div>
    </form>
    <form class="sheet" id="who" novalidate hidden>
      <div class="kicker">Step 2 of 2 · ${sel.plan === 'personal' ? 'About you' : 'Your business'}</div>
      <h3>${sel.plan === 'personal' ? 'Who is this for?' : 'Who is placing this order?'}</h3>
      <p class="muted" style="margin:4px 0 0;font-size:14px">${sel.plan === 'personal' ? 'We put this on your order so we can help you later.' : 'We put your business details on the order and your receipts.'}</p>
      ${window.A3forms.html(sel.plan)}
      <label class="lbl">Promo code <span style="opacity:.6">(optional)</span></label>
      <div class="promo-row"><input class="field" id="promo" placeholder="CODE" autocomplete="off" maxlength="30"><button type="button" class="btn small" id="apply">Apply</button></div>
      <div class="promo-ok" id="promoOk"></div>
      <div class="err" id="er"></div>
      <div class="acts"><button type="button" class="btn quiet" id="back">Back</button><button class="btn primary" id="go">Continue to payment</button></div>
      <div class="secure">🔒 Secure payment by Stripe · your order number comes right after</div>
    </form>`);
    const f1 = wrap.querySelector('#setup'), f2 = wrap.querySelector('#who');
    window.A3forms.wire(f2, { os: () => sel.os });
    f1.onsubmit = e => { e.preventDefault(); sel.os = f1.os.value; sel.connection = f1.connection.value; f1.hidden = true; f2.hidden = false; f2.querySelector('[data-f]')?.focus(); };
    f2.querySelector('#back').onclick = () => { f2.hidden = true; f1.hidden = false; };
    const amt = () => f1.querySelector('#amt').innerHTML = promo ? `<s class="muted" style="font-size:14px">${money(p.amount)}</s> ${money(promo.after)}<small>/${per}</small>` : `${money(p.amount)}<small>/${per}</small>`;
    f2.querySelector('#promo').oninput = () => { if (promo) { promo = null; f2.querySelector('#promoOk').textContent = ''; amt(); } };
    f2.querySelector('#apply').onclick = async e => {
      const code = f2.querySelector('#promo').value.trim(), ok = f2.querySelector('#promoOk'), er = f2.querySelector('#er');
      er.textContent = ''; ok.textContent = '';
      if (!code) return;
      e.target.disabled = true;
      try { promo = await post('checkout', { action: 'promo', code, ...sel }); ok.textContent = `✓ ${promo.code}: ${promo.label}. ${money(promo.after)} instead of ${money(promo.before)}.`; amt(); }
      catch (err) { promo = null; er.textContent = err.message; }
      e.target.disabled = false;
    };
    f2.onsubmit = async e => {
      e.preventDefault();
      const go = f2.querySelector('#go'), er = f2.querySelector('#er'); er.textContent = '';
      let customer; try { customer = window.A3forms.read(f2, sel.plan); } catch (err) { er.textContent = err.message; return; }
      const code = f2.querySelector('#promo').value.trim();
      go.disabled = true; go.innerHTML = '<span class="spin"></span> Opening Stripe…';
      try {
        const r = await post('checkout', { action: 'start', ...sel, customer, promo: code || undefined });
        location.href = r.url;
      } catch (err) { er.textContent = err.message; go.disabled = false; go.textContent = 'Continue to payment'; }
    };
  }

  // ---------- Enterprise: ask for a quote (opens an email with everything filled in)
  function openQuote(tier) {
    const est = A3.enterpriseSuggest(tier, C.plans.enterprise.seats[tier] || 100);
    const { wrap } = sheet(`<form class="sheet" id="q" novalidate>
      <div class="kicker">Enterprise · ${esc(C.tiers[tier].name)}</div>
      <h3>Ask for a quote</h3>
      <p class="muted" style="margin:4px 0 0;font-size:14px">Enterprise is priced for your team and paid by invoice. Most ${esc(C.tiers[tier].name)} teams start around <b id="est">${money(est)}/month</b>.</p>
      <label class="lbl">How many people</label><input class="field" id="seats" type="number" min="100" step="10" value="${C.plans.enterprise.seats[tier] || 100}">
      ${window.A3forms.html('enterprise')}
      <label class="lbl">Anything else? <span style="opacity:.6">(optional)</span></label><textarea class="field" id="msg" rows="3" placeholder="Timeline, billing needs, questions"></textarea>
      <div class="err" id="er"></div>
      <div class="acts"><button type="button" class="btn quiet" data-close>Cancel</button><button class="btn primary">Email my request</button></div>
      <div class="secure">Opens your email app with everything filled in. We'll reply with a quote and an invoice link.</div>
    </form>`);
    const f = wrap.querySelector('#q');
    window.A3forms.wire(f, { os: C.os[0].id });
    f.querySelector('#seats').oninput = e => f.querySelector('#est').textContent = `${money(A3.enterpriseSuggest(tier, e.target.value))}/month`;
    f.onsubmit = e => {
      e.preventDefault();
      let c; try { c = window.A3forms.read(f, 'enterprise'); } catch (err) { f.querySelector('#er').textContent = err.message; return; }
      const seats = Math.max(100, Number(f.querySelector('#seats').value) || 100);
      const body = `Hi Apoji team,\n\nWe'd like an aARgon3 Enterprise ${C.tiers[tier].name} quote.\n\nPeople: ${seats}\nCorporate entity: ${c.company}\nLead operator: ${c.name}${c.title ? ` (${c.title})` : ''}\nEmail: ${c.email}\nPhone: ${c.phone}\nOmni-QNCN node: ${c.node}\nJurisdiction: ${c.jurisdiction}${c.billing_email ? `\nBilling email: ${c.billing_email}` : ''}\n\n${f.querySelector('#msg').value.trim()}\n`;
      location.href = mailto(`aARgon3 Enterprise ${C.tiers[tier].name} quote · ${c.company}`, body);
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
  // closed for now? (owner switch in the terminal)
  post('checkout', { action: 'info' }).then(i => {
    if (i.open) return;
    st.closed = true; st.closedMsg = i.message || 'The store is closed for now. Please check back soon.';
    const n = document.createElement('div'); n.className = 'closed'; n.textContent = st.closedMsg; $('tiers').before(n);
  }).catch(() => {});
  try {
    const orb = window.NexusOrb.create($('heroOrb'), { color: '#5ce1ff' });
    const colors = ['#5ce1ff', '#b18cff', '#3dffa0', '#ffd36b']; let i = 0;
    setInterval(() => { orb.setColor(colors[++i % colors.length]); orb.pulse(.5); }, 3200);
    setInterval(() => orb.setMode(Math.random() < .3 ? 'thinking' : 'idle'), 2200);
  } catch {}
})();
