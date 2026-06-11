// The code half throws. Graceful degradation: the runtime catches it, resolves
// nothing from code, and lets the model fill the entire output schema as residual.
export default function run() {
  throw new Error("boom in code half");
}
