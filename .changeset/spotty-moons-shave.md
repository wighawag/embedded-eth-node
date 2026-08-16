---
'webevm': minor
---

Renamed the package from `embedded-eth-node` to `webevm`.

This is a rename, not a rewrite: the api, the exports and the four subpaths are unchanged, so migrating is `npm i webevm`, removing `embedded-eth-node`, and rewriting the import specifier:

```diff
-import {createNode} from 'embedded-eth-node';
-import {createRevmEngine} from 'embedded-eth-node/revm';
+import {createNode} from 'webevm';
+import {createRevmEngine} from 'webevm/revm';
```

`/revm`, `/worker-entry`, `/worker-host` and `/worker-client` move with it under the new name. `createNode()` and every other exported symbol keep their names.

`embedded-eth-node` is deprecated on npm at 0.4.0 and receives no further releases. Why the name changed is `docs/adr/0011-the-package-is-named-webevm.md`.
