// THE CLI'S --allowedTools / --disallowedTools SPLITTER, vendored verbatim as a test oracle.
//
// Extracted by the drafter on 27 Sep 2026 from the installed Claude Code CLI 2.1.283
// (~/.local/share/claude/versions/2.1.283, a Bun single-file binary), where it is the minified function
// `Hp`, called as `Hp(e.allowedTools ?? [])` / `Hp(e.disallowedTools ?? [])`. Its exact source text
// (sha256 of the string below: 156fbe175a88b7654c0008e5241805c62326542645f61a541278894bec2ff436) is
// asserted to be present in the installed binary by a_grant_never_smuggles_another_grant.test.ts, so a
// CLI upgrade that changes the grammar goes red.
//
// THE GRAMMAR IT IMPLEMENTS: a flag value is split into grants on `,` and on space, but ONLY outside
// parentheses. `(` enters "inside"; `)` leaves it — with NO nesting (a second `(` does not deepen, the first
// `)` closes). So any `)` inside a grant's scope closes it early, and a `,` or space after that point
// starts a new grant: `Bash(npx vitest run),Write,Bash(true:*)` is THREE grants, the middle one a bare
// `Write`. Structure characters: `(`, `)`, `,`, and (outside parentheses) space.
export const HP_SOURCE =
  'function Hp(e){if(e.length===0)return[];let t=[];for(let n of e){if(!n)continue;let r="",s=!1;for(let o of n)switch(o){case"(":s=!0,r+=o;break;case")":s=!1,r+=o;break;case",":if(s)r+=o;else{if(r.trim())t.push(r.trim());r=""}break;case" ":if(s)r+=o;else if(r.trim())t.push(r.trim()),r="";break;default:r+=o}if(r.trim())t.push(r.trim())}return t}';

// eslint-disable-next-line @typescript-eslint/no-implied-eval
export const cliSplitGrants: (values: readonly string[]) => string[] = new Function(`${HP_SOURCE}; return Hp;`)() as (v: readonly string[]) => string[];
