// aARgon3 Terminal — the staff side. Same file on the website (/terminal/) and in the desktop app.
// Staff sign in with their Nexus account; everything goes through the "staff" Edge Function, which checks who you are
// and what your role (employee / manager / owner) lets you do before doing anything.
(function () {
  const CFG = window.A3_CONFIG, A3 = window.A3, { C, TIERS, PLANS, price, money } = A3;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n, s) => window.A3icon(n, s);
  const desk = window.aargonDesktop || null;
  if (desk) document.body.classList.add('desktop', desk.platform === 'darwin' ? 'mac' : 'win');
  const MOD = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl ';

  const sb = window.supabase.createClient(CFG.nexusUrl, CFG.nexusKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'aargon3-staff-auth' } });
  const S = { me: null, state: null, overview: null, store: { open: true }, page: 'today', fetchedAt: 0, sale: null, saleTimer: null, lastOrders: null };
  window.A3T = S;   // for the tests

  // ================================================================ helpers
  function toast(msg, kind = '', onClick = null) {
    const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('toasts').append(t);
    if (onClick) { t.style.cursor = 'pointer'; t.onclick = () => { onClick(); t.remove(); }; }
    setTimeout(() => t.remove(), onClick ? 20000 : kind === 'bad' ? 8000 : 4500);
  }
  const fmtTime = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // "6 AM–5 PM" / "9:30 AM–2 PM": short enough to sit on one line in a schedule cell
  const shortTime = d => { const t = new Date(d); return t.toLocaleTimeString([], t.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' }); };
  const fmtDay = d => new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtDate = d => new Date(d + (String(d).length === 10 ? 'T12:00' : '')).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtWhen = d => { const x = new Date(d), today = new Date().toDateString() === x.toDateString(); return today ? `Today ${fmtTime(x)}` : `${fmtDay(x)} ${fmtTime(x)}`; };
  const hm = m => { m = Math.max(0, Math.round(m)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const clockText = m => { m = Math.max(0, Math.floor(m)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  // 2.6: one Apoji account. Anyone with a Nexus account shows their Nexus picture (looked up in batches, painted in when it arrives)
  const APOJI = { map: new Map(), want: new Set(), t: 0 };
  const avatar = (name, color, cls = '', uid = null) => {
    const p = uid ? APOJI.map.get(uid) : null;
    if (uid && !APOJI.map.has(uid)) apojiWant(uid);
    return `<div class="av ${cls} ${p?.avatar_url ? 'pic' : ''}" ${uid ? `data-uid="${esc(uid)}" data-init="${esc(initials(name))}"` : ''} style="${color ? `background:${esc(color)}` : ''}">${p?.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="" loading="lazy">` : esc(initials(name))}</div>`;
  };
  function apojiWant(uid) { APOJI.want.add(uid); clearTimeout(APOJI.t); APOJI.t = setTimeout(apojiLoad, 40); }
  async function apojiLoad() {
    const ids = [...APOJI.want].slice(0, 200); APOJI.want.clear();
    if (!ids.length) return;
    ids.forEach(i => APOJI.map.set(i, null));
    try {
      const { data, error } = await sb.rpc('apoji_profiles', { p_ids: ids });
      if (error) throw error;
      for (const p of data || []) APOJI.map.set(p.id, p);
    } catch { return; }   // Nexus older than 4.0.1: initials stay
    document.querySelectorAll('.av[data-uid]').forEach(el => { const p = APOJI.map.get(el.dataset.uid); if (p?.avatar_url && !el.classList.contains('pic')) { el.classList.add('pic'); el.innerHTML = `<img src="${esc(p.avatar_url)}" alt="" loading="lazy">`; } });
    document.dispatchEvent(new Event('apoji:profiles'));
  }
  // a flat apoji_profiles row → what NexusCosmetics.card() wants
  const apojiCard = p => p && ({ ...p, style: { display_name: p.display_name, frame: p.frame, pframe: p.pframe, ptheme: p.ptheme, font: p.font, color: p.color, name_a: p.name_a, name_b: p.name_b,
    banner: p.banner, banner_url: p.banner_url, theme_a: p.theme_a, theme_b: p.theme_b, effect: p.effect, presence: p.presence, pronouns: p.pronouns, status_text: p.status_text } });
  const localInput = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  const ymd = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
  const statusPill = s => { s = String(s || '').toUpperCase(); return `<span class="pill ${s === 'ACTIVE' || s === 'PAID' || s === 'APPROVED' ? 'ok' : /CANCEL|REFUND|VOID|DENIED/.test(s) ? 'bad' : s === 'DRAFT' || s === 'EXPIRED' ? 'dim' : s === 'REQUESTED' ? 'info' : s === 'GIFT' ? 'vio' : 'warn'}">${esc(s || '—')}</span>`; };
  const roleName = r => ({ owner: 'Owner', manager: 'Manager', employee: 'Employee' }[r] || r);
  const tierName = t => C.tiers[t]?.name || (t ? t[0].toUpperCase() + t.slice(1) : '—');
  const big = n => money(Math.round(Number(n) || 0));
  const COLORS = ['#5ce1ff', '#b18cff', '#3dffa0', '#ffd36b', '#ff8fb1', '#7c9bff', '#ffb35c', '#9ef0d0'];

  function sheet(html, onMount, cls = '') {
    const w = document.createElement('div'); w.className = 'scrim'; w.innerHTML = `<div class="sheet ${cls}">${html}</div>`;
    document.body.append(w);
    const close = () => { w.remove(); document.removeEventListener('keydown', k); };
    const k = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', k);
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
  const quiet = p => p.catch(() => {});
  function csv(name, header, rows) {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[header.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\n')], { type: 'text/csv' }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function qrSvg(text) {
    try { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
    catch { return '<div style="width:240px;height:240px;display:grid;place-items:center;color:#333">QR unavailable</div>'; }
  }
  const copy = (text, what = 'Copied.') => navigator.clipboard.writeText(text).then(() => toast(what), () => toast("Couldn't copy.", 'bad'));
  const storeOptions = (selected, blank = false) => {
    const regions = {};
    for (const st of S.state?.stores || []) (regions[st.region] = regions[st.region] || []).push(st);
    return (blank ? '<option value="">Any store</option>' : '') + Object.keys(regions).sort().map(r => `<optgroup label="Region ${esc(r)} · ${esc(C.regions[r] || '')}">${regions[r].map(st => `<option value="${esc(st.code)}" ${st.code === selected ? 'selected' : ''}>${storeNow(st.code)?.label === 'Closed today' ? '⛔ ' : ''}#${esc(st.code)} · ${esc(st.name)}</option>`).join('')}</optgroup>`).join('');
  };
  const storeRegion = code => (S.state?.stores || []).find(s => s.code === code)?.region;
  const storeNow = code => S.hours?.stores?.find(x => x.code === code)?.now || null;
  const t12 = hm => { const [h, m] = String(hm).split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };

  // ================================================================ the staff function
  const APP_VERSION = '2.6.0', NEED_DB = '2.6.0';   // keep APP_VERSION = package.json (a test checks)
  const vcmp = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
  const READS = new Set(['me', 'promos', 'deals', 'promo_list', 'orders', 'log']);   // safe to try twice
  async function api(action, body = {}) {
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) { signIn('Your sign-in expired. Sign in again.'); throw new Error('Signed out.'); }
    let res;
    const send = () => fetch(`${CFG.functions}/staff`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: CFG.storeKey }, body: JSON.stringify({ action, ...body }) });
    try { res = await send().catch(async e => { if (!READS.has(action) || navigator.onLine === false) throw e; await new Promise(r => setTimeout(r, 900)); return send(); }); }
    catch { throw new Error(navigator.onLine === false ? "You're offline. Check your internet connection." : "Can't reach aARgon3's server. If you're online, its functions may not be deployed (see the README)."); }
    const r = await res.json().catch(() => ({}));
    if (res.status === 401) { await sb.auth.signOut(); signIn(r.error); throw new Error(r.error || 'Signed out.'); }
    if (res.status === 403 && /isn't an admin|staff list|turned off/.test(r.error || '')) { await sb.auth.signOut(); signIn(r.error); throw new Error(r.error); }
    if (!res.ok) throw new Error(r.error || (res.status === 404 ? "The aARgon3 server functions aren't deployed yet." : `Something went wrong (${res.status}).`));
    return r;
  }
  async function refresh() {
    const r = await api('me');
    const before = S.overview?.today?.orders;
    const reqBefore = S.requests;
    S.me = r.user; S.state = r.state; S.overview = r.overview; S.requests = r.requests || 0;
    const alertsBefore = S.alerts?.length;
    S.alerts = r.alerts || []; S.alertDays = r.alert_days || 3; S.hours = r.hours || null;
    if (alertsBefore === undefined && S.alerts.length && can('manager')) toast(`${S.alerts.length} custom order${S.alerts.length === 1 ? ' has' : 's have'} waited more than ${S.alertDays} days.`, '', () => go('today'));
    if (reqBefore != null && S.requests > reqBefore) { toast('New custom order request from the website.', 'ok', () => { quoteFilter = 'requested'; go('quotes'); }); desk?.attention?.(); } S.store = r.store || { open: true }; S.fetchedAt = Date.now();
    if (before != null && r.overview?.today?.orders > before && !S.sale) { toast(`New order! ${r.overview.today.orders} today.`, 'ok', () => go('orders')); desk?.attention?.(); }
    paintClock(); paintMe(); paintBadges(); paintSys(r);
    if (Date.now() - (S.pingAt || 0) > 4 * 60e3) { S.pingAt = Date.now(); sb.rpc('presence_ping', { p_surface: 'aargon3', p_version: APP_VERSION }).then(() => {}, () => {}); }   // shows aARgon3 in your Apoji account
    if (Date.now() - (S.statusAt || 0) > 5 * 60e3) { S.statusAt = Date.now(); loadStatus(); }
  }
  // ---------- ⌘K: one search across aARgon3 (orders, custom orders, codes, deals, team) and Apoji (known issues, incidents, people, agents)
  function openSearch() {
    const KIND = { order: ['orders', 'Order'], quote: ['quotes', 'Custom order'], promo: ['promos', 'Code'], deal: ['sparkles', 'Deal'], staff: ['team', 'Team'],
      known_issue: ['warning', 'Known issue'], incident: ['bell', 'Incident'], person: ['profile', 'Person'], agent: ['sparkles', 'Agent'], space: ['team', 'Space'], space_message: ['mail', 'Space chat'] };
    const ACTIONS = [['New sale', 'sale', () => go('sale')], ...(can('manager') ? [['New promo code', 'promos', () => { promoTab = 'codes'; go('promos'); promoSheet({}); }],
      ['Code generator', 'sparkles', () => { promoTab = 'codes'; go('promos'); generatorSheet(); }], ['New deal', 'sparkles', () => { promoTab = 'deals'; go('promos'); dealSheet(); }],
      ['Deal generator', 'sparkles', () => { promoTab = 'deals'; go('promos'); dealGeneratorSheet(); }]] : []), ['Apoji status page', 'external', () => window.open(STATUS_URL, '_blank', 'noopener')]];
    let items = [], sel = 0, token = 0;
    sheet(`<div class="cmdk-in">${ic('search', 18)}<input id="kq" placeholder="Search orders, codes, people, known issues…" autocomplete="off" spellcheck="false"><kbd>esc</kbd></div>
      <div class="cmdk-list" id="kl"></div><div class="cmdk-foot">↑ ↓ move · ↵ open · aARgon3 and Apoji</div>`, (el, close) => {
      const q = el.querySelector('#kq'), list = el.querySelector('#kl');
      const paint = () => {
        let last = '';
        list.innerHTML = items.map((x, i) => `${x.group !== last ? `<div class="kg">${esc(last = x.group)}</div>` : ''}<button class="ki ${i === sel ? 'on' : ''}" data-i="${i}">${x.av || `<span class="kic">${ic(x.icon, 16)}</span>`}<span class="kt"><b>${esc(x.title)}</b>${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</span>${x.tag ? `<span class="kk">${esc(x.tag)}</span>` : ''}</button>`).join('')
          || `<div class="empty" style="padding:22px">${q.value.trim().length < 2 ? 'Type to search.' : 'Nothing found.'}</div>`;
        list.querySelectorAll('.ki').forEach(b => { b.onclick = () => run(+b.dataset.i); b.onmousemove = () => { if (sel !== +b.dataset.i) { sel = +b.dataset.i; list.querySelectorAll('.ki').forEach(x => x.classList.toggle('on', x === b)); } }; });
        list.querySelector('.ki.on')?.scrollIntoView({ block: 'nearest' });
      };
      const run = i => { const x = items[i]; if (!x) return; close(); x.run(); };
      const local = t => {
        const m = s => s.toLowerCase().includes(t.toLowerCase());
        return [...visible().filter(p => !t || m(p.label) || m(p.label2 || '')).map(p => ({ group: 'Go to', icon: p.icon, title: p.label2 && !can('manager') ? p.label2 : p.label, run: () => go(p.id) })),
          ...ACTIONS.filter(([l]) => t && m(l)).map(([l, icon, fn]) => ({ group: 'Do', icon, title: l, run: fn }))];
      };
      const fromA3 = r => ({ group: 'aARgon3', icon: KIND[r.kind]?.[0] || 'search', title: r.title, sub: r.sub, tag: KIND[r.kind]?.[1],
        av: r.avatar ? `<span class="kav"><img src="${esc(r.avatar)}" alt=""></span>` : r.user_id ? avatar(r.title, null, 'sm', r.user_id) : '',
        run: { order: () => orderSheet(r.id), quote: () => { go('quotes'); api('quote', { quote_no: r.id }).then(quoteView, e => toast(e.message, 'bad')); },
          promo: () => { promoTab = 'codes'; go('promos'); api('promos').then(l => { const x = l.find(y => y.id === r.id); if (x) promoSheet({}, x); }); },
          deal: () => { promoTab = 'deals'; go('promos'); api('deals').then(l => { const d = l.find(y => y.id === r.id); if (d) dealSheet({}, d); }); },
          staff: () => r.user_id ? apojiPersonSheet(r.user_id, r.title) : go('team') }[r.kind] || (() => {}) });
      const fromApoji = r => ({ group: 'Apoji', icon: KIND[r.kind]?.[0] || 'search', title: r.title, sub: r.sub, tag: KIND[r.kind]?.[1], av: r.kind === 'person' ? avatar(r.sub || r.title.slice(1), null, 'sm', r.id) : '',
        run: r.kind === 'known_issue' ? () => window.open(`${STATUS_URL}#known`, '_blank', 'noopener') : r.kind === 'incident' ? () => window.open(`${STATUS_URL}#incident-${r.id}`, '_blank', 'noopener')
          : r.kind === 'person' ? () => apojiPersonSheet(r.id, r.title) : () => toast('Open Nexus to see that.') });
      const search = async () => {
        const t = q.value.trim(), me = ++token;
        items = local(t); sel = 0; paint();
        if (t.length < 2) return;
        const [a3, nx] = await Promise.all([api('search', { q: t }).catch(() => []), sb.rpc('apoji_search', { p_q: t, p_limit: 12 }).then(r => r.error ? [] : r.data || [], () => [])]);
        if (me !== token || !document.body.contains(list)) return;
        items = [...local(t), ...(a3 || []).map(fromA3), ...(nx || []).filter(r => r.kind !== 'space_message').map(fromApoji)]; sel = 0; paint();
      };
      let t0; q.oninput = () => { clearTimeout(t0); t0 = setTimeout(search, 160); };
      q.onkeydown = e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
        else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
      };
      document.addEventListener('apoji:profiles', paint, { once: true });
      items = local(''); paint(); q.focus(); setTimeout(() => q.focus(), 30);
    }, 'cmdk');
  }
  // someone's Apoji profile card (from search, or a teammate)
  async function apojiPersonSheet(uid, name) {
    const close = sheet(`<div class="pcard" id="pc"><div class="empty"><span class="spin"></span></div></div><div class="acts"><button class="btn primary" data-close>Close</button></div>`);
    let p = APOJI.map.get(uid);
    if (!p) { try { const { data } = await sb.rpc('apoji_profiles', { p_ids: [uid] }); p = data?.[0]; if (p) APOJI.map.set(uid, p); } catch {} }
    const el = $('pc'); if (!el) return;
    el.innerHTML = p && window.NexusCosmetics ? window.NexusCosmetics.card({ ...apojiCard(p), online: p.presence && p.presence !== 'offline', self: uid === S.me.id }, { size: 'full' })
      : `<div class="empty">${esc(name || 'Someone')} hasn't set up a Nexus profile yet.</div>`;
    return close;
  }
  // ---------- Apoji status: incidents on the aARgon3 parts of the status page, and aARgon3's known issues (with the release that fixes them)
  const STATUS_URL = 'https://apojidelegraphics.github.io/Nexus-28/status/', A3_PARTS = ['aargon3_store', 'aargon3_terminal'];
  const relUrl = (rel, a3 = true) => { const v = String(rel || '').match(/(\d+\.\d+(?:\.\d+)?)/)?.[1]; if (!v) return null; const mine = a3 || /aargon/i.test(rel);
    return `https://github.com/apojidelegraphics/${mine ? 'aArgon3' : 'Nexus-28'}/releases/tag/v${v.split('.').length === 2 ? v + '.0' : v}`; };
  async function loadStatus() {
    const get = fn => sb.rpc(fn).then(r => r.error ? null : r.data, () => null);
    const [st, known, links] = await Promise.all([get('public_status'), get('public_known_issues'), get('public_status_links')]);
    if (!st && !known) return;
    const linkOf = id => (links || []).find(l => l.incident === id);
    S.apojiStatus = {
      active: (st?.active || []).filter(i => (i.components || []).some(c => A3_PARTS.includes(c))).map(i => ({ ...i, link: linkOf(i.id) })),
      parts: (st?.components || []).filter(c => A3_PARTS.includes(c.key)),
      known: (known || []).filter(k => (k.apps || []).includes('aargon3')),
    };
    paintStatus();
    if (S.page === 'today' && $('apojiStatus')) $('apojiStatus').outerHTML = statusCard();
  }
  function paintStatus() {
    const el = $('statusbar'), a = S.apojiStatus; if (!el || !a) return;
    el.innerHTML = a.active.map(i => {
      const last = (i.updates || [])[0], k = i.link?.known || [], rel = i.link?.release;
      return `<div class="sysmsg inc ${esc(i.severity)}">${ic('warning', 15)}<span><b>${esc(i.title)}</b> <span class="pill dim">${esc(i.status)}</span>${last?.body ? ` ${esc(last.body)}` : ''}
        ${k.filter(x => x.workaround).map(x => `<br><small>Workaround: ${esc(x.workaround)}</small>`).join('')}${rel ? ` <small>Fix: ${relUrl(rel, false) ? `<a href="${esc(relUrl(rel, false))}" target="_blank" rel="noopener">${esc(rel)}</a>` : esc(rel)}</small>` : ''}
        <a href="${STATUS_URL}#incident-${esc(i.id)}" target="_blank" rel="noopener">Status page</a></span></div>`;
    }).join('');
  }
  function statusCard() {
    const a = S.apojiStatus; if (!a) return '<div id="apojiStatus"></div>';
    const open = a.known.filter(k => !['fixed', 'wont_fix'].includes(k.status)), fixed = a.known.filter(k => k.status === 'fixed');
    const mine = v => v && vcmp(APP_VERSION, v) >= 0;
    const row = k => `<div class="kirow"><span class="pill ${k.status === 'fixed' ? 'ok' : k.severity === 'critical' ? 'bad' : 'warn'}">${esc(k.status.replace('_', ' '))}</span><div><b>${esc(k.title)}</b>
      ${k.workaround && k.status !== 'fixed' ? `<small>Workaround: ${esc(k.workaround)}</small>` : ''}${k.fixed_in ? `<small>Fixed in <a href="${esc(relUrl(k.fixed_in))}" target="_blank" rel="noopener">${esc(k.fixed_in)}</a>${mine(k.fixed_in) ? ' · you have it ✓' : ' · update to get it'}</small>` : ''}</div></div>`;
    const bad = a.parts.filter(p => p.status !== 'operational');
    return `<div class="card" id="apojiStatus"><h3>aARgon3 status<small><a href="${STATUS_URL}" target="_blank" rel="noopener">Status page</a></small></h3>
      <div class="partline">${a.parts.map(p => `<span><i class="dot s-${esc(p.status)}"></i>${esc(p.label)}</span>`).join('') || '<span class="muted">Status page parts for aARgon3 aren\'t set up yet.</span>'}</div>
      ${open.length ? `<div class="kilist">${open.map(row).join('')}</div>` : `<p class="muted" style="margin:8px 0 0">${bad.length ? '' : 'Everything is working. '}No known issues in aARgon3.</p>`}
      ${fixed.length ? `<details style="margin-top:8px"><summary class="muted">${fixed.length} fixed recently</summary><div class="kilist">${fixed.map(row).join('')}</div></details>` : ''}</div>`;
  }
  // the server functions or the database are older than this terminal: say so, with the fix, instead of odd errors later
  function paintSys(r = S.sys) {
    if (r) S.sys = r;
    const el = $('sysbar'); if (!el || !r) return;
    const msgs = [];
    if (can('manager') && vcmp(r.server, APP_VERSION) < 0) msgs.push(`aARgon3's server is ${r.server ? `on ${esc(r.server)}` : 'older'}, this terminal is ${APP_VERSION}. Some buttons won't work until the functions are deployed again (README → Deploy).`);
    else if (can('owner') && r.server && vcmp(r.db, NEED_DB) < 0) msgs.push(`The database needs an update: run <b>supabase/aargon3-${NEED_DB.replace(/\.0$/, '')}.sql</b> in Supabase → SQL Editor.`);
    el.innerHTML = msgs.map(m => `<div class="sysmsg">${ic('warning', 15)}<span>${m}</span></div>`).join('');
  }
  const shift = () => S.state?.shift || null;
  const workedNow = () => { const s = shift(); if (!s) return 0; return s.minutes + (s.on_break ? 0 : (Date.now() - S.fetchedAt) / 60e3); };
  const breakNow = () => { const s = shift(); const b = s?.breaks?.find(x => !x.end); return b ? (Date.now() - new Date(b.start)) / 60e3 : 0; };
  const free = () => !!S.me?.owner;   // the owner never has to clock in (but can, and can be scheduled)
  const myStore = () => shift()?.store_code || S.me?.default_store || S.state?.last_store;
  const can = role => ({ employee: 1, manager: 2, owner: 3 }[S.me?.role] || 1) >= ({ employee: 1, manager: 2, owner: 3 }[role]);

  // ================================================================ sign in
  function signIn(msg = '') {
    clearInterval(S.saleTimer); S.me = null;
    $('app').innerHTML = `<div class="login"><form class="card" id="f">
      <img class="logo" src="../icons/icon-192.png" alt="">
      <h1>aARgon3 Terminal</h1><p>Staff sign in with your Nexus account. Only Apoji staff can get in.</p>
      <input class="field" id="em" type="email" placeholder="Email" autocomplete="username" required>
      <input class="field" id="pw" type="password" placeholder="Password" autocomplete="current-password" required>
      <button class="btn primary block" id="go">${ic('login')} Sign in</button>
      <div class="err" id="er">${esc(msg)}</div>
      <div class="fine">Not staff? <a href="${desk ? 'https://apojidelegraphics.github.io/aArgon3/' : '../'}">Visit the aARgon3 store</a></div></form></div>`;
    $('em').focus();
    $('f').onsubmit = async e => {
      e.preventDefault(); $('er').textContent = '';
      const btn = $('go'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Signing in…';
      const { error } = await sb.auth.signInWithPassword({ email: $('em').value.trim(), password: $('pw').value });
      if (error) { $('er').textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message; btn.disabled = false; btn.innerHTML = `${ic('login')} Sign in`; return; }
      start();
    };
  }
  async function signOut() {
    if (shift() && !(await confirmSheet('Sign out while clocked in?', "You'll stay on the clock. Clock out first if you're done for the day.", 'Sign out anyway'))) return;
    await sb.auth.signOut(); history.replaceState(null, '', '#'); signIn();
  }

  // ================================================================ shell
  const PAGES = [
    { id: 'today', icon: 'today', label: 'Today', group: '' }, { id: 'sale', icon: 'sale', label: 'New sale', short: 'Sell', group: '' },
    { id: 'orders', icon: 'orders', label: 'Orders', group: '' }, { id: 'catalog', icon: 'catalog', label: 'Catalog', group: '' },
    { id: 'schedule', icon: 'schedule', label: 'Schedule', group: 'YOUR WORK' }, { id: 'time', icon: 'time', label: 'Timesheet', group: 'YOUR WORK' },
    { id: 'sales', icon: 'sales', label: 'Sales', group: 'YOUR WORK', label2: 'My sales' }, { id: 'points', icon: 'star', label: 'Points', group: 'YOUR WORK', label2: 'My points' },
    { id: 'profile', icon: 'profile', label: 'Profile', group: 'YOUR WORK' },
    { id: 'quotes', icon: 'quotes', label: 'Custom orders', group: 'MANAGER', role: 'manager' }, { id: 'promos', icon: 'promos', label: 'Promotions', group: 'MANAGER', role: 'manager' },
    { id: 'team', icon: 'team', label: 'Team', group: 'MANAGER', role: 'manager' }, { id: 'activity', icon: 'activity', label: 'Activity', group: 'MANAGER', role: 'manager' },
    { id: 'settings', icon: 'settings', label: 'Settings', group: 'OWNER', role: 'owner' }];
  const visible = () => PAGES.filter(p => !p.role || can(p.role));
  function shell() {
    let last = null;
    $('app').innerHTML = `<div class="shell">
      <aside class="side"><div class="brand"><img src="../icons/icon-192.png" alt=""><div>AARGON3<small>TERMINAL</small></div></div>
        ${visible().map((p, i) => { const g = p.group !== last ? (last = p.group, p.group ? `<div class="sect">${p.group}</div>` : '') : '';
          return `${g}<button class="nav" data-p="${p.id}" title="${esc(p.label)}">${ic(p.icon)}<span class="lbl">${esc(p.label2 && !can('manager') ? p.label2 : p.label)}</span><span class="badge" data-badge="${p.id}" hidden></span>${i < 9 ? `<kbd>${MOD}${i + 1}</kbd>` : ''}</button>`; }).join('')}
        <div class="sp"></div><div class="me" id="me"></div></aside>
      <main class="main"><header class="top"><img class="mlogo" src="../icons/icon-192.png" alt=""><h2 id="title"></h2><span class="sp"></span><button class="searchbtn" id="sbtn" title="Search (${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'}K)">${ic('search', 16)}<span>Search</span><kbd>${/Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd></button><div class="clock" id="clock"></div></header><div id="sysbar"></div><div id="statusbar"></div><div id="page"></div></main>
      <nav class="tabs">${TABS.map(id => { const p = PAGES.find(x => x.id === id); return `<button class="tab" data-p="${id}">${ic(p.icon, 20)}<span>${esc(p.short || p.label)}</span><span class="badge" data-badge="${id}" hidden></span></button>`; }).join('')}
        <button class="tab" id="more">${ic('menu', 20)}<span>More</span><span class="badge" data-badge="more" hidden></span></button></nav></div>`;
    paintSys(); paintStatus();
    $('sbtn').onclick = openSearch;
    document.querySelectorAll('.nav, .tab[data-p]').forEach(b => b.onclick = () => go(b.dataset.p));
    $('more').onclick = moreSheet;
    new MutationObserver(() => labelTables($('page'))).observe($('page'), { childList: true, subtree: true });
    paintMe(); paintClock(); paintBadges();
  }
  // phones: a bottom tab bar with the everyday pages; everything else is under More
  const TABS = ['today', 'sale', 'orders', 'schedule'];
  function moreSheet() {
    let last = null;
    sheet(`<div class="more-head">${avatar(S.me.name, S.me.color, '', S.me.id)}<div><b>${esc(S.me.name)}</b><small>${S.me.owner ? 'Owner' : roleName(S.me.role)} · ${esc(S.me.email || '')}</small></div></div>
      ${visible().filter(p => !TABS.includes(p.id)).map(p => { const g = p.group !== last ? (last = p.group, `${p.group ? `<div class="sect">${p.group}</div>` : ''}`) : '';
        return `${g}<button class="nav ${S.page === p.id ? 'on' : ''}" data-p="${p.id}">${ic(p.icon)}<span class="lbl">${esc(p.label2 && !can('manager') ? p.label2 : p.label)}</span><span class="badge" data-badge="${p.id}" hidden></span></button>`; }).join('')}
      <button class="nav" id="mso">${ic('power')}<span class="lbl">Sign out</span></button>`,
      (el, close) => { el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { close(); go(b.dataset.p); }); el.querySelector('#mso').onclick = () => { close(); signOut(); }; }, 'more-sheet');
  }
  // tables become stacked cards on phones; each cell is labelled with its column name
  function labelTables(root) {
    root?.querySelectorAll('table.tbl').forEach(t => {
      const hs = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
      t.querySelectorAll('tbody tr').forEach(tr => { let i = 0; for (const td of tr.children) { if (!td.hasAttribute('data-label')) td.setAttribute('data-label', td.colSpan > 1 ? '' : hs[i] || ''); i += td.colSpan || 1; } });
    });
  }
  function paintMe() {
    if (!$('me') || !S.me) return;
    $('me').innerHTML = `${avatar(S.me.name, S.me.color, '', S.me.id)}<div><b>${esc(S.me.name)}</b><small>${S.me.owner ? `${ic('crown', 11)} Owner` : roleName(S.me.role)}</small></div><button class="btn quiet small out" id="so" title="Sign out">${ic('power', 16)}</button>`;
    $('me').onclick = e => { if (!e.target.closest('#so')) go('profile'); };
    $('so').onclick = signOut;
  }
  function paintBadges() {
    const n = { schedule: can('manager') ? S.state?.pending_time_off || 0 : 0, quotes: can('manager') ? S.requests || 0 : 0 };
    n.more = Object.entries(n).filter(([k]) => !TABS.includes(k)).reduce((m, [, v]) => m + v, 0);
    document.querySelectorAll('[data-badge]').forEach(x => { const v = n[x.dataset.badge] || 0; x.hidden = !v; x.textContent = v; });
  }
  function go(page) {
    const p = visible().find(x => x.id === page) || PAGES[0];
    S.page = p.id; if (location.hash !== '#' + p.id) history.replaceState(null, '', '#' + p.id);
    document.querySelectorAll('.nav, .tab[data-p]').forEach(b => b.classList.toggle('on', b.dataset.p === p.id));
    $('more')?.classList.toggle('on', !TABS.includes(p.id));
    $('title').textContent = p.label2 && !can('manager') ? p.label2 : p.label;
    $('page').innerHTML = '<div class="wrap" id="pg"></div>'; $('page').scrollTop = 0;
    ({ today: pageToday, sale: pageSale, orders: pageOrders, catalog: pageCatalog, schedule: pageSchedule, time: pageTime, sales: pageSales, profile: pageProfile,
       points: pagePoints, quotes: pageQuotes, promos: pagePromos, team: pageTeam, activity: pageActivity, settings: pageSettings })[p.id]();
  }

  // ================================================================ the clock (top bar)
  function paintClock() {
    const el = $('clock'); if (!el) return;
    const s = shift();
    if (!s && free()) {
      el.className = 'clock owner';
      el.innerHTML = `<span class="dot"></span><div class="what" title="The owner doesn't need to clock in"><span class="l">OWNER<span class="hide-sm"> · NO CLOCK NEEDED</span></span><b>${hm(S.state?.week_minutes || 0)} <small>this week</small></b></div><button class="btn quiet small" id="cin" title="Optional: log hours for a scheduled shift">${ic('login', 15)} <span class="hide-sm">Clock in</span></button>`;
      $('cin').onclick = () => clockInSheet();
    } else if (!s) {
      el.className = 'clock';
      el.innerHTML = `<span class="dot"></span><div class="what" title="Your hours this week"><span class="l">OFF THE CLOCK</span><b>${hm(S.state?.week_minutes || 0)}</b></div><button class="btn primary small" id="cin">${ic('login', 15)} <span class="hide-sm">Clock in</span></button>`;
      $('cin').onclick = () => clockInSheet();
    } else if (s.on_break) {
      el.className = 'clock brk';
      el.innerHTML = `<span class="dot"></span><div class="what"><span class="l">ON BREAK</span><b id="tick">${clockText(breakNow())}</b></div><button class="btn primary small" id="bk">End break</button>`;
      $('bk').onclick = e => doBreak(false, e.target);
    } else {
      el.className = 'clock on';
      el.innerHTML = `<span class="dot"></span><div class="what" title="${esc(s.store)}"><span class="l">ON THE CLOCK · #${esc(s.store_code)}${s.late_minutes ? ` · <span style="color:var(--amber)">${s.late_minutes}m late</span>` : ''}</span><b id="tick">${clockText(workedNow())}</b></div>
        <button class="btn small" id="bk">${ic('coffee', 15)} <span class="hide-sm">Break</span></button><button class="btn small danger" id="cout">${ic('logout', 15)} <span class="hide-sm">Clock out</span></button>`;
      $('bk').onclick = e => doBreak(true, e.target);
      $('cout').onclick = () => clockOutSheet();
    }
  }
  setInterval(() => { const t = $('tick'); if (t && shift()) t.textContent = clockText(shift().on_break ? breakNow() : workedNow()); }, 15e3);
  const nextShift = () => (S.state?.upcoming || [])[0] || null;
  const scheduledNow = () => { const n = nextShift(); return n && new Date(n.starts_at) - Date.now() < 3 * 3600e3 ? n : null; };
  function clockInSheet() {
    const sch = scheduledNow();
    sheet(`<div class="kicker">Clock in</div><h3>Start your shift</h3>
      ${sch ? `<div class="banner info" style="margin:10px 0 0">${ic('schedule')}<div><b>You're scheduled ${fmtTime(sch.starts_at)}–${fmtTime(sch.ends_at)}</b>${sch.store_code ? ` at #${esc(sch.store_code)}` : ''}${sch.note ? ` · ${esc(sch.note)}` : ''}</div></div>` : '<p class="muted">Pick where you\'re working. It remembers your store.</p>'}
      <label class="lbl">Store</label><select class="field" id="store">${storeOptions(sch?.store_code || S.state?.last_store)}</select>
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">${ic('login', 15)} Clock in now</button></div>`,
      (el, close) => { el.querySelector('#ok').onclick = e => clockIn(el.querySelector('#store').value, e.target).then(close, () => {}); });
  }
  async function clockIn(store, btn) {
    const r = await busy(btn, () => api('clock_in', { store }));
    await refresh(); toast(r.late_minutes ? `Clocked in, ${r.late_minutes} minutes after your shift started.` : `Clocked in at ${fmtTime(new Date())}. Have a good shift!`, r.late_minutes ? '' : 'ok'); go(S.page);
  }
  function clockOutSheet() {
    const s = shift(), brk = (s.breaks || []).reduce((m, b) => m + ((b.end ? new Date(b.end) : new Date()) - new Date(b.start)) / 60e3, 0);
    sheet(`<div class="kicker">Clock out</div><h3>Done for now?</h3>
      <div class="kv"><span>Clocked in</span><span>${fmtWhen(s.clock_in)} · #${esc(s.store_code)}</span>${s.scheduled ? `<span>Scheduled</span><span>${fmtTime(s.scheduled.starts_at)}–${fmtTime(s.scheduled.ends_at)}</span>` : ''}
        <span>Worked</span><span><b>${hm(workedNow())}</b>${brk >= 1 ? ` <span class="muted">(${hm(brk)} on break)</span>` : ''}</span>
        <span>Sales this shift</span><span>${s.orders} · ${money(Number(s.sales) || 0)}</span></div>
      <label class="lbl">Note (optional)</label><input class="field" id="note" placeholder="Anything your manager should know">
      <div class="acts"><button class="btn quiet" data-close>Keep working</button><button class="btn danger" id="ok">${ic('logout', 15)} Clock out</button></div>`,
      (el, close) => { el.querySelector('#ok').onclick = e => clockOut({ note: el.querySelector('#note').value }, e.target).then(close, () => {}); });
  }
  async function clockOut(body, btn) {
    const r = await busy(btn, () => api('clock_out', body));
    await refresh(); toast(`Clocked out. You worked ${hm(r.minutes)}.`, 'ok'); go(S.page);
  }
  async function doBreak(on, btn) { await busy(btn, () => api('break', { on })); await refresh(); toast(on ? 'Break started. Enjoy!' : 'Welcome back.'); }
  const gate = (title, text) => `<div class="card gate"><div><div class="kicker">Off the clock</div><h3>${esc(title)}</h3><p>${esc(text)}</p>
      <label class="lbl">Store</label><select class="field" id="gstore">${storeOptions(scheduledNow()?.store_code || S.state?.last_store)}</select></div><button class="btn primary" id="gin">${ic('login', 15)} Clock in</button></div>`;
  const wireGate = () => $('gin') && ($('gin').onclick = e => clockIn($('gstore').value, e.target));

  // ================================================================ Today
  function pageToday() {
    const s = shift(), o = S.overview || {}, pg = $('pg'), n = nextShift();
    const long = s && (Date.now() - new Date(s.clock_in)) > 12 * 3600e3;
    const week = o.week || [], max = Math.max(1, ...week.map(d => Number(d.revenue) || 0));
    pg.innerHTML = `
      ${S.store.open === false ? `<div class="banner">${ic('warning')}<div><b>The online store is closed.</b> ${esc(S.store.message || '')}</div>${can('owner') && !S.store.closure ? '<span style="flex:1"></span><button class="btn small" id="openStore">Open it</button>' : ''}</div>` : ''}
      ${(() => { const code = s?.store_code || myStore(), n = code && storeNow(code); return n && n.open === false && n.reason ? `<div class="banner">${ic('store')}<div><b>Store #${esc(code)} is closed today</b>: ${esc(n.reason)}.</div></div>` : n && n.open && n.closes ? `<div class="hoursline">${ic('store', 14)} #${esc(code)} is open until ${t12(n.closes)} today.</div>` : ''; })()}
      ${can('manager') && S.alerts?.length ? `<div class="card alerts"><h3>${ic('warning')} Waiting too long <small>more than ${S.alertDays} day${S.alertDays === 1 ? '' : 's'}</small></h3>
        ${S.alerts.slice(0, 6).map(a => `<button class="arow" data-q="${esc(a.quote_no)}"><span class="mono">${esc(a.quote_no)}</span><span>${a.enterprise ? '<span class="pill vio">ENTERPRISE</span> ' : ''}${esc(a.company || C.plans[a.plan]?.name || '')}</span><span class="muted">${esc(a.status)} · ${a.days} days</span></button>`).join('')}
        ${S.alerts.length > 6 ? `<p class="muted" style="margin:6px 0 0;font-size:13px">and ${S.alerts.length - 6} more in Custom orders.</p>` : ''}</div>` : ''}
      ${long ? `<div class="banner"><div><b>Forgot to clock out?</b> You've been clocked in since ${fmtWhen(s.clock_in)}.</div>
        <span style="flex:1"></span><span class="muted">I left at</span><input class="field" type="datetime-local" id="leftAt" value="${localInput(Math.min(Date.now(), new Date(s.clock_in).getTime() + 8 * 3600e3))}">
        <button class="btn small" id="fix">Clock out at that time</button></div>` : ''}
      ${!s && !free() ? gate('Clock in to start selling', `Hi ${S.me.name}. You've worked ${hm(S.state?.week_minutes || 0)} this week.${n ? ` Next shift: ${fmtDay(n.starts_at)} ${fmtTime(n.starts_at)}–${fmtTime(n.ends_at)}.` : ''}`) : ''}
      <div class="stats">
        <div class="card stat"><div class="k">Sales today</div><div class="v">${money(Number(o.today?.revenue) || 0)}</div><div class="s">${o.today?.orders || 0} order${o.today?.orders === 1 ? '' : 's'}</div></div>
        <div class="card stat"><div class="k">Active subscriptions</div><div class="v">${o.active_subscriptions || 0}</div><div class="s">paying through Stripe</div></div>
        ${s || !free() ? `<div class="card stat"><div class="k">This shift</div><div class="v">${s ? hm(workedNow()) : '—'}</div><div class="s">${s ? `${s.orders} sale${s.orders === 1 ? '' : 's'} · ${money(Number(s.sales) || 0)}` : 'not clocked in'}</div></div>`
          : `<div class="card stat"><div class="k">On the clock</div><div class="v">${(o.on_clock || []).length}</div><div class="s">${(o.on_clock || []).length === 1 ? 'person' : 'people'} working now</div></div>`}
        ${free() && !s ? `<div class="card stat"><div class="k">Last 7 days</div><div class="v">${money(week.reduce((m, d) => m + (Number(d.revenue) || 0), 0))}</div><div class="s">${week.reduce((m, d) => m + (Number(d.orders) || 0), 0)} orders</div></div>`
          : `<div class="card stat"><div class="k">Your week</div><div class="v">${hm((S.state?.week_minutes || 0) + (s && !s.on_break ? (Date.now() - S.fetchedAt) / 60e3 : 0))}</div><div class="s">since Monday</div></div>`}
      </div>
      <div class="cols">
        <div class="card"><h3>Last 7 days<small>sales</small></h3><div class="bars">${week.map((d, i) => `<div class="b ${i === week.length - 1 ? 'today' : ''}" title="${esc(d.day)}: ${d.orders} orders"><span class="amt">${Number(d.revenue) ? big(d.revenue) : ''}</span><div class="bar" style="height:${Math.round((Number(d.revenue) || 0) / max * 130)}px"></div><span class="lab">${new Date(d.day + 'T12:00').toLocaleDateString([], { weekday: 'short' })}</span></div>`).join('')}</div></div>
        <div class="card"><h3>On the clock now<small>${(o.on_clock || []).length}</small></h3><div class="people">${(o.on_clock || []).map(p => `<div class="person">${avatar(p.name, null, '', p.user_id)}<div><b>${esc(p.name)}</b><small>#${esc(p.store_code)} · since ${fmtTime(p.clock_in)}${p.late_minutes ? ` · ${p.late_minutes}m late` : ''}</small></div><div class="r">${p.on_break ? '<span class="pill warn">BREAK</span>' : hm(p.minutes)}</div></div>`).join('') || '<div class="empty" style="padding:20px">Nobody yet.</div>'}</div>
          ${s || free() ? `<button class="btn primary block" id="newsale" style="margin-top:14px">${ic('sale', 16)} New sale</button>` : ''}</div>
      </div>
      <div class="${free() ? 'grid2' : 'grid3'}" style="margin-top:12px">
        ${!free() ? `<div class="card ptsmini" id="ptsmini"><h3>${ic('star')} Your points</h3><div class="empty"><span class="spin"></span></div></div>` : ''}
        <div class="card"><h3>Your next shifts</h3>${(S.state?.upcoming || []).length ? `<div class="people">${S.state.upcoming.map(u => `<div class="person"><div class="av" style="background:var(--panel2);color:var(--accent)">${ic('schedule', 15)}</div><div><b>${fmtDay(u.starts_at)}</b><small>${fmtTime(u.starts_at)}–${fmtTime(u.ends_at)}${u.store_code ? ` · #${esc(u.store_code)}` : ''}${u.note ? ` · ${esc(u.note)}` : ''}</small></div></div>`).join('')}</div>` : '<p class="muted" style="margin:0">Nothing scheduled. <a href="#schedule" id="toSched">See the schedule</a></p>'}</div>
        <div class="card"><h3>Quick links</h3><div class="row">
          <button class="btn small" data-go="orders">${ic('search', 15)} Find an order</button><button class="btn small" data-go="catalog">${ic('catalog', 15)} What's in each plan</button>
          ${can('manager') ? `<button class="btn small" data-go="quotes">${ic('quotes', 15)} Custom order</button><button class="btn small" data-go="team">${ic('team', 15)} Team</button>` : `<button class="btn small" id="reqOff">${ic('calendarx', 15)} Ask for time off</button>`}
          ${can('manager') && S.state?.pending_time_off ? `<button class="btn small" data-go="schedule">${ic('bell', 15)} ${S.state.pending_time_off} time-off request${S.state.pending_time_off === 1 ? '' : 's'}</button>` : ''}</div></div>
      </div>`;
    wireGate();
    pg.querySelectorAll('.arow').forEach(b => b.onclick = async () => { go('quotes'); try { quoteView(await api('quote', { quote_no: b.dataset.q })); } catch (e) { toast(e.message, 'bad'); } });
    if ($('ptsmini')) api('points', { mine: true }).then(r => { const el = $('ptsmini'); if (!el) return;
      el.innerHTML = `<h3>${ic('star')} Your points</h3><div class="ptsbig ${r.mine.total < 0 ? 'neg' : ''}">${r.mine.total}</div><div class="muted" style="font-size:13px">${r.mine.month >= 0 ? '+' : ''}${r.mine.month} this month</div>
        ${r.history[0] ? `<div class="ptlast">${ptRow(r.history[0], true)}</div>` : ''}<button class="btn small quiet" data-go="points" style="margin-top:8px">See all ${ic('right', 14)}</button>`;
      el.querySelector('[data-go]').onclick = () => go('points'); }).catch(() => { const el = $('ptsmini'); if (el) el.innerHTML = `<h3>${ic('star')} Your points</h3><p class="muted" style="margin:0">Points start after the 2.3 update.</p>`; });
    pg.insertAdjacentHTML('beforeend', statusCard());   // 2.6: aARgon3 on the Apoji status page
    $('newsale') && ($('newsale').onclick = () => go('sale'));
    $('fix') && ($('fix').onclick = e => clockOut({ at: new Date($('leftAt').value).toISOString(), note: 'Forgot to clock out' }, e.target));
    $('openStore') && ($('openStore').onclick = e => busy(e.target, async () => { await api('settings_save', { key: 'store', value: { open: true, message: '' } }); await refresh(); go('today'); toast('The store is open.', 'ok'); }).catch(() => {}));
    $('reqOff') && ($('reqOff').onclick = timeOffSheet);
    $('toSched') && ($('toSched').onclick = e => { e.preventDefault(); go('schedule'); });
    pg.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  }

  // ================================================================ New sale
  const draft = { plan: 'personal', tier: 'pro', billing: 'month', os: C.os[0].id, connection: C.connections[0].id, customer: {}, promo: null };
  function pageSale() {
    const pg = $('pg');
    if (S.sale) return paintPayment();
    if (!shift() && !free()) { pg.innerHTML = gate('Clock in first', 'Sales are tracked on your shift.'); return wireGate(); }
    if (C.plans[draft.plan].quote) draft.plan = 'personal';
    pg.innerHTML = `<div class="sale">
      <div class="card">
        <div class="row" style="justify-content:space-between"><div class="seg" id="pseg">${PLANS.filter(p => !C.plans[p].quote).map(p => `<button data-v="${p}" class="${p === draft.plan ? 'on' : ''}">${esc(C.plans[p].name)}</button>`).join('')}</div>
          <div class="seg" id="bseg"><button data-v="month" class="${draft.billing === 'month' ? 'on' : ''}">Monthly</button><button data-v="year" class="${draft.billing === 'year' ? 'on' : ''}">Yearly</button></div></div>
        <label class="lbl">Tier</label><div class="tierpick" id="tp"></div>
        <div class="two"><div><label class="lbl">LentOS</label><select class="field" id="os">${C.os.map(o => `<option ${o.id === draft.os ? 'selected' : ''}>${esc(o.id)}</option>`).join('')}</select></div>
          <div><label class="lbl">Connection</label><select class="field" id="conn">${C.connections.map(o => `<option ${o.id === draft.connection ? 'selected' : ''}>${esc(o.id)}</option>`).join('')}</select></div></div>
        <div class="sect-title">${draft.plan === 'personal' ? 'Customer' : 'Business and the person placing the order'}</div>
        <div id="cust">${window.A3forms.html(draft.plan, draft.customer)}</div>
        <label class="lbl">Promo code <span style="opacity:.6">(optional)</span></label>
        <div class="promo-row"><input class="field" id="promo" placeholder="CODE" value="${esc(draft.promo?.code || '')}" maxlength="30"><button class="btn small" id="apply">Apply</button><button class="btn small quiet" id="find">${ic('search', 15)} Find a code</button></div>
        <div class="finder" id="finder" hidden></div><div class="promo-ok" id="promoOk">${draft.promo ? `✓ ${esc(draft.promo.label)}` : ''}</div>
        <p class="muted" style="font-size:13px;margin:14px 0 0">Enterprise, custom prices and invoices: ${can('manager') ? '<a href="#quotes" id="toQuotes">Custom orders</a>' : 'ask a manager (Custom orders)'}.</p>
      </div>
      <div class="card summary" id="sum"></div></div>`;
    const keep = () => { draft.customer = window.A3forms.values($('cust')); };
    const seg = (id, key) => $(id).querySelectorAll('button').forEach(b => b.onclick = () => { keep(); draft[key] = b.dataset.v; draft.promo = null; pageSale(); });
    seg('pseg', 'plan'); seg('bseg', 'billing');
    $('os').onchange = e => { draft.os = e.target.value; paintSum(); };
    $('conn').onchange = e => { draft.connection = e.target.value; paintSum(); };
    $('cust').oninput = keep;
    window.A3forms.wire($('cust'), { os: () => draft.os, region: () => storeRegion(myStore()) });
    $('promo').oninput = () => { if (draft.promo) { draft.promo = null; $('promoOk').textContent = ''; paintSum(); } };
    $('apply').onclick = e => busy(e.target, async () => {
      const code = $('promo').value.trim(); if (!code) return;
      draft.promo = await api('promo_check', { code, plan: draft.plan, tier: draft.tier, billing: draft.billing });
      $('promoOk').textContent = `✓ ${draft.promo.code}: ${draft.promo.label}`; paintSum();
    }).catch(() => { draft.promo = null; paintSum(); });
    $('toQuotes') && ($('toQuotes').onclick = e => { e.preventDefault(); go('quotes'); });
    $('find').onclick = () => { $('finder').hidden = !$('finder').hidden; if (!$('finder').hidden) paintFinder(); };
    paintTiers();
  }
  // codes that fit what's picked (and ones that almost do), each with copy and use; plus the deals this sale gets on its own
  let dealsKey = '';
  function loadDeals() {
    const key = `${draft.plan}/${draft.tier}/${draft.billing}`;
    if (key === dealsKey && draft.auto) return;
    dealsKey = key; draft.auto = null;
    api('promo_list', { plan: draft.plan, tier: draft.tier, billing: draft.billing }).then(r => {
      if (dealsKey !== key) return;
      draft.auto = r; if ($('sum')) paintSum(); if ($('finder') && !$('finder').hidden) paintFinder();
    }).catch(() => {});
  }
  function paintFinder() {
    const el = $('finder'), r = draft.auto;
    if (!r) { el.innerHTML = '<div class="muted" style="padding:10px"><span class="spin"></span> Looking…</div>'; loadDeals(); return; }
    const fit = r.codes.filter(c => c.fits), not = r.codes.filter(c => !c.fits);
    el.innerHTML = `${r.deals.length ? `<div class="fdeal">${ic('sparkles', 15)} <span>Already included: ${r.deals.map(d => `<b>${esc(d.headline)}</b>`).join(', ')}${r.deals.some(d => ['percent', 'amount'].includes(d.kind)) ? '. A code replaces the price deal (one discount per sale).' : '.'}</span></div>` : ''}
      ${fit.map(c => `<div class="fcode"><span class="codecell"><b class="mono">${esc(c.code)}</b><button class="cp" data-copy="${esc(c.code)}" title="Copy">${ic('copy', 14)}</button></span>
        <span class="fd">${esc(c.label)}${c.ends ? ` · ends ${fmtDate(c.ends)}` : ''}${c.left != null ? ` · ${c.left} left` : ''}</span><span class="fa">${money(c.after)}</span><button class="btn small" data-use="${esc(c.code)}">Use</button></div>`).join('')
        || '<div class="muted" style="padding:8px 10px">No codes fit this plan right now.</div>'}
      ${not.length ? `<details><summary>${not.length} code${not.length === 1 ? '' : 's'} that don't fit this plan</summary>${not.map(c => `<div class="fcode off"><span class="codecell"><b class="mono">${esc(c.code)}</b><button class="cp" data-copy="${esc(c.code)}" title="Copy">${ic('copy', 14)}</button></span><span class="fd">${esc(c.label)}</span><span class="muted">${esc(c.why)}</span></div>`).join('')}</details>` : ''}`;
    el.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy, `Copied ${b.dataset.copy}`));
    el.querySelectorAll('[data-use]').forEach(b => b.onclick = () => { $('promo').value = b.dataset.use; $('apply').click(); $('finder').hidden = true; });
  }
  function paintTiers() {
    $('tp').innerHTML = TIERS.map(t => { const p = price(draft.plan, t, draft.billing);
      return `<button class="tp ${t === draft.tier ? 'on' : ''}" data-t="${t}"><b>${esc(C.tiers[t].name)}</b><div class="pr">${money(p.amount)}<span class="muted" style="font-size:12px;font-weight:500">/${p.interval === 'year' ? 'yr' : 'mo'}</span></div><small>${p.seats === 1 ? '1 person' : `${p.seats} people`} · ${esc(C.tiers[t].chip)}</small></button>`; }).join('');
    $('tp').querySelectorAll('.tp').forEach(b => b.onclick = () => { draft.tier = b.dataset.t; if (draft.promo) { draft.promo = null; $('promoOk').textContent = 'Tier changed: apply the code again.'; } paintTiers(); if (!$('finder').hidden) paintFinder(); });
    loadDeals(); paintSum();
  }
  function paintSum() {
    const p = price(draft.plan, draft.tier, draft.billing), t = C.tiers[draft.tier], per = p.interval === 'year' ? 'yr' : 'mo';
    const a = draft.auto && `${draft.plan}/${draft.tier}/${draft.billing}` === dealsKey ? draft.auto : null;
    const priceDeal = !draft.promo && a?.deals.find(d => ['percent', 'amount'].includes(d.kind));
    const total = draft.promo ? draft.promo.after : priceDeal ? a.after : p.amount;
    $('sum').innerHTML = `<h3>${esc(C.plans[draft.plan].name)} · ${esc(t.name)}</h3>
      ${a?.deals.length ? `<div class="dealtags">${a.deals.map(d => `<span class="pill vio" title="${esc(d.description || '')}">${ic('sparkles', 12)} ${esc(d.headline)}</span>`).join('')}</div>` : ''}
      <div class="line"><span>People</span><span>${p.seats != null && a?.seats ? `${p.seats + a.seats} <span class="muted">(+${a.seats} deal)</span>` : p.seats}</span></div>
      <div class="line"><span>Chip</span><span>${a?.chip ? `${esc(a.chip)} <span class="muted">(deal)</span>` : esc(t.chip)}</span></div>
      <div class="line"><span>Models</span><span>${t.families.map(f => esc(C.families[f].name)).join(' + ')}${a?.models.length ? ` <b style="color:var(--violet)">+ ${a.models.map(esc).join(', ')}</b>` : ''}</span></div>
      <div class="line"><span>LentOS</span><span>${esc(draft.os)}</span></div><div class="line"><span>Connection</span><span>${esc(draft.connection.replace(/ \(.*\)/, ''))}</span></div>
      <div class="line"><span>Billing</span><span>${p.interval === 'year' ? 'Yearly' : 'Monthly'}</span></div>
      ${draft.promo ? `<div class="line"><span>${esc(draft.promo.code)}</span><span style="color:var(--mint)">−${money(p.amount - draft.promo.after)}</span></div>` : ''}
      ${priceDeal ? `<div class="line"><span>Deal</span><span style="color:var(--mint)">−${money(a.saving)}</span></div>` : ''}
      <div class="total"><span class="muted">Total</span><b>${money(total)}<span class="muted" style="font-size:14px;font-weight:500">/${per}</span></b></div>
      <button class="btn primary block" id="mk">${ic('qr', 16)} Create payment link</button>
      ${can('manager') ? `<button class="btn quiet block" id="comp" style="margin-top:8px">${ic('gift', 15)} Give it free (comp)…</button>` : ''}
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">The customer pays on their phone (QR code) or on this screen. The order is created the moment Stripe confirms.</p>`;
    $('mk').onclick = e => {
      let customer; try { customer = window.A3forms.read($('cust'), draft.plan); } catch (err) { return toast(err.message, 'bad'); }
      busy(e.target, async () => {
        const r = await api('sale', { plan: draft.plan, tier: draft.tier, billing: draft.billing, os: draft.os, connection: draft.connection, customer, promo: draft.promo?.code });
        S.sale = { ...r, sel: { ...draft }, customer, state: 'waiting', started: Date.now() };
        paintPayment(); pollSale();
      }).catch(() => {});
    };
    $('comp') && ($('comp').onclick = compSheet);
  }
  function paintPayment() {
    const x = S.sale, pg = $('pg'); if (!pg) return;
    const sel = x.sel, label = `${esc(C.plans[sel.plan].name)} · ${esc(C.tiers[sel.tier].name)} · ${money(x.after ?? x.amount)}/${x.interval === 'year' ? 'yr' : 'mo'}`;
    if (x.state === 'paid') {
      pg.innerHTML = `<div class="card pay" style="max-width:560px;margin:0 auto"><div class="kicker">Paid</div><div class="paid">✓ Payment received</div>
        <p class="muted">${label}${x.customer?.company ? ` · ${esc(x.customer.company)}` : ''}</p>
        <div class="orderno" id="no">${esc(x.order.order_id)}</div>
        <p class="muted">Tell ${esc(x.customer?.first || 'the customer')} to redeem it in Nexus '28: Settings → Account → Redeem an order. It's on their Stripe receipt too.</p>
        <div class="row" style="justify-content:center"><button class="btn" id="cp">${ic('copy', 15)} Copy order number</button><button class="btn" id="rcpt">${ic('mail', 15)} Email receipt</button><button class="btn primary" id="again">${ic('plus', 15)} New sale</button></div></div>`;
      $('cp').onclick = () => copy(x.order.order_id);
      $('rcpt').onclick = () => receiptSheet(x.order.order_id, x.customer?.email);
      $('again').onclick = () => { S.sale = null; draft.customer = {}; draft.promo = null; go('sale'); };
      return;
    }
    const gone = x.state === 'expired';
    pg.innerHTML = `<div class="card pay" style="max-width:560px;margin:0 auto">
      <div class="kicker">${gone ? 'Not paid' : 'Waiting for payment'}</div><h3 style="margin:0">${label}</h3>
      ${x.customer?.name ? `<p class="muted" style="margin:4px 0 0">${esc(x.customer.name)}${x.customer.company ? ` · ${esc(x.customer.company)}` : ''}</p>` : ''}
      ${gone ? '<p class="muted" style="margin:18px 0">This payment link expired without a payment. Nothing was charged.</p>'
        : `<div class="qr">${qrSvg(x.url)}</div>
        <div class="wait"><span class="spin"></span> Scan with a phone camera to pay. This updates by itself.</div>
        <div class="linkbox"><input class="field" readonly value="${esc(x.url)}"><button class="btn small" id="cp">${ic('copy', 15)}</button><button class="btn small" id="open">Pay here</button></div>`}
      <p class="muted" style="font-size:13px;margin-top:14px">Order number once paid: <span class="mono">${esc(x.order_id)}</span></p>
      <div class="row" style="justify-content:center;margin-top:8px"><button class="btn quiet" id="cancel">${gone ? 'Back' : 'Cancel this sale'}</button>${!gone ? `<button class="btn quiet" id="chk">${ic('refresh', 15)} Check now</button>` : ''}</div></div>`;
    $('cp') && ($('cp').onclick = () => copy(x.url, 'Payment link copied.'));
    $('open') && ($('open').onclick = () => { desk ? desk.openPayment(x.url) : window.open(x.url, '_blank', 'noopener'); });
    $('chk') && ($('chk').onclick = e => busy(e.target, checkSale));
    $('cancel').onclick = () => { clearInterval(S.saleTimer); S.sale = null; go(S.page === 'quotes' ? 'quotes' : 'sale'); };
  }
  async function checkSale() {
    const x = S.sale; if (!x) return;
    const r = await api('sale_status', { session_id: x.session_id });
    if (r.ready) { x.state = 'paid'; x.order = r.order; clearInterval(S.saleTimer); toast(`Paid! Order ${r.order.order_id}.`, 'ok'); desk?.attention?.(); quiet(refresh()); }
    else if (r.state === 'expired') { x.state = 'expired'; clearInterval(S.saleTimer); }
    if (S.page === 'sale' || S.page === 'quotes') paintPayment();
  }
  function pollSale() {
    clearInterval(S.saleTimer);
    S.saleTimer = setInterval(() => { if (!S.sale || Date.now() - S.sale.started > 40 * 60e3) return clearInterval(S.saleTimer); quiet(checkSale()); }, 3000);
  }
  function compSheet() {
    let customer; try { customer = window.A3forms.read($('cust'), draft.plan); } catch (err) { return toast(`For a free order too: ${err.message}`, 'bad'); }
    sheet(`<div class="kicker">Manager · free order</div><h3>Comp ${esc(C.plans[draft.plan].name)} · ${esc(C.tiers[draft.tier].name)} for ${esc(customer.name)}</h3>
      <p class="muted">Creates a working order with no payment and no subscription. It's logged under your name.</p>
      <label class="lbl">Why</label><input class="field" id="nt" placeholder="e.g. tester, giveaway, make-good">
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">${ic('gift', 15)} Create free order</button></div>`,
      (el, close) => el.querySelector('#ok').onclick = e => busy(e.target, async () => {
        const r = await api('comp', { plan: draft.plan, tier: draft.tier, os: draft.os, connection: draft.connection, customer, note: el.querySelector('#nt').value });
        close(); sheet(`<div class="kicker">Free order created</div><div class="orderno" style="margin:12px 0">${esc(r.order_id)}</div><p class="muted">Redeem it in Nexus '28: Settings → Account → Redeem an order.</p><div class="acts"><button class="btn" id="cp2">${ic('copy', 15)} Copy</button><button class="btn primary" data-close>Done</button></div>`,
          el2 => el2.querySelector('#cp2').onclick = () => copy(r.order_id));
        draft.customer = {}; go('sale');
      }).catch(() => {}));
  }

  // ================================================================ Orders
  let orderQ = '';
  function pageOrders() {
    $('pg').innerHTML = `<div class="tools"><input class="field" id="q" placeholder="Search order number, email, name, company or quote" value="${esc(orderQ)}"><span class="sp"></span>
      ${can('manager') ? `<button class="btn small" id="exp">${ic('download', 15)} Export CSV</button>` : ''}<button class="btn small" id="rf">${ic('refresh', 15)} Refresh</button></div>
      <div class="card tblcard"><table class="tbl"><thead><tr><th>Order</th><th>Customer</th><th>Plan</th><th class="num">Amount</th><th>Status</th><th>When</th><th>Sold by</th></tr></thead><tbody id="rows"><tr><td colspan="7" class="empty"><span class="spin"></span></td></tr></tbody></table></div>`;
    let t; $('q').oninput = e => { clearTimeout(t); orderQ = e.target.value; t = setTimeout(loadOrders, 250); };
    $('rf').onclick = loadOrders; $('q').focus(); loadOrders();
    $('exp') && ($('exp').onclick = e => busy(e.target, async () => {
      const all = await api('orders', { q: orderQ, all: true });
      csv(`aargon3-orders-${ymd(new Date())}.csv`, ['Order', 'Created', 'Status', 'Plan', 'Tier', 'Billing', 'Amount', 'Paid in total', 'Customer', 'Email', 'Phone', 'Company', 'People', 'Source', 'Sold by', 'Store', 'Promo', 'Quote', 'Node', 'Jurisdiction'],
        all.map(o => [o.order_id, o.created_at, o.status, o.plan, o.tier || o.config?.service_tier, o.billing, o.amount, o.paid_total, o.customer_name, o.customer_email, o.customer_phone, o.company_name, o.seats, o.source, o.operator, o.store, o.promo_code, o.quote_no, o.node_id, o.jurisdiction]));
    }).catch(() => {}));
  }
  const sourceLabel = o => ({ web: 'Online store', comp: 'Free (comp)', custom: 'Custom order', legacy: 'Old terminal' }[o.source] || o.operator || '—');
  async function loadOrders() {
    let list; try { list = await api('orders', { q: orderQ }); } catch (e) { $('rows') && ($('rows').innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`); return; }
    if (!$('rows')) return;
    $('rows').innerHTML = list.map(o => `<tr class="click" data-id="${esc(o.order_id)}"><td class="id">${esc(o.order_id)}${o.quote_no ? `<div class="muted" style="font-size:11.5px">${esc(o.quote_no)}</div>` : ''}</td>
      <td>${esc(o.company_name || o.customer_name || o.customer_email || '—')}${(o.company_name ? o.customer_name : o.customer_name && o.customer_email) ? `<div class="muted" style="font-size:12.5px">${esc(o.company_name ? o.customer_name : o.customer_email)}</div>` : ''}</td>
      <td>${esc(o.plan || '—')} · ${esc(o.tier ? tierName(o.tier) : o.config?.service_tier || '—')}${o.seats && o.plan === 'Enterprise' ? `<div class="muted" style="font-size:12px">${o.seats} people</div>` : ''}</td>
      <td class="num">${o.source === 'comp' ? '<span class="pill vio">COMP</span>' : money(Number(o.amount) || 0)}${o.billing === 'year' ? '<span class="muted">/yr</span>' : o.subscription ? '<span class="muted">/mo</span>' : ''}</td>
      <td>${statusPill(o.status)}</td><td class="muted">${fmtWhen(o.created_at)}</td><td class="muted">${esc(o.source === 'terminal' || o.source === 'custom' ? o.operator || sourceLabel(o) : sourceLabel(o))}</td></tr>`).join('')
      || `<tr><td colspan="7" class="empty">${orderQ ? 'No orders match.' : 'No orders yet.'}</td></tr>`;
    $('rows').querySelectorAll('tr.click').forEach(r => r.onclick = () => orderSheet(r.dataset.id));
  }
  async function orderSheet(id) {
    let o; try { o = await api('order', { order_id: id }); } catch (e) { return toast(e.message, 'bad'); }
    const c = o.config || {}, info = o.customer_info || {}, active = String(o.status).toUpperCase() === 'ACTIVE';
    sheet(`<div class="kicker">Order</div><div class="row" style="justify-content:space-between"><h3 class="mono">${esc(o.order_id)}</h3>${statusPill(o.status)}</div>
      <div class="kv">
        ${o.company_name ? `<span>Company</span><span><b>${esc(o.company_name)}</b></span>` : ''}
        <span>Customer</span><span>${esc(o.customer_name || '—')}${info.title ? ` · ${esc(info.title)}` : ''}${o.customer_email ? `<br><span class="muted">${esc(o.customer_email)}</span>` : ''}${o.customer_phone ? `<br><span class="muted">${esc(o.customer_phone)}</span>` : ''}</span>
        <span>Plan</span><span>${esc(o.plan || '—')} · ${esc(c.service_tier || tierName(o.tier))}${o.seats ? ` · ${o.seats} ${o.seats === 1 ? 'person' : 'people'}` : ''}</span>
        <span>Amount</span><span>${o.source === 'comp' ? 'Free (comp)' : `${money(Number(o.amount) || 0)}${o.billing === 'year' ? ' a year' : o.billing === 'once' ? ' once' : o.subscription ? ' a month' : ''}`}${o.discount > 0 ? ` <span class="muted">(${money(o.discount)} off with ${esc(o.promo_code)})</span>` : o.promo_code ? ` · ${esc(o.promo_code)}` : ''}</span>
        ${o.payments > 1 ? `<span>Paid in total</span><span>${money(o.paid_total)} <span class="muted">over ${o.payments} payments</span></span>` : ''}
        <span>System</span><span>${esc([c.os, c.chip, c.connection].filter(Boolean).join(' · ') || '—')}</span>
        ${o.node_id ? `<span>Node</span><span class="mono">${esc(o.node_id)}</span>` : ''}${o.jurisdiction ? `<span>Jurisdiction</span><span>${esc(o.jurisdiction)}</span>` : ''}
        ${o.quote_no ? `<span>Quote</span><span class="mono">${esc(o.quote_no)}</span>` : ''}
        <span>Sold</span><span>${fmtWhen(o.created_at)} · ${esc(o.source === 'web' ? 'Online store' : `${o.operator || '—'}${o.store ? ', ' + o.store : ''}`)}</span>
        ${o.notes ? `<span>Notes</span><span>${esc(o.notes)}</span>` : ''}
        ${o.status === 'PAUSED' ? `<span>Paused</span><span>until ${fmtDay(o.paused_until)}</span>` : o.cancel_at && o.status !== 'CANCELLED' ? `<span>Ends</span><span>${fmtDay(o.cancel_at)} <span class="muted">(cancelling at the end of the period)</span></span>`
          : o.current_period_end && o.subscription && o.status === 'ACTIVE' ? `<span>Renews</span><span>${fmtDay(o.current_period_end)}</span>` : ''}
        ${o.expires_at ? `<span>${o.status === 'EXPIRED' ? 'Ended' : 'Runs until'}</span><span>${fmtDay(o.expires_at)}</span>` : ''}
        ${o.region ? `<span>Region</span><span>${esc(o.region)} · ${esc(C.regions[o.region] || '')}${Number(o.tax) ? ` · ${money(o.tax)} tax` : ''}</span>` : ''}
        ${o.gift ? `<span>Gift</span><span>${o.status === 'GIFT' ? `Not claimed yet · code <b class="mono">${esc(o.gift.code)}</b>` : `Claimed ${fmtDay(o.gift.claimed_at)}`} · ${o.gift.months} months for ${esc(o.gift.to_name || '')}${o.gift.from_name ? `, from ${esc(o.gift.from_name)}` : ''}</span>` : ''}
        ${o.referral_code ? `<span>Referral code</span><span class="mono">${esc(o.referral_code)}${o.referrals ? ` <span class="muted">· ${o.referrals} friend${o.referrals === 1 ? '' : 's'}, ${money(o.referral_credit)} credit</span>` : ''}</span>` : ''}
        ${o.referred_by ? `<span>Referred by</span><span class="mono">${esc(o.referred_by)}</span>` : ''}
        ${o.deals?.length ? `<span>Deals</span><span>${o.deals.map(d => esc(d.headline)).join(' · ')}</span>` : ''}
        ${o.apoji?.username ? `<span>Nexus</span><span class="nxline">${o.apoji.avatar_url ? `<span class="kav"><img src="${esc(o.apoji.avatar_url)}" alt=""></span>` : ''}<b>${esc(o.apoji.display_name || o.apoji.nickname || o.apoji.username)}</b> <span class="muted mono">@${esc(o.apoji.username)}</span></span>` : ''}</div>
      ${(o.history || []).length ? `<label class="lbl">History</label><div class="hist">${o.history.slice().reverse().map(h => `<div><span class="muted">${fmtWhen(h.at)}</span> ${esc(histText(h))}</div>`).join('')}</div>` : ''}
      <label class="lbl">Models</label><div class="chips">${(o.models || []).map(m => `<span>${esc(m)}</span>`).join('') || '<span>—</span>'}</div>
      ${can('manager') && (o.can?.change || o.can?.pause || o.can?.resume || o.can?.cancel || o.can?.keep || o.can?.card) ? `<div class="oacts">
        ${o.can.change ? `<button class="btn small" id="ochg">${ic('swap', 15)} Change plan</button>` : ''}${o.can.pause ? `<button class="btn small" id="opz">${ic('pause', 15)} Pause</button>` : ''}
        ${o.can.resume ? `<button class="btn small primary" id="ors">${ic('play', 15)} Resume</button>` : ''}${o.can.cancel ? `<button class="btn small" id="oend">Cancel at period end</button>` : ''}
        ${o.can.keep ? `<button class="btn small primary" id="okeep">Keep (undo cancel)</button>` : ''}${o.can.card ? `<button class="btn small" id="ocard">${ic('link', 15)} Card update link</button>` : ''}</div>` : ''}
      <div class="acts"><button class="btn quiet" id="cp">${ic('copy', 15)} Copy number</button><button class="btn quiet" id="rcpt">${ic('mail', 15)} Email receipt</button>${can('manager') && (active || o.status === 'PAUSED') ? `<button class="btn danger" id="cx">Cancel now</button>${o.subscription ? '<button class="btn danger" id="rf">Refund & cancel</button>' : ''}` : ''}<button class="btn primary" data-close>Close</button></div>`,
      (el, close) => {
        el.querySelector('#cp').onclick = () => copy(o.order_id);
        el.querySelector('#rcpt').onclick = () => { close(); receiptSheet(o.order_id, o.customer_email); };
        const reopen = msg => { close(); toast(msg, 'ok'); loadOrders(); orderSheet(o.order_id); };
        const on = (id, fn) => { const b = el.querySelector('#' + id); if (b) b.onclick = fn; };
        on('ochg', () => { close(); changePlanSheet(o); });
        on('opz', () => { close(); pauseOrderSheet(o); });
        on('ors', e => busy(e.target, async () => { await api('order_resume', { order_id: o.order_id }); reopen('Resumed. Billing starts again.'); }).catch(() => {}));
        on('oend', async () => { if (await confirmSheet('Cancel at the end of the period?', `It keeps working until ${fmtDay(o.current_period_end)}, then stops renewing. You (or the customer, on Your order) can undo it before then.`, 'Cancel at period end', true))
          api('order_cancel_end', { order_id: o.order_id }).then(() => reopen('It will end at the end of the period.')).catch(err => toast(err.message, 'bad')); });
        on('okeep', e => busy(e.target, async () => { await api('order_cancel_end', { order_id: o.order_id, undo: true }); reopen('Kept. It renews as normal.'); }).catch(() => {}));
        on('ocard', e => busy(e.target, async () => { const r = await api('order_card_link', { order_id: o.order_id }); copy(r.url, 'Card update link copied. Send it to the customer.'); }).catch(() => {}));
        const act = refund => async () => {
          if (!(await confirmSheet(refund ? 'Refund and cancel?' : 'Cancel this order?', refund ? 'Refunds the last payment, ends the subscription now, and the order stops working in Nexus.' : 'Ends the subscription now (no refund), and the order stops working in Nexus.', refund ? 'Refund & cancel' : 'Cancel order', true))) return;
          const r = await api('cancel', { order_id: o.order_id, refund }).catch(err => { toast(err.message, 'bad'); return null; });
          if (r) { close(); toast(`${o.order_id} ${r.status.toLowerCase()}${r.refunded ? ` · refunded ${money(r.refunded)}` : ''}.`, 'ok'); loadOrders(); }
        };
        el.querySelector('#cx') && (el.querySelector('#cx').onclick = act(false));
        el.querySelector('#rf') && (el.querySelector('#rf').onclick = act(true));
      });
  }

  const histText = h => ({ change: `Changed ${h.from} → ${h.to}${h.due_now ? `, charged ${money(h.due_now)}` : h.credit ? `, ${money(h.credit)} credit` : ''}`, pause: `Paused ${h.months} month${h.months === 1 ? '' : 's'}`,
    resume: 'Resumed', code: `Code ${h.code} added${h.label ? ` (${h.label})` : ''}`, contact: 'Contact details updated', apoji_link: `Linked Nexus account${h.username ? ` @${h.username}` : ''}`, apoji_unlink: 'Unlinked Nexus account', cancel_at_end: 'Set to cancel at the end of the period', keep: 'Cancel undone', gift_bought: `Bought as a ${h.months}-month gift`, gift_claimed: `Gift claimed by ${h.by || 'them'}`, expired: 'Ended (gift months used up)' }[h.kind] || h.kind) + (h.by && !['gift_claimed'].includes(h.kind) ? ` · ${h.by}` : '');
  function receiptSheet(orderId, email) {
    sheet(`<div class="kicker">Receipt</div><h3>Email the receipt for ${esc(orderId)}</h3>
      <p class="muted" style="margin:4px 0 0">Sent from ${esc(S.me ? 'aARgon3' : '')} with your store's name on it.</p>
      <label class="lbl">Customer's email</label><input class="field" id="re" type="email" value="${esc(email || '')}" placeholder="name@example.com">
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">${ic('mail', 15)} Send receipt</button></div>`,
      (el, close) => el.querySelector('#ok').onclick = e => busy(e.target, async () => {
        const r = await api('receipt_email', { order_id: orderId, to: el.querySelector('#re').value.trim() }); close(); toast(`Receipt sent to ${r.to}.`, 'ok');
      }).catch(() => {}));
  }
  function changePlanSheet(o) {
    const sel = { plan: PLANS.find(k => C.plans[k].name === o.plan) || 'personal', tier: o.tier, billing: o.interval === 'year' ? 'year' : 'month' };
    sheet(`<div class="kicker">Change plan · ${esc(o.order_id)}</div><h3>${esc(o.plan)} ${esc(tierName(o.tier))} → …</h3>
      <div class="two"><div><label class="lbl">Plan</label><div class="seg" id="cpp">${PLANS.filter(p => !C.plans[p].quote).map(p => `<button data-v="${p}">${esc(C.plans[p].name)}</button>`).join('')}</div></div>
        <div><label class="lbl">Billing</label><div class="seg" id="cpb"><button data-v="month">Monthly</button><button data-v="year">Yearly</button></div></div></div>
      <label class="lbl">Tier</label><div class="seg" id="cpt">${TIERS.map(t => `<button data-v="${t}">${esc(C.tiers[t].name)}</button>`).join('')}</div>
      <div class="kv" id="cpq" style="min-height:60px"></div>
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok" disabled>Change plan</button></div>`,
      (el, close) => {
        let q = null;
        const paint = () => { for (const [id, k] of [['cpp', 'plan'], ['cpb', 'billing'], ['cpt', 'tier']]) el.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle('on', b.dataset.v === sel[k])); };
        const preview = async () => {
          paint(); q = null; el.querySelector('#ok').disabled = true; el.querySelector('#cpq').innerHTML = '<span class="muted"><span class="spin"></span> Working it out…</span><span></span>';
          try {
            q = await api('order_change', { order_id: o.order_id, ...sel });
            el.querySelector('#cpq').innerHTML = `<span>From</span><span>${esc(q.from)}</span><span>To</span><span><b>${esc(q.to)}</b> · ${money(q.new_price)}/${q.interval === 'year' ? 'yr' : 'mo'}</span>
              <span>${q.upgrade ? 'Charged now' : 'Credit'}</span><span><b>${money(q.upgrade ? q.due_now : q.credit)}</b> <span class="muted">${q.upgrade ? 'to their saved card (minus unused time)' : 'off their next bill'}</span></span>`;
            el.querySelector('#ok').disabled = false; el.querySelector('#ok').textContent = q.upgrade ? `Change and charge ${money(q.due_now)}` : 'Change plan';
          } catch (err) { el.querySelector('#cpq').innerHTML = `<span></span><span class="err">${esc(err.message)}</span>`; }
        };
        for (const [id, k] of [['cpp', 'plan'], ['cpb', 'billing'], ['cpt', 'tier']]) el.querySelectorAll(`#${id} button`).forEach(b => b.onclick = () => { sel[k] = b.dataset.v; preview(); });
        paint();
        el.querySelector('#ok').onclick = e => busy(e.target, async () => {
          const r = await api('order_change', { order_id: o.order_id, ...sel, apply: true });
          close(); toast(`${o.order_id} is now ${r.to}.${r.due_now ? ` Charged ${money(r.due_now)}.` : ''}`, 'ok'); loadOrders(); orderSheet(o.order_id);
        }).catch(() => {});
      });
  }
  function pauseOrderSheet(o) {
    let m = 1;
    sheet(`<div class="kicker">Pause · ${esc(o.order_id)}</div><h3>Pause billing for…</h3>
      <div class="seg" id="pm">${[1, 2, 3].map(n => `<button data-v="${n}" class="${n === 1 ? 'on' : ''}">${n} month${n === 1 ? '' : 's'}</button>`).join('')}</div>
      <p class="muted" style="font-size:13px">Nothing is charged while it's paused. It starts again on its own.</p>
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">${ic('pause', 15)} Pause</button></div>`,
      (el, close) => {
        el.querySelectorAll('#pm button').forEach(b => b.onclick = () => { m = +b.dataset.v; el.querySelectorAll('#pm button').forEach(x => x.classList.toggle('on', x === b)); });
        el.querySelector('#ok').onclick = e => busy(e.target, async () => { await api('order_pause', { order_id: o.order_id, months: m }); close(); toast(`Paused for ${m} month${m === 1 ? '' : 's'}.`, 'ok'); loadOrders(); orderSheet(o.order_id); }).catch(() => {});
      });
  }

  // ================================================================ Catalog
  let catBilling = 'month';
  function pageCatalog() {
    const h = window.A3compare.html({ billing: catBilling });
    $('pg').innerHTML = `<div class="h-row"><p class="muted" style="margin:0">Everything in every plan, straight from the catalog the store uses.</p><span class="sp"></span>
      <div class="seg" id="cb"><button data-v="month" class="${catBilling === 'month' ? 'on' : ''}">Monthly</button><button data-v="year" class="${catBilling === 'year' ? 'on' : ''}">Yearly</button></div></div>
      ${h.table}<div class="sect-title">LentOS</div>${h.os}<div class="sect-title">Connections</div>${h.connections}<div class="sect-title">Quouk chips</div>${h.chips}<div class="sect-title">People per order</div>${h.plans}
      <div class="sect-title">Enterprise starting prices</div><div class="cmp-cards">${TIERS.map(t => `<div class="cmp-card"><b>${esc(C.tiers[t].name)}</b><p>${money(C.plans.enterprise.perSeatMonthly[t])} a person a month, from ${money(A3.enterpriseSuggest(t, 0))}/month. Quote it in Custom orders.</p></div>`).join('')}</div>`;
    $('cb').querySelectorAll('button').forEach(b => b.onclick = () => { catBilling = b.dataset.v; pageCatalog(); });
  }

  // ================================================================ Schedule
  let weekStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; })();
  async function pageSchedule() {
    const pg = $('pg'), mgr = can('manager');
    const end = new Date(weekStart.getTime() + 7 * 864e5), days = [...Array(7)].map((_, i) => new Date(weekStart.getTime() + i * 864e5));
    pg.innerHTML = `<div class="h-row"><button class="btn small" id="prev">${ic('left', 15)}</button><h3>${weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(end - 864e5).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</h3><button class="btn small" id="next">${ic('right', 15)}</button><button class="btn quiet small" id="thisWeek">This week</button>
      <span class="sp"></span>${mgr ? `<button class="btn small" id="copyWeek">${ic('copy', 15)} Copy to next week</button><button class="btn small" id="clos">${ic('store', 15)} Closures</button><button class="btn small" id="timeoff">${ic('bell', 15)} Time off${S.state?.pending_time_off ? ` (${S.state.pending_time_off})` : ''}</button><button class="btn primary small" id="add">${ic('plus', 15)} Add shift</button>`
        : `<button class="btn small" id="timeoff">${ic('calendarx', 15)} Ask for time off</button>`}</div>
      <div id="grid"><div class="empty"><span class="spin"></span></div></div>
      <p class="muted" style="font-size:13px;margin-top:10px">${mgr ? 'Click an empty day to add a shift, or a shift to change it. Striped days are approved time off.' : 'Your shifts are purple. Ask a manager to change them.'}</p>`;
    $('prev').onclick = () => { weekStart = new Date(weekStart.getTime() - 7 * 864e5); pageSchedule(); };
    $('next').onclick = () => { weekStart = new Date(weekStart.getTime() + 7 * 864e5); pageSchedule(); };
    $('thisWeek').onclick = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); weekStart = d; pageSchedule(); };
    $('timeoff').onclick = mgr ? timeOffReview : timeOffSheet;
    $('clos') && ($('clos').onclick = closuresSheet);
    let shifts, team = [], off = [];
    try {
      [shifts, team, off] = await Promise.all([api('schedule', { from: weekStart.toISOString(), to: end.toISOString() }), mgr ? api('team') : Promise.resolve([]), api('timeoff', { everyone: mgr })]);
    } catch (e) { $('grid') && ($('grid').innerHTML = `<div class="empty-card">${esc(e.message)}</div>`); return; }
    if (!$('grid')) return;
    const people = mgr ? team.filter(s => s.active && s.user_id) : [];
    for (const c of shifts) if (!people.some(p => p.user_id === c.user_id)) people.push({ user_id: c.user_id, name: c.name, color: c.color });
    if (!people.some(p => p.user_id === S.me.id)) people.unshift({ user_id: S.me.id, name: S.me.name, color: S.me.color, title: S.me.title });
    const approved = off.filter(t => t.status === 'approved');
    const isOff = (uid, d) => approved.some(t => t.user_id === uid && ymd(d) >= t.starts_on && ymd(d) <= t.ends_on);
    const today = ymd(new Date());
    $('grid').innerHTML = `<div class="week"><div class="hd">Person</div>${days.map(d => `<div class="hd ${ymd(d) === today ? 'today' : ''}">${d.toLocaleDateString([], { weekday: 'short' })}<b>${d.getDate()}</b></div>`).join('')}
      ${people.map(p => `<div class="who ${p.user_id === S.me.id ? 'me-row' : ''}">${avatar(p.name, p.color, '', p.user_id)}<div>${esc(p.name)}<small>${esc(p.title || roleName(p.role) || '')}</small></div></div>
        ${days.map(d => { const list = shifts.filter(c => c.user_id === p.user_id && ymd(c.starts_at) === ymd(d)), offDay = isOff(p.user_id, d);
          return `<div class="cell ${mgr ? 'can' : ''} ${offDay ? 'off' : ''} ${p.user_id === S.me.id ? 'me-row' : ''}" data-u="${esc(p.user_id)}" data-d="${ymd(d)}">${list.map(c => `<button class="chipx ${p.user_id === S.me.id ? 'me' : ''} ${c.worked != null ? 'done' : ''} ${c.time_off ? 'flag' : ''}" data-id="${c.id}" title="${esc(`${fmtTime(c.starts_at)}–${fmtTime(c.ends_at)} · ${c.store_code ? '#' + c.store_code : 'Any store'}${c.note ? ' · ' + c.note : ''}`)}"><span class="t">${shortTime(c.starts_at)}–${shortTime(c.ends_at)}</span><small>${c.store_code ? `#${esc(c.store_code)}` : 'Any store'}${c.note ? ` · ${esc(c.note)}` : ''}${c.worked != null ? ` · worked ${hm(c.worked)}` : ''}</small></button>`).join('')}${offDay && !list.length ? '<small class="muted">Off</small>' : ''}</div>`; }).join('')}`).join('')}</div>`;
    if (!mgr) return;
    $('grid').querySelectorAll('.cell.can').forEach(cell => cell.onclick = e => {
      const chip = e.target.closest('.chipx');
      if (chip) return shiftSheet(shifts.find(c => String(c.id) === chip.dataset.id), people);
      shiftSheet({ user_id: cell.dataset.u, day: cell.dataset.d }, people);
    });
    $('add').onclick = () => shiftSheet({ user_id: people[0]?.user_id, day: ymd(new Date()) }, people);
    $('copyWeek').onclick = e => busy(e.target, async () => { const r = await api('schedule_copy', { week_start: weekStart.toISOString() }); toast(r.copied ? `Copied ${r.copied} shift${r.copied === 1 ? '' : 's'} to next week.` : 'Nothing to copy (or next week already has them).', 'ok'); }).catch(() => {});
  }
  function shiftSheet(c, people) {
    const day = c.day || ymd(c.starts_at), start = c.starts_at ? fmtHM(c.starts_at) : '09:00', end = c.ends_at ? fmtHM(c.ends_at) : '17:00';
    sheet(`<div class="kicker">${c.id ? 'Change shift' : 'Add shift'}</div><h3>${c.id ? esc(c.name || 'Shift') : 'Schedule someone'}</h3>
      <label class="lbl">Person</label><select class="field" id="u">${people.map(p => `<option value="${esc(p.user_id)}" ${p.user_id === c.user_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <div class="grid3"><div><label class="lbl">Day</label><input class="field" type="date" id="d" value="${day}"></div><div><label class="lbl">Starts</label><input class="field" type="time" id="s" value="${start}"></div><div><label class="lbl">Ends</label><input class="field" type="time" id="e" value="${end}"></div></div>
      <label class="lbl">Store</label><select class="field" id="st">${storeOptions(c.store_code || '', true)}</select>
      <label class="lbl">Note (optional)</label><input class="field" id="n" value="${esc(c.note || '')}" placeholder="e.g. Opening, inventory">
      <div class="acts">${c.id ? `<button class="btn danger" id="del">${ic('trash', 15)} Remove</button><span style="flex:1"></span>` : ''}<button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">Save</button></div>`,
      (el, close) => {
        el.querySelector('#ok').onclick = e => busy(e.target, async () => {
          const d = el.querySelector('#d').value, s = el.querySelector('#s').value, en = el.querySelector('#e').value;
          const starts = new Date(`${d}T${s}`), ends = new Date(`${d}T${en}`); if (ends <= starts) ends.setDate(ends.getDate() + 1);   // overnight
          await api('schedule_save', { id: c.id, user_id: el.querySelector('#u').value, starts_at: starts.toISOString(), ends_at: ends.toISOString(), store_code: el.querySelector('#st').value, note: el.querySelector('#n').value });
          close(); toast('Shift saved.', 'ok'); quiet(refresh()); pageSchedule();
        }).catch(() => {});
        el.querySelector('#del') && (el.querySelector('#del').onclick = e => busy(e.target, async () => { await api('schedule_delete', { id: c.id }); close(); toast('Shift removed.'); pageSchedule(); }).catch(() => {}));
      });
  }
  const fmtHM = d => { const x = new Date(d); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
  function timeOffSheet() {
    const t = ymd(new Date(Date.now() + 864e5));
    sheet(`<div class="kicker">Time off</div><h3>Ask for days off</h3><p class="muted">A manager will approve or deny it. You'll see the answer on your Profile.</p>
      <div class="grid2"><div><label class="lbl">First day</label><input class="field" type="date" id="a" value="${t}" min="${ymd(new Date())}"></div><div><label class="lbl">Last day</label><input class="field" type="date" id="b" value="${t}" min="${ymd(new Date())}"></div></div>
      <label class="lbl">Reason (optional)</label><input class="field" id="r" placeholder="e.g. Trip, appointment">
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">Send request</button></div>`,
      (el, close) => el.querySelector('#ok').onclick = e => busy(e.target, async () => {
        await api('timeoff_request', { starts_on: el.querySelector('#a').value, ends_on: el.querySelector('#b').value, reason: el.querySelector('#r').value });
        close(); toast('Request sent.', 'ok'); if (S.page === 'profile') pageProfile();
      }).catch(() => {}));
  }
  async function timeOffReview() {
    let list; try { list = await api('timeoff', { everyone: true }); } catch (e) { return toast(e.message, 'bad'); }
    sheet(`<div class="kicker">Time off</div><h3>Requests</h3>
      <div class="people" style="margin-top:12px">${list.map(t => `<div class="person">${avatar(t.name)}<div><b>${esc(t.name || '—')}</b><small>${fmtDate(t.starts_on)}${t.ends_on !== t.starts_on ? ` – ${fmtDate(t.ends_on)}` : ''}${t.reason ? ` · ${esc(t.reason)}` : ''}${t.decided_by ? ` · ${esc(t.status)} by ${esc(t.decided_by)}` : ''}</small></div>
        <div class="r">${t.status === 'pending' ? `<button class="btn small" data-a="approved" data-id="${t.id}">Approve</button> <button class="btn small danger" data-a="denied" data-id="${t.id}">Deny</button>` : statusPill(t.status)}</div></div>`).join('') || '<div class="empty">No requests.</div>'}</div>
      <div class="acts"><button class="btn primary" data-close>Done</button></div>`,
      (el, close) => el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => busy(b, async () => {
        await api('timeoff_decide', { id: Number(b.dataset.id), status: b.dataset.a }); close(); toast(b.dataset.a === 'approved' ? 'Approved.' : 'Denied.', 'ok'); await refresh(); if (S.page === 'schedule') pageSchedule(); timeOffReview();
      }).catch(() => {})));
  }

  // ================================================================ Timesheet
  const tsv = { range: 'week', everyone: false, rows: [], pay: {} };
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
      ${can('manager') ? `<div class="seg" id="wseg"><button data-v="me" class="${!tsv.everyone ? 'on' : ''}">Me</button><button data-v="all" class="${tsv.everyone ? 'on' : ''}">Everyone</button></div>` : ''}
      <span class="sp"></span><button class="btn small" id="csvb">${ic('download', 15)} Export CSV</button></div><div id="tot" class="totals"></div>
      <div class="card tblcard"><table class="tbl"><thead><tr><th>Day</th>${tsv.everyone ? '<th>Who</th>' : ''}<th>Store</th><th>In</th><th>Out</th><th class="num">Breaks</th><th class="num">Worked</th><th class="num">Sales</th><th></th></tr></thead><tbody id="rows"><tr><td colspan="9" class="empty"><span class="spin"></span></td></tr></tbody></table></div>`;
    $('rseg').querySelectorAll('button').forEach(b => b.onclick = () => { tsv.range = b.dataset.v; pageTime(); });
    $('wseg') && $('wseg').querySelectorAll('button').forEach(b => b.onclick = () => { tsv.everyone = b.dataset.v === 'all'; pageTime(); });
    $('csvb').onclick = exportTime;
    loadShifts();
  }
  const breakMin = s => (s.breaks || []).reduce((m, b) => m + ((b.end ? new Date(b.end) : new Date()) - new Date(b.start)) / 60e3, 0);
  async function loadShifts() {
    const [from, to] = rangeOf(tsv.range);
    try {
      const [rows, team] = await Promise.all([api('shifts', { from: from.toISOString(), to: to.toISOString(), everyone: tsv.everyone }), can('owner') && tsv.everyone ? api('team') : Promise.resolve(null)]);
      tsv.rows = rows; tsv.pay = {}; (team || []).forEach(s => { if (s.user_id && s.pay_rate != null) tsv.pay[s.user_id] = Number(s.pay_rate); });
    } catch (e) { $('rows') && ($('rows').innerHTML = `<tr><td colspan="9" class="empty">${esc(e.message)}</td></tr>`); return; }
    if (!$('rows')) return;
    const total = tsv.rows.reduce((m, s) => m + s.minutes, 0), byPerson = {};
    tsv.rows.forEach(s => { const k = s.user_id; byPerson[k] = byPerson[k] || { name: s.name, m: 0 }; byPerson[k].m += s.minutes; });
    const payTotal = Object.entries(byPerson).reduce((m, [uid, p]) => m + (tsv.pay[uid] != null ? tsv.pay[uid] * p.m / 60 : 0), 0);
    $('tot').innerHTML = `<div class="card stat"><div class="k">Total worked</div><div class="v">${hm(total)}</div></div><div class="card stat"><div class="k">Shifts</div><div class="v">${tsv.rows.length}</div></div>
      <div class="card stat"><div class="k">Late clock-ins</div><div class="v">${tsv.rows.filter(s => s.late_minutes).length}</div></div>
      ${can('owner') && tsv.everyone ? `<div class="card stat"><div class="k">Estimated pay</div><div class="v">${money(Math.round(payTotal * 100) / 100)}</div><div class="s">hours × pay rate (Team)</div></div>` : ''}`
      + (tsv.everyone ? Object.entries(byPerson).sort((a, b) => b[1].m - a[1].m).map(([uid, p]) => `<div class="card stat"><div class="k">${esc(p.name)}</div><div class="v">${hm(p.m)}</div>${tsv.pay[uid] != null && can('owner') ? `<div class="s">${money(Math.round(tsv.pay[uid] * p.m / 60 * 100) / 100)} at ${money(tsv.pay[uid])}/h</div>` : ''}</div>`).join('') : '');
    $('rows').innerHTML = tsv.rows.map((s, i) => `<tr><td>${fmtDay(s.clock_in)}</td>${tsv.everyone ? `<td>${esc(s.name)}</td>` : ''}<td>#${esc(s.store_code || '—')}</td>
      <td>${fmtTime(s.clock_in)}${s.late_minutes ? ` <span class="pill warn" title="Scheduled ${s.scheduled ? fmtTime(s.scheduled.starts_at) : ''}">${s.late_minutes}M LATE</span>` : ''}</td>
      <td>${s.clock_out ? fmtTime(s.clock_out) : '<span class="pill ok">NOW</span>'}${s.forgot ? ' <span class="pill warn" title="Clock-out time entered afterwards">SET LATER</span>' : ''}${s.edited_by ? ` <span class="pill vio" title="Edited by ${esc(s.edited_by)}">EDITED</span>` : ''}</td>
      <td class="num">${breakMin(s) >= 1 ? hm(breakMin(s)) : '—'}</td><td class="num"><b>${hm(s.minutes)}</b></td><td class="num">${s.orders ? `${s.orders} · ${money(Number(s.sales) || 0)}` : '—'}</td>
      <td class="num">${can('manager') ? `<button class="btn quiet small" data-i="${i}" title="Fix this shift">${ic('edit', 15)}</button>` : ''}${s.note ? ` <span title="${esc(s.note)}">📝</span>` : ''}</td></tr>`).join('')
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
        close(); toast('Shift saved.', 'ok'); quiet(refresh()); loadShifts();
      }).catch(() => {}));
  }
  function exportTime() {
    const pay = can('owner') && tsv.everyone;
    csv(`aargon3-timesheet-${tsv.range}${tsv.everyone ? '-everyone' : ''}.csv`, ['Name', 'Store', 'Clock in', 'Clock out', 'Scheduled start', 'Minutes late', 'Break minutes', 'Worked minutes', 'Hours', ...(pay ? ['Pay rate', 'Estimated pay'] : []), 'Orders', 'Sales', 'Note', 'Edited by'],
      tsv.rows.map(s => [s.name, s.store, new Date(s.clock_in).toLocaleString(), s.clock_out ? new Date(s.clock_out).toLocaleString() : '', s.scheduled ? new Date(s.scheduled.starts_at).toLocaleString() : '', s.late_minutes || '',
        Math.round(breakMin(s)), s.minutes, (s.minutes / 60).toFixed(2), ...(pay ? [tsv.pay[s.user_id] ?? '', tsv.pay[s.user_id] != null ? (tsv.pay[s.user_id] * s.minutes / 60).toFixed(2) : ''] : []), s.orders, s.sales, s.note, s.edited_by]));
  }

  // ================================================================ Sales (all time)
  let salesMine = false;
  async function pageSales() {
    const pg = $('pg'), mgr = can('manager');
    pg.innerHTML = `${mgr ? `<div class="h-row"><div class="seg" id="ms"><button data-v="all" class="${!salesMine ? 'on' : ''}">Everyone</button><button data-v="me" class="${salesMine ? 'on' : ''}">Just me</button></div><span class="sp"></span></div>` : ''}<div id="sbody"><div class="empty"><span class="spin"></span></div></div>`;
    $('ms') && $('ms').querySelectorAll('button').forEach(b => b.onclick = () => { salesMine = b.dataset.v === 'me'; pageSales(); });
    let d, settings = null;
    try { [d, settings] = await Promise.all([api('sales', { mine: salesMine }), mgr ? api('settings').catch(() => null) : null]); }
    catch (e) { $('sbody') && ($('sbody').innerHTML = `<div class="empty-card">${esc(e.message)}</div>`); return; }
    if (!$('sbody')) return;
    const goal = Number(settings?.settings?.goals?.monthly_revenue) || 0, a = d.all_time || {};
    const months = d.months || [], max = Math.max(1, ...months.map(m => Number(m.revenue) || 0));
    const split = (title, list, label = x => x.key) => { const tot = Math.max(1, list.reduce((m, x) => m + (Number(x.revenue) || 0), 0));
      return `<div class="card"><h3>${title}</h3><div class="split">${list.map(x => `<div class="r"><span>${esc(label(x))} <span class="muted">· ${x.orders}</span></span><span>${big(x.revenue)}</span><div class="track"><div style="width:${Math.round((Number(x.revenue) || 0) / tot * 100)}%"></div></div></div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div></div>`; };
    $('sbody').innerHTML = `<div class="stats">
        <div class="card stat"><div class="k">All-time sales</div><div class="v">${big(a.revenue)}</div><div class="s">${a.orders || 0} orders${a.renewals ? ` · ${a.renewals} renewals` : ''}</div></div>
        <div class="card stat"><div class="k">This month</div><div class="v">${big(d.this_month)}</div><div class="s">${goal && !salesMine ? `goal ${big(goal)}` : 'payments received'}</div>${goal && !salesMine ? `<div class="goal"><div style="width:${Math.min(100, Math.round(d.this_month / goal * 100))}%"></div></div>` : ''}</div>
        <div class="card stat"><div class="k">Monthly recurring</div><div class="v">${big(d.mrr)}</div><div class="s">${d.active_subscriptions || 0} active subscriptions</div></div>
        <div class="card stat"><div class="k">Average order</div><div class="v">${big(a.paid_orders ? a.revenue / a.paid_orders : 0)}</div><div class="s">${a.comp_orders || 0} free (comp)</div></div></div>
      <div class="card"><h3>Last 12 months</h3><div class="mbars">${months.map((m, i) => `<div class="b ${i === months.length - 1 ? 'now' : ''}" title="${esc(m.month)}: ${m.orders} orders"><span class="amt">${Number(m.revenue) ? big(m.revenue) : ''}</span><div class="bar" style="height:${Math.round((Number(m.revenue) || 0) / max * 160)}px"></div><span class="lab">${new Date(m.month + '-15').toLocaleDateString([], { month: 'short' })}</span></div>`).join('')}</div></div>
      <div class="grid3" style="margin-top:12px">${split('By plan', d.by_plan || [])}${split('By tier', d.by_tier || [], x => tierName(x.key))}${split('Where it sold', d.by_source || [], x => ({ web: 'Online store', terminal: 'Terminal', comp: 'Free (comp)', custom: 'Custom orders', legacy: 'Old terminal' }[x.key] || x.key))}</div>
      ${!salesMine && mgr ? `<div class="grid2" style="margin-top:12px"><div class="card rank"><h3>Top sellers</h3><div class="split">${(d.top_staff || []).map(x => `<div class="r"><span>${esc(x.name)} <span class="muted">· ${x.orders}</span></span><span>${big(x.revenue)}</span></div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div></div>
        <div class="card rank"><h3>Top stores</h3><div class="split">${(d.top_stores || []).map(x => `<div class="r"><span>${esc(x.name)} <span class="muted">· ${x.orders}</span></span><span>${big(x.revenue)}</span></div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div></div></div>` : ''}
      ${!salesMine && mgr ? `<div class="grid2" style="margin-top:12px"><div class="card" id="refs"><h3>${ic('gift')} Referrals</h3><div class="empty"><span class="spin"></span></div></div>
        <div class="card" id="abd"><h3>${ic('mail')} Checkout reminders</h3><div class="empty"><span class="spin"></span></div></div></div>` : ''}
      <p class="muted" style="font-size:12.5px;margin-top:12px">Counts every payment, including monthly and yearly renewals since 2.1. Refunded orders don't count. Old-terminal orders count at the price they were rung up for.${a.first_order ? ` First order: ${fmtDate(a.first_order)}.` : ''}</p>`;
    salesExtras();
  }

  // ================================================================ Profile
  // ================================================================ points (behavior)
  const PT_PRESETS = [[2, 'Great customer service'], [1, 'Helped a teammate'], [3, 'Covered a shift'], [2, 'Big sale'], [5, 'Went above and beyond'], [1, 'Kept the store spotless'],
    [-1, 'Late'], [-1, 'Phone out on the floor'], [-1, 'Forgot to clock out'], [-3, 'Rude to a customer'], [-5, 'No-show'], [-2, 'Left early without asking']];
  const ptVal = n => `<span class="pv ${n < 0 ? 'neg' : 'pos'}">${n > 0 ? '+' : ''}${n}</span>`;
  function ptRow(x, compact, canUndo) {
    return `<div class="ptrow ${x.undone ? 'undone' : ''}">${ptVal(x.points)}<div class="pt-what"><b>${esc(x.reason)}</b><small>${compact ? '' : `${esc(x.name || '')} · `}${x.kind === 'late' ? 'automatic' : `from ${esc(x.given_by || '—')}`} · ${fmtWhen(x.created_at)}${x.undone ? ` · undone by ${esc(x.undone_by || '')}` : ''}</small></div>
      ${canUndo && !x.undone ? `<button class="btn quiet small" data-undo="${x.id}">Undo</button>` : ''}</div>`;
  }
  let ptUser = null;
  async function pagePoints() {
    const pg = $('pg');
    pg.innerHTML = '<div class="empty"><span class="spin"></span></div>';
    let d; try { d = await api('points', ptUser ? { user_id: ptUser } : {}); } catch (e) { pg.innerHTML = `<div class="empty-card">${esc(/function|not find|schema/i.test(e.message) ? 'Points need the 2.3 database update (supabase/aargon3-2.3.sql).' : e.message)}</div>`; return; }
    if (S.page !== 'points') return;
    const mgr = can('manager'), m = d.mine;
    const canUndo = x => mgr && (can('owner') || x.given_by_id === S.me.id);
    if (!mgr) {
      pg.innerHTML = `<div class="stats">
          <div class="card stat"><div class="k">Your points</div><div class="v ${m.total < 0 ? 'neg' : ''}">${m.total}</div><div class="s">all time</div></div>
          <div class="card stat"><div class="k">This month</div><div class="v">${m.month > 0 ? '+' : ''}${m.month}</div><div class="s">since the 1st</div></div>
          <div class="card stat"><div class="k">Earned</div><div class="v" style="color:var(--mint)">+${m.given}</div><div class="s">for great work</div></div>
          <div class="card stat"><div class="k">Lost</div><div class="v" style="color:var(--red)">${m.taken}</div><div class="s">for slip-ups</div></div></div>
        <div class="card"><h3>History</h3><div class="ptlist">${d.history.map(x => ptRow(x, true)).join('') || '<p class="muted" style="margin:0">No points yet. Managers give points for great work (and take a few away for things like being late).</p>'}</div></div>`;
      return;
    }
    const board = d.board || [], who = ptUser && board.find(r => r.user_id === ptUser);
    const eligible = board.filter(r => r.user_id !== S.me.id && (can('owner') || r.role === 'employee'));
    pg.innerHTML = `<div class="h-row"><p class="muted" style="margin:0">Give points for great work and take them away for slip-ups. Everyone sees their own points and history; only managers see the whole team.</p><span class="sp"></span>
        <button class="btn primary small" id="give" ${eligible.length ? '' : 'disabled'}>${ic('star', 15)} Give points</button></div>
      <div class="ptgrid">
        <div class="card"><h3>Leaderboard <small>this month · all time</small></h3><div class="board">${board.map((r, i) => `<button class="brow ${r.user_id === ptUser ? 'on' : ''}" data-u="${esc(r.user_id)}">
            <span class="rank">${i + 1}</span>${avatar(r.name, r.color, '', r.user_id)}<span class="bn"><b>${esc(r.name)}</b><small>${esc(r.title || roleName(r.role))}</small></span>
            <span class="bm">${r.month > 0 ? '+' : ''}${r.month}</span><span class="bt ${r.total < 0 ? 'neg' : ''}">${r.total}</span></button>`).join('') || '<p class="muted">Nobody on the team yet.</p>'}</div></div>
        <div class="card"><div class="h-row" style="margin:0 0 6px"><h3 style="margin:0">${who ? esc(who.name) : 'Recent'}</h3><span class="sp"></span>${who ? `<button class="btn quiet small" id="allp">Everyone</button>${eligible.some(r => r.user_id === who.user_id) ? `<button class="btn small" id="givep">${ic('star', 14)} Give ${esc(who.name.split(' ')[0])} points</button>` : ''}` : ''}</div>
          ${who ? `<div class="row" style="gap:18px;margin:4px 0 12px"><div><div class="k">TOTAL</div><b class="ptsbig ${who.total < 0 ? 'neg' : ''}">${who.total}</b></div><div><div class="k">MONTH</div><b style="font-size:20px">${who.month > 0 ? '+' : ''}${who.month}</b></div><div><div class="k">EARNED</div><b style="font-size:20px;color:var(--mint)">+${who.given}</b></div><div><div class="k">LOST</div><b style="font-size:20px;color:var(--red)">${who.taken}</b></div></div>` : ''}
          <div class="ptlist">${d.history.map(x => ptRow(x, !!who, canUndo(x))).join('') || '<p class="muted" style="margin:0">No points given yet.</p>'}</div></div></div>
      <form class="card" id="fpts" style="margin-top:12px"><h3>${ic('time')} Automatic points</h3>
        <div class="row" style="gap:10px"><span>A late clock-in (more than 5 minutes after a scheduled start) costs</span>
          <select class="field" id="late" style="width:auto" ${can('owner') ? '' : 'disabled'}>${[0, -1, -2, -3, -5].map(v => `<option value="${v}" ${Number(d.settings?.late || 0) === v ? 'selected' : ''}>${v === 0 ? 'nothing (off)' : `${-v} point${v === -1 ? '' : 's'}`}</option>`).join('')}</select>
          ${can('owner') ? '<button class="btn small">Save</button>' : '<span class="muted" style="font-size:13px">Only the owner can change this.</span>'}</div></form>`;
    pg.querySelectorAll('.brow').forEach(b => b.onclick = () => { ptUser = ptUser === b.dataset.u ? null : b.dataset.u; pagePoints(); });
    $('allp') && ($('allp').onclick = () => { ptUser = null; pagePoints(); });
    $('give').onclick = () => giveSheet(eligible, null);
    $('givep') && ($('givep').onclick = () => giveSheet(eligible, who.user_id));
    pg.querySelectorAll('[data-undo]').forEach(b => b.onclick = async () => {
      const x = d.history.find(h => h.id === +b.dataset.undo);
      if (!(await confirmSheet(`Undo ${x.points > 0 ? '+' : ''}${x.points} for ${x.name}?`, `"${x.reason}" stays in the history, marked undone.`, 'Undo'))) return;
      busy(b, async () => { await api('points_undo', { id: x.id }); toast('Undone.'); pagePoints(); }).catch(() => {});
    });
    $('fpts').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => { await api('settings_save', { key: 'points', value: { late: Number($('late').value) } }); toast('Saved.', 'ok'); }).catch(() => {}); };
  }
  function giveSheet(eligible, user) {
    let pts = null;
    sheet(`<div class="kicker">Points</div><h3>Give points</h3>
      <label class="lbl">Who</label><select class="field" id="gu">${eligible.map(r => `<option value="${esc(r.user_id)}" ${r.user_id === user ? 'selected' : ''}>${esc(r.name)}${r.title ? ` · ${esc(r.title)}` : ''}</option>`).join('')}</select>
      <label class="lbl">For</label><div class="presets">${PT_PRESETS.map(([n, why], i) => `<button type="button" class="preset ${n < 0 ? 'neg' : 'pos'}" data-i="${i}">${ptVal(n)} ${esc(why)}</button>`).join('')}</div>
      <div class="fgrid" style="margin-top:4px"><div><label class="lbl">Points</label><input class="field" id="gp" type="number" min="-50" max="50" step="1" placeholder="e.g. 2 or -1"></div>
        <div><label class="lbl">Reason</label><input class="field" id="gr" maxlength="200" placeholder="What it's for"></div></div>
      <p class="muted" style="font-size:12.5px;margin:8px 0 0">They'll see the points and the reason on their Points page.</p>
      <div class="err" id="ge"></div>
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">Give points</button></div>`,
      (el, close) => {
        el.querySelectorAll('.preset').forEach(b => b.onclick = () => { const [n, why] = PT_PRESETS[+b.dataset.i]; el.querySelector('#gp').value = n; el.querySelector('#gr').value = why;
          el.querySelectorAll('.preset').forEach(x => x.classList.toggle('on', x === b)); });
        el.querySelector('#ok').onclick = e => busy(e.target, async () => {
          const n = Math.round(Number(el.querySelector('#gp').value)), why = el.querySelector('#gr').value.trim();
          if (!n) throw new Error('Pick how many points (not 0).'); if (why.length < 2) throw new Error('Say what the points are for.');
          const r = await api('points_give', { user_id: el.querySelector('#gu').value, points: n, reason: why });
          close(); toast(`${n > 0 ? '+' : ''}${n} for ${r.name || 'them'}.`, 'ok'); if (S.page === 'points') pagePoints();
        }).catch(err => { el.querySelector('#ge').textContent = err.message; });
      });
  }

  // the Apoji account card on Profile: your Nexus look, the Apoji apps you use, where to change it
  async function apojiAccount() {
    const el = $('apojiAcct'); if (!el) return;
    let a = null;
    try { const { data, error } = await sb.rpc('apoji_account'); if (error) throw error; a = data; } catch { a = null; }
    if (!$('apojiAcct')) return;
    const NXC = window.NexusCosmetics, card = a?.card;
    const SURF = { mac: 'Nexus for Mac', windows: 'Nexus for Windows', linux: 'Nexus for Linux', phone: 'N28C', test_run: 'Test Run', admin: 'Apoji Admin', aargon3: 'aARgon3' };
    const apps = (a?.apps || []).map(x => `<span class="appchip" title="Last used ${fmtDate(x.seen_at)}">${esc(SURF[x.surface] || x.surface)}${x.version ? ` <small>${esc(x.version)}</small>` : ''}</span>`).join('');
    el.innerHTML = `<div class="card apoji-acct"><div class="aa-card">${card && NXC ? NXC.card({ ...card, self: true }, { size: 'mini' }) : avatar(S.me.name, S.me.color, 'lg', S.me.id)}</div>
      <div class="aa-body"><div class="kicker">Your Apoji account</div><h3>${esc(card?.style?.display_name || card?.nickname || S.me.name)}${card?.username ? ` <span class="muted mono" style="font-size:14px">@${esc(card.username)}</span>` : ''}</h3>
        <p class="muted">The same account signs you into Nexus, N28C, Test Run${S.me.level && S.me.level !== 'staff' ? ', Apoji Admin' : ''} and aARgon3. Your picture, frame and name come from Nexus.</p>
        ${apps ? `<div class="appchips">${apps}</div>` : ''}
        <div class="row" style="margin-top:10px"><a class="btn small" href="https://apojidelegraphics.github.io/Nexus-28/companion/" target="_blank" rel="noopener">${ic('external', 14)} Change it in Nexus</a>${a?.cirkts?.balance != null ? `<span class="muted" style="font-size:13px">${Number(a.cirkts.balance).toLocaleString()} Cirkts</span>` : ''}</div></div></div>`;
  }
  async function pageProfile() {
    const pg = $('pg');
    pg.innerHTML = '<div class="empty"><span class="spin"></span></div>';
    let p; try { p = await api('profile'); } catch (e) { pg.innerHTML = `<div class="empty-card">${esc(e.message)}</div>`; return; }
    if (S.page !== 'profile') return;
    const me = p.me || { name: S.me.name, email: S.me.email, role: S.me.role }, s = p.sales?.all_time || {};
    pg.innerHTML = `<div id="apojiAcct"></div><div class="card profhead">${avatar(me.name, me.color, 'lg', me.user_id || S.me.id)}<div style="flex:1;min-width:200px"><h3 style="margin:0;font-size:24px">${esc(me.name)}</h3>
        <div class="muted">${esc(me.title || roleName(me.role))} · ${esc(me.email)}</div><div class="row" style="margin-top:8px">${S.me.owner ? `<span class="pill vio">${ic('crown', 12)} OWNER</span>` : `<span class="pill info">${esc(roleName(me.role).toUpperCase())}</span>`}<span class="pill dim">NEXUS ${esc(String(S.me.level).toUpperCase())}</span></div></div></div>
      <div class="stats" style="margin-top:12px">
        <div class="card stat"><div class="k">Your sales, all time</div><div class="v">${big(s.revenue)}</div><div class="s">${s.orders || 0} orders</div></div>
        <div class="card stat"><div class="k">This month</div><div class="v">${big(p.sales?.this_month)}</div><div class="s">payments on your sales</div></div>
        <div class="card stat"><div class="k">This week</div><div class="v">${hm(S.state?.week_minutes || 0)}</div><div class="s">on the clock</div></div>
        <div class="card stat"><div class="k">Next shift</div><div class="v" style="font-size:20px">${nextShift() ? `${fmtDay(nextShift().starts_at)}` : '—'}</div><div class="s">${nextShift() ? `${fmtTime(nextShift().starts_at)}–${fmtTime(nextShift().ends_at)}` : 'nothing scheduled'}</div></div></div>
      <div class="grid2">
        <form class="card" id="pf"><h3>Your details</h3>
          <div class="fgrid"><div><label class="lbl">Name in aARgon3</label><input class="field" id="dn" value="${esc(me.display_name || '')}" placeholder="${esc(me.nexus_name || me.name)}"></div>
          <div><label class="lbl">Title</label><input class="field" id="ti" value="${esc(me.title || '')}" placeholder="e.g. Sales associate"></div>
          <div><label class="lbl">Phone</label><input class="field" id="ph" type="tel" value="${esc(me.phone || '')}"></div>
          <div><label class="lbl">Usual store</label><select class="field" id="ds">${storeOptions(me.default_store || '', true)}</select></div></div>
          <label class="lbl">Colour</label><div class="swatches" id="sw">${COLORS.map(c => `<button type="button" data-c="${c}" style="background:${c}" class="${(me.color || '') === c ? 'on' : ''}"></button>`).join('')}</div>
          <div class="acts"><button class="btn primary">Save</button></div></form>
        <div><form class="card" id="pw"><h3>${ic('key')} Change your password</h3><p class="muted" style="margin:0;font-size:13.5px">This is your Nexus account password, so it changes for Nexus '28 too.</p>
            <input class="field" id="p1" type="password" placeholder="New password (8+ characters)" autocomplete="new-password" style="margin-top:12px">
            <input class="field" id="p2" type="password" placeholder="Type it again" autocomplete="new-password" style="margin-top:8px">
            <div class="acts"><button class="btn">Change password</button></div></form>
          <div class="card" style="margin-top:12px"><div class="h-row"><h3>Time off</h3><span class="sp"></span><button class="btn small" id="ask">${ic('plus', 15)} Ask</button></div>
            <div class="people">${(p.timeoff || []).map(t => `<div class="person"><div><b>${fmtDate(t.starts_on)}${t.ends_on !== t.starts_on ? ` – ${fmtDate(t.ends_on)}` : ''}</b><small>${esc(t.reason || '')}${t.decided_by ? ` · by ${esc(t.decided_by)}` : ''}</small></div><div class="r">${statusPill(t.status)}${t.status === 'pending' ? ` <button class="btn quiet small" data-cancel="${t.id}">Cancel</button>` : ''}</div></div>`).join('') || '<p class="muted" style="margin:0">No requests.</p>'}</div></div></div></div>`;
    let color = me.color || '';
    $('sw').querySelectorAll('button').forEach(b => b.onclick = () => { color = b.dataset.c; $('sw').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
    $('pf').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
      await api('profile_save', { display_name: $('dn').value, title: $('ti').value, phone: $('ph').value, default_store: $('ds').value, color });
      await refresh(); toast('Saved.', 'ok'); pageProfile();
    }).catch(() => {}); };
    $('pw').onsubmit = e => { e.preventDefault();
      if ($('p1').value.length < 8) return toast('Use at least 8 characters.', 'bad');
      if ($('p1').value !== $('p2').value) return toast("The two passwords don't match.", 'bad');
      busy(e.submitter, async () => { const { error } = await sb.auth.updateUser({ password: $('p1').value }); if (error) throw error; $('p1').value = $('p2').value = ''; toast('Password changed.', 'ok'); }).catch(() => {}); };
    $('ask').onclick = timeOffSheet;
    pg.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => busy(b, async () => { await api('timeoff_decide', { id: Number(b.dataset.cancel), status: 'cancelled' }); pageProfile(); }).catch(() => {}));
    apojiAccount();
  }

  // ================================================================ Custom orders & Enterprise quotes (managers)
  let quoteFilter = '';
  async function pageQuotes() {
    const pg = $('pg');
    if (S.sale?.quote && S.sale.state !== 'paid') return paintPayment();
    pg.innerHTML = `<div class="h-row"><div class="seg" id="qf">${[['', 'All'], ['requested', 'Requests'], ['draft', 'Drafts'], ['sent', 'Sent'], ['paid', 'Paid'], ['cancelled', 'Cancelled']].map(([v, l]) => `<button data-v="${v}" class="${quoteFilter === v ? 'on' : ''}">${l}${v === 'requested' && S.requests ? ` <span class="cnt">${S.requests}</span>` : ''}</button>`).join('')}</div><span class="sp"></span>
      <button class="btn primary small" id="newq">${ic('plus', 15)} New custom order</button><button class="btn small" id="newe">${ic('building', 15)} Enterprise quote</button></div>
      <div class="card tblcard"><table class="tbl"><thead><tr><th>Quote</th><th>Customer</th><th>What</th><th class="num">Price</th><th>Status</th><th>Made</th></tr></thead><tbody id="rows"><tr><td colspan="6" class="empty"><span class="spin"></span></td></tr></tbody></table></div>
      <p class="muted" style="font-size:13px;margin-top:10px">Custom orders let you set the price, people, models and chip yourself, then send a payment link, an emailed invoice, or make it free. Enterprise quotes are custom orders on the Enterprise plan. Requests come from the Custom tab on the website: price one (Edit), then send it.</p>`;
    $('qf').querySelectorAll('button').forEach(b => b.onclick = () => { quoteFilter = b.dataset.v; pageQuotes(); });
    $('newq').onclick = () => quoteBuilder({ plan: 'business', tier: 'pro' });
    $('newe').onclick = () => quoteBuilder({ plan: 'enterprise', tier: 'pro', seats: 100 });
    let list; try { list = await api('quotes', { status: quoteFilter || null }); } catch (e) { $('rows') && ($('rows').innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`); return; }
    if (!$('rows')) return;
    $('rows').innerHTML = list.map(q => `<tr class="click" data-no="${esc(q.quote_no)}"><td class="id">${esc(q.quote_no)}</td><td>${esc(q.customer?.company || q.customer?.name || '—')}<div class="muted" style="font-size:12.5px">${esc(q.customer?.company ? q.customer?.name : q.customer?.email || '')}</div></td>
      <td>${esc(C.plans[q.plan]?.name || q.plan)} · ${esc(tierName(q.tier))}<div class="muted" style="font-size:12px">${q.seats ? `${q.seats} people · ` : ''}${(q.items || []).length} models</div></td>
      <td class="num">${q.status === 'requested' ? `<span class="muted">${q.request?.budget ? `budget ${money(q.request.budget)}` : 'to price'}</span>` : q.interval === 'free' ? '<span class="pill vio">FREE</span>' : `${money(q.amount)}<span class="muted">${q.interval === 'year' ? '/yr' : q.interval === 'once' ? ' once' : '/mo'}</span>`}</td>
      <td>${statusPill(q.status)}${q.delivery ? `<div class="muted" style="font-size:11.5px">${q.delivery === 'invoice' ? 'invoice' : q.delivery === 'link' ? 'payment link' : ''}</div>` : ''}</td><td class="muted">${fmtWhen(q.created_at)}<div style="font-size:11.5px">${esc(q.created_by || '')}</div></td></tr>`).join('')
      || `<tr><td colspan="6" class="empty">No ${quoteFilter || ''} custom orders yet.</td></tr>`;
    $('rows').querySelectorAll('tr.click').forEach(r => r.onclick = () => quoteView(list.find(q => q.quote_no === r.dataset.no)));
  }
  function quoteBuilder(q) {
    const pg = $('pg');
    const st = { plan: q.plan || 'business', tier: q.tier || 'pro', seats: q.seats || null, interval: q.interval || 'month', amount: q.status === 'requested' ? null : q.amount ?? null, os: q.config?.os || C.os[0].id,
      connection: q.config?.connection || C.connections[0].id, chip: q.config?.chip || null, models: q.items ? q.items.map(i => i.model) : null, customer: q.customer || {}, notes: q.notes || '',
      valid_until: q.valid_until || ymd(new Date(Date.now() + 30 * 864e5)) };
    const suggest = () => st.plan === 'enterprise' ? A3.enterpriseSuggest(st.tier, st.seats, st.interval === 'year' ? 'year' : 'month') : st.interval === 'once' ? price(st.plan, st.tier, 'year').amount : price(st.plan, st.tier, st.interval === 'year' ? 'year' : 'month').amount ?? 0;
    function draw() {
      const defSeats = price(st.plan, st.tier, 'month').seats, defModels = A3.items(st.tier).map(i => i.model);
      const models = st.models || defModels, chip = st.chip || C.tiers[st.tier].chip;
      pg.innerHTML = `<div class="h-row"><button class="btn quiet small" id="back">${ic('left', 15)} Custom orders</button><h3>${q.status === 'requested' ? `Price ${esc(q.quote_no)}` : q.quote_no ? `Edit ${esc(q.quote_no)}` : st.plan === 'enterprise' ? 'New Enterprise quote' : 'New custom order'}</h3></div>
        <div class="builder"><div class="card">
          <div class="row" style="justify-content:space-between"><div class="seg" id="pl">${PLANS.map(p => `<button data-v="${p}" class="${p === st.plan ? 'on' : ''}">${esc(C.plans[p].name)}</button>`).join('')}</div>
            <div class="seg" id="iv">${[['month', 'Monthly'], ['year', 'Yearly'], ['once', 'One time'], ['free', 'Free']].map(([v, l]) => `<button data-v="${v}" class="${st.interval === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          <label class="lbl">Tier</label><div class="seg" id="tr">${TIERS.map(t => `<button data-v="${t}" class="${t === st.tier ? 'on' : ''}">${esc(C.tiers[t].name)}</button>`).join('')}</div>
          <div class="grid3"><div><label class="lbl">People</label><input class="field" id="seats" type="number" min="1" value="${st.seats ?? defSeats ?? ''}" placeholder="${defSeats ?? 'No limit'}"></div>
            <div><label class="lbl">Price ${st.interval === 'free' ? '' : `(${st.interval === 'year' ? 'a year' : st.interval === 'once' ? 'one time' : 'a month'})`}</label><div class="money-in"><input class="field" id="amt" type="number" min="0.5" step="0.01" value="${st.interval === 'free' ? '' : st.amount ?? ''}" ${st.interval === 'free' ? 'disabled placeholder="Free"' : `placeholder="${suggest()}"`}></div></div>
            <div><label class="lbl">&nbsp;</label><button class="btn block" id="sug" ${st.interval === 'free' ? 'disabled' : ''}>Use ${money(suggest())}</button></div></div>
          <div class="grid3"><div><label class="lbl">Quouk chip</label><select class="field" id="chip">${C.chips.filter(c => c.id !== 'No order').map(c => `<option ${c.id === chip ? 'selected' : ''}>${esc(c.id)}</option>`).join('')}</select></div>
            <div><label class="lbl">LentOS</label><select class="field" id="os">${C.os.map(o => `<option ${o.id === st.os ? 'selected' : ''}>${esc(o.id)}</option>`).join('')}</select></div>
            <div><label class="lbl">Connection</label><select class="field" id="conn">${C.connections.map(o => `<option ${o.id === st.connection ? 'selected' : ''}>${esc(o.id)}</option>`).join('')}</select></div></div>
          <label class="lbl">Models on the order <a href="#" id="resetM" style="text-transform:none;letter-spacing:0;font-weight:400">(reset to ${esc(C.tiers[st.tier].name)}'s)</a></label>
          <div class="models" id="mods">${Object.keys(C.families).filter(f => !C.families[f].free).map(f => `<div class="fam"><b>${esc(C.families[f].name)}</b><div class="chk">${C.families[f].models.map(m => `<label><input type="checkbox" value="${esc(m)}" ${models.includes(m) ? 'checked' : ''}>${esc(m)}</label>`).join('')}</div></div>`).join('')}</div>
          <div class="sect-title">${st.plan === 'enterprise' ? 'Corporate entity and lead operator' : st.plan === 'business' ? 'Business and the person placing the order' : 'Customer'}</div>
          <div id="cust">${window.A3forms.html(st.plan, st.customer)}</div>
          <div class="grid2"><div><label class="lbl">Good until</label><input class="field" id="vu" type="date" value="${st.valid_until}"></div><div></div></div>
          <label class="lbl">Notes (on the order, staff only)</label><textarea class="field" id="nt" rows="2">${esc(st.notes)}</textarea>
        </div>
        <div class="card summary" id="qsum"></div></div>`;
      const keep = () => { st.customer = window.A3forms.values($('cust')); st.notes = $('nt').value; st.valid_until = $('vu').value; const v = $('amt').value; st.amount = v === '' ? null : Number(v); st.seats = $('seats').value ? Number($('seats').value) : null; };
      const seg = (id, key, reset) => $(id).querySelectorAll('button').forEach(b => b.onclick = () => { keep(); st[key] = b.dataset.v; if (reset) reset(); draw(); });
      seg('pl', 'plan', () => { st.seats = null; }); seg('iv', 'interval'); seg('tr', 'tier', () => { st.models = null; st.chip = null; });
      $('chip').onchange = e => { st.chip = e.target.value; sum(); }; $('os').onchange = e => { st.os = e.target.value; }; $('conn').onchange = e => { st.connection = e.target.value; };
      $('mods').onchange = () => { st.models = [...$('mods').querySelectorAll('input:checked')].map(i => i.value); sum(); };
      $('resetM').onclick = e => { e.preventDefault(); keep(); st.models = null; draw(); };
      $('sug').onclick = () => { $('amt').value = suggest(); keep(); sum(); };
      ['seats', 'amt'].forEach(id => $(id).oninput = () => { keep(); sum(); });
      $('back').onclick = () => go('quotes');
      window.A3forms.wire($('cust'), { os: () => st.os, region: () => storeRegion(myStore()) });
      sum();
    }
    function sum() {
      const models = st.models || A3.items(st.tier).map(i => i.model), chip = st.chip || C.tiers[st.tier].chip, seats = st.seats ?? price(st.plan, st.tier, 'month').seats;
      const amt = st.interval === 'free' ? 0 : Number($('amt').value) || 0, list = price(st.plan, st.tier, st.interval === 'year' ? 'year' : 'month');
      $('qsum').innerHTML = `<h3>${esc(C.plans[st.plan].name)} · ${esc(C.tiers[st.tier].name)}</h3>
        <div class="line"><span>People</span><span>${seats ?? 'No limit'}</span></div><div class="line"><span>Chip</span><span>${esc(chip)}</span></div>
        <div class="line"><span>Models</span><span>${models.length}</span></div><div class="line"><span>Billing</span><span>${{ month: 'Monthly', year: 'Yearly', once: 'One time', free: 'Free' }[st.interval]}</span></div>
        ${!list.quote && st.interval !== 'free' && st.interval !== 'once' && amt ? `<div class="line"><span>Store price</span><span>${money(list.amount)}</span></div>` : ''}
        <div class="total"><span class="muted">Price</span><b>${st.interval === 'free' ? 'Free' : money(amt)}${st.interval === 'month' || st.interval === 'year' ? `<span class="muted" style="font-size:14px;font-weight:500">/${st.interval === 'year' ? 'yr' : 'mo'}</span>` : ''}</b></div>
        <button class="btn primary block" id="save">${q.quote_no ? 'Save changes' : 'Save and continue'}</button>
        <p class="muted" style="font-size:12.5px;margin:10px 0 0">Next you'll choose how to send it: a payment link (QR), an emailed Stripe invoice${st.interval === 'free' ? ', or create it free right away' : ''}.</p>`;
      $('save').onclick = e => {
        let customer; try { customer = window.A3forms.read($('cust'), st.plan); } catch (err) { return toast(err.message, 'bad'); }
        if (!(st.models || A3.items(st.tier)).length) return toast('Pick at least one model.', 'bad');
        busy(e.target, async () => {
          const r = await api('quote_save', { quote_no: q.quote_no, plan: st.plan, tier: st.tier, seats: $('seats').value || null, interval: st.interval, amount: st.interval === 'free' ? 0 : Number($('amt').value),
            models: st.models || A3.items(st.tier).map(i => i.model), chip: $('chip').value, os: $('os').value, connection: $('conn').value, customer, notes: $('nt').value, valid_until: $('vu').value });
          toast(`${r.quote_no} saved.`, 'ok'); quoteView(r);
        }).catch(() => {});
      };
    }
    draw();
  }
  function salesExtras() {
    const need = e => `<p class="muted" style="margin:0">${/function|not find|2\.4/i.test(e.message) ? 'Needs the 2.4 database update.' : esc(e.message)}</p>`;
    if ($('refs')) api('referrals').then(l => { const el = $('refs'); if (!el) return;
      el.innerHTML = `<h3>${ic('gift')} Referrals <small>${l.length}</small></h3><div class="split">${l.slice(0, 8).map(r => `<div class="r"><span><span class="mono">${esc(r.code)}</span> <span class="muted">· ${esc(r.referrer_name || r.referrer_order)} → ${esc(r.new_order)}</span></span><span>${r.status === 'credited' ? money(r.credit_cents / 100) : `<span class="pill ${r.status === 'limit' ? 'dim' : 'warn'}">${esc(r.status)}</span>`}</span></div>`).join('') || '<p class="muted" style="margin:0">No referrals yet. Every order gets a code to share.</p>'}</div>`; })
      .catch(e => { const el = $('refs'); if (el) el.innerHTML = `<h3>${ic('gift')} Referrals</h3>${need(e)}`; });
    if ($('abd')) api('abandoned').then(l => { const el = $('abd'); if (!el) return;
      el.innerHTML = `<h3>${ic('mail')} Checkout reminders <small>${l.filter(a => a.recovered).length} came back</small></h3><div class="split">${l.slice(0, 8).map(a => `<div class="r"><span>${esc(a.email)} <span class="muted">· ${esc(a.label || '')}</span></span><span>${a.recovered ? '<span class="pill ok">BOUGHT</span>' : a.emailed_at ? '<span class="pill info">REMINDED</span>' : `<span class="pill bad" title="${esc(a.email_error || '')}">NOT SENT</span>`}</span></div>`).join('') || '<p class="muted" style="margin:0">Only people who tick "remind me" at checkout get one email if they don\'t finish.</p>'}</div>`; })
      .catch(e => { const el = $('abd'); if (el) el.innerHTML = `<h3>${ic('mail')} Checkout reminders</h3>${need(e)}`; });
  }
  function quoteView(q) {
    const c = q.customer || {}, pg = $('pg');
    pg.innerHTML = `<div class="h-row"><button class="btn quiet small" id="back">${ic('left', 15)} Custom orders</button><h3 class="mono">${esc(q.quote_no)}</h3>${statusPill(q.status)}<span class="sp"></span>
      ${q.status === 'draft' || q.status === 'requested' ? `<button class="btn small ${q.status === 'requested' ? 'primary' : ''}" id="edit">${ic('edit', 15)} ${q.status === 'requested' ? 'Price it' : 'Edit'}</button>` : ''}${q.status !== 'paid' && q.status !== 'cancelled' ? `<button class="btn small danger" id="cq">Cancel quote</button>` : ''}</div>
      <div class="grid2"><div class="card"><h3>${esc(C.plans[q.plan]?.name)} · ${esc(tierName(q.tier))}</h3><div class="kv">
        <span>Price</span><span>${q.status === 'requested' ? '<span class="pill info">NOT PRICED YET</span>' : `<b>${q.interval === 'free' ? 'Free' : money(q.amount)}</b>${q.interval === 'year' ? ' a year' : q.interval === 'month' ? ' a month' : q.interval === 'once' ? ' one time' : ''}`}</span>
        <span>People</span><span>${q.seats ?? 'No limit'}</span><span>System</span><span>${esc([q.config?.os, q.config?.chip, q.config?.connection].filter(Boolean).join(' · '))}</span>
        <span>Good until</span><span>${q.valid_until ? fmtDate(q.valid_until) : '—'}</span><span>Made by</span><span>${esc(q.created_by || '—')} · ${fmtWhen(q.created_at)}</span>
        ${q.order_id ? `<span>Order</span><span class="mono">${esc(q.order_id)}</span>` : ''}${q.notes ? `<span>Notes</span><span>${esc(q.notes)}</span>` : ''}</div>
        <label class="lbl">Models</label><div class="chips">${(q.items || []).map(i => `<span>${esc(i.model)}</span>`).join('')}</div></div>
      <div class="card"><h3>${esc(c.company || c.name || 'Customer')}</h3><div class="kv">${c.company ? `<span>Contact</span><span>${esc(c.name)}${c.title ? ` · ${esc(c.title)}` : ''}</span>` : ''}
        <span>Email</span><span>${esc(c.email || '—')}</span>${c.phone ? `<span>Phone</span><span>${esc(c.phone)}</span>` : ''}${c.billing_email ? `<span>Billing email</span><span>${esc(c.billing_email)}</span>` : ''}
        ${c.node ? `<span>Node</span><span class="mono">${esc(c.node)}</span>` : ''}${c.jurisdiction ? `<span>Jurisdiction</span><span>${esc(c.jurisdiction)}</span>` : ''}</div></div></div>
      ${q.request ? `<div class="card req" style="margin-top:12px"><h3>${ic('sparkles')} What they asked for <small>from the website · ${fmtWhen(q.request.at || q.created_at)}</small></h3><div class="kv">
        <span>Budget</span><span>${q.request.budget ? `${money(q.request.budget)} ${q.request.interval === 'year' ? 'a year' : q.request.interval === 'once' ? 'one time' : 'a month'}` : 'Not given'}</span>
        <span>Billing</span><span>${q.request.interval === 'year' ? 'Yearly' : q.request.interval === 'once' ? 'One payment' : 'Monthly'}</span>
        <span>People</span><span>${esc(q.request.seats ?? q.seats ?? '—')}</span>${q.request.notes ? `<span>Their notes</span><span style="white-space:pre-wrap">${esc(q.request.notes)}</span>` : ''}</div></div>` : ''}
      <div class="card" style="margin-top:12px" id="sendBox"></div>`;
    $('back').onclick = () => go('quotes');
    $('edit') && ($('edit').onclick = () => quoteBuilder(q));
    $('cq') && ($('cq').onclick = async () => {
      if (!(await confirmSheet('Cancel this quote?', q.stripe_invoice_id || q.delivery === 'invoice' ? 'Its Stripe invoice is voided, so it can no longer be paid.' : 'Its payment link stops being tracked here.', 'Cancel quote', true))) return;
      const r = await api('quote_cancel', { quote_no: q.quote_no }).catch(e => { toast(e.message, 'bad'); return null; }); if (r) { toast('Quote cancelled.'); quoteView(r); }
    });
    const box = $('sendBox');
    if (q.status === 'paid') { box.innerHTML = `<h3 style="color:var(--mint)">✓ Paid</h3><p class="muted" style="margin:0">Order <span class="mono">${esc(q.order_id || '')}</span>. Find it in Orders.</p>`; return; }
    if (q.status === 'cancelled') { box.innerHTML = '<h3>Cancelled</h3><p class="muted" style="margin:0">Make a new custom order if they still want it.</p>'; return; }
    if (q.status === 'requested') { box.innerHTML = `<h3>Price it, then send it</h3><p class="muted" style="margin:0 0 12px">Nothing has been charged. Set the price (and change anything else), save, and you can send a payment link or an invoice to ${esc(c.email || 'them')}. Not doing it? Cancel the quote.</p><button class="btn primary" id="price">${ic('edit', 15)} Price it</button>`;
      $('price').onclick = () => quoteBuilder(q); return; }
    box.innerHTML = q.interval === 'free' ? `<h3>Create it</h3><p class="muted">This custom order is free: it becomes a working order right away (logged under your name).</p><button class="btn primary" id="sf">${ic('gift', 15)} Create free order</button>`
      : `<h3>${q.status === 'sent' ? 'Sent' : 'Send it'}</h3>${q.status === 'sent' && q.url ? `<p class="muted" style="margin:0 0 10px">${q.delivery === 'invoice' ? 'Stripe emailed an invoice. It turns into an order when it\'s paid.' : 'A payment link was made.'} <a href="${esc(q.url)}" target="_blank" rel="noopener">${q.delivery === 'invoice' ? 'Open the invoice' : 'Open the link'} ${ic('external', 13)}</a></p>` : ''}
        <div class="grid2"><div class="card" style="background:var(--panel2)"><b>${ic('qr')} Payment link</b><p class="muted" style="font-size:13.5px">A Stripe checkout with a QR code. Good when they're with you, or to text them.</p><button class="btn primary" id="sl">Make payment link</button></div>
        <div class="card" style="background:var(--panel2)"><b>${ic('mail')} Email an invoice</b><p class="muted" style="font-size:13.5px">Stripe emails ${esc(c.billing_email || c.email || 'them')} an invoice${q.interval === 'once' ? '' : ' every ' + (q.interval === 'year' ? 'year' : 'month')}.</p>
          <div class="row"><select class="field" id="due" style="width:auto"><option value="7">Due in 7 days</option><option value="15">Due in 15 days</option><option value="30" selected>Due in 30 days</option><option value="60">Due in 60 days</option></select><button class="btn" id="si">Send invoice</button></div></div></div>`;
    $('sf') && ($('sf').onclick = e => busy(e.target, async () => { const r = await api('quote_send', { quote_no: q.quote_no }); toast(`Order ${r.order_id} created.`, 'ok'); quoteView({ ...q, status: 'paid', order_id: r.order_id }); }).catch(() => {}));
    $('sl') && ($('sl').onclick = e => busy(e.target, async () => {
      const r = await api('quote_send', { quote_no: q.quote_no, delivery: 'link' });
      S.sale = { ...r, quote: q.quote_no, amount: q.amount, interval: q.interval, sel: { plan: q.plan, tier: q.tier }, customer: c, state: 'waiting', started: Date.now() };
      paintPayment(); pollSale();
    }).catch(() => {}));
    $('si') && ($('si').onclick = e => busy(e.target, async () => {
      const r = await api('quote_send', { quote_no: q.quote_no, delivery: 'invoice', days_until_due: Number($('due').value) });
      toast(`Invoice sent to ${r.email}.`, 'ok'); quoteView({ ...q, status: 'sent', delivery: 'invoice', url: r.url });
    }).catch(() => {}));
  }

  // ================================================================ Promotions (managers)
  // ================================================================ Promotions: codes (typed in) and deals (automatic)
  let promoTab = 'codes';
  async function pagePromos() {
    const pg = $('pg');
    pg.innerHTML = `<div class="h-row"><div class="seg" id="ptab"><button data-v="codes" class="${promoTab === 'codes' ? 'on' : ''}">Codes</button><button data-v="deals" class="${promoTab === 'deals' ? 'on' : ''}">Deals</button></div>
        <span class="sp"></span>${promoTab === 'codes' ? `<button class="btn small" id="gen">${ic('sparkles', 15)} Code generator</button><button class="btn primary small" id="np">${ic('plus', 15)} New code</button>`
          : `<button class="btn small" id="dgen">${ic('sparkles', 15)} Deal generator</button><button class="btn primary small" id="nd">${ic('plus', 15)} New deal</button>`}</div>
      <p class="muted" style="margin:0 0 12px;font-size:13.5px">${promoTab === 'codes' ? 'Codes customers type in the store, or you apply in New sale. Each one is a Stripe coupon. Codes switch themselves off when they expire or run out.'
        : 'Deals apply on their own, no code needed, and show on the home page. A price deal doesn\'t stack with a code (the customer gets one discount); bonus models, chip upgrades and extra people always apply.'}</p>
      <div id="old"></div>
      <div class="card tblcard"><table class="tbl"><thead>${promoTab === 'codes' ? '<tr><th>Code</th><th>Discount</th><th>Works on</th><th class="num">Used</th><th>Ends</th><th>Status</th><th></th></tr>'
        : '<tr><th>Deal</th><th>Gives</th><th>Works on</th><th class="num">Used</th><th>Ends</th><th>Status</th><th>Home page</th><th></th></tr>'}</thead><tbody id="rows"><tr><td colspan="8" class="empty"><span class="spin"></span></td></tr></tbody></table></div>`;
    $('ptab').querySelectorAll('button').forEach(b => b.onclick = () => { promoTab = b.dataset.v; pagePromos(); });
    const works = x => esc([(x.plans || []).map(p => C.plans[p]?.name || p).join(', ') || 'All plans', (x.tiers || []).map(tierName).join(', ') || 'all tiers',
      ...(x.billing?.length ? [x.billing.map(b => b === 'year' ? 'yearly' : 'monthly').join('/')] : [])].join(' · '));
    const state = x => x.old && x.active ? '<span class="pill warn" title="Bring it over to make it work at checkout">OLD CODE</span>' : x.live ? '<span class="pill ok">LIVE</span>' : x.ended_reason === 'expired' ? '<span class="pill dim" title="Switched off automatically">EXPIRED</span>'
      : x.ended_reason === 'used up' ? '<span class="pill dim" title="Switched off automatically">USED UP</span>' : x.old ? '<span class="pill warn">OLD CODE</span>' : x.active ? '<span class="pill warn">NOT STARTED</span>' : '<span class="pill dim">OFF</span>';
    if (promoTab === 'deals') {
      $('nd').onclick = () => dealSheet();
      $('dgen').onclick = dealGeneratorSheet;
      let list; try { list = await api('deals'); } catch (e) { $('rows') && ($('rows').innerHTML = `<tr><td colspan="8" class="empty">${esc(/function|not find|2\.5/i.test(e.message) ? 'Deals need the 2.5 database update.' : e.message)}</td></tr>`); return; }
      if (!$('rows')) return;
      $('rows').innerHTML = list.map(d => `<tr><td><b>${esc(d.headline)}</b><div class="muted" style="font-size:12px">${esc([d.name !== d.headline ? d.name : '', d.created_by].filter(Boolean).join(' · '))}</div></td>
        <td>${esc(dealText(d))}</td><td class="muted">${works(d)}</td><td class="num">${d.used_count}${d.usage_limit ? ` / ${d.usage_limit}` : ''}</td><td class="muted">${d.ends_at ? fmtDate(d.ends_at) : 'Never'}</td>
        <td>${state(d)}</td><td><label class="switch" title="Show on the home page"><input type="checkbox" data-f="${d.id}" ${d.featured ? 'checked' : ''}></label></td>
        <td class="num"><span class="rowacts"><button class="cp" data-edit="${d.id}" title="Edit">${ic('edit', 14)}</button><label class="switch" title="On / off"><input type="checkbox" data-id="${d.id}" ${d.active ? 'checked' : ''}></label></span></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No deals yet. Try "2 models for the price of one" for a weekend.</td></tr>';
      $('rows').querySelectorAll('input[data-id]').forEach(i => i.onchange = () => busy(null, async () => { await api('deal_save', { id: Number(i.dataset.id), active: i.checked }); toast(i.checked ? 'Deal on.' : 'Deal off.'); pagePromos(); }).catch(() => { i.checked = !i.checked; }));
      $('rows').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => dealSheet({}, list.find(d => d.id === Number(b.dataset.edit))));
      $('rows').querySelectorAll('input[data-f]').forEach(i => i.onchange = () => busy(null, async () => { await api('deal_save', { id: Number(i.dataset.f), featured: i.checked }); toast(i.checked ? 'Shown on the home page.' : 'Hidden from the home page (still applies).'); }).catch(() => { i.checked = !i.checked; }));
      return;
    }
    $('np').onclick = () => promoSheet({});
    $('gen').onclick = generatorSheet;
    let list; try { list = await api('promos'); } catch (e) { $('rows') && ($('rows').innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`); return; }
    if (!$('rows')) return;
    const old = list.filter(x => x.old && x.active);
    if (old.length) $('old').innerHTML = `<div class="banner">${ic('warning')}<div><b>${old.length} old code${old.length === 1 ? '' : 's'} from the old aARgon3</b> (${old.slice(0, 4).map(x => esc(x.code)).join(', ')}${old.length > 4 ? '…' : ''}) ${old.length === 1 ? "doesn't" : "don't"} work at checkout yet.</div><span style="flex:1"></span><button class="btn small primary" id="upg">Bring them over</button></div>`;
    $('upg') && ($('upg').onclick = e => busy(e.target, async () => {
      const r = await api('promo_upgrade');
      sheet(`<div class="kicker">Old codes</div><h3>${r.filter(x => x.live).length} of ${r.length} work now</h3><div class="ulist">${r.map(x => `<div class="r"><span class="mono">${esc(x.code)}</span><span class="${x.error ? 'err' : x.live ? '' : 'muted'}">${esc(x.result)}</span></div>`).join('')}</div>
        <div class="acts"><button class="btn primary" data-close>Done</button></div>`);
      pagePromos();
    }).catch(() => {}));
    const batches = {};
    $('rows').innerHTML = list.map(x => `<tr><td class="id"><span class="codecell"><span>${esc(x.code)}</span><button class="cp" data-copy="${esc(x.code)}" title="Copy">${ic('copy', 14)}</button></span>
        <div class="muted" style="font-size:11.5px;font-family:var(--sans)">${esc(x.created_by || (x.old ? 'old aARgon3' : ''))}${x.batch ? ` · batch ${esc(x.batch)}` : ''}</div></td><td>${esc(x.description || '')}</td>
      <td class="muted">${works(x)}${Number(x.min_total) ? ` · over ${money(x.min_total)}` : ''}</td>
      <td class="num">${x.used}${x.limit ? ` / ${x.limit}` : ''}</td><td class="muted">${x.ends ? fmtDate(x.ends) : 'Never'}</td><td>${state(x)}</td>
      <td class="num">${x.old ? '' : `<span class="rowacts"><button class="cp" data-edit="${x.id}" title="Edit">${ic('edit', 14)}</button><label class="switch" title="On / off"><input type="checkbox" data-id="${x.id}" ${x.active ? 'checked' : ''}></label></span>`}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No codes yet. Try the code generator.</td></tr>';
    $('rows').querySelectorAll('[data-copy]').forEach(b => b.onclick = e => { e.stopPropagation(); copy(b.dataset.copy, `Copied ${b.dataset.copy}`); });
    $('rows').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => promoSheet({}, list.find(x => x.id === Number(b.dataset.edit))));
    $('rows').querySelectorAll('input[data-id]').forEach(i => i.onchange = () => busy(null, async () => { await api('promo_save', { id: Number(i.dataset.id), active: i.checked }); toast(i.checked ? 'Code on.' : 'Code off.'); pagePromos(); }).catch(() => { i.checked = !i.checked; }));
    if (list.some(x => x.edited_at)) $('rows').querySelectorAll('tr').forEach((tr, n) => { const x = list[n]; if (x?.edited_at) tr.title = `Edited ${fmtDate(x.edited_at)}${x.edited_by ? ` by ${x.edited_by}` : ''}`; });
  }
  const dealText = d => d.kind === 'percent' ? `${Number(d.value)}% off ${d.duration === 'forever' ? 'every payment' : d.duration === 'repeating' ? `for ${d.duration_months} months` : 'the first payment'}`
    : d.kind === 'amount' ? `${money(Number(d.value))} off ${d.duration === 'forever' ? 'every payment' : d.duration === 'repeating' ? `for ${d.duration_months} months` : 'the first payment'}`
    : d.kind === 'models' ? `Free: ${(d.models || []).join(', ')}` : d.kind === 'chip' ? `Chip: ${d.chip}` : `+${Number(d.value)} people`;

  // ---------- the code generator: season, month or occasion → code ideas and dates
  const OCCASIONS = {
    '': { label: 'None', words: [] },
    blackfriday: { label: 'Black Friday', words: ['BLACKFRIDAY', 'BF', 'BFRIDAY'], dates: y => { const t = thanksgiving(y); return [addD(t, 1), addD(t, 3)]; } },
    cybermonday: { label: 'Cyber Monday', words: ['CYBERMONDAY', 'CYBER', 'CM'], dates: y => { const t = thanksgiving(y); return [addD(t, 4), addD(t, 5)]; } },
    thanksgiving: { label: 'Thanksgiving', words: ['THANKS', 'GRATEFUL', 'TURKEY'], dates: y => { const t = thanksgiving(y); return [addD(t, -3), t]; } },
    holiday: { label: 'Holidays', words: ['HOLIDAY', 'MERRY', 'GIFT'], dates: y => [`${y}-12-01`, `${y}-12-31`] },
    christmas: { label: 'Christmas', words: ['XMAS', 'MERRY', 'JOLLY'], dates: y => [`${y}-12-15`, `${y}-12-25`] },
    newyear: { label: 'New Year', words: ['NEWYEAR', 'NY', 'FRESHSTART'], dates: y => [`${y}-12-26`, `${y + 1}-01-07`], yearShift: 1 },
    valentines: { label: "Valentine's Day", words: ['LOVE', 'VALENTINE', 'HEART'], dates: y => [`${y}-02-07`, `${y}-02-14`] },
    springbreak: { label: 'Spring break', words: ['SPRINGBREAK', 'BREAK'], dates: y => [`${y}-03-01`, `${y}-03-31`] },
    backtoschool: { label: 'Back to school', words: ['BACK2SCHOOL', 'SCHOOL', 'STUDY'], dates: y => [`${y}-08-01`, `${y}-09-15`] },
    halloween: { label: 'Halloween', words: ['SPOOKY', 'HALLOWEEN', 'BOO'], dates: y => [`${y}-10-24`, `${y}-10-31`] },
    launch: { label: 'Launch / new release', words: ['LAUNCH', 'NEW', 'HELLO'], dates: () => [ymd(new Date()), addD(ymd(new Date()), 14)] },
    birthday: { label: 'aARgon3 birthday', words: ['BIRTHDAY', 'BDAY', 'PARTY'], dates: () => [ymd(new Date()), addD(ymd(new Date()), 7)] },
  };
  const SEASONS = { '': ['', null], winter: ['Winter', ['WINTER', 'SNOW', 'FROST']], spring: ['Spring', ['SPRING', 'BLOOM']], summer: ['Summer', ['SUMMER', 'SUNNY', 'HEATWAVE']], fall: ['Fall', ['FALL', 'AUTUMN', 'HARVEST']] };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const addD = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const thanksgiving = y => { const d = new Date(Date.UTC(y, 10, 1)); const first = (4 - d.getUTCDay() + 7) % 7 + 1; return `${y}-11-${String(first + 21).padStart(2, '0')}`; };
  const seasonDates = (s, y) => ({ winter: [`${y}-12-21`, `${y + 1}-03-19`], spring: [`${y}-03-20`, `${y}-06-20`], summer: [`${y}-06-21`, `${y}-09-22`], fall: [`${y}-09-23`, `${y}-12-20`] }[s]);
  function codeIdeas({ occasion, season, month, year, value, type }) {
    const yy = String(year).slice(-2), num = type === 'fixed' ? `${Math.round(value)}OFF` : `${Math.round(value)}`;
    const words = [...(OCCASIONS[occasion]?.words || []), ...(SEASONS[season]?.[1] || [])];
    const out = [];
    const oy = OCCASIONS[occasion]?.yearShift ? String(year + 1).slice(-2) : yy;
    for (const w of words.slice(0, 4)) out.push(`${w}${OCCASIONS[occasion]?.words.includes(w) ? oy : yy}`, `${w}${num}`, `${w}-${oy || yy}-${num}`);
    if (month !== '') { const m = MONTHS[+month].toUpperCase(); out.push(`${m.slice(0, 3)}${yy}`, `${m}${num}`, `${m.slice(0, 3)}-SAVE${num.replace('OFF', '')}`); }
    if (!out.length) out.push(`SAVE${num}`, `APOJI${num}`, `ARGON${yy}`);
    return [...new Set(out.map(c => c.replace(/[^A-Z0-9_-]/g, '')).filter(c => c.length >= 3 && c.length <= 24))].slice(0, 9);
  }
  // dates for an occasion, season or month (the code and deal generators share this)
  function periodDates({ occasion, season, month, year }) {
    const o = OCCASIONS[occasion];
    const d = o?.dates ? o.dates(year) : season ? seasonDates(season, year) : month !== '' ? [`${year}-${String(+month + 1).padStart(2, '0')}-01`, ymd(new Date(year, +month + 1, 0))] : null;
    if (d && d[0] < ymd(new Date())) d[0] = ymd(new Date());
    return d;
  }
  const periodName = ({ occasion, season, month }) => occasion ? OCCASIONS[occasion].label : season ? SEASONS[season][0] : month !== '' ? MONTHS[+month] : '';
  const dayStart = d => d ? new Date(d + 'T00:00').toISOString() : null, dayEnd = d => d ? new Date(d + 'T23:59').toISOString() : null;
  // only the fields that changed, so an edit doesn't touch Stripe unless it has to
  const changes = (init, now) => Object.fromEntries(Object.entries(now).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(init[k])));
  function generatorSheet() {
    const now = new Date(), y0 = now.getFullYear();
    const st = { occasion: now.getMonth() === 10 ? 'blackfriday' : '', season: '', month: '', year: y0, value: 20, type: 'percentage', code: '', starts: '', ends: '', count: 1 };
    sheet(`<div class="kicker">Promotions</div><h3>Code generator</h3>
      <p class="muted" style="margin:4px 0 0;font-size:13.5px">Pick an occasion, season or month. You get code ideas and the dates filled in.</p>
      <div class="grid2" style="margin-top:6px"><div><label class="lbl">Occasion</label><select class="field" id="go">${Object.entries(OCCASIONS).map(([k, o]) => `<option value="${k}" ${k === st.occasion ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
        <div><label class="lbl">Season</label><select class="field" id="gs">${Object.entries(SEASONS).map(([k, s]) => `<option value="${k}">${esc(s[0] || 'None')}</option>`).join('')}</select></div>
        <div><label class="lbl">Month</label><select class="field" id="gm"><option value="">None</option>${MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('')}</select></div>
        <div><label class="lbl">Year</label><input class="field" id="gy" type="number" min="${y0}" max="${y0 + 3}" value="${y0}"></div></div>
      <div class="grid2"><div><label class="lbl">Discount</label><div class="row"><input class="field" id="gv" type="number" min="1" style="flex:1" value="20"><select class="field" id="gt" style="width:auto"><option value="percentage">% off</option><option value="fixed">$ off</option></select></div></div>
        <div><label class="lbl">How many codes</label><select class="field" id="gc"><option value="1">One shared code</option>${[5, 10, 25, 50].map(n => `<option value="${n}">${n} single-use codes</option>`).join('')}</select></div></div>
      <label class="lbl">Ideas <span style="opacity:.6">(tap one)</span></label><div class="ideas" id="gi"></div>
      <label class="lbl" id="gcl">Code</label><input class="field mono" id="gcode" style="text-transform:uppercase" maxlength="30">
      <div class="grid2"><div><label class="lbl">Starts</label><input class="field" id="gst" type="date"></div><div><label class="lbl">Ends</label><input class="field" id="gen2" type="date"></div></div>
      <p class="muted" id="gnote" style="font-size:12.5px;margin:8px 0 0"></p>
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn" id="more">More options…</button><button class="btn primary" id="ok">${ic('sparkles', 15)} Create</button></div>`,
      (el, close) => {
        const q = x => el.querySelector(x);
        const paint = () => {
          Object.assign(st, { occasion: q('#go').value, season: q('#gs').value, month: q('#gm').value, year: Number(q('#gy').value) || y0, value: Number(q('#gv').value) || 0, type: q('#gt').value, count: Number(q('#gc').value) });
          const ideas = codeIdeas(st);
          q('#gi').innerHTML = ideas.map(c => `<button type="button" class="idea ${c === st.code ? 'on' : ''}">${esc(c)}</button>`).join('');
          q('#gi').querySelectorAll('.idea').forEach(b => b.onclick = () => { st.code = b.textContent; q('#gcode').value = st.code; paint(); });
          if (!st.code || !ideas.includes(st.code) && !q('#gcode').matches(':focus')) { st.code = ideas[0] || ''; q('#gcode').value = st.code; q('#gi').firstElementChild?.classList.add('on'); }
          const d = periodDates(st);
          if (d) { q('#gst').value = d[0]; q('#gen2').value = d[1]; }
          q('#gcl').textContent = st.count > 1 ? 'Codes start with' : 'Code';
          q('#gnote').textContent = st.count > 1 ? `Makes ${st.count} codes like ${q('#gcode').value || 'CODE'}-7K2P, each usable once. Good for giveaways.` : 'One code anyone can use until it ends. It switches itself off after the end date.';
        };
        ['#go', '#gs', '#gm', '#gy', '#gv', '#gt', '#gc'].forEach(x => q(x).onchange = () => { st.code = ''; paint(); });
        q('#gv').oninput = () => { st.code = ''; paint(); };
        q('#gcode').oninput = () => { st.code = q('#gcode').value.toUpperCase(); };
        paint();
        q('#more').onclick = () => { close(); promoSheet({ code: q('#gcode').value, value: st.value, type: st.type, starts: q('#gst').value, ends: q('#gen2').value, count: st.count }); };
        q('#ok').onclick = e => busy(e.target, async () => {
          const r = await api('promo_batch', { prefix: q('#gcode').value, count: st.count, type: st.type, value: st.value,
            starts: q('#gst').value ? new Date(q('#gst').value + 'T00:00').toISOString() : null, ends: q('#gen2').value ? new Date(q('#gen2').value + 'T23:59').toISOString() : null });
          close(); promoTab = 'codes'; pagePromos(); codesMadeSheet(r);
        }).catch(() => {});
      });
  }
  function codesMadeSheet(r) {
    const text = r.map(x => x.code).join('\n');
    sheet(`<div class="kicker">Done</div><h3>${r.length === 1 ? `${esc(r[0].code)} is live` : `${r.length} codes are live`}</h3>
      <p class="muted" style="margin:4px 0 0">${esc(r[0].description || '')}${r[0].ends ? ` · ends ${fmtDate(r[0].ends)}` : ''}</p>
      <div class="ulist">${r.map(x => `<div class="r"><span class="mono">${esc(x.code)}</span><button class="cp" data-copy="${esc(x.code)}">${ic('copy', 14)}</button></div>`).join('')}</div>
      <div class="acts">${r.length > 1 ? `<button class="btn" id="all">${ic('copy', 15)} Copy all</button>` : ''}<button class="btn primary" data-close>Done</button></div>`,
      el => { el.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy, `Copied ${b.dataset.copy}`)); const a = el.querySelector('#all'); if (a) a.onclick = () => copy(text, `Copied ${r.length} codes`); });
  }
  function promoSheet(pre = {}, x = null) {
    const ed = !!x, auto = ed && ['expired', 'used up'].includes(x.ended_reason);
    const v = ed ? { code: x.code, value: Number(x.value), type: x.type, duration: x.duration || 'once', months: x.duration_months || 3, plans: x.plans || [], tiers: x.tiers || [], limit: x.limit || '',
      starts: x.starts ? ymd(x.starts) : '', ends: x.ends ? ymd(x.ends) : '', min: Number(x.min_total) || '', description: x.description || '', active: !!x.active }
      : { code: pre.code || '', value: pre.value || 20, type: pre.type || 'percentage', duration: pre.duration || 'once', months: pre.months || 3, plans: pre.plans || [], tiers: pre.tiers || [], limit: pre.limit || '',
      starts: pre.starts || '', ends: pre.ends || '', min: pre.min || '', description: pre.description || '', active: true };
    sheet(`<div class="kicker">Promotions</div><h3>${ed ? `Edit <span class="mono">${esc(x.code)}</span>` : pre.copyOf ? `Copy of ${esc(pre.copyOf)}` : 'New promo code'}</h3>
      ${ed ? `<p class="muted" style="margin:4px 0 0;font-size:13px">Used ${x.used}${x.limit ? ` of ${x.limit}` : ''} time${x.used === 1 ? '' : 's'}${x.batch ? ` · batch ${esc(x.batch)}` : ''} · made by ${esc(x.created_by || '—')}${x.edited_at ? ` · edited ${fmtDate(x.edited_at)}${x.edited_by ? ` by ${esc(x.edited_by)}` : ''}` : ''}</p>` : ''}
      ${auto ? `<div class="banner" style="margin-top:10px">${ic('warning')}<div>Switched off automatically (${esc(x.ended_reason)}). ${x.ended_reason === 'expired' ? 'Move the end date' : 'Raise the use limit'} and turn it on to bring it back.</div></div>` : ''}
      <div class="grid2"><div><label class="lbl">${pre.count > 1 ? 'Codes start with' : 'Code'}</label><input class="field mono" id="code" style="text-transform:uppercase" maxlength="30" placeholder="SUMMER25" value="${esc(v.code)}"></div>
        <div><label class="lbl">Discount</label><div class="row"><input class="field" id="val" type="number" min="1" style="flex:1" value="${v.value}"><select class="field" id="type" style="width:auto"><option value="percentage">% off</option><option value="fixed" ${v.type === 'fixed' ? 'selected' : ''}>$ off</option></select></div></div></div>
      <div class="grid2"><div><label class="lbl">For how long</label><select class="field" id="dur">${[['once', 'First payment only'], ['repeating', 'A number of months'], ['forever', 'Every payment']].map(([k, l]) => `<option value="${k}" ${v.duration === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div id="monthsBox" ${v.duration === 'repeating' ? '' : 'hidden'}><label class="lbl">Months</label><input class="field" id="months" type="number" min="1" max="36" value="${v.months}"></div></div>
      <label class="lbl">Plans (none ticked = all)</label><div class="chk" id="pls">${PLANS.filter(p => !C.plans[p].quote).map(p => `<label><input type="checkbox" value="${p}" ${v.plans.includes(p) ? 'checked' : ''}>${esc(C.plans[p].name)}</label>`).join('')}</div>
      <label class="lbl">Tiers (none ticked = all)</label><div class="chk" id="trs">${TIERS.map(t => `<label><input type="checkbox" value="${t}" ${v.tiers.includes(t) ? 'checked' : ''}>${esc(C.tiers[t].name)}</label>`).join('')}</div>
      <div class="grid2">${ed ? '' : `<div><label class="lbl">How many codes</label><select class="field" id="cnt"><option value="1">One shared code</option>${[5, 10, 25, 50].map(n => `<option value="${n}" ${pre.count === n ? 'selected' : ''}>${n} single-use codes</option>`).join('')}</select></div>`}
        <div><label class="lbl">Use limit <span style="opacity:.6">${ed ? '(total)' : '(shared code)'}</span></label><input class="field" id="lim" type="number" min="1" placeholder="No limit" value="${v.limit}"></div></div>
      <div class="grid3"><div><label class="lbl">Starts</label><input class="field" id="sts" type="date" value="${esc(v.starts)}"></div><div><label class="lbl">Ends</label><input class="field" id="ends" type="date" value="${esc(v.ends)}"></div><div><label class="lbl">Order over</label><div class="money-in"><input class="field" id="min" type="number" min="0" placeholder="0" value="${v.min}"></div></div></div>
      <label class="lbl">What it says <span style="opacity:.6">(optional, shown with the code)</span></label><input class="field" id="desc" maxlength="200" placeholder="Filled in from the discount" value="${esc(v.description)}">
      ${ed ? `<label class="switch" style="margin-top:12px"><input type="checkbox" id="on" ${v.active ? 'checked' : ''}> On</label>
        <p class="muted" style="font-size:12.5px;margin:8px 0 0">Changing the discount, end date or limit makes a fresh Stripe code behind the scenes. Customers keep typing the same code${x.used && x.duration !== 'once' ? '; people already using it keep their old discount' : ''}.</p>` : ''}
      <div class="err" id="perr"></div>
      <div class="acts">${ed ? `<button class="btn quiet" id="dup">${ic('copy', 15)} Duplicate</button><span class="sp"></span>` : ''}<button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">${ed ? `${ic('check', 15)} Save` : `${ic('promos', 15)} Create`}</button></div>`,
      (el, close) => {
        const q = s => el.querySelector(s);
        q('#dur').onchange = () => q('#monthsBox').hidden = q('#dur').value !== 'repeating';
        const read = () => ({ code: q('#code').value.trim().toUpperCase(), value: Number(q('#val').value), type: q('#type').value, duration: q('#dur').value, months: Number(q('#months').value) || 3,
          plans: [...q('#pls').querySelectorAll('input:checked')].map(i => i.value), tiers: [...q('#trs').querySelectorAll('input:checked')].map(i => i.value), limit: q('#lim').value ? Number(q('#lim').value) : '',
          starts: q('#sts').value, ends: q('#ends').value, min: Number(q('#min').value) || '', description: q('#desc').value.trim(), active: ed ? q('#on').checked : true });
        if (ed) q('#dup').onclick = () => { const n = read(); close(); promoSheet({ ...n, code: '', copyOf: x.code, starts: '', ends: n.ends && n.ends >= ymd(new Date()) ? n.ends : '' }); };
        q('#ok').onclick = e => busy(e.target, async () => {
          q('#perr').textContent = '';
          const n = read();
          const api_ = o => ({ code: o.code, value: o.value, type: o.type, duration: o.duration, duration_months: o.duration === 'repeating' ? o.months : null, plans: o.plans, tiers: o.tiers,
            limit: o.limit || null, starts: o.starts || null, ends: o.ends || null, min_total: Number(o.min) || 0, description: o.description, active: o.active });
          try {
            if (ed) {
              const ch = changes(api_(v), api_(n));
              if (!Object.keys(ch).length) { close(); return; }
              if ('starts' in ch) ch.starts = dayStart(ch.starts); if ('ends' in ch) ch.ends = dayEnd(ch.ends);
              const r = await api('promo_save', { id: x.id, ...ch });
              close(); toast(`${r.code} saved.${r.note ? ` ${r.note}` : ''}`, 'ok'); pagePromos();
            } else {
              const r = await api('promo_batch', { prefix: n.code, count: Number(q('#cnt').value), type: n.type, value: n.value, duration: n.duration, duration_months: n.months, plans: n.plans, tiers: n.tiers,
                limit: n.limit || null, starts: dayStart(n.starts), ends: dayEnd(n.ends), min_total: Number(n.min) || 0, description: n.description });
              close(); pagePromos(); codesMadeSheet(r);
            }
          } catch (err) { q('#perr').textContent = err.message; }
        });
      });
  }
  const DEAL_KINDS = [['models', 'Bonus models', '2 for the price of 1'], ['percent', '% off', 'automatic discount'], ['amount', '$ off', 'automatic discount'], ['chip', 'Chip upgrade', 'a better Quouk chip'], ['seats', 'Extra people', 'more seats']];
  const bonusFamilies = () => Object.entries(C.families).filter(([k, f]) => !f.free && !TIERS.every(t => C.tiers[t].families.includes(k)));
  function dealSheet(pre = {}, d = null) {
    const ed = !!d;
    const v = ed ? { kind: d.kind, value: d.value != null ? Number(d.value) : null, duration: d.duration || 'once', months: d.duration_months || 3, models: d.models || [], chip: d.chip || null,
      plans: d.plans || [], tiers: d.tiers || [], billing: d.billing || [], headline: d.headline, description: d.description || '', starts: d.starts_at ? ymd(d.starts_at) : '', ends: d.ends_at ? ymd(d.ends_at) : '',
      limit: d.usage_limit || '', featured: d.featured !== false, active: !!d.active }
      : { kind: 'models', value: null, duration: 'once', months: 3, models: [], chip: null, plans: [], tiers: [], billing: [], headline: '', description: '', starts: ymd(new Date()), ends: '', limit: '', featured: true, active: true, ...pre };
    let kind = v.kind;
    const auto = ed && ['expired', 'used up'].includes(d.ended_reason);
    sheet(`<div class="kicker">Deals</div><h3>${ed ? 'Edit deal' : pre.copyOf ? 'Copy of a deal' : 'New deal'}</h3>
      ${ed ? `<p class="muted" style="margin:4px 0 0;font-size:13px">Used ${d.used_count}${d.usage_limit ? ` of ${d.usage_limit}` : ''} time${d.used_count === 1 ? '' : 's'} · made by ${esc(d.created_by || '—')}${d.edited_at ? ` · edited ${fmtDate(d.edited_at)}${d.edited_by ? ` by ${esc(d.edited_by)}` : ''}` : ''}</p>` : ''}
      ${auto ? `<div class="banner" style="margin-top:10px">${ic('warning')}<div>Switched off automatically (${esc(d.ended_reason)}). ${d.ended_reason === 'expired' ? 'Move the end date' : 'Raise the use limit'} and turn it on to bring it back.</div></div>` : ''}
      <div class="kinds" id="dk">${DEAL_KINDS.map(([k, l, sub]) => `<button type="button" data-k="${k}" class="${k === kind ? 'on' : ''}"><b>${l}</b><small>${sub}</small></button>`).join('')}</div>
      <div id="dbody"></div>
      <label class="lbl">Works on</label><div class="chk" id="dpl">${PLANS.filter(p => !C.plans[p].quote).map(p => `<label><input type="checkbox" value="${p}" ${v.plans.includes(p) ? 'checked' : ''}>${esc(C.plans[p].name)}</label>`).join('')}</div>
      <div class="chk" id="dtr" style="margin-top:6px">${TIERS.map(t => `<label><input type="checkbox" value="${t}" ${v.tiers.includes(t) ? 'checked' : ''}>${esc(C.tiers[t].name)}</label>`).join('')}</div>
      <div class="chk" id="dbl" style="margin-top:6px">${[['month', 'Monthly'], ['year', 'Yearly']].map(([k, l]) => `<label><input type="checkbox" value="${k}" ${v.billing.includes(k) ? 'checked' : ''}>${l}</label>`).join('')}</div>
      <p class="muted" style="font-size:12px;margin:4px 0 0">None ticked in a row = all of them.</p>
      <label class="lbl">Headline customers see</label><input class="field" id="dh" maxlength="90" value="${esc(v.headline)}">
      <label class="lbl">More detail <span style="opacity:.6">(optional)</span></label><input class="field" id="dd" maxlength="300" placeholder="e.g. This weekend only, while it lasts." value="${esc(v.description)}">
      <div class="grid3"><div><label class="lbl">Starts</label><input class="field" id="ds" type="date" value="${esc(v.starts)}"></div><div><label class="lbl">Ends</label><input class="field" id="de" type="date" value="${esc(v.ends)}"></div><div><label class="lbl">Use limit</label><input class="field" id="dl" type="number" min="1" placeholder="No limit" value="${v.limit}"></div></div>
      <div class="row" style="gap:18px;margin-top:12px"><label class="switch"><input type="checkbox" id="df" ${v.featured ? 'checked' : ''}> Show it on the home page</label>${ed ? `<label class="switch"><input type="checkbox" id="don" ${v.active ? 'checked' : ''}> On</label>` : ''}</div>
      ${ed && ['percent', 'amount'].includes(d.kind) && d.used_count ? '<p class="muted" style="font-size:12.5px;margin:8px 0 0">Changing the discount applies from now on. Orders already placed keep what they got.</p>' : ''}
      <div class="err" id="derr"></div>
      <div class="acts">${ed ? `<button class="btn quiet" id="dup">${ic('copy', 15)} Duplicate</button><span class="sp"></span>` : ''}<button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">${ed ? `${ic('check', 15)} Save` : `${ic('sparkles', 15)} Start the deal`}</button></div>`,
      (el, close) => {
        const q = s => el.querySelector(s);
        let touched = ed || !!v.headline;
        const ticked = id => [...q(id).querySelectorAll('input:checked')].map(i => i.value);
        const suggest = () => {
          if (touched) return;
          const tiers = ticked('#dtr').map(tierName), on = tiers.length ? ` with ${tiers.join(' or ')}` : '';
          const models = [...el.querySelectorAll('#dm input:checked')].map(i => i.value);
          q('#dh').value = kind === 'models' ? (models.length ? `${models.length === 1 ? models[0] : `${models.slice(0, -1).join(', ')} and ${models.at(-1)}`} free${on}` : '')
            : kind === 'percent' ? `${q('#dv')?.value || 20}% off${on}` : kind === 'amount' ? `${money(Number(q('#dv')?.value || 5))} off${on}` : kind === 'chip' ? `Free upgrade to the ${q('#dc')?.value || ''} chip${on}` : `${q('#dv')?.value || 2} extra people free${on}`;
        };
        const body = () => {
          const val = v.kind === kind && v.value != null ? v.value : kind === 'seats' ? 2 : kind === 'percent' ? 20 : 5;
          q('#dbody').innerHTML = kind === 'models' ? `<label class="lbl">Bonus models (added free on top of the tier)</label><div class="dm" id="dm">${bonusFamilies().map(([, f]) => `<div><b>${esc(f.name)}</b>${f.models.map(m => `<label><input type="checkbox" value="${esc(m)}" ${v.models.includes(m) ? 'checked' : ''}>${esc(m)}</label>`).join('')}</div>`).join('')}</div>`
            : kind === 'chip' ? `<label class="lbl">They get</label><select class="field" id="dc">${C.chips.filter(c => c.id !== 'No order').map(c => `<option ${c.id === v.chip ? 'selected' : ''}>${esc(c.id)}</option>`).join('')}</select>`
            : `<div class="grid2"><div><label class="lbl">${kind === 'seats' ? 'Extra people' : kind === 'percent' ? 'Percent off' : 'Dollars off'}</label><input class="field" id="dv" type="number" min="1" value="${val}"></div>
              ${kind === 'seats' ? '' : `<div><label class="lbl">For how long</label><div class="row"><select class="field" id="ddur" style="flex:1">${[['once', 'First payment'], ['repeating', 'Some months'], ['forever', 'Every payment']].map(([k, l]) => `<option value="${k}" ${v.duration === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <input class="field" id="dmo" type="number" min="1" max="36" value="${v.months}" style="width:76px" title="Months" ${v.duration === 'repeating' ? '' : 'hidden'}></div></div>`}</div>`;
          q('#dbody').querySelectorAll('input, select').forEach(i => i.addEventListener('input', suggest));
          q('#ddur') && (q('#ddur').onchange = () => { q('#dmo').hidden = q('#ddur').value !== 'repeating'; });
          suggest();
        };
        // a new kind rewrites the headline too, unless someone already changed the wording
        q('#dk').querySelectorAll('button').forEach(b => b.onclick = () => { kind = b.dataset.k; if (q('#dh').value === v.headline) touched = false; q('#dk').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); body(); });
        ['#dpl', '#dtr', '#dbl'].forEach(id => q(id).addEventListener('change', suggest));
        q('#dh').oninput = () => touched = true;
        body();
        const read = () => {
          const dur = q('#ddur')?.value || 'once', priced = kind === 'percent' || kind === 'amount';
          return { kind, value: ['percent', 'amount', 'seats'].includes(kind) ? Number(q('#dv')?.value) || null : null, duration: priced ? dur : 'once', duration_months: priced && dur === 'repeating' ? Number(q('#dmo').value) || 3 : null,
            models: kind === 'models' ? [...el.querySelectorAll('#dm input:checked')].map(i => i.value) : null, chip: kind === 'chip' ? q('#dc').value : null,
            plans: ticked('#dpl'), tiers: ticked('#dtr'), billing: ticked('#dbl'), headline: q('#dh').value.trim(), description: q('#dd').value.trim(),
            starts_at: q('#ds').value || null, ends_at: q('#de').value || null, limit: q('#dl').value ? Number(q('#dl').value) : null, featured: q('#df').checked, ...(ed ? { active: q('#don').checked } : {}) };
        };
        if (ed) q('#dup').onclick = () => { const n = read(); close(); dealSheet({ ...n, value: n.value, months: n.duration_months || 3, starts: ymd(new Date()), ends: n.ends_at && n.ends_at >= ymd(new Date()) ? n.ends_at : '', limit: n.limit || '', copyOf: true }); };
        q('#ok').onclick = e => busy(e.target, async () => {
          q('#derr').textContent = '';
          const n = read();
          try {
            if (ed) {
              const init = { kind: v.kind, value: v.value, duration: ['percent', 'amount'].includes(v.kind) ? v.duration : 'once', duration_months: ['percent', 'amount'].includes(v.kind) && v.duration === 'repeating' ? v.months : null,
                models: v.kind === 'models' ? v.models : null, chip: v.kind === 'chip' ? v.chip : null, plans: v.plans, tiers: v.tiers, billing: v.billing, headline: v.headline, description: v.description,
                starts_at: v.starts || null, ends_at: v.ends || null, limit: v.limit || null, featured: v.featured, active: v.active };
              const ch = changes(init, n);
              if (!Object.keys(ch).length) { close(); return; }
              if ('starts_at' in ch) ch.starts_at = dayStart(ch.starts_at); if ('ends_at' in ch) ch.ends_at = dayEnd(ch.ends_at);
              if ('kind' in ch) Object.assign(ch, { value: n.value, duration: n.duration, duration_months: n.duration_months, models: n.models, chip: n.chip });
              const r = await api('deal_save', { id: d.id, ...ch });
              close(); toast(`Deal saved.${r.note ? ` ${r.note}` : ''}`, 'ok'); pagePromos();
            } else {
              await api('deal_save', { ...n, starts_at: dayStart(n.starts_at), ends_at: dayEnd(n.ends_at) });
              close(); promoTab = 'deals'; toast('Deal started.', 'ok'); pagePromos();
            }
          } catch (err) { q('#derr').textContent = err.message; }
        });
      });
  }

  // ---------- 2.5.1 the deal generator: pick an occasion and a size, get a set of ready-made deals to tick
  function dealIdeas({ occasion, season, month, size }) {
    const name = periodName({ occasion, season, month }), pre = name ? `${name}: ` : '';
    const pct = [10, 20, 30][size], amt = [5, 10, 20][size], people = [1, 2, 3][size];
    const [famKey, fam] = bonusFamilies()[0] || [];
    const without = TIERS.filter(t => famKey && !C.tiers[t].families.includes(famKey));   // tiers that don't have those models
    const withTier = TIERS.filter(t => !without.includes(t));
    const lowTop = without.at(-1), mid = withTier[0] || TIERS[TIERS.length - 2], top = TIERS.at(-1);
    const topChip = C.chips.filter(c => c.id !== 'No order').at(-1)?.id;
    const models = fam ? fam.models.slice(0, size + 1) : [];
    const list = (a) => a.length === 1 ? a[0] : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`;
    const bizPlan = PLANS.find(p => p === 'business');
    return [
      models.length && lowTop && { kind: 'models', models, tiers: [lowTop], headline: `${pre}${models.length === 1 ? `2 for 1: ${models[0]}` : list(models)} free with ${tierName(lowTop)}`, description: `Get ${list(models)} on top of everything in ${tierName(lowTop)}, at no extra cost.` },
      { kind: 'percent', value: pct, duration: 'repeating', duration_months: 3, tiers: [mid], headline: `${pre}${tierName(mid)} is ${pct}% off for 3 months`, description: `${pct}% off your first three months of ${tierName(mid)}.` },
      { kind: 'amount', value: amt, duration: 'once', tiers: [top], headline: `${pre}${money(amt)} off your first ${tierName(top)} payment`, description: '' },
      topChip && mid && C.tiers[mid].chip !== topChip && { kind: 'chip', chip: topChip, tiers: [mid], headline: `${pre}Free ${topChip} chip with ${tierName(mid)}`, description: `The ${tierName(top)} chip, on the ${tierName(mid)} price.` },
      bizPlan && { kind: 'seats', value: people, plans: [bizPlan], headline: `${pre}${people} extra ${people === 1 ? 'person' : 'people'} free on ${C.plans[bizPlan].name}`, description: '' },
      { kind: 'percent', value: pct, duration: 'once', billing: ['year'], headline: `${pre}${pct}% off yearly plans`, description: `Pay for the year and save ${pct}% on top of the yearly price.` },
    ].filter(Boolean);
  }
  function dealGeneratorSheet() {
    const now = new Date(), y0 = now.getFullYear();
    const st = { occasion: now.getMonth() === 10 ? 'blackfriday' : '', season: '', month: '', year: y0, size: 1 };
    let ideas = [], pick = new Set([0, 1]);
    sheet(`<div class="kicker">Deals</div><h3>Deal generator</h3>
      <p class="muted" style="margin:4px 0 0;font-size:13.5px">Pick an occasion and how big. Tick the deals you want; you can change the wording first.</p>
      <div class="grid2" style="margin-top:6px"><div><label class="lbl">Occasion</label><select class="field" id="go">${Object.entries(OCCASIONS).map(([k, o]) => `<option value="${k}" ${k === st.occasion ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
        <div><label class="lbl">Season</label><select class="field" id="gs">${Object.entries(SEASONS).map(([k, x]) => `<option value="${k}">${esc(x[0] || 'None')}</option>`).join('')}</select></div>
        <div><label class="lbl">Month</label><select class="field" id="gm"><option value="">None</option>${MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('')}</select></div>
        <div><label class="lbl">Year</label><input class="field" id="gy" type="number" min="${y0}" max="${y0 + 3}" value="${y0}"></div></div>
      <label class="lbl">How big</label><div class="seg" id="gz"><button data-v="0">Small</button><button data-v="1" class="on">Medium</button><button data-v="2">Big</button></div>
      <label class="lbl">Ideas</label><div class="dideas" id="gi"></div>
      <div class="grid2"><div><label class="lbl">Starts</label><input class="field" id="gst" type="date"></div><div><label class="lbl">Ends</label><input class="field" id="gen2" type="date"></div></div>
      <label class="switch" style="margin-top:10px"><input type="checkbox" id="gf" checked> Show them on the home page</label>
      <div class="err" id="gerr"></div>
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">${ic('sparkles', 15)} Start 2 deals</button></div>`,
      (el, close) => {
        const q = x => el.querySelector(x);
        const count = () => { q('#ok').innerHTML = `${ic('sparkles', 15)} Start ${pick.size} deal${pick.size === 1 ? '' : 's'}`; q('#ok').disabled = !pick.size; };
        const paint = () => {
          Object.assign(st, { occasion: q('#go').value, season: q('#gs').value, month: q('#gm').value, year: Number(q('#gy').value) || y0 });
          ideas = dealIdeas(st);
          q('#gi').innerHTML = ideas.map((x, i) => `<label class="didea ${pick.has(i) ? 'on' : ''}"><input type="checkbox" data-i="${i}" ${pick.has(i) ? 'checked' : ''}>
            <div><input class="field" data-h="${i}" value="${esc(x.headline)}" maxlength="90"><small>${esc(dealText(x))} · ${esc([(x.plans || []).map(p => C.plans[p].name).join(', ') || 'all plans', (x.tiers || []).map(tierName).join(', ') || 'all tiers', ...(x.billing?.length ? ['yearly'] : [])].join(' · '))}</small></div></label>`).join('');
          q('#gi').querySelectorAll('input[data-i]').forEach(c => c.onchange = () => { const i = +c.dataset.i; c.checked ? pick.add(i) : pick.delete(i); c.closest('.didea').classList.toggle('on', c.checked); count(); });
          q('#gi').querySelectorAll('input[data-h]').forEach(h => h.oninput = () => { ideas[+h.dataset.h].headline = h.value; });
          const d = periodDates(st);
          if (d) { q('#gst').value = d[0]; q('#gen2').value = d[1]; }
          count();
        };
        ['#go', '#gs', '#gm', '#gy'].forEach(x => q(x).onchange = paint);
        q('#gz').querySelectorAll('button').forEach(b => b.onclick = () => { st.size = +b.dataset.v; q('#gz').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); paint(); });
        paint();
        q('#ok').onclick = e => busy(e.target, async () => {
          q('#gerr').textContent = '';
          let made = 0;
          try {
            for (const i of [...pick].sort()) {
              await api('deal_save', { ...ideas[i], starts_at: dayStart(q('#gst').value), ends_at: dayEnd(q('#gen2').value), featured: q('#gf').checked });
              made++; pick.delete(i);   // so trying again doesn't make it twice
              el.querySelector(`input[data-i="${i}"]`)?.closest('.didea')?.classList.add('done');
            }
            close(); promoTab = 'deals'; toast(`${made} deal${made === 1 ? '' : 's'} started.`, 'ok'); pagePromos();
          } catch (err) { q('#gerr').textContent = `${made ? `${made} made, then: ` : ''}${err.message}`; count(); if (made) pagePromos(); }
        });
      });
  }

  // ================================================================ Team (managers)
  async function pageTeam() {
    const pg = $('pg');
    pg.innerHTML = `<div class="h-row"><p class="muted" style="margin:0">Nexus admins are added the first time they sign in. Add anyone else by the email they use for Nexus.</p><span class="sp"></span><button class="btn primary small" id="add">${ic('plus', 15)} Add person</button></div>
      <div class="card tblcard"><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th>Now</th><th>Usual store</th><th class="num">This week</th><th class="num">Sales this month</th><th class="num">Points</th>${can('owner') ? '<th class="num">Pay</th>' : ''}<th></th></tr></thead><tbody id="rows"><tr><td colspan="9" class="empty"><span class="spin"></span></td></tr></tbody></table></div>`;
    $('add').onclick = () => personSheet(null);
    let list, pts = {};
    try { [list, pts] = await Promise.all([api('team'), api('points').then(r => Object.fromEntries((r.board || []).map(x => [x.user_id, x]))).catch(() => ({}))]); }
    catch (e) { $('rows') && ($('rows').innerHTML = `<tr><td colspan="9" class="empty">${esc(e.message)}</td></tr>`); return; }
    if (!$('rows')) return;
    S.team = list;
    $('rows').innerHTML = list.map((s, i) => `<tr class="click" data-i="${i}" style="${s.active ? '' : 'opacity:.5'}"><td><div class="row" style="gap:10px;flex-wrap:nowrap">${avatar(s.name, s.color, '', s.user_id)}<div><b>${esc(s.name)}</b><div class="muted" style="font-size:12.5px">${esc(s.title ? `${s.title} · ` : '')}${esc(s.email)}</div></div></div></td>
      <td>${s.role === 'owner' ? `<span class="pill vio">${ic('crown', 11)} OWNER</span>` : s.role === 'manager' ? '<span class="pill info">MANAGER</span>' : '<span class="pill dim">EMPLOYEE</span>'}</td>
      <td>${!s.active ? '<span class="pill bad">OFF</span>' : !s.signed_in ? '<span class="pill warn">INVITED</span>' : s.on_clock ? `<span class="pill ok">${s.on_clock.on_break ? 'BREAK' : 'ON'} · #${esc(s.on_clock.store_code)}</span>` : `<span class="muted" style="font-size:12.5px">${s.last_seen ? 'seen ' + fmtWhen(s.last_seen) : '—'}</span>`}</td>
      <td class="muted">${s.default_store ? '#' + esc(s.default_store) : '—'}</td><td class="num">${hm(s.week_minutes || 0)}</td><td class="num">${money(Number(s.month_sales) || 0)}</td><td class="num">${pts[s.user_id] ? `<b class="${pts[s.user_id].total < 0 ? 'neg' : ''}">${pts[s.user_id].total}</b>` : '<span class="muted">—</span>'}</td>${can('owner') ? `<td class="num">${s.pay_rate != null ? money(Number(s.pay_rate)) + '/h' : '—'}</td>` : ''}
      <td class="num">${ic('edit', 15)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Nobody yet.</td></tr>';
    $('rows').querySelectorAll('tr.click').forEach(r => r.onclick = () => personSheet(list[+r.dataset.i]));
  }
  function personSheet(p) {
    const owner = can('owner'), isOwner = p?.role === 'owner', self = p?.user_id === S.me.id;
    const lockRole = !owner || isOwner || self, canEdit = !p || owner || p.role === 'employee';
    sheet(`<div class="kicker">${p ? 'Team' : 'Add someone'}</div><h3>${p ? esc(p.name) : 'Add a person'}</h3>
      ${p ? `<p class="muted" style="margin:2px 0 0">${esc(p.email)}${p.signed_in ? '' : ' · hasn\'t signed in yet'}</p>` : '<p class="muted">They sign in to aARgon3 with the Nexus account for this email. If they don\'t have one, they can make one in Nexus \'28 for free.</p>'}
      ${!canEdit ? '<div class="banner" style="margin-top:12px">Only the owner can change managers.</div>' : ''}
      <div class="fgrid">${p ? '' : '<div class="wide"><label class="lbl">Email</label><input class="field" id="em" type="email" placeholder="name@example.com"></div>'}
        <div><label class="lbl">Name in aARgon3</label><input class="field" id="dn" value="${esc(p?.display_name || '')}" placeholder="${esc(p?.nexus_name || '')}"></div>
        <div><label class="lbl">Title</label><input class="field" id="ti" value="${esc(p?.title || '')}" placeholder="e.g. Sales associate"></div>
        <div><label class="lbl">Role</label><select class="field" id="ro" ${lockRole && p ? 'disabled' : ''}>${isOwner ? '<option>Owner</option>' : `<option value="employee" ${p?.role !== 'manager' ? 'selected' : ''}>Employee</option>${owner ? `<option value="manager" ${p?.role === 'manager' ? 'selected' : ''}>Manager</option>` : ''}`}</select></div>
        <div><label class="lbl">Usual store</label><select class="field" id="ds">${storeOptions(p?.default_store || '', true)}</select></div>
        <div><label class="lbl">Phone</label><input class="field" id="ph" type="tel" value="${esc(p?.phone || '')}"></div>
        ${owner ? `<div><label class="lbl">Pay rate (owner only)</label><div class="money-in"><input class="field" id="pay" type="number" min="0" step="0.25" value="${p?.pay_rate ?? ''}" placeholder="per hour"></div></div>` : '<div></div>'}
        <div class="wide"><label class="lbl">Notes (managers only)</label><input class="field" id="nt" value="${esc(p?.notes || '')}"></div></div>
      ${p && !isOwner && !self ? `<label class="switch" style="margin-top:16px"><input type="checkbox" id="ac" ${p.active ? 'checked' : ''} ${canEdit ? '' : 'disabled'}> Can use aARgon3</label>` : ''}
      <div class="acts">${p?.user_id ? `<button class="btn quiet" id="ts">${ic('time', 15)} Timesheet</button><span style="flex:1"></span>` : ''}<button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok" ${canEdit ? '' : 'disabled'}>${p ? 'Save' : 'Add'}</button></div>`,
      (el, close) => {
        const q = s => el.querySelector(s);
        q('#ts') && (q('#ts').onclick = () => { close(); tsv.everyone = true; go('time'); });
        q('#ok').onclick = e => busy(e.target, async () => {
          const body = { display_name: q('#dn').value, title: q('#ti').value, default_store: q('#ds').value, phone: q('#ph').value, notes: q('#nt').value };
          if (p) body.id = p.id; else body.email = q('#em').value;
          if (!q('#ro').disabled && !isOwner && (owner || !p)) { if (owner) body.role = q('#ro').value; }
          if (owner && q('#pay')) body.pay_rate = q('#pay').value;
          if (q('#ac') && !q('#ac').disabled && q('#ac').checked !== p.active) body.active = q('#ac').checked;
          const r = await api('team_save', body);
          close(); toast(p ? 'Saved.' : `${r.email} added. They can sign in now.`, 'ok'); if (self) await refresh(); pageTeam();
        }).catch(() => {});
      });
  }

  // ================================================================ Activity (managers)
  async function pageActivity() {
    $('pg').innerHTML = '<div class="card tblcard"><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody id="rows"><tr><td colspan="4" class="empty"><span class="spin"></span></td></tr></tbody></table></div>';
    const label = { sale_link: 'Made a payment link', comp: 'Gave a free order', cancel: 'Cancelled an order', refund: 'Refunded an order', edit_shift: 'Fixed a shift', quote: 'Made a custom order',
      quote_sent: 'Sent a custom order', quote_cancel: 'Cancelled a custom order', promo: 'Made a promo code', promo_edit: 'Changed a promo code', team_add: 'Added a person', team_edit: 'Changed a person',
      schedule: 'Scheduled a shift', schedule_delete: 'Removed a shift', schedule_copy: 'Copied a week', time_off: 'Answered time off', settings: 'Changed settings', store: 'Changed a store' };
    try {
      const list = await api('log');
      $('rows').innerHTML = list.map(l => `<tr><td class="muted">${fmtWhen(l.at)}</td><td>${esc(l.name)}</td><td>${esc(label[l.action] || l.action)}</td><td class="muted mono" style="font-size:12.5px">${esc(Object.entries(l.details || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '))}</td></tr>`).join('')
        || '<tr><td colspan="4" class="empty">Nothing yet.</td></tr>';
    } catch (e) { $('rows').innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`; }
  }

  // ================================================================ Settings (owner)
  async function pageSettings() {
    const pg = $('pg');
    pg.innerHTML = '<div class="empty"><span class="spin"></span></div>';
    let d; try { d = await api('settings'); } catch (e) { pg.innerHTML = `<div class="empty-card">${esc(e.message)}</div>`; return; }
    const s = d.settings || {}, st = s.store || {}, biz = s.business || {}, goals = s.goals || {};
    const tax = s.tax || {}, em = s.email || {}, ref = s.referral || {}, fu = s.followup || {}, al = s.alerts || {}, def = d.email_defaults || {};
    pg.innerHTML = `<div class="grid2">
      <form class="card" id="fs"><h3>${ic('store')} Online store</h3><label class="switch"><input type="checkbox" id="open" ${st.open !== false ? 'checked' : ''}> Taking orders</label>
        <label class="lbl">Message when closed</label><input class="field" id="msg" value="${esc(st.message || '')}" placeholder="e.g. Back Monday! Staff sales still work.">
        <p class="muted" style="font-size:13px">Closing the store stops new checkouts on the website. Staff sales in the terminal keep working.</p><div class="acts"><button class="btn primary">Save</button></div></form>
      <form class="card" id="fg"><h3>${ic('target')} Monthly sales goal</h3><div class="money-in"><input class="field" id="goal" type="number" min="0" value="${goals.monthly_revenue || ''}" placeholder="0 = no goal"></div>
        <p class="muted" style="font-size:13px">Shown as a progress bar on Sales.</p><div class="acts"><button class="btn primary">Save</button></div></form></div>
      <form class="card" id="fb" style="margin-top:12px"><h3>${ic('building')} Business details</h3><div class="fgrid">
        <div><label class="lbl">Business name</label><input class="field" id="bn" value="${esc(biz.name || '')}"></div><div><label class="lbl">Support email</label><input class="field" id="be" type="email" value="${esc(biz.support_email || '')}"></div>
        <div><label class="lbl">Address</label><input class="field" id="ba" value="${esc(biz.address || '')}"></div><div><label class="lbl">Phone</label><input class="field" id="bp" value="${esc(biz.phone || '')}"></div></div>
        <div class="acts"><button class="btn primary">Save</button></div></form>
      <div class="grid2" style="margin-top:12px">
        <form class="card" id="ftax"><h3>${ic('percent')} Tax by region</h3><label class="switch"><input type="checkbox" id="tx" ${tax.enabled ? 'checked' : ''}> Add tax at checkout and on invoices</label>
          <label class="lbl">Name on receipts</label><input class="field" id="tl" value="${esc(tax.label || 'Sales tax')}" maxlength="50">
          <div class="taxgrid">${Object.keys(C.regions).map(r => `<label><span><b>${r}</b> ${esc(C.regions[r])}</span><div class="pct-in"><input class="field" type="number" min="0" max="30" step="0.001" data-r="${r}" value="${tax.regions?.[r]?.rate ?? ''}" placeholder="0"></div></label>`).join('')}</div>
          <p class="muted" style="font-size:12.5px">Customers pick their region at checkout; terminal sales use the store's region. Each rate becomes a Stripe tax rate, so it shows on receipts and invoices. Ask an accountant which rates apply to you.</p>
          <div class="acts"><button class="btn primary">Save</button></div></form>
        <form class="card" id="fem"><h3>${ic('mail')} Email (EmailJS)</h3><label class="switch"><input type="checkbox" id="ee" ${em.enabled !== false ? 'checked' : ''}> Send emails</label>
          <div class="fgrid"><div><label class="lbl">Service id</label><input class="field mono" id="es" value="${esc(em.service_id || '')}" placeholder="${esc(def.service_id || '')}"></div>
            <div><label class="lbl">Public key</label><input class="field mono" id="ek" value="${esc(em.public_key || '')}" placeholder="${esc(def.public_key || '')}"></div>
            <div><label class="lbl">Receipt template</label><input class="field mono" id="er" value="${esc(em.receipt_template || '')}" placeholder="${esc(def.receipt_template || '')}"></div>
            <div><label class="lbl">Gift + reminder template</label><input class="field mono" id="emt" value="${esc(em.message_template || '')}" placeholder="template_…"></div></div>
          <p class="muted" style="font-size:12.5px">Blank = the old aARgon3 account's ids. Receipts use your existing template. Gifts and checkout reminders need a second template: paste <span class="mono">emails/message-template.html</span> into a new EmailJS template and put its id here. In EmailJS, turn on Account → Security → "Allow EmailJS API for non-browser applications".${d.has_private_key ? ' Private key: set.' : ''}</p>
          <div class="acts"><button type="button" class="btn quiet" id="etest">${ic('mail', 15)} Send me a test</button><button class="btn primary">Save</button></div></form>
      </div>
      <form class="card" id="fmore" style="margin-top:12px"><h3>${ic('gift')} Referrals, reminders and alerts</h3><div class="fgrid">
        <div><label class="switch"><input type="checkbox" id="re" ${ref.enabled !== false ? 'checked' : ''}> Referral codes</label><p class="muted" style="font-size:12.5px;margin:4px 0 0">A friend gets a month off; the person who shared the code gets a month of credit.</p></div>
        <div><label class="lbl">Credits per customer per year</label><input class="field" id="rm" type="number" min="1" max="100" value="${ref.max_per_year || 12}"></div>
        <div><label class="switch"><input type="checkbox" id="fu" ${fu.enabled !== false ? 'checked' : ''}> Checkout reminders</label><p class="muted" style="font-size:12.5px;margin:4px 0 0">One email, only to people who tick "remind me" and don't finish.</p></div>
        <div><label class="lbl">Alert when a custom order waits more than (days)</label><input class="field" id="ad" type="number" min="1" max="60" value="${al.quote_days || 3}"></div></div>
        <div class="acts"><button class="btn primary">Save</button></div></form>
      <div class="card" style="margin-top:12px"><div class="h-row"><h3>${ic('store')} Stores</h3><span class="sp"></span><button class="btn small" id="addStore">${ic('plus', 15)} Add store</button></div>
        <table class="tbl"><thead><tr><th>Store</th><th>Region</th><th>Hours</th><th>Status</th><th></th></tr></thead><tbody>${(d.stores || []).map((x, i) => `<tr><td><b class="mono">#${esc(x.code)}</b> ${esc(x.name)}</td><td class="muted">${esc(x.region)} · ${esc(C.regions[x.region] || '')}</td><td class="muted">${x.hours ? hoursSummary(x.hours) : 'Not set'}</td><td>${x.active ? '<span class="pill ok">OPEN</span>' : '<span class="pill dim">CLOSED</span>'}</td><td class="num"><button class="btn quiet small" data-i="${i}">${ic('edit', 15)}</button></td></tr>`).join('')}</tbody></table></div>`;
    const ro = !can('owner');
    if (ro) pg.querySelectorAll('input, select, button.btn.primary, #addStore, #etest, [data-i]').forEach(x => x.disabled = true);
    const save = (key, value) => api('settings_save', { key, value }).then(() => { toast('Saved.', 'ok'); return refresh(); });
    $('fs').onsubmit = e => { e.preventDefault(); busy(e.submitter, () => save('store', { open: $('open').checked, message: $('msg').value })).catch(() => {}); };
    $('fg').onsubmit = e => { e.preventDefault(); busy(e.submitter, () => save('goals', { monthly_revenue: Number($('goal').value) || 0 })).catch(() => {}); };
    $('fb').onsubmit = e => { e.preventDefault(); busy(e.submitter, () => save('business', { name: $('bn').value, support_email: $('be').value, address: $('ba').value, phone: $('bp').value })).catch(() => {}); };
    $('ftax').onsubmit = e => { e.preventDefault(); busy(e.submitter, () => save('tax', { enabled: $('tx').checked, label: $('tl').value,
      regions: Object.fromEntries([...pg.querySelectorAll('[data-r]')].map(i => [i.dataset.r, { rate: Number(i.value) || 0 }])) }).then(() => pageSettings())).catch(() => {}); };
    $('fem').onsubmit = e => { e.preventDefault(); busy(e.submitter, () => save('email', { enabled: $('ee').checked, service_id: $('es').value, public_key: $('ek').value, receipt_template: $('er').value, message_template: $('emt').value }))
      .catch(err => toast(err.message, 'bad')); };
    $('etest').onclick = e => busy(e.target, async () => { const r = await api('email_test'); toast(`Test to ${r.to}: receipt ${r.receipt === 'sent' ? '✓ sent' : `✗ ${r.receipt}`} · gift/reminder ${r.message === 'sent' ? '✓ sent' : `✗ ${r.message}`}`, r.receipt === 'sent' && r.message === 'sent' ? 'ok' : 'bad'); }).catch(() => {});
    $('fmore').onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
      await api('settings_save', { key: 'referral', value: { enabled: $('re').checked, max_per_year: Number($('rm').value) || 12 } });
      await api('settings_save', { key: 'followup', value: { enabled: $('fu').checked } });
      await save('alerts', { quote_days: Number($('ad').value) || 3 });
    }).catch(() => {}); };
    const storeSheet = x => sheet(`<div class="kicker">Stores</div><h3>${x ? `#${esc(x.code)}` : 'Add a store'}</h3>
      <div class="fgrid"><div><label class="lbl">Store number</label><input class="field" id="sc" maxlength="4" value="${esc(x?.code || '')}" ${x ? 'disabled' : ''} placeholder="4 digits"></div>
      <div><label class="lbl">Region</label><select class="field" id="sr">${Object.keys(C.regions).map(r => `<option value="${r}" ${x?.region === r ? 'selected' : ''}>${r} · ${esc(C.regions[r])}</option>`).join('')}</select></div>
      <div class="wide"><label class="lbl">Name</label><input class="field" id="sn" value="${esc(x?.name || '')}"></div></div>
      ${x ? `<label class="switch" style="margin-top:14px"><input type="checkbox" id="sa" ${x.active ? 'checked' : ''}> Open (staff can clock in here)</label>` : ''}
      <label class="lbl">Opening hours <span style="opacity:.6">(Eastern time; shown on the Stores page)</span></label>
      <label class="switch" style="margin-bottom:6px"><input type="checkbox" id="hon" ${x?.hours ? 'checked' : ''}> Post hours for this store</label>
      <div class="hedit" id="hed" ${x?.hours ? '' : 'hidden'}>${DAYS7.map(([k, l]) => { const h = x?.hours?.[k]; return `<div class="hrow" data-d="${k}"><span>${l}</span><label class="mini"><input type="checkbox" class="hopen" ${!x?.hours || h ? 'checked' : ''}> Open</label>
        <input class="field" type="time" value="${h?.[0] || '09:00'}"><span class="muted">to</span><input class="field" type="time" value="${h?.[1] || (k === 'sun' ? '17:00' : '21:00')}"></div>`; }).join('')}</div>
      <div class="acts"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="ok">Save</button></div>`,
      (el, close) => { el.querySelector('#hon').onchange = ev => el.querySelector('#hed').hidden = !ev.target.checked; el.querySelector('#ok').onclick = e => busy(e.target, async () => {
        await api('store_save', { code: el.querySelector('#sc').value, name: el.querySelector('#sn').value, region: el.querySelector('#sr').value, active: x ? el.querySelector('#sa').checked : true });
        const hours = el.querySelector('#hon').checked ? Object.fromEntries([...el.querySelectorAll('.hrow')].map(r => { const t = r.querySelectorAll('input[type=time]'); return [r.dataset.d, r.querySelector('.hopen').checked ? [t[0].value, t[1].value] : null]; })) : null;
        if (x?.hours || hours) await api('store_hours', { code: el.querySelector('#sc').value, hours });
        close(); toast('Store saved.', 'ok'); await refresh(); pageSettings();
      }).catch(() => {}); });
    $('addStore').onclick = () => storeSheet(null);
    pg.querySelectorAll('[data-i]').forEach(b => b.onclick = () => storeSheet(d.stores[+b.dataset.i]));
  }

  const DAYS7 = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
  const hoursSummary = h => { const wk = DAYS7.slice(0, 5).map(([k]) => h[k]), same = wk.every(x => JSON.stringify(x) === JSON.stringify(wk[0]));
    return same && wk[0] ? `Mon–Fri ${t12(wk[0][0])}–${t12(wk[0][1])}` : `Mon ${h.mon ? `${t12(h.mon[0])}–${t12(h.mon[1])}` : 'closed'} · …`; };
  // ================================================================ closures (managers): days a store, or the online store, is closed
  async function closuresSheet() {
    let d; try { d = await api('stores_public'); } catch (e) { return toast(/function|not find|2\.4/i.test(e.message) ? 'Closures need the 2.4 database update.' : e.message, 'bad'); }
    const name = c => c.store_code ? `#${c.store_code} ${(d.stores.find(x => x.code === c.store_code) || {}).name || ''}` : 'Online store';
    const today = ymd(new Date());
    sheet(`<div class="kicker">Closures</div><h3>Days we're closed</h3>
      <p class="muted" style="margin:4px 0 0;font-size:13.5px">They show on the Stores page and in the terminal. An <b>online store</b> closure stops website checkouts on those days.</p>
      <div class="clist">${d.closures.filter(c => c.ends_on >= today).map(c => `<div class="crow"><div><b>${esc(name(c))}</b><small>${fmtDay(c.starts_on + 'T12:00')}${c.ends_on !== c.starts_on ? ` – ${fmtDay(c.ends_on + 'T12:00')}` : ''}${c.reason ? ` · ${esc(c.reason)}` : ''}</small></div><button class="btn quiet small" data-del="${c.id}">Remove</button></div>`).join('') || '<p class="muted">Nothing on the calendar.</p>'}</div>
      <div class="fgrid" style="margin-top:10px"><div class="wide"><label class="lbl">Where</label><select class="field" id="cs"><option value="">Online store (website checkouts)</option>${storeOptions('', false)}</select></div>
        <div><label class="lbl">From</label><input class="field" id="cf" type="date" value="${today}"></div><div><label class="lbl">To</label><input class="field" id="ct" type="date" value="${today}"></div>
        <div class="wide"><label class="lbl">Why</label><input class="field" id="cr" maxlength="120" placeholder="e.g. Thanksgiving, inventory day"></div></div>
      <div class="acts"><button class="btn quiet" data-close>Done</button><button class="btn primary" id="ok">${ic('plus', 15)} Add closure</button></div>`,
      (el, close) => {
        el.querySelectorAll('[data-del]').forEach(b => b.onclick = e => busy(e.target, async () => { await api('closure_delete', { id: +b.dataset.del }); close(); await refresh(); closuresSheet(); }).catch(() => {}));
        el.querySelector('#ok').onclick = e => busy(e.target, async () => {
          await api('closure_save', { store_code: el.querySelector('#cs').value, starts_on: el.querySelector('#cf').value, ends_on: el.querySelector('#ct').value, reason: el.querySelector('#cr').value });
          close(); toast('Closure added.', 'ok'); await refresh(); closuresSheet();
        }).catch(() => {});
      });
  }

  // ================================================================ start
  async function start() {
    $('app').innerHTML = '<div class="login"><div class="muted"><span class="spin"></span> Loading…</div></div>';
    const { data } = await sb.auth.getSession();
    if (!data.session) return signIn();
    try { await refresh(); }
    catch (e) {
      if (!$('app').querySelector('.login .spin')) return;   // already on the sign-in screen
      $('app').innerHTML = `<div class="login"><div class="card"><h1>Can't load</h1><p>${esc(e.message)}</p><button class="btn primary" id="again">Try again</button><button class="btn quiet" id="so2">Sign out</button></div></div>`;
      $('again').onclick = start; $('so2').onclick = async () => { await sb.auth.signOut(); signIn(); };
      return;
    }
    shell(); go(location.hash.slice(1) || 'today');
  }
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && S.me) { e.preventDefault(); if (!document.querySelector('.cmdk')) openSearch(); return; }
    if (!(e.metaKey || e.ctrlKey) || !S.me || document.querySelector('.scrim') || e.altKey || e.shiftKey) return;
    const list = visible(), n = +e.key;
    if (n >= 1 && n <= Math.min(9, list.length)) { e.preventDefault(); go(list[n - 1].id); }
  });
  setInterval(() => { if (S.me && document.visibilityState === 'visible' && !document.querySelector('.scrim')) refresh().then(() => { if (S.page === 'today') go('today'); }).catch(() => {}); }, 60e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.me) quiet(refresh()); });
  desk?.onUpdate?.(u => {
    if (u.ready) return updateBar(u.ready);                                              // Windows: downloaded, restart to finish
    if (u.downloading) return toast(`Downloading aARgon3 ${u.downloading} in the background…`);
    if (u.latest) return toast(`aARgon3 ${u.latest} is out. Click here to download it.`, 'ok', () => desk.openReleases());   // Mac
    if (u.current) toast(`You're on the latest version (${u.current}).`);
  });
  function updateBar(v) {
    if (document.querySelector('.updbar')) return;
    const b = document.createElement('div'); b.className = 'updbar';
    b.innerHTML = `${ic('download', 16)}<span><b>aARgon3 ${esc(v)} is ready.</b> Restart to update; it takes a few seconds and keeps you signed in.</span><button class="btn small primary">Restart now</button><button class="btn small quiet" aria-label="Later">Later</button>`;
    b.querySelector('.primary').onclick = () => {
      b.querySelector('.primary').innerHTML = '<span class="spin"></span>'; desk.installUpdate();
    };
    b.querySelector('.quiet').onclick = () => { b.remove(); toast('It will install the next time you quit aARgon3.'); };
    document.body.append(b);
  }
  desk?.onMenu?.(p => S.me && (p === 'signout' ? signOut() : go(p)));
  start();
})();
