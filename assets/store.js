// The public store: plans, the "set up your system" sheet, and the trip to Stripe Checkout.
// Prices come from assets/catalog.js; the checkout function works them out again on the server, so nobody can change
// what they pay by editing this page.
(function () {
  const A3 = window.A3, { C, TIERS, PLANS, price, money } = A3;
  const CFG = window.A3_CONFIG;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const st = { plan: 'personal', billing: 'month', closed: false, closedMsg: '', info: null };
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const GIFT_MONTHS = [1, 3, 6, 12];
  const giftCents = (sel, m) => m === 12 ? price(sel.plan, sel.tier, 'year').cents : price(sel.plan, sel.tier, 'month').cents * m;
  const taxRate = r => st.info?.tax?.rates?.[r] || 0;
  // ---------- deals (2.5): automatic, no code. Same rules as the server: best price deal unless a code is used; perks always.
  const fits = (d, sel) => (!d.plans.length || d.plans.includes(sel.plan)) && (!d.tiers.length || d.tiers.includes(sel.tier)) && (!d.billing.length || d.billing.includes(sel.billing));
  const saving = (d, amt) => d.kind === 'percent' ? Math.round(amt * d.value) / 100 : d.kind === 'amount' ? Math.min(amt, d.value) : 0;
  function dealsFor(sel, withCode = false) {
    const list = (st.info?.deals || []).filter(d => fits(d, sel)), amt = price(sel.plan, sel.tier, sel.billing).amount;
    const priceDeal = withCode ? null : list.filter(d => d.kind === 'percent' || d.kind === 'amount').sort((a, b) => saving(b, amt) - saving(a, amt))[0] || null;
    const have = new Set(A3.items(sel.tier).map(i => i.model));
    const perks = list.filter(d => !['percent', 'amount'].includes(d.kind));
    return { price: priceDeal, perks, saving: priceDeal ? saving(priceDeal, amt) : 0, models: [...new Set(perks.filter(d => d.kind === 'models').flatMap(d => d.models))].filter(m => !have.has(m)),
      chip: perks.find(d => d.kind === 'chip')?.chip || null, seats: perks.filter(d => d.kind === 'seats').reduce((m, d) => m + d.value, 0), any: !!priceDeal || perks.length > 0 };
  }
  const ends = d => d.ends_at ? `Ends ${new Date(d.ends_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}` : 'For a limited time';
  function renderDeals() {
    const el = $('deals'), list = (st.info?.deals || []).filter(d => d.featured);
    if (!el) return;
    el.hidden = !list.length; const dlk = document.getElementById('dealsLink'); if (dlk) dlk.hidden = !list.length;
    el.innerHTML = list.length ? `<div class="deals-head"><span class="kicker">Deals</span><span class="muted">Applied automatically at checkout. No code needed.</span></div>
      <div class="deals">${list.map(d => `<article class="deal ${d.kind}"><div class="dk">${d.kind === 'models' ? '2 FOR 1' : d.kind === 'percent' ? `${d.value}% OFF` : d.kind === 'amount' ? `${money(d.value)} OFF` : d.kind === 'chip' ? 'CHIP UPGRADE' : 'MORE PEOPLE'}</div>
        <h3>${esc(d.headline)}</h3><p>${esc(d.description || d.label)}</p>
        <div class="dfoot"><span>${esc(ends(d))}</span><button class="btn small" data-deal="${d.id}">Get this deal</button></div></article>`).join('')}</div>` : '';
    el.querySelectorAll('[data-deal]').forEach(b => b.onclick = () => {
      const d = list.find(x => x.id === +b.dataset.deal);
      if (d.plans.length && !d.plans.includes(st.plan)) { st.plan = d.plans[0]; renderPlanSeg(); }
      if (d.billing.length && !d.billing.includes(st.billing)) { st.billing = d.billing[0]; renderPlanSeg(); }
      renderTiers();
      const t = d.tiers.length ? d.tiers[0] : 'pro';
      $('tiers').scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => openSetup(t), 350);
    });
  }
  const mailto = (subject, body = '') => `mailto:${C.contactEmail}?subject=${encodeURIComponent(subject)}${body ? '&body=' + encodeURIComponent(body) : ''}`;

  function toast(msg, kind = '') {
    const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('toasts').append(t);
    setTimeout(() => t.remove(), 6000);
  }

  // ---------- plans
  function renderPlanSeg() {
    $('planSeg').innerHTML = PLANS.map(p => `<button data-p="${p}" class="${p === st.plan ? 'on' : ''}">${esc(C.plans[p].name)}</button>`).join('')
      + `<button data-p="custom" class="${st.plan === 'custom' ? 'on' : ''}">Custom</button>`;
    $('planSeg').querySelectorAll('button').forEach(b => b.onclick = () => { st.plan = b.dataset.p; renderPlanSeg(); renderTiers(); });
    $('billSeg').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.b === st.billing); b.onclick = () => { st.billing = b.dataset.b; renderPlanSeg(); renderTiers(); }; });
    $('billSeg').hidden = st.plan === 'custom' || !!C.plans[st.plan].quote;
  }
  const people = n => n == null ? 'No set limit on people' : n === 1 ? '1 person' : `Up to ${n} people`;
  function renderTiers() {
    $('tiers').classList.toggle('custom', st.plan === 'custom');
    if (st.plan === 'custom') return renderCustom();
    const plan = C.plans[st.plan];
    $('planBlurb').textContent = plan.blurb;
    $('tiers').innerHTML = TIERS.map(t => {
      const tier = C.tiers[t], p = price(st.plan, t, st.billing), dl = p.quote ? null : dealsFor({ plan: st.plan, tier: t, billing: st.billing });
      const priceHtml = p.quote ? `<div class="price">Quote</div><div class="per">from ${money(p.from)}/month, by invoice</div>`
        : `<div class="price">${dl?.price ? `<s>${money(p.amount)}</s> ${money(Math.round((p.amount - dl.saving) * 100) / 100)}` : money(p.amount)}<small>/${p.interval === 'year' ? 'yr' : 'mo'}</small></div>
           ${dl?.price ? `<div class="per deal-per">${esc(dl.price.label)}</div>` : ''}
           <div class="per">${p.interval === 'year' ? `${money(Math.round(p.amount / 12 * 100) / 100)}/mo, billed yearly` : `or ${money(p.monthly * C.yearlyMonths)}/yr (2 months free)`}</div>`;
      return `<article class="tier ${tier.popular ? 'pop' : ''} ${dl?.any ? 'has-deal' : ''}">${dl?.any ? '<span class="flag deal-flag">DEAL</span>' : tier.popular ? '<span class="flag">MOST POPULAR</span>' : ''}
        <h3>${esc(tier.name)}</h3><div class="tag">${esc(tier.tagline)}</div>${priceHtml}
        <div class="meta"><span class="pill info">${esc(people(p.seats))}</span><span class="pill vio chip">${esc(tier.chip)}</span></div>
        ${dl && (dl.models.length || dl.chip || dl.seats) ? `<div class="deal-perks">${dl.models.length ? `<div>🎁 <b>${dl.models.map(esc).join(' + ')}</b> free</div>` : ''}${dl.chip ? `<div>🎁 Upgraded to <b>${esc(dl.chip)}</b></div>` : ''}${dl.seats ? `<div>🎁 <b>+${dl.seats}</b> ${dl.seats === 1 ? 'person' : 'people'}</div>` : ''}</div>` : ''}
        <ul>${tier.perks.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        ${p.quote ? `<button class="btn block" data-q="${t}">Ask for a quote</button>`
                  : `<button class="btn ${tier.popular ? 'primary' : ''} block" data-t="${t}">Choose ${esc(tier.name)}</button>`}
      </article>`;
    }).join('');
    $('tiers').querySelectorAll('button[data-t]').forEach(b => b.onclick = () => openSetup(b.dataset.t));
    $('tiers').querySelectorAll('button[data-q]').forEach(b => b.onclick = () => openQuote(b.dataset.q));
  }

  // ---------- Custom: build exactly what you want; staff price it and email a payment link or invoice
  const cu = { plan: 'business', tier: 'pro', seats: '', models: null, chip: null, os: C.os[0].id, connection: C.connections[0].id, interval: 'month', budget: '', notes: '' };
  function renderCustom() {
    $('planBlurb').textContent = 'Pick the people, models and hardware you want. We price it, then email you a secure Stripe link or invoice. Nothing is charged until you pay it.';
    const defModels = A3.items(cu.tier).map(i => i.model), models = cu.models || defModels, chip = cu.chip || C.tiers[cu.tier].chip;
    const segs = (id, list, on) => `<div class="seg" id="${id}">${list.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === on ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
    $('tiers').innerHTML = `<form class="tier cbuild" id="cform" novalidate>
      <div class="cb-head"><div><span class="flag">CUSTOM ORDER</span><h3>Build it your way</h3><div class="tag">Your people, your models, your chip. A real person prices it.</div></div>
        <div class="cb-steps"><span><b>1</b> Build</span><span><b>2</b> We price it</span><span><b>3</b> Pay by link or invoice</span></div></div>
      <div class="cb-grid">
        <div><label class="lbl">Who it's for</label>${segs('cuPlan', PLANS.map(p => [p, C.plans[p].name]), cu.plan)}</div>
        <div><label class="lbl">How many people</label><input class="field" id="cuSeats" type="number" min="1" max="100000" placeholder="${price(cu.plan, cu.tier, 'month').seats ?? 100}" value="${esc(cu.seats)}"></div>
        <div class="wide"><label class="lbl">Start from a tier</label>${segs('cuTier', TIERS.map(t => [t, C.tiers[t].name]), cu.tier)}</div>
        <div class="wide"><label class="lbl">Models you want <a href="#" id="cuReset">(reset to ${esc(C.tiers[cu.tier].name)}'s)</a></label>
          <div class="cb-models">${Object.keys(C.families).filter(f => !C.families[f].free).map(f => `<div class="cb-fam"><b>${esc(C.families[f].name)}</b>
            ${C.families[f].models.map(m => `<label class="cb-chk"><input type="checkbox" value="${esc(m)}" ${models.includes(m) ? 'checked' : ''}><span>${esc(m)}</span></label>`).join('')}</div>`).join('')}</div></div>
        <div><label class="lbl">Quouk chip</label><select class="field" id="cuChip">${C.chips.filter(c => c.id !== 'No order').map(c => `<option ${c.id === chip ? 'selected' : ''}>${esc(c.id)}</option>`).join('')}</select></div>
        <div><label class="lbl">LentOS</label><select class="field" id="cuOs">${C.os.map(o => `<option ${o.id === cu.os ? 'selected' : ''}>${esc(o.id)}</option>`).join('')}</select></div>
        <div><label class="lbl">Connection</label><select class="field" id="cuConn">${C.connections.map(o => `<option ${o.id === cu.connection ? 'selected' : ''}>${esc(o.id)}</option>`).join('')}</select></div>
        <div><label class="lbl">How you'd like to pay</label>${segs('cuIv', [['month', 'Monthly'], ['year', 'Yearly'], ['once', 'One payment']], cu.interval)}</div>
        <div><label class="lbl">Budget <span style="opacity:.6">(optional)</span></label><div class="money-in"><input class="field" id="cuBudget" type="number" min="0" step="1" placeholder="e.g. 500" value="${esc(cu.budget)}"></div></div>
        <div class="wide"><label class="lbl">Anything else? <span style="opacity:.6">(optional)</span></label><textarea class="field" id="cuNotes" rows="3" maxlength="1500" placeholder="Deadlines, special setups, questions">${esc(cu.notes)}</textarea></div>
      </div>
      <div class="cb-foot"><div class="muted" id="cuSum"></div><button class="btn primary">Next: your details</button></div>
    </form>`;
    const f = $('cform');
    const keep = () => { cu.seats = f.querySelector('#cuSeats').value; cu.chip = f.querySelector('#cuChip').value; cu.os = f.querySelector('#cuOs').value; cu.connection = f.querySelector('#cuConn').value;
      cu.budget = f.querySelector('#cuBudget').value; cu.notes = f.querySelector('#cuNotes').value; cu.models = [...f.querySelectorAll('.cb-models input:checked')].map(i => i.value); };
    const sum = () => { const n = f.querySelectorAll('.cb-models input:checked').length; f.querySelector('#cuSum').textContent = `${C.plans[cu.plan].name} · ${n} model${n === 1 ? '' : 's'} · ${f.querySelector('#cuChip').value}`; };
    const seg = (id, key, after) => f.querySelector('#' + id).querySelectorAll('button').forEach(b => b.onclick = () => { keep(); cu[key] = b.dataset.v; after?.(); renderCustom(); });
    seg('cuPlan', 'plan'); seg('cuIv', 'interval'); seg('cuTier', 'tier', () => { cu.models = null; cu.chip = null; });
    f.querySelector('#cuReset').onclick = e => { e.preventDefault(); keep(); cu.models = null; renderCustom(); };
    f.addEventListener('change', sum); sum();
    f.onsubmit = e => { e.preventDefault(); keep(); if (!cu.models.length) return toast('Pick at least one model.', 'bad'); openCustomDetails(); };
  }
  function openCustomDetails() {
    if (st.closed) return toast(st.closedMsg || 'The store is closed for now.', 'bad');
    const { wrap, close } = sheet(`<form class="sheet" id="cd" novalidate>
      <div class="kicker">Custom order · ${esc(C.plans[cu.plan].name)}</div>
      <h3>${cu.plan === 'personal' ? 'Where should we send your price?' : 'Who is asking?'}</h3>
      <p class="muted" style="margin:4px 0 0;font-size:14px">We'll look at what you built and email you a price with a secure Stripe link or invoice, usually within a day. Nothing is charged until you pay it.</p>
      ${window.A3forms.html(cu.plan)}
      <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="err" id="er"></div>
      <div class="acts"><button type="button" class="btn quiet" data-close>Back</button><button class="btn primary" id="go">Send my request</button></div>
    </form>`);
    const f = wrap.querySelector('#cd');
    window.A3forms.wire(f, { os: cu.os });
    f.onsubmit = async e => {
      e.preventDefault();
      const go = f.querySelector('#go'), er = f.querySelector('#er'); er.textContent = '';
      let customer; try { customer = window.A3forms.read(f, cu.plan); } catch (err) { er.textContent = err.message; return; }
      go.disabled = true; go.innerHTML = '<span class="spin"></span> Sending…';
      try {
        const r = await post('checkout', { action: 'request', plan: cu.plan, tier: cu.tier, seats: cu.seats || undefined, models: cu.models, chip: cu.chip, os: cu.os, connection: cu.connection,
          interval: cu.interval, budget: cu.budget, notes: cu.notes, customer, website: f.website.value });
        f.innerHTML = `<div class="kicker">Request sent</div><h3>Thanks! It's <span class="mono">${esc(r.quote_no)}</span>.</h3>
          <p class="muted" style="font-size:15px">We'll email <b>${esc(customer.billing_email || customer.email)}</b> with your price and a secure way to pay. Keep that number in case you need to reach us.</p>
          <div class="acts"><button type="button" class="btn primary" data-close>Done</button></div>`;
        f.querySelector('[data-close]').onclick = close;
        cu.notes = ''; cu.budget = ''; renderCustom();
      } catch (err) { er.textContent = err.message; go.disabled = false; go.textContent = 'Send my request'; }
    };
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
      <label class="lbl">Your region <span style="opacity:.6">${st.info?.tax ? '(for tax)' : '(optional)'}</span></label>
      <select class="field" id="region"><option value="">Choose your region</option>${Object.entries(C.regions).map(([k, v]) => `<option value="${k}" ${store.get('a3_region') === k ? 'selected' : ''}>${k} · ${esc(v)}</option>`).join('')}</select>
      <label class="check gift-tog"><input type="checkbox" id="isGift"><span><b>🎁 Send this as a gift</b><small>Pay once for 1 to 12 months. They get a code to claim it, and the months start when they do.</small></span></label>
      <div class="giftbox" id="giftBox" hidden>
        <label class="lbl">How long</label><div class="seg" id="gm">${GIFT_MONTHS.map(m => `<button type="button" data-m="${m}" class="${m === 3 ? 'on' : ''}">${m} mo<small>${money(giftCents(sel, m) / 100)}</small></button>`).join('')}</div>
        <div class="two"><div><label class="lbl">Their name</label><input class="field" id="gName" maxlength="80" placeholder="Who it's for"></div>
          <div><label class="lbl">Their email <span style="opacity:.6">(optional)</span></label><input class="field" id="gEmail" type="email" maxlength="120" placeholder="We'll email them the code"></div></div>
        <label class="lbl">A note <span style="opacity:.6">(optional)</span></label><textarea class="field" id="gMsg" rows="2" maxlength="300" placeholder="Happy birthday!"></textarea>
        <p class="fine" style="margin:6px 0 0">No email? We'll send the code to you, and it's on the next page too.</p>
      </div>
      <label class="lbl">Promo or referral code <span style="opacity:.6">(optional)</span></label>
      <div class="promo-row"><input class="field" id="promo" placeholder="CODE or REF-XXXXXX" autocomplete="off" maxlength="30"><button type="button" class="btn small" id="apply">Apply</button></div>
      <div class="promo-ok" id="promoOk"></div>
      <div class="totals" id="tot"></div>
      <label class="check"><input type="checkbox" id="remind"><span><small>Email me one reminder if I don't finish checking out. Just one, and only for this order.</small></span></label>
      <div class="err" id="er"></div>
      <div class="acts"><button type="button" class="btn quiet" id="back">Back</button><button class="btn primary" id="go">Continue to payment</button></div>
      <div class="secure">🔒 Secure payment by Stripe · your order number comes right after</div>
    </form>`);
    const f1 = wrap.querySelector('#setup'), f2 = wrap.querySelector('#who');
    window.A3forms.wire(f2, { os: () => sel.os });
    const ref = store.get('a3_ref');
    if (ref) f2.querySelector('#promo').value = ref;
    f1.onsubmit = e => { e.preventDefault(); sel.os = f1.os.value; sel.connection = f1.connection.value; f1.hidden = true; f2.hidden = false; f2.querySelector('[data-f]')?.focus(); };
    f2.querySelector('#back').onclick = () => { f2.hidden = true; f1.hidden = false; };
    let giftM = 3;
    const isGift = () => f2.querySelector('#isGift').checked;
    // what they'll pay today: plan (or gift) − code + tax for their region
    const amt = () => {
      f1.querySelector('#amt').innerHTML = promo ? `<s class="muted" style="font-size:14px">${money(p.amount)}</s> ${money(promo.after)}<small>/${per}</small>` : `${money(p.amount)}<small>/${per}</small>`;
      const dl = isGift() ? null : dealsFor(sel, !!promo);
      const base = isGift() ? giftCents(sel, giftM) / 100 : p.amount, after = promo && !isGift() ? promo.after : dl?.price ? Math.round((base - dl.saving) * 100) / 100 : base;
      const r = f2.querySelector('#region').value, rate = taxRate(r), tax = Math.round(after * rate) / 100;
      f2.querySelector('#tot').innerHTML = `<div><span>${isGift() ? `Gift · ${giftM} month${giftM === 1 ? '' : 's'}, paid once` : `${esc(C.plans[sel.plan].name)} ${esc(C.tiers[sel.tier].name)} · ${per === 'year' ? 'yearly' : 'monthly'}`}</span><b>${money(base)}</b></div>
        ${promo && !isGift() ? `<div class="off"><span>${esc(promo.code)}</span><b>−${money(Math.round((base - after) * 100) / 100)}</b></div>` : ''}
        ${dl?.price ? `<div class="off"><span>Deal: ${esc(dl.price.headline)}</span><b>−${money(dl.saving)}</b></div>` : ''}
        ${dl?.perks.length ? `<div class="perk"><span>🎁 ${dl.perks.map(d => esc(d.headline)).join(' · ')}</span><b>free</b></div>` : ''}
        ${promo && !isGift() && dealsFor(sel).price ? `<div class="fine">Your code replaces the ${esc(dealsFor(sel).price.headline)} deal (one discount per order).</div>` : ''}
        ${rate ? `<div><span>${esc(st.info.tax.label)} (${rate}%)</span><b>${money(tax)}</b></div>` : ''}
        <div class="t"><span>Today</span><b>${money(Math.round((after + tax) * 100) / 100)}</b></div>
        ${!isGift() && promo ? `<div class="fine">Then ${money(p.amount)}${rate ? ' + tax' : ''} a ${per}${promo.duration === 'forever' ? ` (${money(promo.after)} with your code)` : ''}.</div>` : ''}`;
    };
    f2.querySelector('#region').onchange = e => { store.set('a3_region', e.target.value); amt(); };
    f2.querySelector('#isGift').onchange = () => { f2.querySelector('#giftBox').hidden = !isGift(); f2.querySelector('#remind').closest('label').hidden = false; amt(); if (isGift()) f2.querySelector('#gName').focus(); };
    f2.querySelectorAll('#gm button').forEach(b => b.onclick = () => { giftM = +b.dataset.m; f2.querySelectorAll('#gm button').forEach(x => x.classList.toggle('on', x === b)); amt(); });
    amt();
    f2.querySelector('#promo').oninput = () => { if (promo) { promo = null; f2.querySelector('#promoOk').textContent = ''; amt(); } };
    f2.querySelector('#apply').onclick = async e => {
      const code = f2.querySelector('#promo').value.trim(), ok = f2.querySelector('#promoOk'), er = f2.querySelector('#er');
      er.textContent = ''; ok.textContent = '';
      if (!code) return;
      e.target.disabled = true;
      const email = f2.querySelector('[data-f=email]')?.value || '';
      try { promo = await post('checkout', { action: 'promo', code, email, ...sel }); ok.textContent = `✓ ${promo.code}: ${promo.label}.`; amt(); }
      catch (err) { promo = null; er.textContent = err.message; }
      e.target.disabled = false;
    };
    f2.onsubmit = async e => {
      e.preventDefault();
      const go = f2.querySelector('#go'), er = f2.querySelector('#er'); er.textContent = '';
      let customer; try { customer = window.A3forms.read(f2, sel.plan); } catch (err) { er.textContent = err.message; return; }
      const code = f2.querySelector('#promo').value.trim(), region = f2.querySelector('#region').value;
      if (st.info?.tax && !region) { er.textContent = 'Pick your region so we can add the right tax.'; f2.querySelector('#region').focus(); return; }
      const gift = isGift() ? { months: giftM, to_name: f2.querySelector('#gName').value.trim(), to_email: f2.querySelector('#gEmail').value.trim(), message: f2.querySelector('#gMsg').value.trim() } : undefined;
      if (gift && !gift.to_name) { er.textContent = "Who's the gift for? Add their name."; f2.querySelector('#gName').focus(); return; }
      go.disabled = true; go.innerHTML = '<span class="spin"></span> Opening Stripe…';
      try {
        const r = await post('checkout', { action: 'start', ...sel, customer, promo: code || undefined, region: region || undefined, gift, followup: f2.querySelector('#remind').checked });
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
  const q = new URLSearchParams(location.search);
  if (q.has('cancelled')) toast('Payment cancelled. Nothing was charged.');
  // a friend's referral link: ?ref=REF-XXXXXX (kept for this visit, filled into the code box)
  if (/^REF-[A-Z0-9]{6}$/i.test(q.get('ref') || '')) {
    store.set('a3_ref', q.get('ref').toUpperCase());
    const n = document.createElement('div'); n.className = 'refnote'; n.innerHTML = `🎉 A friend sent you a month off. Code <b class="mono">${esc(q.get('ref').toUpperCase())}</b> is filled in at checkout.`; $('tiers').before(n);
  }
  // a link back to a plan (from a reminder email): ?plan=business&tier=pro&billing=month
  if (PLANS.includes(q.get('plan'))) { st.plan = q.get('plan'); if (['month', 'year'].includes(q.get('billing'))) st.billing = q.get('billing'); }
  renderPlanSeg(); renderTiers(); renderFamilies();
  if (q.get('tier') && TIERS.includes(q.get('tier')) && !C.plans[st.plan].quote) setTimeout(() => { $('plans').scrollIntoView(); openSetup(q.get('tier')); }, 300);
  const nice = d => new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  post('checkout', { action: 'info' }).then(i => {
    st.info = i;
    if ((i.deals || []).length) { renderDeals(); renderTiers(); }
    if (!i.open) {   // closed for now (owner switch, or a closure on the calendar)
      st.closed = true; st.closedMsg = i.message || 'The store is closed for now. Please check back soon.';
      const n = document.createElement('div'); n.className = 'closed'; n.textContent = st.closedMsg; $('tiers').before(n);
      return;
    }
    // heads-up for closures in the next two weeks
    const soon = (i.closures || []).filter(c => (new Date(c.starts_on) - Date.now()) / 864e5 < 14);
    if (soon.length) { const n = document.createElement('div'); n.className = 'closed soon';
      n.innerHTML = soon.map(c => `Heads up: the online store is closed ${c.starts_on === c.ends_on ? nice(c.starts_on) : `${nice(c.starts_on)} – ${nice(c.ends_on)}`}${c.reason ? ` for ${esc(c.reason)}` : ''}.`).join('<br>'); $('tiers').before(n); }
  }).catch(() => {});
  try {
    const orb = window.NexusOrb.create($('heroOrb'), { color: '#5ce1ff' });
    const colors = ['#5ce1ff', '#b18cff', '#3dffa0', '#ffd36b']; let i = 0;
    setInterval(() => { orb.setColor(colors[++i % colors.length]); orb.pulse(.5); }, 3200);
    setInterval(() => orb.setMode(Math.random() < .3 ? 'thinking' : 'idle'), 2200);
  } catch {}
})();
