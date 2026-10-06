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
const SHEET_LABEL = { master: "Master tracker", timeline: "Timeline", calendar: "Publishing calendar" };
const DEFAULT_LINK_TABS = ["master|Important Links"];
function srcCfg() { const c = S.srcSettings || {}; return { linkTabs: Array.isArray(c.linkTabs) ? c.linkTabs : DEFAULT_LINK_TABS, projects: c.projects || {} }; }
function tabLinks(key, tab) {
  const out = [], rows = tab.rows || [], lk = tab.links || {};
  Object.entries(lk).forEach(([rc, url]) => {
    const [r, c] = rc.split(",").map(Number); let title = cellStr((rows[r] || [])[c]);
    if (!title || /^https?:/i.test(title) || /^link$|^اللينك$/i.test(title)) { const rowText = (rows[r] || []).map(cellStr).filter(v => v && !/^https?:/i.test(v) && v.length < 80); title = rowText.slice(0, 2).join(" · ") || url; }
    out.push({ title: title.split("\n")[0].slice(0, 90), url, group: tab.name.trim(), src: SHEET_LABEL[key] || key });
  });
  return out;
}
function applySheets() {
  const m = parseMaster((S.raw.master || {}).tabs || []);
  const cfg = srcCfg();
  S.allProjects = m.projects.map(p => ({ ...p }));
  // Project progress: hide, rename or override each tracker tab (Team → Sheets setup)
  const rename = {}, hiddenP = new Set();
  S.projects = m.projects.filter(p => { const c = cfg.projects[p.name] || {}; if (c.show === false) { hiddenP.add(p.name); return false; } return true; }).map(p => {
    const c = cfg.projects[p.name] || {}; const out = { ...p };
    if (c.name && c.name.trim()) { out.name = c.name.trim(); rename[p.name] = out.name; }
    if (c.done != null && c.done !== "") { const total = c.total != null && c.total !== "" ? +c.total : p.total; out.total = Math.max(1, total); out.done = Math.min(out.total, +c.done); out.review = 0; out.wip = 0; out.todo = out.total - out.done; out.manual = true; }
    return out;
  });
  S.episodes = m.episodes.filter(e => !hiddenP.has(e.project)).map(e => rename[e.project] ? { ...e, project: rename[e.project] } : e);
  S.reshoots = m.reshoots;
  // Links: every hyperlink in the sheet tabs chosen in Sheets setup
  const seen = new Set(); S.sheetLinks = [];
  Object.keys(SHEET_LABEL).forEach(key => ((S.raw[key] || {}).tabs || []).forEach(tab => {
    if (!cfg.linkTabs.includes(key + "|" + tab.name.trim())) return;
    tabLinks(key, tab).forEach(l => { if (!seen.has(l.url)) { seen.add(l.url); S.sheetLinks.push(l); } });
  }));
  S.timeline = parseTimeline((S.raw.timeline || {}).tabs || []);
  S.publish = parseCalendar((S.raw.calendar || {}).tabs || []);
  $("#projList").innerHTML = S.projects.map(p => "<option>" + esc(p.name) + "</option>").join("");
  renderAll();
}
function renderSheetSetup() {
  const panel = $("#sheetSetup"); if (!S.isLead) { panel.hidden = true; return; } panel.hidden = false;
  const cfg = srcCfg();
  const tabs = []; Object.keys(SHEET_LABEL).forEach(key => ((S.raw[key] || {}).tabs || []).forEach(tab => tabs.push({ key, tab, id: key + "|" + tab.name.trim(), n: Object.keys(tab.links || {}).length })));
  $("#ssLinks").innerHTML = tabs.length ? "<div class=\"tab-picks\">" + tabs.map(t => "<label class=\"tab-pick" + (t.n ? "" : " none") + "\"><input type=\"checkbox\" data-linktab=\"" + esc(t.id) + "\"" + (cfg.linkTabs.includes(t.id) ? " checked" : "") + "> <span><b>" + esc(t.tab.name.trim()) + "</b><span class=\"meta\"> · " + esc(SHEET_LABEL[t.key]) + " · " + t.n + " link" + (t.n === 1 ? "" : "s") + "</span></span></label>").join("") + "</div>" : "<p class=\"empty\">Sheet tabs appear after the first sheet sync.</p>";
  const ps = S.allProjects || [];
  $("#ssProjects").innerHTML = ps.length ? "<div class=\"tscroll\"><table><thead><tr><th>Show</th><th>Sheet tab</th><th>Name on dashboard</th><th style=\"text-align:end\">From sheet</th><th>Set done</th><th>Set total</th></tr></thead><tbody>" + ps.map(p => { const c = cfg.projects[p.name] || {};
    return "<tr data-proj-row=\"" + esc(p.name) + "\"><td><input type=\"checkbox\" class=\"ps-show\"" + (c.show === false ? "" : " checked") + " aria-label=\"Show " + esc(p.name) + "\"></td><td>" + esc(p.name) + "</td><td><input class=\"ps-name\" value=\"" + esc(c.name || "") + "\" placeholder=\"" + esc(p.name) + "\"></td><td class=\"n\">" + p.done + "/" + p.total + "</td><td><input class=\"ps-done\" type=\"number\" min=\"0\" value=\"" + esc(c.done ?? "") + "\" placeholder=\"auto\" style=\"max-width:90px\"></td><td><input class=\"ps-total\" type=\"number\" min=\"1\" value=\"" + esc(c.total ?? "") + "\" placeholder=\"auto\" style=\"max-width:90px\"></td></tr>"; }).join("") + "</tbody></table></div>" : "<p class=\"empty\">Projects appear after the first sheet sync.</p>";
}
async function saveSheetSetup() {
  const linkTabs = [...document.querySelectorAll("[data-linktab]:checked")].map(c => c.dataset.linktab);
  const projects = {};
  document.querySelectorAll("[data-proj-row]").forEach(tr => {
    const done = tr.querySelector(".ps-done").value, total = tr.querySelector(".ps-total").value, name = tr.querySelector(".ps-name").value.trim(), show = tr.querySelector(".ps-show").checked;
    if (!show || name || done !== "" || total !== "") projects[tr.dataset.projRow] = { show, name, done: done === "" ? null : +done, total: total === "" ? null : +total };
  });
  try { await setDoc(doc(db, "dash_settings", "sources"), { linkTabs, projects, by: S.email, at: Date.now() }); $("#ssMsg").textContent = "Saved. The dashboard updated for everyone."; }
  catch (e) { $("#ssMsg").textContent = "Couldn't save. Only leads can change this."; }
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
  const hidden = new Set(S.hiddenLinks || []);
  const everything = [...builtIn, ...S.sheetLinks, ...S.links.map(l => ({ ...l, src: "Team" }))];
  const all = everything.filter(l => S.showHiddenLinks ? hidden.has(l.url) : !hidden.has(l.url));
  $("#lkHiddenToggle").hidden = !S.isLead || !hidden.size;
  $("#lkHiddenToggle").textContent = S.showHiddenLinks ? "Back to all links" : "Show removed links (" + everything.filter(l => hidden.has(l.url)).length + ")";
  const groups = ["All", ...new Set(all.map(l => l.group || "Other"))];
  if (!groups.includes(S.lkFilter)) S.lkFilter = "All";
  $("#lkChips").innerHTML = groups.map(g => "<button type=\"button\" data-lk=\"" + esc(g) + "\" aria-pressed=\"" + (g === S.lkFilter) + "\">" + esc(g) + "</button>").join("");
  const q = ($("#lkSearch").value || "").trim().toLowerCase();
  const show = all.filter(l => (S.lkFilter === "All" || (l.group || "Other") === S.lkFilter) && (!q || (l.title + " " + l.url + " " + (l.group || "")).toLowerCase().includes(q)));
  $("#links").innerHTML = show.map(l => {
    let host = ""; try { host = new URL(l.url).hostname.replace(/^www\./, ""); } catch (e) { }
    return "<div class=\"lk\"><a href=\"" + esc(l.url) + "\" target=\"_blank\" rel=\"noopener\" dir=\"auto\">" + esc(l.title) + "</a><div class=\"meta\"><span>" + esc(host) + " · " + esc(l.group || "Other") + "</span>" + (S.showHiddenLinks ? "<span><button class=\"link\" data-lk-restore=\"" + esc(l.url) + "\">Restore</button></span>" : l.id ? "<span><button class=\"link\" data-lk-del=\"" + esc(l.id) + "\">Remove</button></span>" : S.isLead ? "<span><button class=\"link\" data-lk-hide=\"" + esc(l.url) + "\">Remove</button></span>" : "<span>" + esc(l.src) + "</span>") + "</div></div>";
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
function renderAll() { renderPrioBar(); renderSearch(); renderOverview(); renderProjects(); renderDeadlines(); renderLinks(); renderMyWork(); renderTeam(); renderKpi(); renderPauseReview(); renderPlans(); renderSheetSetup(); renderResetBtn(); setSync(); }

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
  weights: { deadlines: 30, output: 25, speed: 20, focus: 15, consistency: 10 },
  targetHours: 6, workdays: [6, 0, 1, 2, 3, 4], minTakes: 3,
  excused: "render, rendering, export, exporting, upload, رندر, ريندر, تصدير, اكسبورت, review, feedback, waiting, wait, مراجعة, مراجعه, فيدباك, كومنت, استنى, انتظار, meeting, meet, call, ميتنج, اجتماع, pray, prayer, salah, صلاة, صلاه, الصلاة, الصلاه"
};
const PART_LABEL = { deadlines: "Deadlines", output: "Output", speed: "Speed", focus: "Focus", consistency: "Consistency" };
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/* KPI periods run from the 25th to the 24th of the next month. A period is named after the month it ends in:
   "2026-10" = 25 Sep 2026 – 24 Oct 2026. */
const periodOf = d => { const s = String(d || ""); if (s.length < 10) return s.slice(0, 7); const y = +s.slice(0, 4), m = +s.slice(5, 7), day = +s.slice(8, 10); if (day < 25) return s.slice(0, 7); const n = new Date(y, m, 1); return n.getFullYear() + "-" + pad(n.getMonth() + 1); };
const monthOf = periodOf;
const curMonth = () => periodOf(today());
function periodBounds(m) { const [y, mo] = m.split("-").map(Number); const s = new Date(y, mo - 2, 25), e = new Date(y, mo - 1, 24); return { start: ymd(s), end: ymd(e) }; }
function monthLabel(m) { const [y, mo] = m.split("-").map(Number); const b = periodBounds(m); return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][mo - 1] + " " + y + " · " + fmtDay(b.start) + " – " + fmtDay(b.end); }
function prevMonth(m) { const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 2, 1); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
function kpiCfg() { const s = S.kpiSettings || {}; return { ...KPI_DEFAULTS, ...s, weights: { ...KPI_DEFAULTS.weights, ...(s.weights || {}) } }; }
function excusedWords() { return kpiCfg().excused.split(",").map(w => w.trim().toLowerCase()).filter(Boolean); }
function isExcused(reason, words) { const r = String(reason || "").toLowerCase(); return !!r && words.some(w => r.includes(w)); }

/* Each task (from Today's plan in SS Tracker) gets its own KPI:
     done on or before its deadline (date, and time if one was set) = 100%
     done after the deadline, or still not done once the deadline has passed = 0%
     deadline still ahead and not done yet = not counted yet
   An editor's KPI for the period = tasks on time ÷ tasks due in the period (by deadline date). */
function taskResult(p, todayK, nowHM) {
  const doneDay = (p.doneAt || "").slice(0, 10);
  if (p.status === "done" && doneDay) {
    if (doneDay < p.deadline) return "ontime";
    if (doneDay === p.deadline) { const hm = p.doneAt ? new Date(p.doneAt).toTimeString().slice(0, 5) : "00:00"; return p.deadlineTime && hm > p.deadlineTime ? "late" : "ontime"; }
    return "late";
  }
  if (p.deadline < todayK || (p.deadline === todayK && p.deadlineTime && nowHM > p.deadlineTime)) return "missed";
  return "pending";
}
function computeKpi(month, entries) {
  const words = excusedWords(), b = periodBounds(month), todayK = today(), now = new Date(), nowHM = pad(now.getHours()) + ":" + pad(now.getMinutes());
  const tasks = (S.plans || []).filter(p => p.editor && p.deadline && p.deadline >= b.start && p.deadline <= b.end);
  const ents = entries.filter(e => e.editor && periodOf(e.date) === month);
  const names = [...new Set([...tasks.map(p => p.editor), ...ents.map(e => e.editor)])];
  const rows = names.map(name => {
    const mine = tasks.filter(p => p.editor === name).map(p => {
      const res = taskResult(p, todayK, nowHM);
      const doneDay = (p.doneAt || "").slice(0, 10);
      const late = res === "late" ? daysBetween(p.deadline, doneDay) : res === "missed" ? daysBetween(p.deadline, todayK) : 0;
      return { video: p.video, project: p.project || "", stage: p.stage || "", priority: p.priority || "normal", deadline: p.deadline, deadlineTime: p.deadlineTime || "", done: doneDay, res, late, kpi: res === "ontime" ? 100 : res === "pending" ? null : 0, midDay: !!p.midDay };
    });
    const counted = mine.filter(t => t.res !== "pending");
    const onTime = counted.filter(t => t.res === "ontime").length;
    const list = ents.filter(e => e.editor === name);
    let cP = 0, eP = 0, cMin = 0, eMin = 0, hC = 0, hE = 0; const reasons = {};
    list.forEach(e => (Array.isArray(e.pauses) ? e.pauses : []).forEach((p, i) => {
      const m = (p.durationMs || 0) / 60000, dec = S.pauseReviews[pauseKey(e, i)], ex = dec ? dec.decision === "accept" : isExcused(p.reason, words);
      const label = (p.reason || "no reason given").trim().slice(0, 40) + (dec ? (dec.decision === "accept" ? " (accepted)" : " (rejected)") : "");
      reasons[label] = reasons[label] || { n: 0, min: 0, ex }; reasons[label].n++; reasons[label].min += m;
      if (ex) { eP++; eMin += m; } else { cP++; cMin += m; }
    }));
    list.filter(e => e.held).forEach(e => { const dec = S.pauseReviews[holdKey(e)], ex = dec ? dec.decision === "accept" : isExcused(e.holdReason, words); if (ex) hE++; else hC++; const label = "HOLD: " + (e.holdReason || "no reason given").trim().slice(0, 34) + (dec ? (dec.decision === "accept" ? " (accepted)" : " (rejected)") : ""); reasons[label] = reasons[label] || { n: 0, min: 0, ex }; reasons[label].n++; });
    const daily = {}; list.forEach(e => { const d = daily[e.date] = daily[e.date] || { takes: 0, hours: 0 }; d.takes++; d.hours += entryHours(e); });
    return {
      name, tasks: mine, total: mine.length, counted: counted.length, onTime,
      late: counted.filter(t => t.res === "late").length, missed: counted.filter(t => t.res === "missed").length, pending: mine.filter(t => t.res === "pending").length,
      score: counted.length ? 100 * onTime / counted.length : null, enough: counted.length > 0,
      takes: list.length, hours: list.reduce((a, e) => a + entryHours(e), 0), videos: new Set(list.map(e => compact(e.video))).size,
      countedPauses: cP, excusedPauses: eP, countedMin: cMin, excusedMin: eMin, countedHolds: hC, excusedHolds: hE,
      activeDays: Object.keys(daily).length, daily, reasons
    };
  });
  rows.sort((a, b2) => (b2.enough - a.enough) || ((b2.score ?? -1) - (a.score ?? -1)) || (b2.counted - a.counted));
  return { month, bounds: b, rows };
}
const scoreCls = v => v == null ? "" : v >= 90 ? "ok" : v >= 70 ? "acc" : v >= 50 ? "warn" : "bad";
const r0 = v => v == null ? "—" : Math.round(v);
function sparkline(vals) {
  const pts = vals.map((v, i) => v == null ? null : [i * 14 + 2, 30 - (v / 100) * 26]).filter(Boolean);
  if (!pts.length) return "";
  return "<svg class=\"spark\" viewBox=\"0 0 " + ((vals.length - 1) * 14 + 4) + " 32\" width=\"" + ((vals.length - 1) * 14 + 4) + "\" height=\"32\" aria-hidden=\"true\"><polyline points=\"" + pts.map(p => p.join(",")).join(" ") + "\" fill=\"none\" stroke=\"var(--accent)\" stroke-width=\"2\"/><circle cx=\"" + pts[pts.length - 1][0] + "\" cy=\"" + pts[pts.length - 1][1] + "\" r=\"3\" fill=\"var(--accent)\"/></svg>";
}
const pctTxt = v => v == null ? "—" : Math.round(v) + "%";
function kpiCard(r, prev) {
  const d = prev && prev.score != null && r.score != null ? r.score - prev.score : null;
  return "<div class=\"kpi-card\"><div class=\"kpi-big\"><span class=\"lab\">KPI</span><span class=\"val " + scoreCls(r.score) + "\">" + pctTxt(r.score) + "</span>" +
    (r.counted ? "<span class=\"meta\">" + r.onTime + " of " + r.counted + " tasks on time</span>" : "<span class=\"meta\">No tasks due yet this period</span>") +
    (d == null ? "" : "<span class=\"meta\">" + (d >= 0 ? "▲ " : "▼ ") + Math.abs(Math.round(d)) + " pts vs last period</span>") + "</div>" +
    "<div class=\"facts\">" + fact("On time", "<span class=\"pill ok\">" + r.onTime + "</span>") + fact("Late", "<span class=\"pill bad\">" + r.late + "</span>") + fact("Not done, past deadline", "<span class=\"pill bad\">" + r.missed + "</span>") + fact("Still upcoming", String(r.pending)) +
    fact("Hours logged", fmtH(r.hours)) + fact("Active days", String(r.activeDays)) +
    fact("Pauses", r.countedPauses + " not excused (" + Math.round(r.countedMin) + " min) · " + r.excusedPauses + " excused") + fact("Holds", r.countedHolds + " not excused · " + r.excusedHolds + " excused") + "</div></div>";
}
function kpiDetail(r) {
  const b = periodBounds(S.kpiMonth), all = []; for (let d = parseYmd(b.start); ymd(d) <= b.end; d.setDate(d.getDate() + 1)) all.push(ymd(d));
  const days = Object.keys(r.daily || {}); const mx = Math.max(1, ...days.map(k => r.daily[k].hours));
  const bw = 16, H = 90;
  const bars = all.map((k, i) => { const v = (r.daily || {})[k]; const h = v ? Math.max(2, (v.hours / mx) * (H - 20)) : 0; return (v ? "<rect x=\"" + (i * bw + 2) + "\" y=\"" + (H - 14 - h) + "\" width=\"" + (bw - 4) + "\" height=\"" + h + "\" rx=\"2\" fill=\"var(--accent)\"><title>" + fmtDay(k) + ": " + v.takes + " takes · " + fmtH(v.hours) + "</title></rect><text x=\"" + (i * bw + bw / 2) + "\" y=\"" + (H - 16 - h) + "\" text-anchor=\"middle\" font-size=\"9\" fill=\"var(--muted)\">" + v.takes + "</text>" : "") + (i % 5 === 0 ? "<text x=\"" + (i * bw + bw / 2) + "\" y=\"" + (H - 2) + "\" text-anchor=\"middle\" font-size=\"9\" fill=\"var(--muted)\">" + fmtDay(k) + "</text>" : ""); }).join("");
  const RES = { ontime: "<span class=\"pill ok\">On time · 100%</span>", late: x => "<span class=\"pill bad\">Late " + (x.late ? x.late + "d" : "· after " + esc(x.deadlineTime)) + " · 0%</span>", missed: x => "<span class=\"pill bad\">Not done · " + x.late + "d past · 0%</span>", pending: "<span class=\"pill\">Upcoming · not counted yet</span>" };
  const reasons = Object.entries(r.reasons || {}).sort((a, b2) => b2[1].min - a[1].min).slice(0, 12);
  return "<h2>" + esc(r.name) + " · " + esc(monthLabel(S.kpiMonth)) + "</h2>" +
    "<h3 class=\"sub-h\">Tasks in this period <span class=\"meta\">(each task's own KPI)</span></h3>" + ((r.tasks || []).length ? "<div class=\"tscroll\"><table><thead><tr><th>Episode</th><th>Project · stage</th><th>Priority</th><th>Deadline</th><th>Finished</th><th>Task KPI</th></tr></thead><tbody>" +
      r.tasks.slice().sort((a, b2) => a.deadline.localeCompare(b2.deadline)).map(x => "<tr><td class=\"code\">" + esc(x.video) + (x.midDay ? " <span class=\"pill warn\">mid-day</span>" : "") + "</td><td>" + esc(x.project) + " · " + esc(x.stage) + "</td><td>" + esc(x.priority) + "</td><td class=\"code\">" + fmtDay(x.deadline) + (x.deadlineTime ? " " + esc(x.deadlineTime) : "") + "</td><td class=\"code\">" + (x.done ? fmtDay(x.done) : "—") + "</td><td>" + (typeof RES[x.res] === "function" ? RES[x.res](x) : RES[x.res]) + "</td></tr>").join("") + "</tbody></table></div>"
      : "<p class=\"empty\">No tasks with a deadline in this period. Editors add tasks in SS Tracker under “Today's plan”.</p>") +
    "<h3 class=\"sub-h\">Hours and takes per day <span class=\"meta\">(number above each bar = takes)</span></h3><div class=\"tscroll\"><svg viewBox=\"0 0 " + (all.length * bw + 4) + " " + H + "\" width=\"" + (all.length * bw + 4) + "\" height=\"" + H + "\" role=\"img\" aria-label=\"Hours per day\">" + bars + "</svg></div>" +
    "<h3 class=\"sub-h\">Pause and hold reasons</h3>" + (reasons.length ? "<ul class=\"list\">" + reasons.map(([k, v]) => "<li><span class=\"grow\" dir=\"auto\">" + esc(k) + " " + (v.ex ? "<span class=\"pill ok\">excused</span>" : "") + "</span><span class=\"meta\">" + v.n + "×" + (v.min ? " · " + Math.round(v.min) + " min" : "") + "</span></li>").join("") + "</ul>" : "<p class=\"empty\">No pauses or holds this period.</p>");
}
function kpiMonths() { const out = []; let m = curMonth(); for (let i = 0; i < 12; i++) { out.push(m); m = prevMonth(m); } return out; }
function renderKpi() {
  if (!S.kpiMonth) S.kpiMonth = curMonth();
  const sel = $("#kpiMonth"); if (!sel.options.length || sel.dataset.m !== kpiMonths()[0]) { sel.innerHTML = kpiMonths().map(m => "<option value=\"" + m + "\">" + monthLabel(m) + (m === curMonth() ? " (current)" : "") + "</option>").join(""); sel.dataset.m = kpiMonths()[0]; }
  sel.value = S.kpiMonth;
  $("#kpiHow").innerHTML = "<h2>How the KPI works</h2><div class=\"facts\">" +
    fact("Each task", "A task from Today's plan in SS Tracker. Finished on or before its deadline (and time, if set) = 100%. Finished late, or not finished once the deadline passes = 0%.") +
    fact("The period's KPI", "Tasks on time ÷ all tasks due in the period. All on time = 100%. None on time = 0%.") +
    fact("Period", "From the 25th of one month to the 24th of the next. Tasks belong to the period their deadline falls in.") +
    fact("Upcoming tasks", "Tasks whose deadline hasn't arrived and aren't done yet don't count until they're finished or overdue.") +
    "</div><p class=\"meta\">The current period updates live. Pauses, holds and hours are shown for context; they don't change the KPI.</p>";
  $("#kpiSettingsPanel").hidden = !S.isLead;
  if (S.isLead) {
    const fromSnap = m => { const live = computeKpi(m, S.entries), snap = (S.kpiSnap || {})[m]; if (m !== curMonth() && snap && snap.length && !live.rows.some(r => r.total)) { return { month: m, bounds: periodBounds(m), rows: snap.slice().sort((a, b2) => (b2.enough - a.enough) || ((b2.score ?? -1) - (a.score ?? -1))), saved: true }; } return live; };
    const res = fromSnap(S.kpiMonth), prev = fromSnap(prevMonth(S.kpiMonth));
    const trendMonths = []; { let m = S.kpiMonth; for (let i = 0; i < 6; i++) { trendMonths.unshift(m); m = prevMonth(m); } }
    const trend = {}; trendMonths.forEach(m => fromSnap(m).rows.forEach(r => { (trend[r.name] = trend[r.name] || {})[m] = r.score; }));
    const teamOn = res.rows.reduce((a, r) => a + r.onTime, 0), teamCounted = res.rows.reduce((a, r) => a + r.counted, 0);
    $("#kpiAsOf").textContent = res.rows.length + " editors · team " + (teamCounted ? Math.round(100 * teamOn / teamCounted) + "% on time (" + teamOn + "/" + teamCounted + ")" : "no tasks due yet");
    $("#kpiBody").innerHTML = res.rows.length ? "<div class=\"tscroll\"><table class=\"kpi-table\"><thead><tr><th>#</th><th>Editor</th><th style=\"text-align:end\">KPI</th><th style=\"text-align:end\">Tasks due</th><th style=\"text-align:end\">On time</th><th style=\"text-align:end\">Late</th><th style=\"text-align:end\">Not done</th><th style=\"text-align:end\">Upcoming</th><th style=\"text-align:end\">vs last</th><th style=\"text-align:end\">Hours</th><th style=\"text-align:end\">Pauses</th><th style=\"text-align:end\">Holds</th><th>6 periods</th></tr></thead><tbody>" +
      res.rows.map((r, i) => { const p = prev.rows.find(x => x.name === r.name); const d = p && p.score != null && r.score != null ? Math.round(r.score - p.score) : null;
        return "<tr class=\"clickable" + (S.kpiOpen === r.name ? " on" : "") + "\" data-kpi=\"" + esc(r.name) + "\"><td class=\"n meta\">" + (r.enough ? i + 1 : "") + "</td><td><b>" + esc(r.name) + "</b></td><td class=\"n\">" + (r.score == null ? "<span class=\"meta\">no tasks yet</span>" : "<span class=\"score " + scoreCls(r.score) + "\">" + pctTxt(r.score) + "</span>") + "</td><td class=\"n\">" + r.counted + "</td><td class=\"n\"><span class=\"up\">" + r.onTime + "</span></td><td class=\"n\">" + (r.late ? "<span class=\"down\">" + r.late + "</span>" : "·") + "</td><td class=\"n\">" + (r.missed ? "<span class=\"down\">" + r.missed + "</span>" : "·") + "</td><td class=\"n\">" + (r.pending || "·") + "</td><td class=\"n\">" + (d == null ? "·" : "<span class=\"" + (d >= 0 ? "up" : "down") + "\">" + (d >= 0 ? "▲" : "▼") + Math.abs(d) + "</span>") + "</td><td class=\"n\">" + fmtH(r.hours) + "</td><td class=\"n\">" + r.countedPauses + "<span class=\"meta\"> +" + r.excusedPauses + "</span></td><td class=\"n\">" + r.countedHolds + "<span class=\"meta\"> +" + r.excusedHolds + "</span></td><td>" + sparkline(trendMonths.map(m => (trend[r.name] || {})[m] ?? null)) + "</td></tr>"; }).join("") +
      "</tbody></table></div><p class=\"meta\">Click an editor to see every task and its KPI. Pauses and holds: not excused <span class=\"meta\">+ excused</span>.</p>" : "<p class=\"empty\">No tasks or takes in " + esc(monthLabel(S.kpiMonth)) + ".</p>";
    const open = res.rows.find(r => r.name === S.kpiOpen);
    $("#kpiDetail").hidden = !open; $("#kpiDetail").innerHTML = open ? kpiCard(open, prev.rows.find(x => x.name === open.name)) + kpiDetail(open) : "";
    fillKpiSettings();
    if (!res.saved) saveKpiSnapshots(res);
    if (res.saved) $("#kpiAsOf").textContent += " · saved record";
  } else {
    const row = S.kpiMine[S.kpiMonth], prev = S.kpiMine[prevMonth(S.kpiMonth)];
    $("#kpiAsOf").textContent = row && row.savedAt ? "updated " + new Date(row.savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    $("#kpiBody").innerHTML = !S.myName ? "<p class=\"empty\">Your account isn't linked to an SS Tracker name yet.</p>" : row ? kpiCard(row, prev) : "<p class=\"empty\">No KPI for " + esc(monthLabel(S.kpiMonth)) + " yet. It appears once you have tasks with deadlines in SS Tracker and a lead has opened the dashboard.</p>";
    $("#kpiDetail").hidden = !row; $("#kpiDetail").innerHTML = row ? kpiDetail(row) : "";
  }
}
function fillKpiSettings() {
  const f = $("#kpiSettingsForm"); if (f.dataset.filled === JSON.stringify(S.kpiSettings || {})) return;
  $("#kExcused").value = kpiCfg().excused;
  f.dataset.filled = JSON.stringify(S.kpiSettings || {});
}

/* Leads' browsers save each editor's row so editors can see their own score (rules: an editor reads only their own row). */
const kpiWritten = {};
let kpiSaveTimer = null;
function saveKpiSnapshots(res) {
  clearTimeout(kpiSaveTimer);
  kpiSaveTimer = setTimeout(() => {
    const months = res.month === curMonth() ? [res.month] : [];
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
function showTab(v) { setTimeout(renderResetBtn, 0); const rp = document.getElementById("resetPanel"); if (rp) rp.hidden = true; document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.v === v))); document.querySelectorAll("section.view").forEach(s => s.classList.toggle("on", s.id === "v-" + v)); try { localStorage.setItem("scr-tab", v); } catch (e) { } }
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
  try { await setDoc(doc(db, "dash_settings", "kpi"), { excused: $("#kExcused").value, by: S.email, at: Date.now() }, { merge: true }); $("#kSaveMsg").textContent = "Saved."; } catch (err) { $("#kSaveMsg").textContent = "Couldn't save. Only leads can change this."; }
});
$("#kReset").addEventListener("click", () => { S.kpiSettings = { ...KPI_DEFAULTS }; $("#kpiSettingsForm").dataset.filled = ""; fillKpiSettings(); $("#kSaveMsg").textContent = "Defaults loaded. Click Save to apply."; });
let myKpiUnsubs = [];
function subscribeMyKpi() {
  myKpiUnsubs.splice(0).forEach(u => { try { u(); } catch (e) { } });
  if (S.isLead && S.kpiMonth) { S.kpiSnap = S.kpiSnap || {}; const ms = []; let m = S.kpiMonth; for (let i = 0; i < 6; i++) { ms.push(m); m = prevMonth(m); } ms.forEach(mm => myKpiUnsubs.push(onSnapshot(collection(db, "dash_kpi", mm, "editors"), snap => { S.kpiSnap[mm] = snap.docs.map(d => d.data()); renderKpi(); }, () => { }))); return; }
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
  if (t.dataset.lkHide) { const u = t.dataset.lkHide; confirmIn(t.parentElement, "Remove?", () => setDoc(doc(db, "dash_settings", "links"), { hidden: [...new Set([...(S.hiddenLinks || []), u])] }, { merge: true }).catch(() => { })); }
  if (t.dataset.lkRestore) { const u = t.dataset.lkRestore; setDoc(doc(db, "dash_settings", "links"), { hidden: (S.hiddenLinks || []).filter(x => x !== u) }, { merge: true }).catch(() => { }); }
  if (t.id === "lkHiddenToggle") { S.showHiddenLinks = !S.showHiddenLinks; renderLinks(); }
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


/* ---------- reset: clears filters for everyone; leads can also delete data ---------- */
function currentTab() { const v = document.querySelector("section.view.on"); return v ? v.id.slice(2) : "overview"; }
const TAB_NAME = { overview: "Overview", projects: "Projects", deadlines: "Deadlines", links: "Links", mywork: "My work", kpi: "KPI", team: "Team", search: "search" };
function renderResetBtn() { $("#resetView").textContent = "↺ Reset " + (TAB_NAME[currentTab()] || "view"); }
function clearFilters(t) {
  S.prio = "all";
  if (t === "search") { $("#globalSearch").value = ""; $("#globalSearch").dispatchEvent(new Event("input")); }
  if (t === "projects") { S.projFilter = "all"; S.statusFilter = "open"; $("#projSearch").value = ""; }
  if (t === "deadlines") { S.kindFilter = "all"; S.calMonth = null; }
  if (t === "links") { S.lkFilter = "All"; $("#lkSearch").value = ""; S.showHiddenLinks = false; }
  if (t === "kpi") { S.kpiMonth = curMonth(); S.kpiOpen = null; S.prFilter = { status: "pending", editor: "" }; subscribeMyKpi(); }
  if (t === "team") { $("#teamPick").value = ""; S.planEd = ""; }
}
function freshPeriodTasks() { const end = periodBounds(curMonth()).end; return (S.plans || []).filter(p => p.status === "done" || !p.deadline || p.deadline <= end); }
function resetOptions() {
  return [
    { k: "deadlines", label: "Team deadlines", n: S.deadlines.length, tabs: ["deadlines"], note: "Deadlines added on the dashboard. Timeline and publishing dates come from the sheets and stay." },
    { k: "links", label: "Team links and removed links", n: S.links.length + (S.hiddenLinks || []).length, tabs: ["links"], note: "Deletes links added on the dashboard and brings back any sheet links you removed." },
    { k: "stars", label: "High-priority stars", n: Object.keys(S.flags || {}).length, tabs: ["projects"], note: "Stars set by hand on episodes." },
    { k: "reviews", label: "Pause and hold decisions", n: Object.keys(S.pauseReviews || {}).length, tabs: ["kpi"], note: "Every Accept / Reject goes back to not reviewed." },
    { k: "period", label: "Start a fresh KPI period", n: freshPeriodTasks().length, tabs: ["kpi", "team"], note: "Deletes editors' tasks that are finished or due by " + fmtDay(periodBounds(curMonth()).end) + ", so the current period's KPI starts from zero. Tasks due later stay. All periods' KPI is saved first, so past periods keep their scores." }
  ];
}
function openReset() {
  const t = currentTab(), box = $("#resetPanel");
  if (!box.hidden) { box.hidden = true; return; }
  const opts = S.isLead ? resetOptions() : [];
  box.innerHTML = "<div class=\"reset-box\"><b>Reset " + esc(TAB_NAME[t] || "view") + "</b>" +
    "<label class=\"rs-opt\"><input type=\"checkbox\" checked disabled> <span><b>Clear filters and search</b><span class=\"meta\">Nothing is deleted.</span></span></label>" +
    opts.map(o => "<label class=\"rs-opt" + (o.n ? "" : " none") + "\"><input type=\"checkbox\" data-rs=\"" + o.k + "\"" + (o.tabs.includes(t) && o.n ? " checked" : "") + (o.n ? "" : " disabled") + "> <span><b>" + esc(o.label) + " (" + o.n + ")</b><span class=\"meta\">" + esc(o.note) + "</span></span></label>").join("") +
    "<div class=\"inline-row\" style=\"margin:10px 0 0\"><button class=\"btn\" type=\"button\" id=\"rsGo\">Reset</button><button class=\"btn ghost\" type=\"button\" id=\"rsCancel\">Cancel</button><span class=\"meta\" id=\"rsMsg\"></span></div></div>";
  box.hidden = false;
}
async function snapshotAllPeriods() {
  for (const m of kpiMonths()) {
    const r = computeKpi(m, S.entries);
    for (const row of r.rows) await setDoc(doc(db, "dash_kpi", m, "editors", row.name), { ...row, month: m, final: m < curMonth(), savedAt: Date.now() }).catch(() => { });
  }
}
async function runReset() {
  const t = currentTab(), picks = [...document.querySelectorAll("[data-rs]:checked")].map(c => c.dataset.rs);
  const go = $("#rsGo"), msg = $("#rsMsg");
  if (picks.length && go.dataset.armed !== "1") { go.dataset.armed = "1"; go.textContent = "Click again to delete"; go.classList.add("danger-solid"); msg.textContent = "This can't be undone."; return; }
  go.disabled = true; go.textContent = "Working…";
  const del = (c, id) => deleteDoc(doc(db, c, id)).catch(() => { });
  try {
    if (picks.includes("deadlines")) await Promise.all(S.deadlines.map(d => del("dash_deadlines", d.id)));
    if (picks.includes("links")) { await Promise.all(S.links.map(l => del("dash_links", l.id))); await setDoc(doc(db, "dash_settings", "links"), { hidden: [] }, { merge: true }).catch(() => { }); }
    if (picks.includes("stars")) await Promise.all(Object.keys(S.flags || {}).map(k => del("dash_flags", k)));
    if (picks.includes("reviews")) await Promise.all(Object.keys(S.pauseReviews || {}).map(k => del("dash_pause_reviews", k)));
    if (picks.includes("period")) {
      msg.textContent = "Saving every period's KPI…"; await snapshotAllPeriods();
      const cur = curMonth(), names = computeKpi(cur, S.entries).rows.map(r => r.name);
      msg.textContent = "Deleting tasks…"; await Promise.all(freshPeriodTasks().map(p => del("plans", p.id)));
      await Promise.all(names.map(n => deleteDoc(doc(db, "dash_kpi", cur, "editors", n)).catch(() => { })));
      Object.keys(kpiWritten).forEach(k => { if (k.startsWith(cur + "/")) delete kpiWritten[k]; });
    }
    clearFilters(t);
    $("#resetPanel").hidden = true;
    renderAll();
  } catch (e) { msg.textContent = "Something failed. Only leads can delete data."; go.disabled = false; go.textContent = "Reset"; }
}
$("#resetView").addEventListener("click", openReset);
$("#resetPanel").addEventListener("click", e => { if (e.target.id === "rsGo") runReset(); if (e.target.id === "rsCancel") $("#resetPanel").hidden = true; });
$("#resetPanel").addEventListener("change", () => { const g = $("#rsGo"); if (g) { g.dataset.armed = ""; g.textContent = "Reset"; g.classList.remove("danger-solid"); } });
$("#ssSave").addEventListener("click", saveSheetSetup);
$("#ssLinkAll").addEventListener("click", () => document.querySelectorAll("[data-linktab]").forEach(c => { c.checked = c.closest(".tab-pick").classList.contains("none") ? c.checked : true; }));
$("#ssLinkNone").addEventListener("click", () => document.querySelectorAll("[data-linktab]").forEach(c => { c.checked = false; }));

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
  live(doc(db, "dash_settings", "sources"), snap => { S.srcSettings = snap.exists() ? snap.data() : null; applySheets(); });
  live(doc(db, "dash_settings", "links"), snap => { S.hiddenLinks = snap.exists() ? (snap.data().hidden || []) : []; renderLinks(); });
  live(doc(db, "dash_settings", "kpi"), snap => { S.kpiSettings = snap.exists() ? snap.data() : null; renderKpi(); });
  live(collection(db, "dash_flags"), s => { const f = {}; s.docs.forEach(d => { f[d.id] = true; }); S.flags = f; renderAll(); });
  live(collection(db, "dash_links"), s => { S.links = s.docs.map(d => ({ id: d.id, ...d.data() })); renderLinks(); });
  live(collection(db, "activeTakes"), s => { S.takes = s.docs.map(d => ({ editor: d.id, ...d.data() })).filter(x => x.video); renderOverview(); renderMyWork(); renderTeam(); renderSearch(); });
  if (S.isLead) {
    live(collection(db, "entries"), s => { S.entries = s.docs.map(d => ({ id: d.id, ...d.data() })); renderMyWork(); renderTeam(); renderProjects(); renderKpi(); renderPauseReview(); });
    live(collection(db, "dash_roles"), s => { S.roles = s.docs.map(d => ({ id: d.id, ...d.data() })); renderTeam(); });
    live(collection(db, "plans"), s => { S.plans = s.docs.map(d => ({ id: d.id, ...d.data() })); renderPlans(); renderKpi(); });
    live(collection(db, "dash_pause_reviews"), s => { const m = {}; s.docs.forEach(d => { m[d.id] = d.data(); }); S.pauseReviews = m; renderKpi(); renderPauseReview(); });
  } else if (S.myName) {
    live(query(collection(db, "entries"), where("editor", "==", S.myName)), s => { S.entries = s.docs.map(d => d.data()); renderMyWork(); });
    live(query(collection(db, "plans"), where("editor", "==", S.myName)), s => { S.plans = s.docs.map(d => ({ id: d.id, ...d.data() })); renderPlans(); });
  }
  S.kpiMonth = S.kpiMonth || curMonth();
  subscribeMyKpi();
  renderAll();
});
