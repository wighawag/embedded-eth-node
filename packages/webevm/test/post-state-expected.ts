/**
 * post-state-expected.ts — the post-state BOTH engines must leave after the
 * five-shape battery (test/helpers/post-state.ts), pinned as literals.
 *
 * WHY LITERALS AS WELL AS A DIFF. The battery already diffs the node under test
 * against a live `@ethereumjs/vm` reference node, which is the strongest oracle
 * available — but two engines can agree on a state NEITHER should have produced,
 * and a diff cannot tell you that. These numbers are the absolute half: what a
 * `SELFDESTRUCT` leaves, what a created contract's code is, which slot a nested
 * frame wrote, and the wei the sender has left after seven transactions at a zero
 * priority fee.
 *
 * WHAT TO LOOK AT FIRST IF THIS FILE FAILS. `selfdestruct.slot0x0` is zero
 * because the account was REMOVED and its storage went with it; `coinbase.balance`
 * is zero and the coinbase is absent from `dumpState` because every transaction
 * here pays NO priority fee, so it ends touched-and-empty and EIP-161 deletes it
 * (correct, on both engines); `survivorAfterKill` still HAS its code and its slot
 * 9 because EIP-6780 removes only a contract destroyed in the transaction that
 * created it.
 *
 * RECEIPT GAS IS DELIBERATELY NOT HERE. This file is about STATE. The receipt's
 * `status` and `contractAddress` are asserted in the spec (the created address is
 * derived, not reported, so it is part of what this task proves); gas is the
 * cross-backend gate's job and is diffed engine-against-engine by the battery
 * itself.
 *
 * It lives in its own module because Playwright refuses to let one spec file
 * import another.
 */
export const POST_STATE = {
	/** Shape 1: storage written and code deployed in ONE creation frame. */
	creation: {
		balance: '0x0',
		nonce: '0x1',
		code: '0x60005460005260206000f3',
		slot0x0:
			'0x000000000000000000000000000000000000000000000000000000000000002a',
	},
	/**
	 * Shape 2: the TOP-LEVEL creation. `topLevelAddress` is what the receipt's
	 * `contractAddress` must name — revm reports no created address at all and
	 * TWO of this transaction's account changes are flagged `created`, so a
	 * derivation that took the first flagged entry would name `childAddress`.
	 */
	nestedCreation: {
		balance: '0x0',
		nonce: '0x2',
		code: '0x60015460005260206000f3',
		slot0x1:
			'0x000000000000000000000000cafac3dd18ac6c6e92c921884f9e4176737c052c',
		childAddress: '0xcafac3dd18ac6c6e92c921884f9e4176737c052c',
		topLevelAddress: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
	},
	/** ...and the child, whose CODE was deployed from inside a sub-frame. */
	nestedCreationChild: {
		balance: '0x0',
		nonce: '0x1',
		code: '0x600160005500',
	},
	/** Shape 3: the outer frame's own slot. */
	nestedFramesOuter: {
		balance: '0x0',
		nonce: '0x0',
		code: '0x6001600055600060006000600060007300000000000000000000000000000000000011115af100',
		slot0x0:
			'0x0000000000000000000000000000000000000000000000000000000000000001',
	},
	/** ...and the slot written one frame DOWN, which is the point of the shape. */
	nestedFramesInner: {
		balance: '0x0',
		nonce: '0x0',
		code: '0x60636007550000',
		slot0x7:
			'0x0000000000000000000000000000000000000000000000000000000000000063',
	},
	/** Shape 4: present before the transaction, GONE after it (EIP-161). */
	emptiedAccount: {
		balance: '0x0',
		nonce: '0x0',
		code: '0x',
		inDumpBefore: 'true',
		inDumpAfter: 'false',
	},
	/**
	 * Shape 5a: destroyed in the transaction that created it. No balance, no
	 * code, NO STORAGE (the slot its constructor wrote reads zero), and gone from
	 * `dumpState`.
	 */
	selfdestruct: {
		balance: '0x0',
		nonce: '0x0',
		code: '0x',
		slot0x0:
			'0x0000000000000000000000000000000000000000000000000000000000000000',
		inDumpAfter: 'false',
	},
	/** ...and the 1000 wei it carried reached the beneficiary. */
	selfdestructBeneficiary: {balance: '0x3e8', nonce: '0x0', code: '0x'},
	/** Shape 5b, before: a contract with code, storage and 777 wei. */
	survivorBeforeKill: {
		balance: '0x309',
		nonce: '0x1',
		code: '0x730000000000000000000000000000000000005555ff',
		slot0x9:
			'0x0000000000000000000000000000000000000000000000000000000000000063',
	},
	/**
	 * ...and after: EIP-6780 moved the balance and removed NOTHING, because it
	 * was created in an EARLIER transaction. A host that deleted on every
	 * `SELFDESTRUCT` fails exactly here.
	 */
	survivorAfterKill: {
		balance: '0x0',
		nonce: '0x1',
		code: '0x730000000000000000000000000000000000005555ff',
		slot0x9:
			'0x0000000000000000000000000000000000000000000000000000000000000063',
	},
	survivorBeneficiary: {balance: '0x309', nonce: '0x0', code: '0x'},
	/**
	 * The sender: seven transactions, 10^24 wei of genesis, and every wei of the
	 * difference is `sum(gasUsed) * 1 gwei` plus the 1000 and 777 wei the two
	 * destructible contracts were funded with. An engine that reported perfect
	 * receipts and committed nothing leaves this at a round `0xd3c21bcecceda1000000`.
	 */
	sender: {balance: '0xd3c21bccf4b1ac1b6b0f', nonce: '0x7', code: '0x'},
	/**
	 * THE DISAPPEARING COINBASE, AND IT IS NOT A BUG. Every transaction in the
	 * battery pays a ZERO priority fee, so the block's beneficiary is credited
	 * nothing, ends each transaction touched-and-empty, and is DELETED under
	 * EIP-161 — on `@ethereumjs/vm` exactly as on revm. Do not "fix" this.
	 */
	coinbase: {balance: '0x0', nonce: '0x0', code: '0x'},
} as const;
