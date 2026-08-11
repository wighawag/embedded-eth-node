---
title: Gate 2 keeps finding decision records that are not linked from the done record
date: 2026-08-11
status: open
---

Raised four times now across this drive, on `close-the-residual-holes-in-the-affordability-classification`, `finish-the-two-oracle-correction-on-the-other-doc-surfaces`, `fees-refunds-and-effective-gas-price-come-from-the-engine` and `eip-2930-access-lists-are-charged-and-warmed`. A repeated finding is a signal about the mechanism rather than about any one task, so it is captured here instead of being patched a fifth time.

The build prompt (`work/protocol/CLAIM-PROTOCOL.md`) tells an agent to record a non-obvious in-scope decision in any durable home and then to LINK it from the done record so it is discoverable. Agents reliably do the first half and reliably skip the second. The decisions land in a JSDoc at the choice site, a Decisions block in `docs/spikes/<slug>/measurements.md`, or the changeset, all of which are legitimate homes; what is missing every time is the pointer from `work/tasks/done/<slug>.md`. The task file moves `backlog` to `done` as a pure rename at 100 percent similarity, so nothing ever adds one, and in at least one case a Decisions block asserted it WAS linked from the done record when it was not.

The consequence is mild per task and compounds across a board: the done record is the one artifact addressed by slug, and it is the last place a decision is findable from.

Worth considering rather than assuming: the runner owns the ready-to-done move, so the pointer is arguably the RUNNER's to write rather than the agent's, which would fix it once instead of asking every agent to remember. That is a dorfl change, not an embedded-eth-node one. Alternatively the repo could stop asking for the link and treat the changeset plus the spike doc as sufficient, which is what actually happens today.

## Update, 2026-08-11 (fifth instance, and now a contract question too)

Raised again on `the-conformance-differential-covers-transactions-on-revm`, which additionally INVENTED a home for the decisions rather than choosing one of the sanctioned ones: `work/notes/observations/decisions-<slug>-<date>.md`, carrying a new `decisionsFor` frontmatter field.

That deserves a decision of its own, because the bucket does not fit. `WORK-CONTRACT.md` defines `notes/observations/` as SPOTTED, UNVERIFIED, append-only signals that leave by DELETION when they stop being live, and it explicitly warns against back-filling an observation to narrate work that is already done. A decision record is none of those things: it is verified, it is durable, and it should not become deletable merely because it stopped being newsworthy. Two of these files now exist in the bucket alongside genuine live signals, which blurs what `ls work/notes/observations/` means.

The maintainer's call, and it pairs with the linkage question above: either bless a real home for build decisions (a `## Decisions` block in the done record itself is the option the protocol already names, and it solves the linkage problem in the same stroke), or say that the changeset plus `docs/spikes/<slug>/measurements.md` are sufficient and stop asking for more. These notes are LEFT IN PLACE pending that call rather than discharged, since they are decision records awaiting ratification and not signals this drive may retire.
