# 0011 — The package is named `webevm`

The package published as `embedded-eth-node` through 0.4.0 is published as `webevm` from 0.5.0 on. The old name is deprecated on npm rather than kept in sync; there is no alias package and no re-export shim.

## Why the old name had to go

`embedded-eth-node` was a description, not a name, and it described the thing wrongly in the one word it leaned on. This is not a node: ADR 0004 refuses accounts and signing outright, there is no mempool, no peer set and no consensus, and the RPC surface is a curated execution-only method set that answers `-32601` at its edges. "Node" also reads as Node.js first in an npm context, which pointed at the exact runtime this library is least about. "Embedded" then carried no information: embedded in what, and as opposed to which alternative?

`webevm` fixes both halves. `web` is the browser claim the README leads with (main thread or Worker, IndexedDB persistence, measured on Chromium and WebKit), and `evm` is the honest scope: this is execution, and the engine seam of ADR 0006 makes the EVM behind it the thing a consumer actually chooses. It is also short enough to say, which the old name never was.

## What was considered and refused

`webchain` was the other finalist and is unavailable twice over: the npm name is held by an unrelated 2016 package with real published code, so a name dispute would not succeed, and Webchain was already an ethash blockchain with its own coin (later MintMe Coin), so the name arrives in this domain pre-owned by something else. `chainlet`, `tabchain` and `paneth` were free and rejected for being weaker on the browser claim, on scope honesty, or on both. `evmweb` remains free and was refused only for reading worse.

The known cost of `webevm` is `webvm`: an unrelated npm package, and the well-known CheerpX product that runs Linux in the browser. One letter apart, so expect the occasional misheard name or mistyped install. Accepted knowingly: the domains are far enough apart that context disambiguates, and no candidate that cleared availability was better on the two things that matter.

## Consequences

- **`node` remains the word for the object.** `createNode()` keeps its name, and *slim node* stays the CONTEXT.md term. What this ADR rejects is "node" as the PACKAGE's claim about itself, where it has to stand alone and is read as a full node. Inside the vocabulary, with the glossary next to it, the word is precise and worth keeping.
- **Trusted publishing is bound to the repo NAME.** The OIDC subject claim carries `repo:<owner>/<repo>` plus the workflow filename, so `webevm` needs its own trusted-publisher entry on npmjs.com, and renaming the GitHub repo without mirroring it there breaks publishing with an auth error even though GitHub still redirects the old URL. Recorded here because the failure appears at release time, far from the rename that caused it.
- **Dated records keep the old name.** `work/`, `docs/spikes/` and `CHANGELOG.md` were left alone: they were true when written, and rewriting them would make past records claim a name that did not exist yet. CONTEXT.md carries the translation rule. ADRs 0001-0010 are the exception and had their import/repo PATHS corrected in place, because a decision record is consulted as current guidance and a path that does not resolve is a defect, not a historical fact.
- **No compatibility shim.** `embedded-eth-node` is deprecated with a message naming `webevm`, and stops there. A shim package would have to be versioned, built and published in step with this one forever, to serve consumers of a library at 0.x whose only cost of moving is one line in a package.json.
