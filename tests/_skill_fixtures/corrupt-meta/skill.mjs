// meta.json next to this file is malformed JSON. loadSkillPackage must raise a named
// SkillLoadError (not a bare SyntaxError) so a broken package fails loud and legibly.
export default function run() {
  return {};
}
