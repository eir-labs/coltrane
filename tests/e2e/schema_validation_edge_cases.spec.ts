// T-schema-validation-edge-cases e2e — adversarial input fuzzing of the validate
// path. Two surfaces under test:
//
//   1) src/registry.ts createRegistry().validate — the Ajv-backed schema check.
//      The schema is constructed as:
//
//        {
//          type: "object",
//          properties: dt.schema.properties ?? {},
//          required: dt.required_fields,
//          additionalProperties: true,        // ← gap surface
//        }
//
//      Ajv is created with `{ allErrors: true, strict: false }`. The compiled
//      validator's `errors` is mapped to `e.message ?? "invalid"` — no field
//      path, no instancePath, no schemaPath.
//
//   2) src/server.ts dispatchTool("output_write", …) — the MCP surface that
//      wraps registry.validate. Note the input coercions:
//
//        domain_type = String(args["domain_type"] ?? "")    // null → ""
//        data        = (args["data"] as Record<…>) ?? {}    // null → {}
//
//      The null-to-empty-string collapse means callers can't distinguish
//      "I sent null" from "I sent ''" at the boundary, and a null-data payload
//      becomes an empty object before validation sees it. That's an apoha:
//      the boundary erases adversarial intent before the validator can name it.
//
// Honest about scope: this is a fingerprint of TODAY's validator behavior +
// the dispatchTool coercion path. Where we find gaps (silent accept, vague
// reject, no field name), we PIN them as the bug-bash finding. When a future
// patch closes the gap, the assertion flips and we move the case into the
// "rejected with named field" bucket.
//
// Pattern lifted from standard_mismatched_type_edges.spec.ts (sequential it()
// blocks, no tempdir, pure dispatchTool + registry calls).

import { describe, expect, it } from "vitest";

import {
  MemoryLedger,
  createOutputStore,
  createRegistry,
  dispatchTool,
  type ServerDeps,
} from "../../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared scaffolding: a Signal-extending domain type with one of each
// "interesting" primitive shape — string, boolean, number, object, array.
// ─────────────────────────────────────────────────────────────────────────────

function buildDeps(): ServerDeps {
  const registry = createRegistry();
  registry.registerType({
    slug: "edge-signal",
    extends: "Signal",
    domain: "edgetests",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        flag: { type: "boolean" },
        count: { type: "number" },
        nested: {
          type: "object",
          properties: {
            inner: { type: "string" },
          },
          required: ["inner"],
        },
        tags: { type: "array", items: { type: "string" } },
      },
    },
    required_fields: ["name", "flag", "count", "nested", "tags"],
  });
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { registry, outputs, ledger };
}

// Convenience: build a "valid" payload, then mutate one field to the adversarial
// value. Keeps each test focused on a single failure mode.
function basePayload(): Record<string, unknown> {
  return {
    name: "ok",
    flag: true,
    count: 1,
    nested: { inner: "ok" },
    tags: ["a", "b"],
  };
}

function callOutputWrite(
  deps: ServerDeps,
  data: Record<string, unknown>,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return dispatchTool(
    "output_write",
    {
      core_type: "Signal",
      domain_type: "edge-signal",
      domain: "edgetests",
      gig_id: "gig-edge-1",
      agent_slug: "edge-agent",
      data,
      ...overrides,
    },
    deps,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Required field set to empty string "" — Ajv has no `minLength` on the
//    schema, so "" SATISFIES type=string AND required (key exists). Silent
//    accept. Bug-bash finding: required+string admits the empty string by
//    default — required only enforces key-presence, not value-substance.
// ─────────────────────────────────────────────────────────────────────────────

describe("schema validation edge cases (adversarial — required-field-substance)", () => {
  it("APOHA: required string field set to '' is SILENTLY ACCEPTED (required = key-present, not value-nonempty)", async () => {
    const deps = buildDeps();
    const payload = basePayload();
    payload["name"] = "";

    const res = await callOutputWrite(deps, payload);

    // Pin the gap: empty-string-as-required-field passes today.
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    const written = (res.data as { output: { data: Record<string, unknown> } }).output;
    expect(written.data["name"]).toBe("");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2) Required field set to null. Two sub-cases:
  //    a) Passed through to registry.validate — Ajv rejects with "must be string"
  //       but the error message does NOT name the failing field — only the
  //       message string survives the `e.message ?? "invalid"` projection.
  //    b) When the WHOLE `data` is null at the dispatchTool boundary, the
  //       coercion `data ?? {}` swallows the null → an empty object reaches
  //       validate → rejected for missing required, but the user's "I sent null"
  //       signal is lost. Recorded as apoha: the boundary erases adversarial
  //       intent before the validator can name it.
  // ───────────────────────────────────────────────────────────────────────────
  it("required field set to null is REJECTED but error message does NOT name the failing field", async () => {
    const deps = buildDeps();
    const payload = basePayload();
    payload["name"] = null;

    const res = await callOutputWrite(deps, payload);

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    // Fingerprint the gap: the error contains a type-class message ("must be string")
    // but does NOT identify which field failed. Operators see a generic message.
    expect(res.error!.toLowerCase()).toMatch(/must be string|invalid/);
    // The field name "name" is NOT in the error. When that gets fixed, flip this.
    const namesField = /\bname\b/.test(res.error!);
    expect(namesField).toBe(false);
  });

  it("APOHA: whole `data: null` at dispatchTool boundary is coerced to {} — original null is invisible to validate", async () => {
    const deps = buildDeps();

    const res = await dispatchTool(
      "output_write",
      {
        core_type: "Signal",
        domain_type: "edge-signal",
        domain: "edgetests",
        gig_id: "gig-edge-null-data",
        agent_slug: "edge-agent",
        data: null,
      },
      deps,
    );

    // The empty-object reaches validate, which then rejects for missing required.
    // But the user's "I sent null" signal was already lost at the boundary.
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    // Required-fields complaint, not "data was null". Boundary erased the intent.
    expect(res.error!.toLowerCase()).toMatch(/required|must have|invalid/);
    expect(res.error!.toLowerCase()).not.toMatch(/null/);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3) Required field set to whitespace " " — SILENTLY ACCEPTED, same root cause
  //    as case (1): type=string + required is structurally satisfied. Whitespace
  //    is a valid string in JSON Schema unless minLength/pattern is declared.
  // ───────────────────────────────────────────────────────────────────────────
  it("APOHA: required string field set to ' ' (whitespace) is SILENTLY ACCEPTED", async () => {
    const deps = buildDeps();
    const payload = basePayload();
    payload["name"] = " ";

    const res = await callOutputWrite(deps, payload);

    expect(res.ok).toBe(true);
    const written = (res.data as { output: { data: Record<string, unknown> } }).output;
    expect(written.data["name"]).toBe(" ");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4) Required field set to 0 when string expected — Ajv rejects (type
  //    mismatch). Fingerprint that the message identifies the TYPE class but
  //    NOT the failing field name.
  // ───────────────────────────────────────────────────────────────────────────
  it("required string field set to 0 (number) is REJECTED with type-class message but no field name", async () => {
    const deps = buildDeps();
    const payload = basePayload();
    payload["name"] = 0;

    const res = await callOutputWrite(deps, payload);

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!.toLowerCase()).toMatch(/must be string/);
    // Same gap as case (2): error names the constraint but not the field.
    expect(/\bname\b/.test(res.error!)).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5) Required field set to "true" (string) when bool expected — Ajv has no
  //    coercion (we don't pass `coerceTypes: true`), so this is rejected. Pin
  //    the message shape AND the no-field-name gap.
  // ───────────────────────────────────────────────────────────────────────────
  it("required boolean field set to 'true' (string) is REJECTED with type-class message but no field name", async () => {
    const deps = buildDeps();
    const payload = basePayload();
    payload["flag"] = "true";

    const res = await callOutputWrite(deps, payload);

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!.toLowerCase()).toMatch(/must be boolean/);
    expect(/\bflag\b/.test(res.error!)).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6) Extra fields NOT in schema — `additionalProperties: true` is hardcoded
  //    in registry.ts:105. Silent accept of any extra fields. Bug-bash finding:
  //    no surface enforces the closed-world contract that domain_types claim
  //    to encode. A typo in a field name lands silently in the output store.
  // ───────────────────────────────────────────────────────────────────────────
  it("APOHA: extra fields NOT in schema are SILENTLY ACCEPTED (additionalProperties: true is hardcoded)", async () => {
    const deps = buildDeps();
    const payload = basePayload();
    payload["totally_unknown_field"] = "garbage";
    payload["another_extra"] = { weird: ["shape", null, 42] };

    const res = await callOutputWrite(deps, payload);

    expect(res.ok).toBe(true);
    const written = (res.data as { output: { data: Record<string, unknown> } }).output;
    // Unknown fields survive into the persisted row — typos land silently.
    expect(written.data["totally_unknown_field"]).toBe("garbage");
    expect(written.data["another_extra"]).toEqual({ weird: ["shape", null, 42] });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7) Deeply-nested null in a nested object's required field. The inner schema
  //    has `required: ["inner"]` + `inner: { type: "string" }`. Setting it to
  //    null should be rejected by Ajv. Fingerprint whether the path-or-field
  //    name is in the error.
  // ───────────────────────────────────────────────────────────────────────────
  it("nested required field set to null is REJECTED but error message does NOT name the path", async () => {
    const deps = buildDeps();
    const payload = basePayload();
    payload["nested"] = { inner: null };

    const res = await callOutputWrite(deps, payload);

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!.toLowerCase()).toMatch(/must be string/);
    // Neither "nested" nor "inner" appear in the error — the path information
    // Ajv computes is dropped by the `e.message ?? "invalid"` projection.
    expect(/\bnested\b/.test(res.error!)).toBe(false);
    expect(/\binner\b/.test(res.error!)).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8) Array where string expected — Ajv rejects with type-mismatch. Same
  //    no-field-name gap.
  // ───────────────────────────────────────────────────────────────────────────
  it("required string field set to an array is REJECTED with type-class message but no field name", async () => {
    const deps = buildDeps();
    const payload = basePayload();
    payload["name"] = ["a", "b", "c"];

    const res = await callOutputWrite(deps, payload);

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!.toLowerCase()).toMatch(/must be string/);
    expect(/\bname\b/.test(res.error!)).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9) domain_type extends "Signal" but data shape doesn't match at all — a
  //    totally foreign shape (no required fields, all extras). This is the
  //    "right type label, wrong data" case. Validator should reject for the
  //    missing requireds. Fingerprint the message: does it list ALL missing
  //    requireds (allErrors: true) or just one? Does it name them?
  // ───────────────────────────────────────────────────────────────────────────
  it("domain_type='edge-signal' with wholly foreign data shape is REJECTED — does it list all missing requireds?", async () => {
    const deps = buildDeps();

    const res = await callOutputWrite(
      deps,
      {
        // None of the declared requireds; only unknowns.
        wrong_shape: "completely different",
        random: 99,
      },
    );

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    // ajv `allErrors: true` accumulates errors. With 5 missing requireds we
    // expect MULTIPLE "must have required property" messages.
    const requiredCount =
      (res.error!.match(/must have required property/g) ?? []).length;
    // Pin the COUNT — if a future patch normalizes to "missing required: a, b, c"
    // (a single message), this number will change and the test will trip.
    expect(requiredCount).toBeGreaterThanOrEqual(5);
    // The required-property messages from Ajv DO carry the field name in the
    // message itself (e.g. `must have required property 'name'`). Sanity-check.
    expect(res.error!).toMatch(/'name'/);
    expect(res.error!).toMatch(/'flag'/);
    expect(res.error!).toMatch(/'count'/);
    expect(res.error!).toMatch(/'nested'/);
    expect(res.error!).toMatch(/'tags'/);
    // But unknown fields are silently allowed even when the shape is wrong.
    // That's case (6) reaffirmed at the wholly-foreign-shape level.
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 10) Bonus: unknown domain_type — registry.validate's own short-circuit.
  //     This is the only branch where the error message DOES quote the failing
  //     identifier. Pin it as the positive contract.
  // ───────────────────────────────────────────────────────────────────────────
  it("unknown domain_type at output_write is REJECTED with the unknown slug named in the error (positive contract)", async () => {
    const deps = buildDeps();

    const res = await callOutputWrite(deps, basePayload(), {
      domain_type: "this-type-was-never-registered",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!).toMatch(/this-type-was-never-registered/);
    expect(res.error!.toLowerCase()).toMatch(/unknown domain_type/);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 11) Bonus: domain_type omitted entirely — the boundary coerces undefined →
  //     "" via `String(args["domain_type"] ?? "")`. Registry then reports
  //     `unknown domain_type ""`. Pin the empty-quoted message.
  // ───────────────────────────────────────────────────────────────────────────
  it("APOHA: domain_type omitted is coerced to '' at the boundary, reaching validate as an empty-slug lookup", async () => {
    const deps = buildDeps();

    const res = await dispatchTool(
      "output_write",
      {
        core_type: "Signal",
        // domain_type intentionally omitted
        domain: "edgetests",
        gig_id: "gig-edge-omit",
        agent_slug: "edge-agent",
        data: basePayload(),
      },
      deps,
    );

    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error!).toMatch(/unknown domain_type ""/);
  });
});
