# Examples — a learning ladder

Three runnable examples, in the order a newcomer should meet them. Each runs with `npx tsx`; the first two need no API key.

## 1. `hello_band/run.ts` — the pipeline shape (offline)

```bash
npx tsx examples/hello_band/run.ts
```

Two agents — a `SENSE` agent feeding an `INTERPRET` agent — composed into a standard and run as a gig. Types, agents, and the standard are defined **inline in the file**, and a deterministic invoker stands in for the model, so it runs offline with zero infrastructure. Read this first to see the moving parts: register types → define agents → compose a standard → run a gig → get typed, sealed outputs.

## 2. `run_from_genome/run.ts` — definitions as files (offline)

```bash
npx tsx examples/run_from_genome/run.ts
```

The same shape, but **nothing is defined in the file** — the types, agents, and standard are loaded from disk (`core_types/ domain_types/ agents/ standards/`). This is the whole idea: the genome IS the files you can see and edit. Add a capability by adding a file, not by changing code. Output is the typed result plus `loaded_from: "files"`.

## 3. `run_document_factory.ts` — a real inference workflow

```bash
npx tsx examples/run_document_factory.ts
```

The document factory: deterministic structure layers around bounded inference calls (compose-from-facts, then join-the-seams), so a cheap model fills a typed contract instead of free-generating a whole document. This one exercises real model inference. Read it once you understand the genome — it's what the pieces build toward.

---

**The progression:** inline defs (see the parts) → defs from files (the genome model) → a real workflow (what it's for). Run them in order and the architecture explains itself.
