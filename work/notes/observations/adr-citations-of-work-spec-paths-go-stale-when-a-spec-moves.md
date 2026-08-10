# ADR citations of `work/specs/<status>/...` paths go stale when the spec moves

2026-08-10, noticed while sweeping this change's docs for unresolvable citations.

`docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md` (the third consequence, in the original 2026-08-08 decision text) cites `work/specs/ready/revm-engine-behind-runtx.md`; that spec is now at `work/specs/tasked/revm-engine-behind-runtx.md`, so the path does not resolve. Not fixed here (it is pre-existing text inside a clause the amendments already mark discharged, and out of this task's scope), but the general shape is worth deciding once: a spec FLOWS through status folders, so any ADR that cites one by full path is guaranteed to rot. Citing the slug, or the spec title, would not.
