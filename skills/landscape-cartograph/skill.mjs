// landscape-cartograph — assemble the landscape map. Deterministic, no model.
//
// This was a model seat and should not have been. A map is a PROJECTION: every fact in it is
// already sealed upstream (verified items, typed relations, fit decisions, attack findings), so
// assembling it is layout, not judgement. As a seat it also failed in a way that proves the point —
// it tried to emit 64 items with every field in one response and hit the 32k output ceiling.
// Deterministic assembly cannot exceed a ceiling it does not have.
//
// Reads its upstream records individually (the merge would collapse same-shaped records), and
// carries every attack finding forward rather than summarising them away.
const arr = (v) => (Array.isArray(v) ? v : []);
const pick = (ctx, type) => (ctx?.upstream ?? []).filter((u) => u?.domain_type === type).map((u) => u.data);

function line(item, fit) {
  const bits = [item.name];
  if (fit?.decision) bits.push(`**${fit.decision}**`);
  if (item.status && item.status !== "unknown") bits.push(item.status);
  if (item.licence && item.licence !== "unknown") bits.push(item.licence);
  return `- ${bits.join(" · ")}\n  ${item.what_it_models ?? ""}${fit?.rationale ? `\n  _why:_ ${fit.rationale}` : ""}\n  ${item.url ?? ""}`;
}

export default function run(input, context) {
  const scans = pick(context, "landscape-scan").length ? pick(context, "landscape-scan") : arr(input?.scans);
  const ver = pick(context, "landscape-verification")[0] ?? input?.verification ?? {};
  const rel = pick(context, "landscape-relations")[0] ?? input?.relations ?? {};
  const fit = pick(context, "landscape-fit")[0] ?? input?.fit ?? {};
  const atk = pick(context, "landscape-attack")[0] ?? input?.attack ?? {};

  const verified = new Set(arr(ver.verified_handles).map(String));
  const fits = new Map(arr(fit.fits).map((f) => [String(f.handle), f]));
  const items = scans.flatMap((s) => arr(s?.data?.items)).filter((i) => verified.has(String(i.handle)));

  const byLayer = new Map();
  for (const it of items) {
    const k = String(it.layer ?? "unsorted");
    if (!byLayer.has(k)) byLayer.set(k, []);
    byLayer.get(k).push(it);
  }

  const layers = [...byLayer.entries()].map(([id, list]) => ({
    id,
    summary: `${list.length} verified`,
    recommended: list.filter((i) => ["adopt", "borrow"].includes(fits.get(String(i.handle))?.decision)).map((i) => String(i.handle)),
    gaps: arr(atk.findings).filter((f) => f.kind === "missing-item" && String(f.target ?? "").includes(id)).map((f) => f.claim),
  }));

  const sections = layers.map(({ id }) => {
    const list = byLayer.get(id);
    const ordered = ["adopt", "borrow", "reference", "ignore", undefined];
    const sorted = [...list].sort((a, b) =>
      ordered.indexOf(fits.get(String(a.handle))?.decision) - ordered.indexOf(fits.get(String(b.handle))?.decision));
    return `## ${id}\n\n${sorted.map((i) => line(i, fits.get(String(i.handle)))).join("\n")}`;
  });

  const findings = arr(atk.findings);
  const bySeverity = (s) => findings.filter((f) => f.severity === s);
  const content = [
    `# Landscape map`,
    `${items.length} verified items across ${layers.length} layers · ${arr(rel.relations).length} relations · ${findings.length} open findings`,
    ...sections,
    `## Relations\n\n${arr(rel.relations).map((r) => `- ${r.from} —${r.rel}→ ${r.to}${r.evidence ? `\n  ${r.evidence}` : ""}`).join("\n")}`,
    `## Open findings\n\n${["blocker", "high", "medium", "note"].map((s) =>
      bySeverity(s).length ? `### ${s}\n${bySeverity(s).map((f) => `- **${f.kind}** ${f.claim}${f.evidence ? `\n  ${f.evidence}` : ""}`).join("\n")}` : "").filter(Boolean).join("\n\n")}`,
    `## Competency questions nothing covers\n\n${arr(fit.uncovered_questions).map((q) => `- ${q}`).join("\n") || "- none"}`,
  ].join("\n\n");

  return {
    id: "landscape-map",
    input_refs: [],
    artifact_type: "landscape-map",
    format: "markdown",
    content,
    validation_criteria: [
      "every item is in the evidence check's verified_handles",
      "every attack finding is carried, none summarised away",
      "uncovered competency questions are listed",
      "assembly is deterministic: no claim is added that is not in a sealed upstream record",
    ],
    layers,
    items,
    relations: arr(rel.relations),
    fits: arr(fit.fits),
    open_findings: findings,
    uncovered_questions: arr(fit.uncovered_questions),
  };
}
