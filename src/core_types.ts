export type CoreType =
  | "Signal"
  | "Interpretation"
  | "Judgment"
  | "Plan"
  | "Artifact"
  | "Verdict";

export type Primitive =
  | "SENSE"
  | "INTERPRET"
  | "JUDGE"
  | "PLAN"
  | "CREATE"
  | "VERIFY";

export type ReferenceType =
  | "derived_from"
  | "validates"
  | "challenges"
  | "refines"
  | "triggers"
  | "contains";

export const CORE_TYPES: readonly CoreType[] = [
  "Signal",
  "Interpretation",
  "Judgment",
  "Plan",
  "Artifact",
  "Verdict",
];

export const REFERENCE_TYPES: readonly ReferenceType[] = [
  "derived_from",
  "validates",
  "challenges",
  "refines",
  "triggers",
  "contains",
];

export const PRIMITIVE_OUTPUT_TYPE: Readonly<Record<Primitive, CoreType>> = {
  SENSE: "Signal",
  INTERPRET: "Interpretation",
  JUDGE: "Judgment",
  PLAN: "Plan",
  CREATE: "Artifact",
  VERIFY: "Verdict",
};
