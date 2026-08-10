/**
 * revm-post-state.spec.ts — a chain built on `embedded-eth-node/revm` is the SAME
 * CHAIN as one built on `@ethereumjs/vm`, proved by diffing POST-STATE rather
 * than gas.
 *
 * The cross-backend gate in `packages/benchmarks` asserts that every EVM charges
 * the same gas for the same call, and that bar is structurally blind to this one:
 * an engine can charge every transaction correctly and commit the wrong account
 * changes. So the battery (helpers/post-state.ts) runs five state-shaped
 * transactions on a revm-backed node AND on a default-engine node built from
 * identical state, and diffs everything a consumer can observe about what they
 * left behind — `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `dumpState`.
 * Nothing here reaches into the state manager: an assertion that read
 * `accountStack` would be testing our own bookkeeping, which is the thing most
 * likely to be wrong the same way on both sides of a diff.
 *
 * The five shapes, and the write callback each one reaches: a CREATION
 * (clear-then-write-then-deposit-code in one frame), a NESTED CREATION (two
 * accounts created by one transaction, which is what makes the receipt's
 * `contractAddress` ambiguous and a byte comparison of `dumpState` wrong), STORAGE
 * WRITTEN THROUGH NESTED CALL FRAMES, an ACCOUNT EMPTIED TO NOTHING (EIP-161
 * removal) and a SELFDESTRUCT — in both EIP-6780 halves, because a host that
 * deleted on every `SELFDESTRUCT` would produce a plausible wrong chain and only
 * the "not deleted" half can catch it.
 *
 * Its OWN cut (helpers/cut-revm.ts), because that bundle carries the revm `.wasm`
 * and the shared cut must keep costing the other specs nothing.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {POST_STATE} from './post-state-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('revm post-state: creation, nested frames, code, EIP-161 and selfdestruct all land where @ethereumjs/vm lands them', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape, as in `revm-conformance.spec.ts`.
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'post-state'}});

	console.log('\n[revm-post-state] errors:', r.errors);
	const c = r.results.revmPostState as Record<string, any>;
	console.log('[revm-post-state]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// The battery really ran the two engines against each other, and not one engine
	// against itself — which is the failure mode that would make every assertion
	// below pass while measuring nothing.
	expect(c.referenceEngineId).toBe('@ethereumjs/evm');
	expect(c.engineId).toBe('revm-wasm');

	// 1) THE DIFFERENTIAL: every balance, nonce, code and storage slot the battery
	// reads is identical on the two engines, for all five shapes. `mismatches`
	// names `where.field` with both values, so a failure says which shape broke
	// rather than "not equal".
	expect(c.mismatches).toEqual([]);

	// 2) ...AND THE ABSOLUTE STATEMENT, because two engines can agree on a state
	// neither should have produced. The same literals hold both engines to what a
	// creation, a nested creation, a nested-frame write, an EIP-161 emptying and
	// each half of EIP-6780 actually leave behind (./post-state-expected.ts).
	expect(c.readings).toEqual(POST_STATE);

	// 3) THE CREATED ADDRESS IS DERIVED, AND THE NESTED CASE IS WHERE THAT BITES.
	// revm's outcome carries no created-address field, so `src/revm.ts` derives it
	// from the account changes — and this transaction flags TWO of them `created`.
	// The receipt must name the TOP-LEVEL creation, `keccak(rlp(sender, nonce))`,
	// on both engines; taking "the entry flagged created" would name the child.
	expect(c.receipts.nestedCreation.contractAddress).toBe(
		POST_STATE.nestedCreation.topLevelAddress,
	);
	expect(c.readings.nestedCreation.childAddress).not.toBe(
		POST_STATE.nestedCreation.topLevelAddress,
	);
	// ...and a transaction WITH a `to` creates nothing at the top level, whatever it
	// creates inside, so it carries no `contractAddress` at all.
	expect(c.receipts.nestedFrames.contractAddress).toBe(null);
	expect(c.receipts.emptiedAccount.contractAddress).toBe(null);
	expect(c.receipts.survivorKill.contractAddress).toBe(null);
	for (const [shape, rcpt] of Object.entries(
		c.receipts as Record<string, {status: string}>,
	)) {
		expect(`${shape}: ${rcpt.status}`).toBe(`${shape}: 0x1`);
	}
	expect(c.receipts.creation.contractAddress).toBe(
		'0x5fbdb2315678afecb367f032d93f642f64180aa3',
	);
	expect(c.receipts.selfdestruct.contractAddress).toBe(
		'0xdc64a140aa3e981100a9beca4e685f962f0cf6c9',
	);

	// 4) `dumpState` MATCHES STRUCTURALLY: same accounts, same code, same slots,
	// same values.
	expect(c.dumpStructurallyEqual).toBe(true);
	// ...and it is compared structurally BECAUSE key order is insertion order,
	// which is each engine's write order: revm hands its account changes over
	// sorted by address, `@ethereumjs/vm` writes them in touch order. One
	// transaction in this battery creates TWO accounts, which is the precondition
	// that makes a byte comparison of two CORRECT dumps fail — asserted here so
	// the structural comparison is known to be load-bearing rather than lenient.
	// (`dumpJsonIdentical` is reported and NOT asserted: an engine that started
	// writing in touch order would make it true and would still be correct.)
	expect(c.nestedCreateAccountCount).toBe(2);
	expect(c.dumpAccountOrder.reference.slice().sort()).toEqual(
		c.dumpAccountOrder.underTest.slice().sort(),
	);

	// 5) THE ZERO-TIP COINBASE VANISHES, ON BOTH ENGINES, AND THAT IS CORRECT.
	// Every transaction in the battery pays NO priority fee, so the block's
	// beneficiary is credited nothing, stays touched-and-empty and is DELETED under
	// EIP-161 — `@ethereumjs/vm` does exactly the same. It is the case in a state
	// diff most likely to be filed as a bug, so it is asserted here, on both
	// engines, rather than avoided by paying a tip. Do not "fix" it.
	expect(c.coinbaseInDump).toEqual({reference: false, underTest: false});
	expect(BigInt(c.readings.coinbase.balance)).toBe(0n);

	await h.dispose();
});
