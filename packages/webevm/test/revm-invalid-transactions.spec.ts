/**
 * revm-invalid-transactions.spec.ts — A REPLAYED OR INVALID TRANSACTION IS
 * REFUSED, identically on both engines, in the node's own words, with nothing
 * left behind.
 *
 * Four transactions a real node rejects — a replayed nonce, a far-future nonce,
 * one the sender cannot afford, and one whose gas limit is below its intrinsic
 * gas — are submitted through `eth_sendRawTransactionSync` to a revm-backed node
 * AND to a default-engine (`@ethereumjs/vm` `runTx`) node built from identical
 * state (helpers/invalid-transactions.ts).
 *
 * THE PART THAT MATTERS IS NOT THAT THEY FAILED. It is that nothing moved: no
 * balance, no nonce, no storage slot, no block, no receipt, no entry in a block's
 * transaction list, and no gas in the next block's `cumulativeGasUsed`. A
 * rejection that half-committed is worse than a transaction that succeeded
 * wrongly, and only a state reading catches it.
 *
 * AND THE REFUSAL IS THE NODE'S OWN SENTENCE. Left to the engines, the same
 * rejection reads `the tx doesn't have the correct nonce. account has nonce of: 1
 * tx has nonce of: 0 (vm hf=cancun -> block number=2 hash=0x93… )` on one and
 * `Transaction(NonceTooLow { tx: 0, state: 1 })` on the other — a wasm-shaped
 * string in a field a client reads as prose, which is the same class of mistake
 * as the one recorded in the `rejectionMessage` JSDoc of `src/revm.ts` (revm's
 * validation text arriving as `eth_call` return data). The node refuses these
 * itself, BEFORE any engine sees them, so the message is one sentence in the
 * node's own vocabulary — geth's leading clause, so viem's error mapping
 * recognises it — with the numbers in it, no engine text in it, no `data` on the
 * error, and CHARACTER-FOR-CHARACTER the same on both engines.
 *
 * Its OWN cut (helpers/cut-revm.ts), because that bundle carries the revm `.wasm`
 * and the shared cut must keep costing the other specs nothing.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

/** Everything a refusal must be, held against BOTH engines. */
const REFUSED = {
	outcome: 'refused',
	// -32000 is the JSON-RPC server-error range geth uses for a transaction its
	// pool refuses, and the code the node already refuses an over-limit gas limit
	// with (`refuseIfOverBlockGasLimit` in `src/node.ts`). NOT 3
	// `execution reverted`: nothing executed, and a client reading a revert here
	// would look for return data that does not exist.
	code: '-32000',
	// ...which is also why there is no `data`. `data` on an `execution reverted`
	// error means ONE thing to a client: the callee's revert payload.
	hasData: 'false',
	namesCause: 'named',
	namesNumbers: 'named',
	engineIndependent: 'engine-independent',
	// THE HALF A "DID IT THROW" TEST MISSES: no balance, no nonce, no slot, no
	// block number changed across the refusal.
	moved: 'NOTHING',
	receipt: 'none',
	transaction: 'none',
	inABlock: 'no',
	// ...and the node still mines, at the very nonce the refused transaction
	// claimed, into the NEXT block, with a `cumulativeGasUsed` the refused
	// transaction contributed nothing to.
	recovered: 'mined 0x1',
	blocksMined: '1',
	cumulativeGasUsed: 'equal to its own gasUsed',
	// ...and `receipt`/`transaction`/`inABlock` above are ABSENCES rather than a
	// mis-computed hash: the same hashing finds the transaction that DID mine, in
	// both of the places the refused one was looked for.
	lookupByHashWorks: 'the mined transaction IS found by the same hashing',
} as const;

/**
 * The five refusals, each with the slot 7 reading that says how many
 * transactions REALLY ran: the case's setup plus its follow-up, never the
 * refused one. A rejection that half-ran leaves this one higher.
 */
const EXPECTED = {
	// A REPLAY — the reason nonces exist. One setup transaction, one follow-up.
	replayedNonce: {...REFUSED, counterSlotAfter: '2'},
	// A GAP THIS NODE WILL NEVER FILL: it has no mempool to queue the transaction
	// in, so it refuses rather than holding it.
	nonceTooHigh: {...REFUSED, counterSlotAfter: '2'},
	// `value + gasLimit * maxFeePerGas` over the sender's balance...
	unaffordable: {...REFUSED, counterSlotAfter: '1'},
	// ...by exactly ONE WEI, which is where the line really is: the MAX fee the
	// transaction offered, not the effective price it would have been charged.
	unaffordableByOneWei: {...REFUSED, counterSlotAfter: '1'},
	// One gas short of reaching the first opcode.
	belowIntrinsicGas: {...REFUSED, counterSlotAfter: '1'},
	// ...and the same rule where the floor is NOT 21000, because a type-1
	// transaction pays for its access list too. The node's floor is the
	// transaction's own `getIntrinsicGas()` rather than the read path's shared
	// formula precisely so that this case is the node's refusal and not an
	// engine's.
	belowIntrinsicGasWithAccessList: {...REFUSED, counterSlotAfter: '1'},
} as const;

/**
 * The leading clause of each refusal, verbatim. geth's own phrasing, because a
 * client (viem maps `nonce too low` / `nonce too high` / `insufficient funds` /
 * `intrinsic gas too low` onto typed errors) should recognise this node's
 * refusals as the ones it already knows — and because inventing a private
 * vocabulary for a rule the whole ecosystem already names would be a second
 * dialect for no gain. The address is the suite's sender, lower-cased as
 * `@ethereumjs/util`'s `Address` renders it.
 */
const SENDER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const CLAUSES = {
	replayedNonce: `nonce too low: address ${SENDER}, tx: 0, state: 1.`,
	nonceTooHigh: `nonce too high: address ${SENDER}, tx: 99, state: 1.`,
	unaffordable: `insufficient funds for gas * price + value: address ${SENDER} have 1000000000000000000 want 1000000000001000000.`,
	unaffordableByOneWei: `insufficient funds for gas * price + value: address ${SENDER} have 1000000000000000000 want 1000000000000000001.`,
	belowIntrinsicGas: 'intrinsic gas too low: have 20999, want 21000.',
	belowIntrinsicGasWithAccessList:
		'intrinsic gas too low: have 27199, want 27200.',
} as const;

/** The readings minus the whole message, which is asserted on its own below. */
function withoutMessage(readings: Record<string, any>) {
	return Object.fromEntries(
		Object.entries(readings).map(([label, r]) => {
			const {message, ...rest} = r as Record<string, string>;
			return [label, rest];
		}),
	);
}

test("revm invalid transactions: a replayed nonce, a far-future nonce, an unaffordable tx and a gas limit below intrinsic gas are refused identically on both engines, in the node's own words, with state untouched", async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape, as in `revm-fees.spec.ts`.
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({
		phase: 'once',
		params: {mode: 'invalid-transactions'},
	});

	console.log('\n[revm-invalid-transactions] errors:', r.errors);
	const c = r.results.revmInvalidTransactions as Record<string, any>;
	console.log('[revm-invalid-transactions]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// The battery really ran the two engines against each other, and not one
	// engine against itself — the failure mode that would make every assertion
	// below pass while measuring nothing.
	expect(c.referenceEngineId).toBe('@ethereumjs/evm');
	expect(c.engineId).toBe('revm-wasm');

	// 1) THE DIFFERENTIAL: every reading — including the refusal's whole message —
	// is the same on both engines. `mismatches` names `case.field` with both
	// values, so a failure says which case broke rather than "not equal".
	expect(c.mismatches).toEqual([]);

	// 2) ...AND THE ABSOLUTE STATEMENT, on BOTH engines, because two engines can
	// agree on an answer neither should have given.
	expect(withoutMessage(c.refusals.underTest)).toEqual(EXPECTED);
	expect(withoutMessage(c.refusals.reference)).toEqual(EXPECTED);

	// 3) THE REFUSAL IS THE NODE'S OWN SENTENCE, and it opens with the clause a
	// client already knows. (Its guidance half — what to do about it — is checked
	// as the node's honest-edge convention rather than pinned word for word.)
	for (const [label, clause] of Object.entries(CLAUSES)) {
		expect(c.refusals.underTest[label].message).toContain(clause);
		expect(c.refusals.reference[label].message).toContain(clause);
	}

	// 4) THE CONTROL UNDER THE WEI-EXACT CASE: the largest value the sender CAN
	// afford is MINED, on both engines, and it really ran (the slot moved). Without
	// this, "one wei more is refused" would hold on a node that refused every
	// value-bearing transaction.
	const affordable = {
		value: '999999999999000000',
		outcome: 'mined 0x1',
		counterSlot: '1',
	};
	expect(c.affordableToTheWei.underTest).toEqual(affordable);
	expect(c.affordableToTheWei.reference).toEqual(affordable);

	// 5) THE NONCE CHECK, FROM OUTSIDE. Against an on-chain nonce of 5, the READ
	// path — which checks no nonce — answers the identical call, the transaction
	// path REFUSES nonce 99 as too high, and the transaction path MINES nonce 5.
	// The third leg is what makes the first two a statement about the nonce rather
	// than about a broken node, and the whole triple is what says the check is
	// chosen by the CALL PATH rather than by anything a caller passes.
	const nonceCheck = {
		onChainNonce: '5',
		read: 'ok',
		txAtFutureNonce: 'refused: nonce too high',
		txAtCorrectNonce: 'mined 0x1',
	};
	expect(c.nonceCheck.underTest).toEqual(nonceCheck);
	expect(c.nonceCheck.reference).toEqual(nonceCheck);

	await h.dispose();
});
