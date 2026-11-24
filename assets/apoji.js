// aARgon3 2.6: the Apoji pieces of the store. Reads public things from Nexus with the publishable key (nothing private):
//   • a banner when the Apoji status page has an incident on the aARgon3 store, with its known issues, workaround and fixing release
//   • Apoji.look(profile) → a linked Nexus account's picture, frame and name (uses NexusCosmetics when it's on the page)
(function () {
  const CFG = window.A3_CONFIG || {}, STATUS = 'https://apojidelegraphics.github.io/Nexus-28/status/';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function nx(fn, args = {}) {
    const r = await fetch(`${CFG.nexusUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: CFG.nexusKey, Authorization: `Bearer ${CFG.nexusKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`Nexus ${r.status}`);
    return r.json();
  }
  const rel = (text, a3 = true) => { const v = String(text || '').match(/(\d+\.\d+(?:\.\d+)?)/)?.[1]; if (!v) return null;
    return `https://github.com/apojidelegraphics/${a3 || /aargon/i.test(text) ? 'aArgon3' : 'Nexus-28'}/releases/tag/v${v.split('.').length === 2 ? v + '.0' : v}`; };
  async function statusBanner(parts = ['aargon3_store']) {
    if (!CFG.nexusUrl || document.querySelector('.apoji-status')) return;
    let st, links;
    try { [st, links] = await Promise.all([nx('public_status'), nx('public_status_links').catch(() => [])]); } catch { return; }
    const active = (st?.active || []).filter(i => (i.components || []).some(c => parts.includes(c)));
    if (!active.length) return;
    const el = document.createElement('div'); el.className = 'apoji-status';
    el.innerHTML = active.map(i => {
      const l = (links || []).find(x => x.incident === i.id), last = (i.updates || [])[0], fix = l?.release;
      return `<div class="as-row ${esc(i.severity)}"><b>${i.severity === 'maintenance' ? 'Maintenance' : 'Heads-up'}: ${esc(i.title)}</b>${last?.body ? ` <span>${esc(last.body)}</span>` : ''}
        ${(l?.known || []).filter(k => k.workaround).map(k => `<span class="as-tip">Until it's fixed: ${esc(k.workaround)}</span>`).join('')}
        ${fix ? `<span class="as-tip">Fix: ${rel(fix, false) ? `<a href="${esc(rel(fix, false))}" target="_blank" rel="noopener">${esc(fix)}</a>` : esc(fix)}</span>` : ''}
        <a href="${STATUS}#incident-${esc(i.id)}" target="_blank" rel="noopener">Status page →</a></div>`;
    }).join('');
    (document.querySelector('header.nav, .topbar, header') || document.body.firstElementChild)?.insertAdjacentElement('afterend', el);
  }
  // a linked Nexus account (the copy aARgon3 keeps on the order)
  function look(p, size = 44) {
    if (!p) return '';
    const NXC = window.NexusCosmetics, name = p.display_name || p.nickname || p.username;
    const av = NXC ? NXC.avatarHtml(p.avatar_url, name, p.frame, size, { crown: !!p.owner }) : `<span class="ap-av" style="width:${size}px;height:${size}px">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc(String(name || '?')[0].toUpperCase())}</span>`;
    const nm = NXC ? NXC.nameHtml(name, { font: p.font, color: p.color, name_a: p.name_a, name_b: p.name_b }) : esc(name);
    return `<span class="ap-look">${av}<span><b>${nm}</b><small>@${esc(p.username)}</small></span></span>`;
  }
  const avatar = (p, size = 44) => { if (!p) return ''; const NXC = window.NexusCosmetics, name = p.display_name || p.nickname || p.username;
    return NXC ? NXC.avatarHtml(p.avatar_url, name, p.frame, size, { crown: !!p.owner }) : `<span class="ap-av" style="width:${size}px;height:${size}px">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc(String(name || '?')[0].toUpperCase())}</span>`; };
  window.Apoji = { nx, statusBanner, look, avatar, rel, STATUS };
  const go = () => { const parts = document.body?.dataset.apojiParts; if (parts !== 'none') statusBanner(parts ? parts.split(',') : ['aargon3_store']); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
