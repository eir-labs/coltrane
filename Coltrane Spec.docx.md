![][image1]

**COLTRANE**

The Well-Tempered Agent System

Technical Specification v2.0

March 2026

the founder  |  Eir Is Real, Inc.

# **Contents**

1\.  What Coltrane Is

2\.  The Well-Tempered Type System

3\.  The Primitives & Behavioral Tuning

4\.  The Agent Model

5\.  The Domain Type Registry

6\.  The Database Schema

7\.  The MCP Surface

8\.  Coltrane’s Own Profile

9\.  The Trust & Access Model

10\.  Company Context & Proactive Mode

11\.  Product Development Domain

12\.  Pricing Architecture

13\.  The Bootstrap Sequence

14\.  Testing Strategy

# **1\. What Coltrane Is**

Coltrane is the agent orchestration layer for Eir Is Real, Inc. In v1, it was the service layer between EirTests and the agents that do the work. In v2, it becomes the operating system for any company that uses it.

Coltrane composes bands of agents, briefs them with context, dispatches them to containers, records their performance, learns from the results, and — critically — designs new agents and workflows autonomously when existing ones don’t cover what’s needed.

The core insight is that agent orchestration follows musical principles. The v2 type system is built on the concept of well-temperament: accept imperfection locally to enable expressiveness globally. The system doesn’t aim for mathematically perfect abstractions. It aims for playability across all keys — meaning any domain, any depth, any customer context — while preserving the character of each configuration.

*The jazz metaphor is structural, not decorative. Standards are setlists. Agents are players. Gigs are performances. The type system is the temperament. The system learns from recordings the way a jazz musician learns from tape.*

## **The Three Zones (unchanged from v1)**

| Zone | What Lives Here | Changes When | Owner |
| :---- | :---- | :---- | :---- |
| IDENTITY | Agent profiles, type registry, standards, tool registry, playbooks | Code deploy or approved proposal | Human \+ Coltrane |
| INTELLIGENCE | Baselines, patterns, gig notes, agent tunings, site history, KPIs, company context | Every gig (automatically) | The system |
| EXPERIENCE | Frontend, customer API, billing, auth, share links, cockpit UI | Product cycles | Human |

## **What Changed from v1**

| Aspect | v1 | v2 |
| :---- | :---- | :---- |
| Scope | Service layer for EirTests | Operating system for any company |
| Agent types | 7 fixed roles (analyst, reviewer, etc.) | 6 composable primitives → unlimited roles |
| Output types | Fixed per role (DimensionAnalysis, etc.) | 6 core types \+ open domain registry |
| Type creation | Manual, by human | Autonomous by agents, governed by resolution protocol |
| Workflow creation | Manual standard definitions | Coltrane designs from natural language goals |
| Domains | EirTests only | Any domain (testing, code, bizdev, ops, product dev) |
| Self-modification | Learner proposes tuning changes | Full self-building: types, agents, standards, tools |

# **2\. The Well-Tempered Type System**

Every piece of data flowing through Coltrane is typed. The type system has two layers: an immutable core and an open extension layer.

## **Core Types (immutable, 6\)**

These are the harmonic law. They never change. Every output in the system extends exactly one of these.

| Core Type | Produced By | What It Represents | Key Required Fields |
| :---- | :---- | :---- | :---- |
| Signal | SENSE | Raw acquired data from a source | id, source, data, completeness, acquisition\_cost |
| Interpretation | INTERPRET | Meaning extracted from signals | id, input\_refs, frame, claims\[\], confidence |
| Judgment | JUDGE | Evaluation against criteria | id, input\_refs, criteria\[\], verdicts\[\], reasoning\_chain\[\] |
| Plan | PLAN | Sequenced actions with dependencies | id, input\_refs, objective, steps\[\], budget |
| Artifact | CREATE | Novel created thing | id, input\_refs, artifact\_type, format, content, validation\_criteria\[\] |
| Verdict | VERIFY | Pass/fail with evidence | id, target\_ref, pass, checks\[\] |

## **Design Principles**

Fixed structural bones, domain-flexible flesh. Each core type defines the minimum required fields for pipeline validation and provenance tracking. Domain-specific fields live in extension schemas that specialize the core type without changing it.

The well-temperament tradeoff: the core types are deliberately minimal. A Signal doesn’t know whether it came from a URL scan or a CRM query. An Artifact doesn’t know whether it’s a Playwright test or a sales email. This “imperfection” — the loss of specificity at the core level — is what enables universality. Domain types add the specificity back, but only where needed.

## **Reference Types (closed set, 6\)**

Relationships between outputs are explicitly typed and directional. These form the provenance graph.

| Relation | Meaning | Example |
| :---- | :---- | :---- |
| derived\_from | This output was produced using that output | Judgment derived\_from Interpretation |
| validates | This verdict checks that artifact or claim | Verdict validates Artifact |
| challenges | This judgment disputes that interpretation | Judgment challenges Interpretation |
| refines | This is a better version of that | Interpretation v2 refines Interpretation v1 |
| triggers | This plan caused that action | Plan triggers Artifact creation |
| contains | This composite contains that element | Report contains Finding\[\] |

# **3\. The Primitives & Behavioral Tuning**

Primitives are the six atomic cognitive operations that cannot be decomposed further. Every agent is a composition of one or more primitives. Each primitive maps 1:1 to a core output type.

## **The Six Primitives**

| Primitive | Verb | Output Type | Temperature | Prompt Archetype |
| :---- | :---- | :---- | :---- | :---- |
| SENSE | Acquire raw information | Signal | 0.0–0.3 | Extractive. Report what you see, add nothing. |
| INTERPRET | Turn signals into meaning | Interpretation | 0.3–0.6 | Structured reasoning. What patterns emerge? |
| JUDGE | Evaluate against criteria | Judgment | 0.2–0.5 | Adversarial. Challenge this, find the weakness. |
| PLAN | Determine what to do next | Plan | 0.3–0.6 | Strategic. Given goals and constraints, what’s the sequence? |
| CREATE | Produce a novel artifact | Artifact | 0.5–0.9 | Generative. Produce something new that meets criteria. |
| VERIFY | Test against reality | Verdict | 0.0–0.2 | Deterministic preferred. Does this pass or fail? |

## **Behavioral Tuning Profile**

Each primitive carries a behavioral tuning profile that governs how it’s prompted and evaluated. This binds tightly to the primitive, not the agent.

PrimitiveTuning {  
  primitive: PrimitiveType  
  temperature\_range: \[min, max\]  
  prompt\_archetype: string         // system prompt skeleton  
  success\_criteria: string\[\]       // what "good output" means  
  model\_selection\_rule: {  
    factors: \['task\_complexity', 'depth\_tier', 'budget\_remaining'\]  
    default\_tier: ModelTier  
    escalation\_triggers: string\[\]  // conditions that push to higher tier  
  }  
}

Model selection is loose — resolved at dispatch time by primitive × complexity × depth × budget. The learner optimizes at the primitive level, and improvements generalize across every agent that uses that primitive.

## **Composition Rules**

Agents compose multiple primitives. The pipeline validator enforces that every primitive’s input is satisfied either by a preceding primitive within the same agent, or by an upstream agent’s output.

Illegal progressions (enforced at composition time, not runtime):

| Illegal Progression | Why | Consequence |
| :---- | :---- | :---- |
| CREATE without upstream INTERPRET or PLAN | Creating from raw observation without reasoning is hallucination | Agent definition rejected |
| VERIFY without a target | Nothing to verify | Pipeline validation fails |
| Circular dependencies | Infinite loops | Standard composition rejected |

## **Standard Compositions**

Common agent patterns that emerge from primitive composition:

| Pattern | Primitives | Use Cases |
| :---- | :---- | :---- |
| Analyst | SENSE \+ INTERPRET \+ JUDGE | Dimension analysis, competitor analysis, root cause analysis |
| Reviewer | JUDGE \+ VERIFY | Adversarial review, fact-checking, code review |
| Builder | PLAN \+ CREATE \+ VERIFY | Test writing, code patching, feature implementation |
| Explorer | SENSE \+ INTERPRET \+ PLAN | Discovery, reconnaissance, iterative research |
| Reporter | INTERPRET \+ CREATE | Report generation, documentation, summaries |
| Full-Chain | SENSE \+ INTERPRET \+ JUDGE \+ PLAN \+ CREATE \+ VERIFY | Bug fixing, feature builds, complete workflows |

# **4\. The Agent Model**

An agent is a named composition of primitives with typed inputs/outputs, a creative identity, and scoped permissions. The agent model separates what the system enforces (type safety, pipeline validation) from what agents are free to evolve (identity, method, reasoning approach).

## **Agent Profile Schema**

| Field | Type | Space | Purpose |
| :---- | :---- | :---- | :---- |
| slug | TEXT | Identity | Unique name: trust-analyst, bug-fixer |
| version | INT | Identity | Increments on each approved change |
| status | ENUM | Identity | draft → review → approved → active → retired |
| parent\_id | UUID | Identity | Lineage — what version this evolved from |
| created\_by | TEXT | Identity | human:eugene or agent:coltrane |
| primitives | TEXT\[\] | Harmonic | Which primitives this agent composes |
| input\_types | TEXT\[\] | Harmonic | Domain type slugs this agent consumes |
| output\_types | TEXT\[\] | Harmonic | Domain type slugs this agent produces |
| domain | TEXT | Harmonic | eirtests, code-maintenance, company-ops, etc. |
| identity | TEXT | Creative | Who you are, core behavior (2–3 paragraphs) |
| method | TEXT | Creative | Step by step how you work |
| constraints | TEXT\[\] | Creative | Hard rules, never violate |
| depth\_profile | ENUM | Tuning | skim | quick | standard | deep |
| permissions | JSONB | Permissions | Tools, model tier, budgets, write access |

The profile has three spaces: Creative (identity, method, constraints — Coltrane can draft and evolve freely), Harmonic (primitives, types — enforced by the type system), and Permissions (tools, model tier, budgets — always requires human approval).

## **Agent Permissions**

| Field | Type | Purpose |
| :---- | :---- | :---- |
| allowed\_tools | TEXT\[\] | Explicit whitelist of tool slugs |
| disallowed\_tools | TEXT\[\] | Explicit blacklist (overrides allowed) |
| model\_tier | ENUM | economy | standard | premium |
| max\_tool\_calls | INT | Hard ceiling per gig |
| max\_token\_budget | FLOAT | Hard ceiling on spend per gig (USD) |
| can\_write\_outputs | BOOL | Can this agent write to the outputs table |
| can\_trigger\_standards | BOOL | Can this agent escalate to another standard |

# **5\. The Domain Type Registry**

The domain type registry is the open extension layer. Domain types are named specializations of core types that add domain-specific fields. They are the rigid contract the UI binds to.

Agents create domain types autonomously. The cost of allowing this is low: if the base types are solid and validated, a new domain type that extends them is just more structured data. Worst case it’s unused. It doesn’t break anything downstream because the base contract is still honored.

## **Domain Type Schema**

| Field | Type | Purpose |
| :---- | :---- | :---- |
| slug | TEXT | finding, dimension-analysis, code-patch, competitive-gap |
| version | INT | Increments on evolution |
| extends | TEXT | Which core type this specializes (FK to core\_types) |
| domain | TEXT | eirtests, code-maintenance, competitor-intel, company-ops |
| status | ENUM | active | deprecated | retired |
| schema | JSONB | Additional fields beyond the core type |
| required\_fields | TEXT\[\] | Which extension fields are mandatory |
| ui\_binding | JSONB | display\_component, sort\_fields, summary\_template (nullable) |
| created\_by | TEXT | human:eugene, agent:bug-fixer, coltrane:learner |
| times\_produced | INT | Usage counter (updated by recorder) |
| times\_consumed | INT | How often downstream agents consumed this |
| satisfaction\_rate | FLOAT | How often downstream consumers accepted output (0–1) |
| forked\_from | TEXT | If adapted from another domain’s type |

## **Type Resolution Protocol**

Every agent, before producing output, runs the type resolution protocol. This ensures reuse over reinvention:

1\. The agent identifies what it needs to output and the required fields.

2\. type\_resolve searches the registry using a cost function that scores field coverage (40%), usage gravity (15%), downstream satisfaction (20%), domain affinity (15%), and recency (10%).

3\. Score ≥ 80: use the existing type as-is.

4\. Score ≥ 50: extend the closest type with additive fields (new version).

5\. Score \< 50: create a new domain type, register it, continue without interruption.

*The type registry is a living ecosystem. Types are born, thrive, or die based on usage — like species. The governance isn’t about preventing creation; it’s about natural selection after the fact.*

## **Versioning Rules**

| Change Type | Approval | Effect |
| :---- | :---- | :---- |
| Additive (new optional fields) | None — auto-increment | Existing consumers unaffected, ignore new fields |
| Modified (type changes, new required fields) | None — new version, old version stays | Both versions coexist, consumers pinned to old until upgrade |
| Breaking (field removal, semantic redefinition) | Human approval required | Can break UI bindings. Only gated type operation. |

## **EirTests Domain Types (seeded)**

The initial domain types migrated from the v1 schema:

| Domain Type | Extends | Key Fields | UI Binding |
| :---- | :---- | :---- | :---- |
| finding | Interpretation | pattern\_key, severity, title, evidence, location, recommendation, is\_novel, kpi\_impacts\[\] | FindingCard |
| dimension-analysis | Interpretation | dimension, score (0–100), confidence, findings\[\], exploration\_notes | DimensionScoreCard |
| dimension-review | Judgment | reviews\[\] (verdict per finding), score\_adjustment, review\_notes | ReviewPanel |
| test-brief | Plan | finding\_id, assertion, priority | TestBriefRow |
| test-spec | Artifact | spec\_code (Playwright), selectors\_verified | CodeViewer |
| test-result | Verdict | pass, assertions\_passed, assertions\_failed, error\_log | TestResultCard |
| readiness-report | Artifact | readiness\_score, dimension\_scores\[\], findings\_ranked\[\], benchmark | ReadinessReport |
| site-cache | Signal | pages\[\], resources\[\], console\_errors\[\], network\_requests\[\] | — |

# **6\. The Database Schema**

The existing 7 tables from v1 remain. We add 4 new tables and evolve 2 existing ones. Backward compatibility is maintained through database views.

## **New Tables**

### **core\_types**

Immutable. Seeded once with exactly 6 rows. The harmonic law.

CREATE TABLE core\_types (  
  slug          TEXT PRIMARY KEY,  
  base\_schema   JSONB NOT NULL,  
  primitive     TEXT NOT NULL,  
  description   TEXT NOT NULL  
);

### **domain\_types**

The open registry. Agents create rows autonomously. Usage stats updated by the recorder.

CREATE TABLE domain\_types (  
  id              UUID PRIMARY KEY DEFAULT gen\_random\_uuid(),  
  slug            TEXT NOT NULL,  
  version         INT NOT NULL DEFAULT 1,  
  extends         TEXT NOT NULL REFERENCES core\_types(slug),  
  domain          TEXT NOT NULL,  
  status          TEXT NOT NULL DEFAULT 'active',  
  schema          JSONB NOT NULL,  
  required\_fields TEXT\[\] NOT NULL DEFAULT '{}',  
  ui\_binding      JSONB,  
  created\_by      TEXT NOT NULL,  
  parent\_version  INT,  
  forked\_from     TEXT,  
  times\_produced  INT NOT NULL DEFAULT 0,  
  times\_consumed  INT NOT NULL DEFAULT 0,  
  active\_agents   TEXT\[\] NOT NULL DEFAULT '{}',  
  last\_used\_at    TIMESTAMPTZ,  
  satisfaction\_rate FLOAT,  
  changelog       JSONB,  
  created\_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  
  UNIQUE(slug, version, domain)  
);

### **outputs**

The universal output store. Instead of separate tables per output shape, one table stores all typed outputs. This is the biggest structural change from v1.

CREATE TABLE outputs (  
  id              UUID PRIMARY KEY DEFAULT gen\_random\_uuid(),  
  core\_type       TEXT NOT NULL REFERENCES core\_types(slug),  
  domain\_type     TEXT NOT NULL,  
  domain\_type\_version INT NOT NULL,  
  domain          TEXT NOT NULL,  
  gig\_id          UUID NOT NULL REFERENCES gigs(id),  
  agent\_slug      TEXT NOT NULL,  
  phase           TEXT,  
  primitive       TEXT NOT NULL,  
  data            JSONB NOT NULL,   \-- validated against core \+ domain schema  
  input\_refs      UUID\[\],  
  created\_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  
  cost\_usd        FLOAT,  
  tokens\_used     INT,  
  duration\_ms     INT  
);

### **output\_refs**

The provenance graph. Every relationship between outputs is explicitly typed.

CREATE TABLE output\_refs (  
  id              UUID PRIMARY KEY DEFAULT gen\_random\_uuid(),  
  from\_output\_id  UUID NOT NULL REFERENCES outputs(id),  
  to\_output\_id    UUID NOT NULL REFERENCES outputs(id),  
  relation        TEXT NOT NULL,  
  primitive       TEXT NOT NULL,  
  created\_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  
  CHECK (relation IN (  
    'derived\_from','validates','challenges','refines','triggers','contains'  
  ))  
);

## **Evolved Tables**

\-- agent\_profiles: ADD typed I/O  
ALTER TABLE agent\_profiles ADD COLUMN primitives TEXT\[\];  
ALTER TABLE agent\_profiles ADD COLUMN input\_types TEXT\[\];  
ALTER TABLE agent\_profiles ADD COLUMN output\_types TEXT\[\];  
ALTER TABLE agent\_profiles ADD COLUMN domain TEXT;  
   
\-- standards: ADD composition schema  
ALTER TABLE standards ADD COLUMN composition\_schema JSONB;

## **Backward Compatibility**

The existing findings table becomes a view over the outputs table. Existing queries, the UI, the learner — all continue to work without modification.

CREATE VIEW findings AS  
SELECT   
  o.id, o.gig\_id,  
  o.data-\>\>'pattern\_key' as pattern\_key,  
  o.data-\>\>'severity' as severity,  
  o.data-\>\>'title' as title,  
  o.data-\>\>'evidence' as evidence,  
  o.data-\>\>'location' as location,  
  o.data-\>\>'recommendation' as recommendation,  
  (o.data-\>\>'is\_novel')::boolean as is\_novel,  
  o.data-\>'kpi\_impacts' as kpi\_impacts,  
  o.data-\>\>'status' as status,  
  o.agent\_slug as agent\_role,  
  o.data-\>\>'dimension' as dimension,  
  o.created\_at  
FROM outputs o  
WHERE o.domain\_type \= 'finding' AND o.domain \= 'eirtests';

The gigs, performances, baselines, finding\_patterns, and standards tables remain unchanged. They continue to serve their v1 functions.

# **7\. The MCP Surface**

32 MCP tools organized into 8 categories. These are the hands that Coltrane and agent-building agents use to interact with the system.

## **Understand the World**

| Tool | Input | Output | Purpose |
| :---- | :---- | :---- | :---- |
| type\_resolve | core\_type, domain, semantic\_description, required\_fields | action (use/extend/create), candidates\[\], recommendation | Find matching types before creating new ones |
| type\_browse | domain?, extends?, min\_usage?, status? | types\[\], stats | Explore the type registry |
| tool\_registry\_browse | category?, usage\_min?, unused\_since? | tools\[\], usage\_stats\[\], dependency\_map | Explore available tools |
| output\_query | domain\_type?, gig\_id?, agent\_slug?, data\_filter?, date range | outputs\[\], total\_count | Find past outputs |
| output\_trace | output\_id, direction (up/down/both), max\_depth? | graph (nodes \+ edges), root\_signals, terminal\_outputs | Trace provenance chain |
| company\_context\_read | company\_id | CompanyContext (products, goals, pain\_points, tech\_stack, access\_grants) | Understand the customer |
| execution\_history\_read | company\_id?, domain?, date\_range? | gigs\[\], performance\_summary | What’s been run before |
| access\_grant\_check | company\_id, resource\_uri, required\_permissions\[\] | granted, missing\_permissions, expires\_in | Verify what Coltrane can touch |

## **Build Things**

| Tool | Input | Output | Purpose |
| :---- | :---- | :---- | :---- |
| type\_register | slug, extends, domain, schema, required\_fields, reason | registered, domain\_type\_id, version | Create new domain type (resolver must run first) |
| type\_extend | slug, domain, fields\_to\_add, reason | new\_version, changelog\_entry | Add fields to existing type (additive only) |
| agent\_define | slug, primitives, input/output\_types, identity, method, constraints, permissions | agent\_profile\_id, validation result | Create a new agent (starts as draft) |
| agent\_evolve | slug, changes, reason, evidence? | new\_version, cascade\_check | Improve existing agent’s creative space |
| standard\_compose | slug, domain, phases\[\], depth\_overrides, composition\_schema, credits\_formula | standard\_id, validation result | Create a new workflow |
| standard\_simulate | standard\_slug, mock\_input, depth | phases\[\], estimated\_cost, estimated\_duration | Dry-run a workflow |

## **Run Things**

| Tool | Input | Output | Purpose |
| :---- | :---- | :---- | :---- |
| gig\_dispatch | standard\_slug, input, depth, company\_id | gig\_id, manifest | Start a workflow |
| gig\_monitor | gig\_id | status, phases\_complete, current\_agent, outputs\_so\_far | Watch execution |
| gig\_abort | gig\_id, reason | aborted, cleanup\_result | Stop if needed |
| output\_write | core\_type, domain\_type, data, input\_refs, refs\[\] | output\_id, validation result | Record typed outputs |

## **Improve Things**

| Tool | Input | Output | Purpose |
| :---- | :---- | :---- | :---- |
| agent\_validate\_pipeline | agents\[\], standard\_slug? | valid, graph, unsatisfied inputs, illegal progressions | Check agent compositions work together |
| health\_check | entity\_type, slug, window? | usage, success\_rate, cost, trend, recommendations | Per-entity performance |
| system\_health | window? | gigs\_run, cost, type/agent/tool stats, bottlenecks, budget | System-wide vitals |
| system\_audit | scope, check | findings\[\] with severity and recommendations | Find problems proactively |
| proposal\_create | change\_type, target, changes, reason, evidence? | proposal\_id, cascade\_impact | Propose changes that need approval |
| tool\_propose | slug, type (in\_house/off\_shelf), spec or external info, reason | proposal\_id | Propose new tools or MCPs |
| tool\_deprecate\_propose | slug, reason, usage\_stats | proposal\_id, affected\_agents | Retire unused tools |
| capability\_research | need, context | approaches\[\], mcp\_options\[\], recommendation | Research what’s needed for new capabilities |

## **Manage Context**

| Tool | Input | Output | Purpose |
| :---- | :---- | :---- | :---- |
| company\_context\_suggest\_update | company\_id, field, current\_value, suggested\_value, evidence | proposal\_id | Update company knowledge (requires approval) |

## **Approval Requirements**

| Tool | Requires Approval | Reason |
| :---- | :---- | :---- |
| tool\_propose | Always | Expands system capability surface |
| tool\_deprecate\_propose | Always | Removes capability |
| company\_context\_suggest\_update | Always | Changes what Coltrane believes about a company |
| proposal\_create (permission changes) | Always | Coltrane can request but never grant permissions |
| type\_register/type\_extend (breaking) | Only if breaking | Additive changes are free; breaking changes need gate |
| All other tools | Never | Operate within type safety guardrails |

# **8\. Coltrane’s Own Profile**

Coltrane is itself an agent — the agent-building-agent. It is the one bootstrap exception: seeded manually in the database, not created through the MCP tools. After bootstrap, everything else flows through the system.

## **Profile Definition**

| Field | Value |
| :---- | :---- |
| slug | coltrane |
| primitives | sense, interpret, judge, plan, create, verify (full chain) |
| input\_types | goal, company-context, execution-history |
| output\_types | domain-type-definition, agent-definition, standard-definition, execution-plan, design-rationale, improvement-proposal |
| domain | coltrane-meta |
| model\_tier | premium |
| max\_tool\_calls | 100 |
| max\_token\_budget | $5.00 |

## **Operating Modes**

Design Mode: Someone describes a goal. Coltrane decomposes it into primitives, resolves or creates the types needed, defines the agents, composes the standard, estimates the cost, and presents the plan. It prefers reusing existing agents and types over creating new ones. It prefers simple pipelines over complex ones.

Execution Mode: A standard exists. Coltrane composes the manifest, dispatches agents, monitors execution, and delivers results. It intervenes only if something fails or if it spots an optimization opportunity mid-run.

Proactive Mode: Coltrane periodically reviews company context and execution history. It looks for recurring manual requests that could be automated, underperforming agents, unused types, cost optimization opportunities, and company goals that don’t have supporting workflows yet. It generates improvement proposals with evidence.

## **Key Constraints**

* Never execute a standard without presenting the design first (unless auto-approve is on)  
* Never create a new type if type\_resolve scores an existing type ≥ 80  
* Never create an agent with permissions exceeding the requesting user’s access level  
* Never touch customer code, data, or infrastructure without explicit scoped permission  
* Always estimate cost before execution; abort if estimate exceeds budget  
* Maximum 10 new types per design session — if more needed, the goal is too broad  
* Maximum 5 new agents per design session — same reason  
* Always include a design-rationale output explaining choices  
* Never store customer credentials — use scoped access tokens with TTL  
* Proactive proposals require minimum 50 data points before suggesting changes  
* Can never approve its own proposals

## **The Full Loop**

When Coltrane receives a natural language goal:

1\. Load company context — goals, products, access grants, execution history.

2\. Decompose goal into required output types — what does the human need to receive?

3\. Work backward: what primitives produce these? What inputs do those need?

4\. Check the roster: do agents exist that fit? Score by primitive match × domain match × performance history.

5\. For gaps: design new agents. Always resolve types before registering new ones.

6\. Compose the standard: phases, chairs, conditions, depth overrides.

7\. Simulate: estimate cost, duration, output tree.

8\. Present the design with rationale, including what company goal this serves.

9\. On approval: switch to execution mode and dispatch.

10\. Post-execution: record everything, trigger learner, check for optimization opportunities.

# **9\. The Trust & Access Model**

When Coltrane touches customer infrastructure — especially codebases — trust must be structural, not conversational. The type system creates 7 enforceable trust boundaries.

## **Access Grant Schema**

AccessGrant {  
  id: string  
  company\_id: string  
  resource\_type: 'repo' | 'environment' | 'database' | 'api' |  
                 'email' | 'crm' | 'calendar' | 'social' | 'analytics'  
  resource\_uri: string  
   
  permissions: {  
    read: boolean  
    write: boolean  
    execute: boolean  
    deploy: boolean  
  }  
   
  scope: {  
    branches: string\[\]        // \['fix/\*', 'eir/\*'\]  
    paths: string\[\]           // \['src/\*\*', 'tests/\*\*'\]  
    excluded\_paths: string\[\]  // \['.env', 'secrets/\*\*'\]  
    max\_files\_per\_patch: number  
    max\_lines\_per\_patch: number  
  }  
   
  expires\_at: string          // TTL, must be renewed  
  requires\_pr: boolean  
  requires\_human\_review: boolean  
  auto\_revert\_on\_failure: boolean  
}

## **Seven Trust Boundaries**

| \# | Boundary | What’s Enforced | Enforcement Mechanism |
| :---- | :---- | :---- | :---- |
| 1 | Finding quality | Bug must be structured with evidence | Finding domain type schema validation |
| 2 | Access scoping | What can be read/written/executed | AccessGrant typed fields (not prose instructions) |
| 3 | Plan validation | Planned changes must fit within grant | Plan.files ⊆ Grant.scope, checked before execution |
| 4 | Phase-based tool exposure | Write tools only available in CREATE phase | MCP tool filtering per phase per primitive |
| 5 | Artifact validation | Patch must include verification criteria | Artifact schema requires validation\_criteria\[\] |
| 6 | Deterministic verification | Tests must actually pass | Verdict schema requires checks\[\] with method field |
| 7 | Post-write audit | Files modified match plan and grant | Recorder validates output against declared scope |

*None of these are "we hope the AI follows instructions." They’re structural. The type system makes it impossible to skip steps. You can’t produce a code-patch without validation criteria because the schema rejects it. You can’t write to files outside the grant because the MCP server doesn’t expose those paths.*

## **Phase-Based Tool Exposure**

Tool availability is the intersection of: agent.permissions.allowed\_tools ∩ access\_grant.permissions ∩ phase\_permissions. During SENSE phase, only read tools are exposed. During CREATE phase, write tools become available but only within the scoped paths. Deploy tools are never exposed unless the grant explicitly allows it.

# **10\. Company Context & Proactive Mode**

Coltrane doesn’t just execute workflows — it understands the company it serves. The company context is loaded into Coltrane’s briefing every time it runs, enabling goal-aware design and proactive intervention.

## **Company Context Schema**

CompanyContext {  
  company\_name: string  
  products: \[{ name, type, url, description }\]  
  goals: \[{ goal, priority, timeframe, metrics\[\] }\]  
  pain\_points: string\[\]  
  tech\_stack: string\[\]  
  team\_size: number  
  existing\_tools: string\[\]  
  access\_grants: AccessGrant\[\]  
}

## **Continuous Monitoring Loops**

| Loop | Frequency | What It Does | Example Intervention |
| :---- | :---- | :---- | :---- |
| Goal Monitor | Daily | Check progress metrics against company goals; if off-track, design intervention | "Conversion score stuck at 51\. Deep trust analysis designed. Cost: $1.20." |
| Market Watch | Configurable | Scan competitor sites/social/news; compare against last scan | "Competitor launched free tier. Battle card and response strategy drafted." |
| Customer Health | Per customer, daily | Check usage, support tickets, deal stage progression | "Nourish deal stalled 14 days. Personalized follow-up designed." |
| System Optimization | Weekly | Run system\_health and system\_audit | "JUDGE primitives getting 95% acceptance with haiku. Proposing model downgrade." |
| Capability Gap | On failure | Diagnose what went wrong; research capability expansion | "Need PDF extraction for financial docs. Found MCP option. Proposing integration." |

# **11\. Product Development Domain**

The same primitives that fix bugs can build features from scratch. The difference isn’t the primitives — it’s the complexity of the PLAN and the scope of the CREATE.

## **Feature Build Standard**

| Phase | Agents | Primitives | Outputs | Checkpoint |
| :---- | :---- | :---- | :---- | :---- |
| 1\. Understand | product-analyst | SENSE \+ INTERPRET | codebase-signal, architecture-interpretation | — |
| 2\. Specify | spec-writer | INTERPRET \+ JUDGE \+ PLAN \+ CREATE | feature-specification | Customer reviews spec |
| 3a. Schema | schema-builder | PLAN \+ CREATE \+ VERIFY | db-migration | — |
| 3b. API | api-builder | PLAN \+ CREATE \+ VERIFY | api-routes | — |
| 3c. Frontend | component-builder | PLAN \+ CREATE \+ VERIFY | ui-components | — |
| 3d. Tests | test-writer | PLAN \+ CREATE \+ VERIFY | test-suite | — |
| 4\. Integrate | integration-agent | SENSE \+ INTERPRET \+ JUDGE \+ VERIFY | integration-verdict | — |
| 5\. Review | code-reviewer | JUDGE | code-review | Loop to Phase 3 if critical issues |
| 6\. Deliver | delivery-agent | PLAN \+ CREATE | PR, deployment-plan, documentation | — |

## **Product Development Domain Types**

| Domain Type | Extends | Key Fields |
| :---- | :---- | :---- |
| feature-specification | Artifact | acceptance\_criteria\[\], components\_needed\[\], api\_changes\[\], db\_changes\[\], estimated\_complexity |
| db-migration | Artifact | migration\_sql, rollback\_sql, tables\_affected\[\], data\_loss\_risk |
| api-route | Artifact | method, path, handler\_code, input\_schema, output\_schema, auth\_required |
| ui-component | Artifact | component\_name, framework, code, props\_schema, dependencies\[\] |
| integration-verdict | Verdict | full\_test\_results, regression\_detected, regressions\[\], performance\_impact, deployment\_ready |

## **From-Scratch Builds**

From-scratch builds follow the same pattern with a heavier Phase 0: the existing onboarding pipeline (personas, requirements, site modeling) serves as the discovery phase. The rest is PLAN \+ CREATE \+ VERIFY at larger scale.

## **Access Model for Builds**

| Parameter | Bug Fix | Feature Build | From Scratch |
| :---- | :---- | :---- | :---- |
| Branch pattern | eir/fix/\* | eir/feature/\* | eir/build/\* |
| Max files per patch | 5 | 30 | 100 |
| Max lines per patch | 500 | 2,000 | 10,000 |
| Deploy allowed | No | No | Staging only |
| Requires PR | Yes | Yes | Yes |
| Requires human review | Yes | Yes | Yes |
| Auto-revert on failure | Yes | Yes | Yes |

# **12\. Pricing Architecture**

Standard complexity maps directly to cost. The credit formula is tied to primitive count × depth × model tier.

## **Cost Profiles by Standard Type**

| Standard Type | Agents | Estimated Cost | Estimated Time | Credit Cost |
| :---- | :---- | :---- | :---- | :---- |
| Readiness Scan | 27 | $0.50–$1.50 | 1–3 minutes | 25–50 credits |
| Bug Fix | 3–5 | $0.50–$2.00 | 20–60 seconds | 10–25 credits |
| Feature Build | 8–15 | $5–$20 | 5–30 minutes | 50–200 credits |
| From-Scratch App | 20–50 | $50–$200 | 1–4 hours | 500–2000 credits |
| Competitor Analysis | 5–8 | $2–$8 | 2–5 minutes | 25–75 credits |
| Market Watch (recurring) | 3–5 | $0.50–$2.00/run | Background | 10–25/run |

## **Credit Formula**

credits \= base\_cost(standard)  
         \* depth\_multiplier(skim: 0.5, quick: 0.75, standard: 1.0, deep: 2.0)  
         \* model\_multiplier(economy: 0.5, standard: 1.0, premium: 2.0)  
         \+ per\_agent\_cost(agents.length \* 0.5)  
         \+ tool\_cost(external\_tool\_calls \* 0.1)

# **13\. The Bootstrap Sequence**

Each week produces something testable in isolation. Each week’s output becomes the next week’s input. Coltrane starts dumb (migrating known configs) and gets progressively more autonomous (designing novel workflows from goals).

*You seed the schema. Coltrane seeds the players. The tour seeds the knowledge. The type system is the foundation because without it, nothing Coltrane builds is validated.*

| Week | Stage | Deliverables | Tests | Coltrane Can... |
| :---- | :---- | :---- | :---- | :---- |
| 1 | Type System | 6 core types in DB. domain\_types table. outputs table. output\_refs table. Schema validator function. Seed \~18 EirTests domain types. | 30+ schema validation tests | Nothing yet (no MCP) |
| 2 | MCP Surface (minimal) | 5 tools: type\_resolve, type\_register, type\_browse, agent\_define, output\_write. Hardcoded test calls. | 20+ MCP integration tests | Nothing yet (no profile) |
| 3 | Bootstrap Run | Coltrane profile seeded manually. First bootstrap gig: read existing agent configs, migrate into new type system via MCP tools. | Migration correctness | Migrate existing agents into new schema |
| 4 | Pipeline Validation | 3 more tools: agent\_validate\_pipeline, standard\_compose, standard\_simulate. Coltrane composes existing EirTests standards. | 30+ pipeline tests | Compose and simulate workflows |
| 5 | Recorder \+ Provenance | output\_trace, output\_query tools. Recorder writes to outputs table. Backward-compat findings view. 50 readiness scans through new system. | 20+ reconciliation tests | Run workflows and record typed outputs |
| 6 | Learner \+ Governance | agent\_evolve, type\_extend, proposal\_create, health\_check tools. Learner batch jobs over typed outputs. | Learner threshold tests | Observe, analyze, propose improvements |
| 7 | Design Mode | Full MCP surface (32 tools). system\_health, system\_audit, tool\_propose, capability\_research. Natural language goal intake. | End-to-end goal → execution | Design novel workflows from goals |
| 8 | Gloves Off | Auto-approve on. Burn-in period. Watch type registry grow, new agents appear, standards evolve. Collect data. | Manual QA \+ monitoring | Full self-sustaining operation |

# **14\. Testing Strategy**

Testing is organized by layer. Each layer can be tested in isolation with hardcoded inputs.

## **Type System Tests**

| Test | What It Verifies |
| :---- | :---- |
| Insert output against core type schema, validate | Core type validation works |
| Insert output against domain type schema, validate | Domain type validation works |
| Insert output with bad schema, verify rejection | Validation catches garbage |
| type\_resolve returns correct scores for known types | Resolution cost function works |
| type\_register fails if resolver found score ≥ 80 | Reuse enforcement works |
| type\_extend creates new version, old version survives | Versioning works |
| Breaking change without approval is rejected | Governance gate works |
| Backward-compat findings view returns correct data | Migration doesn’t break existing UI |

## **Pipeline Validation Tests**

| Test | What It Verifies |
| :---- | :---- |
| Agent with CREATE but no upstream INTERPRET rejected | Hallucination guard works |
| Valid pipeline (SENSE → INTERPRET → JUDGE) passes | Happy path works |
| Missing input type in pipeline flagged | Unsatisfied inputs detected |
| Circular dependency rejected | Loop detection works |
| Standard composition with invalid agent mix rejected | Composition validation works |
| standard\_simulate returns accurate cost estimate (±20%) | Cost estimation works |

## **Trust & Access Tests**

| Test | What It Verifies |
| :---- | :---- |
| Agent in SENSE phase cannot access write tools | Phase-based tool exposure works |
| Plan referencing files outside access grant is rejected | Plan validation works |
| Artifact without validation\_criteria\[\] is rejected | Artifact schema enforced |
| Verdict without checks\[\] is rejected | Verdict schema enforced |
| Expired access grant blocks execution | TTL enforcement works |
| Files modified outside declared scope flagged by recorder | Post-write audit works |

## **End-to-End Tests**

| Test | What It Verifies |
| :---- | :---- |
| Natural language goal → designed standard → executed → outputs in DB | Full loop works |
| 100 readiness scans through new system, findings view works | Backward compatibility |
| Bug fix standard: finding → triage → fix → review → PR | Cross-domain workflow works |
| Type created by agent during execution, consumed by downstream agent | Dynamic type creation works |
| Learner observes 50+ gigs, proposes model downgrade with evidence | Learning loop works |
| Full provenance trace from final artifact to original signal | Provenance graph complete |

# **Appendix: The Well-Temperament Analogy**

Bach’s Well-Tempered Clavier demonstrated that a single tuning system could enable music in all 24 keys, each with its own character. The system accepted small imperfections in individual intervals to gain universal playability.

Coltrane’s type system follows the same principle:

| Musical Concept | Coltrane Equivalent |
| :---- | :---- |
| Key signature | Domain (eirtests, code-maintenance, competitor-intel, company-ops) |
| Notes | Core output types (Signal, Interpretation, Judgment, Plan, Artifact, Verdict) |
| Intervals | Relationships between types (derived\_from, validates, challenges, etc.) |
| Chords | Agent primitive compositions (SENSE \+ INTERPRET \+ JUDGE \= analyst) |
| Counterpoint rules | Pipeline validation (no CREATE without INTERPRET, no circular deps) |
| Dynamics (pp–ff) | Depth tiers (skim, quick, standard, deep) |
| The score | Standard definitions (the formal workflow specification) |
| The performance | A gig (one execution of a standard) |
| The recording | The outputs \+ provenance graph (captured by the recorder) |
| The ear training | The learner (improves from recordings) |
| The temperament | The type resolution protocol (where to accept imperfection) |
| The bandleader | Coltrane itself (designs the ensemble, calls the tunes) |

*Same instrument. Any key. The music works.*

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAZV0lEQVR4Xu1c+XMb133PP9MZTxtLFEkBBEFAACmRlmQ7juNJ4sRpmmmaTDKTZDqdZqY/pOkPmSZtnOl42thWJFHCvYuDp3gDBEFAEKnIluzEhxInipxIsiVKFIlj7339ft8Ci8ViQYAkXGum+vhZJLHXe5/3vfc9fIY8xo74jPmDx6jHY4Ja4NEgSKn8VImk4k/JcOxTxiNBEEekfx2fHQymT/rmCSkSVTaf8enhkSBIIrIzONcfyUGTFJFQKXpE8JigFnhMUAs8JqgF9k2QQPZvUTtMkCqKpOYZ94n9EiQo5POv/EqkXdozOkmQKkysX3unKMDMdQT7IEhVNkmxazLvCWVtU0l5H8FLBwn6cXTSFUi6Iplbnz5BID6C4I5fckVSg4Hsy1feRalW9iJKHSFIVVWecP1MFpqLSe7pHhbYF0GAu8WCM5KD1hvNSRgK7wUdIQjwfHhZI6jrVT/Zy0xZYL8EqUR8JrrgjGShPeebErab9gs1sKxwVqNvSZAKjyFyMx1W8Q7qX7iSKwxTlelnMjxX2ofG12G/BCkqKavEHc0DQXY2s6E2DK6K7eKmrJD7Kl5iQkuCRFn4oHmGBnMiSOIQk3dF0t5gbqXMy4RXScl83p6wX4I0fNc36w5ngKMjkRWiFsyHKRK/u+ENpXtjmUbr2ZKgocB0TyzvYJLmAxTA+fzNW5py9U1f7JiHp+gMQTIpHkyglsEc3jEfrOCn6+90jS062NQb5iOtCeqJrsAEHA1kqLiYUea2jwaQHWh3FSKoFufsGZ0hCLTmOiEOJtcbTz4RnsG/GwZZEhUwEL2x9MnErOnQTgRJZFsmrnDWwWTdzHzDXQlPxBOvsa5w3s7k/3p8nqhSRwWoQwRhv1VyeHIB/CsM8pvMUmPJAnywnVmzs2CqsjgMwwk7EMQT8swvfdqh3xILNylsPgTJdbCZgWhGUNAENpyyL3SGIA0Qh/TF1kDOnRcubYpmglRVdofmNUXYKvFGGnYgiFO53siCdgite8Poe/3jILmOyOpLUTB/jfZtv+gkQZLCfz6c6GdTICPDEysSEevESCZfOxfTCMoX6izpDgSB0Rnx5Z1M2hFNiqb0QRHh7z5m2RW6fJDJ1h3qHDpJkKgqMMk2NodhEbP+TrHMGY5KoA3FBxpBQ9FUWaod3IEgcNfAuINNu05NbZOSkXCYAOfUZVCu/sDCaok3HOkkOkmQhtNX/qCx4AkniWToN4YrhAZyWZjzekPclKCT/hiwA8HBh7XPKvj5/JKLQbfonM5KHagpWKPDBKmoObxGECRovzYcUqiFePZ0DOLdfjZpnPFmBPE8381mDo5lTvjSnPDAcAUeso1eBKJBncvwt/yIEcSR4sup1WITh1okxBNcg7l1hFNkCxMFHdN3irZYysXMvxSYkTBDwA8tCZJVRZZVjWvIHiBW1m+yTaSn/ePaIVt8Xm5w7OD74Z7/Nrm6BX+ozSLwtrBHgo4HYh5m5vDo0kOFNPZvk1eABchgwUCM+EN1yYUI3OXB4jrDi6RqoywJArm4emNDY+GL8QWVPkTzYyCKzlE0TKCw5rqPdoai2ieXveHFJ0IQUhgtYVNYeUhEHUFUQdqC+xUf9A+6DgGupGKpwXhUgU4XVSe7AoF1b3RtSzbokyr3BSs5tz40S4J4VT0OH9Izb6GJoX3j4DdxZHTBFUnBzb8ykSKkYBwZRyS5wB+ayNpiSbjwrwJJi8DcCrIsKlZnVgkSCKg4TPjXz88qHAenNqaUdZBkb2wJwuLaUBvi+4FTPlAl7QSxXEAe8DnExca1D7erk2ZNEM+7gldBTwfDy2RTFrRTZQwdtcuPBq4aK5k8KCXMU7lytCeeGRz7detSp6Q+5HBC3cErP5jImY8aJEgZiEyC8LuZWUd07S2aPewAkcgQlQyxlfGDa3+Ak1BnKTm1fOzUknbCn6tcwBkfK5UxeJmEdqY1QQq4PJTQIWYRgsxqh3h3ZFG7fA07iQZaA162KUGuA5IFR+1sBg1QK/C8OMCuHPNd9oQy9vMr5sM1ghTx9UtvecJptB1MyhbNPJdI38M6A9dMg0Ua+Bw9lcCB0R4/QL2ozRj8tnCX1wo0EOmpRNSl/VAs6wlcBgHUCrVmgqiF/sdzcW8w05OYH9NvKZH8hw8gL4O7HQ3MiSpeSE+GaEKG/5yTFYmGdruZB6GSLGP3xBfPJLRKFrDjimQOMNPmU3WCaHbJySXleCQDUk2fkbGzuadHp40RnRHogRQVVPdkYFLrE3S9aDxDAUUs2sJT9mi6N54Kvn1TL8jaJ+ApGWc4r/1pJgg7o8A8Odl5dzgrVeUS/AFN5TL9kfxtFaw2aBS1Yyqq7kB8xRussFMQQQCbph2SIL6rqn2TOWrmkSCIs96FA4KFPpq9WIkoDwk5yCxgPzT1YS5f+M37NA+SG9UOPi8qsvNMHIQOTgZ50ZYf6LivkCPhdZT50ApRKtb6xbNTwD707ya9hZkgKrna092+ZZQ8ii+9GkJaQe9ejWsWjaCzE8hDoXe8Iju2aLYsmp2GBjALEJ2ArToUnXYwWOGDBpd8K/s2CrLFFQgzQeizBcJL2z/O/057JLDrjiS7R+c38bg5puAJTqVAhKdiK1r/etklQajN3gNSeNI3gdwFlv/zjXe0DzfRIaAuHw/O0lqqWYKAE+3pzlhaqNp/V/CiO5Q7Eru0CapsUKABZlXzWdC2YYZ1kTNBkkd87JGJa+ABbTGUHXsg/ZGwCbenqmqtkmaCdCiAUsEbWIYxa8+2j68dPzdbRkk3n4zFC17oOz3Vz+BMHvTPlKplRWD03u2NI5Fcbyx7IJIsVsLG4nD4yt9Oz2+hzJaxhCPxiqRKkO8KBbQnElkiZCQw/xa9A0c4b2RmgMl1J1KDZ6e0O3NgA1X1wPgqWIN+VPBcsyKrrArfC0199uwSKDsOBJQjdPEtPFCz8c3QlCANKg3YoAdYDIulwcqAajzjWxAgzsGwoaa0OGxFfDY0CxwBp6BraI8oGcDnl0/FwAMcZlLDv7ygVK6qmmx6ZW0CtVpbTeDxc7CC/aE5GNjh8BpIFw1OVbJRcrFoK5+YSh8KLRfMIasCl/FEuasQcIVwmiuc74nlHPFL/ut/Ikq7uUkLggjGYdImKdwipDs2q+kttnD+O+dDtJ5Vg4g9FIdPVWoaoC9XOKXi+2VhgF3+2Vu/A21squ7NwZMCSORAbP0qWFKVRosFcoBdAtsPD/psaJa30g9JIZ+dmnGHsEQFrS+U/3b2bbAJaN2tjJQlWhNUg6r8JP82uJWeOCqwO5yGCfwzfi4LVRFQUTelF3wzuu+/uiUV6KH7KBttTltTYEWFPs8xVrHKYLYrMSQFjB4njZcH/VMQDYDQgfiA9j2XWN60CGZbYxcESdRnEUl6gU154msOGgqAKg2OztxDtcHBa+rCyeWRV0a1AXhC2T/QfqlWTnC3QIZLkjuxAtZau79YL5C8VPzm2QlPYBUiRiAIqPFGU9cJirAWlxjObQu7IMiIuw/E7rH5QX9Fem3Bi88nVkpySRMRmEZgc/DsKJzQ9XqgnYi2fYDz+CMhoONdiYxwj4c/4WHbhBdJeebGfXtiSXsBBfF0V3gVLD3ZrgvOdos9EgTiUiL8HbXijMH+obMbf/uV1WsEyx0QCZOyKH2HmbtLBDQ7HQUEEb/fpu6DhhMKWiXS65sFoQb/DWExEPTF2atEKdP5aubc2sJeCSJagKeW5Yf/NJUFH9dfib/TzvE1LG3RDL59W7h3lLnhWErXODA6TiYJse7uPYE1mhAEkYnMS/T1raIKBRWjHxQDTsYHG42i9r9MvIk5N/trCI67xpKDgfznoqnaSZ8MQGpeei0C8gKZB8ivncm746k/UxtIO2gQW8zaQDcxVgRjCZEXdDhx/QMBhbAFrAkC0bi2LUFoBwkEmDpPOPn9c2NcqWx+r1AFtc/ypkrs8RRah+jCP19803xSpwFaXCLq4dg6+NNDwaz/XhEcKExsY1kHU1Matl37aOP42KKL1sWB1sHEXEsZtyYI3M57ND5ER8BUonituX0XFu9sQCbNa04N/VotCIG/3lNJdzyDHWoDcBradU6ScIJlsVjkYHa4XejmyH+NHmXmTDVpRaYWCiDwdyD1+59whZRqZACaaI+mTrBp41WWsCaIjk66Qcjxc4taIK83iM3ATUDebEtcfSYwxWEAVMcFxESqIrVpljEAUJV/eM0/wF7uieH75aHwgkRF2HxqE6i0/GyKryDW/sbPTw/5ljyBN4COwWDaEa2UrqANjK072VnfX+7Wd9wa1gTVQcFKbHhj48h4CsI/OhUoWRpxlXJBPPWsP4GmUZJo0NgWQEoKhBuKVopqeoPY6j3zuTsB81O4U4l7efyiM3KhK7qq3wqcmjeYsyUgns6PhFdB1j4kmM22S39bBNEJ5bREv8yB2f7GzEy/74JWK9AIwldX8RRwd8yXfzo4Zr5DM6jiSd8i5bqOIGjd0/n2tewWJzlj2cEg1pggHYVsUb+PJ7h0MngB8lKeK4m8UJPrdu/dDkGWUMFOcL/hSVdgxoHhPAZmGlm7MM6qrGckpuZkcy/4x7EO0QYElQOrRyutmCd7Q2lPZBHisTtikWwr+3ynuEeCMLGQhTI11SVSUnkRRPdYKAX9Q5vQJjgtzzazU5n8xGq5zYmmr6f72cV/f++jMhantpASrKHI4Eza1nhr7JEgS5Sw0C62HzfTQoqZl0qL5LrPXWjPE6Klp03m950MN6KTBO0WHK65wgq8iR1UVSbddybONQm7/i/xaRIE4cpgaFErQhqbnUV/D0H7/qxHZ/CpEkSdyYHx3GAgR4snVHwgNI1kzn5oUQJAukplGddASJAAYf5Q4nZfwNgdPmWCEBI5cTamLYuB5o1l/9REdG4ScgJjnDQuKWPy/YEV8FZbJd7y5E7hESAIg2+eqBJW/hWOcKVGI/+QiM+xS73V6LTeYOGLpk+Oo0eCIJp9YWkQ6/iYYpspevp03MYuuSIYypsIQjM/s7pPX74DHgmCdgBQtakKB4LL2otMSB3sTP4NiA8ieZ2jXv+SMWHuLPZKkIyv8yBJ48i2oMg8ZM1YOeRpNZEeaWPBKQRyCoaVAq1RNDlfIcciE7T4TS1UePWF6TkQM1t0oUJQJDd4Ptfs6v1jrwSVyPfD0yDznnCa1oBxww/G+OH0UGDyHgyrDe+iSsW7hCR++/uNhwVJtC6MbqjbtnCt3tIXzan4nliofQjPjV7CjX2fDHZFkIIZhkqGJ/DFttEQmJo7krL75u7TFRTmexjgqVpcyOaO/+JV82ENnKSXU4ELmz8P5PNlDnJ07UNcoxXP0Wz6E8FuCFLFXyTfdIVztlhyZ4Ic2O/MoUDqDzvOazejW9y0K5G1Tt8FfIGhE3QgkpRl+dmxZf1lvIPFMms7Ars3tEUQrUYL3wlNmHJLMJweZtrO5jwhfP8FKbU3MosLl+lRILEvuIIOuFH+ZXJ8rFbBgkscr8fN51DA5T2xmgQdnFzniaSVDbQPnxzL1ZWfO422CIJufu9X52nBRXt1URmVKzhXRDMqaEkiGIePCdEWCGgEQXMF1itfyGHAJtly+Wp1MpARTCysIIm8HV/AVwgCbfJE6UL1KkFgxdrM+feG1gRxRLx+v+j1X9HHow3pI3xX0OA8sERNIF3QU1BPOHW7YQAvnWPwbUT1bgen58tNrBW4uc+F6oritT5Qmiz60FG0JqjMCTY2p6+nskdTvWNZASccy9Hmsym+8qpPD3nh2hH/TG2SQczksiu0jK/SKNGD7BoWWBukrAIFSR+eWdcXjJqaN7xIV5gXm3dnX2hNkONUxNghtz/P0ZXaOwg2XR9V9VBMbpBZhiRCOwQXvasSW1QrAKI5d8SyrWv0EulnreXIFku5mXkPkxW3K+sDOoudCIKMWabbafSuQLBzu5XHAGfEKUR/zWKLZsFU0QP4z0NStgdr1gec0Q/fb12hh2542FrojAvxmJTREuGH4exDGd8bdBY7EQTx2OHERW3BODRvMPuFxDy+nNyRIfAoQ7+KVd9EZ92h/NQ9ej79B466dLcNgV8gixlYKxx7LWRMU4+PXe4PzPaHV40EwZSMhNLmK/eNnQi6qxAwsXoPnjy32M46CaW6okFrTiZ5n9PWGKAmvTia0JSrn0YJw2wS10A3h0TkWyoumNa4ABE+xCRvb5UUBXIccnAyYywk9QUgC2mlrbvETgT1ja0Zc8LvTq1UV881BXTOXVVJrfWEVh5qmZKIltQVzurWxMHkUbZ2DmIkuS+yqBPkiC4eO5MQqSIrWDHj+tmLFe6YtM03Q9cGdxLWBMGzSypENCkcDx3MQPCSrCr4kmAH8OTQ6Zi2Hlhr4MKw8K55KJn8bLqaYdLWNT5vvkMDom+96w7X/NcRZk1fJwY/njkbHKiG4yP+zFfnL9Vf3QFYE8QT9SunoqDVmjPuiWWHTrOStgSgBjRFqB44fGn57eu2YBrslPaCDOwopEszuHVJW2uBOftQ+KKRoBuGe1kBsn3ZEV7Sa0CQ5fzHux/oC+5URTrJvqGbIQhQPwEn1oQgIvHD47XBOKcubzSoNqqNJBbVwgdlghsdojVr1RPP9I8uv3bzAV1FUIVCeuN1rlriePNNDQArM/mbyubFGgWGCfrWmTAWXqtHuyeSXCsLsAdYE8SLEBzWnm1buiIKuLRUAG3BL1lB/H6bPAWuxDCAfloAhU4fiV65YrqjIH1+dF6fbXxlnhi3zk6r4NVtT6AufP/R+7jYkFDRFZWi11fZDgDpvit2BXOOTyBStCbow20CKq33rCeR7Erges2usVRvPAUC0h1Ht+pkKxtv9IbfALC4AsaYq1+bxBEVUiqdIFck1XIs2/hasS56JlzFnoM3/OlcBnM0GkyAHRhiV/a/hNYS1gQ9G4obTaO2SaCu1fMCHYXzB+KraCSrO1aM+JfoZF29PbK2g++CQKtISsY4EAh9yp+orYySS/ZqrADtMLN0vdn2g33DmqCB2KxnNwSNRNK4W6ZQ+JgI1aSiDl2+tPGqD6ifNp+kQ8XV4kaCHLjSCV97aBRlN3kI6/W7OQJLsmwxKx2BmSBtIoYDM4bOpcA3QUNVD615gnn4HXeWBeaPstO/BddW5AUJt02YbqWhTFRXZEYfDM3y06rI7ahiyoi/Oj10Pp6Prii0yA1RJSduQfiqpzKg8rfxCisJsu7R7mBNUD+urNHXjWYxmoMDKn7TATr70naZk8QS3Ycs0XX9atMa/U/m5geZmi0HT/SF4EKBPMSdFE1wn5e7E3UE0V3MFPQnEKQXiYAprMs2kKFSP9t6S2YrWBAky7Ibt8xW6xtsZqfMvTlEIt0i5NBYzmaoVPTE0z99p+KMrCFyByO4s0qjBs4/Fp8msqIRBIb478OVnb5a+wt+2iCNovxkdA3SQAc70zc6R2jWvTeYCdJwcHy+K6F3InOtzDWfbyvIBQgF/rRF6FaqjB6OQ+uK526Zz64At54RcuJ03MWgc9RsEMSWpKSFmpQFqaQXUiBk9zAZIoh1m7VlVSLi8OgFfIOG2xNhelLJrd113whrgl583YfBXnVUveHl++qG+aTmeLhx87v+cTfunTJ4Lo2gRJZuzLMA5KWz79/sjue0wi6wcyR2aekBKFBNTW4bfD9E6n83d1nEsdcIAmV8gF/IdFmzoRDW2/2zuKV4LzqAsCYIVGqw+p1O/XRDyrcTc9iPBlk2QsUtAcrW1qbRATW0TKOCoY0j5MY2X/dSIHz52Jjxuy3wneTRYC3y6k4kjaEP8KvQFW9OwxpFW3zx6OxK7aTdw5qgApGeiUzpjwFlBmUZjF66i2a6KYqEnFxaH/FVtKOel0rzhtLPT62aNpBvSfJXg9PAjlFs7ednJKnu69Agm9OLG9COnb+yVTBUyFTypf8edbKrug5CGx5bV6y26rYPa4JgPnmF/M1kyljo1IZ96NzsC/75u3QvXYmQOyr54Rm2P7Z0jF038YL1BzY3cG5NFLd7onXFLe/oxDZuZyVvbpW+EFocCC0ZR4U7C/3pokJ3DBhwn9QMUD/NXb/mn9yUyV1V+fqZ8b6pOmMHN/GOvfExdnKHmLQ1rAlSCXXh98seg6Jp48eEI4EVZXBz0HqjOWf4MoTRWAatJ8jO5L88vkK/EEF2+uaMk++M5ED4B4OYrOBOz0hdGAlHNwvUodYPDb/DKlKLD+HpYIbgE3ckCaIHwaTR5MFNCryK9Zl98dOEIA2YHMukfyLpZFK49MQwwlprCKyBI3xhH0x9DDRX0w6VFOAO+r52ywZPAaLBN9HHNtELiTgidRms+SZ0krrjGZBwXBaxb+xEEBpPDO7xmwX6Jle9fnQKEECimLCLMGO0oWBDh9wRkIWsN/6m61yczpn5LUyhWB4KTB6NXILUV7vEG16EG0KA7gyl7OeXe5jFDWSABn1NnQ5u67f7luwx3COhbb4HXYNeeYMZ8Oh9sbUP0FrtfJNdYEeCdOBXE6qSwqchivVNHUwkHb5FdyQ3PH7Fy6zbxlcPRhdf/vDGH7HEVWz2houKhAgh+IkA25dYfgpsFrvyhG/qaGxxXOAVWcT6W8spF0EywFiLP7p0rW88e9g/5wxmHGcWes8vDrFzBRpJCpZpx17RHkH/j/GYoBZ4TFALPCaoBR4T1AKPCWqB/wVmjI5xLQXW3QAAAABJRU5ErkJggg==>