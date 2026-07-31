# No account or signing methods, not even optionally

`embedded-eth-node` is *just an embedded node*: it has no accounts, holds no keys, and signs nothing. `eth_sendTransaction`, `eth_accounts`, `eth_sign`, `eth_signTransaction`, `personal_*` and `wallet_*` throw a real `-32601` instead of being implemented. Holding a key would complicate the system for no benefit, because applications are **already** written to work against a remote node that has no account: they sign client-side and submit a signed raw transaction. Supporting a second path would add key custody, an unlock model and a signing surface to serve a shape no consumer needs.

## Considered Options

- **Optionally hold a key** (dev accounts with `eth_accounts` / `eth_sendTransaction`, as anvil and hardhat do). Rejected: it buys nothing for the target consumer, who already has a signing client, and everything it adds is custody complexity.
- **Accept the methods and fake a plausible result.** Rejected outright — a node that pretends to have signed is worse than one that says it cannot.

## Consequences

- The node's write surface is `eth_sendRawTransaction` / `eth_sendRawTransactionSync` only. A viem or wagmi client with a local account works unchanged, because that is already how it talks to a remote node.
- The `-32601` on those methods is a deliberate, tested edge rather than an unimplemented gap (see the honesty checks in the test suite), and it names the alternative in its error message.
- Impersonation is downstream of the same boundary: it is account POLICY, so it lives above this package rather than in it. See `0002-trusted-sender-is-a-primitive-impersonation-is-not-our-job.md`.
