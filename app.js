// Shareh Control Room — Firebase-hosted team dashboard.
// Reads SS Tracker's live data (entries, activeTakes) from the same Firebase project,
// and sheet data that the Apps Script sync pushes into `dash_sheets`.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, query, where, setDoc, updateDoc, deleteDoc, addDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { FIREBASE_CONFIG, OWNER_EMAILS, SS_TRACKER_URL } from "./config.js";

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => { }); // stay signed in after refresh or closing the browser
const db = getFirestore(app);

const SHEETS = {
  master: { id: "1djNmrvP5MBj5xRZPx_YE_WFEJ-lJAqd8czfa6_gr5bs", title: "Shareh.Ai Master tracker" },
  timeline: { id: "1y2wxT1tHs8J77owpnsANSl5O93YSPQn1avMSyZVUR28", title: "Timeline" },
  calendar: { id: "1_YySbLa9jAMb5RjAEbzMVr-XB7ii_1T7gcPeLhHJmBE", title: "Main page publishing calendar" },
  deliverables: { id: "15jXeLQuSdpn-lHznMb2HlBF2fRjbHzEKBko_uxsDNiI", title: "SM Deliverables 26/27", linkOnly: true }
};
const ALIAS = { "zeyad": "Ziad", "ziad": "Ziad", "amr anan": "Amr Annan", "amr annan": "Amr Annan", "muhamed": "Muhamed", "mohamed": "Muhamed" };

const S = {
  user: null, email: "", isOwner: false, role: null, myName: null, isLead: false,
  raw: {}, rawAt: {}, projects: [], episodes: [], reshoots: [], timeline: [], publish: { tabs: [], items: [] }, sheetLinks: [],
  links: [], deadlines: [], takes: [], entries: [], roles: [],
  projFilter: "all", lkFilter: "All", calMonth: null,
  prio: "all", statusFilter: "open", kindFilter: "all", flags: {}
};
const unsubs = [];

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const today = () => ymd(new Date());
const parseYmd = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = s => { const d = parseYmd(s); return d ? pad(d.getDate()) + " " + MON[d.getMonth()] : s; };
const normName = n => { n = String(n || "").trim(); if (!n) return ""; const k = n.toLowerCase().replace(/\s+/g, " "); return ALIAS[k] || n.replace(/\b\w/g, c => c.toUpperCase()); };
const AR_DIG = { "٠": 0, "١": 1, "٢": 2, "٣": 3, "٤": 4, "٥": 5, "٦": 6, "٧": 7, "٨": 8, "٩": 9 };
const toLatin = s => String(s).replace(/[٠-٩]/g, c => AR_DIG[c]);
const MONTHS = { jan: 0, january: 0, "يناير": 0, feb: 1, february: 1, "فبراير": 1, mar: 2, march: 2, "مارس": 2, apr: 3, april: 3, "ابريل": 3, "أبريل": 3, may: 4, "مايو": 4, jun: 5, june: 5, "يونيو": 5, jul: 6, july: 6, "يوليو": 6, aug: 7, august: 7, "اغسطس": 7, "أغسطس": 7, sep: 8, sept: 8, september: 8, "سبتمبر": 8, oct: 9, october: 9, "اكتوبر": 9, "أكتوبر": 9, nov: 10, november: 10, "نوفمبر": 10, "نوفمير": 10, dec: 11, december: 11, "ديسمبر": 11 };
function academicYear(month) { const n = new Date(); const start = n.getMonth() >= 7 ? n.getFullYear() : n.getFullYear() - 1; return month >= 7 ? start : start + 1; }
function parseLooseDate(v) {
  const s = toLatin(String(v || "")).toLowerCase();
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s); if (iso) return iso[0];
  const re = /(\d{1,2})\s*([a-z؀-ۿ]+)/g; let m;
  while ((m = re.exec(s))) { const mon = MONTHS[m[2]]; const d = +m[1]; if (mon != null && d >= 1 && d <= 31) return academicYear(mon) + "-" + pad(mon + 1) + "-" + pad(d); }
  return null;
}
function classify(s) {
  s = String(s || "").toLowerCase().trim();
  if (!s || /not assigned|^-+$/.test(s)) return "todo";
  if (/ready to upload|done final|^final$|done render|uploaded|published|اتنشر|sme approved/.test(s)) return "done";
  if (/frame ?io|review|revis|waiting/.test(s)) return "review";
  return "wip";
}
const STATE_LABEL = { done: "Done", review: "In review", wip: "In edit", todo: "Not started" };
const STATE_PILL = { done: "ok", review: "warn", wip: "acc", todo: "" };
const cellStr = v => String(v == null ? "" : v).trim();
const normCode = s => String(s || "").toUpperCase().replace(/\s+/g, "").replace(/VO(\d)/g, "V0$1");
const fmtH = h => (Math.round(h * 10) / 10).toFixed(1) + "h";

/* ---------- sheet parsing (grids come from the Apps Script sync, merges already filled) ---------- */
function parseMaster(tabs) {
  const projects = [], episodes = [], reshoots = [], links = [];
  tabs.forEach(tab => {
    const name = tab.name, rows = tab.rows || [], lk = tab.links || {};
    if (/important links/i.test(name)) {
      rows.forEach((r, i) => { const t = cellStr(r[1]); const u = lk[i + ",1"]; if (t && u) links.push({ title: t, url: u, group: "Scripts & content", src: "Master tracker" }); });
      return;
    }
    let h = -1; for (let i = 0; i < Math.min(rows.length, 6); i++) { if ((rows[i] || []).some(v => /episode code|lesson code|^videos$/i.test(cellStr(v)))) { h = i; break; } }
    if (h < 0) return;
    const head = rows[h].map(cellStr);
    const codeCol = head.findIndex(v => /episode code|lesson code|^videos$/i.test(v));
    if (/re-?shoot/i.test(name)) {
      const tc = head.findIndex(v => /timing/i.test(v)), rc = head.findIndex(v => /reason/i.test(v)); const items = [];
      const has = s => s && !/^_+$/.test(s);
      for (let i = h + 1; i < rows.length; i++) { const r = rows[i] || []; const code = cellStr(r[codeCol]); const t = cellStr(r[tc]), why = cellStr(r[rc]); if (code && (has(t) || has(why))) items.push({ code, note: has(why) ? why : t }); }
      reshoots.push({ tab: name.trim(), count: items.length, items }); return;
    }
    const edCols = [], stCols = [];
    head.forEach((v, i) => { if (/editor name|assigned person/i.test(v)) edCols.push(i); else if (/status|first cut\/|edit r1/i.test(v) && !/sme/i.test(v)) stCols.push(i); });
    if (!stCols.length) return;
    const proj = { name: name.trim(), total: 0, done: 0, review: 0, wip: 0, todo: 0 };
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i] || []; const code = cellStr(r[codeCol]);
      if (!code || /episode code|lesson code|videos/i.test(code)) continue;
      let sc = -1; for (const c of stCols) { if (cellStr(r[c])) sc = c; }
      const stage = sc >= 0 ? cellStr(r[sc]) : "";
      let ed = ""; if (sc >= 0) { for (const c of edCols) { if (c < sc && cellStr(r[c])) ed = cellStr(r[c]); } }
      if (!ed) { for (const c of edCols) { if (cellStr(r[c])) ed = cellStr(r[c]); } }
      const touched = [...new Set(edCols.map(c => normName(cellStr(r[c]))).filter(Boolean))];
      const st = classify(stage);
      const grp = [cellStr(r[0]), codeCol > 1 ? cellStr(r[1]) : ""].filter(x => x && x !== code).join(" · ");
      episodes.push({ code, project: proj.name, group: grp, editor: normName(ed), touched, stage: stage || "—", state: st });
      proj.total++; proj[st]++;
    }
    if (proj.total) projects.push(proj);
  });
  return { projects, episodes, reshoots, links };
}
function parseTimeline(tabs) {
  const out = []; const tab = tabs[0]; if (!tab) return out; const rows = tab.rows || [];
  const head = (rows[0] || []).map(cellStr); const ci = re => head.findIndex(v => re.test(v));
  const cG = ci(/grade/i), cU = ci(/unit/i), cS = ci(/schedule/i), cF = ci(/red flag/i), cD = ci(/تسليم/), cSh = ci(/تصوير/), cP = ci(/المنصة/);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || []; const g = cellStr(r[cG]), u = cellStr(r[cU]);
    if (!/^G\d/i.test(g) || !/^\d+$/.test(u)) continue;
    const dRaw = cellStr(r[cD]), fRaw = cellStr(r[cF]), pRaw = cellStr(r[cP]);
    out.push({ grade: g.toUpperCase(), unit: u, school: cellStr(r[cS]), delivery: parseLooseDate(dRaw), flag: fRaw, flagDate: parseLooseDate(fRaw), shoot: cellStr(r[cSh]), done: /done/i.test(pRaw) || /done/i.test(dRaw) });
  }
  return out;
}
function parseCalendar(tabs) {
  const outTabs = [], items = [];
  tabs.forEach(tab => {
    const rows = tab.rows || [], lk = tab.links || {};
    let h = -1; for (let i = 0; i < Math.min(rows.length, 8); i++) { const r = rows[i] || []; if (r.some(v => /status|الحالة/i.test(cellStr(v))) && r.some(v => /publish date|تاريخ النشر/i.test(cellStr(v)))) { h = i; break; } }
    if (h < 0) return;
    const head = rows[h].map(cellStr); const ci = re => head.findIndex(v => re.test(v));
    const cD = ci(/publish date|تاريخ النشر/i), cS = ci(/status|الحالة/i), cT = [ci(/عنوان|title/i), ci(/topic|الموضوع/i), ci(/لينك المحتوي/), ci(/فكرة|idea/i)].find(x => x >= 0), cL = ci(/^اللينك|^link$/i), cTime = ci(/وقت النشر|time/i);
    const t = { name: tab.name.split(" - ")[0].trim(), planned: 0, ready: 0, published: 0 };
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i] || []; const st = cellStr(r[cS]); if (!st) continue;
      const k = /اتنشر|published/i.test(st) ? "published" : /جاهز|ready/i.test(st) ? "ready" : /مخطط|planned/i.test(st) ? "planned" : null; if (!k) continue;
      t[k]++;
      const title = cT >= 0 ? cellStr(r[cT]).split("\n").map(x => x.trim()).filter(Boolean)[0] || "" : "";
      const url = cL >= 0 ? (lk[i + "," + cL] || (/^https?:/.test(cellStr(r[cL])) ? cellStr(r[cL]) : null)) : null;
      items.push({ tab: t.name, date: parseLooseDate(r[cD]), time: cTime >= 0 ? cellStr(r[cTime]) : "", title: title.slice(0, 90), state: k, url });
    }
    outTabs.push(t);
  });
  return { tabs: outTabs, items };
}
function applySheets() {
  const m = parseMaster((S.raw.master || {}).tabs || []);
  S.projects = m.projects; S.episodes = m.episodes; S.reshoots = m.reshoots; S.sheetLinks = m.links;
  S.timeline = parseTimeline((S.raw.timeline || {}).tabs || []);
  S.publish = parseCalendar((S.raw.calendar || {}).tabs || []);
  $("#projList").innerHTML = S.projects.map(p => "<option>" + esc(p.name) + "</option>").join("");
  renderAll();
}
function setSync() {
  const keys = Object.keys(SHEETS).filter(k => !SHEETS[k].linkOnly);
  const have = keys.filter(k => S.raw[k]);
  const dot = $("#syncDot"), txt = $("#syncText");
  if (!have.length) { dot.className = "dot warn"; txt.textContent = "Waiting for the first sheet sync"; return; }
  // The sync checks every minute but only writes when a sheet changes, so this is "last change", not "last check".
  const newest = Math.max(...have.map(k => S.rawAt[k] || 0));
  const mins = Math.round((Date.now() - newest) / 60000);
  const ago = mins < 1 ? "just now" : mins < 60 ? mins + " min ago" : mins < 1440 ? Math.round(mins / 60) + " h ago" : Math.round(mins / 1440) + " d ago";
  dot.className = "dot " + (have.length < keys.length ? "warn" : "ok");
  txt.textContent = "Live · last sheet change " + ago;
}

/* ---------- SS Tracker data ---------- */
function entryHours(e) { return Number(e.hours) || 0; }
function takeElapsed(t) {
  const start = new Date(t.startedAt).getTime(); if (!start) return "";
  const paused = (t.pauseLog || []).reduce((a, p) => a + (p.durationMs || 0), 0) + (t.pausedAt ? Date.now() - new Date(t.pausedAt).getTime() : 0);
  const m = Math.max(0, Math.floor((Date.now() - start - paused) / 60000));
  return Math.floor(m / 60) + "h " + pad(m % 60) + "m";
}
function loggedByCode() {
  const m = {}; S.entries.forEach(e => { const k = normCode(e.video); m[k] = (m[k] || 0) + entryHours(e); }); return m;
}

/* ---------- priority ----------
   Overdue  = not done and its due date has passed
   High     = overdue, due within 3 days, or flagged by hand (★)
   This week = due within the next 7 days
   Episode due dates come from the Timeline sheet (delivery date of the episode's grade + unit). */
const PRIO_RANK = { overdue: 0, high: 1, week: 2, normal: 3, past: 4, done: 5 };
function unitKey(e) {
  let m = /^G(\d)-U(\d+)/i.exec(e.code);
  if (m) { const g = +m[1]; return "G0" + (g <= 3 ? g + 6 : g) + "|" + (+m[2]); }   // G1–G3 = prep 1–3 = G07–G09
  m = /G[O0]?(\d)\s*·\s*(\d+)/i.exec(e.group || "");
  if (m) return "G0" + (+m[1]) + "|" + (+m[2]);
  return null;
}
function timelineMap() { const m = {}; S.timeline.forEach(t => { m[t.grade + "|" + (+t.unit)] = t; }); return m; }
function episodePrio(e, tl) {
  const flagged = !!S.flags[normCode(e.code)];
  if (e.state === "done") return { level: "done", due: null, n: null, flagged };
  const k = unitKey(e); const t = k ? tl[k] : null;
  const due = t && !t.done ? t.delivery : null;
  const n = due ? daysBetween(today(), due) : null;
  let level = "normal";
  if (n != null && n < 0) level = "overdue";
  else if (flagged || (n != null && n <= 3)) level = "high";
  else if (n != null && n <= 7) level = "week";
  return { level, due, n, flagged };
}
function episodesP() { const tl = timelineMap(); return S.episodes.map(e => ({ ...e, p: episodePrio(e, tl) })); }
function deadlinePrio(d) {
  const n = daysBetween(today(), d.date);
  if (d.done) return { level: "done", n };
  if (d.kind === "flag") return { level: n < 0 ? "past" : n <= 7 ? "high" : "normal", n };
  if (n < 0) return { level: d.kind === "publish" ? "past" : "overdue", n };
  if (d.priority === "high" || n <= 3) return { level: "high", n };
  if (n <= 7) return { level: "week", n };
  return { level: "normal", n };
}
function matchPrio(p) {
  if (S.prio === "all") return true;
  if (S.prio === "overdue") return p.level === "overdue";
  if (S.prio === "high") return p.level === "overdue" || p.level === "high";
  if (S.prio === "week") return p.n != null && p.n >= 0 && p.n <= 7 && p.level !== "done" && p.level !== "past";
  return true;
}
function prioPill(level) {
  const m = { overdue: ["bad", "Overdue"], high: ["warn", "High"], week: ["acc", "This week"] }[level];
  return m ? "<span class=\"pill " + m[0] + "\">" + m[1] + "</span>" : "";
}
const byPrio = (a, b) => (PRIO_RANK[a.p.level] - PRIO_RANK[b.p.level]) || ((a.p.due || "9999") < (b.p.due || "9999") ? -1 : (a.p.due || "9999") > (b.p.due || "9999") ? 1 : 0);
function renderPrioBar() {
  const eps = episodesP(), dls = allDeadlines().map(d => ({ ...d, p: deadlinePrio(d) }));
  const count = k => { const save = S.prio; S.prio = k; const c = eps.filter(e => matchPrio(e.p)).length + dls.filter(d => matchPrio(d.p)).length; S.prio = save; return c; };
  const opts = [["all", "Everything"], ["overdue", "Overdue"], ["high", "High priority"], ["week", "Due this week"]];
  $("#prioBar").innerHTML = "<span class=\"meta\">Show</span>" + opts.map(([k, l]) => "<button type=\"button\" data-prio=\"" + k + "\" aria-pressed=\"" + (S.prio === k) + "\" class=\"" + (k === "overdue" ? "p-bad" : k === "high" ? "p-warn" : "") + "\">" + l + (k === "all" ? "" : " <b>" + count(k) + "</b>") + "</button>").join("");
}

/* ---------- deadlines ---------- */
function allDeadlines() {
  const out = [];
  S.timeline.forEach(t => {
    if (t.delivery) out.push({ date: t.delivery, title: t.grade + " · Unit " + t.unit + " delivery", meta: t.shoot ? "Shoot: " + t.shoot : "School: " + t.school, kind: "delivery", done: t.done, src: "Timeline" });
    if (t.flag && t.flagDate) out.push({ date: t.flagDate, title: t.grade + " · " + t.flag, meta: "Red flag", kind: "flag", done: false, src: "Timeline" });
  });
  S.publish.items.forEach(p => { if (p.date && p.state !== "published") out.push({ date: p.date, title: p.title || p.tab, meta: p.tab + (p.time ? " · " + p.time : "") + " · " + p.state, kind: "publish", done: false, src: "Calendar", url: p.url }); });
  S.deadlines.forEach(d => out.push({ date: d.date, title: d.title, meta: d.project || "Team deadline", kind: "custom", done: !!d.done, id: d.id, src: "Team", priority: d.priority || "normal" }));
  return out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}
function dlItem(d) {
  const p = d.p || deadlinePrio(d), n = p.n;
  const cls = d.done ? "" : n < 0 ? "late" : n <= 3 ? "soon" : "";
  const pill = { delivery: "acc", flag: "bad", publish: "ok", custom: "warn" }[d.kind];
  const rel = d.done ? "done" : n === 0 ? "today" : n < 0 ? (-n) + "d ago" : "in " + n + "d";
  const title = d.url ? "<a href=\"" + esc(d.url) + "\" target=\"_blank\" rel=\"noopener\">" + esc(d.title) + "</a>" : esc(d.title);
  const ctl = d.kind === "custom" ? " <button class=\"link\" data-dl-toggle=\"" + esc(d.id) + "\">" + (d.done ? "Reopen" : "Mark done") + "</button><button class=\"link\" data-dl-prio=\"" + esc(d.id) + "\">" + (d.priority === "high" ? "Unmark high" : "Mark high") + "</button><span><button class=\"link\" data-dl-del=\"" + esc(d.id) + "\">Delete</button></span>" : "";
  return "<li><span class=\"when " + cls + "\">" + fmtDay(d.date) + "</span><span class=\"grow\" dir=\"auto\"><span style=\"" + (d.done ? "text-decoration:line-through;color:var(--muted)" : "") + "\">" + title + "</span> " + prioPill(p.level) + "<div class=\"meta\"><span class=\"pill " + pill + "\">" + esc(d.src) + "</span> " + esc(d.meta) + " · " + rel + ctl + "</div></span></li>";
}

/* ---------- render ---------- */
function bar(name, p, suffix, extra) {
  const t = p.total || 1, w = k => (100 * (p[k] || 0) / t).toFixed(1) + "%";
  return "<div class=\"bar-row\"><span class=\"name\" title=\"" + esc(name) + "\" dir=\"auto\">" + esc(name) + (extra || "") + "</span><span class=\"track\"><i class=\"s-done\" style=\"width:" + w("done") + "\"></i><i class=\"s-review\" style=\"width:" + w("review") + "\"></i><i class=\"s-wip\" style=\"width:" + w("wip") + "\"></i></span><span class=\"num\">" + suffix + "</span></div>";
}
function renderOverview() {
  const tot = S.projects.reduce((a, p) => a + p.total, 0), done = S.projects.reduce((a, p) => a + p.done, 0);
  $("#k-done").textContent = tot ? Math.round(100 * done / tot) + "%" : "—";
  $("#k-done-s").textContent = tot ? done + " of " + tot + " episodes" : "waiting for sheets";
  const t = today();
  const eps = episodesP();
  const dls = allDeadlines().map(d => ({ ...d, p: deadlinePrio(d) }));
  $("#k-due").textContent = dls.filter(d => d.kind !== "publish" && !d.done && d.p.n >= 0 && d.p.n <= 14).length;
  const odE = eps.filter(e => e.p.level === "overdue").length, odD = dls.filter(d => d.p.level === "overdue").length;
  $("#k-late").textContent = odE + odD; $("#k-late-box").classList.toggle("alert", odE + odD > 0);
  $("#k-late-s").textContent = odE + " episodes · " + odD + " deadlines";
  $("#k-now").textContent = S.takes.length;
  $("#k-now-s").textContent = S.takes.length ? S.takes.map(x => x.editor).join(", ") : "no timers running";
  let up = dls.filter(d => d.kind !== "publish" && !d.done);
  up = S.prio === "all" ? up.filter(d => d.p.n >= -7).slice(0, 8) : up.filter(d => matchPrio(d.p)).slice(0, 12);
  $("#ov-deadlines").innerHTML = up.length ? up.map(dlItem).join("") : "<li class=\"empty\">" + (S.prio === "all" ? "Nothing due soon." : "No deadlines match this filter.") + "</li>";
  $("#ov-projects").innerHTML = S.projects.length ? S.projects.map(p => {
    const od = eps.filter(e => e.project === p.name && e.p.level === "overdue").length, hi = eps.filter(e => e.project === p.name && e.p.level === "high").length;
    return bar(p.name, p, p.done + "/" + p.total, (od ? " <span class=\"pill bad\">" + od + " overdue</span>" : "") + (hi ? " <span class=\"pill warn\">" + hi + " high</span>" : ""));
  }).join("") : "<p class=\"empty\">Project progress appears after the first sheet sync.</p>";
  const m = {};
  eps.filter(e => matchPrio(e.p) || (S.prio === "all")).forEach(e => {
    if (e.editor && e.state !== "done") { const x = m[e.editor] = m[e.editor] || { open: 0, done: 0, review: 0, wip: 0, od: 0 }; x.open++; x[e.state === "review" ? "review" : "wip"]++; if (e.p.level === "overdue") x.od++; }
    if (e.state === "done" && S.prio === "all") e.touched.forEach(n => { (m[n] = m[n] || { open: 0, done: 0, review: 0, wip: 0, od: 0 }).done++; });
  });
  const es = Object.entries(m).filter(([, s]) => S.prio === "all" || s.open).sort((a, b) => b[1].od - a[1].od || b[1].open - a[1].open || b[1].done - a[1].done);
  const mx = Math.max(1, ...es.map(e => e[1].open));
  $("#ov-editors").innerHTML = es.length ? es.map(([n, s]) => bar(n, { total: mx, review: s.review, wip: s.wip }, s.open + " · " + s.done, s.od ? " <span class=\"pill bad\">" + s.od + "</span>" : "")).join("") : "<p class=\"empty\">" + (S.episodes.length ? "No episodes match this filter." : "Workload appears after the first sheet sync.") + "</p>";
  $("#ov-now").innerHTML = S.takes.length ? S.takes.map(x => "<li><span class=\"when\">" + esc(takeElapsed(x)) + "</span><span class=\"grow\"><b>" + esc(x.editor) + "</b> <span class=\"code\">" + esc(x.video) + "</span>" + (x.pausedAt ? " <span class=\"pill warn\">paused</span>" : "") + "<div class=\"meta\">" + esc(x.stage || "") + (x.project ? " · " + esc(x.project) : "") + "</div></span></li>").join("") : "<li class=\"empty\">No one has a timer running.</li>";
  const pt = S.publish.tabs;
  $("#ov-publish").innerHTML = pt.length ? "<table><thead><tr><th>Format</th><th style=\"text-align:end\">Planned</th><th style=\"text-align:end\">Ready</th><th style=\"text-align:end\">Published</th><th>Next up</th></tr></thead><tbody>" + pt.map(x => {
    const nx = S.publish.items.filter(i => i.tab === x.name && i.state !== "published" && i.date && i.date >= t).sort((a, b) => a.date < b.date ? -1 : 1)[0];
    return "<tr><td>" + esc(x.name) + "</td><td class=\"n\">" + x.planned + "</td><td class=\"n\">" + x.ready + "</td><td class=\"n\">" + x.published + "</td><td dir=\"auto\">" + (nx ? "<span class=\"code\">" + fmtDay(nx.date) + "</span> " + esc(nx.title) : "<span class=\"meta\">nothing scheduled</span>") + "</td></tr>";
  }).join("") + "</tbody></table>" : "<p class=\"empty\">Publishing counts appear after the first sheet sync.</p>";
}
const STATUS_OPTS = [["open", "Not done"], ["all", "All"], ["todo", "Not started"], ["wip", "In edit"], ["review", "In review"], ["done", "Done"]];
function epRow(e, showProject, logged) {
  const h = logged ? logged[normCode(e.code)] : 0;
  return "<tr><td class=\"code\">" + esc(e.code) + (showProject ? "<div class=\"meta\">" + esc(e.project) + "</div>" : "") + "</td><td dir=\"auto\">" + esc(e.group) + "</td><td>" + esc(e.editor || "—") + "</td><td dir=\"auto\">" + esc(e.stage) + "</td><td><span class=\"pill " + STATE_PILL[e.state] + "\">" + STATE_LABEL[e.state] + "</span></td><td class=\"code\">" + (e.p.due ? fmtDay(e.p.due) : "·") + "</td><td>" + prioPill(e.p.level) + "</td>" + (logged ? "<td class=\"n\">" + (h ? fmtH(h) : "·") + "</td>" : "") + "<td><button class=\"star\" type=\"button\" data-flag=\"" + esc(e.code) + "\" aria-pressed=\"" + e.p.flagged + "\" title=\"" + (e.p.flagged ? "Remove high priority" : "Mark as high priority") + "\">" + (e.p.flagged ? "★" : "☆") + "</button></td></tr>";
}
function renderProjects() {
  const chips = ["all", ...S.projects.map(p => p.name)];
  if (!chips.includes(S.projFilter)) S.projFilter = "all";
  $("#projChips").innerHTML = chips.map(c => "<button type=\"button\" data-proj=\"" + esc(c) + "\" aria-pressed=\"" + (c === S.projFilter) + "\">" + esc(c === "all" ? "All projects" : c) + "</button>").join("");
  $("#statusChips").innerHTML = STATUS_OPTS.map(([k, l]) => "<button type=\"button\" data-status=\"" + k + "\" aria-pressed=\"" + (S.statusFilter === k) + "\">" + l + "</button>").join("");
  const q = $("#projSearch").value.trim().toLowerCase();
  let eps = episodesP().filter(e => (S.projFilter === "all" || e.project === S.projFilter) && matchPrio(e.p));
  if (S.statusFilter === "open") eps = eps.filter(e => e.state !== "done"); else if (S.statusFilter !== "all") eps = eps.filter(e => e.state === S.statusFilter);
  if (q) eps = eps.filter(e => (e.code + " " + e.editor + " " + e.stage + " " + e.group).toLowerCase().includes(q));
  eps.sort(byPrio);
  const logged = S.isLead ? loggedByCode() : null;
  $("#projHead").innerHTML = "<tr><th>Episode</th><th>Group</th><th>Editor</th><th>Stage</th><th>Status</th><th>Due</th><th>Priority</th>" + (logged ? "<th style=\"text-align:end\">Logged</th>" : "") + "<th></th></tr>";
  $("#projTitle").textContent = (S.projFilter === "all" ? "All episodes" : S.projFilter) + " · " + eps.length;
  $("#projTable tbody").innerHTML = eps.length ? eps.slice(0, 800).map(e => epRow(e, S.projFilter === "all", logged)).join("") : "<tr><td colspan=\"9\" class=\"empty\">" + (S.episodes.length ? "No episodes match these filters." : "Episodes appear after the first sheet sync.") + "</td></tr>";
  $("#reshoots").innerHTML = S.reshoots.length ? S.reshoots.map(r => "<details><summary><b>" + esc(r.tab) + "</b> <span class=\"pill " + (r.count ? "bad" : "ok") + "\">" + r.count + " flagged</span></summary><ul class=\"list\">" + r.items.slice(0, 80).map(i => "<li><span class=\"code\" style=\"flex:none\">" + esc(i.code) + "</span><span class=\"grow meta\" dir=\"auto\">" + esc(i.note.slice(0, 160)) + "</span></li>").join("") + "</ul></details>").join("") : "<p class=\"empty\">Re-shoot tabs appear after the first sheet sync.</p>";
  const es = {}; episodesP().filter(e => (S.projFilter === "all" || e.project === S.projFilter) && e.state !== "done" && e.editor && matchPrio(e.p)).forEach(e => { const x = es[e.editor] = es[e.editor] || { total: 0, review: 0, wip: 0, od: 0 }; x.total++; x[e.state === "review" ? "review" : "wip"]++; if (e.p.level === "overdue") x.od++; });
  const arr = Object.entries(es).sort((a, b) => b[1].od - a[1].od || b[1].total - a[1].total); const mx = Math.max(1, ...arr.map(a => a[1].total));
  $("#proj-editors").innerHTML = arr.length ? arr.map(([n, s]) => bar(n, { total: mx, review: s.review, wip: s.wip }, String(s.total), s.od ? " <span class=\"pill bad\">" + s.od + "</span>" : "")).join("") : "<p class=\"empty\">No open episodes match.</p>";
}
const KIND_OPTS = [["all", "All types"], ["delivery", "Deliveries"], ["flag", "Red flags"], ["publish", "Publishing"], ["custom", "Team deadlines"]];
function renderDeadlines() {
  if (!S.calMonth) { const d = new Date(); S.calMonth = new Date(d.getFullYear(), d.getMonth(), 1); }
  $("#kindChips").innerHTML = KIND_OPTS.map(([k, l]) => "<button type=\"button\" data-kind=\"" + k + "\" aria-pressed=\"" + (S.kindFilter === k) + "\">" + l + "</button>").join("");
  const m = S.calMonth;
  $("#calLabel").textContent = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m.getMonth()] + " " + m.getFullYear();
  const dls = allDeadlines().map(d => ({ ...d, p: deadlinePrio(d) })).filter(d => (S.kindFilter === "all" || d.kind === S.kindFilter) && matchPrio(d.p));
  const byDay = {}; dls.forEach(d => { (byDay[d.date] = byDay[d.date] || []).push(d); });
  const start = new Date(m); start.setDate(1 - ((m.getDay() + 1) % 7)); // weeks start Saturday
  let h = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"].map(d => "<div class=\"dow\">" + d + "</div>").join("");
  const t = today();
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i); const k = ymd(d); const ev = byDay[k] || [];
    if (i === 35 && d.getMonth() !== m.getMonth()) break;
    h += "<div class=\"day" + (d.getMonth() !== m.getMonth() ? " out" : "") + (k === t ? " today" : "") + "\"><span class=\"dn\">" + d.getDate() + "</span>" + ev.slice(0, 4).map(e => "<span class=\"ev k-" + e.kind + (e.p.level === "overdue" ? " is-late" : "") + "\" title=\"" + esc(e.title + " — " + e.meta) + "\" dir=\"auto\">" + esc(e.title) + "</span>").join("") + (ev.length > 4 ? "<span class=\"meta\">+" + (ev.length - 4) + " more</span>" : "") + "</div>";
  }
  $("#cal").innerHTML = h;
  let up = dls.filter(d => !d.done);
  up = S.prio === "all" ? up.filter(d => d.p.n >= -14) : up;
  up.sort((a, b) => (PRIO_RANK[a.p.level] - PRIO_RANK[b.p.level]) || (a.date < b.date ? -1 : 1));
  $("#dl-list").innerHTML = up.length ? up.slice(0, 60).map(dlItem).join("") : "<li class=\"empty\">No deadlines match these filters.</li>";
}
function renderLinks() {
  const builtIn = [
    ...Object.values(SHEETS).map(s => ({ title: s.title, url: "https://docs.google.com/spreadsheets/d/" + s.id + "/edit", group: "Sheets", src: "Built in" })),
    { title: "SS Tracker", url: SS_TRACKER_URL, group: "Tools", src: "Built in" }
  ];
  const all = [...builtIn, ...S.sheetLinks, ...S.links.map(l => ({ ...l, src: "Team" }))];
  const groups = ["All", ...new Set(all.map(l => l.group || "Other"))];
  if (!groups.includes(S.lkFilter)) S.lkFilter = "All";
  $("#lkChips").innerHTML = groups.map(g => "<button type=\"button\" data-lk=\"" + esc(g) + "\" aria-pressed=\"" + (g === S.lkFilter) + "\">" + esc(g) + "</button>").join("");
  const q = ($("#lkSearch").value || "").trim().toLowerCase();
  const show = all.filter(l => (S.lkFilter === "All" || (l.group || "Other") === S.lkFilter) && (!q || (l.title + " " + l.url + " " + (l.group || "")).toLowerCase().includes(q)));
  $("#links").innerHTML = show.map(l => {
    let host = ""; try { host = new URL(l.url).hostname.replace(/^www\./, ""); } catch (e) { }
    return "<div class=\"lk\"><a href=\"" + esc(l.url) + "\" target=\"_blank\" rel=\"noopener\" dir=\"auto\">" + esc(l.title) + "</a><div class=\"meta\"><span>" + esc(host) + " · " + esc(l.group || "Other") + "</span>" + (l.id ? "<span><button class=\"link\" data-lk-del=\"" + esc(l.id) + "\">Remove</button></span>" : "<span>" + esc(l.src) + "</span>") + "</div></div>";
  }).join("") || "<p class=\"empty\">No links match.</p>";
}
function last7() { const days = []; for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(ymd(d)); } return days; }
function renderMyWork() {
  $("#noNamePanel").hidden = !!S.myName;
  $("#meName").textContent = S.myName || "";
  const mine = S.entries.filter(e => S.myName && e.editor === S.myName);
  const days = last7();
  const hrs = days.map(k => mine.filter(e => e.date === k).reduce((a, e) => a + entryHours(e), 0));
  const mx = Math.max(1, ...hrs);
  $("#myWeek").innerHTML = days.map((k, i) => bar(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parseYmd(k).getDay()] + " " + fmtDay(k), { total: mx, wip: hrs[i] }, fmtH(hrs[i]))).join("");
  const take = S.takes.find(x => x.editor === S.myName);
  $("#myTimer").innerHTML = take ? "<div class=\"timer\"><span class=\"clock\">" + esc(takeElapsed(take)) + "</span><span class=\"grow\"><b class=\"code\">" + esc(take.video) + "</b><div class=\"meta\">" + esc(take.stage || "") + (take.pausedAt ? " · paused" : "") + "</div></span></div>" : "<p class=\"empty\">No timer running. Start one in <a href=\"" + esc(SS_TRACKER_URL) + "\" target=\"_blank\" rel=\"noopener\">SS Tracker</a>.</p>";
  const myEps = S.myName ? episodesP().filter(e => e.editor === normName(S.myName) && e.state !== "done" && matchPrio(e.p)).sort(byPrio) : [];
  $("#myEps").innerHTML = myEps.length ? "<table><thead><tr><th>Episode</th><th>Group</th><th>Editor</th><th>Stage</th><th>Status</th><th>Due</th><th>Priority</th><th></th></tr></thead><tbody>" + myEps.map(e => epRow(e, true, null)).join("") + "</tbody></table>" : "<p class=\"empty\">" + (S.myName ? "No open episodes match this filter." : "") + "</p>";
  const cutoff = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return ymd(d); })();
  const rows = mine.filter(e => (e.date || "") >= cutoff).sort((a, b) => (b.loggedAt || "").localeCompare(a.loggedAt || ""));
  $("#myHist").innerHTML = entriesTable(rows, false);
}
function entriesTable(rows, withEditor) {
  if (!rows.length) return "<p class=\"empty\">No entries yet.</p>";
  return "<table><thead><tr><th>Day</th>" + (withEditor ? "<th>Editor</th>" : "") + "<th>Episode</th><th>Project</th><th>Stage</th><th style=\"text-align:end\">Hours</th><th>Notes</th></tr></thead><tbody>" + rows.slice(0, 300).map(r => "<tr><td class=\"code\">" + fmtDay(r.date) + "</td>" + (withEditor ? "<td>" + esc(r.editor) + "</td>" : "") + "<td class=\"code\">" + esc(r.video) + "</td><td>" + esc(r.project || "") + "</td><td>" + esc(r.stage || "") + "</td><td class=\"n\">" + fmtH(entryHours(r)) + "</td><td dir=\"auto\">" + esc(r.notes || "") + "</td></tr>").join("") + "</tbody></table>";
}
function renderTeam() {
  if (!S.isLead) return;
  const days = last7();
  const eps = episodesP();
  const names = [...new Set([...S.entries.map(e => e.editor), ...S.roles.filter(r => r.name).map(r => r.name)])].filter(Boolean).sort();
  const rows = names.map(n => {
    const mineEps = eps.filter(e => e.editor === normName(n) && e.state !== "done");
    return { n, open: mineEps.length, od: mineEps.filter(e => e.p.level === "overdue").length, hi: mineEps.filter(e => e.p.level === "high").length, wk: mineEps.filter(e => matchPrio(e.p)).length };
  }).filter(r => S.prio === "all" || r.wk > 0);
  $("#teamTable").innerHTML = rows.length ? "<table><thead><tr><th>Editor</th>" + days.map(k => "<th style=\"text-align:end\">" + fmtDay(k) + "</th>").join("") + "<th style=\"text-align:end\">Week</th><th style=\"text-align:end\">Open eps</th><th style=\"text-align:end\">Overdue</th><th style=\"text-align:end\">High</th></tr></thead><tbody>" + rows.map(r => {
    let wk = 0; const cells = days.map(k => { const h = S.entries.filter(e => e.editor === r.n && e.date === k).reduce((a, e) => a + entryHours(e), 0); wk += h; return "<td class=\"n\">" + (h ? fmtH(h) : "·") + "</td>"; }).join("");
    return "<tr><td>" + esc(r.n) + (S.takes.some(x => x.editor === r.n) ? " <span class=\"pill ok\">live</span>" : "") + "</td>" + cells + "<td class=\"n\"><b>" + fmtH(wk) + "</b></td><td class=\"n\">" + r.open + "</td><td class=\"n\">" + (r.od ? "<span class=\"pill bad\">" + r.od + "</span>" : "·") + "</td><td class=\"n\">" + (r.hi ? "<span class=\"pill warn\">" + r.hi + "</span>" : "·") + "</td></tr>";
  }).join("") + "</tbody></table>" : "<p class=\"empty\">" + (names.length ? "No editors have episodes matching this filter." : "No SS Tracker entries yet.") + "</p>";
  const pick = $("#teamPick"), cur = pick.value;
  pick.innerHTML = "<option value=\"\">Everyone</option>" + names.map(n => "<option>" + esc(n) + "</option>").join("");
  if (names.includes(cur)) pick.value = cur;
  const sel = pick.value;
  const ents = S.entries.filter(e => !sel || e.editor === sel).sort((a, b) => (b.loggedAt || "").localeCompare(a.loggedAt || ""));
  $("#teamEntries").innerHTML = entriesTable(ents, !sel);
  $("#rosterList").innerHTML = names.map(n => "<option>" + esc(n) + "</option>").join("");
  $("#roleTable").innerHTML = S.roles.length ? "<table><thead><tr><th>Email</th><th>Name</th><th>Access</th><th></th></tr></thead><tbody>" + S.roles.map(r => "<tr><td>" + esc(r.id) + "</td><td>" + esc(r.name || "") + "</td><td><span class=\"pill " + (r.role === "lead" ? "acc" : "") + "\">" + (r.role === "lead" ? "Lead" : "Editor") + "</span></td><td><span><button class=\"link\" data-role-del=\"" + esc(r.id) + "\">Remove</button></span></td></tr>").join("") + "</tbody></table>" : "<p class=\"empty\">Only you can open the dashboard right now. Add your team above.</p>";
}
function renderAll() { renderPrioBar(); renderSearch(); renderOverview(); renderProjects(); renderDeadlines(); renderLinks(); renderMyWork(); renderTeam(); setSync(); }

/* ---------- global search: "who is on it and what's its status" ---------- */
const compact = s => String(s || "").toUpperCase().replace(/VO(\d)/g, "V0$1").replace(/[^A-Z0-9؀-ۿ]/g, "");
function parseUnitQuery(q) {
  const m = /G(?:RADE)?\s*([O0])?(\d)\s*[-_ ]*\s*U(?:NIT)?\s*[-_ ]*(\d+)/i.exec(q);
  if (!m) return null;
  const g = +m[2];
  // "G05 U3" / "G5 U3" = grade 5; "G2-U1" (episode-code style, 1–3) = prep 2 = G08
  return { grade: "G0" + (m[1] || g > 3 ? g : g + 6), unit: +m[3] };
}
function renderSearch() {
  const qRaw = $("#globalSearch").value.trim();
  const box = $("#searchResults");
  if (!qRaw) { box.innerHTML = ""; return; }
  const q = qRaw.toLowerCase(), qc = compact(qRaw);
  const eps = episodesP();
  const logged = loggedByCode();
  const unitQ = parseUnitQuery(qRaw);
  const wholeUnit = unitQ && !/[-_ ]?[LV]\s*O?\d/i.test(qRaw.replace(/^.*?U(?:NIT)?\s*[-_ ]*\d+/i, ""));
  const tl = timelineMap();
  let html = "";

  // Unit summary (e.g. "G05 U3", "grade 5 unit 3", "G2-U1")
  if (unitQ) {
    const key = unitQ.grade + "|" + unitQ.unit;
    const t = tl[key];
    const unitEps = eps.filter(e => unitKey(e) === key);
    const c = s => unitEps.filter(e => e.state === s).length;
    html += "<div class=\"panel span12\"><h2>" + esc(unitQ.grade + " · Unit " + unitQ.unit) + " <span class=\"aside\">" + unitEps.length + " episodes</span></h2>" +
      "<div class=\"facts\">" +
      fact("Delivery", t ? (t.done ? "<span class=\"pill ok\">Delivered</span>" : (t.delivery ? fmtDay(t.delivery) : "not set")) : "not in Timeline") +
      fact("In school", t ? esc(t.school || "—") : "—") +
      fact("Shooting", t ? esc(t.shoot || "—") : "—") +
      fact("Red flag", t && t.flag ? "<span dir=\"auto\">" + esc(t.flag) + "</span>" : "—") +
      fact("Progress", c("done") + " done · " + c("review") + " in review · " + c("wip") + " in edit · " + c("todo") + " not started") +
      "</div></div>";
  }

  // Episodes
  const words = q.split(/\s+/).filter(Boolean);
  let hits = eps.filter(e => {
    if (wholeUnit && unitKey(e) === unitQ.grade + "|" + unitQ.unit) return true;
    if (qc.length >= 2 && compact(e.code).includes(qc)) return true;
    const hay = (e.code + " " + e.project + " " + e.group + " " + e.editor + " " + e.touched.join(" ") + " " + e.stage).toLowerCase();
    return words.every(w => hay.includes(w));
  }).sort(byPrio);
  if (hits.length === 1 || (hits.length > 1 && hits.filter(e => compact(e.code) === qc).length === 1)) {
    const e = hits.length === 1 ? hits[0] : hits.find(x => compact(x.code) === qc);
    html += episodeCard(e, logged);
  }
  html += "<div class=\"panel span12\"><h2>Episodes <span class=\"aside\">" + hits.length + " found</span></h2>" + (hits.length ?
    "<div class=\"tscroll\"><table><thead><tr><th>Episode</th><th>Group</th><th>Editor</th><th>Stage</th><th>Status</th><th>Due</th><th>Priority</th>" + (S.isLead ? "<th style=\"text-align:end\">Logged</th>" : "") + "<th></th></tr></thead><tbody>" +
    hits.slice(0, 200).map(e => epRow(e, true, S.isLead ? logged : null).replace("</td>", liveTag(e.code) + "</td>")).join("") + "</tbody></table></div>"
    : "<p class=\"empty\">No episodes match. Try a code like G2-U1-L03, a unit like G05 U3, or an editor's name.</p>") + "</div>";

  // SS Tracker entries for codes not in the sheets (or extra detail)
  const ent = S.entries.filter(x => compact(x.video).includes(qc) || (x.editor || "").toLowerCase() === q).slice(0, 50);
  if (ent.length && hits.length !== 1) html += "<div class=\"panel span12\"><h2>SS Tracker entries <span class=\"aside\">" + ent.length + (ent.length === 50 ? "+" : "") + "</span></h2><div class=\"tscroll\">" + entriesTable(ent.sort((a, b) => (b.loggedAt || "").localeCompare(a.loggedAt || "")), true) + "</div></div>";

  // Deadlines, publishing and links
  const dls = allDeadlines().filter(d => (d.title + " " + d.meta).toLowerCase().includes(q) || (unitQ && d.title.startsWith(unitQ.grade + " · Unit " + unitQ.unit + " ")));
  if (dls.length) html += "<div class=\"panel span6\"><h2>Deadlines &amp; publishing</h2><ul class=\"list\">" + dls.slice(0, 15).map(dlItem).join("") + "</ul></div>";
  const lks = [...S.sheetLinks, ...S.links].filter(l => (l.title + " " + (l.group || "")).toLowerCase().includes(q));
  if (lks.length) html += "<div class=\"panel span6\"><h2>Links</h2><ul class=\"list\">" + lks.slice(0, 15).map(l => "<li><span class=\"grow\"><a href=\"" + esc(l.url) + "\" target=\"_blank\" rel=\"noopener\" dir=\"auto\">" + esc(l.title) + "</a><div class=\"meta\">" + esc(l.group || "") + "</div></span></li>").join("") + "</ul></div>";
  box.innerHTML = html;
}
function fact(label, valueHtml) { return "<div class=\"fact\"><span class=\"lab\">" + esc(label) + "</span><span>" + valueHtml + "</span></div>"; }
function liveTag(code) { const t = S.takes.find(x => compact(x.video) === compact(code)); return t ? " <span class=\"pill ok\">" + esc(t.editor) + " editing now</span>" : ""; }
function episodeCard(e, logged) {
  const t = S.takes.find(x => compact(x.video) === compact(e.code));
  const ent = S.entries.filter(x => compact(x.video) === compact(e.code));
  const byEd = {}; ent.forEach(x => { const k = x.editor + "|" + (x.stage || ""); byEd[k] = (byEd[k] || 0) + entryHours(x); });
  const rs = []; S.reshoots.forEach(r => r.items.forEach(i => { if (compact(i.code) === compact(e.code)) rs.push(r.tab + ": " + i.note); }));
  const pub = S.publish.items.filter(p => compact(p.title).includes(compact(e.code)));
  return "<div class=\"panel span12 hit\"><h2><span class=\"code\">" + esc(e.code) + "</span> " + prioPill(e.p.level) + " <span class=\"aside\">" + esc(e.project) + "</span></h2><div class=\"facts\">" +
    fact("Status", "<span class=\"pill " + STATE_PILL[e.state] + "\">" + STATE_LABEL[e.state] + "</span> <span dir=\"auto\">" + esc(e.stage) + "</span>") +
    fact("Who's on it", esc(e.editor || "Nobody assigned") + (t ? " <span class=\"pill ok\">" + esc(t.editor) + " editing now · " + esc(takeElapsed(t)) + "</span>" : "")) +
    fact("Worked on by", esc(e.touched.join(", ") || "—")) +
    fact("Unit", "<span dir=\"auto\">" + esc(e.group || "—") + "</span>") +
    fact("Due", e.p.due ? fmtDay(e.p.due) + (e.p.n != null ? " (" + (e.p.n < 0 ? (-e.p.n) + " days late" : "in " + e.p.n + " days") + ")" : "") : (e.state === "done" ? "—" : "no date in Timeline")) +
    (S.isLead ? fact("Hours logged", Object.keys(byEd).length ? Object.entries(byEd).map(([k, h]) => esc(k.replace("|", " · ")) + ": " + fmtH(h)).join("<br>") : "none in SS Tracker") : "") +
    (rs.length ? fact("Re-shoot notes", rs.map(x => "<span dir=\"auto\">" + esc(x) + "</span>").join("<br>")) : "") +
    (pub.length ? fact("Publishing", pub.map(p => esc(p.tab) + " · " + (p.date ? fmtDay(p.date) : "no date") + " · " + esc(p.state)).join("<br>")) : "") +
    "</div></div>";
}
/* ---------- UI events ---------- */
function showTab(v) { document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.v === v))); document.querySelectorAll("section.view").forEach(s => s.classList.toggle("on", s.id === "v-" + v)); try { localStorage.setItem("scr-tab", v); } catch (e) { } }
$("#tabs").addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (b) { $("#globalSearch").value = ""; renderSearch(); showTab(b.dataset.v); } });
$("#projChips").addEventListener("click", e => { const b = e.target.closest("[data-proj]"); if (b) { S.projFilter = b.dataset.proj; renderProjects(); } });
$("#projSearch").addEventListener("input", renderProjects);
$("#prioBar").addEventListener("click", e => { const b = e.target.closest("[data-prio]"); if (b) { S.prio = b.dataset.prio; renderAll(); } });
$("#statusChips").addEventListener("click", e => { const b = e.target.closest("[data-status]"); if (b) { S.statusFilter = b.dataset.status; renderProjects(); } });
$("#kindChips").addEventListener("click", e => { const b = e.target.closest("[data-kind]"); if (b) { S.kindFilter = b.dataset.kind; renderDeadlines(); } });
$("#lkSearch").addEventListener("input", renderLinks);
$("#k-late-box").addEventListener("click", () => { S.prio = "overdue"; renderAll(); });
let lastTab = "overview";
$("#globalSearch").addEventListener("input", () => {
  const on = !!$("#globalSearch").value.trim();
  const cur = document.querySelector("section.view.on"); if (on && cur && cur.id !== "v-search") lastTab = cur.id.slice(2);
  document.querySelectorAll("section.view").forEach(s => s.classList.toggle("on", on ? s.id === "v-search" : s.id === "v-" + lastTab));
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-selected", String(!on && b.dataset.v === lastTab)));
  renderSearch();
});
document.addEventListener("keydown", e => { if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") { e.preventDefault(); $("#globalSearch").focus(); } if (e.key === "Escape" && document.activeElement.id === "globalSearch") { $("#globalSearch").value = ""; $("#globalSearch").dispatchEvent(new Event("input")); } });

$("#lkChips").addEventListener("click", e => { const b = e.target.closest("[data-lk]"); if (b) { S.lkFilter = b.dataset.lk; renderLinks(); } });
$("#calPrev").addEventListener("click", () => { S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() - 1, 1); renderDeadlines(); });
$("#calNext").addEventListener("click", () => { S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + 1, 1); renderDeadlines(); });
$("#teamPick").addEventListener("change", renderTeam);
setInterval(() => { renderOverview(); renderMyWork(); setSync(); }, 30000);

function confirmIn(wrap, label, onYes) {
  const orig = wrap.innerHTML;
  wrap.innerHTML = "<span class=\"confirm\">" + esc(label) + " <button class=\"link\" data-yes style=\"color:var(--bad)\">Yes</button><button class=\"link\" data-no>No</button></span>";
  wrap.querySelector("[data-yes]").onclick = onYes; wrap.querySelector("[data-no]").onclick = () => { wrap.innerHTML = orig; };
}
document.addEventListener("click", async e => {
  const t = e.target;
  if (t.dataset.dlToggle) { const d = S.deadlines.find(x => x.id === t.dataset.dlToggle); if (d) updateDoc(doc(db, "dash_deadlines", d.id), { done: !d.done }).catch(() => { }); }
  if (t.dataset.flag) { const k = normCode(t.dataset.flag); const on = !!S.flags[k]; (on ? deleteDoc(doc(db, "dash_flags", k)) : setDoc(doc(db, "dash_flags", k), { code: t.dataset.flag, by: S.email, at: Date.now() })).catch(() => { }); }
  if (t.dataset.dlPrio) { const d = S.deadlines.find(x => x.id === t.dataset.dlPrio); if (d) updateDoc(doc(db, "dash_deadlines", d.id), { priority: d.priority === "high" ? "normal" : "high" }).catch(() => { }); }
  if (t.dataset.dlDel) { const id = t.dataset.dlDel; confirmIn(t.parentElement, "Delete?", () => deleteDoc(doc(db, "dash_deadlines", id)).catch(() => { })); }
  if (t.dataset.lkDel) { const id = t.dataset.lkDel; confirmIn(t.parentElement, "Remove?", () => deleteDoc(doc(db, "dash_links", id)).catch(() => { })); }
  if (t.dataset.roleDel) { const id = t.dataset.roleDel; confirmIn(t.parentElement, "Remove access?", () => deleteDoc(doc(db, "dash_roles", id)).catch(() => { })); }
});
$("#dlForm").addEventListener("submit", async e => {
  e.preventDefault();
  const data = { title: $("#dlTitle").value.trim(), date: $("#dlDate").value, project: $("#dlProject").value.trim(), priority: $("#dlPrio").value, done: false, by: S.email, at: Date.now() };
  if (!data.title || !data.date) return;
  try { await addDoc(collection(db, "dash_deadlines"), data); e.target.reset(); $("#dlMsg").textContent = "Added."; }
  catch (err) { $("#dlMsg").textContent = "Couldn't add it. Check your connection and try again."; }
});
$("#lkForm").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("#lkUrl").value.trim(); if (!/^https?:\/\//i.test(url)) return;
  try { await addDoc(collection(db, "dash_links"), { title: $("#lkTitle").value.trim(), url, group: $("#lkGroup").value.trim() || "Other", by: S.email, at: Date.now() }); e.target.reset(); } catch (err) { }
});
$("#roleForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#roleEmail").value.trim().toLowerCase();
  try { await setDoc(doc(db, "dash_roles", email), { name: $("#roleName").value.trim(), role: $("#roleRole").value, by: S.email, at: Date.now() }); e.target.reset(); $("#roleMsg").textContent = "Saved. " + email + " can sign in now."; }
  catch (err) { $("#roleMsg").textContent = "Couldn't save. Only leads can change access."; }
});

/* ---------- auth & live subscriptions ---------- */
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
$("#signInBtn").addEventListener("click", () => signInWithPopup(auth, provider).catch(err => { $("#gateMsg").textContent = "Sign-in didn't finish (" + (err.code || "error") + "). Try again."; }));
$("#gateOut").addEventListener("click", () => signOut(auth));
$("#signOutBtn").addEventListener("click", () => signOut(auth));

function stopAll() { unsubs.splice(0).forEach(u => { try { u(); } catch (e) { } }); }
function live(ref, fn) { unsubs.push(onSnapshot(ref, fn, err => console.warn("listener", err.code))); }

onAuthStateChanged(auth, async user => {
  stopAll();
  $("#loading").hidden = true;
  S.user = user;
  if (!user) { $("#app").hidden = true; $("#gate").hidden = false; $("#signInBtn").hidden = false; $("#gateOut").hidden = true; $("#gateMsg").textContent = "Sign in with your Google account to open the team dashboard."; return; }
  S.email = (user.email || "").toLowerCase();
  S.isOwner = OWNER_EMAILS.map(e => e.toLowerCase()).includes(S.email);
  let roleDoc = null;
  try { const snap = await getDoc(doc(db, "dash_roles", S.email)); roleDoc = snap.exists() ? snap.data() : null; } catch (e) { roleDoc = null; }
  if (!S.isOwner && !roleDoc) {
    $("#gateMsg").innerHTML = "<b>" + esc(S.email) + "</b> doesn't have access yet. Ask Gold to add you in the dashboard's Team tab.";
    $("#signInBtn").hidden = true; $("#gateOut").hidden = false; return;
  }
  S.role = S.isOwner ? "lead" : roleDoc.role;
  S.isLead = S.role === "lead";
  S.myName = roleDoc && roleDoc.name ? roleDoc.name : (S.isOwner ? null : null);
  $("#whoText").textContent = (S.myName || user.displayName || S.email) + (S.isLead ? " · lead" : "");
  $("#teamTab").hidden = !S.isLead;
  $("#gate").hidden = true; $("#app").hidden = false;
  try { const t = localStorage.getItem("scr-tab"); if (t && document.getElementById("v-" + t) && (t !== "team" || S.isLead)) showTab(t); } catch (e) { }

  Object.keys(SHEETS).filter(k => !SHEETS[k].linkOnly).forEach(k => live(doc(db, "dash_sheets", k), snap => {
    if (!snap.exists()) return;
    try { const d = snap.data(); S.raw[k] = JSON.parse(d.payload); S.rawAt[k] = d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : Date.now(); applySheets(); } catch (e) { console.warn("sheet parse", k, e); }
  }));
  live(collection(db, "dash_deadlines"), s => { S.deadlines = s.docs.map(d => ({ id: d.id, ...d.data() })); renderOverview(); renderDeadlines(); });
  live(collection(db, "dash_flags"), s => { const f = {}; s.docs.forEach(d => { f[d.id] = true; }); S.flags = f; renderAll(); });
  live(collection(db, "dash_links"), s => { S.links = s.docs.map(d => ({ id: d.id, ...d.data() })); renderLinks(); });
  live(collection(db, "activeTakes"), s => { S.takes = s.docs.map(d => ({ editor: d.id, ...d.data() })).filter(x => x.video); renderOverview(); renderMyWork(); renderTeam(); renderSearch(); });
  if (S.isLead) {
    live(collection(db, "entries"), s => { S.entries = s.docs.map(d => d.data()); renderMyWork(); renderTeam(); renderProjects(); });
    live(collection(db, "dash_roles"), s => { S.roles = s.docs.map(d => ({ id: d.id, ...d.data() })); renderTeam(); });
  } else if (S.myName) {
    live(query(collection(db, "entries"), where("editor", "==", S.myName)), s => { S.entries = s.docs.map(d => d.data()); renderMyWork(); });
  }
  renderAll();
});
