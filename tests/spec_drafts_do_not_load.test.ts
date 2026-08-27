// A DRAFT IS NOT A PROMISE — drafts do not load into the drain genome.
//
// THE SOVEREIGN'S RULING, verbatim option: "Drafts don't load into the drain genome."
//
// Two of production's six load errors were DRAFT standards whose chairs feed an agent a type
// its `input_types` never declared. That is a real composition fault, and the loader was right
// to dislike it — but it was reported as a fault of the DRAIN'S GENOME, and under the
// fail-closed worker it held every gig closed against work that had nothing to do with either
// draft. A draft is a thing being written. Its problems are not the drain's problems.
//
// NOT AN EXCUSE TO STOP CHECKING THEM. `standard_promote` still runs the loader's own
// composition gate, so a draft that cannot compose cannot become active. The trap — found
// while building this, not by a law — is that promote validates against the LOADED genome:
// drop drafts from every collection and a draft becomes `notFound`, so "drafts do not load"
// silently becomes "drafts can NEVER BE PROMOTED", and the one path whose job is to check a
// draft is the only path that cannot see it. Hence `draft_standards`: a separate, REQUIRED
// field on LoadedGenome, so no construction site can forget it and no consumer can confuse
// what the drain runs with what promote inspects.
import { describe, expect, it } from "vitest";
import { reconstructGenome } from "../src/genome_store.js";

const std = (over: Record<string, unknown>) => ({
  slug: "landing-lineage-spec-v0",
  version: 1,
  status: "draft",
  domain: "lineage",
  phases: [],
  input_types: ["design-question"],
  output_types: ["design-brief"],
  ...over,
});

const load = (standards: unknown[]) =>
  reconstructGenome({
    core_types: [], domain_types: [], agents: [], skills: [],
    charts: [], institutions: [], venues: [], standards,
  } as never);

describe("a draft does not load into the drain genome", () => {
  it("a draft is absent from `standards` AND produces no load_error", () => {
    // Both halves matter. Absent, so the drain cannot run it. And SILENT, because an error
    // the operator cannot act on — they never asked for the draft to run — is noise that
    // trains people to skim the list, which is how the six real ones went unread for a day.
    const g = load([std({})]);
    expect(g.standards.has("landing-lineage-spec-v0"), "the drain does not run drafts").toBe(false);
    expect(g.load_errors, "and a draft's own troubles are not the drain's").toEqual([]);
  });

  it("but the draft is still THERE, so promote can find and check it", () => {
    // The trap this exists to close: without its own collection, a draft is notFound to
    // standard_promote and can never be promoted — "drafts do not load" becoming "drafts are
    // never checked", which is worse than the defect it replaced.
    const g = load([std({})]);
    expect(g.draft_standards.get("landing-lineage-spec-v0")).toBeDefined();
  });

  it("an ACTIVE standard still loads, and still gets its composition check", () => {
    const g = load([std({ slug: "active-one", status: "active" })]);
    expect(g.standards.has("active-one")).toBe(true);
    expect(g.draft_standards.has("active-one")).toBe(false);
  });

  it("a draft beside an active one for the same slug: the ACTIVE one, alone", () => {
    const g = load([
      std({ slug: "both", status: "draft", domain: "the-draft" }),
      std({ slug: "both", status: "active", domain: "the-active" }),
    ]);
    expect(g.standards.get("both")?.domain).toBe("the-active");
    expect(g.load_errors, "a draft is not a duplicate of the thing it may become").toEqual([]);
  });

  it("DISPATCH cannot reach a draft — true by construction, and pinned so it stays true", () => {
    // gig_dispatch refuses `retired` and warns on `deprecated`, and has never said anything
    // about `draft` — so before this change a draft standard WAS dispatchable. The hole
    // closes here by construction rather than by a new check, which is the better fix; this
    // law exists so the construction cannot be undone without the consequence being visible.
    const g = load([std({ slug: "draft-only" })]);
    expect(g.standards.get("draft-only"), "dispatch resolves through `standards`, and it is not there")
      .toBeUndefined();
  });
});
