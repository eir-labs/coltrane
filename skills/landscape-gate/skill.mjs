// landscape-gate — the hard guard on the landscape map. Deterministic, no model, no network.
//
// A skill-backed CHAIR after the cartographer. Reads its upstream records individually from
// context.upstream (the merged `input` is last-wins and would let one record's fields shadow
// another's): the candidate landscape-map, the landscape-verification, the landscape-attack.
// Seals exactly one record: the gated landscape-map.
//   - evidence gate: an item survives only if its handle is in verified_handles AND it carries
//     at least one evidence entry with a url and a non-empty quote.
//   - relations and fits touching a dropped item are removed with it.
//   - blocker gate: an attack finding of severity "blocker" marks the map BLOCKED (still sealed,
//     so the findings are readable; not ready for type formalisation).
//   - an empty map is EMPTY, never READY. Uncovered competency questions are always carried.
const arr = (v) => (Array.isArray(v) ? v : []);

function pick(input, context, type) {
  const up = context && Array.isArray(context.upstream) ? context.upstream : [];
  const hit = up.find((u) => u && u.domain_type === type);
  if (hit) return hit.data || {};
  const key = { "landscape-map": "map", "landscape-verification": "verification", "landscape-attack": "attack" }[type];
  return (input && input[key]) || {}; // fixtures
}

export default function run(input, context) {
  const map = pick(input, context, "landscape-map");
  const ver = pick(input, context, "landscape-verification");
  const atk = pick(input, context, "landscape-attack");
  const verified = new Set(arr(ver.verified_handles).map(String));
  const kept = [];
  const dropped = [];
  for (const it of arr(map.items)) {
    const handle = String(it?.handle ?? "");
    const ev = arr(it?.evidence).filter((e) => e && typeof e.url === "string" && e.url && typeof e.quote === "string" && e.quote.trim());
    if (!verified.has(handle)) dropped.push({ handle, reason: "not verified by the evidence check" });
    else if (ev.length === 0) dropped.push({ handle, reason: "no evidence with url and quote" });
    else kept.push(it);
  }
  const keptSet = new Set(kept.map((i) => String(i.handle)));
  const findings = arr(atk.findings);
  const blockers = findings.filter((f) => f && f.severity === "blocker").length;
  const status = kept.length === 0 ? "EMPTY" : blockers > 0 ? "BLOCKED" : "READY";
  return {
    id: String(map.id || "landscape-map"),
    input_refs: arr(map.input_refs),
    artifact_type: "landscape-map",
    format: String(map.format || "markdown"),
    content: String(map.content || ""),
    validation_criteria: [
      "every item's handle is in the evidence check's verified_handles",
      "every item carries at least one evidence entry with a url and a quote",
      "relations and fits reference kept items only",
      "READY requires no blocker finding; an empty map is EMPTY",
      "uncovered competency questions are carried, not dropped",
    ],
    layers: arr(map.layers),
    items: kept,
    relations: arr(map.relations).filter((r) => r && keptSet.has(String(r.from)) && keptSet.has(String(r.to))),
    fits: arr(map.fits).filter((f) => f && keptSet.has(String(f.handle))),
    open_findings: findings,
    uncovered_questions: arr(map.uncovered_questions),
    gate: { status, kept: kept.length, dropped, blockers },
  };
}
