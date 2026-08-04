// RED — issue #252, the "the server may not even die" half.
//
// src/server.ts installs `process.on("SIGTERM", flush)` where flush() sets a flag and returns.
// In Node, installing a SIGINT/SIGTERM listener REPLACES the default terminate behaviour — so
// a recorder-enabled server survives SIGTERM indefinitely. The relay's 2s SIGKILL escalation
// masks this; a direct `kill <pid>` does not terminate the server at all.
//
// And on the way out the server must stop its own chair children, which are spawned without
// `detached` and therefore receive nothing when the server is signalled. (Killing the process
// GROUP is the airtight answer and is deliberately NOT taken here: it takes children out of
// the server's group, so an operator Ctrl-C stops reaching them — which makes #252 worse.)
import { describe, it, expect } from "vitest";
import { installShutdownHandlers, type ShutdownProcess } from "../src/server.js";

function fakeProc(): { proc: ShutdownProcess; handlers: Map<string, Array<() => void>>; exits: number[] } {
  const handlers = new Map<string, Array<() => void>>();
  const exits: number[] = [];
  const proc: ShutdownProcess = {
    on(event: string, cb: () => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      return proc;
    },
    exit(code?: number) { exits.push(code ?? 0); },
  };
  return { proc, handlers, exits };
}

describe("#252 — a signalled server flushes, stops its children, and then actually exits", () => {
  it.each(["SIGTERM", "SIGINT"])("%s flushes the recorder AND terminates the process", (signal) => {
    const { proc, handlers, exits } = fakeProc();
    let flushed = 0;
    installShutdownHandlers({ flush: () => { flushed++; } }, proc);

    const cbs = handlers.get(signal) ?? [];
    expect(cbs.length, `no ${signal} handler was installed`).toBeGreaterThan(0);
    for (const cb of cbs) cb();

    expect(flushed, "the recorder must still be flushed on the way out").toBeGreaterThan(0);
    expect(
      exits.length,
      "the handler is `() => recorder.flush()`, which sets a flag and returns. Installing it " +
        "REPLACES Node's default terminate behaviour, so the server survives the signal " +
        "forever — a direct `kill <pid>` does not terminate it at all.",
    ).toBeGreaterThan(0);
  });

  it("kills live chair children before exiting, so a restart is not an orphaning", () => {
    const { proc, handlers } = fakeProc();
    let killed = 0;
    installShutdownHandlers({ killChildren: () => { killed++; } }, proc);
    for (const cb of handlers.get("SIGTERM") ?? []) cb();
    expect(
      killed,
      "the server's `claude` grandchildren are spawned without detached, are not in a separate " +
        "process group, and POSIX delivers them nothing when the server is signalled. They keep " +
        "running, orphaned, still billing — and gig tracking is dropped, so nothing records that " +
        "the orphans exist.",
    ).toBe(1);
  });

  it("is installed even with no recorder wired (the child-orphan half is unconditional)", () => {
    const { proc, handlers } = fakeProc();
    installShutdownHandlers({}, proc);
    expect((handlers.get("SIGTERM") ?? []).length).toBeGreaterThan(0);
  });

  it("a second signal while shutting down does not re-enter the flush", () => {
    const { proc, handlers, exits } = fakeProc();
    let flushed = 0;
    installShutdownHandlers({ flush: () => { flushed++; } }, proc);
    const cbs = handlers.get("SIGTERM") ?? [];
    for (const cb of cbs) cb();
    for (const cb of cbs) cb();
    expect(flushed, "an impatient operator hitting Ctrl-C twice must not double-flush").toBe(1);
    expect(exits.length).toBe(1);
  });
});
