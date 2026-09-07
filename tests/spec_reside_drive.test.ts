// RED — THE DRIVE. The half of `coltrane reside` that WI-3 specified as a loop and shipped as a set
// of moves nobody makes.
//
// WHAT IS TRUE BEFORE THIS FILE. `createResidency` returns `boot · onInbound · wake · tick · beat ·
// shutdown`, each one law-covered by spec_reside_loop.test.ts and each one correct. And `runReside`
// — the thing `coltrane reside` actually runs — calls `boot()` and `return 0`. Nothing in src/ calls
// `channelListener()`, `wake()`, `tick()` or `beat()`; there is no interval, and no signal handler is
// ever registered. A box running `coltrane reside --any` claims a seat and exits, so WI-9's M4
// supervisor would watch its "standing" machine come up and immediately go down.
//
// THIS IS THE SAME DEFECT WI-3'S OWN MERGE CLOSED, ONE LAYER IN. #532's message: "a mechanism proven
// to work that nothing could reach" — the CLI's KNOWN table had no `reside` while `runReside` was
// exported and pinned. The mount landed. The DRIVE did not, and the laws that pin each move cannot
// see it, because every one of them calls the move itself.
//
// So these laws never call `wake`, `beat` or `shutdown` directly. They hand the loop a listener and
// assert what the loop DID — which is the only way a missing driver is expressible as a red.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadReside,
  recordingDeps,
  leaseClaim,
  msg,
  type ResideModule,
  type ResideDeps,
} from "./spec_reside_loop_fixtures.js";
import type { InboundMessage } from "./spec_reside_fixtures.js";

/** A listener that yields exactly these messages and then ENDS — the pump's natural terminator, so
 *  a law needs no fake timer to bound it. A real socket never ends; a test's must. */
function listenerOf(...messages: InboundMessage[]) {
  const seen: string[] = [];
  const listener = async function* (channelId: string) {
    seen.push(channelId);
    for (const m of messages) yield m;
  };
  return { listener, seen };
}

/** A hand-driven timer: nothing fires until a law says `fire()`. The heartbeat's cadence is the
 *  deployment's; what the engine owes is that the loop ARMS one and DISARMS it on release. */
function handTimer() {
  const armed: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    armed,
    timer: {
      set(fn: () => void, ms: number) { armed.push({ fn, ms, cleared: false }); return armed.length - 1; },
      clear(h: unknown) { const e = armed[h as number]; if (e) e.cleared = true; },
    },
    fire(i = 0) { armed[i]?.fn(); },
  };
}

/** Signal registration as a seam: a law fires the signal, `process` is never touched. */
function handSignal() {
  let handler: ((s: "SIGTERM" | "SIGINT") => void) | null = null;
  return {
    onSignal: (fn: (s: "SIGTERM" | "SIGINT") => void) => { handler = fn; },
    get registered() { return handler !== null; },
    raise(s: "SIGTERM" | "SIGINT" = "SIGTERM") { handler?.(s); },
  };
}

describe("LAW D1 — the loop SUBSCRIBES to the claimed residency's channel", () => {
  it("channelListener is called once, with the channel the claim named", async () => {
    const R: ResideModule = await loadReside();
    const { listener, seen } = listenerOf();
    const { deps } = recordingDeps({ channelListener: listener });

    const code = await R.driveResidency(R.createResidency({ residency: "any" }, deps), deps, {
      timer: handTimer().timer,
      onSignal: handSignal().onSignal,
    });

    // A residency that never opens its ear is not listening, whatever its status column says.
    expect(seen, "the loop never subscribed to a channel").toHaveLength(1);
    expect(seen[0], "the loop listened to a channel the claim did not name").toBe(leaseClaim().channel_id);
    expect(code).toBe(0);
  });

  it("a listener that yields nothing still seats, beats and releases cleanly", async () => {
    const R: ResideModule = await loadReside();
    const { listener } = listenerOf();
    const { deps, calls } = recordingDeps({ channelListener: listener });

    const code = await R.driveResidency(R.createResidency({ residency: "any" }, deps), deps, {
      timer: handTimer().timer,
      onSignal: handSignal().onSignal,
    });

    expect(calls.claim, "a quiet channel is still a seat").toBe(1);
    expect(calls.say, "a quiet channel is not an utterance").toHaveLength(0);
    expect(code).toBe(0);
  });
});

describe("LAW D2 — every message the channel yields is acked, in order", () => {
  it("the inbox holds every message the listener produced, in arrival order", async () => {
    const R: ResideModule = await loadReside();
    const { listener } = listenerOf(msg("m1"), msg("m2"), msg("m3"));
    const { deps } = recordingDeps({ channelListener: listener });
    const r = R.createResidency({ residency: "any" }, deps);

    await R.driveResidency(r, deps, { timer: handTimer().timer, onSignal: handSignal().onSignal });

    expect(r.inbox.map((m) => m.id), "the pump dropped or reordered inbound messages").toEqual(["m1", "m2", "m3"]);
  });
});

describe("LAW D3 — every acked message earns exactly one answered, sealed wake", () => {
  it("three messages produce three utterances, three seals and three cursor advances", async () => {
    const R: ResideModule = await loadReside();
    const { listener } = listenerOf(msg("m1"), msg("m2"), msg("m3"));
    const { deps, calls, tape } = recordingDeps({ channelListener: listener });

    await R.driveResidency(R.createResidency({ residency: "any" }, deps), deps, {
      timer: handTimer().timer,
      onSignal: handSignal().onSignal,
    });

    // The always-answer law, driven rather than called: a consumed message that nobody answered is
    // the state `wake` refuses, and the loop is what must never produce it.
    expect(calls.say, "a message was consumed and never answered").toHaveLength(3);
    expect(calls.cursorAdvance, "the cursor did not follow the seals").toHaveLength(3);
    expect(tape.filter((t) => t === "sealOutput"), "an utterance went unsealed").toHaveLength(3);

    // ORDER, not merely count: the seal earns the cursor, every time (I1/I3). The tape's
    // `cursorAdvance:<n>` carries the FENCE, not the cursor — the recorder prints argument 1 and
    // the signature is (residencyId, fence, n) — so the ORDER is asserted here and the cursor's
    // arithmetic below, off the recorded arguments. Reading the tape's number as the cursor is how
    // this law nearly asserted a constant three times and called it monotonic.
    const sealsAndCursors = tape.filter((t) => t === "sealOutput" || t.startsWith("cursorAdvance"));
    expect(sealsAndCursors, "a cursor moved before the seal that earns it").toEqual([
      "sealOutput", "cursorAdvance:1",
      "sealOutput", "cursorAdvance:1",
      "sealOutput", "cursorAdvance:1",
    ]);

    // The cursor itself: 1, 2, 3 — monotonic, one per seal, never a repeat. This is the half that
    // would go red if the drain re-woke on a cursor that had not moved.
    expect(calls.cursorAdvance.map((a) => a[2]), "the cursor did not advance once per seal").toEqual([1, 2, 3]);
  });

  it("the cursor the claim carried is honoured — a re-hosted box does not re-answer", async () => {
    const R: ResideModule = await loadReside();
    const { listener } = listenerOf(msg("m1"), msg("m2"));
    // A box resurrected onto a residency that already answered one message: cursor 1, and the
    // messages the socket replays start at the beginning.
    const { deps, calls } = recordingDeps({
      channelListener: listener,
      claim: async () => leaseClaim({ cursor: 1 }),
    });

    await R.driveResidency(R.createResidency({ residency: "any" }, deps), deps, {
      timer: handTimer().timer,
      onSignal: handSignal().onSignal,
    });

    // Two in the inbox, one already consumed before this box existed: exactly one answer is owed.
    expect(calls.say, "a re-hosted box re-answered what a dead one already did").toHaveLength(1);
  });
});

describe("LAW D4 — the reflex does not wait on the cortex", () => {
  it("messages keep being acked while a cortex turn is still in flight", async () => {
    const R: ResideModule = await loadReside();

    // A cortex that hangs until a law lets it go. If the pump awaits the wake, message 2 is never
    // acked and this deadlocks rather than fails — so the law bounds itself and asserts the inbox.
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let cortexEntered = 0;

    const r_ref: { r?: ReturnType<ResideModule["createResidency"]> } = {};
    const listener = async function* () {
      yield msg("m1");
      // Wait until the cortex is actually in flight before producing the second message, so the
      // question this law asks — "can the ear work while the mind is busy?" — is really asked.
      while (cortexEntered === 0) await new Promise((res) => setTimeout(res, 1));
      yield msg("m2");
      // The ack must have happened WITHOUT the cortex having returned. This is the assertion that
      // cannot be made after the loop finishes, because by then everything has drained.
      expect(r_ref.r!.inbox.map((m) => m.id), "the pump blocked on the cortex — a busy mind deafened the ear")
        .toEqual(["m1", "m2"]);
      release();
    };

    const { deps, calls } = recordingDeps({
      channelListener: listener,
      cortex: async () => { cortexEntered += 1; await held; return { utterance: { channel_id: "chan.parlor", text: "answered" } }; },
    });
    r_ref.r = R.createResidency({ residency: "any" }, deps);

    await R.driveResidency(r_ref.r, deps, { timer: handTimer().timer, onSignal: handSignal().onSignal });

    expect(calls.say, "both messages should still be answered once the mind is free").toHaveLength(2);
  });
});

describe("LAW D5 — the loop ARMS a heartbeat and DISARMS it on release", () => {
  it("a timer is armed at the cadence the deployment named, and renews the lease when it fires", async () => {
    const R: ResideModule = await loadReside();
    const t = handTimer();
    const sig = handSignal();
    // A listener that stays open until the law has fired the heartbeat — a real channel does not end.
    let done!: () => void;
    const open = new Promise<void>((res) => { done = res; });
    const listener = async function* () { await open; };

    const { deps, calls } = recordingDeps({ channelListener: listener });
    const running = R.driveResidency(R.createResidency({ residency: "any" }, deps), deps, {
      heartbeat_ms: 30_000,
      timer: t.timer,
      onSignal: sig.onSignal,
    });

    // Armed before any message arrives: a residency waiting on a quiet channel must still prove it
    // is alive, or the reaper takes a seat that was never abandoned.
    await new Promise((res) => setTimeout(res, 5));
    expect(t.armed, "the loop armed no heartbeat — a live seat that never proves it").toHaveLength(1);
    expect(t.armed[0]!.ms, "the loop ignored the cadence it was given").toBe(30_000);

    t.fire();
    await new Promise((res) => setTimeout(res, 5));
    expect(calls.heartbeat, "the armed timer did not renew the lease").toBe(1);

    done();
    await running;
    expect(t.armed[0]!.cleared, "the heartbeat outlived the seat — a released seat kept proving itself alive").toBe(true);
  });
});

describe("LAW D6 — a signal HANDS THE SEAT OVER, and the loop returns 0", () => {
  it("SIGTERM releases hibernated exactly once and ends the loop", async () => {
    const R: ResideModule = await loadReside();
    const t = handTimer();
    const sig = handSignal();
    const listener = async function* () { await new Promise(() => { /* a channel that never ends */ }); };

    const { deps, calls } = recordingDeps({ channelListener: listener });
    const running = R.driveResidency(R.createResidency({ residency: "any" }, deps), deps, {
      timer: t.timer,
      onSignal: sig.onSignal,
    });

    await new Promise((res) => setTimeout(res, 5));
    expect(sig.registered, "the loop registered no signal handler — a redeploy would race for the seat").toBe(true);

    sig.raise("SIGTERM");
    const code = await running;

    expect(calls.release, "the seat was not handed back").toHaveLength(1);
    expect(calls.release[0]![2], "a signalled release must rest the seat, not unseat it").toBe("hibernated");
    expect(code, "a clean handover is exit 0").toBe(0);
  });

  it("a second signal does not release twice", async () => {
    const R: ResideModule = await loadReside();
    const sig = handSignal();
    const listener = async function* () { await new Promise(() => { /* never ends */ }); };
    const { deps, calls } = recordingDeps({ channelListener: listener });

    const running = R.driveResidency(R.createResidency({ residency: "any" }, deps), deps, {
      timer: handTimer().timer,
      onSignal: sig.onSignal,
    });
    await new Promise((res) => setTimeout(res, 5));
    sig.raise("SIGTERM");
    sig.raise("SIGINT");
    await running;

    expect(calls.release, "two signals released the same seat twice").toHaveLength(1);
  });
});

describe("LAW D7 — an unwired seam is a NAMED exit code, never a throw", () => {
  it("driving with no channelListener returns the seam's exit code instead of raising", async () => {
    const R: ResideModule = await loadReside();
    const { deps } = recordingDeps();
    // The one seam this loop cannot proceed without, removed.
    const without: ResideDeps = { ...deps };
    delete (without as { channelListener?: unknown }).channelListener;

    const code = await R.driveResidency(R.createResidency({ residency: "any" }, without), without, {
      timer: handTimer().timer,
      onSignal: handSignal().onSignal,
    });

    // `no_backend` is exit 2 — misconfigured, the same door `work` uses. Never a throw, and never 0.
    expect(code, "an unwired seam exited as though it had stood").toBe(2);
  });

  it("an empty roster is exit 3 — not an error, and not a seat", async () => {
    const R: ResideModule = await loadReside();
    const { deps } = recordingDeps({ claim: async () => null });

    const code = await R.driveResidency(R.createResidency({ residency: "any" }, deps), deps, {
      timer: handTimer().timer,
      onSignal: handSignal().onSignal,
    });

    expect(code, "nothing claimable is exit 3").toBe(3);
  });
});

describe("LAW D8 — `coltrane reside` REACHES the drive, not merely the boot", () => {
  it("runReside consumes the channel and answers it, through a module backing", async () => {
    const R: ResideModule = await loadReside();

    // THE LAW THAT WOULD HAVE CAUGHT THE GAP. Every other law here drives `driveResidency`
    // directly, so all of them would stay green if `runReside` went back to `boot(); return 0`.
    // This one goes through the real verb, over the module backing's real pass-through, and reads
    // the evidence off DISK — the module cannot share memory with this file, so a marker written by
    // `say()` is proof the loop ran end to end inside the command.
    const dir = mkdtempSync(join(tmpdir(), "reside-drive-"));
    const marker = join(dir, "said.json");
    const mod = join(dir, "backing.mjs");
    writeFileSync(mod, `
      import { writeFileSync } from "node:fs";
      const said = [];
      export function residencyBacking() {
        return {
          claim: async () => ({
            residency_id: "res-drive-1", agent_slug: "agent.viola", org: "org.house",
            venue_slug: "venue.studio", channel_id: "chan.parlor", session_id: "sess-1",
            cursor: 0, lease_token: "ctk_lease", fence: "1", gig_id: null, may_dispatch: ["*"],
          }),
          heartbeat: async () => {},
          release: async () => {},
          cursorAdvance: async () => 1,
          channelListener: async function* () { yield { id: "m1", text: "hello", at: 0 }; },
          cortex: async () => ({ utterance: { channel_id: "chan.parlor", text: "answered" } }),
          sealOutput: async () => ({ content_sha: "sha-1" }),
          say: async (u) => { said.push(u.text); writeFileSync(${JSON.stringify(marker)}, JSON.stringify(said)); },
        };
      }
    `);

    const code = await R.runReside(["--any"], {
      err: () => {},
      env: { COLTRANE_RESIDENCY_MODULE: mod },
    });

    expect(existsSync(marker), "`coltrane reside` claimed a seat and exited without ever listening").toBe(true);
    expect(JSON.parse(readFileSync(marker, "utf8")), "the command reached the channel but never answered it").toEqual(["answered"]);
    expect(code, "a channel that ended is a clean release").toBe(0);
  });

  it("the local file roster drives too — the shipped backing is not a second-class door", async () => {
    const R: ResideModule = await loadReside();
    const root = mkdtempSync(join(tmpdir(), "reside-roster-"));
    mkdirSync(join(root, "residencies"), { recursive: true });

    // The local backing supplies the SEAT only; channel/cortex/say are the deployment's on every
    // backing, so this must refuse by NAME rather than stand up half a residency.
    const code = await R.runReside(["--any"], { err: () => {}, env: { COLTRANE_RESIDENCY_DIR: root } });

    // Exit 2 or 3 — misconfigured (no channel wired) or nothing claimable (empty roster). What it
    // must never be is 0, which is what "boot and return" produced.
    expect([2, 3], "the local backing exited as though a residency stood").toContain(code);
  });
});
