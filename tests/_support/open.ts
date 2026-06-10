// The OPEN primitive — the third TDD state, committed alongside RED.
//
//   GREEN  done + verified.
//   RED    the contract is DEFINED but unimplemented — the assertion is written, the gap
//          is code. (A normal failing it() committed as pre-registration.)
//   OPEN   the contract itself isn't GROUNDED yet — you can't write the assertion because
//          the answer depends on a decision, a source, or evidence you don't have. The gap
//          is RESOLUTION, not implementation.
//
// RED is room to grow toward a known target; OPEN is room to grow toward DEFINING the
// target. The lifecycle is OPEN -> RED -> GREEN: ground the question into a concrete failing
// assertion (the `resolves_when`, sourced from `grounding`), then implement it. Each open()
// is committed and tracked (reported as a vitest todo — a distinct count, never a false
// pass nor a noisy fail), so the unresolved space is formal and visible, not folklore.
import { it } from "vitest";

export interface OpenSpec {
  /** What is unresolved — the question itself. */
  question: string;
  /** The condition that closes it: usually the concrete assertion you'd write once grounded
   *  (this is the OPEN -> RED move). */
  resolves_when: string;
  /** Where the answer must come from — a decision owner, a doc, a source, real evidence.
   *  An ungrounded claim is a door, not a wall: name the door. */
  grounding?: string;
}

/** Register a committed, tracked OPEN question. */
export function open(name: string, spec: OpenSpec): void {
  const g = spec.grounding ? ` · grounding: ${spec.grounding}` : "";
  it.todo(`◇ OPEN — ${name} · Q: ${spec.question} · resolves when: ${spec.resolves_when}${g}`);
}
