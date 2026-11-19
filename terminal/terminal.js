// aARgon3 Terminal — the staff side: sign in, clock in and out, sell, look up orders, timesheets.
// Same file on the website (/terminal/) and in the desktop app. Staff sign in with their Nexus account; everything
// goes through the "staff" Edge Function, which checks that the account is a Nexus admin before doing anything.
(function () {
  const CFG = window.A3_CONFIG, A3 = window.A3, { C, TIERS, PLANS, price, money } = A3;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const desk = window.aargonDesktop || null;
  if (desk) document.body.classList.add('desktop', desk.platform === 'darwin' ? 'mac' : 'win');

  // Nexus accounts (sign in) — kept apart from Nexus '28's own session on this browser
  const sb = window.supabase.createClient(CFG.nexusUrl, CFG.nexusKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'aargon3-staff-auth' } });
  const S = { me: null, state: null, overview: null, page: 'today', fetchedAt: 0, sale: null, saleTimer: null };
  window.A3T = S;   // for the tests

  // ---------- small helpers
  function toast(msg, kind = '', onClick = null) {
    const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('toasts').append(t);
    if (onClick) { t.style.cursor = 'pointer'; t.onclick = () => { onClick(); t.remove(); }; }
    setTimeout(() => t.remove(), onClick ? 20000 : kind === 'bad' ? 8000 : 4500);
  }
  const fmtTime = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDay = d => new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtWhen = d => { const x = new Date(d), today = new Date().toDateString() === x.toDateString(); return today ? `Today ${fmtTime(x)}` : `${fmtDay(x)} ${fmtTime(x)}`; };
  const hm = m => { m = Math.max(0, Math.round(m)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const clockText = m => { m = Math.max(0, Math.floor(m)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const localInput = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  const statusPill = s => { s = String(s || '').toUpperCase(); return `<span class="pill ${s === 'ACTIVE' ? 'ok' : /CANCEL|REFUND|VOID/.test(s) ? 'bad' : 'warn'}">${esc(s || '—')}</span>`; };
  function sheet(html, onMount) {
    const w = document.createElement('div'); w.className = 'scrim'; w.innerHTML = `<div class="sheet">${html}</div>`;
    document.body.append(w);
    const close = () => { w.remove(); document.removeEventListener('keydown', esc_); };
    const esc_ = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc_);
    w.onclick = e => { if (e.target === w) close(); };
    w.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
    onMount?.(w.querySelector('.sheet'), close);
    return close;
  }
  function confirmSheet(title, text, okLabel, danger = false) {
    return new Promise(res => sheet(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p><div class="acts"><button class="btn quiet" data-close>Never mind</button><button class="btn ${danger ? 'danger' : 'primary'}" id="ok">${esc(okLabel)}</button></div>`,
      (el, close) => { el.querySelector('#ok').onclick = () => { close(); res(true); }; el.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => res(false))); }));
  }
  async function busy(btn, fn) {
    const label = btn?.innerHTML; if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
    try { return await fn(); } catch (e) { toast(e.message, 'bad'); throw e; } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
  }

  // ---------- the staff function
  async function api(action, body = {}) {
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) { signIn('Your sign-in expired. Sign in again.'); throw new Error('Signed out.'); }
    let res;
    try { res = await fetch(`${CFG.functions}/staff`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: CFG.storeKey }, body: JSON.stringify({ action, ...body }) }); }
    catch { throw new Error("Can't reach aARgon3. Check your internet connection."); }
    const r = await res.json().catch(() => ({}));
    if (res.status === 401) { await sb.auth.signOut(); signIn(r.error); throw new Error(r.error || 'Signed out.'); }
    if (res.status === 403 && /isn't an admin/.test(r.error || '')) { await sb.auth.signOut(); signIn(r.error); throw new Error(r.error); }
    if (!res.ok) throw new Error(r.error || (res.status === 404 ? "The aARgon3 server functions aren't deployed yet." : `Something went wrong (${res.status}).`));
    return r;
  }
  async function refresh() {
    const r = await api('me');
    S.me = r.user; S.state = r.state; S.overview = r.overview; S.fetchedAt = Date.now();
    paintClock(); paintMe();
  }
  const shift = () => S.state?.shift || null;
  const workedNow = () => { const s = shift(); if (!s) return 0; return s.minutes + (s.on_break ? 0 : (Date.now() - S.fetchedAt) / 60e3); };
  const breakNow = () => { const s = shift(); const b = s?.breaks?.find(x => !x.end); return b ? (Date.now() - new Date(b.start)) / 60e3 : 0; };

  // ---------- sign in (admins only)
  function signIn(msg = '') {
    clearInterval(S.saleTimer);
    $('app').innerHTML = `<div class="login"><form class="card" id="f">
      <img class="logo" src="../icons/icon-192.png" alt="">
      <h1>aARgon3 Terminal</h1><p>Staff sign in. Use your Nexus admin account — this terminal is for Apoji staff only.</p>
      <input class="field" id="em" type="email" placeholder="Email" autocomplete="username" required>
      <input class="field" id="pw" type="password" placeholder="Password" autocomplete="current-password" required>
      <button class="btn primary block" id="go">Sign in</button>
      <div class="err" id="er">${esc(msg)}</div>
      <div class="fine">Not staff? <a href="${desk ? 'https://apojidelegraphics.github.io/aArgon3/' : '../'}">Visit the aARgon3 store</a></div></form></div>`;
    $('em').focus();
    $('f').onsubmit = async e => {
      e.preventDefault(); $('er').textContent = '';
      const go = $('go'); go.disabled = true; go.innerHTML = '<span class="spin"></span> Signing in…';
      const { error } = await sb.auth.signInWithPassword({ email: $('em').value.trim(), password: $('pw').value });
      if (error) { $('er').textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message; go.disabled = false; go.textContent = 'Sign in'; return; }
      // quick check before the full load: is this a Nexus admin at all?
      const { data: level } = await sb.rpc('get_my_admin_level');
      if (!level) { await sb.auth.signOut(); go.disabled = false; go.textContent = 'Sign in'; $('er').textContent = "That account isn't an admin, so it can't use aARgon3."; return; }
      start();
    };
  }
  async function signOut() {
    if (shift() && !(await confirmSheet('Sign out while clocked in?', "You'll stay on the clock. Clock out first if you're done for the day.", 'Sign out anyway'))) return;
    await sb.auth.signOut(); location.hash = ''; signIn();
  }

  // ---------- shell
  const PAGES = [
    { id: 'today', ic: '◉', label: 'Today' }, { id: 'sale', ic: '＋', label: 'New sale' }, { id: 'orders', ic: '☰', label: 'Orders' },
    { id: 'time', ic: '◷', label: 'Timesheet' }, { id: 'activity', ic: '≡', label: 'Activity', manager: true }];
  function shell() {
    $('app').innerHTML = `<div class="shell">
      <aside class="side"><div class="brand"><img src="../icons/icon-192.png" alt=""><div>AARGON3<small>TERMINAL</small></div></div>
        ${PAGES.filter(p => !p.manager || S.me.manager).map((p, i) => `${p.manager && !PAGES[i - 1]?.manager ? '<div class="sect">MANAGER</div>' : ''}<button class="nav" data-p="${p.id}"><span class="ic">${p.ic}</span><span class="lbl">${p.label}</span><kbd>${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl '}${i + 1}</kbd></button>`).join('')}
        <div class="sp"></div><div class="me" id="me"></div></aside>
      <main class="main"><header class="top"><h2 id="title"></h2><span class="sp"></span><div class="clock" id="clock"></div></header><div id="page"></div></main></div>`;
    document.querySelectorAll('.nav').forEach(b => b.onclick = () => go(b.dataset.p));
    paintMe(); paintClock();
  }
  function paintMe() {
    if (!$('me') || !S.me) return;
    $('me').innerHTML = `<div class="av">${esc(initials(S.me.name))}</div><div><b>${esc(S.me.name)}</b><small>${S.me.manager ? 'Manager' : esc(S.me.level)}</small></div><button class="btn quiet small out" id="so" title="Sign out">⏻</button>`;
    $('so').onclick = signOut;
  }
  function go(page) {
    const p = PAGES.find(x => x.id === page && (!x.manager || S.me.manager)) || PAGES[0];
    S.page = p.id; if (location.hash !== '#' + p.id) history.replaceState(null, '', '#' + p.id);
    document.querySelectorAll('.nav').forEach(b => b.classList.toggle('on', b.dataset.p === p.id));
    $('title').textContent = p.label;
    $('page').innerHTML = '<div class="wrap" id="pg"></div>';
    ({ today: pageToday, sale: pageSale, orders: pageOrders, time: pageTime, activity: pageActivity })[p.id]();
  }

  // ---------- the clock (top bar)
  function paintClock() {
    const el = $('clock'); if (!el) return;
    const s = shift();
    if (!s) {
      el.className = 'clock';
      el.innerHTML = `<span class="dot"></span><div class="what">OFF THE CLOCK<b>${hm(S.state?.week_minutes || 0)}</b></div><button class="btn primary small" id="cin">Clock in</button>`;
      el.querySelector('.what').title = 'Your hours this week';
      $('cin').onclick = () => clockInSheet();
    } else if (s.on_break) {
      el.className = 'clock brk';
      el.innerHTML = `<span class="dot"></span><div class="what">ON BREAK<b id="tick">${clockText(breakNow())}</b></div><button class="btn primary small" id="bk">End break</button>`;
      $('bk').onclick = e => doBreak(false, e.target);
    } else {
      el.className = 'clock on';
      el.innerHTML = `<span class="dot"></span><div class="what" title="${esc(s.store)}">ON THE CLOCK · #${esc(s.store_code)}<b id="tick">${clockText(workedNow())}</b></div>
        <button class="btn small" id="bk">Break</button><button class="btn small danger" id="cout">Clock out</button>`;
      $('bk').onclick = e => doBreak(true, e.target);
      $('cout').onclick = () => clockOutSheet();
    }
  }
  setInterval(() => { const t = $('tick'); if (t && shift()) t.textContent = clockText(shift().on_break ? breakNow() : workedNow()); }, 15e3);

  function storeOptions(selected) {
    const regions = {};
    for (const st of S.state?.stores || []) (regions[st.region] = regions[st.region] || []).push(st);
    return Object.keys(regions).sort().map(r => `<optgroup label="Region ${esc(r)}">${regions[r].map(st => `<option value="${esc(st.code)}" ${st.code === selected ? 'selected' : ''}>#${esc(st.code)} · ${esc(st.name)}</option>`).join('')}</optgroup>`).join('');
  }
  function clockInSheet() {
    sheet(`<div class="kicker">Clock in</div><h3>Start your shift</h3><p class="muted">Pick where you're working. It remembers your last store.</p>
      <label class="lbl">Store</label><select class="field" id="store">${storeOptions(S.state?.last_store)}</select>
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">Clock in now</button></div>`,
      (el, close) => { el.querySelector('#ok').onclick = e => clockIn(el.querySelector('#store').value, e.target).then(close, () => {}); });
  }
  async function clockIn(store, btn) {
    await busy(btn, () => api('clock_in', { store }));
    await refresh(); toast(`Clocked in at ${fmtTime(new Date())}. Have a good shift!`, 'ok'); go(S.page);
  }
  function clockOutSheet() {
    const s = shift(), brk = (s.breaks || []).reduce((m, b) => m + ((b.end ? new Date(b.end) : new Date()) - new Date(b.start)) / 60e3, 0);
    sheet(`<div class="kicker">Clock out</div><h3>Done for now?</h3>
      <div class="kv"><span>Clocked in</span><span>${fmtWhen(s.clock_in)} · #${esc(s.store_code)}</span><span>Worked</span><span><b>${hm(workedNow())}</b>${brk >= 1 ? ` <span class="muted">(${hm(brk)} on break)</span>` : ''}</span>
        <span>Sales this shift</span><span>${s.orders} · ${money(Number(s.sales) || 0)}</span></div>
      <label class="lbl">Note (optional)</label><input class="field" id="note" placeholder="Anything your manager should know">
      <div class="acts"><button class="btn quiet" data-close>Keep working</button><button class="btn danger" id="ok">Clock out</button></div>`,
      (el, close) => { el.querySelector('#ok').onclick = e => clockOut({ note: el.querySelector('#note').value }, e.target).then(close, () => {}); });
  }
  async function clockOut(body, btn) {
    const r = await busy(btn, () => api('clock_out', body));
    await refresh(); toast(`Clocked out. You worked ${hm(r.minutes)}.`, 'ok'); go(S.page);
  }
  async function doBreak(on, btn) { await busy(btn, () => api('break', { on })); await refresh(); toast(on ? 'Break started. Enjoy!' : 'Welcome back.'); }

  // ---------- Today
  function pageToday() {
    const s = shift(), o = S.overview || {}, pg = $('pg');
    const long = s && (Date.now() - new Date(s.clock_in)) > 12 * 3600e3;
    const week = o.week || [], max = Math.max(1, ...week.map(d => Number(d.revenue) || 0));
    pg.innerHTML = `
      ${long ? `<div class="banner"><div><b>Forgot to clock out?</b> You've been clocked in since ${fmtWhen(s.clock_in)}.</div>
        <span class="sp" style="flex:1"></span><span class="muted">I left at</span><input class="field" type="datetime-local" id="leftAt" value="${localInput(Math.min(Date.now(), new Date(s.clock_in).getTime() + 8 * 3600e3))}">
        <button class="btn small" id="fix">Clock out at that time</button></div>` : ''}
      ${!s ? `<div class="card gate"><div><div class="kicker">Off the clock</div><h3>Clock in to start selling</h3><p>Hi ${esc(S.me.name)}. You've worked ${hm(S.state?.week_minutes || 0)} this week.</p>
          <label class="lbl">Store</label><select class="field" id="gstore">${storeOptions(S.state?.last_store)}</select></div>
          <button class="btn primary" id="gin">Clock in</button></div>` : ''}
      <div class="stats">
        <div class="card stat"><div class="k">Sales today</div><div class="v">${money(Number(o.today?.revenue) || 0)}</div><div class="s">${o.today?.orders || 0} order${o.today?.orders === 1 ? '' : 's'}</div></div>
        <div class="card stat"><div class="k">Active subscriptions</div><div class="v">${o.active_subscriptions || 0}</div><div class="s">paying through Stripe</div></div>
        <div class="card stat"><div class="k">This shift</div><div class="v">${s ? hm(workedNow()) : '—'}</div><div class="s">${s ? `${s.orders} sale${s.orders === 1 ? '' : 's'} · ${money(Number(s.sales) || 0)}` : 'not clocked in'}</div></div>
        <div class="card stat"><div class="k">Your week</div><div class="v">${hm((S.state?.week_minutes || 0) + (s && !s.on_break ? (Date.now() - S.fetchedAt) / 60e3 : 0))}</div><div class="s">since Monday</div></div>
      </div>
      <div class="cols">
        <div class="card"><h3>Last 7 days<small>sales</small></h3><div class="bars">${week.map((d, i) => `<div class="b ${i === week.length - 1 ? 'today' : ''}" title="${esc(d.day)}: ${d.orders} orders"><span class="amt">${Number(d.revenue) ? money(Math.round(d.revenue)) : ''}</span><div class="bar" style="height:${Math.round((Number(d.revenue) || 0) / max * 130)}px"></div><span class="lab">${new Date(d.day + 'T12:00').toLocaleDateString([], { weekday: 'short' })}</span></div>`).join('')}</div></div>
        <div class="card"><h3>On the clock now<small>${(o.on_clock || []).length}</small></h3><div class="people">${(o.on_clock || []).map(p => `<div class="person"><div class="av">${esc(initials(p.name))}</div><div><b>${esc(p.name)}</b><small>#${esc(p.store_code)} · since ${fmtTime(p.clock_in)}</small></div><div class="r">${p.on_break ? '<span class="pill warn">BREAK</span>' : hm(p.minutes)}</div></div>`).join('') || '<div class="empty" style="padding:20px">Nobody yet.</div>'}</div>
          ${s ? '<button class="btn primary block" id="newsale" style="margin-top:14px">＋ New sale</button>' : ''}</div>
      </div>`;
    $('gin') && ($('gin').onclick = e => clockIn($('gstore').value, e.target));
    $('newsale') && ($('newsale').onclick = () => go('sale'));
    $('fix') && ($('fix').onclick = e => clockOut({ at: new Date($('leftAt').value).toISOString(), note: 'Forgot to clock out' }, e.target));
  }

  // ---------- New sale
  const draft = { plan: 'personal', tier: 'pro', billing: 'month', os: C.os[0].id, connection: C.connections[0].id, email: '' };
  function pageSale() {
    const pg = $('pg');
    if (S.sale) return paintPayment();
    if (!shift()) {
      pg.innerHTML = `<div class="card gate"><div><div class="kicker">New sale</div><h3>Clock in first</h3><p>Sales are tracked on your shift.</p>
        <label class="lbl">Store</label><select class="field" id="gstore">${storeOptions(S.state?.last_store)}</select></div><button class="btn primary" id="gin">Clock in</button></div>`;
      $('gin').onclick = e => clockIn($('gstore').value, e.target);
      return;
    }
    const plan = C.plans[draft.plan];
    if (plan.quote) draft.plan = 'personal';
    pg.innerHTML = `<div class="sale">
      <div class="card">
        <div class="row" style="justify-content:space-between"><div class="seg" id="pseg">${PLANS.filter(p => !C.plans[p].quote).map(p => `<button data-v="${p}" class="${p === draft.plan ? 'on' : ''}">${esc(C.plans[p].name)}</button>`).join('')}</div>
          <div class="seg" id="bseg"><button data-v="month" class="${draft.billing === 'month' ? 'on' : ''}">Monthly</button><button data-v="year" class="${draft.billing === 'year' ? 'on' : ''}">Yearly</button></div></div>
        <label class="lbl">Tier</label><div class="tierpick" id="tp"></div>
        <div class="two"><div><label class="lbl">LentOS</label><select class="field" id="os">${C.os.map(o => `<option ${o.id === draft.os ? 'selected' : ''}>${esc(o.id)}</option>`).join('')}</select></div>
          <div><label class="lbl">Connection</label><select class="field" id="conn">${C.connections.map(o => `<option ${o.id === draft.connection ? 'selected' : ''}>${esc(o.id)}</option>`).join('')}</select></div></div>
        <label class="lbl">Customer email (optional)</label><input class="field" id="email" type="email" placeholder="Stripe sends the receipt here" value="${esc(draft.email)}">
        <p class="muted" style="font-size:13px;margin:14px 0 0">Enterprise is quoted by invoice: send them to ${esc(C.contactEmail)}.</p>
      </div>
      <div class="card summary" id="sum"></div></div>`;
    const seg = (id, key) => $(id).querySelectorAll('button').forEach(b => b.onclick = () => { draft[key] = b.dataset.v; $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); paintTiers(); });
    seg('pseg', 'plan'); seg('bseg', 'billing');
    $('os').onchange = e => { draft.os = e.target.value; paintSum(); };
    $('conn').onchange = e => { draft.connection = e.target.value; paintSum(); };
    $('email').oninput = e => { draft.email = e.target.value; };
    paintTiers();
  }
  function paintTiers() {
    $('tp').innerHTML = TIERS.map(t => { const p = price(draft.plan, t, draft.billing);
      return `<button class="tp ${t === draft.tier ? 'on' : ''}" data-t="${t}"><b>${esc(C.tiers[t].name)}</b><div class="pr">${money(p.amount)}<span class="muted" style="font-size:12px;font-weight:500">/${p.interval === 'year' ? 'yr' : 'mo'}</span></div><small>${p.seats === 1 ? '1 person' : `${p.seats} people`} · ${esc(C.tiers[t].chip)}</small></button>`; }).join('');
    $('tp').querySelectorAll('.tp').forEach(b => b.onclick = () => { draft.tier = b.dataset.t; paintTiers(); });
    paintSum();
  }
  function paintSum() {
    const p = price(draft.plan, draft.tier, draft.billing), t = C.tiers[draft.tier];
    $('sum').innerHTML = `<h3>${esc(C.plans[draft.plan].name)} · ${esc(t.name)}</h3>
      <div class="line"><span>People</span><span>${p.seats}</span></div><div class="line"><span>Chip</span><span>${esc(t.chip)}</span></div>
      <div class="line"><span>LentOS</span><span>${esc(draft.os)}</span></div><div class="line"><span>Connection</span><span>${esc(draft.connection.replace(/ \(.*\)/, ''))}</span></div>
      <div class="line"><span>Billing</span><span>${p.interval === 'year' ? 'Yearly' : 'Monthly'}</span></div>
      <div class="total"><span class="muted">Total</span><b>${money(p.amount)}<span class="muted" style="font-size:14px;font-weight:500">/${p.interval === 'year' ? 'yr' : 'mo'}</span></b></div>
      <button class="btn primary block" id="mk">Create payment link</button>
      ${S.me.manager ? '<button class="btn quiet block" id="comp" style="margin-top:8px">Give it free (comp)…</button>' : ''}
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">The customer pays on their phone (QR code) or on this screen. The order is created the moment Stripe confirms.</p>`;
    $('mk').onclick = e => busy(e.target, async () => {
      const r = await api('sale', { ...draft });
      S.sale = { ...r, sel: { ...draft }, state: 'waiting', started: Date.now() };
      paintPayment(); pollSale();
    }).catch(() => {});
    $('comp') && ($('comp').onclick = compSheet);
  }
  function qrSvg(text) {
    try { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
    catch { return '<div style="width:240px;height:240px;display:grid;place-items:center;color:#333">QR unavailable</div>'; }
  }
  function paintPayment() {
    const x = S.sale, pg = $('pg'); if (!pg) return;
    const sel = x.sel;
    if (x.state === 'paid') {
      pg.innerHTML = `<div class="card pay" style="max-width:560px;margin:0 auto"><div class="kicker">Paid</div><div class="paid">✓ Payment received</div>
        <p class="muted">${esc(C.plans[sel.plan].name)} · ${esc(C.tiers[sel.tier].name)} · ${money(x.amount)}/${x.interval === 'year' ? 'yr' : 'mo'}</p>
        <div class="orderno" id="no">${esc(x.order.order_id)}</div>
        <p class="muted">Tell the customer to redeem it in Nexus '28: Settings → Account → Redeem an order. It's on their Stripe receipt too.</p>
        <div class="row" style="justify-content:center"><button class="btn" id="cp">Copy order number</button><button class="btn primary" id="again">New sale</button></div></div>`;
      $('cp').onclick = () => navigator.clipboard.writeText(x.order.order_id).then(() => toast('Copied.'));
      $('again').onclick = () => { S.sale = null; draft.email = ''; go('sale'); };
      return;
    }
    const gone = x.state === 'expired' || x.state === 'cancelled';
    pg.innerHTML = `<div class="card pay" style="max-width:560px;margin:0 auto">
      <div class="kicker">${gone ? 'Not paid' : 'Waiting for payment'}</div>
      <h3 style="margin:0">${esc(C.plans[sel.plan].name)} · ${esc(C.tiers[sel.tier].name)} · ${money(x.amount)}/${x.interval === 'year' ? 'yr' : 'mo'}</h3>
      ${gone ? `<p class="muted" style="margin:18px 0">This payment link ${x.state === 'expired' ? 'expired' : 'was closed'} without a payment. Nothing was charged.</p>`
        : `<div class="qr">${qrSvg(x.url)}</div>
        <div class="wait"><span class="spin"></span> Scan with a phone camera to pay. This updates by itself.</div>
        <div class="linkbox"><input class="field" readonly value="${esc(x.url)}" id="lnk"><button class="btn small" id="cp">Copy</button><button class="btn small" id="open">Pay here</button></div>`}
      <p class="muted" style="font-size:13px;margin-top:14px">Order number once paid: <span class="mono">${esc(x.order_id)}</span></p>
      <div class="row" style="justify-content:center;margin-top:8px"><button class="btn quiet" id="cancel">${gone ? 'Back' : 'Cancel this sale'}</button>${!gone ? '<button class="btn quiet" id="chk">Check now</button>' : ''}</div></div>`;
    $('cp') && ($('cp').onclick = () => navigator.clipboard.writeText(x.url).then(() => toast('Payment link copied.')));
    $('open') && ($('open').onclick = () => { desk ? desk.openPayment(x.url) : window.open(x.url, '_blank', 'noopener'); });
    $('chk') && ($('chk').onclick = e => busy(e.target, checkSale));
    $('cancel').onclick = () => { clearInterval(S.saleTimer); S.sale = null; go('sale'); };
  }
  async function checkSale() {
    const x = S.sale; if (!x) return;
    const r = await api('sale_status', { session_id: x.session_id });
    if (r.ready) {
      x.state = 'paid'; x.order = r.order; clearInterval(S.saleTimer);
      toast(`Paid! Order ${r.order.order_id}.`, 'ok'); desk?.attention?.();
      refresh().catch(() => {});
    } else if (r.state === 'expired') { x.state = 'expired'; clearInterval(S.saleTimer); }
    if (S.page === 'sale') paintPayment();
  }
  function pollSale() {
    clearInterval(S.saleTimer);
    S.saleTimer = setInterval(() => {
      if (!S.sale || Date.now() - S.sale.started > 40 * 60e3) return clearInterval(S.saleTimer);
      checkSale().catch(() => {});
    }, 3000);
  }
  function compSheet() {
    sheet(`<div class="kicker">Manager · free order</div><h3>Comp ${esc(C.plans[draft.plan].name)} · ${esc(C.tiers[draft.tier].name)}</h3>
      <p class="muted">Creates a working order with no payment and no subscription. It's logged under your name.</p>
      <label class="lbl">Who it's for</label><input class="field" id="nm" placeholder="Name">
      <label class="lbl">Email</label><input class="field" id="em" type="email" value="${esc(draft.email)}">
      <label class="lbl">Why</label><input class="field" id="nt" placeholder="e.g. tester, giveaway, make-good">
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">Create free order</button></div>`,
      (el, close) => el.querySelector('#ok').onclick = e => busy(e.target, async () => {
        const r = await api('comp', { ...draft, email: el.querySelector('#em').value, name: el.querySelector('#nm').value, note: el.querySelector('#nt').value });
        close(); sheet(`<div class="kicker">Free order created</div><div class="orderno" style="margin:12px 0">${esc(r.order_id)}</div><p class="muted">Redeem it in Nexus '28: Settings → Account → Redeem an order.</p><div class="acts"><button class="btn primary" data-close>Done</button></div>`);
      }).catch(() => {}));
  }

  // ---------- Orders
  let orderQ = '';
  function pageOrders() {
    $('pg').innerHTML = `<div class="tools"><input class="field" id="q" placeholder="Search order number, email or name" value="${esc(orderQ)}"><span class="sp"></span><button class="btn small" id="rf">Refresh</button></div>
      <div class="card tblcard"><table class="tbl"><thead><tr><th>Order</th><th>Customer</th><th>Plan</th><th class="num">Amount</th><th>Status</th><th>When</th><th>Sold by</th></tr></thead><tbody id="rows"><tr><td colspan="7" class="empty"><span class="spin"></span></td></tr></tbody></table></div>`;
    let t; $('q').oninput = e => { clearTimeout(t); orderQ = e.target.value; t = setTimeout(loadOrders, 250); };
    $('rf').onclick = loadOrders; $('q').focus(); loadOrders();
  }
  async function loadOrders() {
    let list; try { list = await api('orders', { q: orderQ }); } catch (e) { $('rows') && ($('rows').innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`); return; }
    if (!$('rows')) return;
    $('rows').innerHTML = list.map(o => `<tr class="click" data-id="${esc(o.order_id)}"><td class="id">${esc(o.order_id)}</td>
      <td>${esc(o.customer_name || o.customer_email || '—')}${o.customer_name && o.customer_email ? `<div class="muted" style="font-size:12.5px">${esc(o.customer_email)}</div>` : ''}</td>
      <td>${esc(o.plan || '—')}${o.tier ? ` · ${esc(C.tiers[o.tier]?.name || o.tier)}` : (o.config?.service_tier ? ` · ${esc(o.config.service_tier)}` : '')}</td>
      <td class="num">${o.source === 'comp' ? '<span class="pill vio">COMP</span>' : money(Number(o.amount) || 0)}${o.billing === 'year' ? '<span class="muted">/yr</span>' : o.subscription ? '<span class="muted">/mo</span>' : ''}</td>
      <td>${statusPill(o.status)}</td><td class="muted">${fmtWhen(o.created_at)}</td><td class="muted">${esc(o.source === 'web' ? 'Online store' : o.operator || '—')}</td></tr>`).join('')
      || `<tr><td colspan="7" class="empty">${orderQ ? 'No orders match.' : 'No orders yet.'}</td></tr>`;
    $('rows').querySelectorAll('tr.click').forEach(r => r.onclick = () => orderSheet(r.dataset.id));
  }
  async function orderSheet(id) {
    let o; try { o = await api('order', { order_id: id }); } catch { return; }
    const c = o.config || {}, active = String(o.status).toUpperCase() === 'ACTIVE';
    sheet(`<div class="kicker">Order</div><div class="row" style="justify-content:space-between"><h3 class="mono">${esc(o.order_id)}</h3>${statusPill(o.status)}</div>
      <div class="kv"><span>Customer</span><span>${esc(o.customer_name || '—')}${o.customer_email ? `<br><span class="muted">${esc(o.customer_email)}</span>` : ''}</span>
        <span>Plan</span><span>${esc(o.plan || '—')} · ${esc(c.service_tier || o.tier || '—')}</span>
        <span>Amount</span><span>${o.source === 'comp' ? 'Free (comp)' : `${money(Number(o.amount) || 0)}${o.billing === 'year' ? ' a year' : o.subscription ? ' a month' : ''}`}</span>
        <span>System</span><span>${esc([c.os, c.chip, c.connection].filter(Boolean).join(' · ') || '—')}</span>
        <span>Sold</span><span>${fmtWhen(o.created_at)} · ${esc(o.source === 'web' ? 'Online store' : `${o.operator || '—'}${o.store ? ', ' + o.store : ''}`)}</span></div>
      <label class="lbl">Models</label><div class="chips">${(o.models || []).map(m => `<span>${esc(m)}</span>`).join('') || '<span>—</span>'}</div>
      <div class="acts"><button class="btn quiet" id="cp">Copy number</button>${S.me.manager && active ? `<button class="btn danger" id="cx">Cancel</button>${o.subscription ? '<button class="btn danger" id="rf">Refund & cancel</button>' : ''}` : ''}<button class="btn primary" data-close>Close</button></div>`,
      (el, close) => {
        el.querySelector('#cp').onclick = () => navigator.clipboard.writeText(o.order_id).then(() => toast('Copied.'));
        const act = refund => async e => {
          if (!(await confirmSheet(refund ? 'Refund and cancel?' : 'Cancel this order?', refund ? 'Refunds the last payment, ends the subscription now, and the order stops working in Nexus.' : 'Ends the subscription now (no refund), and the order stops working in Nexus.', refund ? 'Refund & cancel' : 'Cancel order', true))) return;
          const r = await api('cancel', { order_id: o.order_id, refund }).catch(err => { toast(err.message, 'bad'); return null; });
          if (r) { close(); toast(`${o.order_id} ${r.status.toLowerCase()}${r.refunded ? ` · refunded ${money(r.refunded)}` : ''}.`, 'ok'); loadOrders(); }
        };
        el.querySelector('#cx') && (el.querySelector('#cx').onclick = act(false));
        el.querySelector('#rf') && (el.querySelector('#rf').onclick = act(true));
      });
  }

  // ---------- Timesheet
  const tsv = { range: 'week', everyone: false, rows: [] };
  function rangeOf(r) {
    const now = new Date(), d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (r === 'week') return [monday, new Date(monday.getTime() + 7 * 864e5)];
    if (r === 'lastweek') return [new Date(monday.getTime() - 7 * 864e5), monday];
    if (r === 'month') return [new Date(d.getFullYear(), d.getMonth(), 1), new Date(d.getFullYear(), d.getMonth() + 1, 1)];
    return [new Date(d.getFullYear(), d.getMonth() - 1, 1), new Date(d.getFullYear(), d.getMonth(), 1)];
  }
  function pageTime() {
    $('pg').innerHTML = `<div class="tools"><div class="seg" id="rseg">${[['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month']].map(([v, l]) => `<button data-v="${v}" class="${tsv.range === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${S.me.manager ? `<div class="seg" id="wseg"><button data-v="me" class="${!tsv.everyone ? 'on' : ''}">Me</button><button data-v="all" class="${tsv.everyone ? 'on' : ''}">Everyone</button></div>` : ''}
      <span class="sp"></span><button class="btn small" id="csv">Export CSV</button></div><div id="tot" class="totals"></div>
      <div class="card tblcard"><table class="tbl"><thead><tr><th>Day</th>${tsv.everyone ? '<th>Who</th>' : ''}<th>Store</th><th>In</th><th>Out</th><th class="num">Breaks</th><th class="num">Worked</th><th class="num">Sales</th><th></th></tr></thead><tbody id="rows"><tr><td colspan="9" class="empty"><span class="spin"></span></td></tr></tbody></table></div>`;
    $('rseg').querySelectorAll('button').forEach(b => b.onclick = () => { tsv.range = b.dataset.v; pageTime(); });
    $('wseg') && $('wseg').querySelectorAll('button').forEach(b => b.onclick = () => { tsv.everyone = b.dataset.v === 'all'; pageTime(); });
    $('csv').onclick = exportCsv;
    loadShifts();
  }
  const breakMin = s => (s.breaks || []).reduce((m, b) => m + ((b.end ? new Date(b.end) : new Date()) - new Date(b.start)) / 60e3, 0);
  async function loadShifts() {
    const [from, to] = rangeOf(tsv.range);
    try { tsv.rows = await api('shifts', { from: from.toISOString(), to: to.toISOString(), everyone: tsv.everyone }); }
    catch (e) { $('rows') && ($('rows').innerHTML = `<tr><td colspan="9" class="empty">${esc(e.message)}</td></tr>`); return; }
    if (!$('rows')) return;
    const total = tsv.rows.reduce((m, s) => m + s.minutes, 0), byPerson = {};
    tsv.rows.forEach(s => byPerson[s.name] = (byPerson[s.name] || 0) + s.minutes);
    $('tot').innerHTML = `<div class="card stat"><div class="k">Total worked</div><div class="v">${hm(total)}</div></div><div class="card stat"><div class="k">Shifts</div><div class="v">${tsv.rows.length}</div></div>`
      + (tsv.everyone ? Object.entries(byPerson).sort((a, b) => b[1] - a[1]).map(([n, m]) => `<div class="card stat"><div class="k">${esc(n)}</div><div class="v">${hm(m)}</div></div>`).join('') : '');
    $('rows').innerHTML = tsv.rows.map((s, i) => `<tr><td>${fmtDay(s.clock_in)}</td>${tsv.everyone ? `<td>${esc(s.name)}</td>` : ''}<td>#${esc(s.store_code || '—')}</td>
      <td>${fmtTime(s.clock_in)}</td><td>${s.clock_out ? fmtTime(s.clock_out) : '<span class="pill ok">NOW</span>'}${s.forgot ? ' <span class="pill warn" title="Clock-out time entered afterwards">SET LATER</span>' : ''}${s.edited_by ? ` <span class="pill vio" title="Edited by ${esc(s.edited_by)}">EDITED</span>` : ''}</td>
      <td class="num">${breakMin(s) >= 1 ? hm(breakMin(s)) : '—'}</td><td class="num"><b>${hm(s.minutes)}</b></td><td class="num">${s.orders ? `${s.orders} · ${money(Number(s.sales) || 0)}` : '—'}</td>
      <td class="num">${S.me.manager ? `<button class="btn quiet small" data-i="${i}">Edit</button>` : ''}${s.note ? ` <span title="${esc(s.note)}">📝</span>` : ''}</td></tr>`).join('')
      || `<tr><td colspan="9" class="empty">No shifts in this range.</td></tr>`;
    $('rows').querySelectorAll('button[data-i]').forEach(b => b.onclick = () => editShift(tsv.rows[+b.dataset.i]));
  }
  function editShift(s) {
    sheet(`<div class="kicker">Manager · fix a shift</div><h3>${esc(s.name)} · ${fmtDay(s.clock_in)}</h3><p class="muted">The change is saved with your name on it.</p>
      <div class="two"><div><label class="lbl">Clock in</label><input class="field" type="datetime-local" id="ci" value="${localInput(s.clock_in)}"></div>
      <div><label class="lbl">Clock out</label><input class="field" type="datetime-local" id="co" value="${s.clock_out ? localInput(s.clock_out) : ''}"></div></div>
      <label class="lbl">Note</label><input class="field" id="nt" value="${esc(s.note || '')}">
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">Save</button></div>`,
      (el, close) => el.querySelector('#ok').onclick = e => busy(e.target, async () => {
        const co = el.querySelector('#co').value;
        await api('edit_shift', { id: s.id, clock_in: new Date(el.querySelector('#ci').value).toISOString(), clock_out: co ? new Date(co).toISOString() : null, note: el.querySelector('#nt').value });
        close(); toast('Shift saved.', 'ok'); refresh().catch(() => {}); loadShifts();
      }).catch(() => {}));
  }
  function exportCsv() {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Name', 'Store', 'Clock in', 'Clock out', 'Break minutes', 'Worked minutes', 'Hours', 'Orders', 'Sales', 'Note', 'Edited by'].join(',')]
      .concat(tsv.rows.map(s => [s.name, s.store, new Date(s.clock_in).toLocaleString(), s.clock_out ? new Date(s.clock_out).toLocaleString() : '', Math.round(breakMin(s)), s.minutes, (s.minutes / 60).toFixed(2), s.orders, s.sales, s.note, s.edited_by].map(q).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `aargon3-timesheet-${tsv.range}${tsv.everyone ? '-everyone' : ''}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Activity (managers)
  async function pageActivity() {
    $('pg').innerHTML = '<div class="card tblcard"><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody id="rows"><tr><td colspan="4" class="empty"><span class="spin"></span></td></tr></tbody></table></div>';
    const label = { sale_link: 'Made a payment link', comp: 'Gave a free order', cancel: 'Cancelled an order', refund: 'Refunded an order', edit_shift: 'Fixed a shift' };
    try {
      const list = await api('log');
      $('rows').innerHTML = list.map(l => `<tr><td class="muted">${fmtWhen(l.at)}</td><td>${esc(l.name)}</td><td>${esc(label[l.action] || l.action)}</td><td class="muted mono" style="font-size:12.5px">${esc(Object.entries(l.details || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '))}</td></tr>`).join('')
        || '<tr><td colspan="4" class="empty">Nothing yet.</td></tr>';
    } catch (e) { $('rows').innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`; }
  }

  // ---------- start
  async function start() {
    $('app').innerHTML = '<div class="login"><div class="muted"><span class="spin"></span> Loading…</div></div>';
    const { data } = await sb.auth.getSession();
    if (!data.session) return signIn();
    try { await refresh(); }
    catch (e) {
      if (!$('app').querySelector('.login .spin')) return;   // already showing the sign-in screen
      $('app').innerHTML = `<div class="login"><div class="card"><h1>Can't load</h1><p>${esc(e.message)}</p><button class="btn primary" id="again">Try again</button><button class="btn quiet" id="so2">Sign out</button></div></div>`;
      $('again').onclick = start; $('so2').onclick = async () => { await sb.auth.signOut(); signIn(); };
      return;
    }
    shell(); go(location.hash.slice(1) || 'today');
  }
  document.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || !S.me || document.querySelector('.scrim')) return;
    const list = PAGES.filter(p => !p.manager || S.me.manager), n = +e.key;
    if (n >= 1 && n <= list.length) { e.preventDefault(); go(list[n - 1].id); }
  });
  // keep the clock and numbers fresh while the terminal is open
  setInterval(() => { if (S.me && document.visibilityState === 'visible' && !document.querySelector('.scrim')) refresh().then(() => { if (S.page === 'today') go('today'); }).catch(() => {}); }, 60e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.me) refresh().catch(() => {}); });
  desk?.onUpdate?.(u => u.latest ? toast(`aARgon3 ${u.latest} is out. Click here to download it.`, 'ok', () => desk.openReleases()) : u.current && toast(`You're on the latest version (${u.current}).`));
  desk?.onMenu?.(p => S.me && (p === 'signout' ? signOut() : go(p)));
  start();
})();
