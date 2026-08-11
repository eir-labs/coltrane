// vercel-api — the deterministic half of the deploy act. Pure: input in, output out, no
// I/O, no LLM, no network. determinism_ratio 1.0 (the code resolves the entire output).
//
// The engine has no subprocess or async-wait primitive, so the wait on a Vercel build is a
// BOUNDED synchronous poll inside the deploy chair's own turn: the agent makes one
// WebFetch GET /v6/deployments per iteration and collects the observed `readyState` values.
// This function takes that sequence plus the poll budget and resolves the ONE terminal
// deploy state — the logic that must be deterministic, not model-improvised:
//
//   input:  { polls: string[] (readyState per GET, in order),
//             max_polls: number (the agent's turn ceiling),
//             logs_tail?: string[] (tail of the build log, attached on failure) }
//   output: { terminal_state, build_status, deadline_exceeded, pass, polls_used,
//             logs_tail?, source }
//
// The terminal readyStates are READY, ERROR and CANCELED. pass is true only on READY. When
// the budget is spent with no terminal observation the state is UNSETTLED and
// deadline_exceeded is true — the honest never-settled path, made visible rather than a
// guess that the build would have settled a few polls later. logs_tail rides along only on a
// non-READY terminal (or the UNSETTLED give-up), so a passing verdict carries no noise.
const TERMINAL = new Set(["READY", "ERROR", "CANCELED"]);

export default function run(input) {
  const polls = Array.isArray(input && input.polls) ? input.polls.map((s) => String(s)) : [];
  const rawBudget = Number(input && input.max_polls);
  const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : polls.length;
  const logsTail = Array.isArray(input && input.logs_tail) ? input.logs_tail.map((s) => String(s)) : [];

  // Walk the observations up to the budget, stopping at the first terminal readyState.
  const window = polls.slice(0, budget);
  let terminalIndex = -1;
  for (let i = 0; i < window.length; i++) {
    if (TERMINAL.has(window[i])) { terminalIndex = i; break; }
  }

  if (terminalIndex !== -1) {
    const terminal_state = window[terminalIndex];
    const pass = terminal_state === "READY";
    const out = {
      terminal_state,
      build_status: terminal_state,
      deadline_exceeded: false,
      pass,
      polls_used: terminalIndex + 1,
      source: "skill://vercel-api@1",
    };
    // A failing terminal carries the build log tail; a passing one carries no noise.
    if (!pass) out.logs_tail = logsTail;
    return out;
  }

  // Budget spent with no terminal observation: the honest never-settled path.
  const last = window.length > 0 ? window[window.length - 1] : "INITIALIZING";
  return {
    terminal_state: "UNSETTLED",
    build_status: last,
    deadline_exceeded: true,
    pass: false,
    polls_used: window.length,
    logs_tail: logsTail,
    source: "skill://vercel-api@1",
  };
}
