import { describe, it, expect } from "vitest";
import {
  CANONICAL_FORM_VERSION,
  canonJson,
  canonText,
  fileHashJson,
  fileHashText,
  definitionHash,
  runFingerprint,
  dependencyHash,
  effectiveHash,
  sha256Hex,
} from "../src";

describe("canonical_form version", () => {
  it("version matches v0.1 emptiness amendment", () => {
    expect(CANONICAL_FORM_VERSION).toBe("1.1");
  });
});

describe("conformance against published vectors (Coltrane_canonical_form_contract_v0.md)", () => {
  const META = {
    slug: "hello-skill",
    version: "1",
    status: "active",
    kind: "deterministic",
    input_types: ["text/plain"],
    output_types: ["text/plain"],
    content_hash: "THIS_FIELD_IS_EXCLUDED",
  };
  const SKILL_MD =
    "---\nslug: hello-skill\nkind: deterministic\n---\n# Hello Skill\n\nReturns a greeting.\n";

  const META_HASH = "e88dff82403e35c07bce390b88ecb5995ebada86db83242d2ac0a8ff558d37da";
  const SKILL_HASH = "d778a51deac04f56d1fb5456b2b1498505320c64043b5f402d2dfe27baf21ea4";
  const DEFINITION_HASH = "25e74fe11444b604f4715e984a1f101dcf7cdd135035696175acf508d54f0fe3";

  it("meta.json canonical bytes hash to published hex", () => {
    expect(fileHashJson(META)).toBe(META_HASH);
  });

  it("skill.md canonical bytes hash to published hex", () => {
    expect(fileHashText(SKILL_MD)).toBe(SKILL_HASH);
  });

  it("definition manifest hashes to published hex", () => {
    expect(
      definitionHash([
        { relpath: "meta.json", hash: META_HASH },
        { relpath: "skill.md", hash: SKILL_HASH },
      ]),
    ).toBe(DEFINITION_HASH);
  });
});

describe("canonText spec compliance", () => {
  it("strips all trailing newlines then appends exactly one", () => {
    expect(canonText("a\n\n\n\n")).toBe("a\n");
    expect(canonText("a\n\n")).toBe("a\n");
    expect(canonText("a")).toBe("a\n");
    expect(canonText("a\r\n\r\n")).toBe("a\n");
  });
});

describe("canonJson", () => {
  it("sorts keys", () => {
    expect(canonJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("strips excluded self-referential fields", () => {
    expect(
      canonJson({ a: 1, content_hash: "x", materialized_at: "y", last_seen: "z" }),
    ).toBe('{"a":1}');
  });

  it("recursively strips excluded fields in nested objects", () => {
    expect(
      canonJson({ outer: { content_hash: "x", value: 5 } }),
    ).toBe('{"outer":{"value":5}}');
  });

  it("preserves arrays", () => {
    expect(canonJson({ items: [3, 1, 2] })).toBe('{"items":[3,1,2]}');
  });
});

describe("canonText", () => {
  it("normalizes CRLF to LF", () => {
    expect(canonText("a\r\nb")).toBe("a\nb\n");
  });

  it("appends trailing newline if missing", () => {
    expect(canonText("a")).toBe("a\n");
  });

  it("idempotent on already-canonical text", () => {
    const t = "a\nb\n";
    expect(canonText(t)).toBe(t);
  });
});

describe("file hashes", () => {
  it("identical JSON content yields identical hash", () => {
    expect(fileHashJson({ a: 1, b: 2 })).toBe(fileHashJson({ b: 2, a: 1 }));
  });

  it("different JSON content yields different hash", () => {
    expect(fileHashJson({ a: 1 })).not.toBe(fileHashJson({ a: 2 }));
  });

  it("CRLF and LF text yield identical hash", () => {
    expect(fileHashText("a\nb")).toBe(fileHashText("a\r\nb"));
  });
});

describe("definitionHash", () => {
  it("order-independent over file list", () => {
    const a = definitionHash([
      { relpath: "meta.json", hash: "aa" },
      { relpath: "skill.md", hash: "bb" },
    ]);
    const b = definitionHash([
      { relpath: "skill.md", hash: "bb" },
      { relpath: "meta.json", hash: "aa" },
    ]);
    expect(a).toBe(b);
  });

  it("changes when a file hash changes", () => {
    const before = definitionHash([{ relpath: "meta.json", hash: "aa" }]);
    const after = definitionHash([{ relpath: "meta.json", hash: "ab" }]);
    expect(before).not.toBe(after);
  });

  it("empty file list has deterministic hash", () => {
    expect(definitionHash([])).toBe(sha256Hex("[]"));
  });
});

describe("runFingerprint", () => {
  const base = {
    genome_hash: "ghash",
    model_version: "claude-opus-4-7",
    canonical_form_version: "1",
    eval_scores: { dim_score: 0.92 },
    output_hashes: ["out1", "out2"],
  };

  it("deterministic", () => {
    expect(runFingerprint(base)).toBe(runFingerprint(base));
  });

  it("changes when model_version changes", () => {
    expect(runFingerprint(base)).not.toBe(
      runFingerprint({ ...base, model_version: "claude-sonnet-4-6" }),
    );
  });

  it("changes when an eval score changes", () => {
    expect(runFingerprint(base)).not.toBe(
      runFingerprint({ ...base, eval_scores: { dim_score: 0.95 } }),
    );
  });

  it("output_hashes order-independent", () => {
    expect(runFingerprint(base)).toBe(
      runFingerprint({ ...base, output_hashes: ["out2", "out1"] }),
    );
  });
});

describe("dependencyHash — v0.1 spec shape", () => {
  it("empty deps list hashes to published constant sha256('[]')", () => {
    expect(dependencyHash([])).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
  });

  it("sorted by (class, slug) lexicographically", () => {
    const a = dependencyHash([
      { class: "type", slug: "alpha", effective_hash: "e1" },
      { class: "agent", slug: "beta", effective_hash: "e2" },
    ]);
    const b = dependencyHash([
      { class: "agent", slug: "beta", effective_hash: "e2" },
      { class: "type", slug: "alpha", effective_hash: "e1" },
    ]);
    expect(a).toBe(b);
  });

  it("different effective_hash on a dep changes the dependency_hash (cascade)", () => {
    const before = dependencyHash([
      { class: "type", slug: "foo", effective_hash: "v1" },
    ]);
    const after = dependencyHash([
      { class: "type", slug: "foo", effective_hash: "v2" },
    ]);
    expect(before).not.toBe(after);
  });

  it("adding a dep changes the dependency_hash", () => {
    const before = dependencyHash([
      { class: "type", slug: "foo", effective_hash: "e1" },
    ]);
    const after = dependencyHash([
      { class: "type", slug: "foo", effective_hash: "e1" },
      { class: "skill", slug: "bar", effective_hash: "e2" },
    ]);
    expect(before).not.toBe(after);
  });
});

describe("effectiveHash — karma × emptiness binding", () => {
  it("composes from content_hash + dependency_hash via the v0.1 byte format", () => {
    const ch = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const dh = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    expect(effectiveHash(ch, dh)).toBe(sha256Hex(`1.1|${ch}|${dh}`));
  });

  it("changes when content_hash changes", () => {
    expect(effectiveHash("c1", "d1")).not.toBe(effectiveHash("c2", "d1"));
  });

  it("changes when dependency_hash changes", () => {
    expect(effectiveHash("c1", "d1")).not.toBe(effectiveHash("c1", "d2"));
  });

  it("two definitions with identical bytes but different dependencies produce different effective_hash", () => {
    const ch = "samebytes";
    const dh_a = dependencyHash([
      { class: "type", slug: "parent", effective_hash: "v1" },
    ]);
    const dh_b = dependencyHash([
      { class: "type", slug: "parent", effective_hash: "v2" },
    ]);
    expect(effectiveHash(ch, dh_a)).not.toBe(effectiveHash(ch, dh_b));
  });
});
