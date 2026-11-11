// Smart Sticky Notes - frontend (Tailwind CSS + Lucide icons + Tajawal font)
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ''}</svg>`;
const S = {
  token: localStorage.getItem('tk'), me: null, data: null, tab: location.hash.slice(1) || 'board', sel: null, open: new Set(),
  // board filter & pagination
  bq: '', bPri: 'all', bUser: 'all', bSort: 'pri', bPage: 1, bPer: 8,
  // tree filter & pagination
  tq: '', tDept: 'all', tPri: 'all', tPage: 1, tPer: 5,
  // history filter & pagination
  hq: '', hProj: 'all', hState: 'all', hPage: 1, hPer: 8,
  // admin filter & pagination
  uq: '', uRole: 'all', uDept: 'all', uPage: 1, uPer: 8,
  dq: '', dKind: 'all', dPage: 1, dPer: 6,
  // alerts filter & pagination
  aq: '', aState: 'active', aPage: 1, aPer: 8,
  // real-time state
  liveEs: null, liveConnected: false, lastVer: 0, detailNoteId: null, detailIsArchived: false,
};
const ROLE = { admin: 'مدير عام', manager: 'مدير قسم', employee: 'موظف' };

async function call(method, url, body) {
  const r = await fetch('/api/' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (S.token || '') }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const j = await r.json();
  if (!r.ok) { if (r.status === 401 && S.me) logout(true); throw new Error(j.error || 'خطأ'); }
  return j;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2800); }
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const showModal = () => { $('#modal').classList.remove('hidden'); $('#modal').classList.add('flex'); };
const hideModal = () => { S.detailNoteId = null; $('#modal').classList.add('hidden'); $('#modal').classList.remove('flex'); };
const modalOpen = () => !$('#modal').classList.contains('hidden');

function captureUiState() {
  const ae = document.activeElement;
  const inApp = ae && $('#app')?.contains(ae) && ae.id;
  let selStart = null, selEnd = null;
  try { selStart = ae?.selectionStart; selEnd = ae?.selectionEnd; } catch {}
  return {
    focusId: inApp ? ae.id : null,
    selStart,
    selEnd,
    mainScroll: $('#main')?.scrollTop || 0,
    asideScroll: document.querySelector('#body aside')?.scrollTop || 0,
    bodyScroll: $('#body')?.scrollTop || 0,
  };
}
function restoreUiState(st) {
  if (!st) return;
  if ($('#main') && st.mainScroll) $('#main').scrollTop = st.mainScroll;
  const aside = document.querySelector('#body aside');
  if (aside && st.asideScroll) aside.scrollTop = st.asideScroll;
  if ($('#body') && st.bodyScroll) $('#body').scrollTop = st.bodyScroll;
  if (st.focusId) {
    const el = document.getElementById(st.focusId);
    if (el) {
      el.focus();
      try { if (st.selStart !== null) el.setSelectionRange(st.selStart, st.selEnd); } catch {}
    }
  }
}

// ---------- priority engine ----------
const PRI = {
  future:   { label: 'لم تبدأ',        cls: 'p-future',   badge: 'b-future',   rank: 5, icon: 'hourglass',    dot: 'bg-sky-400' },
  low:      { label: 'أولوية منخفضة',   cls: 'p-low',      badge: 'b-low',      rank: 4, icon: 'leaf',         dot: 'bg-emerald-500' },
  medium:   { label: 'أولوية متوسطة',   cls: 'p-medium',   badge: 'b-medium',   rank: 3, icon: 'clock',        dot: 'bg-amber-400' },
  high:     { label: 'أولوية عالية',    cls: 'p-high',     badge: 'b-high',     rank: 2, icon: 'zap',          dot: 'bg-orange-500' },
  critical: { label: 'حرجة',           cls: 'p-critical', badge: 'b-critical', rank: 1, icon: 'flame',        dot: 'bg-rose-500' },
  late:     { label: 'متأخرة',         cls: 'p-late',     badge: 'b-late',     rank: 0, icon: 'timer-off',    dot: 'bg-red-600' },
  pending:  { label: 'بانتظار التأكيد', cls: 'p-pending',  badge: 'b-pending',  rank: 6, icon: 'shield-check', dot: 'bg-indigo-500' },
};
function priority(n, now = Date.now()) {
  if (n.status === 'pending') return 'pending';
  const s = Date.parse(n.start), e = Date.parse(n.end), left = e - now, DAY = 864e5;
  if (left < 0) return 'late';
  if (now < s) return 'future';
  const frac = (now - s) / Math.max(1, e - s);
  if (left <= DAY || frac >= .9) return 'critical';
  if (left <= 3 * DAY || frac >= .7) return 'high';
  if (left <= 7 * DAY || frac >= .4) return 'medium';
  return 'low';
}
function remaining(n) {
  const left = Date.parse(n.end) - Date.now(), a = Math.abs(left), d = Math.floor(a / 864e5), h = Math.floor(a % 864e5 / 36e5), m = Math.floor(a % 36e5 / 6e4);
  const t = d ? `${d} يوم ${h} س` : h ? `${h} س ${m} د` : `${m} د`;
  return left < 0 ? `متأخرة ${t}` : `متبقي ${t}`;
}
const fmt = d => {
  const dt = new Date(d);
  return `${dt.toLocaleDateString('ar', { day: 'numeric', month: 'short', year: 'numeric' })} • ${dt.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}`;
};
const toLocalInput = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const nm = id => (S.data.users.find(u => u.id === id) || {}).name || '—';
const deptName = id => (S.data.departments.find(d => d.id === id) || {}).name || '—';
const canConfirm = n => S.me.role === 'admin' || (S.me.role === 'manager' && (S.data.users.find(u => u.id === n.assigneeId) || {}).managerId === S.me.id);
const isMgr = () => S.me.role !== 'employee';
const empty = (icon, text) => `<div class="col-span-full flex flex-col items-center gap-2 py-12 text-slate-400">${ic(icon, '!h-10 !w-10')}<span>${text}</span></div>`;

// ---------- pagination helper ----------
function paginate(list, page, per) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / per));
  const cur = Math.min(Math.max(1, page), pages);
  const start = (cur - 1) * per;
  return { items: list.slice(start, start + per), cur, pages, total, from: total ? start + 1 : 0, to: Math.min(start + per, total) };
}
function pagerHtml(pg, prefix) {
  if (pg.total <= pg.items.length && pg.pages <= 1) return '';
  const btns = [];
  for (let i = 1; i <= pg.pages; i++) {
    if (i === 1 || i === pg.pages || Math.abs(i - pg.cur) <= 1) {
      btns.push(`<button data-pg="${prefix}:${i}" class="flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs font-bold transition ${i === pg.cur ? 'bg-brand-600 text-white shadow-sm' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50'}">${i}</button>`);
    } else if (btns[btns.length - 1] !== '<span class="px-1 text-slate-400">…</span>') {
      btns.push('<span class="px-1 text-slate-400">…</span>');
    }
  }
  return `<div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/80 px-3.5 py-2 text-xs text-slate-600 ring-1 ring-slate-200/80">
    <span>عرض <b>${pg.from}–${pg.to}</b> من <b>${pg.total}</b></span>
    <div class="flex items-center gap-1">
      <button data-pg="${prefix}:${pg.cur - 1}" ${pg.cur <= 1 ? 'disabled' : ''} class="btn btn-ghost btn-sm !px-2">${ic('chevron-right')}السابق</button>
      ${btns.join('')}
      <button data-pg="${prefix}:${pg.cur + 1}" ${pg.cur >= pg.pages ? 'disabled' : ''} class="btn btn-ghost btn-sm !px-2">التالي${ic('chevron-left')}</button>
    </div>
  </div>`;
}

// ---- finished notes: shown compactly (one-line chips inside a collapsed section) ----
const shortDate = d => new Date(d).toLocaleDateString('ar', { day: 'numeric', month: 'short' });
const doneTip = d => `${d.title} — أنجزها ${nm(d.assigneeId)} • أُكّدت ${fmt(d.confirmedAt)} (اضغط لعرض التفاصيل)`;
function doneSection(list) {
  if (!list.length) return '';
  return `<details class="mt-6 rounded-2xl bg-white/80 ring-1 ring-slate-200"><summary class="flex cursor-pointer select-none items-center gap-2 px-4 py-2.5 text-sm font-bold text-emerald-700">${ic('check-check')}المنتهية (${list.length})<span class="ms-auto text-slate-400">${ic('chevron-down')}</span></summary>
    <div class="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto px-4 pb-3">${list.map(d => `<button type="button" data-nd="done:${d.id}" title="${esc(doneTip(d))}" class="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-800 ring-1 ring-emerald-200 transition hover:bg-emerald-100 hover:shadow-sm">${ic('check')}<span class="truncate">${esc(d.title)}</span><span class="text-emerald-600/70">${shortDate(d.confirmedAt)}</span></button>`).join('')}</div></details>`;
}
function doneFooter(list) {
  if (!list.length) return '';
  return `<details class="border-t border-slate-200 bg-emerald-50/60 text-xs"><summary class="flex cursor-pointer select-none items-center gap-1.5 px-2 py-1.5 font-bold text-emerald-700">${ic('check-check')}منتهية (${list.length})</summary>
    <ul class="max-h-28 space-y-0.5 overflow-y-auto px-2 pb-2">${list.map(d => `<li data-nd="done:${d.id}" title="${esc(doneTip(d))}" class="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-emerald-900 transition hover:bg-emerald-100">${ic('check', 'text-emerald-600')}<span class="truncate">${esc(d.title)}</span><span class="ms-auto flex-none text-emerald-600/70">${shortDate(d.confirmedAt)}</span></li>`).join('')}</ul></details>`;
}

// identifies this browser/device to the server (kept in the user's device list)
function webDevice() {
  let k = localStorage.getItem('dk'); if (!k) { k = 'web-' + Math.random().toString(36).slice(2, 12); localStorage.setItem('dk', k); }
  return { key: k, kind: 'web', name: navigator.platform, os: navigator.userAgent, screen: screen.width + 'x' + screen.height };
}
function getSavedAccounts() {
  try { return JSON.parse(localStorage.getItem('sn_accounts') || '[]'); } catch { return []; }
}
function saveAccountCreds(username, password, user, token) {
  if (!username) return;
  const list = getSavedAccounts().filter(a => a.username !== username);
  list.unshift({
    username,
    password: password || '',
    name: user?.name || username,
    role: user?.role || 'employee',
    token: token || '',
    updatedAt: Date.now(),
  });
  localStorage.setItem('sn_accounts', JSON.stringify(list.slice(0, 6)));
  localStorage.setItem('sn_last_creds', JSON.stringify({ username, password: password || '' }));
}
function removeSavedAccount(username) {
  const list = getSavedAccounts().filter(a => a.username !== username);
  localStorage.setItem('sn_accounts', JSON.stringify(list));
  const last = JSON.parse(localStorage.getItem('sn_last_creds') || '{}');
  if (last.username === username) localStorage.removeItem('sn_last_creds');
}

// ---------- boot & real-time SSE ----------
async function boot() {
  if (S.token) {
    try {
      S.me = await call('GET', 'me');
      localStorage.removeItem('sn_explicit_logout');
      const ex = getSavedAccounts().find(a => a.username === S.me.username);
      saveAccountCreds(S.me.username, ex?.password || '', S.me, S.token);
      await refresh();
      connectLive();
      return;
    } catch {
      S.token = null;
      localStorage.removeItem('tk');
    }
  }
  // Auto-restore session from device or saved credentials unless user explicitly clicked Logout
  if (localStorage.getItem('sn_explicit_logout') !== '1') {
    try {
      const r = await call('POST', 'auto-login', { device: webDevice() });
      S.token = r.token; S.me = r.user; localStorage.setItem('tk', r.token);
      const ex = getSavedAccounts().find(a => a.username === r.user.username);
      saveAccountCreds(r.user.username, ex?.password || '', r.user, r.token);
      await refresh(); connectLive();
      return;
    } catch {}
    const saved = getSavedAccounts()[0];
    if (saved && saved.username && saved.password) {
      try {
        const r = await call('POST', 'login', { username: saved.username, password: saved.password, device: webDevice() });
        S.token = r.token; S.me = r.user; localStorage.setItem('tk', r.token);
        saveAccountCreds(saved.username, saved.password, r.user, r.token);
        await refresh(); connectLive();
        return;
      } catch {}
    }
  }
  loginView();
}
async function refresh(silent = false) {
  const d = await call('GET', 'data');
  S.data = d;
  if (d.v) S.lastVer = d.v;
  if (d.codeVer) S.codeVer = d.codeVer;
  render(silent);
  checkScheduledAlerts();
  if (modalOpen() && S.detailNoteId) {
    const openNote = S.data.notes.find(x => x.id === S.detailNoteId);
    const doneNote = S.data.done.find(x => x.id === S.detailNoteId) || cachedHistory.find(x => x.id === S.detailNoteId);
    if (openNote) showNoteDetails(openNote, false);
    else if (doneNote) showNoteDetails(doneNote, true);
    else hideModal();
  }
}
let liveTimer = null;
function updateLiveDot() {
  const dot = $('#live-dot');
  if (!dot) return;
  dot.className = `flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-bold ${S.liveConnected ? 'text-emerald-300' : 'text-amber-300'}`;
  dot.innerHTML = `<span class="h-2 w-2 rounded-full ${S.liveConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}"></span>${S.liveConnected ? 'مباشر' : 'يتصل...'}`;
}
function connectLive() {
  disconnectLive();
  if (!S.token) return;
  const es = new EventSource('/api/events?token=' + encodeURIComponent(S.token));
  S.liveEs = es;
  es.onopen = () => { S.liveConnected = true; updateLiveDot(); };
  es.onerror = () => { S.liveConnected = false; updateLiveDot(); };
  es.onmessage = e => {
    try {
      const msg = JSON.parse(e.data || '{}');
      if (msg.codeVer && S.codeVer && msg.codeVer !== S.codeVer) {
        location.reload();
        return;
      }
      if (msg.codeVer) S.codeVer = msg.codeVer;
      if (msg.v && msg.v !== S.lastVer) {
        clearTimeout(liveTimer);
        liveTimer = setTimeout(() => { if (S.me) refresh(true).catch(() => {}); }, 80);
      }
    } catch {}
  };
}
function disconnectLive() {
  if (S.liveEs) { try { S.liveEs.close(); } catch {} S.liveEs = null; }
  S.liveConnected = false;
}
function logout(silent) {
  disconnectLive();
  if (!silent) {
    localStorage.setItem('sn_explicit_logout', '1');
    call('POST', 'logout', { deviceKey: localStorage.getItem('dk') }).catch(() => {});
  }
  localStorage.removeItem('tk'); S.token = null; S.me = null; loginView();
}

function loginView() {
  const accounts = getSavedAccounts();
  let last = {};
  try { last = JSON.parse(localStorage.getItem('sn_last_creds') || '{}'); } catch {}
  if (!last.username && accounts[0]) last = accounts[0];

  const savedHtml = accounts.length ? `<div class="mb-4 rounded-2xl bg-slate-50/90 p-3 ring-1 ring-slate-200/80">
    <div class="mb-2 flex items-center gap-1.5 text-xs font-extrabold text-slate-600">${ic('shield-check', 'text-brand-600')}الحسابات المحفوظة على هذا الجهاز (دخول بنقرة واحدة)</div>
    <div class="space-y-1.5">${accounts.map(a => `<div class="flex items-center gap-1.5">
      <button type="button" data-qa="${esc(a.username)}" class="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-white px-3 py-2 text-start text-xs shadow-sm ring-1 ring-slate-200/90 transition hover:bg-brand-50 hover:ring-brand-300">
        <span class="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-brand-100 text-brand-700 font-bold">${ic('user')}</span>
        <div class="min-w-0 flex-1">
          <div class="truncate font-extrabold text-slate-800">${esc(a.name || a.username)}</div>
          <div class="truncate text-[11px] text-slate-400">@${esc(a.username)} • ${ROLE[a.role] || 'مستخدم'}</div>
        </div>
        <span class="rounded-lg bg-brand-600 px-2 py-1 text-[11px] font-bold text-white">دخول ←</span>
      </button>
      <button type="button" data-rm-acc="${esc(a.username)}" title="إزالة الحساب من هذا الجهاز" class="btn btn-ghost btn-sm !p-1.5 text-slate-400 hover:!text-rose-600">${ic('x')}</button>
    </div>`).join('')}</div>
  </div>` : '';

  $('#app').innerHTML = `<div class="flex min-h-screen items-center justify-center p-4">
    <form id="lf" autocomplete="on" class="w-full max-w-sm rounded-3xl bg-white/90 p-8 shadow-2xl shadow-brand-500/20 ring-1 ring-slate-200 backdrop-blur">
      <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-300 text-amber-900 shadow-md -rotate-6">${ic('sticky-note', '!h-8 !w-8')}</div>
      <h2 class="mb-1 text-center text-2xl font-extrabold text-slate-800">النوتات الذكية</h2>
      <p class="mb-5 text-center text-sm text-slate-500">سجّل الدخول لمتابعة مهامك</p>
      ${savedHtml}
      <label class="label">اسم المستخدم</label><div class="relative">${ic('user', 'absolute start-3 top-1/2 -translate-y-1/2 text-slate-400')}<input id="u" name="username" autocomplete="username" value="${esc(last.username || '')}" class="input ps-9" autofocus></div>
      <label class="label">كلمة المرور</label><input id="p" name="password" type="password" autocomplete="current-password" value="${esc(last.password || '')}" class="input">
      <label class="mt-3 flex cursor-pointer select-none items-center gap-2 text-xs font-bold text-slate-700">
        <input id="rem" type="checkbox" checked class="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500">
        <span>تذكر بيانات الدخول على هذا الجهاز</span>
      </label>
      <div id="le" class="mt-2 min-h-5 text-sm text-rose-600"></div>
      <button class="btn mt-2 w-full py-2.5 text-base">دخول</button></form></div>`;

  const doLogin = async (username, password, remember = true) => {
    try {
      const r = await call('POST', 'login', { username, password, device: webDevice() });
      S.token = r.token; S.me = r.user;
      localStorage.setItem('tk', r.token);
      localStorage.removeItem('sn_explicit_logout');
      if (remember) saveAccountCreds(username, password, r.user, r.token);
      await refresh(); connectLive();
    } catch (x) {
      $('#le').textContent = x.message;
    }
  };

  document.querySelectorAll('[data-qa]').forEach(b => b.onclick = async () => {
    const acc = accounts.find(a => a.username === b.dataset.qa);
    if (!acc) return;
    if (acc.password) {
      await doLogin(acc.username, acc.password, true);
    } else if (acc.token) {
      try {
        S.token = acc.token;
        S.me = await call('GET', 'me');
        localStorage.setItem('tk', acc.token);
        localStorage.removeItem('sn_explicit_logout');
        await refresh(); connectLive();
      } catch {
        $('#u').value = acc.username; $('#p').focus();
      }
    }
  });
  document.querySelectorAll('[data-rm-acc]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    removeSavedAccount(b.dataset.rmAcc);
    loginView();
  });

  $('#lf').onsubmit = async e => {
    e.preventDefault();
    await doLogin($('#u').value.trim(), $('#p').value, $('#rem').checked);
  };
}

// ---------- layout ----------
function render(silent = false) {
  if (!S.me) return;
  const uiState = captureUiState();
  const activeAlerts = (S.data?.alerts || []).filter(a => a.status === 'active' && a.targetId === S.me.id).length;
  const tb = (t, l, i, badge = 0) => `<button data-t="${t}" class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${S.tab === t ? 'bg-white text-brand-700 shadow' : 'text-indigo-100 hover:bg-white/10'}">${ic(i)}${l}${badge ? `<span class="ms-0.5 rounded-full bg-teal-400 px-1.5 py-0.2 text-[11px] font-extrabold text-slate-900">${badge}</span>` : ''}</button>`;
  $('#app').innerHTML = `<header class="flex flex-wrap items-center gap-3 bg-brand-900 px-5 py-2.5 text-white shadow-md">
    <div class="flex items-center gap-2 text-lg font-extrabold"><span class="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-300 text-amber-900 -rotate-6">${ic('sticky-note')}</span>النوتات الذكية</div>
    <nav class="flex flex-1 flex-wrap gap-1.5 ps-4">${tb('board', 'اللوحة', 'layout-grid')}${tb('tree', 'الشجرة', 'git-fork')}${tb('alerts', 'التنبيهات', 'bell-ring', activeAlerts)}${tb('history', 'الأرشيف', 'archive')}${S.me.role === 'admin' ? tb('admin', 'الأقسام والمستخدمون', 'users') : ''}</nav>
    <span id="live-dot" title="التزامن الفوري المباشر (Real-Time)" class="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-bold ${S.liveConnected ? 'text-emerald-300' : 'text-amber-300'}"><span class="h-2 w-2 rounded-full ${S.liveConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}"></span>${S.liveConnected ? 'مباشر' : 'يتصل...'}</span>
    <a href="/api/desktop-setup?token=${encodeURIComponent(S.token || '')}" title="تحميل أداة إظهار نوتاتك وتنبيهاتك على سطح المكتب لجهازك" class="flex items-center gap-1.5 rounded-full bg-amber-300 px-3 py-1 text-xs font-extrabold text-amber-950 shadow-sm transition hover:bg-amber-200">${ic('monitor')}ربط سطح المكتب</a>
    <div class="flex items-center gap-2 rounded-full bg-white/10 py-1 pe-3 ps-1 text-sm"><span class="flex h-7 w-7 items-center justify-center rounded-full bg-brand-500">${ic('user')}</span>
      <span>${esc(S.me.name)}</span><span class="chip bg-white/20 text-indigo-100">${ROLE[S.me.role]}${S.me.deptId ? ' • ' + esc(deptName(S.me.deptId)) : ''}</span></div>
    <button id="chpw" title="تغيير كلمة المرور" class="btn btn-ghost btn-sm">${ic('key-round')}كلمة المرور</button>
    <button id="lo" class="btn btn-ghost btn-sm">${ic('log-out')}خروج</button></header>
    <div id="body"></div>`;
  $('#chpw').onclick = () => passwordForm();
  $('#lo').onclick = () => logout();
  document.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { S.tab = b.dataset.t; render(); });
  ({ admin: S.me.role === 'admin' ? adminView : boardView, history: historyView, tree: treeView, alerts: alertsView }[S.tab] || boardView)(silent);
  restoreUiState(uiState);
}

function passwordForm() {
  S.detailNoteId = null;
  const m = $('#modal');
  m.innerHTML = `<form class="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl ring-1 ring-slate-200">
    <div class="mb-3 flex items-center gap-2.5">
      <span class="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-600 text-white">${ic('key-round')}</span>
      <div>
        <h3 class="text-lg font-extrabold text-slate-800">تغيير كلمة المرور</h3>
        <p class="text-xs text-slate-500">تحديث كلمة المرور الخاصة بحسابك (${esc(S.me.name)})</p>
      </div>
    </div>
    <label class="label">كلمة المرور الحالية</label>
    <input name="currentPassword" type="password" autocomplete="current-password" class="input" required autofocus>
    <label class="label">كلمة المرور الجديدة</label>
    <input name="newPassword" type="password" autocomplete="new-password" minlength="4" placeholder="4 أحرف أو أرقام على الأقل" class="input" required>
    <label class="label">تأكيد كلمة المرور الجديدة</label>
    <input name="confirmPassword" type="password" autocomplete="new-password" minlength="4" class="input" required>
    <div id="pwe" class="mt-2 min-h-5 text-xs font-bold text-rose-600"></div>
    <div class="mt-4 flex gap-2">
      <button class="btn">${ic('check')}حفظ كلمة المرور</button>
      <button type="button" class="btn btn-ghost" id="cx">${ic('x')}إلغاء</button>
    </div>
  </form>`;
  showModal();
  $('#cx').onclick = hideModal;
  m.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    if (b.newPassword !== b.confirmPassword) {
      $('#pwe').textContent = 'كلمة المرور الجديدة وتأكيدها غير متطابقين';
      return;
    }
    try {
      const r = await call('POST', 'password', { currentPassword: b.currentPassword, newPassword: b.newPassword });
      saveAccountCreds(S.me.username, b.newPassword, r.user || S.me, r.token || S.token);
      hideModal();
      toast('تم تغيير كلمة المرور بنجاح');
    } catch (err) {
      $('#pwe').textContent = err.message;
    }
  };
}

// ---------- sidebar tree (board page) ----------
function dotCls(n) { return PRI[priority(n)].dot; }
function treeHtml() {
  const { departments, projects, notes } = S.data;
  const row = (sel, inner, extra = '') => `<div data-sel="${sel}" class="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition hover:bg-brand-50 ${S.sel && sel.endsWith(':' + S.sel.id) ? 'bg-brand-100 text-brand-700 font-bold' : ''} ${extra}">${inner}</div>`;
  const noteLi = n => {
    const kids = notes.filter(c => c.parentId === n.id);
    return `<li>${row('note:' + n.id, `<span class="h-2.5 w-2.5 flex-none rounded-full ${dotCls(n)}"></span><span class="truncate">${esc(n.title)}</span>`)}${kids.length ? `<ul class="ms-4 border-s border-slate-200 ps-1">${kids.map(noteLi).join('')}</ul>` : ''}</li>`;
  };
  const caret = id => `<span data-tg="${id}" class="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-200">${ic(S.open.has(id) ? 'chevron-down' : 'chevron-left')}</span>`;
  return `<div data-sel="all:all" class="mb-1 flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-bold transition hover:bg-brand-50 ${!S.sel ? 'bg-brand-100 text-brand-700' : 'text-slate-700'}">${ic('layout-grid', 'text-brand-600')}عرض الكل (${notes.length})</div>
    <ul class="space-y-1">${departments.map(d => {
      const dp = projects.filter(p => p.deptId === d.id);
      return `<li>${row('dept:' + d.id, `${caret(d.id)}${ic('building-2', 'text-brand-600')}<b>${esc(d.name)}</b><span class="ms-auto text-xs text-slate-400">${dp.length}</span>`)}
        ${S.open.has(d.id) ? `<ul class="ms-3 border-s border-slate-200 ps-1">${dp.map(p => {
          const cnt = notes.filter(n => n.projectId === p.id).length;
          return `<li>${row('proj:' + p.id, `${caret(p.id)}${ic('folder', 'text-amber-500')}<span class="truncate font-medium">${esc(p.name)}</span><span class="ms-auto text-xs text-slate-400">${cnt}</span>`)}
          ${S.open.has(p.id) ? `<ul class="ms-4 border-s border-slate-200 ps-1">${notes.filter(n => n.projectId === p.id && !n.parentId).map(noteLi).join('')}</ul>` : ''}</li>`;
        }).join('')}</ul>` : ''}</li>`;
    }).join('')}</ul>`;
}

function boardView() {
  const { projects, notes, users } = S.data;
  if (!S.open.size) S.data.departments.forEach(d => S.open.add(d.id));
  $('#body').innerHTML = `<div class="grid h-[calc(100vh-56px)] grid-cols-[18rem_1fr]">
    <aside class="overflow-auto border-e border-slate-200 bg-white/90 p-3 backdrop-blur">
      <div class="mb-3 flex flex-col gap-1.5">
        ${isMgr() ? `<button id="np" class="btn btn-sm w-full">${ic('folder-plus')}مشروع جديد</button>` : ''}
        <button id="npn-side" class="btn btn-sm w-full ${isMgr() ? 'btn-ghost' : ''}">${ic('plus')}نوتة خاصة بي</button>
      </div>${treeHtml()}
      ${!S.data.departments.length ? empty('inbox', 'لا توجد بيانات') : ''}</aside><section class="overflow-auto p-5" id="main"></section></div>`;
  document.querySelectorAll('[data-tg]').forEach(el => el.onclick = e => { e.stopPropagation(); const id = el.dataset.tg; S.open.has(id) ? S.open.delete(id) : S.open.add(id); render(); });
  document.querySelectorAll('[data-sel]').forEach(el => el.onclick = () => {
    const [type, id] = el.dataset.sel.split(':');
    S.sel = type === 'all' ? null : { type, id };
    S.bPage = 1;
    if (type === 'proj') S.open.add(id);
    render();
  });
  if ($('#np')) $('#np').onclick = newProject;
  if ($('#npn-side')) $('#npn-side').onclick = () => personalNoteForm();
  renderBoardMain();
}

function renderBoardMain() {
  const { projects, notes, users } = S.data;
  let baseList, title, proj = null;
  if (S.sel?.type === 'proj') { proj = projects.find(p => p.id === S.sel.id); baseList = notes.filter(n => n.projectId === S.sel.id); title = proj?.name || ''; }
  else if (S.sel?.type === 'dept') { const ids = projects.filter(p => p.deptId === S.sel.id).map(p => p.id); baseList = notes.filter(n => ids.includes(n.projectId)); title = deptName(S.sel.id); }
  else if (S.sel?.type === 'note') { const n = notes.find(x => x.id === S.sel.id); baseList = n ? notes.filter(x => x.id === n.id || x.parentId === n.id) : []; title = 'النوتة المحددة'; }
  else { baseList = notes; title = S.me.role === 'employee' ? 'نوتاتي' : 'كل النوتات'; }

  // counts per priority (before priority/search filter, so user sees numbers on chips)
  const counts = { all: baseList.length };
  Object.keys(PRI).forEach(k => counts[k] = 0);
  baseList.forEach(n => { const k = priority(n); counts[k] = (counts[k] || 0) + 1; });

  // apply search & filters
  const q = S.bq.trim().toLowerCase();
  let list = baseList.filter(n => {
    if (S.bPri !== 'all' && priority(n) !== S.bPri) return false;
    if (S.bUser !== 'all' && n.assigneeId !== S.bUser) return false;
    if (q) {
      const pName = (projects.find(p => p.id === n.projectId) || {}).name || '';
      const uName = nm(n.assigneeId);
      const hay = `${n.title} ${n.description || ''} ${pName} ${uName}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // sort
  list = list.slice().sort((a, b) => {
    if (S.bSort === 'end') return Date.parse(a.end) - Date.parse(b.end);
    if (S.bSort === 'new') return Date.parse(b.createdAt || b.start) - Date.parse(a.createdAt || a.start);
    if (S.bSort === 'title') return (a.title || '').localeCompare(b.title || '', 'ar');
    return PRI[priority(a)].rank - PRI[priority(b)].rank || Date.parse(a.end) - Date.parse(b.end);
  });

  const pg = paginate(list, S.bPage, S.bPer);
  S.bPage = pg.cur;

  const scopeIds = new Set(S.sel?.type === 'proj' ? [S.sel.id] : S.sel?.type === 'dept' ? projects.filter(p => p.deptId === S.sel.id).map(p => p.id) : projects.map(p => p.id));
  const pend = isMgr() ? notes.filter(n => n.status === 'pending' && canConfirm(n)).length : 0;
  const emps = users.filter(u => u.role === 'employee');
  const hasFilters = S.bq || S.bPri !== 'all' || S.bUser !== 'all' || S.bSort !== 'pri';

  const filterChips = `<div class="flex flex-wrap items-center gap-1.5">
    <button data-bpri="all" class="chip transition ${S.bPri === 'all' ? 'bg-slate-800 text-white shadow-sm' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}">الكل (${counts.all})</button>
    ${Object.entries(PRI).map(([k, p]) => `<button data-bpri="${k}" class="chip transition ${ p.cls } ${S.bPri === k ? 'ring-2 ring-slate-900 scale-105 shadow-sm' : 'opacity-80 hover:opacity-100'}">${ic(p.icon)}${p.label} (${counts[k] || 0})</button>`).join('')}
  </div>`;

  $('#main').innerHTML = `<div class="mb-3 flex flex-wrap items-center gap-2"><h2 class="me-auto flex items-center gap-2 text-xl font-extrabold">${ic(proj ? 'folder' : 'layout-grid', 'text-brand-600')}${esc(title)} <span class="text-sm font-medium text-slate-400">(${list.length})</span></h2>
    ${pend ? `<button data-bpri="pending" class="chip p-pending !text-xs cursor-pointer">${ic('hourglass')}${pend} بانتظار تأكيدك</button>` : ''}
    <button id="npn" class="btn ${proj && isMgr() && !proj.personal ? 'btn-ghost' : ''}">${ic('sticky-note')}نوتة خاصة</button>
    ${proj && isMgr() && !proj.personal ? `<button id="nn" class="btn">${ic('plus')}نوتة للمشروع</button><button class="btn btn-ghost" id="ep">${ic('pencil')}تعديل</button><button class="btn btn-ghost" id="ar">${ic('archive')}أرشفة</button><button class="btn btn-danger" id="dp">${ic('trash-2')}حذف المشروع</button>` : ''}</div>
    ${proj && isMgr() && !proj.personal && !baseList.length ? `<div class="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-emerald-50 p-4 text-emerald-900 ring-1 ring-emerald-200">${ic('check-check', '!h-6 !w-6')}<span class="me-auto text-sm font-medium">لا توجد نوتات نشطة في هذا المشروع — كل المهام منتهية ومؤكدة. يمكنك أرشفته الآن.</span><button class="btn btn-ok" id="ar2">${ic('archive')}أرشفة المشروع</button></div>` : ''}

    <!-- Search & Filter Toolbar -->
    <div class="mb-4 space-y-2.5 rounded-2xl bg-white/85 p-3.5 shadow-sm ring-1 ring-slate-200/80 backdrop-blur">
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative min-w-[14rem] flex-1">
          ${ic('search', 'absolute start-3 top-1/2 -translate-y-1/2 text-slate-400')}
          <input id="bq" value="${esc(S.bq)}" placeholder="ابحث في العنوان، الوصف، المشروع، الموظف..." class="input ps-9 !py-1.5 text-sm">
        </div>
        ${isMgr() && emps.length ? `<select id="buser" class="input !w-auto !py-1.5 text-xs font-medium">
          <option value="all">👤 كل الموظفين</option>
          ${emps.map(u => `<option value="${u.id}" ${S.bUser === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
        </select>` : ''}
        <select id="bsort" class="input !w-auto !py-1.5 text-xs font-medium">
          <option value="pri" ${S.bSort === 'pri' ? 'selected' : ''}>⚡ الترتيب: حسب الأولوية</option>
          <option value="end" ${S.bSort === 'end' ? 'selected' : ''}>📅 الأقرب انتهاءً</option>
          <option value="new" ${S.bSort === 'new' ? 'selected' : ''}>🕒 الأحدث إضافة</option>
          <option value="title" ${S.bSort === 'title' ? 'selected' : ''}>🔤 أبجدياً</option>
        </select>
        <select id="bper" class="input !w-auto !py-1.5 text-xs font-medium">
          ${[4, 8, 12, 24].map(n => `<option value="${n}" ${S.bPer === n ? 'selected' : ''}>${n} / صفحة</option>`).join('')}
        </select>
        ${hasFilters ? `<button id="breset" class="btn btn-ghost btn-sm">${ic('rotate-ccw')}مسح الفلاتر</button>` : ''}
      </div>
      ${filterChips}
    </div>

    <div class="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-5">${pg.items.map(noteHtml).join('') || empty('inbox', hasFilters ? 'لا توجد نوتات تطابق البحث أو الفلتر' : 'لا توجد نوتات')}</div>
    ${pagerHtml(pg, 'b')}
    ${doneSection(S.sel?.type === 'note' ? [] : S.data.done.filter(d => scopeIds.has(d.projectId) && (!q || d.title.toLowerCase().includes(q))))}`;

  if ($('#npn')) $('#npn').onclick = () => personalNoteForm(null, null, proj);
  if (proj && isMgr() && !proj.personal) {
    $('#nn').onclick = () => noteForm(proj);
    $('#ep').onclick = () => form('تعديل المشروع', [{ k: 'name', label: 'الاسم', value: proj.name }, { k: 'description', label: 'الوصف', type: 'textarea', value: proj.description }], b => call('PUT', 'projects/' + proj.id, b).then(refresh));
    const archive = () => ask({ title: 'أرشفة المشروع', body: 'سيختفي المشروع من الشجرة واللوحة، ويمكنك استرجاعه في أي وقت من تبويب الأرشيف.', okText: 'أرشفة المشروع', icon: 'archive', tone: 'ok' },
      async () => { await call('POST', `projects/${proj.id}/archive`); S.sel = null; toast('تمت أرشفة المشروع'); await refresh(); });
    $('#ar').onclick = archive; if ($('#ar2')) $('#ar2').onclick = archive;
    $('#dp').onclick = () => ask({ title: 'حذف المشروع', body: `سيتم حذف المشروع "${proj.name}" وجميع نوتاته نهائياً ولا يمكن التراجع.`, okText: 'حذف نهائي', icon: 'trash-2', tone: 'danger' },
      async () => { await call('DELETE', 'projects/' + proj.id); S.sel = null; await refresh(); });
  }
  $('#bq').oninput = e => { S.bq = e.target.value; S.bPage = 1; renderBoardMain(); const el = $('#bq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
  if ($('#buser')) $('#buser').onchange = e => { S.bUser = e.target.value; S.bPage = 1; renderBoardMain(); };
  $('#bsort').onchange = e => { S.bSort = e.target.value; S.bPage = 1; renderBoardMain(); };
  $('#bper').onchange = e => { S.bPer = +e.target.value; S.bPage = 1; renderBoardMain(); };
  if ($('#breset')) $('#breset').onclick = () => { S.bq = ''; S.bPri = 'all'; S.bUser = 'all'; S.bSort = 'pri'; S.bPage = 1; renderBoardMain(); };
  document.querySelectorAll('[data-bpri]').forEach(b => b.onclick = () => { S.bPri = b.dataset.bpri; S.bPage = 1; renderBoardMain(); });
  document.querySelectorAll('[data-pg^="b:"]').forEach(b => b.onclick = () => { S.bPage = +b.dataset.pg.split(':')[1]; renderBoardMain(); });
  bindNoteActions();
}

const abtn = (a, id, icon, text, cls = '', sz = 'btn-sm') => `<button class="btn ${sz} ${cls}" data-a="${a}:${id}">${ic(icon)}${text}</button>`;
const isOwnPersonal = n => (n.personal || n.createdBy === S.me.id) && n.assigneeId === S.me.id;
function noteActs(n, proj, full) {
  let acts = '';
  const sz = full ? 'btn-sm' : 'btn-xs flex-1';
  const own = isOwnPersonal(n);
  if (n.status === 'open' && n.assigneeId === S.me.id) acts += abtn('done', n.id, 'check', full ? 'تم الانتهاء' : 'تم الإنجاز', 'btn-ok', sz);
  if (n.status === 'pending' && canConfirm(n)) acts += abtn('confirm', n.id, 'check-check', 'تأكيد', 'btn-ok', sz) + abtn('reject', n.id, 'undo-2', 'إرجاع', 'btn-danger-soft', sz);
  if (full && (own || (isMgr() && (S.me.role === 'admin' || S.me.deptId === proj?.deptId)))) {
    acts += abtn('edit', n.id, 'pencil', 'تعديل', 'btn-ghost') + abtn('sub', n.id, 'git-fork', 'فرعية', 'btn-ghost') + abtn('del', n.id, 'trash-2', '', 'btn-ghost !text-rose-600');
  } else if (full && n.assigneeId === S.me.id) {
    acts += abtn('sub', n.id, 'git-fork', 'فرعية', 'btn-ghost');
  }
  return acts;
}

function noteHtml(n) {
  const k = priority(n), p = PRI[k], proj = S.data.projects.find(x => x.id === n.projectId);
  const total = Date.parse(n.end) - Date.parse(n.start), pct = Math.min(100, Math.max(0, (Date.now() - Date.parse(n.start)) / Math.max(1, total) * 100));
  const subs = S.data.notes.filter(c => c.parentId === n.id).length;
  const par = n.parentId ? S.data.notes.find(x => x.id === n.parentId) : null;
  const hasLongDesc = (n.description || '').length > 100 || (n.description || '').split('\n').length > 3;
  const own = isOwnPersonal(n);
  return `<article data-nd="open:${n.id}" class="${p.cls} sticky-note group mt-2 flex min-h-48 cursor-pointer flex-col gap-2 border-t-[6px] p-4 transition-all duration-200 hover:-translate-y-1 hover:rotate-[-0.4deg] ${k === 'late' ? 'note-pulse' : ''}">
    <div class="flex items-center justify-between gap-1.5">
      <span class="chip ${p.badge}">${ic(p.icon, '!h-3.5 !w-3.5')}${p.label}</span>
      <div class="flex min-w-0 items-center gap-1">
        ${own ? `<span class="rounded-full bg-black/10 px-2 py-0.5 text-[10px] font-extrabold">📌 خاصة</span>` : ''}
        <span title="${esc(proj?.name || '')}" class="inline-flex max-w-[8rem] items-center gap-1 rounded-full bg-white/60 px-2 py-0.5 text-[11px] font-bold ring-1 ring-black/10"><span class="truncate">${esc(proj?.name || '')}</span></span>
      </div>
    </div>
    <h4 title="${esc(n.title)}" class="clamp-2 text-base font-extrabold leading-snug">${esc(n.title)}</h4>
    ${par ? `<div title="فرعية من: ${esc(par.title)}" class="flex min-w-0 items-center gap-1 rounded-lg bg-black/[0.06] px-2 py-1 text-xs">${ic('corner-down-left', 'flex-none opacity-70')}<span class="truncate">فرعية من: <b>${esc(par.title)}</b></span></div>` : ''}
    ${n.description ? `<p title="${esc(n.description)}" class="clamp-3 flex-1 text-xs leading-relaxed opacity-85">${esc(n.description)}</p>` : `<div class="flex-1"></div>`}
    ${hasLongDesc ? `<div class="text-[11px] font-extrabold opacity-80 group-hover:underline">عرض كامل التفاصيل ←</div>` : ''}
    ${n.rejectNote ? `<div title="${esc(n.rejectNote)}" class="clamp-2 rounded-xl bg-rose-600/15 px-2.5 py-1.5 text-xs text-rose-950 ring-1 ring-rose-600/25"><b>↩ سبب الإرجاع:</b> ${esc(n.rejectNote)}</div>` : ''}
    <div class="mt-auto space-y-2 pt-1">
      <div class="h-1.5 overflow-hidden rounded-full bg-black/10"><i class="block h-full rounded-full bg-current opacity-55" style="width:${pct}%"></i></div>
      <div class="flex items-center justify-between gap-2 text-xs">
        <span title="${esc(nm(n.assigneeId))}" class="flex min-w-0 items-center gap-1 font-bold opacity-90">${ic('user', 'opacity-70')}<span class="truncate">${esc(nm(n.assigneeId))}</span></span>
        <span class="flex flex-none items-center gap-1 font-extrabold">${ic('clock', 'opacity-70')}${n.status === 'pending' ? 'بانتظار التأكيد' : remaining(n)}</span>
      </div>
      <div class="flex items-center justify-between gap-1 border-t border-black/10 pt-1.5 text-[11px] opacity-80">
        <span class="truncate">${ic('calendar-days', '!h-3.5 !w-3.5')}${shortDate(n.start)} ← ${shortDate(n.end)}</span>
        ${subs ? `<span class="chip bg-black/10">${ic('git-fork')}${subs}</span>` : ''}
      </div>
      <div class="flex flex-wrap gap-1.5 pt-0.5">${noteActs(n, proj, true)}</div>
    </div></article>`;
}

function bindNoteActions() {
  document.querySelectorAll('[data-a]').forEach(b => b.onclick = guard(async e => {
    e.stopPropagation();
    const [a, id] = b.dataset.a.split(':'), n = S.data.notes.find(x => x.id === id), proj = S.data.projects.find(p => p.id === n.projectId);
    if (a === 'done') {
      const r = await call('POST', `notes/${id}/done`);
      toast(r.autoConfirmed ? 'تم إنجاز النوتة الخاصة ونقلها للأرشيف' : 'تم الإرسال للمدير للتأكيد');
    }
    else if (a === 'confirm') { await call('POST', `notes/${id}/confirm`); toast('تم التأكيد وحذف النوتة من الشجرة'); }
    else if (a === 'reject') return ask({ title: 'إرجاع النوتة للموظف', body: `أدخل سبب الإرجاع للنوتة "${n.title}" (اختياري):`, okText: 'إرجاع النوتة', icon: 'undo-2', tone: 'danger', inputPlaceholder: 'سبب الإرجاع...' },
      async reason => { await call('POST', `notes/${id}/reject`, { reason }); await refresh(); });
    else if (a === 'del') return ask({ title: 'حذف النوتة', body: `سيتم حذف النوتة "${n.title}" وجميع النوتات الفرعية التابعة لها نهائياً.`, okText: 'حذف النوتة', icon: 'trash-2', tone: 'danger' },
      async () => { await call('DELETE', 'notes/' + id); await refresh(); });
    else if (a === 'edit') return (isOwnPersonal(n) || proj?.personal || !isMgr()) ? personalNoteForm(n, null, proj) : noteForm(proj, n);
    else if (a === 'sub') return (isOwnPersonal(n) || proj?.personal || !isMgr()) ? personalNoteForm(null, id, proj) : noteForm(proj, null, id);
    await refresh();
  }));
  bindNoteDetailClicks();
}

function bindNoteDetailClicks() {
  document.querySelectorAll('[data-nd]').forEach(el => el.onclick = e => {
    if (e.target.closest('button[data-a]')) return;
    const [src, id] = el.dataset.nd.split(':');
    let item;
    if (src === 'open') item = S.data.notes.find(x => x.id === id);
    else if (src === 'done') item = S.data.done.find(x => x.id === id);
    else if (src === 'hist') item = cachedHistory.find(x => x.id === id);
    if (item) showNoteDetails(item, src !== 'open');
  });
}

function durText(ms) {
  const a = Math.abs(ms), d = Math.floor(a / 864e5), h = Math.floor(a % 864e5 / 36e5), m = Math.floor(a % 36e5 / 6e4);
  return d ? `${d} يوم و ${h} ساعة` : h ? `${h} ساعة و ${m} دقيقة` : `${m} دقيقة`;
}

function showNoteDetails(n, isArchived = false) {
  S.detailNoteId = n.id;
  S.detailIsArchived = isArchived;
  const m = $('#modal');
  const proj = S.data.projects.find(p => p.id === n.projectId);
  const pName = n.projectName || proj?.name || '—';
  const dName = n.deptName || (proj ? deptName(proj.deptId) : '—');
  const aName = n.assigneeName || nm(n.assigneeId);
  const cName = n.createdByName || (n.createdBy ? nm(n.createdBy) : '—');
  const par = n.parentId ? (S.data.notes.find(x => x.id === n.parentId) || S.data.done.find(x => x.id === n.parentId) || cachedHistory.find(x => x.id === n.parentId)) : null;
  const subs = S.data.notes ? S.data.notes.filter(c => c.parentId === n.id) : [];

  let statusChip, timeBanner;
  if (isArchived || n.confirmedAt) {
    const diff = Date.parse(n.doneAt) - Date.parse(n.end);
    const late = diff > 0;
    statusChip = `<span class="chip ${late ? 'b-critical' : 'b-low'} !text-xs">${ic(late ? 'triangle-alert' : 'check-check')}${late ? 'أُنجزت متأخرة' : 'مؤكدة وفي الوقت'}</span>`;
    timeBanner = `<div class="flex flex-wrap items-center justify-between gap-2 rounded-xl ${late ? 'bg-rose-50 text-rose-900 ring-rose-200' : 'bg-emerald-50 text-emerald-900 ring-emerald-200'} px-3.5 py-2.5 text-xs ring-1">
      <span class="font-bold">${ic(late ? 'triangle-alert' : 'check')}${late ? `تأخرت بمقدار ${durText(diff)} عن الموعد المخطط` : `أُنجزت قبل الموعد بـ ${durText(diff)}`}</span>
      <span>مدة التنفيذ الفعلية: <b>${durText(Date.parse(n.doneAt) - Date.parse(n.start))}</b></span>
    </div>`;
  } else {
    const k = priority(n), p = PRI[k];
    statusChip = `<span class="chip ${p.badge} !text-xs">${ic(p.icon)}${p.label}</span>`;
    timeBanner = `<div class="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700 ring-1 ring-slate-200">
      <span class="font-bold">${ic('clock')}${n.status === 'pending' ? 'بانتظار تأكيد المدير المباشر' : remaining(n)}</span>
      <span>المدة المخططة: <b>${durText(Date.parse(n.end) - Date.parse(n.start))}</b></span>
    </div>`;
  }

  const infoRow = (icon, label, val) => `<div class="flex items-start gap-2 rounded-xl bg-slate-50/80 p-2.5 ring-1 ring-slate-200/70">
    <span class="mt-0.5 text-brand-600">${ic(icon)}</span>
    <div class="min-w-0 flex-1"><div class="text-[11px] text-slate-400">${label}</div><div title="${esc(val)}" class="truncate text-xs font-bold text-slate-800">${val}</div></div>
  </div>`;

  const acts = !isArchived && !n.confirmedAt ? noteActs(n, proj, true) : '';

  m.innerHTML = `<div class="max-h-[90vh] w-full max-w-xl overflow-auto rounded-3xl bg-white p-6 shadow-2xl ring-1 ring-slate-200">
    <div class="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
      <div class="min-w-0 flex-1">
        <div class="mb-1.5 flex flex-wrap items-center gap-2">${statusChip}<span class="text-xs text-slate-400">#${esc(n.id)}</span></div>
        <h3 class="break-words text-xl font-extrabold leading-snug text-slate-800">${esc(n.title)}</h3>
      </div>
      <button type="button" id="cx" class="btn btn-ghost btn-sm !p-1.5">${ic('x')}</button>
    </div>

    <div class="mt-4 space-y-4">
      ${timeBanner}

      <div>
        <div class="mb-1 text-xs font-bold text-slate-500">الوصف والتفاصيل</div>
        <div class="max-h-56 min-h-14 overflow-y-auto break-words whitespace-pre-wrap rounded-2xl bg-slate-50 p-3.5 text-sm leading-relaxed text-slate-700 ring-1 ring-slate-200/80">${esc(n.description || 'لا يوجد وصف مضاف لهذه النوتة.')}</div>
      </div>

      ${n.rejectNote ? `<div class="break-words rounded-xl bg-rose-50 p-3 text-xs text-rose-800 ring-1 ring-rose-200"><b>↩ سبب الإرجاع السابق:</b> ${esc(n.rejectNote)}</div>` : ''}

      <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        ${infoRow('folder', 'المشروع', esc(pName))}
        ${infoRow('building-2', 'القسم', esc(dName))}
        ${infoRow('user', 'الموظف المسند إليه', esc(aName))}
        ${infoRow('user', 'أنشأها', esc(cName))}
        ${infoRow('calendar-days', 'تاريخ البداية', fmt(n.start))}
        ${infoRow('calendar-days', 'الانتهاء المخطط', fmt(n.end))}
        ${n.createdAt ? infoRow('clock', 'تاريخ الإنشاء', fmt(n.createdAt)) : ''}
        ${n.doneAt ? infoRow('check', 'تاريخ إنجاز الموظف', fmt(n.doneAt)) : ''}
        ${n.confirmedAt ? infoRow('shield-check', 'أكّدها المدير', `${esc(n.confirmedByName || '—')} (${fmt(n.confirmedAt)})`) : ''}
      </div>

      ${par ? `<div class="flex min-w-0 items-center gap-2 rounded-xl bg-indigo-50/70 px-3 py-2 text-xs text-indigo-900 ring-1 ring-indigo-200">${ic('corner-down-left', 'flex-none')}<span class="truncate">نوتة فرعية من: <b>${esc(par.title)}</b></span></div>` : ''}
      ${subs.length ? `<div><div class="mb-1.5 text-xs font-bold text-slate-500">النوتات الفرعية (${subs.length})</div><div class="flex flex-wrap gap-1.5">${subs.map(s => `<span class="chip ${PRI[priority(s)].badge} max-w-full">${ic('git-fork')}<span class="truncate">${esc(s.title)}</span></span>`).join('')}</div></div>` : ''}
    </div>

    <div class="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4">
      <div class="flex flex-wrap gap-1.5" id="md-acts">${acts}</div>
      <button type="button" id="cx2" class="btn btn-ghost">إغلاق</button>
    </div>
  </div>`;

  showModal();
  $('#cx').onclick = hideModal;
  $('#cx2').onclick = hideModal;
  if ($('#md-acts')) {
    $('#md-acts').querySelectorAll('[data-a]').forEach(b => b.onclick = guard(async () => {
      hideModal();
      const [a, id] = b.dataset.a.split(':'), note = S.data.notes.find(x => x.id === id), prj = S.data.projects.find(p => p.id === note.projectId);
      if (a === 'done') {
        const r = await call('POST', `notes/${id}/done`);
        toast(r.autoConfirmed ? 'تم إنجاز النوتة الخاصة ونقلها للأرشيف' : 'تم الإرسال للمدير للتأكيد');
      }
      else if (a === 'confirm') { await call('POST', `notes/${id}/confirm`); toast('تم التأكيد وحذف النوتة من الشجرة'); }
      else if (a === 'reject') return ask({ title: 'إرجاع النوتة للموظف', body: `أدخل سبب الإرجاع للنوتة "${note.title}" (اختياري):`, okText: 'إرجاع النوتة', icon: 'undo-2', tone: 'danger', inputPlaceholder: 'سبب الإرجاع...' },
        async reason => { await call('POST', `notes/${id}/reject`, { reason }); await refresh(); });
      else if (a === 'del') return ask({ title: 'حذف النوتة', body: `سيتم حذف النوتة "${note.title}" وجميع النوتات الفرعية التابعة لها نهائياً.`, okText: 'حذف النوتة', icon: 'trash-2', tone: 'danger' },
        async () => { await call('DELETE', 'notes/' + id); await refresh(); });
      else if (a === 'edit') return (isOwnPersonal(note) || prj?.personal || !isMgr()) ? personalNoteForm(note, null, prj) : noteForm(prj, note);
      else if (a === 'sub') return (isOwnPersonal(note) || prj?.personal || !isMgr()) ? personalNoteForm(null, id, prj) : noteForm(prj, null, id);
      await refresh();
    }));
  }
}

// ---------- projects wall: 5 projects per page, with search, filter & pagination ----------
function treeView() {
  const { departments, projects, notes } = S.data;
  const endOf = n => Date.parse(n.end);
  const q = S.tq.trim().toLowerCase();

  // filter notes inside projects
  const matchNote = n => {
    if (S.tPri !== 'all' && priority(n) !== S.tPri) return false;
    if (q) {
      const hay = `${n.title} ${n.description || ''} ${nm(n.assigneeId)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  // filter projects
  let ps = projects.filter(p => {
    if (S.tDept !== 'all' && p.deptId !== S.tDept) return false;
    if (q || S.tPri !== 'all') {
      const pMatch = q && p.name.toLowerCase().includes(q) && S.tPri === 'all';
      const hasNotes = notes.some(n => n.projectId === p.id && matchNote(n));
      return pMatch || hasNotes;
    }
    return true;
  });

  const minEnd = id => { const l = notes.filter(n => n.projectId === id); return l.length ? Math.min(...l.map(endOf)) : Infinity; };
  ps = ps.slice().sort((a, b) => minEnd(a.id) - minEnd(b.id));

  const pg = paginate(ps, S.tPage, S.tPer);
  S.tPage = pg.cur;
  const hasFilters = S.tq || S.tDept !== 'all' || S.tPri !== 'all';

  const col = p => {
    const list = notes.filter(n => n.projectId === p.id && matchNote(n)).sort((a, b) => endOf(a) - endOf(b));
    const items = list.map((n, i) => {
      const k = priority(n), pr = PRI[k], par = n.parentId ? notes.find(x => x.id === n.parentId) : null, right = i % 2 === 0;
      const acts = noteActs(n, p, false);
      const statusTxt = n.status === 'pending' ? 'بانتظار التأكيد' : remaining(n);
      return `<div class="relative flex w-full ${right ? 'justify-start' : 'justify-end'} ${i > 0 ? '-mt-3' : ''} mb-3 pt-2">
        <span class="pointer-events-none absolute left-1/2 top-[26px] z-10 h-3 w-3 -translate-x-1/2 rounded-full ${pr.dot} ring-4 ring-white shadow-sm"></span>
        <div data-nd="open:${n.id}" class="${pr.cls} sticky-note group relative w-[calc(50%-12px)] cursor-pointer border-t-[5px] p-2.5 text-xs transition-all duration-200 hover:z-20 hover:-translate-y-0.5 hover:rotate-[-0.4deg] ${k === 'late' ? 'note-pulse' : ''}">
          <span class="pointer-events-none absolute top-[14px] h-[2px] w-3 bg-slate-300 ${right ? 'right-full' : 'left-full'}"></span>
          <div class="mb-1 flex items-center justify-between gap-1">
            <span title="${esc(pr.label)} — ${esc(statusTxt)}" class="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${pr.badge}">
              ${ic(pr.icon, '!h-3 !w-3')}<span class="truncate">${esc(statusTxt)}</span>
            </span>
            ${isOwnPersonal(n) ? `<span class="flex-none rounded-full bg-black/10 px-1.5 py-0.5 text-[9px] font-extrabold">📌 خاصة</span>` : ''}
          </div>
          <h4 title="${esc(n.title)}" class="clamp-2 text-[13px] font-extrabold leading-snug">${esc(n.title)}</h4>
          ${par ? `<div title="فرعية من: ${esc(par.title)}" class="mt-1 flex min-w-0 items-center gap-1 rounded-md bg-black/[0.06] px-1.5 py-0.5 text-[10px] opacity-85">${ic('corner-down-left', '!h-3 !w-3 flex-none opacity-70')}<span class="truncate">${esc(par.title)}</span></div>` : ''}
          ${n.description ? `<p title="${esc(n.description)}" class="mt-0.5 clamp-1 text-[11px] leading-relaxed opacity-80">${esc(n.description)}</p>` : ''}
          <div class="mt-2 flex items-center justify-between gap-1 border-t border-black/10 pt-1.5 text-[11px]">
            <span title="الموظف: ${esc(nm(n.assigneeId))}" class="flex min-w-0 items-center gap-1 font-bold opacity-90">
              ${ic('user', '!h-3 !w-3 opacity-70')}<span class="truncate">${esc(nm(n.assigneeId))}</span>
            </span>
            <span title="الموعد النهائي: ${esc(fmt(n.end))}" class="flex flex-none items-center gap-0.5 text-[10px] font-semibold opacity-75">
              ${ic('calendar-days', '!h-3 !w-3 opacity-70')}${shortDate(n.end)}
            </span>
          </div>
          ${acts ? `<div class="mt-2 flex flex-wrap gap-1">${acts}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    return `<section class="flex min-w-0 flex-col overflow-hidden rounded-3xl bg-white/95 shadow-sm ring-1 ring-slate-200/90">
      <div class="h-1.5 bg-gradient-to-l from-brand-500 via-indigo-500 to-violet-500"></div>
      <div class="border-b border-slate-100 bg-gradient-to-b from-slate-50/90 to-white px-3.5 py-3">
        <div class="flex items-center gap-2.5">
          <span class="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">${ic('folder', '!h-4 !w-4')}</span>
          <div class="min-w-0 flex-1">
            <h3 title="${esc(p.name)}" class="clamp-1 text-sm font-extrabold text-slate-800">${esc(p.name)}</h3>
            <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
              <span title="${esc(deptName(p.deptId))}" class="truncate">${esc(deptName(p.deptId))}</span>
              <span>•</span>
              <span class="flex-none rounded-full bg-indigo-50 px-2 py-0.2 font-bold text-brand-700">${list.length} نوتة</span>
            </div>
          </div>
        </div>
      </div>
      <div class="relative flex flex-1 flex-col overflow-y-auto overflow-x-hidden px-2.5 py-4">
        <div class="pointer-events-none absolute inset-y-2 left-1/2 w-[2px] -translate-x-1/2 rounded-full bg-gradient-to-b from-indigo-300 via-slate-300 to-slate-200/40"></div>
        ${items || `<div class="relative z-10 m-auto flex flex-col items-center gap-1.5 rounded-2xl bg-slate-50/90 px-4 py-6 text-center text-xs text-slate-400 ring-1 ring-slate-100">${ic('check-check', '!h-6 !w-6 text-emerald-400')}<span>لا توجد نوتات نشطة</span></div>`}
      </div>
      ${doneFooter(S.data.done.filter(d => d.projectId === p.id))}</section>`;
  };

  const gridCols = pg.items.length <= 2 ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3' : pg.items.length === 3 ? 'grid-cols-1 md:grid-cols-3' : pg.items.length === 4 ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-4' : 'grid-cols-1 md:grid-cols-3 xl:grid-cols-5';

  $('#body').innerHTML = `<div class="flex h-[calc(100vh-56px)] flex-col p-3">
    <div class="mb-2.5 flex flex-wrap items-center gap-2 rounded-2xl bg-white/85 px-3.5 py-2.5 shadow-sm ring-1 ring-slate-200/80 backdrop-blur">
      <div class="relative min-w-[13rem] flex-1">
        ${ic('search', 'absolute start-3 top-1/2 -translate-y-1/2 text-slate-400')}
        <input id="tq" value="${esc(S.tq)}" placeholder="ابحث عن مشروع أو نوتة أو موظف..." class="input ps-9 !py-1.5 text-xs">
      </div>
      ${departments.length > 1 ? `<select id="tdept" class="input !w-auto !py-1.5 text-xs font-medium">
        <option value="all">🏢 كل الأقسام</option>
        ${departments.map(d => `<option value="${d.id}" ${S.tDept === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select>` : ''}
      <select id="tpri" class="input !w-auto !py-1.5 text-xs font-medium">
        <option value="all">🎨 كل الأولويات</option>
        ${Object.entries(PRI).map(([k, p]) => `<option value="${k}" ${S.tPri === k ? 'selected' : ''}>${p.label}</option>`).join('')}
      </select>
      ${hasFilters ? `<button id="treset" class="btn btn-ghost btn-sm">${ic('rotate-ccw')}مسح</button>` : ''}
      <button id="tnpn" class="btn btn-sm">${ic('plus')}نوتة خاصة</button>
      <div class="ms-auto flex items-center gap-1.5 text-xs text-slate-600">
        <span>المشاريع: <b>${pg.from}–${pg.to}</b> من <b>${pg.total}</b></span>
        <button data-pg="t:${pg.cur - 1}" ${pg.cur <= 1 ? 'disabled' : ''} class="btn btn-ghost btn-sm !px-2">${ic('chevron-right')}</button>
        <span class="font-bold">${pg.cur}/${pg.pages}</span>
        <button data-pg="t:${pg.cur + 1}" ${pg.cur >= pg.pages ? 'disabled' : ''} class="btn btn-ghost btn-sm !px-2">${ic('chevron-left')}</button>
      </div>
    </div>
    <div class="grid flex-1 ${gridCols} gap-3.5 min-h-0">${pg.items.map(col).join('') || empty('inbox', 'لا توجد مشاريع مطابقة')}</div>
  </div>`;

  $('#tq').oninput = e => { S.tq = e.target.value; S.tPage = 1; treeView(); const el = $('#tq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
  if ($('#tdept')) $('#tdept').onchange = e => { S.tDept = e.target.value; S.tPage = 1; treeView(); };
  $('#tpri').onchange = e => { S.tPri = e.target.value; S.tPage = 1; treeView(); };
  if ($('#treset')) $('#treset').onclick = () => { S.tq = ''; S.tDept = 'all'; S.tPri = 'all'; S.tPage = 1; treeView(); };
  if ($('#tnpn')) $('#tnpn').onclick = () => personalNoteForm();
  document.querySelectorAll('[data-pg^="t:"]').forEach(b => b.onclick = () => { S.tPage = +b.dataset.pg.split(':')[1]; treeView(); });
  bindNoteActions();
}

// ---------- history & archived projects ----------
let cachedHistory = [], cachedArchive = [], historyLoaded = false;
async function historyView(silent = false) {
  if (silent && historyLoaded) {
    renderHistoryDom();
  } else {
    $('#body').innerHTML = `<div class="p-5 text-slate-500">جارٍ التحميل...</div>`;
  }
  [cachedHistory, cachedArchive] = await Promise.all([call('GET', 'history'), isMgr() ? call('GET', 'archive') : []]);
  historyLoaded = true;
  if (S.tab !== 'history') return;
  const st = captureUiState();
  renderHistoryDom();
  restoreUiState(st);
}
function renderHistoryDom() {
  const h = cachedHistory, ap = cachedArchive;
  const projNames = [...new Set(h.map(x => x.projectName).filter(Boolean))];
  const q = S.hq.trim().toLowerCase();
  const filtered = h.filter(x => {
    const late = Date.parse(x.doneAt) > Date.parse(x.end);
    if (S.hProj !== 'all' && x.projectName !== S.hProj) return false;
    if (S.hState === 'ontime' && late) return false;
    if (S.hState === 'late' && !late) return false;
    if (q) {
      const hay = `${x.title} ${x.projectName} ${x.assigneeName} ${x.confirmedByName}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const pg = paginate(filtered, S.hPage, S.hPer);
  S.hPage = pg.cur;
  const hasFilters = S.hq || S.hProj !== 'all' || S.hState !== 'all';

  const archivedCard = isMgr() ? `<div class="card mb-5"><h2 class="mb-4 flex items-center gap-2 text-lg font-extrabold">${ic('folder', 'text-amber-500')}المشاريع المؤرشفة (${ap.length})</h2>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">${ap.map(p => `<div class="flex min-w-0 flex-col gap-1.5 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200"><div title="${esc(p.name)}" class="flex items-center gap-1.5 font-extrabold">${ic('archive', 'flex-none text-slate-400')}<span class="truncate">${esc(p.name)}</span></div>
      <div class="truncate text-xs text-slate-500">${esc(p.deptName)} • ${p.doneCount} نوتة منجزة</div><div class="truncate text-xs text-slate-500">أُرشف: ${fmt(p.archivedAt)} بواسطة ${esc(p.archivedByName)}</div>
      <div class="mt-1 flex gap-1.5"><button class="btn btn-sm btn-ghost" data-pf="${esc(p.name)}">${ic('list-checks')}نوتاته</button><button class="btn btn-sm btn-ghost" data-pr="${p.id}">${ic('undo-2')}استرجاع</button></div></div>`).join('') || `<div class="col-span-full py-6 text-center text-sm text-slate-400">لا توجد مشاريع مؤرشفة</div>`}</div></div>` : '';

  $('#body').innerHTML = `<div class="p-5">${archivedCard}<div class="card">
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <h2 class="me-auto flex items-center gap-2 text-lg font-extrabold">${ic('archive', 'text-brand-600')}أرشيف النوتات المنجزة (${filtered.length})</h2>
      <div class="relative min-w-[13rem]">
        ${ic('search', 'absolute start-3 top-1/2 -translate-y-1/2 text-slate-400')}
        <input id="hq" value="${esc(S.hq)}" placeholder="ابحث في الأرشيف..." class="input ps-9 !py-1.5 text-xs">
      </div>
      <select id="hproj" class="input !w-auto !py-1.5 text-xs font-medium">
        <option value="all">📁 كل المشاريع</option>
        ${projNames.map(n => `<option value="${esc(n)}" ${S.hProj === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select>
      <select id="hstate" class="input !w-auto !py-1.5 text-xs font-medium">
        <option value="all">⏱ كل الحالات</option>
        <option value="ontime" ${S.hState === 'ontime' ? 'selected' : ''}>✔ في الوقت</option>
        <option value="late" ${S.hState === 'late' ? 'selected' : ''}>⚠ متأخرة</option>
      </select>
      ${hasFilters ? `<button id="hreset" class="btn btn-ghost btn-sm">${ic('rotate-ccw')}مسح</button>` : ''}
    </div>
    <div class="overflow-x-auto rounded-xl ring-1 ring-slate-200"><table class="w-full"><tr><th class="th">النوتة</th><th class="th">المشروع</th><th class="th">الموظف</th><th class="th">الانتهاء المخطط</th><th class="th">تاريخ الإنجاز</th><th class="th">أكّدها</th><th class="th">التأكيد</th></tr>
    ${pg.items.map(x => { const late = Date.parse(x.doneAt) > Date.parse(x.end); return `<tr data-nd="hist:${x.id}" class="cursor-pointer transition hover:bg-brand-50/60"><td title="${esc(x.title)}" class="td max-w-[15rem] truncate font-bold text-brand-700 underline decoration-brand-300 underline-offset-4">${esc(x.title)}</td><td title="${esc(x.projectName)}" class="td max-w-[10rem] truncate">${esc(x.projectName)}</td><td class="td max-w-[9rem] truncate">${esc(x.assigneeName)}</td><td class="td whitespace-nowrap">${fmt(x.end)}</td>
    <td class="td whitespace-nowrap"><span class="chip ${late ? 'b-critical' : 'b-low'}">${ic(late ? 'triangle-alert' : 'check')}${late ? 'متأخرة' : 'في الوقت'}</span> ${fmt(x.doneAt)}</td><td class="td max-w-[9rem] truncate">${esc(x.confirmedByName)}</td><td class="td whitespace-nowrap">${fmt(x.confirmedAt)}</td></tr>`; }).join('') || `<tr><td colspan="7" class="td py-10 text-center text-slate-400">لا توجد نتائج مطابقة</td></tr>`}</table></div>
    ${pagerHtml(pg, 'h')}</div></div>`;

  $('#hq').oninput = e => { S.hq = e.target.value; S.hPage = 1; renderHistoryDom(); const el = $('#hq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
  $('#hproj').onchange = e => { S.hProj = e.target.value; S.hPage = 1; renderHistoryDom(); };
  $('#hstate').onchange = e => { S.hState = e.target.value; S.hPage = 1; renderHistoryDom(); };
  if ($('#hreset')) $('#hreset').onclick = () => { S.hq = ''; S.hProj = 'all'; S.hState = 'all'; S.hPage = 1; renderHistoryDom(); };
  document.querySelectorAll('[data-pg^="h:"]').forEach(b => b.onclick = () => { S.hPage = +b.dataset.pg.split(':')[1]; renderHistoryDom(); });
  document.querySelectorAll('[data-pr]').forEach(b => b.onclick = guard(async () => { await call('POST', `projects/${b.dataset.pr}/restore`); toast('تم استرجاع المشروع'); await refresh(); }));
  document.querySelectorAll('[data-pf]').forEach(b => b.onclick = () => { S.hProj = b.dataset.pf; S.hPage = 1; renderHistoryDom(); });
  bindNoteDetailClicks();
}

// ---------- forms & custom dialogs ----------
function ask({ title, body, okText = 'تأكيد', icon = 'triangle-alert', tone = 'danger', inputPlaceholder = null }, onOk) {
  S.detailNoteId = null;
  const m = $('#modal');
  const ringCls = tone === 'ok' ? 'bg-emerald-100 text-emerald-700 ring-emerald-200' : tone === 'brand' ? 'bg-brand-100 text-brand-700 ring-brand-200' : 'bg-rose-100 text-rose-600 ring-rose-200';
  const btnCls = tone === 'ok' ? 'btn-ok' : tone === 'brand' ? '' : 'btn-danger';
  m.innerHTML = `<form class="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl ring-1 ring-slate-200">
    <div class="flex items-start gap-3.5">
      <span class="flex h-12 w-12 flex-none items-center justify-center rounded-2xl ring-1 ${ringCls}">${ic(icon, '!h-6 !w-6')}</span>
      <div class="min-w-0 flex-1">
        <h3 class="text-lg font-extrabold text-slate-800">${esc(title)}</h3>
        <p class="mt-1 text-sm leading-relaxed text-slate-600">${esc(body)}</p>
        ${inputPlaceholder !== null ? `<textarea name="val" rows="2" placeholder="${esc(inputPlaceholder)}" class="input mt-3"></textarea>` : ''}
      </div>
    </div>
    <div class="mt-6 flex justify-end gap-2">
      <button type="button" class="btn btn-ghost" id="cx">${ic('x')}إلغاء</button>
      <button class="btn ${btnCls}">${ic(icon)}${esc(okText)}</button>
    </div></form>`;
  showModal();
  $('#cx').onclick = hideModal;
  const inp = m.querySelector('textarea'); if (inp) inp.focus();
  m.querySelector('form').onsubmit = guard(async e => {
    e.preventDefault();
    const val = inp ? inp.value : true;
    hideModal();
    await onOk(val);
  });
}

function form(title, fields, onSubmit) {
  S.detailNoteId = null;
  const m = $('#modal');
  m.innerHTML = `<form class="max-h-[90vh] w-full max-w-md overflow-auto rounded-2xl bg-white p-6 shadow-2xl"><h3 class="mb-1 text-lg font-extrabold">${esc(title)}</h3>${fields.map(f => `<label class="label">${f.label}</label>${
    f.type === 'select' ? `<select name="${f.k}" class="input">${f.options.map(o => `<option value="${esc(o.v)}" ${o.v === f.value ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`
    : f.type === 'textarea' ? `<textarea name="${f.k}" rows="3" class="input">${esc(f.value || '')}</textarea>`
    : `<input name="${f.k}" type="${f.type || 'text'}" value="${esc(f.value || '')}" class="input" ${f.req === false ? '' : 'required'}>`}`).join('')}
    <div class="mt-5 flex gap-2"><button class="btn">${ic('check')}حفظ</button><button type="button" class="btn btn-ghost" id="cx">${ic('x')}إلغاء</button></div></form>`;
  showModal();
  $('#cx').onclick = hideModal;
  m.querySelector('form').onsubmit = guard(async e => {
    e.preventDefault();
    await onSubmit(Object.fromEntries(new FormData(e.target))); hideModal();
  });
}
function newProject() {
  const f = [{ k: 'name', label: 'اسم المشروع' }, { k: 'description', label: 'الوصف', type: 'textarea' }];
  if (S.me.role === 'admin') f.unshift({ k: 'deptId', label: 'القسم', type: 'select', options: S.data.departments.map(d => ({ v: d.id, t: d.name })) });
  form('مشروع جديد', f, b => call('POST', 'projects', b).then(p => { S.sel = { type: 'proj', id: p.id }; S.open.add(p.id); S.open.add(p.deptId); return refresh(); }));
}
function noteForm(proj, note, parentId) {
  const emps = S.data.users.filter(u => u.role === 'employee' && u.deptId === proj.deptId);
  if (!emps.length) return toast('لا يوجد موظفون في قسم هذا المشروع');
  form(note ? 'تعديل نوتة' : parentId ? 'نوتة فرعية' : 'نوتة جديدة', [
    { k: 'title', label: 'العنوان', value: note?.title },
    { k: 'description', label: 'الوصف', type: 'textarea', value: note?.description },
    { k: 'assigneeId', label: 'إسناد إلى', type: 'select', value: note?.assigneeId, options: emps.map(u => ({ v: u.id, t: u.name })) },
    { k: 'start', label: 'تاريخ البداية', type: 'datetime-local', value: toLocalInput(note?.start || new Date()) },
    { k: 'end', label: 'تاريخ النهاية', type: 'datetime-local', value: toLocalInput(note?.end || new Date(Date.now() + 7 * 864e5)) },
  ], b => {
    b.start = new Date(b.start).toISOString(); b.end = new Date(b.end).toISOString();
    return (note ? call('PUT', 'notes/' + note.id, b) : call('POST', 'notes', { ...b, projectId: proj.id, parentId: parentId || null })).then(refresh);
  });
}

function personalNoteForm(note = null, parentId = null, defaultProj = null) {
  const otherProjs = S.data.projects.filter(p => !p.personal);
  const projOpts = [{ v: 'personal', t: '📌 نوتاتي الخاصة (شخصية)' }, ...otherProjs.map(p => ({ v: p.id, t: `📁 ${p.name}` }))];
  const initProj = defaultProj && !defaultProj.personal ? defaultProj.id : 'personal';
  const fields = [
    { k: 'title', label: 'عنوان النوتة الخاصة', value: note?.title },
    { k: 'description', label: 'الوصف والتفاصيل', type: 'textarea', value: note?.description, req: false },
  ];
  if (!note && !parentId && otherProjs.length) {
    fields.push({ k: 'projectId', label: 'التصنيف / المشروع', type: 'select', value: initProj, options: projOpts });
  }
  fields.push(
    { k: 'start', label: 'تاريخ البداية', type: 'datetime-local', value: toLocalInput(note?.start || new Date()) },
    { k: 'end', label: 'تاريخ النهاية', type: 'datetime-local', value: toLocalInput(note?.end || new Date(Date.now() + 3 * 864e5)) }
  );
  form(note ? 'تعديل نوتة خاصة' : parentId ? 'إضافة نوتة فرعية خاصة' : 'إضافة نوتة خاصة بي', fields, b => {
    b.start = new Date(b.start).toISOString();
    b.end = new Date(b.end).toISOString();
    if (note) return call('PUT', 'notes/' + note.id, b).then(refresh);
    const pid = parentId ? defaultProj?.id : (b.projectId || 'personal');
    return call('POST', 'notes', { ...b, projectId: pid, parentId: parentId || null, personal: pid === 'personal' }).then(() => {
      toast('تمت إضافة النوتة الخاصة بنجاح');
      return refresh();
    });
  });
}

// ---------- sound synthesizer (iPhone Tri-tone, Chime, Classic Bell, Radar) & alerts section ----------
const SOUNDS = {
  iphone: { label: '📱 نغمة رسالة آيفون (Tri-tone)', notes: [[987.77, 0, .13], [1318.51, .12, .15], [1567.98, .25, .36]], type: 'sine' },
  chime:  { label: '✨ رنين هادئ (Chime)', notes: [[523.25, 0, .18], [659.25, .14, .18], [783.99, .28, .22], [1046.5, .42, .42]], type: 'sine' },
  bell:   { label: '🔔 جرس تنبيه (Classic Bell)', notes: [[880, 0, .16], [880, .22, .16], [1174.66, .44, .38]], type: 'triangle' },
  radar:  { label: '🚨 منبّه قوي (Radar)', notes: [[1046.5, 0, .12], [1318.5, .13, .12], [1046.5, .28, .12], [1318.5, .41, .12], [1567.98, .56, .35]], type: 'square' },
};
let audioCtx;
function playAlertSound(kind = 'iphone') {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const s = SOUNDS[kind] || SOUNDS.iphone, t0 = audioCtx.currentTime;
    s.notes.forEach(([freq, start, dur]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = s.type; o.frequency.setValueAtTime(freq, t0 + start);
      g.gain.setValueAtTime(0.001, t0 + start);
      g.gain.exponentialRampToValueAtTime(s.type === 'square' ? 0.14 : 0.28, t0 + start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0 + start); o.stop(t0 + start + dur + 0.03);
    });
  } catch {}
}

function alertSchedule(a) {
  const s = Date.parse(a.startAt || a.eventAt), ev = Date.parse(a.eventAt);
  const cnt = Math.max(1, +a.repeatCount || 1), step = Math.max(0.05, +a.intervalHours || 1) * 36e5;
  const times = [];
  for (let i = 0; i < cnt; i++) {
    const t = s + i * step;
    if (t <= ev + 60000) times.push(t);
  }
  if (!times.length || Math.abs(times[times.length - 1] - ev) > 60000) times.push(ev);
  return times;
}
function alertState(a, now = Date.now()) {
  if (a.status === 'dismissed') return { key: 'dismissed', label: 'مُغلق / تم الاطلاع', badge: 'bg-slate-200 text-slate-700', ring: 'border-slate-300' };
  const times = alertSchedule(a), ev = Date.parse(a.eventAt), s = Date.parse(a.startAt || a.eventAt);
  const fired = times.filter(t => t <= now).length, next = times.find(t => t > now);
  if (now >= ev) return { key: 'due', label: 'حان وقت التنبيه الآن!', badge: 'bg-teal-400 text-slate-950', ring: 'border-teal-400', fired, total: times.length, next };
  if (now >= s) return { key: 'ringing', label: `جاري التذكير (${fired}/${times.length})`, badge: 'bg-cyan-300 text-slate-950', ring: 'border-cyan-400', fired, total: times.length, next };
  return { key: 'upcoming', label: 'مجدول قريباً', badge: 'bg-indigo-200 text-indigo-950', ring: 'border-indigo-400', fired: 0, total: times.length, next };
}
function alertRemaining(ms) {
  const left = ms - Date.now(), a = Math.abs(left), d = Math.floor(a / 864e5), h = Math.floor(a % 864e5 / 36e5), m = Math.floor(a % 36e5 / 6e4);
  const t = d ? `${d} يوم ${h} س` : h ? `${h} س ${m} د` : `${m} د`;
  return left < 0 ? `مضى ${t}` : `بعد ${t}`;
}

function alertsView() {
  const all = S.data.alerts || [];
  const q = S.aq.trim().toLowerCase();
  const filtered = all.filter(a => {
    if (S.aState === 'active' && a.status !== 'active') return false;
    if (S.aState === 'dismissed' && a.status !== 'dismissed') return false;
    if (q && !`${a.title} ${a.description || ''} ${a.targetName || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const pg = paginate(filtered, S.aPage, S.aPer);
  S.aPage = pg.cur;

  $('#body').innerHTML = `<div class="p-5">
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <div class="me-auto flex items-center gap-2.5">
        <span class="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-600 text-white shadow-md">${ic('bell-ring', '!h-5 !w-5')}</span>
        <div>
          <h2 class="text-xl font-extrabold text-slate-800">نوتات التنبيهات الذكية (${filtered.length})</h2>
          <p class="text-xs text-slate-500">تنبيهات مجدولة بهوية مستقلة وتكرار تلقائي وصوت تنبيه على الويب وسطح المكتب</p>
        </div>
      </div>
      <button id="na" class="btn !bg-teal-600 hover:!bg-teal-700">${ic('plus')}إضافة تنبيه جديد</button>
    </div>

    <div class="mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-white/85 p-3.5 shadow-sm ring-1 ring-slate-200/80 backdrop-blur">
      <div class="relative min-w-[14rem] flex-1">
        ${ic('search', 'absolute start-3 top-1/2 -translate-y-1/2 text-slate-400')}
        <input id="aq" value="${esc(S.aq)}" placeholder="ابحث في عنوان التنبيه أو الوصف أو المستفيد..." class="input ps-9 !py-1.5 text-sm">
      </div>
      <div class="flex gap-1">
        ${[['active', '🔔 النشطة'], ['dismissed', '✔ المغلقة'], ['all', 'الكل']].map(([k, l]) => `<button data-ast="${k}" class="btn btn-sm ${S.aState === k ? '!bg-teal-600 text-white' : 'btn-ghost'}">${l}</button>`).join('')}
      </div>
    </div>

    <div class="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-5">
      ${pg.items.map(alertCardHtml).join('') || empty('bell-ring', 'لا توجد تنبيهات في هذا القسم')}
    </div>
    ${pagerHtml(pg, 'a')}
  </div>`;

  $('#na').onclick = () => alertForm();
  $('#aq').oninput = e => { S.aq = e.target.value; S.aPage = 1; alertsView(); const el = $('#aq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
  document.querySelectorAll('[data-ast]').forEach(b => b.onclick = () => { S.aState = b.dataset.ast; S.aPage = 1; alertsView(); });
  document.querySelectorAll('[data-pg^="a:"]').forEach(b => b.onclick = () => { S.aPage = +b.dataset.pg.split(':')[1]; alertsView(); });
  bindAlertActions();
}

function alertCardHtml(a) {
  const st = alertState(a), snd = SOUNDS[a.sound] || SOUNDS.iphone;
  const times = alertSchedule(a);
  const pulse = st.key === 'due' || st.key === 'ringing';
  return `<article class="relative flex flex-col gap-2.5 overflow-hidden rounded-3xl border-2 ${st.ring} bg-gradient-to-br from-slate-900 via-teal-950 to-cyan-900 p-4 text-white shadow-xl transition hover:-translate-y-1 ${pulse ? 'ring-4 ring-teal-400/40' : ''}">
    <div class="flex items-center justify-between gap-2">
      <span class="chip ${st.badge}">${ic('bell-ring')}${st.label}</span>
      <button type="button" data-asnd="${a.sound || 'iphone'}" title="تجربة الصوت" class="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-teal-200 transition hover:bg-white/20">${ic('volume-2')}${esc(snd.label.replace(/^[^\s]+\s/, ''))}</button>
    </div>

    <div class="mt-1 flex items-start gap-2.5">
      <span class="flex h-10 w-10 flex-none items-center justify-center rounded-2xl bg-teal-400/20 text-teal-300 ring-1 ring-teal-400/30">${ic('alarm-clock', '!h-5 !w-5')}</span>
      <div class="min-w-0 flex-1">
        <h4 title="${esc(a.title)}" class="clamp-2 text-base font-extrabold leading-snug text-white">${esc(a.title)}</h4>
        <div class="mt-0.5 flex items-center gap-1 truncate text-xs text-teal-200/80">${ic('user')}<span class="truncate">${esc(a.targetName)}</span>${a.userId !== a.targetId ? ` <span class="truncate opacity-70">(من: ${esc(a.createdByName)})</span>` : ''}</div>
      </div>
    </div>

    ${a.description ? `<p title="${esc(a.description)}" class="clamp-3 rounded-2xl bg-white/5 p-2.5 text-xs leading-relaxed text-teal-50/90 ring-1 ring-white/10">${esc(a.description)}</p>` : ''}

    <div class="space-y-1.5 rounded-2xl bg-black/25 p-3 text-xs ring-1 ring-white/10">
      <div class="flex items-center justify-between"><span class="text-teal-200/70">${ic('calendar-days')}وقت التنبيه الأساسي:</span><b class="text-teal-300">${fmt(a.eventAt)}</b></div>
      <div class="flex items-center justify-between"><span class="text-teal-200/70">${ic('clock')}بدء التذكير المسبق:</span><b>${fmt(a.startAt || a.eventAt)}</b></div>
      <div class="flex items-center justify-between"><span class="text-teal-200/70">${ic('repeat')}التكرار والفاصل:</span><b>${a.repeatCount} مرات • كل ${a.intervalHours} ساعة</b></div>
      ${a.status === 'active' ? `<div class="mt-1 flex items-center justify-between border-t border-white/10 pt-1.5 text-teal-300"><span>${ic('bell')}التذكير القادم:</span><b>${st.next ? `${fmt(st.next)} (${alertRemaining(st.next)})` : 'عند الموعد النهائي'}</b></div>` : ''}
    </div>

    <!-- schedule dots -->
    <div class="flex items-center gap-1 px-1">
      <span class="text-[11px] text-teal-200/70 me-1">مرات الرنين (${times.length}):</span>
      ${times.slice(0, 12).map((t, idx) => `<span title="${fmt(t)}" class="h-2.5 w-2.5 rounded-full ${t <= Date.now() ? 'bg-teal-400 shadow-sm shadow-teal-300' : 'bg-white/20'}"></span>`).join('')}
    </div>

    <div class="mt-auto flex flex-wrap gap-1.5 pt-1">
      ${a.status === 'active' ? `<button class="btn btn-sm !bg-teal-500 !text-slate-950 font-bold hover:!bg-teal-400" data-aa="dismiss:${a.id}">${ic('check')}تم الاطلاع / إيقاف</button>` : `<button class="btn btn-sm btn-ghost !bg-white/10 !text-white !ring-white/20" data-aa="reactivate:${a.id}">${ic('rotate-ccw')}إعادة تفعيل</button>`}
      <button class="btn btn-sm btn-ghost !bg-white/10 !text-white !ring-white/20" data-aa="edit:${a.id}">${ic('pencil')}تعديل</button>
      <button class="btn btn-sm btn-danger ms-auto" data-aa="del:${a.id}">${ic('trash-2')}</button>
    </div>
  </article>`;
}

function bindAlertActions() {
  document.querySelectorAll('[data-asnd]').forEach(b => b.onclick = e => { e.stopPropagation(); playAlertSound(b.dataset.asnd); });
  document.querySelectorAll('[data-aa]').forEach(b => b.onclick = guard(async () => {
    const [act, id] = b.dataset.aa.split(':'), a = (S.data.alerts || []).find(x => x.id === id);
    if (act === 'dismiss') { await call('POST', `alerts/${id}/dismiss`); toast('تم إيقاف التنبيه'); }
    else if (act === 'reactivate') { await call('POST', `alerts/${id}/reactivate`); toast('تمت إعادة تفعيل التنبيه'); }
    else if (act === 'edit') return alertForm(a);
    else if (act === 'del') return ask({ title: 'حذف التنبيه', body: `هل تريد حذف التنبيه "${a.title}" نهائياً؟`, okText: 'حذف التنبيه', icon: 'trash-2', tone: 'danger' },
      async () => { await call('DELETE', 'alerts/' + id); await refresh(); });
    await refresh();
  }));
}

function alertForm(a) {
  S.detailNoteId = null;
  const m = $('#modal');
  const now = Date.now();
  const defEvent = a?.eventAt || new Date(now + 4 * 36e5).toISOString();
  const defStart = a?.startAt || new Date(now + 1 * 36e5).toISOString();
  const users = S.data.users || [];
  const canAssignOthers = isMgr() && users.length > 1;
  m.innerHTML = `<form class="max-h-[92vh] w-full max-w-lg overflow-auto rounded-3xl bg-white p-6 shadow-2xl ring-1 ring-slate-200">
    <div class="mb-3 flex items-center gap-2.5">
      <span class="flex h-10 w-10 items-center justify-center rounded-2xl bg-teal-600 text-white">${ic('bell-ring')}</span>
      <div><h3 class="text-lg font-extrabold text-slate-800">${a ? 'تعديل التنبيه' : 'إضافة نوتة تنبيه جديدة'}</h3><p class="text-xs text-slate-500">حدد موعد الحدث ومتى يبدأ التذكير وعدد مرات التكرار</p></div>
    </div>

    <label class="label">عنوان التنبيه</label>
    <input name="title" value="${esc(a?.title || '')}" placeholder="مثال: اجتماع مراجعة الميزانية" class="input" required>

    <label class="label">تفاصيل إضافية (اختياري)</label>
    <textarea name="description" rows="2" placeholder="أي ملاحظات تظهر في نوتة التنبيه..." class="input">${esc(a?.description || '')}</textarea>

    ${canAssignOthers ? `<label class="label">المستفيد من التنبيه</label>
    <select name="targetId" class="input">
      <option value="${S.me.id}" ${(a?.targetId || S.me.id) === S.me.id ? 'selected' : ''}>🔔 لي شخصياً (${esc(S.me.name)})</option>
      ${users.filter(u => u.id !== S.me.id).map(u => `<option value="${u.id}" ${a?.targetId === u.id ? 'selected' : ''}>👤 ${esc(u.name)} (${ROLE[u.role]})</option>`).join('')}
    </select>` : ''}

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label class="label">وقت التنبيه الأساسي (الموعد)</label>
        <input name="eventAt" type="datetime-local" value="${toLocalInput(defEvent)}" class="input" required>
      </div>
      <div>
        <label class="label">بدء إرسال التنبيه قبل الموعد (التاريخ والوقت)</label>
        <input name="startAt" type="datetime-local" value="${toLocalInput(defStart)}" class="input" required>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label class="label">عدد مرات التنبيه</label>
        <input name="repeatCount" type="number" min="1" max="50" step="1" value="${a?.repeatCount ?? 3}" class="input" required>
      </div>
      <div>
        <label class="label">تكرار كل كم ساعة؟ (يقبل كسور مثل 0.5 لنصف ساعة)</label>
        <input name="intervalHours" type="number" min="0.05" max="720" step="any" value="${a?.intervalHours ?? 1}" class="input" required>
      </div>
    </div>

    <label class="label">نغمة صوت التنبيه</label>
    <div class="flex gap-2">
      <select name="sound" id="asnd-sel" class="input flex-1">
        ${Object.entries(SOUNDS).map(([k, v]) => `<option value="${k}" ${(a?.sound || 'iphone') === k ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>
      <button type="button" id="asnd-test" class="btn btn-ghost">${ic('volume-2')}تجربة الصوت</button>
    </div>

    <div class="mt-5 flex gap-2">
      <button class="btn !bg-teal-600 hover:!bg-teal-700">${ic('check')}حفظ التنبيه</button>
      <button type="button" class="btn btn-ghost" id="cx">${ic('x')}إلغاء</button>
    </div>
  </form>`;
  showModal();
  $('#cx').onclick = hideModal;
  $('#asnd-test').onclick = () => playAlertSound($('#asnd-sel').value);
  m.querySelector('form').onsubmit = guard(async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    b.eventAt = new Date(b.eventAt).toISOString();
    b.startAt = new Date(b.startAt).toISOString();
    b.repeatCount = +b.repeatCount;
    b.intervalHours = +b.intervalHours;
    await (a ? call('PUT', 'alerts/' + a.id, b) : call('POST', 'alerts', b));
    hideModal();
    playAlertSound(b.sound);
    await refresh();
  });
}

// check scheduled alertoccurrences every 20 seconds and ring in web browser
function checkScheduledAlerts() {
  if (!S.data?.alerts || !S.me) return;
  const firedMap = JSON.parse(localStorage.getItem('afired') || '{}');
  const now = Date.now();
  let rang = false;
  for (const a of S.data.alerts) {
    if (a.status !== 'active' || a.targetId !== S.me.id) continue;
    const times = alertSchedule(a);
    times.forEach((t, idx) => {
      const key = `${a.id}:${idx}:${t}`;
      if (now >= t && now - t < 15 * 60000 && !firedMap[key]) {
        firedMap[key] = now;
        if (!rang) { playAlertSound(a.sound || 'iphone'); rang = true; }
        toast(`🔔 تنبيه (${idx + 1}/${times.length}): ${a.title}`);
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(`🔔 تنبيه: ${a.title}`, { body: `${a.description || ''}\nالموعد: ${fmt(a.eventAt)}` });
        }
      }
    });
  }
  localStorage.setItem('afired', JSON.stringify(firedMap));
}
setInterval(checkScheduledAlerts, 20000);

// ---------- admin ----------
let cachedDevs = [];
async function adminView(silent = false) {
  $('#body').innerHTML = `<div class="space-y-5 p-5"><div id="adm-main"></div><div id="devs"></div></div>`;
  renderAdminMain();
  if (silent && cachedDevs.length) renderDevicesCard();
  cachedDevs = await call('GET', 'devices');
  if (S.tab === 'admin') {
    const st = captureUiState();
    renderDevicesCard();
    restoreUiState(st);
  }
}
function renderAdminMain() {
  const { departments, users } = S.data;
  const mgrs = users.filter(u => u.role === 'manager');
  const q = S.uq.trim().toLowerCase();
  const filteredUsers = users.filter(u => {
    if (u.role === 'admin') return false;
    if (S.uRole !== 'all' && u.role !== S.uRole) return false;
    if (S.uDept !== 'all' && u.deptId !== S.uDept) return false;
    if (q && !`${u.name} ${u.username}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const upg = paginate(filteredUsers, S.uPage, S.uPer);
  S.uPage = upg.cur;

  $('#adm-main').innerHTML = `<div class="space-y-5">
  <div class="card"><div class="mb-4 flex items-center"><h2 class="me-auto flex items-center gap-2 text-lg font-extrabold">${ic('building-2', 'text-brand-600')}الأقسام (${departments.length})</h2><button id="ad" class="btn">${ic('plus')}قسم</button></div>
  <div class="overflow-x-auto rounded-xl ring-1 ring-slate-200"><table class="w-full"><tr><th class="th">القسم</th><th class="th">المدير</th><th class="th">عدد الموظفين</th><th class="th"></th></tr>${departments.map(d => `<tr><td class="td font-medium">${esc(d.name)}</td>
    <td class="td">${esc(mgrs.filter(m => m.deptId === d.id).map(m => m.name).join('، ') || '—')}</td><td class="td">${users.filter(u => u.deptId === d.id && u.role === 'employee').length}</td>
    <td class="td"><div class="flex gap-1.5"><button class="btn btn-sm btn-ghost" data-de="${d.id}">${ic('pencil')}تعديل</button><button class="btn btn-sm btn-danger" data-dd="${d.id}">${ic('trash-2')}</button></div></td></tr>`).join('')}</table></div></div>

  <div class="card">
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <h2 class="me-auto flex items-center gap-2 text-lg font-extrabold">${ic('users', 'text-brand-600')}المستخدمون (${filteredUsers.length})</h2>
      <div class="relative min-w-[12rem]">
        ${ic('search', 'absolute start-3 top-1/2 -translate-y-1/2 text-slate-400')}
        <input id="uq" value="${esc(S.uq)}" placeholder="بحث بالاسم أو الدخول..." class="input ps-9 !py-1.5 text-xs">
      </div>
      <select id="urole" class="input !w-auto !py-1.5 text-xs font-medium">
        <option value="all">كل الأدوار</option>
        <option value="manager" ${S.uRole === 'manager' ? 'selected' : ''}>مدير قسم</option>
        <option value="employee" ${S.uRole === 'employee' ? 'selected' : ''}>موظف</option>
      </select>
      <select id="udept" class="input !w-auto !py-1.5 text-xs font-medium">
        <option value="all">كل الأقسام</option>
        ${departments.map(d => `<option value="${d.id}" ${S.uDept === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select>
      <button id="au" class="btn">${ic('plus')}مستخدم</button>
    </div>
    <div class="overflow-x-auto rounded-xl ring-1 ring-slate-200"><table class="w-full"><tr><th class="th">الاسم</th><th class="th">اسم الدخول</th><th class="th">الدور</th><th class="th">القسم</th><th class="th">المدير المباشر</th><th class="th"></th></tr>${upg.items.map(u => `<tr><td class="td font-medium">${esc(u.name)}</td><td class="td">${esc(u.username)}</td>
      <td class="td"><span class="chip ${u.role === 'manager' ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-600'}">${ROLE[u.role]}</span></td><td class="td">${esc(deptName(u.deptId))}</td><td class="td">${esc(u.managerId ? nm(u.managerId) : '—')}</td>
      <td class="td"><div class="flex gap-1.5"><button class="btn btn-sm btn-ghost" data-ue="${u.id}">${ic('pencil')}تعديل</button><button class="btn btn-sm btn-danger" data-ud="${u.id}">${ic('trash-2')}</button></div></td></tr>`).join('') || `<tr><td colspan="6" class="td py-8 text-center text-slate-400">لا يوجد مستخدمون مطابقون</td></tr>`}</table></div>
    ${pagerHtml(upg, 'u')}
  </div></div>`;

  $('#ad').onclick = () => form('قسم جديد', [{ k: 'name', label: 'اسم القسم' }], b => call('POST', 'departments', b).then(refresh));
  $('#au').onclick = () => userForm();
  $('#uq').oninput = e => { S.uq = e.target.value; S.uPage = 1; renderAdminMain(); const el = $('#uq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
  $('#urole').onchange = e => { S.uRole = e.target.value; S.uPage = 1; renderAdminMain(); };
  $('#udept').onchange = e => { S.uDept = e.target.value; S.uPage = 1; renderAdminMain(); };
  document.querySelectorAll('[data-pg^="u:"]').forEach(b => b.onclick = () => { S.uPage = +b.dataset.pg.split(':')[1]; renderAdminMain(); });
  document.querySelectorAll('[data-de]').forEach(b => b.onclick = () => { const d = departments.find(x => x.id === b.dataset.de); form('تعديل القسم', [{ k: 'name', label: 'الاسم', value: d.name }], v => call('PUT', 'departments/' + d.id, v).then(refresh)); });
  document.querySelectorAll('[data-dd]').forEach(b => b.onclick = () => {
    const d = departments.find(x => x.id === b.dataset.dd);
    ask({ title: 'حذف القسم', body: `هل تريد حذف قسم "${d?.name || ''}"؟`, okText: 'حذف القسم', icon: 'trash-2', tone: 'danger' },
      async () => { await call('DELETE', 'departments/' + b.dataset.dd); await refresh(); });
  });
  document.querySelectorAll('[data-ue]').forEach(b => b.onclick = () => userForm(users.find(x => x.id === b.dataset.ue)));
  document.querySelectorAll('[data-ud]').forEach(b => b.onclick = () => {
    const u = users.find(x => x.id === b.dataset.ud);
    ask({ title: 'حذف المستخدم', body: `هل تريد حذف المستخدم "${u?.name || ''}"؟`, okText: 'حذف المستخدم', icon: 'trash-2', tone: 'danger' },
      async () => { await call('DELETE', 'users/' + b.dataset.ud); await refresh(); });
  });
}
function renderDevicesCard() {
  if (S.tab !== 'admin' || !$('#devs')) return;
  const q = S.dq.trim().toLowerCase();
  const filtered = cachedDevs.filter(d => {
    if (S.dKind !== 'all' && d.kind !== S.dKind) return false;
    if (q && !`${d.userName} ${d.name} ${d.osUser || ''} ${d.ip}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const pg = paginate(filtered, S.dPage, S.dPer);
  S.dPage = pg.cur;

  $('#devs').innerHTML = `<div class="card">
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <h2 class="me-auto flex items-center gap-2 text-lg font-extrabold">${ic('monitor', 'text-brand-600')}أجهزة المستخدمين (${filtered.length})</h2>
      <div class="relative min-w-[12rem]">
        ${ic('search', 'absolute start-3 top-1/2 -translate-y-1/2 text-slate-400')}
        <input id="dq" value="${esc(S.dq)}" placeholder="بحث بالمستخدم أو الجهاز أو IP..." class="input ps-9 !py-1.5 text-xs">
      </div>
      <select id="dkind" class="input !w-auto !py-1.5 text-xs font-medium">
        <option value="all">كل الأنواع</option>
        <option value="desktop" ${S.dKind === 'desktop' ? 'selected' : ''}>🖥 سطح المكتب</option>
        <option value="web" ${S.dKind === 'web' ? 'selected' : ''}>🌐 متصفح</option>
      </select>
    </div>
    <div class="overflow-x-auto rounded-xl ring-1 ring-slate-200"><table class="w-full"><tr><th class="th">المستخدم</th><th class="th">النوع</th><th class="th">الجهاز</th><th class="th">النظام</th><th class="th">IP</th><th class="th">أول دخول</th><th class="th">آخر دخول</th><th class="th">مرات الدخول</th></tr>
    ${pg.items.map(d => `<tr><td class="td font-medium">${esc(d.userName)}</td><td class="td"><span class="chip bg-slate-100 text-slate-600">${ic(d.kind === 'desktop' ? 'monitor' : 'globe')}${d.kind === 'desktop' ? 'سطح المكتب' : 'متصفح'}</span></td><td class="td">${esc(d.name)}${d.osUser ? ' / ' + esc(d.osUser) : ''}</td><td class="td max-w-56 truncate">${esc((d.os || '').slice(0, 60))}</td><td class="td">${esc(d.ip)}</td><td class="td">${fmt(d.firstSeen)}</td><td class="td">${fmt(d.lastSeen)}</td><td class="td">${d.logins}</td></tr>`).join('') || `<tr><td colspan="8" class="td py-8 text-center text-slate-400">لا توجد أجهزة</td></tr>`}</table></div>
    ${pagerHtml(pg, 'd')}</div>`;

  $('#dq').oninput = e => { S.dq = e.target.value; S.dPage = 1; renderDevicesCard(); const el = $('#dq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
  $('#dkind').onchange = e => { S.dKind = e.target.value; S.dPage = 1; renderDevicesCard(); };
  document.querySelectorAll('[data-pg^="d:"]').forEach(b => b.onclick = () => { S.dPage = +b.dataset.pg.split(':')[1]; renderDevicesCard(); });
}
function userForm(u) {
  const { departments, users } = S.data;
  if (!departments.length) return toast('أنشئ قسماً أولاً');
  const m = $('#modal');
  const mgrOpts = dept => users.filter(x => x.role === 'manager' && x.deptId === dept).map(x => ({ v: x.id, t: x.name }));
  form(u ? 'تعديل مستخدم' : 'مستخدم جديد', [
    { k: 'name', label: 'الاسم', value: u?.name },
    { k: 'username', label: 'اسم الدخول', value: u?.username },
    { k: 'password', label: u ? 'كلمة مرور جديدة (اختياري)' : 'كلمة المرور', type: 'password', req: !u },
    { k: 'role', label: 'الدور', type: 'select', value: u?.role, options: [{ v: 'employee', t: 'موظف' }, { v: 'manager', t: 'مدير قسم' }] },
    { k: 'deptId', label: 'القسم', type: 'select', value: u?.deptId, options: departments.map(d => ({ v: d.id, t: d.name })) },
    { k: 'managerId', label: 'المدير المباشر (للموظف)', type: 'select', value: u?.managerId, options: [] },
  ], b => {
    if (!b.password) delete b.password;
    return call(u ? 'PUT' : 'POST', u ? 'users/' + u.id : 'users', b).then(refresh);
  });
  const sync = () => {
    const dept = m.querySelector('[name=deptId]').value, role = m.querySelector('[name=role]').value, sel = m.querySelector('[name=managerId]');
    const cur = sel.value || u?.managerId;
    sel.innerHTML = mgrOpts(dept).map(o => `<option value="${o.v}" ${o.v === cur ? 'selected' : ''}>${esc(o.t)}</option>`).join('');
    sel.disabled = role !== 'employee';
  };
  m.querySelector('[name=deptId]').onchange = sync; m.querySelector('[name=role]').onchange = sync; sync();
}

setInterval(() => { if (S.me && S.data && !modalOpen() && S.tab !== 'history' && S.tab !== 'admin') { render(); notifyDue(); } }, 60000);
// in-app alert for the user's own late/critical notes, or notes awaiting a manager's confirmation
function notifyDue() {
  if (!S.data) return;
  const msgs = [];
  if (S.me.role === 'employee') {
    const c = S.data.notes.filter(n => ['late', 'critical'].includes(priority(n))).length;
    if (c) msgs.push(`⚠ لديك ${c} نوتة حرجة أو متأخرة`);
  } else {
    const p = S.data.notes.filter(n => n.status === 'pending' && canConfirm(n)).length;
    if (p) msgs.push(`⏳ ${p} نوتة بانتظار تأكيدك`);
  }
  msgs.forEach(m => {
    toast(m);
    if ('Notification' in window && Notification.permission === 'granted') new Notification('النوتات الذكية', { body: m });
  });
}
// ask once for browser-notification permission
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}
boot();
