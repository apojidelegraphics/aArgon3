// Customer / company detail fields, the same in the store and the terminal. They come from catalog.json → fields,
// so Personal asks for a name and email, Business adds the registered business name, and Enterprise asks for the
// corporate entity, lead operator, Omni-QNCN node and jurisdiction (with Generate buttons, like the old terminal).
//   A3forms.html(plan, values)     → the inputs
//   A3forms.wire(el, { os, region }) → hooks up the Generate buttons
//   A3forms.read(el, plan)         → { first, last, email, … } (checked; throws a readable error)
(function () {
  const A3 = window.A3, C = A3.C;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const auto = { first: 'given-name', last: 'family-name', email: 'email', phone: 'tel', company: 'organization', title: 'organization-title', billing_email: 'email' };
  function html(plan, values = {}) {
    const fields = C.fields[plan] || C.fields.personal;
    return `<div class="fgrid">${fields.map(f => {
      const wide = ['company', 'node', 'jurisdiction', 'billing_email'].includes(f.key) || (f.key === 'email' && plan === 'personal');
      const input = `<input class="field" data-f="${f.key}" type="${f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : 'text'}" placeholder="${esc(f.placeholder || '')}"
        value="${esc(values[f.key] || '')}" ${f.required ? 'required' : ''} autocomplete="${auto[f.key] || 'off'}" maxlength="${f.key === 'company' ? 160 : 120}">`;
      return `<div class="${wide ? 'wide' : ''}"><label class="lbl">${esc(f.label)}${f.required ? '' : ' <span style="opacity:.6">(optional)</span>'}</label>
        ${f.generate ? `<div class="fgen">${input}<button type="button" class="btn small" data-gen="${f.generate}">Generate</button></div>` : input}</div>`;
    }).join('')}</div>`;
  }
  function wire(el, ctx = {}) {
    el.querySelectorAll('[data-gen]').forEach(b => b.onclick = () => {
      const input = b.parentElement.querySelector('input');
      input.value = b.dataset.gen === 'node' ? A3.nodeId(typeof ctx.os === 'function' ? ctx.os() : ctx.os) : A3.jurisdiction(typeof ctx.region === 'function' ? ctx.region() : ctx.region);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  function values(el) { const v = {}; el.querySelectorAll('[data-f]').forEach(i => v[i.dataset.f] = i.value.trim()); return v; }
  function read(el, plan) {
    try { return A3.customer(plan, values(el)); }
    catch (e) {
      const f = (C.fields[plan] || []).find(x => e.message.startsWith(x.label));
      const input = f && el.querySelector(`[data-f="${f.key}"]`);
      if (input) { input.focus(); input.classList.add('bad'); setTimeout(() => input.classList.remove('bad'), 2500); }
      throw e;
    }
  }
  window.A3forms = { html, wire, read, values };
})();
