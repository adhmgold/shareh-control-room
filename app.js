// Shareh Control Room — Firebase-hosted team dashboard.
// Reads SS Tracker's live data (entries, activeTakes) from the same Firebase project,
// and sheet data that the Apps Script sync pushes into `dash_sheets`.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, query, where, setDoc, updateDoc, deleteDoc, addDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import * as CFG from "./config.js";
const { FIREBASE_CONFIG, SS_TRACKER_URL } = CFG;
// Works with both the old (OWNER_EMAIL) and new (OWNER_EMAILS) config.js; both owners are always included.
const OWNER_EMAILS = [...new Set([...(CFG.OWNER_EMAILS || []), ...(CFG.OWNER_EMAIL ? [CFG.OWNER_EMAIL] : []), "adham.youssry@sciencestreets.com", "adhmgold@gmail.com"])];

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
  prio: "all", statusFilter: "open", kindFilter: "all", flags: {},
  kpiSettings: null, kpiMonth: null, kpiOpen: null, kpiMine: {}, plans: [], pauseReviews: {}, prFilter: { status: "pending", editor: "" }
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
function renderAll() { renderPrioBar(); renderSearch(); renderOverview(); renderProjects(); renderDeadlines(); renderLinks(); renderMyWork(); renderTeam(); renderKpi(); renderPauseReview(); renderPlans(); setSync(); }

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
/* ---------- KPI (monthly, per editor, from SS Tracker takes) ----------
   Output 35%      distinct video+stage passes this month vs the team median (median = 70 pts)
   Speed 25%       hours per video for each stage vs the team median for that stage (equal = 70 pts, capped at 100)
   Focus 20%       share of time paused (excused reasons don't count) and pauses per take
   Consistency 20% active days out of working days, and hours per active day vs target
   Weights, target hours, working days and excused pause keywords are editable by leads (dash_settings/kpi). */
const KPI_DEFAULTS = {
  weights: { output: 35, speed: 25, focus: 20, consistency: 20 },
  targetHours: 6, workdays: [6, 0, 1, 2, 3, 4], minTakes: 3,
  excused: "render, rendering, export, exporting, upload, رندر, ريندر, تصدير, اكسبورت, review, feedback, waiting, wait, مراجعة, مراجعه, فيدباك, كومنت, استنى, انتظار, meeting, meet, call, ميتنج, اجتماع, pray, prayer, salah, صلاة, صلاه, الصلاة, الصلاه"
};
const PART_LABEL = { output: "Output", speed: "Speed", focus: "Focus", consistency: "Consistency" };
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const monthOf = d => String(d || "").slice(0, 7);
const curMonth = () => today().slice(0, 7);
function monthLabel(m) { const [y, mo] = m.split("-").map(Number); return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][mo - 1] + " " + y; }
function prevMonth(m) { const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 2, 1); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
function kpiCfg() { const s = S.kpiSettings || {}; return { ...KPI_DEFAULTS, ...s, weights: { ...KPI_DEFAULTS.weights, ...(s.weights || {}) } }; }
function workdaysIn(month) {
  const cfg = kpiCfg(); const [y, mo] = month.split("-").map(Number); const t = today(); let n = 0;
  for (let d = new Date(y, mo - 1, 1); d.getMonth() === mo - 1; d.setDate(d.getDate() + 1)) { const k = ymd(d); if (k > t) break; if (cfg.workdays.includes(d.getDay())) n++; }
  return Math.max(1, n);
}
function excusedWords() { return kpiCfg().excused.split(",").map(w => w.trim().toLowerCase()).filter(Boolean); }
function isExcused(reason, words) { const r = String(reason || "").toLowerCase(); return !!r && words.some(w => r.includes(w)); }
function computeKpi(month, entries) {
  const cfg = kpiCfg(), words = excusedWords();
  const ms = entries.filter(e => e.editor && monthOf(e.date) === month);
  const pairs = {};
  ms.forEach(e => { const k = e.editor + "|" + compact(e.video) + "|" + (e.stage || "—"); pairs[k] = (pairs[k] || 0) + entryHours(e); });
  const byStage = {};
  Object.entries(pairs).forEach(([k, h]) => { const st = k.split("|")[2]; if (h >= 0.25) (byStage[st] = byStage[st] || []).push(h); });
  const bench = {}; Object.keys(byStage).forEach(st => { bench[st] = median(byStage[st]); });
  const wd = workdaysIn(month);
  const groups = {}; ms.forEach(e => { (groups[e.editor] = groups[e.editor] || []).push(e); });
  const rows = Object.entries(groups).map(([name, list]) => {
    const myPairs = Object.entries(pairs).filter(([k]) => k.split("|")[0] === name).map(([k, h]) => ({ video: k.split("|")[1], stage: k.split("|")[2], h }));
    const videos = new Set(myPairs.map(p => p.video)).size;
    const hours = list.reduce((a, e) => a + entryHours(e), 0);
    const ratios = myPairs.filter(p => p.h >= 0.25 && bench[p.stage]).map(p => bench[p.stage] / p.h);
    let cP = 0, eP = 0, cMin = 0, eMin = 0; const reasons = {};
    list.forEach(e => {
      const ps = Array.isArray(e.pauses) ? e.pauses : [];
      if (ps.length) ps.forEach((p, i) => {
        const m = (p.durationMs || 0) / 60000, dec = S.pauseReviews[pauseKey(e, i)];
        const ex = dec ? dec.decision === "accept" : isExcused(p.reason, words);
        const label = (p.reason || "no reason given").trim().slice(0, 40) + (dec ? (dec.decision === "accept" ? " (accepted)" : " (rejected)") : "");
        reasons[label] = reasons[label] || { n: 0, min: 0, ex }; reasons[label].n++; reasons[label].min += m;
        if (ex) { eP++; eMin += m; } else { cP++; cMin += m; }
      });
      else if (e.pauseCount) { cP += e.pauseCount; cMin += e.pausedMinutes || 0; reasons["no reason given"] = reasons["no reason given"] || { n: 0, min: 0, ex: false }; reasons["no reason given"].n += e.pauseCount; reasons["no reason given"].min += e.pausedMinutes || 0; }
    });
    let hC = 0, hE = 0;
    list.filter(e => e.held).forEach(e => { const dec = S.pauseReviews[holdKey(e)]; const ex = dec ? dec.decision === "accept" : isExcused(e.holdReason, words); if (ex) hE++; else hC++; const label = "HOLD: " + (e.holdReason || "no reason given").trim().slice(0, 34) + (dec ? (dec.decision === "accept" ? " (accepted)" : " (rejected)") : ""); reasons[label] = reasons[label] || { n: 0, min: 0, ex }; reasons[label].n++; });
    const daily = {}; list.forEach(e => { const d = daily[e.date] = daily[e.date] || { takes: 0, hours: 0 }; d.takes++; d.hours += entryHours(e); });
    const activeDays = Object.keys(daily).length;
    const stageRows = {}; myPairs.forEach(p => { const s = stageRows[p.stage] = stageRows[p.stage] || { videos: 0, hrs: [] }; s.videos++; s.hrs.push(p.h); });
    return {
      name, takes: list.length, videos, passes: myPairs.length, hours, speedRatio: median(ratios),
      countedPauses: cP, excusedPauses: eP, countedHolds: hC, excusedHolds: hE, countedMin: cMin, excusedMin: eMin, activeDays, wd,
      takesPerDay: activeDays ? list.length / activeDays : 0, hoursPerDay: activeDays ? hours / activeDays : 0,
      daily, reasons, stages: Object.entries(stageRows).map(([st, s]) => ({ stage: st, videos: s.videos, mine: median(s.hrs), team: bench[st] || null }))
    };
  });
  const medPasses = median(rows.filter(r => r.takes >= cfg.minTakes).map(r => r.passes)) || 1;
  const W = cfg.weights;
  rows.forEach(r => {
    r.enough = r.takes >= cfg.minTakes;
    const share = r.countedMin / Math.max(1, r.hours * 60 + r.countedMin);
    r.parts = {
      output: clamp(70 * r.passes / medPasses),
      speed: r.speedRatio == null ? null : clamp(70 * r.speedRatio),
      focus: clamp(100 - 250 * share - 5 * Math.max(0, r.countedPauses / Math.max(1, r.takes) - 2) - 5 * (r.countedHolds || 0)),
      consistency: 0.6 * Math.min(100, 100 * r.activeDays / r.wd) + 0.4 * Math.min(100, 100 * r.hoursPerDay / cfg.targetHours)
    };
    let sum = 0, wsum = 0; Object.keys(W).forEach(k => { if (r.parts[k] != null) { sum += r.parts[k] * (+W[k] || 0); wsum += (+W[k] || 0); } });
    r.score = wsum ? sum / wsum : 0;
  });
  rows.sort((a, b) => (b.enough - a.enough) || (b.score - a.score));
  return { month, wd, medPasses, rows };
}
const scoreCls = v => v >= 80 ? "ok" : v >= 60 ? "acc" : v >= 40 ? "warn" : "bad";
const r0 = v => v == null ? "—" : Math.round(v);
function sparkline(vals) {
  const pts = vals.map((v, i) => v == null ? null : [i * 14 + 2, 30 - (v / 100) * 26]).filter(Boolean);
  if (!pts.length) return "";
  return "<svg class=\"spark\" viewBox=\"0 0 " + ((vals.length - 1) * 14 + 4) + " 32\" width=\"" + ((vals.length - 1) * 14 + 4) + "\" height=\"32\" aria-hidden=\"true\"><polyline points=\"" + pts.map(p => p.join(",")).join(" ") + "\" fill=\"none\" stroke=\"var(--accent)\" stroke-width=\"2\"/>" + "<circle cx=\"" + pts[pts.length - 1][0] + "\" cy=\"" + pts[pts.length - 1][1] + "\" r=\"3\" fill=\"var(--accent)\"/></svg>";
}
function partCell(v) { return v == null ? "<td class=\"n meta\">—</td>" : "<td class=\"n\"><span class=\"pill " + scoreCls(v) + "\">" + r0(v) + "</span></td>"; }
function kpiCard(r, prev) {
  const d = prev && prev.enough ? r.score - prev.score : null;
  return "<div class=\"kpi-card\"><div class=\"kpi-big\"><span class=\"lab\">KPI score</span><span class=\"val " + scoreCls(r.score) + "\">" + r0(r.score) + "</span>" + (d == null ? "" : "<span class=\"meta\">" + (d >= 0 ? "▲ " : "▼ ") + Math.abs(Math.round(d)) + " vs last month</span>") + (r.enough ? "" : "<span class=\"meta\">Not enough takes yet this month</span>") + "</div>" +
    "<div class=\"facts\">" + Object.keys(PART_LABEL).map(k => fact(PART_LABEL[k] + " · " + kpiCfg().weights[k] + "%", r.parts[k] == null ? "—" : "<span class=\"pill " + scoreCls(r.parts[k]) + "\">" + r0(r.parts[k]) + "</span>")).join("") +
    fact("Videos / stage passes", r.videos + " videos · " + r.passes + " passes") + fact("Hours logged", fmtH(r.hours)) +
    fact("Pauses", r.countedPauses + " counted (" + Math.round(r.countedMin) + " min) · " + r.excusedPauses + " excused (" + Math.round(r.excusedMin) + " min)") +
    fact("Holds", (r.countedHolds || 0) + " counted · " + (r.excusedHolds || 0) + " excused") +
    fact("Active days", r.activeDays + " of " + r.wd + " working days") + fact("Takes per day", r.takesPerDay.toFixed(1)) + fact("Hours per active day", fmtH(r.hoursPerDay)) + "</div></div>";
}
function kpiDetail(r) {
  const days = Object.keys(r.daily).sort();
  const [y, mo] = S.kpiMonth.split("-").map(Number); const all = []; for (let d = new Date(y, mo - 1, 1); d.getMonth() === mo - 1; d.setDate(d.getDate() + 1)) all.push(ymd(d));
  const mx = Math.max(1, ...days.map(k => r.daily[k].hours));
  const bw = 16, H = 90;
  const bars = all.map((k, i) => { const v = r.daily[k]; const h = v ? Math.max(2, (v.hours / mx) * (H - 20)) : 0; return (v ? "<rect x=\"" + (i * bw + 2) + "\" y=\"" + (H - 14 - h) + "\" width=\"" + (bw - 4) + "\" height=\"" + h + "\" rx=\"2\" fill=\"var(--accent)\"><title>" + fmtDay(k) + ": " + v.takes + " takes · " + fmtH(v.hours) + "</title></rect><text x=\"" + (i * bw + bw / 2) + "\" y=\"" + (H - 16 - h) + "\" text-anchor=\"middle\" font-size=\"9\" fill=\"var(--muted)\">" + v.takes + "</text>" : "") + ((i + 1) % 5 === 0 || i === 0 ? "<text x=\"" + (i * bw + bw / 2) + "\" y=\"" + (H - 2) + "\" text-anchor=\"middle\" font-size=\"9\" fill=\"var(--muted)\">" + (i + 1) + "</text>" : ""); }).join("");
  const reasons = Object.entries(r.reasons).sort((a, b) => b[1].min - a[1].min).slice(0, 10);
  return "<h2>" + esc(r.name) + " · " + esc(monthLabel(S.kpiMonth)) + "</h2>" +
    "<h3 class=\"sub-h\">Hours and takes per day <span class=\"meta\">(number above each bar = takes)</span></h3><div class=\"tscroll\"><svg viewBox=\"0 0 " + (all.length * bw + 4) + " " + H + "\" width=\"" + (all.length * bw + 4) + "\" height=\"" + H + "\" role=\"img\" aria-label=\"Hours per day\">" + bars + "</svg></div>" +
    "<h3 class=\"sub-h\">Speed by stage</h3><div class=\"tscroll\"><table><thead><tr><th>Stage</th><th style=\"text-align:end\">Videos</th><th style=\"text-align:end\">Their hours / video</th><th style=\"text-align:end\">Team median</th><th style=\"text-align:end\">Difference</th></tr></thead><tbody>" +
    r.stages.map(s => { const diff = s.mine && s.team ? Math.round(100 * (s.mine - s.team) / s.team) : null; return "<tr><td>" + esc(s.stage) + "</td><td class=\"n\">" + s.videos + "</td><td class=\"n\">" + (s.mine ? fmtH(s.mine) : "—") + "</td><td class=\"n\">" + (s.team ? fmtH(s.team) : "—") + "</td><td class=\"n\">" + (diff == null ? "—" : "<span class=\"pill " + (diff <= 0 ? "ok" : diff <= 25 ? "warn" : "bad") + "\">" + (diff > 0 ? "+" : "") + diff + "%</span>") + "</td></tr>"; }).join("") + "</tbody></table></div>" +
    "<h3 class=\"sub-h\">Pause reasons</h3>" + (reasons.length ? "<ul class=\"list\">" + reasons.map(([k, v]) => "<li><span class=\"grow\" dir=\"auto\">" + esc(k) + " " + (v.ex ? "<span class=\"pill ok\">excused</span>" : "") + "</span><span class=\"meta\">" + v.n + "× · " + Math.round(v.min) + " min</span></li>").join("") + "</ul>" : "<p class=\"empty\">No pauses this month.</p>");
}
function kpiMonths() { const out = []; const d = new Date(); d.setDate(1); for (let i = 0; i < 12; i++) { out.push(d.getFullYear() + "-" + pad(d.getMonth() + 1)); d.setMonth(d.getMonth() - 1); } return out; }
function renderKpi() {
  if (!S.kpiMonth) S.kpiMonth = curMonth();
  const sel = $("#kpiMonth"); if (!sel.options.length || sel.dataset.m !== kpiMonths()[0]) { sel.innerHTML = kpiMonths().map(m => "<option value=\"" + m + "\">" + monthLabel(m) + (m === curMonth() ? " (so far)" : "") + "</option>").join(""); sel.dataset.m = kpiMonths()[0]; }
  sel.value = S.kpiMonth;
  const cfg = kpiCfg();
  $("#kpiHow").innerHTML = "<h2>How the score works</h2><div class=\"facts\">" +
    fact("Output · " + cfg.weights.output + "%", "Different videos and stages worked on this month, compared with the team's middle editor. Matching the middle scores 70.") +
    fact("Speed · " + cfg.weights.speed + "%", "Hours per video for each stage, compared with the team's median for that same stage. Matching it scores 70; faster scores more, up to 100.") +
    fact("Focus · " + cfg.weights.focus + "%", "How much of the working time was paused, and pauses per take. Pauses for render, review, meetings and prayer don't count.") +
    fact("Consistency · " + cfg.weights.consistency + "%", "Days with logged work out of working days, and hours per active day against a " + cfg.targetHours + "h target.") +
    "</div><p class=\"meta\">Scores come from the time logged in SS Tracker. Current month updates live; past months are saved when the month ends.</p>";
  if (S.isLead) {
    const res = computeKpi(S.kpiMonth, S.entries);
    const prev = computeKpi(prevMonth(S.kpiMonth), S.entries);
    const trendMonths = []; { let m = S.kpiMonth; for (let i = 0; i < 6; i++) { trendMonths.unshift(m); m = prevMonth(m); } }
    const trend = {}; trendMonths.forEach(m => { computeKpi(m, S.entries).rows.forEach(r => { (trend[r.name] = trend[r.name] || {})[m] = r.enough ? r.score : null; }); });
    $("#kpiAsOf").textContent = res.rows.length + " editors · " + res.wd + " working days" + (S.kpiMonth === curMonth() ? " so far" : "");
    $("#kpiBody").innerHTML = res.rows.length ? "<div class=\"tscroll\"><table class=\"kpi-table\"><thead><tr><th>#</th><th>Editor</th><th style=\"text-align:end\">Score</th><th style=\"text-align:end\">Output</th><th style=\"text-align:end\">Speed</th><th style=\"text-align:end\">Focus</th><th style=\"text-align:end\">Consist.</th><th style=\"text-align:end\">vs last</th><th style=\"text-align:end\">Videos</th><th style=\"text-align:end\">Hours</th><th style=\"text-align:end\">Pauses</th><th style=\"text-align:end\">Days</th><th style=\"text-align:end\">Takes/day</th><th>6 months</th></tr></thead><tbody>" +
      res.rows.map((r, i) => { const p = prev.rows.find(x => x.name === r.name); const d = p && p.enough && r.enough ? Math.round(r.score - p.score) : null;
        return "<tr class=\"clickable" + (S.kpiOpen === r.name ? " on" : "") + "\" data-kpi=\"" + esc(r.name) + "\"><td class=\"n meta\">" + (r.enough ? i + 1 : "") + "</td><td><b>" + esc(r.name) + "</b>" + (r.enough ? "" : " <span class=\"meta\">few takes</span>") + "</td><td class=\"n\"><span class=\"score " + scoreCls(r.score) + "\">" + r0(r.score) + "</span></td>" + ["output", "speed", "focus", "consistency"].map(k => partCell(r.parts[k])).join("") +
          "<td class=\"n\">" + (d == null ? "·" : "<span class=\"" + (d >= 0 ? "up" : "down") + "\">" + (d >= 0 ? "▲" : "▼") + Math.abs(d) + "</span>") + "</td><td class=\"n\">" + r.videos + "</td><td class=\"n\">" + fmtH(r.hours) + "</td><td class=\"n\">" + r.countedPauses + "<span class=\"meta\"> +" + r.excusedPauses + "</span></td><td class=\"n\">" + r.activeDays + "/" + r.wd + "</td><td class=\"n\">" + r.takesPerDay.toFixed(1) + "</td><td>" + sparkline(trendMonths.map(m => (trend[r.name] || {})[m] ?? null)) + "</td></tr>"; }).join("") +
      "</tbody></table></div><p class=\"meta\">Click an editor for the day-by-day breakdown. Pauses: counted <span class=\"meta\">+ excused</span>.</p>" : "<p class=\"empty\">No SS Tracker entries in " + esc(monthLabel(S.kpiMonth)) + ".</p>";
    const open = res.rows.find(r => r.name === S.kpiOpen);
    $("#kpiDetail").hidden = !open; $("#kpiDetail").innerHTML = open ? kpiCard(open, prev.rows.find(x => x.name === open.name)) + kpiDetail(open) : "";
    $("#kpiSettingsPanel").hidden = false; fillKpiSettings();
    saveKpiSnapshots(res);
  } else {
    $("#kpiSettingsPanel").hidden = true;
    const row = S.kpiMine[S.kpiMonth], prev = S.kpiMine[prevMonth(S.kpiMonth)];
    $("#kpiAsOf").textContent = row && row.savedAt ? "updated " + new Date(row.savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    $("#kpiBody").innerHTML = !S.myName ? "<p class=\"empty\">Your account isn't linked to an SS Tracker name yet.</p>" : row ? kpiCard(row, prev) : "<p class=\"empty\">No KPI for " + esc(monthLabel(S.kpiMonth)) + " yet. It appears once you've logged takes and a lead has opened the dashboard.</p>";
    $("#kpiDetail").hidden = !row; $("#kpiDetail").innerHTML = row ? kpiDetail(row) : "";
  }
}
function fillKpiSettings() {
  const f = $("#kpiSettingsForm"); if (f.dataset.filled === JSON.stringify(S.kpiSettings || {})) return;
  const c = kpiCfg();
  ["output", "speed", "focus", "consistency"].forEach(k => { $("#kw-" + k).value = c.weights[k]; });
  $("#kTarget").value = c.targetHours; $("#kMin").value = c.minTakes; $("#kExcused").value = c.excused;
  document.querySelectorAll("#kDays input").forEach(cb => { cb.checked = c.workdays.includes(+cb.value); });
  f.dataset.filled = JSON.stringify(S.kpiSettings || {});
}
/* Leads' browsers save each editor's row so editors can see their own score (rules: an editor reads only their own row). */
const kpiWritten = {};
let kpiSaveTimer = null;
function saveKpiSnapshots(res) {
  clearTimeout(kpiSaveTimer);
  kpiSaveTimer = setTimeout(() => {
    const months = [res.month, prevMonth(res.month)];
    months.forEach(m => {
      const r = m === res.month ? res : computeKpi(m, S.entries);
      r.rows.forEach(row => {
        const data = { ...row, month: m, final: m < curMonth() };
        const sig = JSON.stringify(data);
        const key = m + "/" + row.name;
        if (kpiWritten[key] === sig) return;
        kpiWritten[key] = sig;
        setDoc(doc(db, "dash_kpi", m, "editors", row.name), { ...data, savedAt: Date.now() }).catch(() => { delete kpiWritten[key]; });
      });
    });
  }, 4000);
}

/* ---------- pause review: leads accept (doesn't count) or reject (counts) each pause ---------- */
const holdKey = e => "hold_" + String(e.id || (e.editor + "_" + e.loggedAt)).replace(/[\/]/g, "_");
const pauseKey = (e, i) => String(e.id || (e.editor + "_" + e.loggedAt)).replace(/[\/]/g, "_") + "_" + i;
function allPauses(month) {
  const words = excusedWords(), out = [];
  S.entries.filter(e => monthOf(e.date) === month && Array.isArray(e.pauses)).forEach(e => e.pauses.forEach((p, i) => {
    const key = pauseKey(e, i), dec = S.pauseReviews[key];
    out.push({ key, editor: e.editor, video: e.video, stage: e.stage, date: e.date, reason: p.reason || "", min: (p.durationMs || 0) / 60000, at: p.pausedAt, auto: isExcused(p.reason, words), dec: dec ? dec.decision : null, by: dec ? dec.by : "" });
  }));
  S.entries.filter(e => monthOf(e.date) === month && e.held).forEach(e => {
    const key = holdKey(e), dec = S.pauseReviews[key];
    out.push({ key, type: "Hold", editor: e.editor, video: e.video, stage: e.stage, date: e.date, reason: e.holdReason || "", min: null, at: e.loggedAt, auto: isExcused(e.holdReason, words), dec: dec ? dec.decision : null, by: dec ? dec.by : "" });
  });
  return out.sort((a, b) => String(b.at || b.date).localeCompare(String(a.at || a.date)));
}
function renderPauseReview() {
  const panel = $("#pauseReview"); if (!S.isLead) { panel.hidden = true; return; } panel.hidden = false;
  const all = allPauses(S.kpiMonth);
  const f = S.prFilter;
  const eds = [...new Set(all.map(p => p.editor))].sort();
  const cnt = st => all.filter(p => st === "all" ? true : st === "pending" ? !p.dec : p.dec === st).length;
  $("#prStatus").innerHTML = [["pending", "To review"], ["accept", "Accepted"], ["reject", "Rejected"], ["all", "All"]].map(([k, l]) => "<button type=\"button\" data-pr=\"" + k + "\" aria-pressed=\"" + (f.status === k) + "\">" + l + " <b>" + cnt(k) + "</b></button>").join("");
  const pick = $("#prEditor"); const cur = f.editor; pick.innerHTML = "<option value=\"\">All editors</option>" + eds.map(n => "<option>" + esc(n) + "</option>").join(""); pick.value = eds.includes(cur) ? cur : "";
  let rows = all.filter(p => (!f.editor || p.editor === f.editor) && (f.status === "all" || (f.status === "pending" ? !p.dec : p.dec === f.status)));
  if (f.status === "pending") rows.sort((a, b) => (b.min ?? 999) - (a.min ?? 999));
  $("#prBulk").hidden = f.status !== "pending" || !rows.length;
  $("#prList").innerHTML = rows.length ? "<div class=\"tscroll\"><table><thead><tr><th>Day</th><th>Type</th><th>Editor</th><th>Episode</th><th>Stage</th><th>Reason</th><th style=\"text-align:end\">Length</th><th>Status</th><th></th></tr></thead><tbody>" + rows.slice(0, 300).map(p =>
    "<tr><td class=\"code\">" + fmtDay(p.date) + "</td><td>" + (p.type === "Hold" ? "<span class=\"pill warn\">Hold</span>" : "<span class=\"pill\">Pause</span>") + "</td><td>" + esc(p.editor) + "</td><td class=\"code\">" + esc(p.video) + "</td><td>" + esc(p.stage || "") + "</td><td dir=\"auto\">" + (p.reason ? esc(p.reason) : "<span class=\"meta\">no reason given</span>") + "</td><td class=\"n\">" + (p.min == null ? "—" : Math.round(p.min) + " min") + "</td><td>" +
    (p.dec === "accept" ? "<span class=\"pill ok\">Accepted</span>" : p.dec === "reject" ? "<span class=\"pill bad\">Rejected</span>" : "<span class=\"pill\">Not reviewed · " + (p.auto ? "excused for now" : "counts for now") + "</span>") +
    "</td><td class=\"pr-actions\"><button class=\"btn small ok\" type=\"button\" data-pr-set=\"accept\" data-key=\"" + esc(p.key) + "\"" + (p.dec === "accept" ? " disabled" : "") + ">Accept</button><button class=\"btn small no\" type=\"button\" data-pr-set=\"reject\" data-key=\"" + esc(p.key) + "\"" + (p.dec === "reject" ? " disabled" : "") + ">Reject</button>" + (p.dec ? "<button class=\"link\" type=\"button\" data-pr-set=\"clear\" data-key=\"" + esc(p.key) + "\">Undo</button>" : "") + "</td></tr>").join("") + "</tbody></table></div>" + (rows.length > 300 ? "<p class=\"meta\">Showing the first 300.</p>" : "")
    : "<p class=\"empty\">" + (f.status === "pending" ? "Nothing left to review for " + esc(monthLabel(S.kpiMonth)) + "." : "No pauses match.") + "</p>";
}
function setPauseDecision(key, decision) {
  if (decision === "clear") return deleteDoc(doc(db, "dash_pause_reviews", key)).catch(() => { });
  return setDoc(doc(db, "dash_pause_reviews", key), { decision, by: S.email, at: Date.now() }).catch(() => { });
}


/* ---------- daily plans (written by SS Tracker: plans/{id}) ---------- */
const PLAN_PRIO = { high: 0, normal: 1, low: 2 }, PLAN_ST = { doing: 0, todo: 1, held: 2, done: 3 };
function planDue(p) {
  const t = today(); if (!p.deadline) return { late: false, label: "no deadline", cls: "" };
  const n = daysBetween(t, p.deadline); const now = new Date(), hm = pad(now.getHours()) + ":" + pad(now.getMinutes());
  const late = p.status !== "done" && (n < 0 || (n === 0 && p.deadlineTime && hm > p.deadlineTime));
  return { late, n, label: (late ? "overdue · " : "") + fmtDay(p.deadline) + (p.deadlineTime ? " " + p.deadlineTime : ""), cls: late ? "late" : n === 0 ? "soon" : "" };
}
function todaysPlans(list) { const t = today(); return list.filter(p => p.status !== "done" || (p.doneAt || "").slice(0, 10) === t); }
function planRow(p, withEditor) {
  const d = planDue(p);
  const st = { doing: "<span class=\"pill acc\">In progress</span>", todo: "<span class=\"pill\">Planned</span>", held: "<span class=\"pill warn\">On hold</span>", done: "<span class=\"pill ok\">Done</span>" }[p.status] || "";
  const prio = "<span class=\"pill " + (p.priority === "high" ? "bad" : p.priority === "low" ? "" : "warn") + "\">" + esc(p.priority || "normal") + "</span>";
  return "<tr><td>" + prio + "</td>" + (withEditor ? "<td>" + esc(p.editor) + "</td>" : "") + "<td class=\"code\">" + esc(p.video) + "</td><td>" + esc(p.project || "") + " · " + esc(p.stage || "") + "</td><td class=\"code when " + d.cls + "\">" + esc(d.label) + "</td><td>" + st + (p.midDay ? " <span class=\"pill warn\">mid-day</span>" : "") + (p.planDate && p.planDate < today() && p.status !== "done" ? " <span class=\"pill acc\">carried over</span>" : "") + (p.status === "held" && p.holdReason ? " <span class=\"meta\" dir=\"auto\">" + esc(p.holdReason) + "</span>" : "") + "</td></tr>";
}
function planTable(list, withEditor) {
  if (!list.length) return "<p class=\"empty\">No plan yet. Editors add their episodes in SS Tracker under “Today's plan”.</p>";
  const rows = list.slice().sort((a, b) => (PLAN_ST[a.status] - PLAN_ST[b.status]) || ((PLAN_PRIO[a.priority] ?? 1) - (PLAN_PRIO[b.priority] ?? 1)) || String(a.deadline || "9").localeCompare(String(b.deadline || "9")));
  return "<div class=\"tscroll\"><table><thead><tr><th>Priority</th>" + (withEditor ? "<th>Editor</th>" : "") + "<th>Episode</th><th>Project · stage</th><th>Deadline</th><th>Status</th></tr></thead><tbody>" + rows.map(p => planRow(p, withEditor)).join("") + "</tbody></table></div>";
}
function renderPlans() {
  const mine = S.myName ? todaysPlans(S.plans.filter(p => p.editor === S.myName)) : [];
  $("#myPlan").innerHTML = S.myName ? planTable(mine, false) : "";
  if (!S.isLead) return;
  const all = todaysPlans(S.plans);
  const eds = [...new Set(all.map(p => p.editor))].sort();
  $("#teamPlanSummary").innerHTML = eds.length ? "<div class=\"tscroll\"><table><thead><tr><th>Editor</th><th style=\"text-align:end\">Planned</th><th style=\"text-align:end\">In progress</th><th style=\"text-align:end\">Done today</th><th style=\"text-align:end\">Overdue</th><th style=\"text-align:end\">Added mid-day</th><th style=\"text-align:end\">On hold</th></tr></thead><tbody>" + eds.map(n => {
    const l = all.filter(p => p.editor === n), c = f => l.filter(f).length;
    return "<tr class=\"clickable\" data-plan-ed=\"" + esc(n) + "\"><td><b>" + esc(n) + "</b></td><td class=\"n\">" + l.length + "</td><td class=\"n\">" + c(p => p.status === "doing") + "</td><td class=\"n\">" + c(p => p.status === "done") + "</td><td class=\"n\">" + (c(p => planDue(p).late) ? "<span class=\"pill bad\">" + c(p => planDue(p).late) + "</span>" : "·") + "</td><td class=\"n\">" + (c(p => p.midDay) || "·") + "</td><td class=\"n\">" + (c(p => p.status === "held") || "·") + "</td></tr>";
  }).join("") + "</tbody></table></div>" : "<p class=\"empty\">No editor has a plan for today yet.</p>";
  const sel = S.planEd && eds.includes(S.planEd) ? S.planEd : "";
  $("#teamPlanList").innerHTML = "<h3 class=\"sub-h\">" + (sel ? esc(sel) + "'s plan" : "All plans") + (sel ? " <button class=\"link\" type=\"button\" data-plan-ed=\"\">show everyone</button>" : "") + "</h3>" + planTable(all.filter(p => !sel || p.editor === sel), !sel);
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
$("#v-team").addEventListener("click", e => { const r = e.target.closest("[data-plan-ed]"); if (r) { S.planEd = r.dataset.planEd; renderPlans(); } });
$("#kpiMonth").addEventListener("change", e => { S.kpiMonth = e.target.value; S.kpiOpen = null; subscribeMyKpi(); renderKpi(); renderPauseReview(); });
$("#kpiBody").addEventListener("click", e => { const tr = e.target.closest("[data-kpi]"); if (tr) { S.kpiOpen = S.kpiOpen === tr.dataset.kpi ? null : tr.dataset.kpi; renderKpi(); if (S.kpiOpen) $("#kpiDetail").scrollIntoView({ behavior: "smooth", block: "start" }); } });
$("#prStatus").addEventListener("click", e => { const b = e.target.closest("[data-pr]"); if (b) { S.prFilter.status = b.dataset.pr; renderPauseReview(); } });
$("#prEditor").addEventListener("change", e => { S.prFilter.editor = e.target.value; renderPauseReview(); });
$("#prList").addEventListener("click", e => { const b = e.target.closest("[data-pr-set]"); if (b) { b.disabled = true; setPauseDecision(b.dataset.key, b.dataset.prSet); } });
$("#prBulk").addEventListener("click", async e => {
  const b = e.target.closest("[data-bulk]"); if (!b) return;
  const pend = allPauses(S.kpiMonth).filter(p => !p.dec && (!S.prFilter.editor || p.editor === S.prFilter.editor));
  const pick = b.dataset.bulk === "accept-suggested" ? pend.filter(p => p.auto) : pend.filter(p => !p.auto);
  const dec = b.dataset.bulk === "accept-suggested" ? "accept" : "reject";
  b.disabled = true; b.textContent = "Saving " + pick.length + "…";
  for (const p of pick) await setPauseDecision(p.key, dec);
  b.disabled = false; renderPauseReview();
});
$("#kpiSettingsForm").addEventListener("submit", async e => {
  e.preventDefault();
  const w = {}; ["output", "speed", "focus", "consistency"].forEach(k => { w[k] = Math.max(0, +$("#kw-" + k).value || 0); });
  const data = { weights: w, targetHours: Math.max(1, +$("#kTarget").value || 6), minTakes: Math.max(1, +$("#kMin").value || 3), excused: $("#kExcused").value, workdays: [...document.querySelectorAll("#kDays input:checked")].map(c => +c.value), by: S.email, at: Date.now() };
  try { await setDoc(doc(db, "dash_settings", "kpi"), data); $("#kSaveMsg").textContent = "Saved. Scores updated."; } catch (err) { $("#kSaveMsg").textContent = "Couldn't save. Only leads can change KPI settings."; }
});
$("#kReset").addEventListener("click", () => { S.kpiSettings = { ...KPI_DEFAULTS }; $("#kpiSettingsForm").dataset.filled = ""; fillKpiSettings(); $("#kSaveMsg").textContent = "Defaults loaded. Click Save to apply."; });
let myKpiUnsubs = [];
function subscribeMyKpi() {
  myKpiUnsubs.splice(0).forEach(u => { try { u(); } catch (e) { } });
  if (S.isLead || !S.myName || !S.kpiMonth) return;
  [S.kpiMonth, prevMonth(S.kpiMonth)].forEach(m => myKpiUnsubs.push(onSnapshot(doc(db, "dash_kpi", m, "editors", S.myName), snap => { S.kpiMine[m] = snap.exists() ? snap.data() : null; renderKpi(); }, () => { })));
}

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
  live(doc(db, "dash_settings", "kpi"), snap => { S.kpiSettings = snap.exists() ? snap.data() : null; renderKpi(); });
  live(collection(db, "dash_flags"), s => { const f = {}; s.docs.forEach(d => { f[d.id] = true; }); S.flags = f; renderAll(); });
  live(collection(db, "dash_links"), s => { S.links = s.docs.map(d => ({ id: d.id, ...d.data() })); renderLinks(); });
  live(collection(db, "activeTakes"), s => { S.takes = s.docs.map(d => ({ editor: d.id, ...d.data() })).filter(x => x.video); renderOverview(); renderMyWork(); renderTeam(); renderSearch(); });
  if (S.isLead) {
    live(collection(db, "entries"), s => { S.entries = s.docs.map(d => ({ id: d.id, ...d.data() })); renderMyWork(); renderTeam(); renderProjects(); renderKpi(); renderPauseReview(); });
    live(collection(db, "dash_roles"), s => { S.roles = s.docs.map(d => ({ id: d.id, ...d.data() })); renderTeam(); });
    live(collection(db, "plans"), s => { S.plans = s.docs.map(d => ({ id: d.id, ...d.data() })); renderPlans(); });
    live(collection(db, "dash_pause_reviews"), s => { const m = {}; s.docs.forEach(d => { m[d.id] = d.data(); }); S.pauseReviews = m; renderKpi(); renderPauseReview(); });
  } else if (S.myName) {
    live(query(collection(db, "entries"), where("editor", "==", S.myName)), s => { S.entries = s.docs.map(d => d.data()); renderMyWork(); });
    live(query(collection(db, "plans"), where("editor", "==", S.myName)), s => { S.plans = s.docs.map(d => ({ id: d.id, ...d.data() })); renderPlans(); });
  }
  S.kpiMonth = S.kpiMonth || curMonth();
  subscribeMyKpi();
  renderAll();
});
