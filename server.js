// Smart Sticky Notes - zero-dependency Node.js server
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const PUBLIC = path.join(__dirname, 'public');

// ---------- storage ----------
const uid = () => crypto.randomBytes(6).toString('hex');
const hash = (pw, salt = crypto.randomBytes(8).toString('hex')) =>
  salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const verify = (pw, stored) => hash(pw, stored.split(':')[0]) === stored;

// Data lives in MySQL/MariaDB. Each collection is a table (id, doc JSON); an in-memory
// copy serves reads and every change is synced to the database incrementally.
const mysql = require('mysql2/promise');
const COLS = ['departments', 'users', 'projects', 'notes', 'history', 'devices', 'alerts'];
let pool, db;
const synced = {};          // collection -> Map(id -> json string) last written to MySQL
let saving = Promise.resolve();

async function init() {
  const cfg = { host: process.env.DB_HOST || '127.0.0.1', port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASS || '' };
  const name = process.env.DB_NAME || 'sticky_notes';
  try {
    const boot = await mysql.createConnection(cfg);
    await boot.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4`);
    await boot.end();
  } catch {
    // On cPanel shared hosting, the database is pre-created and user lacks CREATE DATABASE privilege
  }
  pool = mysql.createPool({ ...cfg, database: name, connectionLimit: 5 });
  db = {};
  for (const c of COLS) {
    await pool.query(`CREATE TABLE IF NOT EXISTS \`${c}\` (id VARCHAR(32) PRIMARY KEY, doc LONGTEXT NOT NULL, pos BIGINT AUTO_INCREMENT UNIQUE) CHARACTER SET utf8mb4`);
    const [rows] = await pool.query(`SELECT id, doc FROM \`${c}\` ORDER BY pos`);
    db[c] = rows.map(r => JSON.parse(r.doc));
    synced[c] = new Map(rows.map(r => [r.id, r.doc]));
  }
  // one-time import of the old JSON file, if the database is still empty
  if (!db.users.length && fs.existsSync(DB_FILE)) {
    const old = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    COLS.forEach(c => { db[c] = old[c] || []; });
    fs.renameSync(DB_FILE, DB_FILE + '.imported');
  }
  if (!db.users.length) {
    db.users.push({ id: uid(), name: 'مدير النظام', username: 'admin', password: hash('admin123'),
      role: 'admin', deptId: null, managerId: null });
  }
  await sync();
}
async function sync() {
  for (const c of COLS) {
    const cur = new Map(db[c].map(x => [x.id, JSON.stringify(x)]));
    const old = synced[c];
    for (const [id, doc] of cur) if (old.get(id) !== doc)
      await pool.query(`INSERT INTO \`${c}\` (id, doc) VALUES (?, ?) ON DUPLICATE KEY UPDATE doc = VALUES(doc)`, [id, doc]);
    for (const id of old.keys()) if (!cur.has(id)) await pool.query(`DELETE FROM \`${c}\` WHERE id = ?`, [id]);
    synced[c] = cur;
  }
}
let stateVersion = Date.now();
const CODE_VER = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['index.html', 'app.js', 'icons.js', 'tailwind.css']) {
    try { h.update(fs.readFileSync(path.join(PUBLIC, f))); } catch {}
  }
  return h.digest('hex').slice(0, 12);
})();
const sseClients = new Set();
function broadcastChange() {
  stateVersion = Math.max(stateVersion + 1, Date.now());
  const msg = `data: ${JSON.stringify({ v: stateVersion, codeVer: CODE_VER, ts: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}
setInterval(() => {
  for (const client of sseClients) {
    try { client.write(': ping\n\n'); } catch { sseClients.delete(client); }
  }
}, 20000);

function save() {
  broadcastChange();
  saving = saving.then(sync).catch(e => console.error('DB sync failed:', e.message));
  return saving;
}
const SECRET = crypto.createHash('sha256').update(DB_FILE + ':sticky-secret').digest();
let lastActiveToken = null;
function makeToken(userId) {
  const sig = crypto.createHmac('sha256', SECRET).update(userId).digest('hex').slice(0, 32);
  return `${userId}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [userId, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(userId).digest('hex').slice(0, 32);
  return sig === expected ? userId : null;
}

// ---------- helpers ----------
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };
const byId = (arr, id) => arr.find(x => x.id === id);
const pub = u => ({ id: u.id, name: u.name, username: u.username, role: u.role, deptId: u.deptId, managerId: u.managerId });

function noteDeptId(n) { const p = byId(db.projects, n.projectId); return p && p.deptId; }
function canManageDept(user, deptId) {
  return user.role === 'admin' || (user.role === 'manager' && user.deptId === deptId);
}
// Who may confirm completion of a note: the assignee's direct manager (or admin)
function canConfirm(user, note) {
  if (user.role === 'admin') return true;
  const assignee = byId(db.users, note.assigneeId);
  return !!assignee && user.role === 'manager' && assignee.managerId === user.id;
}

function ensurePersonalProject(user) {
  const pid = 'pers_' + user.id;
  let p = byId(db.projects, pid);
  if (!p) {
    const deptId = user.deptId || (db.departments[0]?.id || null);
    p = { id: pid, name: 'نوتاتي الخاصة', description: 'نوتات ومهام شخصية خاصة بـ ' + user.name,
      deptId, createdBy: user.id, personal: true, ownerId: user.id };
    db.projects.push(p);
  }
  if (p.archived) { p.archived = false; delete p.archivedAt; delete p.archivedBy; }
  return p;
}

function visibleData(user) {
  let departments, projects, notes, users;
  const canSeeProj = p => !p.archived && (!p.personal || p.ownerId === user.id);
  if (user.role === 'admin') {
    departments = db.departments;
    projects = db.projects.filter(canSeeProj);
    const pids = new Set(projects.map(p => p.id));
    notes = db.notes.filter(n => pids.has(n.projectId) || n.assigneeId === user.id);
    users = db.users;
  } else if (user.role === 'manager') {
    departments = db.departments.filter(d => d.id === user.deptId);
    projects = db.projects.filter(p => (p.deptId === user.deptId || p.ownerId === user.id) && canSeeProj(p));
    const pids = new Set(projects.map(p => p.id));
    notes = db.notes.filter(n => pids.has(n.projectId) || n.assigneeId === user.id);
    users = db.users.filter(u => u.deptId === user.deptId || u.id === user.id);
  } else { // employee: own assigned notes + own personal notes
    notes = db.notes.filter(n => n.assigneeId === user.id || n.createdBy === user.id);
    const pids = new Set(notes.map(n => n.projectId));
    projects = db.projects.filter(p => !p.archived && (pids.has(p.id) || p.ownerId === user.id));
    const dids = new Set(projects.map(p => p.deptId).concat(user.deptId ? [user.deptId] : []));
    departments = db.departments.filter(d => dids.has(d.id));
    users = db.users.filter(u => u.id === user.id || u.id === user.managerId);
  }
  // finished (confirmed) notes, with full details for the detail modal
  const pids = new Set(projects.map(p => p.id));
  const done = db.history.filter(h => pids.has(h.projectId) && (user.role !== 'employee' || h.assigneeId === user.id))
    .map(h => {
      const p = byId(db.projects, h.projectId);
      return { ...h, projectName: (p || {}).name || '—', deptName: (byId(db.departments, p?.deptId) || {}).name || '—',
        assigneeName: (byId(db.users, h.assigneeId) || {}).name || '—', createdByName: (byId(db.users, h.createdBy) || {}).name || '—',
        confirmedByName: (byId(db.users, h.confirmedBy) || {}).name || '—' };
    })
    .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
  if (user.role === 'manager' || user.role === 'admin') users = users.concat(db.users.filter(u => done.some(d => d.assigneeId === u.id) && !users.includes(u)));
  const alerts = (db.alerts || []).filter(a => a.targetId === user.id || a.userId === user.id).map(a => ({
    ...a, targetName: (byId(db.users, a.targetId) || {}).name || '—', createdByName: (byId(db.users, a.userId) || {}).name || '—'
  })).sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt));
  return { v: stateVersion, codeVer: CODE_VER, departments, projects, notes, done, alerts, users: users.map(pub) };
}

function validateDates(start, end) {
  if (!start || !end || isNaN(Date.parse(start)) || isNaN(Date.parse(end))) fail(400, 'تواريخ غير صحيحة');
  if (Date.parse(end) < Date.parse(start)) fail(400, 'تاريخ النهاية قبل البداية');
}

function validateAssignee(user, assigneeId, deptId) {
  const a = byId(db.users, assigneeId);
  if (!a || a.role !== 'employee') fail(400, 'يجب إسناد النوتة إلى موظف');
  if (a.deptId !== deptId) fail(400, 'الموظف ليس من نفس قسم المشروع');
  return a;
}

// remember the device each user logs in from (web browser or desktop agent)
function recordDevice(u, d, req) {
  d = d || {};
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace('::ffff:', '');
  const key = String(d.key || d.name || req.headers['user-agent'] || 'unknown').slice(0, 120);
  let rec = db.devices.find(x => x.userId === u.id && x.key === key);
  const now = new Date().toISOString();
  if (!rec) {
    rec = { id: uid(), userId: u.id, key, firstSeen: now, logins: 0 };
    db.devices.push(rec);
  }
  // mark this user as the active remembered user on this device key
  db.devices.forEach(x => { if (x.key === key) x.activeOnDevice = false; });
  Object.assign(rec, { kind: d.kind || 'web', name: String(d.name || '').slice(0, 120), os: String(d.os || '').slice(0, 200),
    osUser: String(d.user || '').slice(0, 80), screen: String(d.screen || '').slice(0, 30), ip,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 250), lastSeen: now, logins: rec.logins + 1,
    loggedOut: false, activeOnDevice: true });
  save();
}
function parseCookieToken(req) {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)sn_tk=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
// ---------- API ----------
function api(req, method, url, body, user) {
  const parts = url.split('/').filter(Boolean).slice(1); // drop 'api'
  const [res, id, action] = parts;

  if (res === 'login' && method === 'POST') {
    const u = db.users.find(x => x.username === body.username);
    if (!u || !verify(String(body.password || ''), u.password)) fail(401, 'بيانات الدخول غير صحيحة');
    const token = makeToken(u.id);
    recordDevice(u, body.device, req);
    return { token, user: pub(u), serverToken: token };
  }
  if (res === 'auto-login' && method === 'POST') {
    if (user) {
      if (body.device) recordDevice(user, body.device, req);
      return { token: makeToken(user.id), user: pub(user) };
    }
    const dk = String(body.device?.key || '').slice(0, 120);
    const candidates = db.devices
      .filter(x => x.key && x.key === dk && !x.loggedOut)
      .sort((a, b) => (b.activeOnDevice ? 1 : 0) - (a.activeOnDevice ? 1 : 0) || (b.lastSeen || '').localeCompare(a.lastSeen || ''));
    const rec = candidates[0];
    const u = rec && byId(db.users, rec.userId);
    if (!u) fail(401, 'لا توجد جلسة محفوظة لهذا الجهاز');
    rec.lastSeen = new Date().toISOString();
    save();
    return { token: makeToken(u.id), user: pub(u) };
  }
  if (!user) fail(401, 'غير مسجل الدخول');
  if (res === 'logout') {
    const dk = String(body.deviceKey || '').slice(0, 120);
    db.devices.forEach(x => {
      if (x.userId === user.id && (!dk || x.key === dk)) { x.loggedOut = true; x.activeOnDevice = false; }
    });
    save();
    return { ok: true };
  }
  if (res === 'devices' && method === 'GET') {
    if (user.role !== 'admin') fail(403, 'للمدير العام فقط');
    return db.devices.map(d => ({ ...d, userName: (byId(db.users, d.userId) || {}).name || '—' })).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }
  if (res === 'me') return pub(user);
  if (res === 'password' && (method === 'POST' || method === 'PUT')) {
    if (!verify(String(body.currentPassword || ''), user.password)) fail(400, 'كلمة المرور الحالية غير صحيحة');
    const np = String(body.newPassword || '');
    if (np.length < 4) fail(400, 'كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل');
    user.password = hash(np);
    save();
    return { ok: true, token: makeToken(user.id), user: pub(user) };
  }
  if (res === 'data' && method === 'GET') return visibleData(user);
  if (res === 'history' && method === 'GET') {
    const list = db.history.filter(h => {
      if (user.role === 'admin') return true;
      if (user.role === 'employee') return h.assigneeId === user.id;
      const p = byId(db.projects, h.projectId);
      return p && p.deptId === user.deptId;
    }).map(h => {
      const p = byId(db.projects, h.projectId);
      return { ...h, projectName: (p || {}).name || '—', deptName: (byId(db.departments, p?.deptId) || {}).name || '—',
        assigneeName: (byId(db.users, h.assigneeId) || {}).name || '—', createdByName: (byId(db.users, h.createdBy) || {}).name || '—',
        confirmedByName: (byId(db.users, h.confirmedBy) || {}).name || '—' };
    });
    return list.reverse();
  }

  // --- archived projects (admin sees all, managers see their department) ---
  if (res === 'archive' && method === 'GET') {
    if (user.role === 'employee') fail(403, 'غير مسموح');
    return db.projects.filter(p => p.archived && (user.role === 'admin' || p.deptId === user.deptId)).map(p => {
      const done = db.history.filter(h => h.projectId === p.id);
      return { ...p, deptName: (byId(db.departments, p.deptId) || {}).name || '—', doneCount: done.length,
        lastDone: done.reduce((m, h) => (h.confirmedAt > m ? h.confirmedAt : m), ''),
        archivedByName: (byId(db.users, p.archivedBy) || {}).name || '—' };
    }).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  // --- departments (admin) ---
  if (res === 'departments') {
    if (user.role !== 'admin') fail(403, 'للمدير العام فقط');
    if (method === 'POST') {
      if (!body.name) fail(400, 'الاسم مطلوب');
      const d = { id: uid(), name: body.name }; db.departments.push(d); save(); return d;
    }
    const d = byId(db.departments, id); if (!d) fail(404, 'غير موجود');
    if (method === 'PUT') { d.name = body.name || d.name; save(); return d; }
    if (method === 'DELETE') {
      if (db.users.some(u => u.deptId === id) || db.projects.some(p => p.deptId === id))
        fail(400, 'القسم مرتبط بمستخدمين أو مشاريع');
      db.departments = db.departments.filter(x => x.id !== id); save(); return { ok: true };
    }
  }

  // --- users (admin) ---
  if (res === 'users') {
    if (user.role !== 'admin') fail(403, 'للمدير العام فقط');
    const check = b => {
      if (!['manager', 'employee'].includes(b.role)) fail(400, 'دور غير صحيح');
      if (!byId(db.departments, b.deptId)) fail(400, 'يجب ربط المستخدم بقسم');
      if (b.role === 'employee') {
        const m = byId(db.users, b.managerId);
        if (!m || m.role !== 'manager' || m.deptId !== b.deptId) fail(400, 'المدير المباشر يجب أن يكون مديراً في نفس القسم');
      }
    };
    if (method === 'POST') {
      if (!body.name || !body.username || !body.password) fail(400, 'بيانات ناقصة');
      if (db.users.some(u => u.username === body.username)) fail(400, 'اسم المستخدم مستخدم');
      check(body);
      const u = { id: uid(), name: body.name, username: body.username, password: hash(body.password),
        role: body.role, deptId: body.deptId, managerId: body.role === 'employee' ? body.managerId : null };
      db.users.push(u); save(); return pub(u);
    }
    const u = byId(db.users, id); if (!u || u.role === 'admin') fail(404, 'غير موجود');
    if (method === 'PUT') {
      const merged = { ...u, ...body };
      check(merged);
      if (body.username && db.users.some(x => x.username === body.username && x.id !== id)) fail(400, 'اسم المستخدم مستخدم');
      Object.assign(u, { name: merged.name, username: merged.username, role: merged.role,
        deptId: merged.deptId, managerId: merged.role === 'employee' ? merged.managerId : null });
      if (body.password) u.password = hash(body.password);
      save(); return pub(u);
    }
    if (method === 'DELETE') {
      if (db.users.some(x => x.managerId === id)) fail(400, 'هذا المدير لديه موظفون تابعون');
      if (db.notes.some(n => n.assigneeId === id)) fail(400, 'لدى المستخدم نوتات نشطة');
      db.users = db.users.filter(x => x.id !== id); db.devices = db.devices.filter(d => d.userId !== id); save(); return { ok: true };
    }
  }

  // --- projects ---
  if (res === 'projects') {
    if (user.role === 'employee') fail(403, 'غير مسموح');
    if (method === 'POST' && !id) {
      const deptId = user.role === 'admin' ? body.deptId : user.deptId;
      if (!byId(db.departments, deptId)) fail(400, 'القسم غير صحيح');
      if (!body.name) fail(400, 'الاسم مطلوب');
      const p = { id: uid(), name: body.name, description: body.description || '', deptId, createdBy: user.id };
      db.projects.push(p); save(); return p;
    }
    const p = byId(db.projects, id); if (!p) fail(404, 'غير موجود');
    if (!canManageDept(user, p.deptId)) fail(403, 'غير مسموح');
    if (action === 'archive' && method === 'POST') {
      if (p.archived) fail(400, 'المشروع مؤرشف بالفعل');
      if (db.notes.some(n => n.projectId === id)) fail(400, 'لا يمكن الأرشفة: توجد نوتات لم تنته أو لم تُؤكَّد بعد');
      Object.assign(p, { archived: true, archivedAt: new Date().toISOString(), archivedBy: user.id }); save(); return p;
    }
    if (action === 'restore' && method === 'POST') {
      if (!p.archived) fail(400, 'المشروع غير مؤرشف');
      p.archived = false; delete p.archivedAt; delete p.archivedBy; save(); return p;
    }
    if (method === 'PUT') { p.name = body.name || p.name; p.description = body.description ?? p.description; save(); return p; }
    if (method === 'DELETE') {
      db.notes = db.notes.filter(n => n.projectId !== id);
      db.projects = db.projects.filter(x => x.id !== id); save(); return { ok: true };
    }
  }

  // --- notes ---
  if (res === 'notes') {
    if (method === 'POST' && !id) {
      validateDates(body.start, body.end);
      const isPersonalReq = body.personal || body.projectId === 'personal' || !body.projectId || user.role === 'employee';
      let p, assigneeId, isPersonal = false;
      if (body.personal || body.projectId === 'personal' || !body.projectId) {
        p = ensurePersonalProject(user);
        assigneeId = user.id;
        isPersonal = true;
      } else {
        p = byId(db.projects, body.projectId); if (!p) fail(400, 'المشروع غير موجود');
        if (p.archived) fail(400, 'المشروع مؤرشف');
        if (p.personal && p.ownerId === user.id) {
          assigneeId = user.id;
          isPersonal = true;
        } else if (user.role === 'employee') {
          if (p.deptId !== user.deptId) fail(403, 'غير مسموح');
          assigneeId = user.id;
          isPersonal = true;
        } else {
          if (!canManageDept(user, p.deptId)) fail(403, 'غير مسموح');
          validateAssignee(user, body.assigneeId, p.deptId);
          assigneeId = body.assigneeId;
        }
      }
      if (body.parentId) { const par = byId(db.notes, body.parentId); if (!par || par.projectId !== p.id) fail(400, 'النوتة الأم غير صحيحة'); }
      const n = { id: uid(), projectId: p.id, parentId: body.parentId || null, title: body.title || 'بدون عنوان',
        description: body.description || '', start: body.start, end: body.end, assigneeId,
        createdBy: user.id, personal: isPersonal, status: 'open', createdAt: new Date().toISOString() };
      db.notes.push(n); save(); return n;
    }
    const n = byId(db.notes, id); if (!n) fail(404, 'النوتة غير موجودة');
    const deptId = noteDeptId(n);
    const isOwnNote = (n.personal || n.createdBy === user.id) && n.assigneeId === user.id;

    if (action === 'done' && method === 'POST') {
      if (n.assigneeId !== user.id) fail(403, 'هذه النوتة ليست لك');
      if (n.status !== 'open') fail(400, 'الحالة لا تسمح');
      const now = new Date().toISOString();
      if (isOwnNote) {
        // personal note created by the user themselves -> complete directly without needing manager approval
        db.notes.forEach(c => { if (c.parentId === n.id) c.parentId = n.parentId; });
        db.notes = db.notes.filter(x => x.id !== n.id);
        db.history.push({ ...n, doneAt: now, confirmedBy: user.id, confirmedAt: now });
        save(); return { ok: true, removed: n.id, autoConfirmed: true };
      }
      n.status = 'pending'; n.doneAt = now; save(); return n;
    }
    if (action === 'confirm' && method === 'POST') {
      if (!canConfirm(user, n) && !isOwnNote) fail(403, 'التأكيد للمدير المباشر للموظف فقط');
      if (n.status !== 'pending' && !isOwnNote) fail(400, 'النوتة لم تُنجز بعد');
      // remove from the tree (children are re-attached to the parent), keep an archive record
      db.notes.forEach(c => { if (c.parentId === n.id) c.parentId = n.parentId; });
      db.notes = db.notes.filter(x => x.id !== n.id);
      const now = new Date().toISOString();
      db.history.push({ ...n, doneAt: n.doneAt || now, confirmedBy: user.id, confirmedAt: now });
      save(); return { ok: true, removed: n.id };
    }
    if (action === 'reject' && method === 'POST') {
      if (!canConfirm(user, n)) fail(403, 'غير مسموح');
      if (n.status !== 'pending') fail(400, 'النوتة ليست بانتظار التأكيد');
      n.status = 'open'; n.rejectNote = body.reason || ''; delete n.doneAt; save(); return n;
    }
    if (!canManageDept(user, deptId) && !isOwnNote) fail(403, 'غير مسموح');
    if (method === 'PUT') {
      const s = body.start ?? n.start, e = body.end ?? n.end; validateDates(s, e);
      if (body.assigneeId && !isOwnNote) validateAssignee(user, body.assigneeId, deptId);
      Object.assign(n, { title: body.title ?? n.title, description: body.description ?? n.description,
        start: s, end: e, assigneeId: isOwnNote ? user.id : (body.assigneeId || n.assigneeId) });
      save(); return n;
    }
    if (method === 'DELETE') {
      const del = new Set([id]); let grew = true;
      while (grew) { grew = false; db.notes.forEach(c => { if (!del.has(c.id) && del.has(c.parentId)) { del.add(c.id); grew = true; } }); }
      db.notes = db.notes.filter(x => !del.has(x.id)); save(); return { ok: true };
    }
  }

  // --- alerts / reminders ---
  if (res === 'alerts') {
    const checkAlert = (b, cur) => {
      const ev = b.eventAt ?? cur?.eventAt, st = b.startAt ?? cur?.startAt ?? ev;
      if (!ev || isNaN(Date.parse(ev)) || isNaN(Date.parse(st))) fail(400, 'تواريخ التنبيه غير صحيحة');
      if (Date.parse(st) > Date.parse(ev)) fail(400, 'وقت بدء التذكير يجب أن يكون قبل أو يساوي وقت التنبيه');
      const cnt = Math.max(1, Math.min(50, +(b.repeatCount ?? cur?.repeatCount ?? 1) || 1));
      const hrs = Math.max(0.05, +(b.intervalHours ?? cur?.intervalHours ?? 1) || 1);
      let tid = b.targetId || cur?.targetId || user.id;
      if (tid !== user.id) {
        const tUser = byId(db.users, tid);
        if (!tUser) fail(400, 'المستخدم غير موجود');
        if (user.role === 'employee') fail(403, 'لا يمكنك إسناد تنبيه لمستخدم آخر');
        if (user.role === 'manager' && tUser.deptId !== user.deptId) fail(403, 'المستخدم ليس في قسمك');
      }
      return { eventAt: ev, startAt: st, repeatCount: cnt, intervalHours: hrs, targetId: tid };
    };
    if (method === 'POST' && !id) {
      if (!body.title) fail(400, 'عنوان التنبيه مطلوب');
      const v = checkAlert(body, null);
      const a = { id: uid(), userId: user.id, targetId: v.targetId, title: body.title, description: body.description || '',
        eventAt: v.eventAt, startAt: v.startAt, repeatCount: v.repeatCount, intervalHours: v.intervalHours,
        sound: body.sound || 'iphone', status: 'active', createdAt: new Date().toISOString() };
      db.alerts.push(a); save(); return a;
    }
    const a = byId(db.alerts, id); if (!a) fail(404, 'التنبيه غير موجود');
    const isLocalDesktop = req.headers['x-client'] === 'desktop' && ['127.0.0.1', '::1'].includes((req.socket.remoteAddress || '').replace('::ffff:', ''));
    if (a.userId !== user.id && a.targetId !== user.id && user.role !== 'admin' && !isLocalDesktop) fail(403, 'غير مسموح');
    if (action === 'dismiss' && method === 'POST') {
      a.status = 'dismissed'; a.dismissedAt = new Date().toISOString(); save(); return a;
    }
    if (action === 'reactivate' && method === 'POST') {
      a.status = 'active'; delete a.dismissedAt; save(); return a;
    }
    if (method === 'PUT') {
      const v = checkAlert(body, a);
      Object.assign(a, { title: body.title ?? a.title, description: body.description ?? a.description,
        eventAt: v.eventAt, startAt: v.startAt, repeatCount: v.repeatCount, intervalHours: v.intervalHours,
        targetId: v.targetId, sound: body.sound || a.sound });
      save(); return a;
    }
    if (method === 'DELETE') {
      db.alerts = db.alerts.filter(x => x.id !== id); save(); return { ok: true };
    }
  }
  fail(404, 'مسار غير معروف');
}

// ---------- server ----------
const DESKTOP = path.join(__dirname, 'desktop');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ps1': 'text/plain; charset=utf-8', '.ttf': 'font/ttf' };

init().then(() => http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/api/desktop-setup' && req.method === 'GET') {
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const tk = qs.get('token') || (req.headers.authorization || '').replace('Bearer ', '') || parseCookieToken(req);
    const u = byId(db.users, verifyToken(tk));
    if (!u) { res.writeHead(401); return res.end('Unauthorized'); }
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'sticky.abdallaswe.tech';
    const srv = `${proto}://${host}`;
    const userToken = makeToken(u.id);
    const bat = [
      '@echo off',
      'chcp 65001 >nul',
      'echo Configuring Smart Sticky Notes Desktop Agent for ' + u.username + '...',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "` +
        `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ` +
        `$d = Join-Path $env:APPDATA 'StickyAgent'; $f = Join-Path $d 'fonts'; ` +
        `New-Item -ItemType Directory -Force $d | Out-Null; New-Item -ItemType Directory -Force $f | Out-Null; ` +
        `Invoke-WebRequest -Uri '${srv}/desktop/agent.ps1' -OutFile (Join-Path $d 'agent.ps1') -UseBasicParsing; ` +
        `foreach ($fn in 'Tajawal-Regular.ttf','Tajawal-Medium.ttf','Tajawal-Bold.ttf') { try { Invoke-WebRequest -Uri ('${srv}/desktop/fonts/' + $fn) -OutFile (Join-Path $f $fn) -UseBasicParsing } catch {} }; ` +
        `@{ server = '${srv}'; username = '${u.username}'; token = '${userToken}' } | ConvertTo-Json | Set-Content (Join-Path $d 'config.json') -Encoding UTF8; ` +
        `$ag = Join-Path $d 'agent.ps1'; $cmd = '-WindowStyle Hidden -ExecutionPolicy Bypass -File \\"' + $ag + '\\"'; ` +
        `$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'StickyNotesAgent.lnk'; ` +
        `$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk); $s.TargetPath = 'powershell.exe'; $s.Arguments = $cmd; $s.WorkingDirectory = $d; $s.WindowStyle = 7; $s.Save(); ` +
        `Get-CimInstance Win32_Process -Filter \\"Name='powershell.exe'\\" | Where-Object { $_.CommandLine -like '*agent.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ` +
        `Start-Process powershell.exe -ArgumentList $cmd; Write-Host 'Done! Sticky Notes Desktop Agent is now active on your desktop.' -ForegroundColor Green"`,
      'timeout /t 3 >nul',
    ].join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="StickyDesktopSetup.bat"',
    });
    return res.end(bat);
  }
  if (url === '/api/events' && req.method === 'GET') {
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const tk = qs.get('token') || (req.headers.authorization || '').replace('Bearer ', '') || parseCookieToken(req);
    const u = byId(db.users, verifyToken(tk));
    if (!u) { res.writeHead(401); return res.end(); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ v: stateVersion, codeVer: CODE_VER, ts: Date.now(), hello: true })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.startsWith('/api/')) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let status = 200, out;
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      try {
        const body = raw ? JSON.parse(raw) : {};
        const hdrToken = (req.headers.authorization || '').replace('Bearer ', '');
        const cookieToken = parseCookieToken(req);
        const uidFromToken = verifyToken(hdrToken) || verifyToken(cookieToken);
        const token = verifyToken(hdrToken) ? hdrToken : cookieToken;
        const user = byId(db.users, uidFromToken);
        if (user && req.headers['x-client'] !== 'desktop') lastActiveToken = token;
        if (url === '/api/desktop-sync' && req.method === 'GET') {
          const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
          if (user || ip === '127.0.0.1' || ip === '::1') {
            const qs = new URL(req.url, 'http://localhost').searchParams;
            const byName = qs.get('username') && db.users.find(x => x.username === qs.get('username'));
            const webUser = byId(db.users, verifyToken(lastActiveToken));
            const empUser = db.users.find(x => x.role === 'employee');
            const u = user || byName || webUser || empUser || db.users[0];
            const activeAlerts = (db.alerts || []).filter(a => a.status === 'active' && a.targetId === u.id).map(a => ({
              ...a, targetName: (byId(db.users, a.targetId) || {}).name || '—', createdByName: (byId(db.users, a.userId) || {}).name || '—'
            }));
            res.writeHead(200, headers);
            return res.end(JSON.stringify({ token: makeToken(u.id), user: pub(u), webUser: webUser ? pub(webUser) : null, extraAlerts: activeAlerts }));
          }
        }
        out = api(req, req.method, url, body, user);
        if ((url === '/api/login' || url === '/api/auto-login') && out && out.token) {
          headers['Set-Cookie'] = `sn_tk=${encodeURIComponent(out.token)}; Path=/; Max-Age=31536000; SameSite=Lax`;
        } else if (url === '/api/logout') {
          headers['Set-Cookie'] = 'sn_tk=; Path=/; Max-Age=0; SameSite=Lax';
        }
      } catch (e) {
        status = e instanceof HttpError ? e.code : 500;
        out = { error: e instanceof HttpError ? e.message : 'خطأ في الخادم' };
        if (!(e instanceof HttpError)) console.error(e);
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (url.startsWith('/desktop/')) {
    const dfile = path.normalize(path.join(DESKTOP, url.slice('/desktop/'.length)));
    if (!dfile.startsWith(DESKTOP) || !fs.existsSync(dfile) || fs.statSync(dfile).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(dfile)] || 'application/octet-stream' });
    return fs.createReadStream(dfile).pipe(res);
  }
  const file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(file);
  const hdrs = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (['.html', '.js', '.css'].includes(ext)) hdrs['Cache-Control'] = 'no-cache';
  res.writeHead(200, hdrs);
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log("Sticky Notes running on http://localhost:" + PORT))).catch(e => { console.error("Cannot start (is MySQL running?):", e.message); process.exit(1); });
