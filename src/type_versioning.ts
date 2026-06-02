export type ChangeClass = "additive" | "modified" | "breaking";

interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: readonly string[];
}

export interface DomainTypeDef {
  slug: string;
  version: number;
  extends: string;
  domain: string;
  status: "active" | "deprecated" | "retired";
  schema: JsonSchema;
  required_fields: readonly string[];
}

export interface TypeChangeProposal {
  change_class: ChangeClass;
  approval_required: boolean;
  next_version: number;
  old_version_stays: boolean;
}

export function proposeTypeChange(
  base: DomainTypeDef,
  next: DomainTypeDef,
): TypeChangeProposal {
  const baseFields = new Set(Object.keys(base.schema.properties));
  const nextFields = new Set(Object.keys(next.schema.properties));
  const baseRequired = new Set(base.required_fields);
  const nextRequired = new Set(next.required_fields);

  const removedFields = [...baseFields].filter((f) => !nextFields.has(f));
  const newRequired = [...nextRequired].filter((f) => !baseRequired.has(f));

  if (removedFields.length > 0) {
    return {
      change_class: "breaking",
      approval_required: true,
      next_version: base.version + 1,
      old_version_stays: false,
    };
  }

  if (newRequired.length > 0) {
    return {
      change_class: "modified",
      approval_required: false,
      next_version: base.version + 1,
      old_version_stays: true,
    };
  }

  return {
    change_class: "additive",
    approval_required: false,
    next_version: base.version + 1,
    old_version_stays: false,
  };
}
