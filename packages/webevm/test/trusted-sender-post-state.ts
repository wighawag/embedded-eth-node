/**
 * trusted-sender-post-state.ts — the post-state BOTH engines must produce after the
 * trusted-sender suite (test/helpers/trusted-sender.ts), pinned as literals.
 *
 * WHY LITERALS, AND WHY SHARED. "The same account is charged and the same nonce
 * advances on either engine" is invisible from a single run: an engine's numbers
 * always agree with themselves. So `trusted-sender.spec.ts` (default
 * `@ethereumjs/evm`) and `revm-trusted-sender.spec.ts` (`webevm/revm`)
 * run the SAME suite and assert THIS object, and the property is the two halves
 * together — relaxing one alone destroys it.
 *
 * WHAT THE NUMBERS SAY. The suite ends with a transaction SIGNED by one account and
 * submitted CLAIMING another (`senderMode:'trusted'`), the two being deliberately
 * interchangeable as far as validity goes (same nonce, both funded). The claimed
 * sender paid and its nonce moved; the signer is untouched, at a round genesis
 * balance and nonce 0. That contrast IS the divergence a re-recovering engine would
 * produce, stated as numbers rather than as a rule.
 *
 * It lives in its own module because Playwright refuses to let one spec file import
 * another.
 */
export const TRUSTED_SENDER_POST_STATE = {
	/** The address the last tx CLAIMED to be: charged, and its nonce advanced. */
	claimedBalance: '999999999944504000012345',
	claimedNonce: '1',
	/** The address that actually SIGNED that tx: untouched, both ways. */
	signerBalance: '1000000000000000000000000',
	signerNonce: '0',
	/** The suite's main sender — every other transaction in the battery. */
	mainSenderBalance: '999999998776691999987655',
	mainSenderNonce: '7',
	/** The Counter the battery drove: 1 increment + `add(7)` + the claimed-sender increment. */
	counterNumber: '9',
	counterStorage0:
		'0x0000000000000000000000000000000000000000000000000000000000000009',
} as const;
