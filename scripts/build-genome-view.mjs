#!/usr/bin/env node
/**
 * build-genome-view.mjs — a dependency-free genome viewer generator.
 *
 * Reads the Coltrane genome (standards / agents / types / skills) straight off disk and emits
 * ONE self-contained HTML file with every byte of data + CSS + JS inlined. No frameworks, no
 * network, no fetch(): it opens over file:// offline and just works. Regenerate any time the
 * genome changes:
 *
 *     node scripts/build-genome-view.mjs
 *
 * Writes genome-view.html at the repo root. Commit the generated file so a reader can open it
 * directly, or regenerate from the genome (the source of truth) whenever they like.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── genome readers ───────────────────────────────────────────────────────────

function readJsonDir(rel) {
  const dir = join(ROOT, rel);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
    } catch (e) {
      console.error(`skip ${rel}/${name}: ${e.message}`);
    }
  }
  return out;
}

function readSkills() {
  const dir = join(ROOT, "skills");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const sub = join(dir, name);
    if (!statSync(sub).isDirectory()) continue;
    const metaPath = join(sub, "meta.json");
    if (!existsSync(metaPath)) continue;
    let meta = {};
    try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* ignore */ }
    let summary = "";
    const mdPath = join(sub, "skill.md");
    if (existsSync(mdPath)) {
      const md = readFileSync(mdPath, "utf8");
      // First non-heading, non-empty prose line as a one-liner.
      for (const raw of md.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith("---") || line.startsWith("```")) continue;
        summary = line.replace(/[*_`>]/g, "");
        break;
      }
    }
    out.push({ slug: meta.slug ?? name, skill_type: meta.skill_type, domain: meta.domain,
      tier: meta?.permission?.tier, summary });
  }
  return out;
}

function readPlayers() {
  const dir = join(ROOT, "agents", "players");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const md = readFileSync(join(dir, name), "utf8");
    const slug = name.replace(/\.md$/, "");
    // Grab a charter/description line from frontmatter or first prose paragraph.
    let desc = "";
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const m = fm[1].match(/(?:charter|description|role)\s*:\s*(.+)/i);
      if (m) desc = m[1].trim().replace(/^["']|["']$/g, "");
    }
    if (!desc) {
      for (const raw of md.replace(/^---\n[\s\S]*?\n---/, "").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        desc = line; break;
      }
    }
    out.push({ slug, desc });
  }
  return out;
}

const standards = readJsonDir("standards");
const agents = readJsonDir("agents");
const coreTypes = readJsonDir("core_types");
const domainTypes = readJsonDir("domain_types");
const skills = readSkills();
const players = readPlayers();

// primitive ↔ core-type mapping (from CLAUDE.md — the six cognitive primitives).
const PRIMITIVE_OF_TYPE = {};
for (const c of coreTypes) if (c.slug && c.primitive) PRIMITIVE_OF_TYPE[c.slug] = c.primitive;
for (const d of domainTypes) if (d.slug && d.extends && PRIMITIVE_OF_TYPE[d.extends]) PRIMITIVE_OF_TYPE[d.slug] = PRIMITIVE_OF_TYPE[d.extends];

// The bundle handed to the browser. Trimmed to what the views render.
const DATA = {
  generated_at: new Date().toISOString(),
  primitive_of_type: PRIMITIVE_OF_TYPE,
  counts: {
    standards: standards.length, agents: agents.length,
    core_types: coreTypes.length, domain_types: domainTypes.length,
    skills: skills.length, players: players.length,
  },
  standards: standards.map((s) => ({
    slug: s.slug, domain: s.domain ?? null, status: s.status ?? null,
    description: s.description ?? "",
    agent_slugs: s.agent_slugs ?? [],
    input_types: s.input_types ?? [], output_types: s.output_types ?? [],
    phases: (s.phases ?? []).map((p) => ({
      name: p.name, intent: p.intent ?? "",
      chairs: (p.chairs ?? []).map((c) => ({
        role: c.role ?? "", agent_slug: c.agent_slug ?? "", human: !!c.human,
        depends_on: c.depends_on ?? [],
        input_contract: c.input_contract ?? [], output_contract: c.output_contract ?? [],
        required_skills: c.required_skills ?? [], preferred_skills: c.preferred_skills ?? [],
      })),
    })),
  })),
  agents: agents.map((a) => ({
    slug: a.slug, domain: a.domain ?? null,
    primitives: a.primitives ?? [],
    input_types: a.input_types ?? [], output_types: a.output_types ?? [],
    model_tier: a.model_tier ?? null,
    allowed_tools: a.allowed_tools ?? [],
    behavioral_primitives: a.behavioral_primitives ?? [],
    skill_slugs: a.skill_slugs ?? [],
    description: a.description ?? "",
    identity: a.identity ?? "", method: a.method ?? "",
    constraints: a.constraints ?? [],
  })),
  core_types: coreTypes.map((c) => ({
    slug: c.slug, primitive: c.primitive ?? null, description: c.description ?? "",
    properties: c?.schema?.properties ?? {}, required: c?.schema?.required ?? [],
  })),
  domain_types: domainTypes.map((d) => ({
    slug: d.slug, extends: d.extends ?? null, domain: d.domain ?? null,
    status: d.status ?? null, description: d.description ?? "",
    properties: d?.schema?.properties ?? {}, required_fields: d.required_fields ?? [],
  })),
  skills, players,
};

// ── page ─────────────────────────────────────────────────────────────────────

const CSS = String.raw`
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1c1b19; --muted: #6b6a66;
  --faint: #98968f; --line: #e6e4df; --line-strong: #d6d3cc;
  --accent: #b4531f; --accent-soft: #f2e6dd; --chip: #f1efe9;
  --shadow: 0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.05);
  --radius: 12px;
  --sense: #0e8f8f; --interpret: #2f6fd0; --judge: #b8860b;
  --plan: #7c56c9; --create: #2f9e56; --verify: #c94a5f;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17161a; --panel: #201f24; --ink: #ecebe8; --muted: #a29fa6;
    --faint: #78757c; --line: #302e35; --line-strong: #3d3b43;
    --accent: #e08a54; --accent-soft: #35271f; --chip: #2a2930;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 6px 24px rgba(0,0,0,.35);
    --sense: #3cc7c7; --interpret: #6aa3f0; --judge: #e0b84a;
    --plan: #a684f0; --create: #57c47f; --verify: #ec7d90;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font);
  line-height: 1.5; font-size: 15px; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 24px 96px; }

header.top { padding: 40px 24px 0; max-width: 1180px; margin: 0 auto; }
.brand { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.brand h1 { font-size: 26px; margin: 0; letter-spacing: -.02em; font-weight: 650; }
.brand .sub { color: var(--muted); font-size: 15px; }
.tagline { color: var(--muted); margin: 10px 0 0; max-width: 720px; }
.meta-line { color: var(--faint); font-size: 12.5px; margin-top: 10px; font-family: var(--mono); }

nav.tabs { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(8px); border-bottom: 1px solid var(--line);
  margin-top: 26px; padding: 0 24px; }
nav.tabs .inner { max-width: 1180px; margin: 0 auto; display: flex; gap: 4px; overflow-x: auto; }
nav.tabs button { appearance: none; border: 0; background: none; color: var(--muted);
  font: inherit; font-size: 14.5px; padding: 13px 14px 12px; cursor: pointer;
  border-bottom: 2px solid transparent; white-space: nowrap; }
nav.tabs button .n { color: var(--faint); font-size: 12px; margin-left: 6px; }
nav.tabs button:hover { color: var(--ink); }
nav.tabs button.active { color: var(--ink); border-bottom-color: var(--accent); font-weight: 550; }

.panel-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
  flex-wrap: wrap; margin: 30px 0 16px; }
.panel-head h2 { font-size: 19px; margin: 0; font-weight: 600; letter-spacing: -.01em; }
.panel-head p { margin: 4px 0 0; color: var(--muted); font-size: 14px; max-width: 640px; }
.controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.controls input, .controls select { font: inherit; font-size: 13.5px; padding: 7px 11px;
  border: 1px solid var(--line-strong); border-radius: 8px; background: var(--panel); color: var(--ink); }
.controls input { min-width: 200px; }

/* chips + badges */
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; line-height: 1;
  padding: 4px 8px; border-radius: 999px; background: var(--chip); color: var(--muted);
  white-space: nowrap; font-family: var(--mono); }
.chip.mono { font-family: var(--mono); }
.badge-prim { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
  letter-spacing: .04em; padding: 3px 8px; border-radius: 999px; text-transform: uppercase;
  color: #fff; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.type-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px;
  padding: 4px 9px; border-radius: 7px; background: var(--chip); font-family: var(--mono);
  border: 1px solid var(--line); }
.seat { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 550;
  padding: 3px 9px; border-radius: 7px; background: var(--accent-soft); color: var(--accent);
  font-family: var(--mono); }
.seat.human { background: var(--chip); color: var(--ink); }

/* grid + table */
table.overview { width: 100%; border-collapse: collapse; background: var(--panel);
  border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
table.overview th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--faint); font-weight: 600; padding: 12px 16px; border-bottom: 1px solid var(--line);
  cursor: pointer; user-select: none; white-space: nowrap; }
table.overview th:hover { color: var(--muted); }
table.overview th .arrow { opacity: .5; font-size: 10px; }
table.overview td { padding: 13px 16px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.overview tr:last-child td { border-bottom: 0; }
table.overview tbody tr { cursor: pointer; }
table.overview tbody tr:hover { background: color-mix(in srgb, var(--accent-soft) 40%, transparent); }
.t-slug { font-family: var(--mono); font-weight: 600; font-size: 13.5px; color: var(--ink); }
.t-purpose { color: var(--muted); font-size: 13px; max-width: 420px; display: -webkit-box;
  -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.t-seats { display: flex; gap: 5px; flex-wrap: wrap; }
.num { text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 16px 17px; box-shadow: var(--shadow); cursor: pointer; transition: border-color .12s, transform .12s; }
.card:hover { border-color: var(--line-strong); transform: translateY(-1px); }
.card h3 { margin: 0; font-size: 15.5px; font-family: var(--mono); font-weight: 600; letter-spacing: -.01em; }
.card .card-sub { color: var(--faint); font-size: 12px; margin-top: 2px; }
.card .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 11px; }
.card p.desc { color: var(--muted); font-size: 13px; margin: 11px 0 0; }
.io { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 11px; font-size: 12px; color: var(--faint); }
.arrow-io { color: var(--faint); }

.section-label { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--faint); font-weight: 650; margin: 30px 0 12px; }

/* phase flow */
.flow { display: flex; gap: 0; align-items: stretch; overflow-x: auto; padding: 6px 2px 14px; }
.phase { min-width: 250px; flex: 1 1 250px; background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 14px 15px; box-shadow: var(--shadow); position: relative; }
.phase + .phase { margin-left: 30px; }
.phase + .phase::before { content: "→"; position: absolute; left: -24px; top: 50%;
  transform: translateY(-50%); color: var(--faint); font-size: 18px; }
.phase .pname { font-family: var(--mono); font-weight: 650; font-size: 13.5px; }
.phase .pnum { color: var(--faint); font-size: 11px; font-weight: 600; }
.phase .pintent { color: var(--muted); font-size: 12.5px; margin: 8px 0 12px; }
.chair { border-top: 1px dashed var(--line); padding-top: 10px; margin-top: 10px; }
.chair:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.chair .crole { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
.chair .contracts { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; font-size: 12px; }
.contract-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.contract-line .lbl { color: var(--faint); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .04em; width: 34px; flex: none; }

/* detail modal */
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 50; display: none;
  align-items: flex-start; justify-content: center; padding: 40px 20px; overflow-y: auto; }
.overlay.open { display: flex; }
.detail { background: var(--bg); width: 100%; max-width: 860px; border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,.35); border: 1px solid var(--line); }
.detail-head { position: sticky; top: 0; background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(6px); padding: 20px 26px 16px; border-bottom: 1px solid var(--line);
  border-radius: 16px 16px 0 0; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.detail-head h2 { margin: 0; font-size: 20px; font-family: var(--mono); font-weight: 650; letter-spacing: -.01em; }
.detail-head .dmeta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
.detail-body { padding: 22px 26px 32px; }
.detail-body h4 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint);
  font-weight: 650; margin: 24px 0 10px; }
.detail-body h4:first-child { margin-top: 0; }
.detail-body p.long { color: var(--ink); white-space: pre-wrap; margin: 0; font-size: 14px; }
.detail-body .method { color: var(--ink); white-space: pre-wrap; margin: 0; font-size: 13.5px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; line-height: 1.7; }
ul.clean { margin: 0; padding-left: 18px; }
ul.clean li { margin: 5px 0; font-size: 13.5px; color: var(--ink); }
.close-x { appearance: none; border: 1px solid var(--line-strong); background: var(--panel); color: var(--muted);
  width: 32px; height: 32px; border-radius: 8px; font-size: 18px; cursor: pointer; line-height: 1; flex: none; }
.close-x:hover { color: var(--ink); }

/* fields table for types */
table.fields { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 4px; }
table.fields th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--faint); font-weight: 600; padding: 7px 10px; border-bottom: 1px solid var(--line); }
table.fields td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.fields tr:last-child td { border-bottom: 0; }
.fname { font-family: var(--mono); font-weight: 600; font-size: 12.5px; }
.ftype { font-family: var(--mono); color: var(--muted); font-size: 12px; }
.req { color: var(--verify); font-size: 11px; font-weight: 600; }

/* glossary */
.gloss { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.gcard { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 18px 19px; box-shadow: var(--shadow); }
.gcard h3 { margin: 0 0 8px; font-size: 15px; letter-spacing: -.01em; }
.gcard p { margin: 0; color: var(--muted); font-size: 13.5px; }
.gcard p + p { margin-top: 9px; }
.gcard code { font-family: var(--mono); font-size: 12px; background: var(--chip); padding: 1px 5px; border-radius: 4px; color: var(--ink); }
.prim-legend { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-top: 4px; }
.prim-legend .pl { display: flex; align-items: center; gap: 10px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 13px; }
.prim-legend .pl .txt b { font-size: 13px; } .prim-legend .pl .txt span { color: var(--muted); font-size: 12px; }

.empty { color: var(--faint); font-size: 13.5px; padding: 30px; text-align: center; }
.hidden { display: none !important; }
.footer { color: var(--faint); font-size: 12px; margin-top: 40px; text-align: center; }
`;

// The client script is a template string; DATA is injected as JSON. No network, no deps.
const JS = String.raw`
const D = window.__GENOME__;
const PRIM = { SENSE:'--sense', INTERPRET:'--interpret', JUDGE:'--judge', PLAN:'--plan', CREATE:'--create', VERIFY:'--verify' };
const PRIM_OUT = { SENSE:'Signal', INTERPRET:'Interpretation', JUDGE:'Judgment', PLAN:'Plan', CREATE:'Artifact', VERIFY:'Verdict' };
const esc = (s) => String(s==null?'':s).replace(/[&<>"]/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const primColor = (p) => 'var(' + (PRIM[p]||'--muted') + ')';
const primOfType = (t) => D.primitive_of_type[t] || null;

function typeChip(t) {
  const p = primOfType(t);
  const dot = p ? '<span class="dot" style="background:'+primColor(p)+'"></span>' : '';
  return '<span class="type-chip">'+dot+esc(t)+'</span>';
}
function primBadge(p) {
  return '<span class="badge-prim" style="background:'+primColor(p)+'">'+esc(p)+'</span>';
}
function seatChip(c) {
  if (c.human || c.agent_slug === '') return '<span class="seat human">◇ human</span>';
  return '<span class="seat">'+esc(c.agent_slug)+'</span>';
}

// unique seats used by a standard (agent slugs across chairs, + human)
function standardSeats(s) {
  const set = []; let human = false;
  for (const ph of s.phases) for (const c of ph.chairs) {
    if (c.human || c.agent_slug === '') human = true;
    else if (c.agent_slug && !set.includes(c.agent_slug)) set.push(c.agent_slug);
  }
  return { agents: set, human };
}
function oneLine(s) { return (s||'').replace(/\s+/g,' ').trim(); }

/* ── tabs ── */
const TABS = ['standards','agents','types','skills','glossary'];
function showTab(name) {
  for (const t of TABS) {
    document.getElementById('tab-'+t).classList.toggle('hidden', t!==name);
    document.getElementById('btn-'+t).classList.toggle('active', t===name);
  }
  if (location.hash !== '#'+name) history.replaceState(null,'','#'+name);
  window.scrollTo({top:0});
}

/* ── standards ── */
let stSort = { key:'slug', dir:1 };
function renderStandards() {
  const q = (document.getElementById('st-search').value||'').toLowerCase();
  const dom = document.getElementById('st-domain').value;
  let rows = D.standards.filter(s => {
    if (dom && s.domain !== dom) return false;
    if (!q) return true;
    const hay = (s.slug+' '+(s.domain||'')+' '+s.description).toLowerCase();
    return hay.includes(q);
  });
  const k = stSort.key;
  rows.sort((a,b) => {
    let av, bv;
    if (k==='phases') { av=a.phases.length; bv=b.phases.length; }
    else if (k==='seats') { av=standardSeats(a).agents.length; bv=standardSeats(b).agents.length; }
    else { av=(a[k]||'').toString().toLowerCase(); bv=(b[k]||'').toString().toLowerCase(); }
    return (av<bv?-1:av>bv?1:0)*stSort.dir;
  });
  const arrow = (key) => stSort.key===key ? '<span class="arrow">'+(stSort.dir>0?'▲':'▼')+'</span>' : '';
  let html = '<table class="overview"><thead><tr>'+
    '<th data-k="slug">Standard '+arrow('slug')+'</th>'+
    '<th data-k="domain">Domain '+arrow('domain')+'</th>'+
    '<th data-k="phases" style="text-align:center">Phases '+arrow('phases')+'</th>'+
    '<th data-k="seats">Seats '+arrow('seats')+'</th>'+
    '<th>Purpose</th></tr></thead><tbody>';
  if (!rows.length) html += '<tr><td colspan="5" class="empty">No standards match.</td></tr>';
  for (const s of rows) {
    const seats = standardSeats(s);
    const seatChips = seats.agents.map(a=>'<span class="chip mono">'+esc(a)+'</span>').join('') +
      (seats.human?'<span class="chip">◇ human</span>':'');
    html += '<tr data-slug="'+esc(s.slug)+'">'+
      '<td><span class="t-slug">'+esc(s.slug)+'</span>'+(s.status&&s.status!=='active'?' <span class="chip">'+esc(s.status)+'</span>':'')+'</td>'+
      '<td><span class="chip">'+esc(s.domain||'—')+'</span></td>'+
      '<td class="num">'+s.phases.length+'</td>'+
      '<td><div class="t-seats">'+(seatChips||'<span class="chip">—</span>')+'</div></td>'+
      '<td class="t-purpose">'+esc(oneLine(s.description)||'—')+'</td></tr>';
  }
  html += '</tbody></table>';
  const el = document.getElementById('st-table'); el.innerHTML = html;
  el.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
    const key = th.dataset.k;
    if (stSort.key===key) stSort.dir*=-1; else { stSort.key=key; stSort.dir=1; }
    renderStandards();
  });
  el.querySelectorAll('tbody tr[data-slug]').forEach(tr => tr.onclick = () => openStandard(tr.dataset.slug));
}

function openStandard(slug) {
  const s = D.standards.find(x=>x.slug===slug); if (!s) return;
  let body = '';
  if (s.description) body += '<h4>What it does</h4><p class="long">'+esc(s.description)+'</p>';
  body += '<h4>Pipeline — '+s.phases.length+' phase'+(s.phases.length===1?'':'s')+', in order</h4>';
  body += '<div class="flow">';
  s.phases.forEach((ph,i) => {
    body += '<div class="phase"><div><span class="pnum">PHASE '+(i+1)+'</span><br><span class="pname">'+esc(ph.name)+'</span></div>';
    if (ph.intent) body += '<div class="pintent">'+esc(oneLine(ph.intent))+'</div>';
    for (const c of ph.chairs) {
      body += '<div class="chair"><div class="crole">'+esc(c.role||'—')+' '+seatChip(c)+'</div>';
      body += '<div class="contracts">';
      if (c.input_contract.length) body += '<div class="contract-line"><span class="lbl">in</span>'+c.input_contract.map(typeChip).join('')+'</div>';
      if (c.output_contract.length) body += '<div class="contract-line"><span class="lbl">out</span>'+c.output_contract.map(typeChip).join('')+'</div>';
      const sk = [...c.required_skills.map(x=>[x,'req']), ...c.preferred_skills.map(x=>[x,'pref'])];
      if (sk.length) body += '<div class="contract-line"><span class="lbl">skill</span>'+sk.map(([x,k])=>'<span class="chip mono">'+esc(x)+(k==='pref'?' ·pref':'')+'</span>').join('')+'</div>';
      body += '</div></div>';
    }
    body += '</div>';
  });
  body += '</div>';
  const meta = [];
  if (s.domain) meta.push('<span class="chip">'+esc(s.domain)+'</span>');
  if (s.input_types.length) meta.push('<span class="chip">in: '+s.input_types.map(esc).join(', ')+'</span>');
  if (s.output_types.length) meta.push('<span class="chip">out: '+s.output_types.map(esc).join(', ')+'</span>');
  openDetail(s.slug, meta.join(''), body);
}

/* ── agents ── */
function renderAgents() {
  const q = (document.getElementById('ag-search').value||'').toLowerCase();
  const dom = document.getElementById('ag-domain').value;
  let rows = D.agents.filter(a => {
    if (dom && (a.domain||'—') !== dom) return false;
    if (!q) return true;
    return (a.slug+' '+(a.domain||'')+' '+a.primitives.join(' ')+' '+(a.description||'')).toLowerCase().includes(q);
  });
  rows.sort((a,b)=>a.slug<b.slug?-1:1);
  let html = '';
  if (!rows.length) html = '<div class="empty">No agents match.</div>';
  for (const a of rows) {
    const io = (a.input_types.length||a.output_types.length)
      ? '<div class="io">'+(a.input_types.map(typeChip).join('')||'<span class="chip">∅</span>')+'<span class="arrow-io">→</span>'+(a.output_types.map(typeChip).join('')||'<span class="chip">∅</span>')+'</div>' : '';
    html += '<div class="card" data-slug="'+esc(a.slug)+'"><h3>'+esc(a.slug)+'</h3>'+
      '<div class="card-sub">'+esc(a.domain||'domain-agnostic')+(a.model_tier?' · '+esc(a.model_tier):'')+'</div>'+
      '<div class="row">'+a.primitives.map(primBadge).join('')+'</div>'+ io +
      (a.description?'<p class="desc">'+esc(oneLine(a.description))+'</p>':'')+
      '<div class="row">'+a.allowed_tools.slice(0,6).map(t=>'<span class="chip mono">'+esc(t)+'</span>').join('')+
      (a.allowed_tools.length===0?'<span class="chip">no tools · reasoning-only</span>':'')+'</div></div>';
  }
  document.getElementById('ag-cards').innerHTML = html;
  document.querySelectorAll('#ag-cards .card').forEach(c=>c.onclick=()=>openAgent(c.dataset.slug));
}
function openAgent(slug) {
  const a = D.agents.find(x=>x.slug===slug); if (!a) return;
  let body = '';
  body += '<h4>Primitives → outputs</h4><div class="row">'+a.primitives.map(p=>primBadge(p)+' <span class="type-chip" style="margin-right:10px">'+esc(PRIM_OUT[p]||'?')+'</span>').join('')+'</div>';
  if (a.input_types.length||a.output_types.length) body += '<h4>Type flow</h4><div class="io">'+(a.input_types.map(typeChip).join('')||'<span class="chip">∅</span>')+'<span class="arrow-io">→</span>'+(a.output_types.map(typeChip).join('')||'<span class="chip">∅</span>')+'</div>';
  if (a.identity) body += '<h4>Identity</h4><p class="long">'+esc(a.identity)+'</p>';
  if (a.method) body += '<h4>Method</h4><div class="method">'+esc(a.method)+'</div>';
  if (a.constraints.length) body += '<h4>Constraints</h4><ul class="clean">'+a.constraints.map(c=>'<li>'+esc(c)+'</li>').join('')+'</ul>';
  if (a.allowed_tools.length) body += '<h4>Tool grant</h4><div class="row">'+a.allowed_tools.map(t=>'<span class="chip mono">'+esc(t)+'</span>').join('')+'</div>';
  else body += '<h4>Tool grant</h4><p class="long">None — a reasoning-only seat (deny-by-default).</p>';
  if (a.skill_slugs.length) body += '<h4>Skills bound</h4><div class="row">'+a.skill_slugs.map(s=>'<span class="chip mono">'+esc(s)+'</span>').join('')+'</div>';
  const meta = [];
  meta.push('<span class="chip">'+esc(a.domain||'domain-agnostic')+'</span>');
  if (a.model_tier) meta.push('<span class="chip">'+esc(a.model_tier)+' tier</span>');
  a.primitives.forEach(p=>meta.push(primBadge(p)));
  openDetail(a.slug, meta.join(''), body);
}

/* ── types ── */
function fieldsTable(props, required) {
  const keys = Object.keys(props||{});
  if (!keys.length) return '<p class="long" style="color:var(--muted);font-size:13px">No declared properties.</p>';
  let h = '<table class="fields"><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>';
  for (const k of keys) {
    const f = props[k]||{};
    const isReq = (required||[]).includes(k);
    h += '<tr><td><span class="fname">'+esc(k)+'</span>'+(isReq?' <span class="req">req</span>':'')+'</td>'+
      '<td class="ftype">'+esc(f.type||(f.enum?'enum':'—'))+(f.items&&f.items.type?'&lt;'+esc(f.items.type)+'&gt;':'')+'</td>'+
      '<td style="color:var(--muted);font-size:12.5px">'+esc(f.description||'')+'</td></tr>';
  }
  return h+'</tbody></table>';
}
function renderTypes() {
  let html = '<div class="section-label">Core types — the six base shapes, one per cognitive primitive</div>';
  html += '<div class="cards">';
  const order = ['SENSE','INTERPRET','JUDGE','PLAN','CREATE','VERIFY'];
  const core = D.core_types.slice().sort((a,b)=>order.indexOf(a.primitive)-order.indexOf(b.primitive));
  for (const c of core) {
    html += '<div class="card" data-core="'+esc(c.slug)+'"><h3>'+esc(c.slug)+'</h3>'+
      (c.primitive?'<div class="row">'+primBadge(c.primitive)+'</div>':'')+
      '<p class="desc">'+esc(c.description||'')+'</p>'+
      '<div class="card-sub" style="margin-top:10px">'+Object.keys(c.properties||{}).length+' field(s)</div></div>';
  }
  html += '</div>';
  // domain types grouped by domain
  const byDom = {};
  for (const d of D.domain_types) (byDom[d.domain||'—'] ||= []).push(d);
  for (const dom of Object.keys(byDom).sort()) {
    html += '<div class="section-label">'+esc(dom)+' <span style="color:var(--faint);font-weight:400">· '+byDom[dom].length+' type(s)</span></div><div class="cards">';
    for (const d of byDom[dom].sort((a,b)=>a.slug<b.slug?-1:1)) {
      const p = primOfType(d.slug);
      html += '<div class="card" data-domt="'+esc(d.slug)+'"><h3>'+esc(d.slug)+'</h3>'+
        '<div class="card-sub">extends '+esc(d.extends||'?')+(p?'':'')+'</div>'+
        (p?'<div class="row">'+primBadge(p)+'</div>':'')+
        (d.description?'<p class="desc">'+esc(oneLine(d.description))+'</p>':'')+
        '<div class="card-sub" style="margin-top:10px">'+Object.keys(d.properties||{}).length+' field(s) · '+(d.required_fields||[]).length+' required</div></div>';
    }
    html += '</div>';
  }
  document.getElementById('ty-body').innerHTML = html;
  document.querySelectorAll('#ty-body .card[data-core]').forEach(c=>c.onclick=()=>openCore(c.dataset.core));
  document.querySelectorAll('#ty-body .card[data-domt]').forEach(c=>c.onclick=()=>openDomt(c.dataset.domt));
}
function openCore(slug) {
  const c = D.core_types.find(x=>x.slug===slug); if(!c) return;
  let body = '';
  if (c.description) body += '<h4>Description</h4><p class="long">'+esc(c.description)+'</p>';
  body += '<h4>Schema fields</h4>'+fieldsTable(c.properties, c.required);
  openDetail(c.slug, (c.primitive?primBadge(c.primitive):'')+'<span class="chip">core type</span>', body);
}
function openDomt(slug) {
  const d = D.domain_types.find(x=>x.slug===slug); if(!d) return;
  let body = '';
  if (d.description) body += '<h4>Description</h4><p class="long">'+esc(d.description)+'</p>';
  body += '<h4>Schema fields</h4>'+fieldsTable(d.properties, d.required_fields);
  if ((d.required_fields||[]).length) body += '<h4>Required fields</h4><div class="row">'+d.required_fields.map(f=>'<span class="chip mono">'+esc(f)+'</span>').join('')+'</div>';
  const p = primOfType(d.slug);
  const meta = ['<span class="chip">'+esc(d.domain||'—')+'</span>','<span class="chip">extends '+esc(d.extends||'?')+'</span>'];
  if (p) meta.unshift(primBadge(p));
  openDetail(d.slug, meta.join(''), body);
}

/* ── skills ── */
function renderSkills() {
  const rows = D.skills.slice().sort((a,b)=>a.slug<b.slug?-1:1);
  let html = '<div class="cards">';
  for (const s of rows) {
    html += '<div class="card" style="cursor:default"><h3>'+esc(s.slug)+'</h3>'+
      '<div class="card-sub">'+esc(s.skill_type||'skill')+(s.domain?' · '+esc(s.domain):'')+(s.tier!=null?' · tier '+s.tier:'')+'</div>'+
      (s.summary?'<p class="desc">'+esc(s.summary)+'</p>':'')+'</div>';
  }
  html += '</div>';
  if (D.players && D.players.length) {
    html += '<div class="section-label">Base band players <span style="color:var(--faint);font-weight:400">· markdown subagents shipped with the engine</span></div><div class="cards">';
    for (const p of D.players) html += '<div class="card" style="cursor:default"><h3>'+esc(p.slug)+'</h3>'+(p.desc?'<p class="desc">'+esc(oneLine(p.desc))+'</p>':'')+'</div>';
    html += '</div>';
  }
  document.getElementById('sk-body').innerHTML = html;
}

/* ── detail modal ── */
function openDetail(title, metaHtml, bodyHtml) {
  document.getElementById('d-title').textContent = title;
  document.getElementById('d-meta').innerHTML = metaHtml||'';
  document.getElementById('d-body').innerHTML = bodyHtml||'';
  document.getElementById('overlay').classList.add('open');
  document.body.style.overflow='hidden';
  document.querySelector('.detail').scrollTop = 0;
}
function closeDetail() { document.getElementById('overlay').classList.remove('open'); document.body.style.overflow=''; }

/* ── boot ── */
function boot() {
  TABS.forEach(t => document.getElementById('btn-'+t).onclick = ()=>showTab(t));
  document.getElementById('st-search').oninput = renderStandards;
  document.getElementById('st-domain').onchange = renderStandards;
  document.getElementById('ag-search').oninput = renderAgents;
  document.getElementById('ag-domain').onchange = renderAgents;
  document.getElementById('overlay').onclick = (e)=>{ if(e.target.id==='overlay') closeDetail(); };
  document.getElementById('d-close').onclick = closeDetail;
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') closeDetail(); });
  renderStandards(); renderAgents(); renderTypes(); renderSkills();
  const h = (location.hash||'').replace('#','');
  showTab(TABS.includes(h)?h:'standards');
}
boot();
`;

function domainOptions(list, key) {
  const set = new Set();
  for (const x of list) set.add(x[key] || "—");
  return ["<option value=\"\">All domains</option>", ...[...set].sort().map((d) =>
    `<option value="${d === "—" ? "" : d}">${d}</option>`)].join("");
}

const primLegend = coreTypes
  .slice()
  .sort((a, b) => ["SENSE","INTERPRET","JUDGE","PLAN","CREATE","VERIFY"].indexOf(a.primitive) - ["SENSE","INTERPRET","JUDGE","PLAN","CREATE","VERIFY"].indexOf(b.primitive))
  .map((c) => {
    const varName = { SENSE:"--sense", INTERPRET:"--interpret", JUDGE:"--judge", PLAN:"--plan", CREATE:"--create", VERIFY:"--verify" }[c.primitive] || "--muted";
    return `<div class="pl"><span class="dot" style="width:12px;height:12px;background:var(${varName})"></span><div class="txt"><b>${c.primitive}</b> <span>→ ${c.slug}</span></div></div>`;
  }).join("");

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coltrane · Genome Viewer</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="brand">
    <h1>Coltrane Genome</h1>
    <span class="sub">a methodology engine, at a glance</span>
  </div>
  <p class="tagline">Every agent, standard, and type this engine ships with — the shared repertoire a deployment starts from. Browse the workflows, see the shape of each one, and compare them side by side.</p>
  <div class="meta-line">${DATA.counts.standards} standards · ${DATA.counts.agents} agents · ${DATA.counts.core_types + DATA.counts.domain_types} types · ${DATA.counts.skills} skills — generated ${DATA.generated_at}</div>
</header>

<nav class="tabs"><div class="inner">
  <button id="btn-standards">Standards<span class="n">${DATA.counts.standards}</span></button>
  <button id="btn-agents">Agents<span class="n">${DATA.counts.agents}</span></button>
  <button id="btn-types">Types<span class="n">${DATA.counts.core_types + DATA.counts.domain_types}</span></button>
  <button id="btn-skills">Skills<span class="n">${DATA.counts.skills}</span></button>
  <button id="btn-glossary">Glossary</button>
</div></nav>

<main class="wrap">

  <section id="tab-standards">
    <div class="panel-head">
      <div><h2>Standards</h2><p>Multi-phase workflows. Each runs a sequence of phases; each phase seats one or more chairs. Click a row to see the pipeline.</p></div>
      <div class="controls">
        <input id="st-search" type="search" placeholder="Search standards…">
        <select id="st-domain">${domainOptions(standards, "domain")}</select>
      </div>
    </div>
    <div id="st-table"></div>
  </section>

  <section id="tab-agents">
    <div class="panel-head">
      <div><h2>Agents</h2><p>The players seated into chairs. Each carries cognitive primitives, a typed input→output contract, a tool grant, and a method. Click for its full charter.</p></div>
      <div class="controls">
        <input id="ag-search" type="search" placeholder="Search agents…">
        <select id="ag-domain">${domainOptions(agents, "domain")}</select>
      </div>
    </div>
    <div id="ag-cards" class="cards"></div>
  </section>

  <section id="tab-types">
    <div class="panel-head">
      <div><h2>Types</h2><p>The typed schemas passed between chairs. Six core types (one per primitive) sit at the base; domain types extend them. Click for fields.</p></div>
    </div>
    <div id="ty-body"></div>
  </section>

  <section id="tab-skills">
    <div class="panel-head">
      <div><h2>Skills &amp; players</h2><p>Reusable cognitive primitives bound into agents by slug, plus the base band players shipped with the engine.</p></div>
    </div>
    <div id="sk-body"></div>
  </section>

  <section id="tab-glossary">
    <div class="panel-head"><div><h2>Glossary</h2><p>Plain-language guide to the pieces — for reading the genome without knowing the codebase.</p></div></div>

    <div class="section-label">The six cognitive primitives</div>
    <p style="color:var(--muted);margin:0 0 14px;max-width:680px">Every unit of work is one of six moves. Each primitive produces exactly one output type — the colour follows the type everywhere in this viewer.</p>
    <div class="prim-legend">${primLegend}</div>

    <div class="gloss" style="margin-top:26px">
      <div class="gcard"><h3>Standard</h3><p>A multi-phase workflow: the score a run performs. It lists <em>phases</em> in order, and each phase seats one or more <em>chairs</em>. The standard is the shape; a run (a "gig") is one performance of it.</p></div>
      <div class="gcard"><h3>Phase</h3><p>One stage of a standard. A phase carries an <em>intent</em> — what this stage is for — and the chairs that do its work. Phases run in dependency order; a later phase reads the sealed outputs of the ones it depends on.</p></div>
      <div class="gcard"><h3>Chair &amp; seat</h3><p>A <em>chair</em> is a role in a phase, with a typed <code>input → output</code> contract and skill requirements. A <em>seat</em> is who fills it: an <em>agent</em>, or a <em>human</em> (a review/approval gate). The chair is the job; the agent is the player.</p></div>
      <div class="gcard"><h3>Agent</h3><p>A named player defined as content, not glue code. It carries cognitive primitives, the types it consumes and produces, a method, constraints, and a tool grant. Agents swap into chairs; a chair is never a bespoke agent.</p></div>
      <div class="gcard"><h3>Type &amp; contract</h3><p>Data moving between chairs is typed. The <em>input/output contract</em> on a chair names the types it reads and writes, so a phase can only receive what an earlier phase actually produced. Six core types; domain types <em>extend</em> them.</p></div>
      <div class="gcard"><h3>Skill</h3><p>A reusable cognitive technique bound into an agent by slug. Method travels with the player; the institution supplies the data. A chair can <em>require</em> or merely <em>prefer</em> a skill.</p></div>
      <div class="gcard"><h3>The three identity hashes</h3><p><code>content_hash</code> — the bytes themselves. <code>dependency_hash</code> — who it depends on. <code>effective_hash</code> — the binding of the two in a context. Two identical definitions in different contexts get different effective hashes, by design.</p></div>
      <div class="gcard"><h3>Tool grant — deny by default</h3><p>An agent can only touch what its <code>allowed_tools</code> names. Nothing is implicit; an empty grant is a reasoning-only seat. A grant that resolves to no real provider fails closed rather than pretend.</p></div>
      <div class="gcard"><h3>Venue &amp; law</h3><p>A <em>venue</em> is the room a workflow is performed in — a ceiling on capability, never a grant. It can only narrow what a seated agent may do; the effective tools are the agent's grant intersected with the room's.</p></div>
      <div class="gcard"><h3>The sealed ledger</h3><p>Every run appends to a content-addressed ledger: a <code>genome_hash</code> for the structure that ran, and, per output, a <code>content_sha</code> plus the exact inputs it consumed. Provenance is engine-stamped — the chain records what actually happened.</p></div>
    </div>
  </section>

</main>

<div class="footer">Generated from the Coltrane genome by <code style="font-family:var(--mono)">scripts/build-genome-view.mjs</code> — static, offline, dependency-free.</div>

<div class="overlay" id="overlay">
  <div class="detail">
    <div class="detail-head">
      <div><h2 id="d-title"></h2><div class="dmeta" id="d-meta"></div></div>
      <button class="close-x" id="d-close" title="Close (Esc)">×</button>
    </div>
    <div class="detail-body" id="d-body"></div>
  </div>
</div>

<script>window.__GENOME__ = ${JSON.stringify(DATA)};</script>
<script>${JS}</script>
</body>
</html>`;

const outPath = join(ROOT, "genome-view.html");
writeFileSync(outPath, HTML, "utf8");
console.error(`genome-view.html written (${(HTML.length / 1024).toFixed(0)} KB) — ${DATA.counts.standards} standards, ${DATA.counts.agents} agents, ${DATA.counts.core_types + DATA.counts.domain_types} types, ${DATA.counts.skills} skills`);
