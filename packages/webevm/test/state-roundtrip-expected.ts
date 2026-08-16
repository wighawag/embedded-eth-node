/**
 * state-roundtrip-expected.ts — what BOTH engines must report from the state
 * round-trip suite (test/helpers/state-roundtrip.ts), pinned as literals.
 *
 * WHY LITERALS, AND WHY SHARED. Story 13 of `revm-engine-behind-runtx` is a
 * REGRESSION bar: adopting revm must cost a consumer none of the node's existing
 * features. A bar like that is only worth what the two halves are worth TOGETHER —
 * `state-roundtrip.spec.ts` (default `@ethereumjs/evm`) and
 * `revm-state-roundtrip.spec.ts` (`webevm/revm`) run the SAME suite and
 * assert THIS object, so "the same" is a comparison rather than each engine
 * agreeing with itself.
 *
 * EVERY FIGURE HERE IS A VALUE THE ENGINE COULD ONLY HAVE READ FROM THE NODE'S LIVE
 * STATE AT EXECUTION TIME. `numberAfterSecondTx` is 42 because a cheat wrote 41 into
 * the Counter's slot 0 between two transactions and the second one read it; an
 * engine that had cached the slot from the first transaction reports 2, with a
 * success receipt and no error anywhere. `cheatedCodeSlot7After` is 0x63 because
 * code that arrived with no transaction to announce it was CALLED; an engine that
 * cached "no code at this address" reports 0, also successfully.
 *
 * Balances are deliberately NOT pinned here. They encode the gas schedule and the
 * fee arithmetic, which `test/helpers/fees.ts` and the conformance battery already
 * hold to the wei on both engines; what this suite adds is that the money came out
 * of an account the CHEATS created (`cheatSenderChargedExactly`, asserted as an
 * exact equality inside the suite).
 *
 * It lives in its own module because Playwright refuses to let one spec file import
 * another.
 */
export const STATE_ROUND_TRIP = {
	/** The Counter after its first ordinary increment. */
	numberAfterFirstTx: '1',
	/** `evm_setStorageAt` landed, read back before the next transaction ran. */
	counterSlot0AfterCheat: '41',
	/** THE ASSERTION: the second transaction read the cheated slot, so 41 + 1. */
	numberAfterSecondTx: '42',
	secondTxStatus: '0x1',
	/** The cheated nonce the second transaction was accepted at (`evm_setNonce`). */
	secondTxNonce: '5',
	cheatSenderNonceAfter: '6',
	/** `evm_setBalance` gave the cheated account exactly one ether to spend. */
	cheatSenderBalanceBefore: '1000000000000000000',
	/** Nothing has ever written this slot before transaction 3. */
	cheatedCodeSlot7Before: '0',
	/** THE OTHER ASSERTION: the cheated CODE executed. 0x63 = 99. */
	cheatedCodeSlot7After: '99',
	thirdTxStatus: '0x1',
	/** 42 + 1, on the original node AND on the one reloaded from its dump. */
	numberAfterFollowOn: '43',
} as const;
