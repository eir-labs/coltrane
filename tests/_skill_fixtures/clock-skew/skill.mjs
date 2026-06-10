// Non-deterministic on purpose: two runs of the same input return different output.
// The determinism meter (sister run in runSkillFixtures) must catch this and report
// deterministic:false — proving the meter measures, it doesn't assume.
export default function run() {
  return { t: Math.random() };
}
