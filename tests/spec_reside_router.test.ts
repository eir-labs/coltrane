// RED — LAWS 7, 9 and 10 of WI-3: the work-order router is CODE, the lease token is not a gig
// token, and reside does not fork the gig path.
//
// The verb contract these laws encode is WI-4's, taken from spec.envoy-residency.envoy-binds-the-verbs
// (amendments a-c) rather than guessed:
//   work-order-due       args {}            — a row-routed READ; no pin, the credential is the header
//   work-order-dispatch  args {work_order_id, schedule_ordinal, mode?, input?, pin:{org,venue}}
//   gig_monitor          args {gig_id}
// Every refusal carries `message`; a store refusal also carries `errcode` and, when its message
// cites one, `law_ref`. Re-dispatching a (work_order_id, schedule_ordinal) that already has a
// standing non-terminal gig returns that gig's id — so "once per wake" is safe, not merely polite.
import { describe, it, expect } from "vitest";
import { workOnce } from "../src/worker.js";
import {
  loadReside,
  recordingDeps,
  gigScopedClaim,
  leaseClaim,
  SCHEDULE_LAW_REF,
  type ResideModule,
  type EnvoyAnswer,
} from "./spec_reside_loop_fixtures.js";

const PIN = { org: "org.house", venue: "venue.studio" };

/** An envoy stub that answers `due` with the given entries and dispatches each to a fresh gig. */
function envoyWith(
  due: { work_order_id: string; schedule_ordinal: number }[],
  over: { dispatch?: (args: Record<string, unknown>) => EnvoyAnswer } = {},
) {
  const seen: { verb: string; args: Record<string, unknown> }[] = [];
  let n = 0;
  const envoy = async (verb: string, args: Record<string, unknown>): Promise<EnvoyAnswer> => {
    seen.push({ verb, args });
    if (verb === "work-order-due") return { ok: true, data: { due } };
    if (verb === "work-order-dispatch") {
      if (over.dispatch) return over.dispatch(args);
      n += 1;
      return { ok: true, data: { gig_id: `gig-${n}` } };
    }
    if (verb === "gig_monitor") return { ok: true, data: { gig_id: args["gig_id"], status: "running" } };
    return { ok: false, refusal: "unresolvable-ref", message: `no executor for ${verb}` };
  };
  return { envoy, seen };
}

describe("LAW 7 — a gig-scoped token is refused TYPED, before the wire", () => {
  it("a gig-scoped credential presented as the residency's refuses 'gig_scoped_token'", async () => {
    const R: ResideModule = await loadReside();
    const { deps } = recordingDeps({ claim: async () => gigScopedClaim() });
    const r = R.createResidency({ residency: "any" }, deps);
    const booted = await r.boot();
    expect(booted.ok, "a gig-scoped token seated a residency").toBe(false);
    if (!booted.ok) {
      // NOT a generic auth failure: narrow may not mint broad (plan law L28), and the engine must
      // say which narrowness it found.
      expect(booted.refusal).toBe("gig_scoped_token");
      expect(booted.message).toBeTruthy();
    }
  });

  it("the refusal happens ENGINE-SIDE — the envoy is never called with a gig token", async () => {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps({ claim: async () => gigScopedClaim() });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    await r.tick();
    // The store would refuse it too (42501 at the dispatch door) — but a token that cannot possibly
    // dispatch should never reach the wire to find out.
    expect(calls.envoy.length, "a gig-scoped token was carried to the envoy anyway").toBe(0);
  });

  it("may_dispatch:false alone is enough — a gig_id is not the only way to be narrow", async () => {
    const R: ResideModule = await loadReside();
    const { deps } = recordingDeps({
      claim: async () => leaseClaim({ gig_id: null, may_dispatch: false }),
    });
    const r = R.createResidency({ residency: "any" }, deps);
    const booted = await r.boot();
    expect(booted.ok).toBe(false);
    if (!booted.ok) expect(booted.refusal).toBe("gig_scoped_token");
  });

  it("a proper lease token seats — the law refuses narrowness, not every token", async () => {
    const R: ResideModule = await loadReside();
    const { deps } = recordingDeps();
    const r = R.createResidency({ residency: "any" }, deps);
    // Guards the sabotage: if this went red too, law 7 would be refusing everything and proving
    // nothing.
    expect((await r.boot()).ok).toBe(true);
  });
});

describe("LAW 9 — the router is code: every due entry once, the cortex zero times", () => {
  it("dispatches every due (order, ordinal) exactly once per wake", async () => {
    const R: ResideModule = await loadReside();
    const due = [
      { work_order_id: "wo-1", schedule_ordinal: 0 },
      { work_order_id: "wo-1", schedule_ordinal: 1 },
      { work_order_id: "wo-2", schedule_ordinal: 0 },
    ];
    const { envoy, seen } = envoyWith(due);
    const { deps } = recordingDeps({ envoy });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    const res = await r.tick();

    expect(res.ok).toBe(true);
    const dispatches = seen.filter((s) => s.verb === "work-order-dispatch");
    expect(dispatches.length, "the router did not dispatch every due entry exactly once").toBe(3);
    const pairs = dispatches.map((d) => `${String(d.args["work_order_id"])}:${String(d.args["schedule_ordinal"])}`);
    expect(new Set(pairs).size, "the same (order, ordinal) was dispatched twice").toBe(3);
  });

  it("consults the cortex ZERO times on a clean pass", async () => {
    const R: ResideModule = await loadReside();
    const { envoy } = envoyWith([{ work_order_id: "wo-1", schedule_ordinal: 0 }]);
    const { deps, calls } = recordingDeps({ envoy });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    await r.tick();
    // Determinism in the engine; inference in the prompt; they never overlap (plan law). A router
    // that "asks the model to decide" on a clean pass is the cheap default thrown away.
    expect(calls.cortex, "the router reached for a model on a pass that needed no judgment").toBe(0);
  });

  it("sends work-order-due with NO pin, and work-order-dispatch WITH one", async () => {
    const R: ResideModule = await loadReside();
    const { envoy, seen } = envoyWith([{ work_order_id: "wo-1", schedule_ordinal: 0 }]);
    const { deps } = recordingDeps({ envoy });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    await r.tick();

    const dueCall = seen.find((s) => s.verb === "work-order-due");
    expect(dueCall, "the router never asked what is due").toBeTruthy();
    expect(dueCall?.args, "a row-routed read forwards args verbatim; a pin here is not its shape")
      .not.toHaveProperty("pin");

    const dispatch = seen.find((s) => s.verb === "work-order-dispatch");
    // THE PIN LAW: every act names its org and venue in the act itself.
    expect(dispatch?.args["pin"], "a dispatch went out unpinned").toEqual(PIN);
  });

  it("monitors each open gig and records terminality", async () => {
    const R: ResideModule = await loadReside();
    const { envoy, seen } = envoyWith([
      { work_order_id: "wo-1", schedule_ordinal: 0 },
      { work_order_id: "wo-2", schedule_ordinal: 0 },
    ]);
    const { deps } = recordingDeps({ envoy });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    const res = await r.tick();
    const monitored = seen.filter((s) => s.verb === "gig_monitor");
    expect(monitored.length, "gigs were dispatched and never watched").toBe(2);
    if (res.ok) expect(res.monitored.length).toBe(2);
  });

  it("a governance refusal is RELAYED verbatim, not judged", async () => {
    const R: ResideModule = await loadReside();
    const { envoy } = envoyWith([{ work_order_id: "wo-1", schedule_ordinal: 0 }], {
      dispatch: () => ({
        ok: false,
        refusal: "store-refused",
        message: "agent is not seated in a chair that may run this standard",
        errcode: "42501",
      }),
    });
    const { deps, calls } = recordingDeps({ envoy });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    const res = await r.tick();

    // A refusal is information, and the residency's voice is where it is shown.
    expect(calls.say.length, "a refusal was swallowed instead of shown in the channel").toBe(1);
    expect(calls.say[0]?.text, "the refusal was paraphrased rather than relayed")
      .toContain("agent is not seated in a chair that may run this standard");
    expect(calls.cortex, "a governance refusal was handed to a model to adjudicate").toBe(0);
    if (res.ok) expect(res.escalated.length).toBe(0);
  });

  it("ONLY the schedule law_ref escalates to the cortex — keyed on law_ref, never on prose", async () => {
    const R: ResideModule = await loadReside();
    const { envoy } = envoyWith([{ work_order_id: "wo-1", schedule_ordinal: 2 }], {
      dispatch: () => ({
        ok: false,
        refusal: "store-refused",
        message: "schedule entry 2 is classified needs-amendment",
        errcode: "23514",
        law_ref: SCHEDULE_LAW_REF,
      }),
    });
    const { deps, calls } = recordingDeps({ envoy });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    const res = await r.tick();

    expect(calls.cortex, "the one named-demand case did not reach the cortex").toBe(1);
    if (res.ok) {
      expect(res.escalated.length).toBe(1);
      expect(res.escalated[0]?.law_ref).toBe(SCHEDULE_LAW_REF);
    }
  });

  it("the SAME message without the law_ref does NOT escalate", async () => {
    const R: ResideModule = await loadReside();
    const { envoy } = envoyWith([{ work_order_id: "wo-1", schedule_ordinal: 2 }], {
      dispatch: () => ({
        ok: false,
        refusal: "store-refused",
        message: "schedule entry 2 is classified needs-amendment",
        errcode: "23514",
      }),
    });
    const { deps, calls } = recordingDeps({ envoy });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    await r.tick();
    // The pair with the law above is what makes "keyed on law_ref" a real property: identical prose,
    // different behaviour. Keyed on the message, both would escalate and the law would be vacuous.
    expect(calls.cortex, "the router keyed on the refusal's prose instead of its law_ref").toBe(0);
  });

  it("with no envoy wired the router refuses 'no_backend' naming the seam", async () => {
    const R: ResideModule = await loadReside();
    const { deps } = recordingDeps();
    delete (deps as { envoy?: unknown }).envoy;
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    const res = await r.tick();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.refusal).toBe("no_backend");
      expect(res.seam).toBe("envoy");
    }
  });
});

describe("LAW 10 — reside does not fork the gig path", () => {
  it("resideGigPath is the exact workOnce symbol", async () => {
    const R: ResideModule = await loadReside();
    // I12 one level out: src/residency.ts already re-exports workOnce as residencyGigPath, and
    // src/reside.ts must reach the same function rather than growing a second drain.
    expect(R.resideGigPath, "reside re-implemented the gig path instead of reusing workOnce").toBe(
      workOnce,
    );
  });

  it("the residency surface's own identity law still holds", async () => {
    const { loadResidency } = await import("./spec_reside_fixtures.js");
    const Res = await loadResidency();
    expect(Res.residencyGigPath).toBe(workOnce);
  });
});
