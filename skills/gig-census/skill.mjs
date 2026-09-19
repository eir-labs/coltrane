// What a gig ACTUALLY did (determinism 1.0): read the sealed outputs and the ledger rows for one
// gig_id and count them. This is the evidence half of reconciliation, and it exists so the question
// "what happened" is never put to the agent that did it — a seat asked to recall its own run will
// answer with a story, and a story is what a ledger must not accrue.
//
// What the agent CAN answer — why, and what it would do differently — is the other half, and it is a
// hypothesis marked as one, never a finding.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const readJsonl = (path) => {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* a torn line is not a record */ }
  }
  return out;
};

const ms = (a, b) => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : null);

export default async function run(input) {
  const target = (input && typeof input === "object" && input["gig-target"]) || input || {};
  const gig_id = target.gig_id ? String(target.gig_id) : "";
  if (!gig_id) throw new Error("gig-census: no `gig_id` in the input");

  const outputsDir = target.outputs_dir
    ? String(target.outputs_dir)
    : join(process.env.COLTRANE_OUTPUTS_DIR ?? join(homedir(), ".eir", "coltrane_outputs"), "outputs");
  const ledgerPath = target.ledger_path ? String(target.ledger_path) : join(process.cwd(), ".coltrane", "ledger.jsonl");

  const outPath = join(outputsDir, `${gig_id}.jsonl`);
  if (!existsSync(outPath)) throw new Error(`gig-census: no sealed outputs for gig "${gig_id}" at ${outPath}`);
  const records = readJsonl(outPath);

  // Every sealed record, in order, by the chair that sealed it. A role appearing more than once is an
  // AMEND ROUND, which is the single most informative fact about how a gig went.
  const byRole = new Map();
  const seals = [];
  for (const r of records) {
    const role = r.from_role ?? "(none)";
    const slot = byRole.get(role) ?? { role, agent: r.agent_slug, seals: 0, cost_usd: 0, models: new Set(), types: new Set(), perType: new Map() };
    slot.seals += 1;
    // An AMEND ROUND is the same chair sealing the same TYPE again — not the same chair sealing two
    // different types once each. A builder that seals a change-set and a primer in one round is not a
    // builder that ran twice, and counting it as one would put a failure in the ledger that never
    // happened.
    if (r.domain_type) slot.perType.set(r.domain_type, (slot.perType.get(r.domain_type) ?? 0) + 1);
    if (typeof r.cost_usd === "number") slot.cost_usd += r.cost_usd;
    if (r.model) slot.models.add(r.model);
    if (r.domain_type) slot.types.add(r.domain_type);
    byRole.set(role, slot);
    const d = r.data ?? {};
    seals.push({
      at: r.created_at, role, agent: r.agent_slug, type: r.domain_type,
      cost_usd: typeof r.cost_usd === "number" ? r.cost_usd : null,
      model: r.model ?? null,
      ...(typeof d.pass === "boolean" ? { pass: d.pass } : {}),
      ...(Array.isArray(d.departures) && d.departures.length > 0 ? { departures: d.departures.length } : {}),
    });
  }

  // A verdict that failed, and the departures a maker recorded rather than bridging: the two places a
  // gig says out loud that it did not go cleanly.
  const verdicts = records
    .filter((r) => typeof (r.data ?? {}).pass === "boolean")
    .map((r) => ({ at: r.created_at, role: r.from_role, pass: r.data.pass }));
  const departures = [];
  for (const r of records) {
    for (const dep of (r.data ?? {}).departures ?? []) {
      departures.push({ role: r.from_role, from_step: dep.from_step ?? null, instead: dep.instead ?? null, why: dep.why ?? null });
    }
  }

  const primers = records
    .filter((r) => r.domain_type === "seat-primer")
    .map((r) => ({ role: r.from_role, agent: r.data?.agent_slug, area: r.data?.area, context_tokens: r.data?.context_tokens ?? null, frontier: r.data?.frontier ?? null, files: (r.data?.files ?? []).length }));

  const ledgerRows = readJsonl(ledgerPath).filter((row) => row.gig_id === gig_id);
  const spendRows = ledgerRows.filter((row) => row.kind === "chair_spend");
  const gigRows = ledgerRows.filter((row) => row.kind === "gig");

  const first = records[0]?.created_at ?? null;
  const last = records[records.length - 1]?.created_at ?? null;
  const sealedCost = records.reduce((a, r) => a + (typeof r.cost_usd === "number" ? r.cost_usd : 0), 0);

  return {
    source: `gig-census://${gig_id}`,
    gig_id,
    span: { first, last, duration_ms: ms(first, last) },
    chairs: [...byRole.values()].map((s) => ({
      role: s.role, agent: s.agent, seals: s.seals,
      amend_rounds: Math.max(0, Math.max(...[...s.perType.values()], 1) - 1),
      cost_usd: Number(s.cost_usd.toFixed(4)),
      models: [...s.models], output_types: [...s.types],
    })),
    seals,
    verdicts,
    failed_verdicts: verdicts.filter((v) => v.pass === false).length,
    departures,
    primers,
    spend: {
      sealed_cost_usd: Number(sealedCost.toFixed(4)),
      chair_spend_rows: spendRows.length,
      gig_rows: gigRows.length,
      // A gig row missing while sealed outputs exist means the gig did not complete — the absence IS
      // the signal (#236), so it is reported rather than defaulted to "complete".
      completed: gigRows.length > 0,
    },
  };
}
