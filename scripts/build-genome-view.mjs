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
const institutions = readJsonDir("institutions");
const venues = readJsonDir("venues");
const charts = readJsonDir("charts");
const evals = readJsonDir("evals");

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
    institutions: institutions.length, venues: venues.length,
    charts: charts.length, evals: evals.length,
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
  // The institutional layer, passed whole (defensively defaulted) so every field renders.
  institutions: institutions.map((raw) => {
    const inst = raw.institution ?? {};
    return {
      slug: inst.slug ?? "?", name: inst.name ?? inst.slug ?? "?",
      kind: inst.kind ?? null, sovereign: !!inst.sovereign,
      wiki_space: inst.wiki_space ?? null,
      laws: (inst.laws ?? []).map((l) => ({
        attributes: l.attributes ?? "", deontic: l.deontic ?? "", aim: l.aim ?? "",
        conditions: l.conditions ?? "", or_else: l.or_else ?? "",
        predicate: l?.check?.predicate ?? "", inputs: l?.check?.inputs ?? {},
        content_hash: l.content_hash ?? "",
      })),
      lineage: inst.lineage ?? [],
      organizations: (raw.organizations ?? []).map((o) => ({
        slug: o.slug, name: o.name ?? o.slug, charter: o.charter ?? null, parent_org: o.parent_org ?? null,
      })),
      agent_records: (raw.agent_records ?? []).map((a) => ({
        slug: a.slug, name: a.name ?? a.slug, kind: a.kind ?? null, status: a.status ?? null,
        is_institution: !!a.is_institution, skill_slugs: a.skill_slugs ?? [],
        named_from_forebear: a.named_from_forebear ?? null,
      })),
      org_members: (raw.org_members ?? []).map((m) => ({ org_slug: m.org_slug, agent_slug: m.agent_slug })),
      chairs: (raw.chairs ?? []).map((c) => ({
        id: c.id ?? "", role: c.role ?? "", function: c.function ?? null, human: !!c.human,
        mission: c.mission ?? "", required_skills: c.required_skills ?? [],
        preferred_skills: c.preferred_skills ?? [], supplies: c.supplies ?? null,
        caps: c.caps ?? [], obligations: c.obligations ?? [],
      })),
      assignments: (raw.assignments ?? []).map((a) => ({
        id: a.id ?? "", chair_id: a.chair_id ?? "", agent_slug: a.agent_slug ?? "", org_slug: a.org_slug ?? "",
        contract_caps: a.contract_caps ?? [], technique_evidence: a.technique_evidence ?? [],
        witnessed_by: a.witnessed_by ?? null,
      })),
      forebears: (raw.forebears ?? []).map((f) => ({
        slug: f.slug, name: f.name ?? f.slug, domain: f.domain ?? null, kind: f.kind ?? null, what_taken: f.what_taken ?? "",
      })),
      lineage_edges: (raw.lineage_edges ?? []).map((e) => ({
        edge_type: e.edge_type ?? "", from_node: e.from_node ?? "", to_node: e.to_node ?? "",
        kind: e.kind ?? null, source: e.source ?? null,
      })),
    };
  }),
  venues: venues.map((v) => ({
    slug: v.slug, institution_slug: v.institution_slug ?? null, flavor: v.flavor ?? null,
    description: v.description ?? "",
    tools: v?.equipment?.tools ?? [],
    ingress: v?.doors?.ingress ?? [], egress: v?.doors?.egress ?? [],
    installs: v.installs ?? [], credential_surface: v.credential_surface ?? [],
    lifecycle_policy: v?.lifecycle?.policy ?? "ephemeral", rebuild_cadence: v?.lifecycle?.rebuild_cadence ?? null,
    responsible_chair: v.responsible_chair ?? null,
  })),
  charts: charts.map((c) => ({
    slug: c.slug, venue: c.venue ?? null,
    budget_usd: c?.budget_envelope?.total_usd ?? null,
    movements: (c.movements ?? []).map((m) => ({
      movement_id: m.movement_id, standard_slug: m.standard_slug ?? null,
      seatings: (m.seatings ?? []).map((s) => ({ chair: s.chair, agent_slug: s.agent_slug })),
      runtime_fills: m.runtime_fills ?? {},
    })),
    edges: (c.edges ?? []).map((e) => ({
      from_movement: e.from_movement, to_movement: e.to_movement, output_type: e.output_type, optional: !!e.optional,
    })),
    approval_gates: (c.approval_gates ?? []).map((g) => ({
      gate_id: g.gate_id, after_movement: g.after_movement, before_movement: g.before_movement,
      chair: g.chair, prompt: g.prompt ?? "",
    })),
  })),
  evals: evals.map((e) => ({
    slug: e.slug, domain: e.domain ?? null, on_type: e.on_type ?? null,
    non_empty_fields: e.non_empty_fields ?? [], asserts: e.asserts ?? "",
  })),
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

/* ── deontic badges (ADICO) ── */
:root { --permitted: #2f9e56; --obliged: #2f6fd0; --forbidden: #c94a5f; }
@media (prefers-color-scheme: dark) { :root { --permitted: #57c47f; --obliged: #6aa3f0; --forbidden: #ec7d90; } }
.deontic { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 700;
  letter-spacing: .05em; padding: 3px 9px; border-radius: 999px; text-transform: uppercase; color: #fff; }
.deontic.permitted { background: var(--permitted); }
.deontic.obliged { background: var(--obliged); }
.deontic.forbidden { background: var(--forbidden); }

/* ── institution sub-nav pills ── */
.pills { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 22px; }
.pills button { appearance: none; font: inherit; font-size: 13.5px; padding: 8px 15px; cursor: pointer;
  border: 1px solid var(--line-strong); border-radius: 999px; background: var(--panel); color: var(--muted); }
.pills button:hover { color: var(--ink); }
.pills button.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 550; }
.pills button .k { opacity: .8; font-size: 11px; margin-left: 6px; }

/* ── stat tiles ── */
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 10px; margin: 0 0 26px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; box-shadow: var(--shadow); }
.stat .v { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.stat .l { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin-top: 2px; }

.inst-title { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 26px 0 4px; }
.inst-title h2 { margin: 0; font-size: 22px; letter-spacing: -.01em; }
.inst-title .slug { font-family: var(--mono); color: var(--faint); font-size: 13px; }

/* ── seating map (institution → org → chair → seat) ── */
.orgcard { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 16px 18px; box-shadow: var(--shadow); margin-bottom: 14px; }
.orgcard .oname { font-size: 15px; font-weight: 600; }
.orgcard .ocharter { color: var(--muted); font-size: 12.5px; margin: 6px 0 12px; }
.seatrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 0; border-top: 1px solid var(--line); }
.seatrow:first-of-type { border-top: 0; }
.seatrow .chairname { font-family: var(--mono); font-weight: 600; font-size: 13px; min-width: 150px; }
.seatrow .arrow-io { color: var(--faint); }

/* ── law card ── */
.lawcard { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 16px 18px; box-shadow: var(--shadow); }
.lawcard .lawhead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.lawcard .aim { font-size: 15px; font-weight: 550; letter-spacing: -.01em; }
.adico { display: grid; grid-template-columns: 92px 1fr; gap: 3px 12px; margin: 12px 0; font-size: 13px; }
.adico dt { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding-top: 2px; }
.adico dd { margin: 0; color: var(--ink); }
.check { background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 11px 13px; margin-top: 10px; }
.check .pred { font-family: var(--mono); font-size: 12.5px; color: var(--ink); word-break: break-word; }
.check .inputs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
.hash { font-family: var(--mono); font-size: 11px; color: var(--faint); }

/* ── generic definition list for chairs / venues ── */
.defcard { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 16px 18px; box-shadow: var(--shadow); }
.defcard .dh { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.defcard .dh h3 { margin: 0; font-family: var(--mono); font-size: 15px; font-weight: 600; }
.defcard .mission { color: var(--muted); font-size: 13px; margin: 9px 0 0; }
.oblig { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.oblig .o { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; }
.oblig .o .txt { color: var(--ink); }
.supplies { background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px;
  margin-top: 10px; font-size: 12.5px; color: var(--muted); }
.evkey { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 12px 0 6px; }
.evidence { border-left: 3px solid var(--line-strong); padding: 3px 0 3px 12px; margin: 8px 0; font-size: 12.5px; }
.evidence .src { font-family: var(--mono); font-size: 11.5px; color: var(--accent); }
.evidence .claim { color: var(--muted); margin-top: 3px; }

/* ── venue / chart ── */
.grid2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
.kv { display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; margin-top: 10px; font-size: 13px; align-items: start; }
.kv dt { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding-top: 3px; }
.kv dd { margin: 0; display: flex; gap: 5px; flex-wrap: wrap; }
.gate { background: var(--accent-soft); border: 1px dashed var(--accent); border-radius: 10px;
  padding: 10px 13px; min-width: 210px; }
.gate .gname { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--accent); }
.gate .gprompt { color: var(--muted); font-size: 11.5px; margin-top: 5px; display: -webkit-box;
  -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.edge-lbl { font-size: 11px; color: var(--muted); }
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

function deonticBadge(d) {
  const cls = ['permitted','obliged','forbidden'].includes(d) ? d : 'obliged';
  return '<span class="deontic '+cls+'">'+esc(d||'—')+'</span>';
}
function capChip(c) {
  if (c && c.grant === 'dispatch') return '<span class="chip mono">⌁ dispatch: '+(c.standards||[]).map(esc).join(', ')+'</span>';
  if (c && c.edge_type) { const scope = c.scope ? Object.entries(c.scope).map(([k,v])=>k+'='+v).join(' ') : ''; return '<span class="chip mono">edge: '+esc(c.edge_type)+(scope?' ('+esc(scope)+')':'')+'</span>'; }
  return '<span class="chip mono">'+esc(JSON.stringify(c))+'</span>';
}

/* ── tabs (built dynamically from what the genome actually holds) ── */
const TABS = window.__TABS__;
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

/* ── institutions ── */
let instSel = 0;
function renderInstitutions() {
  const nav = D.institutions.map((it,i)=>'<button data-i="'+i+'" class="'+(i===instSel?'active':'')+'">'+esc(it.name)+'<span class="k">'+esc(it.kind||'')+'</span></button>').join('');
  document.getElementById('inst-pills').innerHTML = nav;
  document.querySelectorAll('#inst-pills button').forEach(b=>b.onclick=()=>{ instSel=+b.dataset.i; renderInstitutions(); });
  const it = D.institutions[instSel];
  if (!it) { document.getElementById('inst-body').innerHTML = '<div class="empty">No institutions in this genome.</div>'; return; }
  let h = '';
  // title + governance badges
  h += '<div class="inst-title"><h2>'+esc(it.name)+'</h2><span class="slug">'+esc(it.slug)+'</span>'+
    '<span class="chip">'+esc(it.kind||'?')+'</span>'+
    (it.sovereign?'<span class="deontic obliged">sovereign</span>':'<span class="chip">non-sovereign</span>')+
    (it.wiki_space?'<span class="chip mono">wiki: '+esc(it.wiki_space)+'</span>':'')+'</div>';
  // stat tiles
  const stats = [['laws',it.laws.length],['orgs',it.organizations.length],['chairs',it.chairs.length],
    ['seats',it.assignments.length],['agents',it.agent_records.length],['forebears',it.forebears.length],['lineage',it.lineage_edges.length]];
  h += '<div class="stats">'+stats.map(([l,v])=>'<div class="stat"><div class="v">'+v+'</div><div class="l">'+l+'</div></div>').join('')+'</div>';

  // seating map: org → chairs → seated agent
  const chairById = {}; for (const c of it.chairs) chairById[c.id] = c;
  h += '<div class="section-label">Seating map · institution → organization → chair → agent</div>';
  for (const org of it.organizations) {
    h += '<div class="orgcard"><div class="oname">'+esc(org.name)+' <span class="hash">'+esc(org.slug)+(org.parent_org?' · parent: '+esc(org.parent_org):'')+'</span></div>';
    if (org.charter) h += '<div class="ocharter">'+esc(oneLine(org.charter))+'</div>';
    for (const c of it.chairs) {
      const asn = it.assignments.find(a=>a.chair_id===c.id && a.org_slug===org.slug);
      const seat = asn ? '<span class="seat">'+esc(asn.agent_slug)+'</span>'
        : (c.human ? '<span class="seat human">◇ unassigned — human office</span>' : '<span class="chip">unassigned</span>');
      h += '<div class="seatrow"><span class="chairname">'+esc(c.role)+'</span>'+
        (c.function?primBadge(c.function):'')+(c.human?'<span class="chip">◇ human</span>':'')+
        '<span class="arrow-io">→</span>'+seat+'</div>';
    }
    h += '</div>';
  }

  // laws — the centerpiece
  if (it.laws.length) {
    h += '<div class="section-label">Laws · ADICO contracts <span style="color:var(--faint);font-weight:400">· who it binds · what it permits/obliges/forbids · its aim · when · or-else · the check</span></div>';
    h += '<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(420px,1fr))">';
    for (const l of it.laws) {
      h += '<div class="lawcard"><div class="lawhead">'+deonticBadge(l.deontic)+'<span class="aim">'+esc(l.aim)+'</span></div>'+
        '<dl class="adico">'+
        '<dt>attributes</dt><dd>'+esc(l.attributes)+'</dd>'+
        '<dt>conditions</dt><dd>'+esc(l.conditions)+'</dd>'+
        '<dt>or else</dt><dd>'+esc(l.or_else)+'</dd>'+
        '</dl>'+
        '<div class="check"><div class="pred">'+esc(l.predicate)+'</div>'+
        (Object.keys(l.inputs).length?'<div class="inputs">'+Object.entries(l.inputs).map(([k,t])=>'<span class="type-chip">'+esc(k)+': '+esc(t)+'</span>').join('')+'</div>':'')+
        '</div>'+
        (l.content_hash?'<div class="hash" style="margin-top:9px">'+esc(l.content_hash.replace(/^sha256:/,'sha256:').slice(0,23))+'…</div>':'')+
        '</div>';
    }
    h += '</div>';
  }

  // chairs — the offices
  if (it.chairs.length) {
    h += '<div class="section-label">Chairs · the offices (a chair is configuration, not a person)</div><div class="grid2">';
    for (const c of it.chairs) {
      h += '<div class="defcard"><div class="dh"><h3>'+esc(c.role)+'</h3>'+(c.function?primBadge(c.function):'')+(c.human?'<span class="chip">◇ human</span>':'')+'</div>'+
        '<div class="hash">'+esc(c.id)+'</div>'+
        (c.mission?'<p class="mission">'+esc(c.mission)+'</p>':'');
      if (c.required_skills.length||c.preferred_skills.length) h += '<div class="row" style="margin-top:10px">'+c.required_skills.map(s=>'<span class="chip mono">req: '+esc(s)+'</span>').join('')+c.preferred_skills.map(s=>'<span class="chip mono">pref: '+esc(s)+'</span>').join('')+'</div>';
      if (c.caps.length) h += '<div class="evkey">caps</div><div class="row">'+c.caps.map(capChip).join('')+'</div>';
      if (c.supplies) h += '<div class="evkey">supplies</div>'+Object.entries(c.supplies).map(([k,v])=>'<div class="supplies"><b class="hash">'+esc(k)+'</b><br>'+esc(oneLine(String(v)))+'</div>').join('');
      if (c.obligations.length) h += '<div class="evkey">obligations</div><div class="oblig">'+c.obligations.map(o=>'<div class="o">'+deonticBadge(o.deontic)+'<span class="txt">'+esc(o.aim)+'</span></div>').join('')+'</div>';
      h += '</div>';
    }
    h += '</div>';
  }

  // assignments — seatings with evidence
  if (it.assignments.length) {
    h += '<div class="section-label">Assignments · which agent is seated in which chair, and why</div><div class="grid2">';
    for (const a of it.assignments) {
      const chair = chairById[a.chair_id];
      h += '<div class="defcard"><div class="dh"><h3>'+esc(a.agent_slug)+'</h3><span class="arrow-io">→</span><span class="chip mono">'+esc(chair?chair.role:a.chair_id)+'</span></div>'+
        '<div class="kv"><dt>org</dt><dd><span class="chip">'+esc(a.org_slug)+'</span></dd>'+
        (a.witnessed_by?'<dt>witnessed by</dt><dd>'+esc(a.witnessed_by)+'</dd>':'')+
        (a.contract_caps.length?'<dt>contract caps</dt><dd>'+a.contract_caps.map(capChip).join('')+'</dd>':'')+'</dl></div>';
      if (a.technique_evidence.length) { h += '<div class="evkey">technique evidence</div>'; for (const e of a.technique_evidence) h += '<div class="evidence"><div class="src">'+esc(e.source)+'</div><div class="claim">'+esc(e.claim)+'</div></div>'; }
      h += '</div>';
    }
    h += '</div>';
  }

  // agent records
  if (it.agent_records.length) {
    h += '<div class="section-label">Agent records · human and model agents on the same membership contract</div><div class="cards">';
    for (const a of it.agent_records) h += '<div class="card" style="cursor:default"><h3>'+esc(a.slug)+'</h3>'+
      '<div class="card-sub">'+esc(a.name)+'</div>'+
      '<div class="row">'+(a.kind?'<span class="chip">'+esc(a.kind)+'</span>':'')+(a.status?'<span class="chip">'+esc(a.status)+'</span>':'')+(a.is_institution?'<span class="chip">institution</span>':'')+'</div>'+
      (a.named_from_forebear?'<div class="card-sub" style="margin-top:8px">named from forebear · <span class="hash">'+esc(a.named_from_forebear)+'</span></div>':'')+'</div>';
    h += '</div>';
  }

  // forebears
  if (it.forebears.length) {
    h += '<div class="section-label">Forebears · the documented figures a chair’s disposition is anchored in</div><div class="grid2">';
    for (const f of it.forebears) h += '<div class="defcard"><div class="dh"><h3>'+esc(f.name)+'</h3>'+(f.kind?'<span class="chip">'+esc(f.kind)+'</span>':'')+'</div>'+
      '<div class="hash">'+esc(f.slug)+(f.domain?' · '+esc(f.domain):'')+'</div>'+
      (f.what_taken?'<p class="mission">'+esc(f.what_taken)+'</p>':'')+'</div>';
    h += '</div>';
  }

  // lineage edges
  if (it.lineage_edges.length) {
    h += '<div class="section-label">Lineage edges · the cited descent from agent to forebear</div><div class="grid2">';
    for (const e of it.lineage_edges) {
      const s = e.source || {};
      h += '<div class="defcard"><div class="dh"><span class="chip mono">'+esc(e.from_node)+'</span><span class="arrow-io">—'+esc(e.edge_type)+'→</span><span class="chip mono">'+esc(e.to_node)+'</span>'+(e.kind?'<span class="chip">'+esc(e.kind)+'</span>':'')+'</div>';
      const srcRows = [];
      if (s.figure) srcRows.push(['figure', s.figure]);
      if (s.attributed_disposition) srcRows.push(['disposition', s.attributed_disposition]);
      if (s.primary_text) srcRows.push(['primary text', s.primary_text]);
      if (s.scholarship) srcRows.push(['scholarship', s.scholarship]);
      if (Array.isArray(s.recordings)) srcRows.push(['recordings', s.recordings.join('; ')]);
      if (srcRows.length) h += '<div class="kv">'+srcRows.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd style="display:block;color:var(--muted);font-size:12.5px">'+esc(v)+'</dd>').join('')+'</div>';
      h += '</div>';
    }
    h += '</div>';
  }

  document.getElementById('inst-body').innerHTML = h;
}

/* ── venues ── */
function renderVenues() {
  let h = '<div class="grid2">';
  if (!D.venues.length) h += '<div class="empty">No venues in this genome.</div>';
  for (const v of D.venues) {
    h += '<div class="defcard"><div class="dh"><h3>'+esc(v.slug)+'</h3>'+(v.flavor?'<span class="chip">'+esc(v.flavor)+'</span>':'')+'<span class="deontic '+(v.lifecycle_policy==='standing'?'forbidden':'permitted')+'">'+esc(v.lifecycle_policy)+'</span></div>'+
      (v.institution_slug?'<div class="hash">'+esc(v.institution_slug)+'</div>':'')+
      (v.description?'<p class="mission">'+esc(oneLine(v.description))+'</p>':'')+
      '<dl class="kv">'+
      '<dt>equipment</dt><dd>'+(v.tools.length?v.tools.map(t=>'<span class="chip mono">'+esc(t)+'</span>').join(''):'<span class="chip">holds nothing — empty ceiling</span>')+'</dd>'+
      '<dt>ingress</dt><dd>'+(v.ingress.length?v.ingress.map(x=>'<span class="chip mono">'+esc(x)+'</span>').join(''):'<span class="chip">none</span>')+'</dd>'+
      '<dt>egress</dt><dd>'+(v.egress.length?v.egress.map(x=>'<span class="chip mono">'+esc(x)+'</span>').join(''):'<span class="chip">none</span>')+'</dd>'+
      '<dt>installs</dt><dd>'+(v.installs.length?v.installs.map(x=>'<span class="chip mono">'+esc(x.slice(0,20))+'…</span>').join(''):'<span class="chip">none</span>')+'</dd>'+
      '<dt>credentials</dt><dd>'+(v.credential_surface.length?v.credential_surface.map(x=>'<span class="chip mono">'+esc(x)+'</span>').join(''):'<span class="chip">none admitted</span>')+'</dd>'+
      '<dt>lifecycle</dt><dd><span class="chip">'+esc(v.lifecycle_policy)+(v.rebuild_cadence?' · '+esc(v.rebuild_cadence):'')+'</span></dd>'+
      (v.responsible_chair?'<dt>accountable office</dt><dd><span class="chip mono">'+esc(v.responsible_chair)+'</span></dd>':'')+
      '</dl></div>';
  }
  h += '</div>';
  document.getElementById('ve-body').innerHTML = h;
}

/* ── charts ── */
function renderCharts() {
  let h = '';
  if (!D.charts.length) { document.getElementById('ch-body').innerHTML = '<div class="empty">No charts in this genome.</div>'; return; }
  for (const c of D.charts) {
    h += '<div class="inst-title"><h2>'+esc(c.slug)+'</h2>'+
      (c.venue?'<span class="chip">venue: '+esc(c.venue)+'</span>':'')+
      (c.budget_usd!=null?'<span class="chip">budget: $'+esc(c.budget_usd)+'</span>':'')+'</div>';
    // movement flow with edges
    const gatesAfter = {}; for (const g of c.approval_gates) (gatesAfter[g.after_movement] ||= []).push(g);
    const edgesFrom = {}; for (const e of c.edges) (edgesFrom[e.from_movement] ||= []).push(e);
    h += '<div class="flow">';
    c.movements.forEach((m,i) => {
      h += '<div class="phase"><div><span class="pnum">MOVEMENT '+(i+1)+'</span><br><span class="pname">'+esc(m.movement_id)+'</span></div>'+
        '<div class="contracts" style="margin-top:8px"><div class="contract-line"><span class="lbl">runs</span><span class="chip mono">'+esc(m.standard_slug||'?')+'</span></div>';
      if (m.seatings.length) h += '<div class="contract-line"><span class="lbl">seats</span>'+m.seatings.map(s=>'<span class="seat">'+esc(s.agent_slug)+' @ '+esc(s.chair)+'</span>').join('')+'</div>';
      // outgoing edges + gates after this movement
      const outs = edgesFrom[m.movement_id]||[];
      if (outs.length) h += '<div class="evkey">seals → next</div>'+outs.map(e=>'<div class="contract-line"><span class="edge-lbl">→ '+esc(e.to_movement)+'</span>'+typeChip(e.output_type)+(e.optional?'<span class="chip">optional</span>':'')+'</div>').join('');
      h += '</div>';
      const gs = gatesAfter[m.movement_id]||[];
      for (const g of gs) h += '<div class="gate" style="margin-top:10px"><div class="gname">◇ '+esc(g.gate_id)+'</div><div class="hash">human gate · chair '+esc(g.chair)+'</div>'+(g.prompt?'<div class="gprompt">'+esc(g.prompt)+'</div>':'')+'</div>';
      h += '</div>';
    });
    h += '</div>';
  }
  document.getElementById('ch-body').innerHTML = h;
}

/* ── evals ── */
function renderEvals() {
  let h = '<div class="grid2">';
  if (!D.evals.length) h += '<div class="empty">No evals in this genome.</div>';
  for (const e of D.evals) {
    h += '<div class="defcard"><div class="dh"><h3>'+esc(e.slug)+'</h3>'+(e.on_type?'<span class="type-chip">on: '+esc(e.on_type)+'</span>':'')+'</div>'+
      (e.asserts?'<p class="mission">'+esc(e.asserts)+'</p>':'')+
      '<dl class="kv">'+
      (e.domain?'<dt>domain</dt><dd><span class="chip">'+esc(e.domain)+'</span></dd>':'')+
      (e.non_empty_fields.length?'<dt>non-empty fields</dt><dd>'+e.non_empty_fields.map(f=>'<span class="chip mono">'+esc(f)+'</span>').join('')+'</dd>':'')+
      '</dl></div>';
  }
  h += '</div>';
  document.getElementById('ev-body').innerHTML = h;
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
  if (TABS.includes('institutions')) renderInstitutions();
  if (TABS.includes('venues')) renderVenues();
  if (TABS.includes('charts')) renderCharts();
  if (TABS.includes('evals')) renderEvals();
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

// Which institutional tabs the genome actually holds — a class with no files gets no tab.
const hasInst = DATA.counts.institutions > 0;
const hasVen = DATA.counts.venues > 0;
const hasCharts = DATA.counts.charts > 0;
const hasEvals = DATA.counts.evals > 0;
const TAB_LIST = ["standards", "agents", "types",
  ...(hasInst ? ["institutions"] : []), ...(hasVen ? ["venues"] : []),
  ...(hasCharts ? ["charts"] : []), ...(hasEvals ? ["evals"] : []),
  "skills", "glossary"];

const navExtra =
  (hasInst ? `<button id="btn-institutions">Institutions<span class="n">${DATA.counts.institutions}</span></button>` : "") +
  (hasVen ? `<button id="btn-venues">Venues<span class="n">${DATA.counts.venues}</span></button>` : "") +
  (hasCharts ? `<button id="btn-charts">Charts<span class="n">${DATA.counts.charts}</span></button>` : "") +
  (hasEvals ? `<button id="btn-evals">Evals<span class="n">${DATA.counts.evals}</span></button>` : "");

const instSections =
  (hasInst ? `
  <section id="tab-institutions">
    <div class="panel-head"><div><h2>Institutions</h2><p>The institutional layer, whole: the sovereign, its laws (ADICO contracts), organizations, chairs (offices), the agents seated in them, forebears, and the cited lineage. Pick an institution.</p></div></div>
    <div class="pills" id="inst-pills"></div>
    <div id="inst-body"></div>
  </section>` : "") +
  (hasVen ? `
  <section id="tab-venues">
    <div class="panel-head"><div><h2>Venues</h2><p>The configured performance space a workflow is held in — a deny-by-default ceiling, never a grant. Equipment (the tool ceiling), doors (ingress/egress), digest-pinned installs, credential surface, lifecycle, and the accountable office.</p></div></div>
    <div id="ve-body"></div>
  </section>` : "") +
  (hasCharts ? `
  <section id="tab-charts">
    <div class="panel-head"><div><h2>Charts</h2><p>Arrangements: one gig as a performance of many standards. Each movement runs a standard; typed edges carry a sealed output into the next; human approval gates sit between movements; a budget envelope bounds the whole, held in a venue.</p></div></div>
    <div id="ch-body"></div>
  </section>` : "") +
  (hasEvals ? `
  <section id="tab-evals">
    <div class="panel-head"><div><h2>Evals</h2><p>Verdict shapes that judge a gig's outputs — declared with the standard that uses them. Each asserts a property of a named output type.</p></div></div>
    <div id="ev-body"></div>
  </section>` : "");

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
  <div class="meta-line">${DATA.counts.standards} standards · ${DATA.counts.agents} agents · ${DATA.counts.core_types + DATA.counts.domain_types} types · ${DATA.counts.institutions} institutions · ${DATA.counts.venues} venues · ${DATA.counts.charts} charts · ${DATA.counts.skills} skills — generated ${DATA.generated_at}</div>
</header>

<nav class="tabs"><div class="inner">
  <button id="btn-standards">Standards<span class="n">${DATA.counts.standards}</span></button>
  <button id="btn-agents">Agents<span class="n">${DATA.counts.agents}</span></button>
  <button id="btn-types">Types<span class="n">${DATA.counts.core_types + DATA.counts.domain_types}</span></button>
  ${navExtra}
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

  ${instSections}

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
      <div class="gcard"><h3>The sealed ledger</h3><p>Every run appends to a content-addressed ledger: a <code>genome_hash</code> for the structure that ran, and, per output, a <code>content_sha</code> plus the exact inputs it consumed. Provenance is engine-stamped — the chain records what actually happened.</p></div>
    </div>

    <div class="section-label" style="margin-top:34px">The institutional layer</div>
    <p style="color:var(--muted);margin:0 0 14px;max-width:680px">Above the workflow sits the institution: who is bound by what, who answers for it, and where the work is allowed to run.</p>
    <div class="gloss">
      <div class="gcard"><h3>Institution</h3><p>The governing body: a named sovereign with its own <em>laws</em>, organizations, chairs, and seated agents. It is the boundary of authority — capability crosses to another institution only through a witnessed exchange contract, never implicitly.</p></div>
      <div class="gcard"><h3>Organization</h3><p>An operating body inside an institution — where the work actually happens. It carries a <em>charter</em> (what it exists to do) and may sit under a parent org. Agents are members of an org; a seating binds a member into a chair for that org.</p></div>
      <div class="gcard"><h3>Law (ADICO)</h3><p>An institution's rule, written in Crawford &amp; Ostrom's grammar: <em>Attributes</em> (who it binds), <em>Deontic</em> (<span class="deontic permitted">permitted</span> / <span class="deontic obliged">obliged</span> / <span class="deontic forbidden">forbidden</span>), a<em>I</em>m (the governed action), <em>C</em>onditions (when), and <em>O</em>r-else (the consequence). Each law also carries a machine <code>check</code> — a predicate over typed inputs — so it can be enforced, not just recited.</p></div>
      <div class="gcard"><h3>Chair vs seat / assignment</h3><p>A <em>chair</em> is the office: a role, a cognitive <em>function</em>, a mission, its skill floor, its capability grants (<code>caps</code>), and its <em>obligations</em>. It exists whether or not anyone holds it. An <em>assignment</em> (a seat) binds a specific agent into that chair for an org — optionally citing <em>technique evidence</em> for why this player, this office.</p></div>
      <div class="gcard"><h3>Forebear &amp; lineage edge</h3><p>A <em>forebear</em> is a documented figure a chair's disposition is anchored in — with a domain and exactly what working practice is taken (and nothing more). A <em>lineage edge</em> records the descent from an agent to that forebear, and must cite a real source: an uncited lineage is a recollection, not a record.</p></div>
      <div class="gcard"><h3>Venue</h3><p>The configured room a workflow runs in — a <em>ceiling</em>, never a grant. Its <em>equipment</em> is the tool ceiling (an agent's effective tools are its own grant ∩ the room's); <em>doors</em> separate ingress from egress; <em>installs</em> are digest-pinned; the <em>credential surface</em> names which credential classes may be present; a <em>lifecycle</em> (ephemeral by default) and one accountable <em>chair</em> answer for it.</p></div>
      <div class="gcard"><h3>Chart &amp; movement</h3><p>An <em>arrangement</em>: one gig as a performance of several standards. Each <em>movement</em> runs a standard; a typed <em>edge</em> asserts an output sealed by one movement seeds the next; <em>approval gates</em> are human seats between movements; a <em>budget envelope</em> bounds the whole performance, held in a venue.</p></div>
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

<script>window.__GENOME__ = ${JSON.stringify(DATA)}; window.__TABS__ = ${JSON.stringify(TAB_LIST)};</script>
<script>${JS}</script>
</body>
</html>`;

const outPath = join(ROOT, "genome-view.html");
writeFileSync(outPath, HTML, "utf8");
console.error(`genome-view.html written (${(HTML.length / 1024).toFixed(0)} KB) — ${DATA.counts.standards} standards, ${DATA.counts.agents} agents, ${DATA.counts.core_types + DATA.counts.domain_types} types, ${DATA.counts.institutions} institutions, ${DATA.counts.venues} venues, ${DATA.counts.charts} charts, ${DATA.counts.evals} evals, ${DATA.counts.skills} skills`);
