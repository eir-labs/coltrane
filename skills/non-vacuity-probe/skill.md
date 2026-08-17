# Non-vacuity probe

A green suite is evidence only if it could have gone red. Before trusting one, try to fool it.

## The measurement that produced this

A committed suite of 40 laws pinned what a generated container configuration must never contain — no runtime socket, no host networking, no host PID namespace, no privileged flag, no added capabilities, no underived mount. Each was its own law with a real assertion. The suite was green.

Replacing the function that generates the configuration with one returning `{}` left **32 of the 40 still passing**, including all six escape laws.

Nothing was faked. Every assertion ran. They asserted absences over a document that did not exist.

## The two shapes

**All-negative laws.** A law whose every assertion is `.not.*` is satisfied by producing nothing at all. The fix is a presence anchor in the same block: establish that the thing being examined exists, *then* ask what is missing from it. Anchor structurally — a rendered document has services and the room is one of them — not on an incidental string.

**Loop assertions with no guard.** The sharper one, because it hides. An assertion inside a `for` over a discovered collection never executes when the collection is empty, and the law reports a pass having examined nothing. Assert the collection is non-empty first.

## Reading the output

`hollow_passable` is a classification and `iterables` is the evidence. Check the evidence. A loop over an inline array or a SCREAMING_CASE fixture is statically non-empty and safe; a loop over a `matchAll`, a `filter`, or a variable assigned from a call is not. The probe exempts the first two and reports what it iterated either way, so a borderline call is settled by looking rather than by trusting.

## Use it on a suite you believe is correct

That is the point of it. This probe was itself wrong five times — it counted only in-block assertions and missed anchors reached through helpers; its guard window was too narrow to clear a sentence-length assertion message; it counted literal loops with a non-global regex. Each version was found by running it against laws that were already right and reading every hit.

A tool with a high false-positive rate is worse than no tool, because it teaches the reader to skip it — which is how the original vacuity survived a whole specification cycle.