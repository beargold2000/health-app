/* Health log: a phone front end for a private "health" repo.
 *
 * Reads   app/data.json (written by scripts/health.py) and the photos in exercises/img/.
 * Writes  the same plain-text files you'd edit by hand: the grey box in logs/workouts/... and logs/weight.md.
 * Every tap is saved on the phone first, then synced. Mid-workout saves are committed with [skip ci], so
 * GitHub Actions runs once, when you finish. Your repo name and token live only in this phone's storage.
 */
"use strict";

// ------------------------------------------------------------ storage
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  keys() { try { return Object.keys(localStorage); } catch { return []; } },
};
let cfg = LS.get("cfg", { repo: "", token: "", branch: "main" });
let data = LS.get("data", null);
let view = { name: "home" };
const API = "https://api.github.com";

// ------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function todayISO() {
  // Eastern time, same as the script
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function hourET() { return +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()); }
function label(iso) { const d = new Date(iso + "T12:00:00"); return `${DAYS[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`; }
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms); }
function b64decode(b64) { const bin = atob(b64.replace(/\s/g, "")); const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0)); return new TextDecoder().decode(bytes); }
function b64encode(text) { const bytes = new TextEncoder().encode(text); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); }
async function fingerprint(block) { const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(block)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12); }
const BOX = /```text\n([\s\S]*?)```/;
const clean = (s) => String(s || "").replace(/[\r\n]+/g, " ").replace(/`/g, "'").trim();
const fmtLoad = (x) => (x === "bw" || x === "" || x == null ? "bw" : String(+x));

// ------------------------------------------------------------ GitHub
async function gh(path, { method = "GET", body, raw = false } = {}) {
  const r = await fetch(`${API}/repos/${cfg.repo}/${path}`, {
    method, cache: "no-store",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; throw e; }
  return r;
}
const ref = () => `ref=${encodeURIComponent(cfg.branch || "main")}`;
async function getFile(path) {
  const j = await (await gh(`contents/${path}?${ref()}`)).json();
  return { text: b64decode(j.content).replace(/\r\n/g, "\n"), sha: j.sha };
}
async function putFile(path, text, sha, message) {
  const j = await (await gh(`contents/${path}`, { method: "PUT", body: { message, content: b64encode(text), sha, branch: cfg.branch || "main" } })).json();
  return j.content.sha;
}
// Read-modify-write with one retry if the file changed underneath (409/422 = stale sha).
async function editFile(path, change, message) {
  for (let i = 0; i < 3; i++) {
    const { text, sha } = await getFile(path);
    const next = change(text);
    if (next === text) return text;
    try { await putFile(path, next, sha, message); return next; }
    catch (e) { if (![409, 422].includes(e.status) || i === 2) throw e; }
  }
}

async function loadData() {
  const r = await gh(`contents/app/data.json?${ref()}`, { raw: true });
  data = await r.json();
  LS.set("data", data);
  LS.del("extraW"); LS.del("movedAway");          // left over from the old "Do it today" button
  LS.set("dataAt", Date.now());
}

// ------------------------------------------------------------ photos (cached on the phone for no-signal gyms)
const imgURLs = {};
async function imgURL(path) {
  if (imgURLs[path]) return imgURLs[path];
  const key = new Request(`https://photo.cache/${path}`);
  let cache = null;
  try { cache = await caches.open("photos-v1"); } catch {}
  let resp = cache ? await cache.match(key) : null;
  if (!resp) {
    const r = await gh(`contents/${path}?${ref()}`, { raw: true });
    const blob = await r.blob();
    resp = new Response(blob, { headers: { "Content-Type": "image/jpeg" } });
    if (cache) await cache.put(key, resp.clone());
  }
  imgURLs[path] = URL.createObjectURL(await resp.blob());
  return imgURLs[path];
}
function fillPhotos(root = document) {
  root.querySelectorAll("img[data-src]").forEach(async (el) => {
    try { el.src = await imgURL(el.dataset.src); el.removeAttribute("data-src"); } catch {}
  });
}
function prefetch(w) {
  if (!w) return;
  const paths = w.items.flatMap((it) => [...it.imgs, ...it.backups.flatMap((b) => b.imgs)]);
  paths.reduce((p, x) => p.then(() => imgURL(x).catch(() => {})), Promise.resolve());
}

// ------------------------------------------------------------ workout state (one per workout file)
const wk = (path) => "w:" + path;
function allWorkouts() { return data?.workouts || []; }
const findW = (path) => allWorkouts().find((w) => w.path === path);

function freshState(w) {
  const planned = w.status === "planned";
  const items = {};
  for (const it of w.items) {
    const touched = !planned || (it.sym && it.sym !== "=") || it.note || (it.or && it.or.used);
    const s = { sym: touched ? it.sym || "=" : "", load: it.load, note: it.note || "", alt: null };
    if (it.or && it.or.used) {
      const idx = it.backups.findIndex((b) => b.ex === it.or.ex);
      s.alt = { idx, ex: it.or.ex, sym: it.or.sym || "=", load: it.or.load, note: it.or.note || "" };
    }
    items[it.n] = s;
  }
  return {
    status: w.status, knee: w.knee, elbow: w.elbow, energy: w.energy, note: w.session_note || "",
    items, fps: [w.fp], rev: 0, synced: 0, dirty: false, finishedAt: null,
  };
}
// Local copy wins unless the file was changed somewhere else (e.g. in the GitHub app) and nothing here is unsynced.
function stateFor(w) {
  let s = LS.get(wk(w.path), null);
  if (!s || (!s.dirty && !(s.fps || []).includes(w.fp))) { s = freshState(w); LS.set(wk(w.path), s); }
  return s;
}
function saveState(path, s, { soon = true } = {}) {
  s.rev = (s.rev || 0) + 1; s.dirty = true; LS.set(wk(path), s);
  if (soon) scheduleSync();
  renderSync();
}

function repTxt(reps, unit) { return `${reps}${unit === "s" ? "s" : ""}${unit === "rounds" ? " rd" : ""}`; }
function lineFor(prefix, short, width, sets, reps, unit, load, sym, note) {
  const l = `${prefix}${short.padEnd(width)} ${sets}x${repTxt(reps, unit).padEnd(7)} @${fmtLoad(load).padStart(4)}`;
  return sym ? `${l} ${sym}${note ? " " + clean(note) : ""}` : l;
}
function rebuildBox(text, w, s, untouched = "=") {
  const m = text.match(BOX);
  if (!m) throw new Error("This workout file has no grey box. Fix it in the GitHub app.");
  const legend = m[1].split("\n").filter((l) => l.trim().startsWith("#"));
  const out = [...legend, ...(legend.length ? [""] : []), `status: ${s.status}`, `template: ${w.template}`, ""];
  for (const it of w.items) {
    const st = s.items[it.n];
    const a = st.alt;
    out.push(lineFor(`${it.n} `, it.short, 16, it.sets, it.reps, it.unit, st.load, a ? "=" : st.sym || untouched, a ? "" : st.note));
    if (a) {
      const b = it.backups[a.idx];
      out.push(lineFor(" or ", b.short, 14, b.sets, b.reps, b.unit, a.load, a.sym || "=", a.note));
    } else if (it.backups.length) {
      const b = it.backups[0];
      out.push(lineFor(" or ", b.short, 14, b.sets, b.reps, b.unit, b.load, "", ""));
    }
  }
  const num = (v) => (v == null || v === "" ? "" : String(v));
  out.push("", `knee:   ${num(s.knee)}`, `elbow:  ${num(s.elbow)}`, `energy: ${num(s.energy)}`, `note:   ${clean(s.note)}`.trimEnd());
  return text.replace(BOX, () => "```text\n" + out.join("\n") + "\n```");
}

// ------------------------------------------------------------ sync
let syncTimer = null, syncing = false, lastError = "";
function scheduleSync(ms = 15000) { clearTimeout(syncTimer); syncTimer = setTimeout(syncAll, ms); }
function pending() {
  const w = LS.keys().filter((k) => k.startsWith("w:") && LS.get(k, {}).dirty).map((k) => k.slice(2));
  const wq = Object.keys(LS.get("wq", {}));
  return { w, wq, n: w.length + wq.length };
}
async function syncWorkout(path, { final = false } = {}) {
  const w = findW(path); const s = LS.get(wk(path), null);
  if (!w || !s) return;
  const rev = s.rev;
  const untouched = s.untouched || "=";
  const done = s.status !== "planned";
  const msg = done ? `chore(data): log ${w.title} ${w.label}` : `chore(data): ${w.title} ${w.label} in progress [skip ci]`;
  const next = await editFile(path, (t) => rebuildBox(t, w, s, untouched), msg);
  const fp = await fingerprint(next.match(BOX)[1]);
  const cur = LS.get(wk(path), s);
  cur.fps = [...new Set([...(cur.fps || []), fp])].slice(-20);
  cur.synced = Date.now();
  cur.dirty = cur.rev !== rev;
  LS.set(wk(path), cur);
}
async function syncWeights() {
  const q = LS.get("wq", {});
  const dates = Object.keys(q);
  if (!dates.length || !data) return;
  const file = data.weight.file;
  await editFile(file, (t) => dates.reduce((acc, d) => setWeightRow(acc, d, q[d]), t),
    `chore(data): log weigh-in ${dates.map(label).join(", ")}`);
  const now = LS.get("wq", {});
  dates.forEach((d) => { if (now[d] === q[d]) delete now[d]; });
  LS.set("wq", now);
  const local = LS.get("wlocal", {}); dates.forEach((d) => (local[d] = q[d])); LS.set("wlocal", local);
}
function setWeightRow(text, date, val) {
  const m = text.match(BOX);
  if (!m) throw new Error("weight.md has no grey box");
  const lines = m[1].split("\n");
  const row = `${date}  ${val}`;
  const i = lines.findIndex((l) => l.trim().startsWith(date));
  if (i >= 0) lines[i] = row;
  else { const j = lines.findIndex((l) => /^\s*\d{4}-\d{2}-\d{2}/.test(l)); lines.splice(j < 0 ? lines.length : j, 0, row); }
  return text.replace(BOX, () => "```text\n" + lines.join("\n") + "```");
}
async function syncAll() {
  if (syncing || !cfg.token) return;
  if (!navigator.onLine) { renderSync(); return; }
  syncing = true; renderSync();
  try {
    await syncWeights();
    for (const path of pending().w) await syncWorkout(path);
    lastError = "";
  } catch (e) {
    lastError = e.status === 401 ? "Token rejected: check Settings" : e.status === 404 ? "Repo or file not found: check Settings" : "Couldn't sync; will retry";
    scheduleSync(30000);
  } finally { syncing = false; renderSync(); }
}
function renderSync() {
  const el = $("#sync"); if (!el) return;
  const p = pending().n;
  el.className = "sync" + (lastError ? " bad" : p ? " pending" : "");
  el.textContent = syncing ? "Saving…" : lastError ? lastError : p ? (navigator.onLine ? `${p} to sync` : `No signal · saved on phone`) : "Synced";
}
window.addEventListener("online", () => syncAll());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") syncAll();
  else refresh(false);
});

// ------------------------------------------------------------ calendar sync
// Lift days come from Google Calendar. Opening the app asks GitHub to re-read the calendar (the "Update health"
// workflow, which costs no Claude usage), at most every 10 minutes, then reloads the plan about a minute later.
// Needs the key to have "Actions: Read and write"; without it this quietly does nothing and the daily 5:15 am
// run still picks up calendar changes.
async function askCalendarSync() {
  if (!navigator.onLine || Date.now() - LS.get("syncAskedAt", 0) < 10 * 60 * 1000) return;
  if (Date.now() < LS.get("syncOffUntil", 0)) return;
  LS.set("syncAskedAt", Date.now());
  try {
    await gh("actions/workflows/update.yml/dispatches", { method: "POST", body: { ref: cfg.branch || "main" } });
    [75, 150].forEach((sec) => setTimeout(() => refresh(false, true), sec * 1000));
  } catch (e) {
    if (e.status === 403 || e.status === 404) LS.set("syncOffUntil", Date.now() + 24 * 3600 * 1000);
  }
}

// ------------------------------------------------------------ views
function header(title, back) {
  return `<header class="top">
    ${back ? `<button class="icon-btn" data-go="home" aria-label="Back">‹</button>` : ""}
    <h1>${esc(title)}</h1>
    <span id="sync" class="sync"></span>
    ${back ? "" : `<button class="icon-btn" data-act="refresh" aria-label="Refresh">↻</button><button class="icon-btn" data-go="settings" aria-label="Settings">⚙︎</button>`}
  </header>`;
}

function weightSeries() {
  const m = {};
  (data?.weight?.recent || []).forEach((r) => (m[r.date] = r.lb));
  Object.entries(LS.get("wlocal", {})).forEach(([d, v]) => (m[d] = +v));
  Object.entries(LS.get("wq", {})).forEach(([d, v]) => (m[d] = +v));
  return Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, lb]) => ({ date, lb }));
}
function avg7(series, endISO) {
  const end = new Date(endISO + "T12:00:00");
  const v = series.filter((r) => { const d = (end - new Date(r.date + "T12:00:00")) / 864e5; return d >= 0 && d < 7; }).map((r) => r.lb);
  return v.length >= 4 ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function spark(series) {
  const s = series.slice(-30);
  if (s.length < 2) return "";
  const W = 300, H = 56, pad = 4;
  const t0 = new Date(s[0].date).getTime(), t1 = new Date(s[s.length - 1].date).getTime() || t0 + 1;
  const lo = Math.min(...s.map((r) => r.lb)) - 0.5, hi = Math.max(...s.map((r) => r.lb)) + 0.5;
  const x = (r) => pad + ((new Date(r.date).getTime() - t0) / (t1 - t0 || 1)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const pts = s.map((r) => `${x(r).toFixed(1)},${y(r.lb).toFixed(1)}`).join(" ");
  const dots = s.map((r) => `<circle cx="${x(r).toFixed(1)}" cy="${y(r.lb).toFixed(1)}" r="2.4" fill="var(--accent)"/>`).join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Weight, last 30 days">
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${dots}</svg>`;
}

function statusOf(w) { return LS.get(wk(w.path), null)?.status || w.status; }
function openWorkouts() {
  const t = todayISO();
  return allWorkouts().filter((w) => w.date < t && statusOf(w) === "planned");
}

function viewHome() {
  const t = todayISO();
  if (!data) return `${header("Health")}<div class="wrap"><div class="card">Loading your data… If this stays, check Settings.</div></div>`;
  const series = weightSeries();
  const todayW = series.find((r) => r.date === t);
  const a = avg7(series, t);
  const prev = avg7(series, new Date(new Date(t + "T12:00:00") - 7 * 864e5).toISOString().slice(0, 10));
  const todays = allWorkouts().filter((x) => x.date === t);
  const next = allWorkouts().find((x) => x.date > t);
  const upcoming = allWorkouts().filter((x) => x.date > t).slice(todays.length ? 0 : 1, 6);
  const open = openWorkouts();
  const lateW = todays.find((x) => statusOf(x) === "planned");
  const late = lateW && hourET() >= 18;
  const lifts = (data.week || []).filter((x) => { const ww = allWorkouts().find((y) => y.date === x.date); return ["done", "short"].includes(ww ? statusOf(ww) : x.status); }).length;

  return `${header(label(t))}
  <div class="wrap">
    ${late ? `<div class="banner"><b>Today's ${esc(lateW?.title)} isn't finished.</b> Did you go? Tap the toggle below to log it as done, short or skipped.</div>` : ""}
    ${open.map((o) => `<div class="banner"><b>${esc(o.label)} ${esc(o.title)} is still open.</b> <a href="#" data-open="${esc(o.path)}">Log it</a> or mark it skipped.</div>`).join("")}

    <h2>Weight</h2>
    <div class="card">
      <div class="row">
        <input id="wt" class="weight-in grow" type="text" inputmode="decimal" placeholder="lb" value="${todayW ? esc(todayW.lb) : ""}" aria-label="Morning weight in pounds">
        <button class="btn primary" data-act="save-weight" style="min-width:96px">${todayW ? "Update" : "Save"}</button>
      </div>
      <div class="stat">
        <div><b>${a ? a.toFixed(1) : "–"}</b><span>7-day average</span></div>
        <div><b>${a && prev ? (a - prev >= 0 ? "+" : "") + (a - prev).toFixed(1) : "–"}</b><span>vs last week</span></div>
        <div><b>${todayW ? "✓" : "–"}</b><span>today</span></div>
      </div>
      ${spark(series)}
      <div class="small muted">Morning, after the bathroom, before food or water. One day means little; the average is what counts.</div>
    </div>

    <h2>Workout · ${lifts}/${(data.week || []).length} this week${data.phase ? " · " + esc(data.phase) : ""}</h2>
    ${todays.length ? todays.map(todayCard).join("") : `<div class="card"><b>Rest day.</b>${next ? `
      <div class="muted small" style="margin-top:4px">Next: ${esc(next.label)} · ${esc(next.title)} · <a href="#" data-open="${esc(next.path)}">preview</a></div>
` : ""}</div>`}
    ${upcoming.length ? `<h2>Coming up</h2><div class="card list">${upcoming.map((u) => `<a href="#" class="list-row" data-open="${esc(u.path)}">
      <span class="grow"><b>${esc(u.label)}</b> · ${esc(u.title)}${u.moved ? `<br><span class="small muted">${esc(u.moved)}</span>` : ""}</span><span class="muted">›</span></a>`).join("")}</div>` : ""}
    <div class="small muted">Changing a lift day? Move it in Google Calendar; the app picks it up about a minute after you open it.</div>
  </div>`;
}
function todayCard(w) {
  const st = statusOf(w);
  const finished = st !== "planned";
  return `<div class="card">
    <div class="row"><div class="grow"><div class="big">${esc(w.title)}</div><div class="muted small">${esc(w.time)}${w.moved ? " · " + esc(w.moved) : ""}</div></div>
    <span class="pill ${finished ? "done" : ""}">${esc(st)}</span></div>
    <div style="margin-top:12px" class="row">
      <button class="btn primary grow" data-open="${esc(w.path)}">${finished ? "View workout" : progressOf(w) ? "Continue workout" : "Start workout"}</button>
    </div>
    <button class="toggle ${finished ? "on" : ""}" style="margin-top:10px" data-finish="${esc(w.path)}">
      <span>${finished ? `Logged as ${esc(st)} · edit` : "Workout done"}</span><span class="switch"></span></button>
  </div>`;
}
function progressOf(w) { const s = LS.get(wk(w.path), null); return s ? Object.values(s.items).filter((x) => x.sym || x.alt).length : 0; }

function photoHTML(imgs) {
  if (!imgs.length) return `<div class="photos"><div class="ph"></div><div class="ph"></div></div>`;
  return `<div class="photos">${imgs.map((p) => `<img data-src="${esc(p)}" alt="" data-zoom>`).join("")}</div>`;
}
function rxText(x, load) {
  const unit = x.unit === "s" ? "s" : x.unit === "rounds" ? " rounds" : "";
  return `${x.sets} × ${x.reps}${unit}` + (fmtLoad(load) === "bw" ? "" : ` @ ${fmtLoad(load)} lb${x.per ? ` (${x.per})` : ""}`);
}
const MARKS = [["=", "right"], ["+", "easy, go up"], ["-", "missed reps"], ["x", "skipped"]];

function exCard(w, it, s, locked) {
  const st = s.items[it.n];
  const a = st.alt;
  const cur = a ? it.backups[a.idx] : it;
  const sym = a ? a.sym : st.sym;
  const load = a ? a.load : st.load;
  const note = a ? a.note : st.note;
  const notes = cur.notes || [];
  return `<div class="card ex ${sym ? "marked" : ""}" id="ex-${it.n}">
    <div class="ex-head"><span class="ex-num">${it.n}</span><span class="ex-name grow">${esc(cur.name)}</span></div>
    ${a ? `<div class="swapped-tag">Backup for ${esc(it.name)}</div>` : ""}
    <div class="rx">${esc(rxText(cur, load))}${a && cur.first ? " · first time: starting guess" : ""}</div>
    ${photoHTML(cur.imgs)}
    ${cur.how ? `<div class="small muted">${esc(cur.how)}</div>` : ""}
    <ul class="cues">${cur.cues.map((c) => `<li>${esc(c)}</li>`).join("")}
    ${cur.knee ? `<li><b>Knee check:</b> any squeeze over the kneecap → shorten the depth, then log it at the end.</li>` : ""}</ul>
    ${notes.map((n) => `<div class="lastnote">📝 <b>${esc(label(n.date))}:</b> ${esc(n.text)}</div>`).join("")}
    ${locked ? `<div class="small muted" style="margin-top:10px">Logging opens on ${esc(w.label)}.</div>` : `
    <div class="marks" role="group" aria-label="How it went">
      ${MARKS.map(([m, t]) => `<button class="mark ${sym === m ? "sel" : ""}" data-mark="${it.n}" data-v="${m}">${m === "-" ? "−" : m}<small>${t}</small></button>`).join("")}
    </div>
    ${fmtLoad(load) === "bw" ? "" : `<div class="stepper">
      <button data-step="${it.n}" data-d="-1" aria-label="Lighter">−</button>
      <input inputmode="decimal" data-load="${it.n}" value="${esc(fmtLoad(load))}" aria-label="Weight used">
      <button data-step="${it.n}" data-d="1" aria-label="Heavier">+</button>
      <span class="muted small">lb${cur.per ? " " + esc(cur.per) : ""}</span></div>`}
    <textarea class="note" data-note="${it.n}" rows="1" placeholder="Note: seat, setting, how it felt (🎤 on the keyboard to dictate)">${esc(note)}</textarea>
    <div class="swap">${a
      ? `<button data-unswap="${it.n}">↩ Back to ${esc(it.name)}</button>`
      : it.backups.length ? `<button data-swaps="${it.n}">Machine taken? ${it.backups.length} backup${it.backups.length > 1 ? "s" : ""}</button><div class="alt-list" id="alts-${it.n}" hidden>
          ${it.backups.map((b, i) => `<button class="alt-opt" data-swap="${it.n}" data-i="${i}">
            ${b.imgs[0] ? `<img data-src="${esc(b.imgs[0])}" alt="">` : `<div class="ph"></div>`}
            <span><b>${esc(b.name)}</b><br><span class="small muted">${esc(rxText(b, b.load))}${b.notes[0] ? " · " + esc(b.notes[0].text) : ""}</span></span></button>`).join("")}
        </div>` : ""}</div>`}
  </div>`;
}

function viewWorkout(path) {
  const w = findW(path);
  if (!w) return `${header("Workout", true)}<div class="wrap"><div class="card">This workout isn't in the app's window (a week back to a week ahead). Use the GitHub app for it.</div></div>`;
  const s = stateFor(w);
  const locked = w.date > todayISO();
  const marked = (it) => !!(s.items[it.n].sym || s.items[it.n].alt);
  return `${header(`${w.title} · ${w.label}`, true)}
  <div class="wrap">
    <div class="small muted">${esc(w.phase)}${w.easy ? " · Easy week: weights are lighter" : ""}</div>
    ${locked ? `<div class="card"><b>Planned for ${esc(w.label)}.</b> <span class="muted">Logging opens that day.</span>
      <div class="small muted" style="margin-top:6px">Doing it another day? Move the event in Google Calendar; the app catches up about a minute after you open it.</div></div>` : ""}
    <nav class="jump">${w.items.map((it) => `<a href="#ex-${it.n}" data-jump="${it.n}" class="${marked(it) ? "marked" : ""}">${it.n} ${esc(it.short.split(" ")[0])}</a>`).join("")}</nav>
    ${w.items.map((it) => exCard(w, it, s, locked)).join("")}
    <div class="card small muted">Then: ${esc(w.finisher || "stretches")}, 5 min. Short on time? Do 1–3 for 2 sets, mark the rest x, and finish as <b>short</b>. That counts.</div>
  </div>
  ${locked ? "" : `<div class="dock"><div class="dock-in">
    <textarea id="snote" rows="1" placeholder="Workout note (energy, crowd, anything)">${esc(s.note)}</textarea>
    <button class="btn primary" data-finish="${esc(w.path)}">Finish</button></div></div>`}`;
}

function viewSettings() {
  return `${header("Settings", true)}
  <div class="wrap">
    <div class="card">
      <p style="margin-top:0">This app reads and writes your private health repo directly. The repo name and key are saved only on this phone.</p>
      <label class="lbl" for="repo">Repository (owner/name)</label>
      <input id="repo" class="field" autocapitalize="off" autocorrect="off" placeholder="owner/health" value="${esc(cfg.repo)}">
      <label class="lbl" for="token">GitHub key (fine-grained token)</label>
      <input id="token" class="field" type="password" autocapitalize="off" autocorrect="off" placeholder="github_pat_…" value="${esc(cfg.token)}">
      <label class="lbl" for="branch">Branch</label>
      <input id="branch" class="field" autocapitalize="off" value="${esc(cfg.branch || "main")}">
      <div class="row" style="margin-top:16px"><button class="btn primary grow" data-act="save-cfg">Save and test</button></div>
      <p class="small muted">The key only needs <b>Contents: Read and write</b> on the one repo. If the phone is lost, delete the key on GitHub (Settings → Developer settings → Fine-grained tokens).</p>
    </div>
    <div class="card">
      <div class="row wrap-row">
        <button class="btn grow" data-act="refresh">Reload data</button>
        <button class="btn ghost grow" data-act="clear">Clear phone copy</button>
      </div>
      <p class="small muted">"Clear phone copy" drops unsynced changes and cached photos, then reloads from GitHub.</p>
    </div>
  </div>`;
}

// ------------------------------------------------------------ finish sheet
function openFinish(path) {
  const w = findW(path); if (!w) return;
  const s = stateFor(w);
  const f = { status: s.status === "planned" ? "done" : s.status, energy: s.energy, knee: s.knee, elbow: s.elbow, note: s.note, untouched: "=" };
  const untouched = w.items.filter((it) => !s.items[it.n].sym && !s.items[it.n].alt);
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  const chips = (key, vals, labelFn = (v) => v) => `<div class="chips">${vals.map((v) => `<button class="chip ${f[key] === v ? "sel" : ""}" data-f="${key}" data-v="${v}">${labelFn(v)}</button>`).join("")}</div>`;
  const draw = () => {
    bg.innerHTML = `<div class="sheet" role="dialog" aria-label="Finish workout">
      <h3>Finish ${esc(w.title)}</h3>
      <div class="muted small">${esc(w.label)} · about 20 seconds</div>
      <label class="lbl">How did it go?</label>
      <div class="chips">${[["done", "Done"], ["short", "Short (30 min)"], ["skipped", "Skipped on purpose"]].map(([v, t]) => `<button class="chip ${f.status === v ? "sel" : ""}" data-f="status" data-v="${v}">${t}</button>`).join("")}</div>
      ${f.status === "skipped" ? `<p class="small muted">Sick or traveling on purpose doesn't count as a miss. Otherwise, the rule is to make it up the next day or Saturday morning.</p>` : `
      ${untouched.length ? `<label class="lbl">${untouched.length} not marked: ${esc(untouched.map((i) => i.short).join(", "))}</label>
        <div class="chips"><button class="chip ${f.untouched === "=" ? "sel" : ""}" data-f="untouched" data-v="=">Did them as planned</button><button class="chip ${f.untouched === "x" ? "sel" : ""}" data-f="untouched" data-v="x">Skipped them</button></div>` : ""}
      <label class="lbl">Energy (1–5)</label>${chips("energy", [1, 2, 3, 4, 5])}
      <label class="lbl">Knee squeeze? (0–10, leave off if none)</label>${chips("knee", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])}
      <label class="lbl">Elbow pain? (0–10, leave off if none)</label>${chips("elbow", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])}`}
      <label class="lbl" for="fnote">Note for the session</label>
      <textarea id="fnote" class="field" rows="3" placeholder="Crowd, energy, anything (🎤 to dictate)">${esc(f.note)}</textarea>
      <div class="row" style="margin-top:16px">
        <button class="btn ghost" data-f="cancel">Not yet</button>
        <button class="btn primary grow" data-f="save">Save log</button>
      </div>
    </div>`;
  };
  draw();
  bg.addEventListener("click", async (e) => {
    if (e.target === bg) return bg.remove();
    const b = e.target.closest("[data-f]"); if (!b) return;
    f.note = $("#fnote", bg).value;
    const k = b.dataset.f, v = b.dataset.v;
    if (k === "cancel") return bg.remove();
    if (k === "save") {
      const cur = stateFor(w);
      Object.assign(cur, { status: f.status, energy: f.energy ?? null, knee: f.knee ?? null, elbow: f.elbow ?? null, note: f.note, untouched: f.untouched, finishedAt: Date.now() });
      if (f.status === "skipped") Object.values(cur.items).forEach((x) => { if (!x.sym && !x.alt) x.sym = "x"; });
      saveState(w.path, cur, { soon: false });
      bg.remove();
      view = { name: "home" }; render();
      toast(navigator.onLine ? "Logged. Next workout updates in about a minute." : "Saved on the phone. It syncs when you have signal.");
      syncAll();
      return;
    }
    const val = isNaN(+v) ? v : +v;
    f[k] = ["energy", "knee", "elbow"].includes(k) && f[k] === val ? null : val; // tap again to clear
    draw();
  });
  document.body.appendChild(bg);
}

// ------------------------------------------------------------ events
function render() {
  const app = $("#app");
  if (!cfg.token || !cfg.repo) view = { name: "settings" };
  app.innerHTML = view.name === "workout" ? viewWorkout(view.path) : view.name === "settings" ? viewSettings() : viewHome();
  fillPhotos(app);
  renderSync();
  app.querySelectorAll("textarea").forEach(autogrow);
  if (view.name === "home" && data) allWorkouts().filter((x) => x.date === todayISO()).forEach(prefetch);
}
function autogrow(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, window.innerHeight * 0.3) + "px"; }

function editItem(n, fn) {
  const w = findW(view.path); const s = stateFor(w);
  const st = s.items[n];
  fn(st, w.items.find((x) => x.n === n));
  saveState(w.path, s);
  return { w, s };
}
function rerenderCard(n) {
  const w = findW(view.path); const s = stateFor(w);
  const it = w.items.find((x) => x.n === n);
  const old = $(`#ex-${n}`);
  const tmp = document.createElement("div");
  tmp.innerHTML = exCard(w, it, s, false);
  old.replaceWith(tmp.firstElementChild);
  const card = $(`#ex-${n}`);
  fillPhotos(card); card.querySelectorAll("textarea").forEach(autogrow);
  const chip = $(`[data-jump="${n}"]`);
  if (chip) chip.classList.toggle("marked", !!(s.items[n].sym || s.items[n].alt));
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-go],[data-act],[data-open],[data-finish],[data-mark],[data-step],[data-swaps],[data-swap],[data-unswap],[data-zoom],[data-jump]");
  if (!t) return;
  const ds = t.dataset;
  if (ds.go) { view = { name: ds.go }; render(); window.scrollTo(0, 0); return; }
  if (ds.open) { e.preventDefault(); view = { name: "workout", path: ds.open }; render(); window.scrollTo(0, 0); return; }
  if (ds.finish) { const n = $("#snote"); if (n) saveSessionNote(n.value); openFinish(ds.finish); return; }
  if (ds.jump) { e.preventDefault(); $(`#ex-${ds.jump}`)?.scrollIntoView({ behavior: "smooth" }); return; }
  if (ds.zoom !== undefined && t.src) { const z = document.createElement("div"); z.className = "zoom"; z.innerHTML = `<img src="${t.src}" alt="">`; z.onclick = () => z.remove(); document.body.appendChild(z); return; }
  if (ds.mark) {
    const n = +ds.mark;
    editItem(n, (st) => { if (st.alt) st.alt.sym = st.alt.sym === ds.v ? "" : ds.v; else st.sym = st.sym === ds.v ? "" : ds.v; });
    rerenderCard(n); return;
  }
  if (ds.step) {
    const n = +ds.step;
    editItem(n, (st, it) => {
      const step = (st.alt ? it.backups[st.alt.idx].step : it.step) || 5;
      const tgt = st.alt || st;
      const v = Math.max(0, (parseFloat(tgt.load) || 0) + step * +ds.d);
      tgt.load = String(v);
    });
    rerenderCard(n); return;
  }
  if (ds.swaps) { const l = $(`#alts-${ds.swaps}`); l.hidden = !l.hidden; fillPhotos(l); return; }
  if (ds.swap) {
    const n = +ds.swap, i = +ds.i;
    editItem(n, (st, it) => { const b = it.backups[i]; st.alt = { idx: i, ex: b.ex, sym: "", load: b.load, note: "" }; });
    rerenderCard(n); return;
  }
  if (ds.unswap) { const n = +ds.unswap; editItem(n, (st) => (st.alt = null)); rerenderCard(n); return; }
  if (ds.act === "refresh") { await refresh(true); return; }
  if (ds.act === "save-weight") return saveWeight();
  if (ds.act === "save-cfg") return saveCfg();
  if (ds.act === "clear") {
    if (!confirm("Drop the phone copy (including anything not yet synced) and reload from GitHub?")) return;
    LS.keys().filter((k) => k.startsWith("w:") || ["data", "wq", "wlocal"].includes(k)).forEach(LS.del);
    try { await caches.delete("photos-v1"); } catch {}
    data = null; await refresh(true);
  }
});

// Every keystroke is saved on the phone right away (cheap), so a re-draw or a closed app never loses a note.
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.tagName === "TEXTAREA") autogrow(t);
  if (t.dataset.note) { const v = t.value; editItem(+t.dataset.note, (st) => { if (st.alt) st.alt.note = v; else st.note = v; }); }
  if (t.id === "snote") saveSessionNote(t.value);
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.load) {
    const v = t.value.trim();
    if (!/^\d+(\.\d+)?$/.test(v)) { toast("Type a number, like 35"); return rerenderCard(+t.dataset.load); }
    editItem(+t.dataset.load, (st) => { (st.alt || st).load = String(+v); });
  }
});
function saveSessionNote(v) {
  if (view.name !== "workout") return;
  const w = findW(view.path); const s = stateFor(w);
  if (s.note === v) return;
  s.note = v; saveState(w.path, s);
}

function saveWeight() {
  const v = $("#wt").value.trim().replace(",", ".");
  const n = parseFloat(v);
  if (!/^\d{2,3}(\.\d)?$/.test(v) || n < 80 || n > 400) { toast("Type your weight in pounds, one decimal at most"); return; }
  const q = LS.get("wq", {}); q[todayISO()] = String(n); LS.set("wq", q);
  $("#wt").blur();
  render();
  toast(navigator.onLine ? "Saved" : "Saved on the phone; it syncs when you have signal.");
  syncAll();
}

async function saveCfg() {
  cfg = { repo: $("#repo").value.trim().replace(/^https:\/\/github.com\//, "").replace(/\/$/, ""), token: $("#token").value.trim(), branch: $("#branch").value.trim() || "main" };
  LS.set("cfg", cfg);
  try { await loadData(); toast("Connected"); view = { name: "home" }; render(); }
  catch (e) { toast(e.status === 401 ? "GitHub rejected the key" : e.status === 404 ? "Couldn't find app/data.json in that repo" : "Couldn't reach GitHub", 4000); }
}

async function refresh(loud, quiet) {
  if (!cfg.token) return render();
  if (!quiet) askCalendarSync();
  try {
    if (navigator.onLine) await loadData();
    lastError = "";
    if (loud) toast("Up to date");
  } catch (e) { if (loud) toast("Couldn't reach GitHub; showing the phone copy"); }
  // Don't redraw under the user's thumb while they're typing
  if (!document.activeElement || !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) render();
  syncAll();
}

// Keep the bottom bar above the iPhone keyboard
if (window.visualViewport) {
  visualViewport.addEventListener("resize", () => {
    const d = $(".dock"); if (!d) return;
    const off = window.innerHeight - visualViewport.height - visualViewport.offsetTop;
    d.style.bottom = Math.max(0, off) + "px";
  });
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
refresh(false);
