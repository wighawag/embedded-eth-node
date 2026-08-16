/**
 * trusted-sender.spec.ts — the gate for `senderMode:'trusted'`.
 *
 * `'trusted'` skips ecrecover (a FIXED ~1.6ms/tx on the default engine, ~1.4ms of
 * a small tx's 2.1ms — and ~0.4ms when the installed engine brings its own
 * secp256k1) by pinning the sender to a caller-supplied address. It is only worth having if it changes
 * NOTHING else, so this asserts equivalence rather than speed:
 *   - the same signed raw txs produce receipts equal FIELD BY FIELD (gas, status,
 *     logs, effectiveGasPrice) and identical post-state, across both modes;
 *   - the cheat methods do NOT exist in the default 'recover' mode (-32601);
 *   - a tx signed by one account and submitted claiming ANOTHER executes as the
 *     CLAIMED one, to the wei (the documented footgun, pinned — and the only
 *     assertion that can catch an engine recovering a sender of its own).
 *
 * Gas equality is the load-bearing assertion: two paths disagreeing on gas means
 * an op near the limit OOGs on one and not the other, i.e. a state fork.
 *
 * THE SUITE IS ENGINE-PARAMETERISED, and this file runs it on the DEFAULT
 * `@ethereumjs/evm` engine. `revm-trusted-sender.spec.ts` runs the same suite
 * (helpers/trusted-sender.ts, unchanged) with `webevm/revm` installed and
 * asserts the SAME post-state literals as the block at the end of this file — which
 * is how "both engines agree on who sent the transaction" is stated.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {TRUSTED_SENDER_POST_STATE} from './trusted-sender-post-state.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test("senderMode:'trusted' is equivalent to 'recover', gated, and honest", async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'trusted-sender'}});

	console.log('\n[trusted-sender] errors:', r.errors);
	const c = r.results.trustedSender as Record<string, any>;
	console.log('[trusted-sender]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);
	expect(c.recoverNodeSenderMode).toBe('recover');
	expect(c.trustedNodeSenderMode).toBe('trusted');
	// ...on the DEFAULT engine, which is what makes this file the other half of
	// `revm-trusted-sender.spec.ts` rather than a duplicate of it.
	expect(c.recoverNodeEngineId).toBe('@ethereumjs/evm');
	expect(c.trustedNodeEngineId).toBe('@ethereumjs/evm');

	// 1) DIFFERENTIAL: zero mismatches across the whole battery (deploy, 1559 call,
	// value transfer, legacy call, multi-log, revert) plus post-state.
	expect(c.mismatches).toEqual([]);
	expect(c.totalMismatches).toBe(0);

	// 2) SAFETY: the cheat must be absent in the DEFAULT mode, and fail loudly.
	expect(c.gap_evm_sendRawTransactionAs).toBe('threw:-32601');
	expect(c.gap_evm_sendRawTransactionSyncAs).toBe('threw:-32601');

	// 3) THE CLAIMED SENDER IS THE SENDER, against a signature that says otherwise.
	// The footgun, asserted so it can never become a surprise — and the one case that
	// catches an engine which recovers its own sender instead of executing on behalf
	// of `TransactionRequest.sender`: such an engine charges the SIGNER, advances the
	// SIGNER's nonce and still returns a plausible receipt. Every detail (the wei
	// charged, both nonces, the storage change) is in `c.mismatches` above.
	expect(c.impersonation.mismatches).toEqual([]);
	expect(c.impersonation.chargedTheClaimedSender).toBe(true);
	expect(c.impersonation.receiptFrom).not.toBe(c.impersonation.actualSigner);
	expect(c.impersonation.signerBalanceDelta).toBe('0');
	expect(c.impersonation.signerNonceAfter).toBe(
		c.impersonation.signerNonceBefore,
	);

	// 4) THE CROSS-ENGINE POST-STATE, absolutely (./trusted-sender-post-state.ts).
	// `revm-trusted-sender.spec.ts` asserts the SAME literals after running the SAME
	// suite on revm, so a chain built by either engine through the trusted-sender path
	// is the same chain: balances (hence the gas charged and to whom), nonces (hence
	// who sent what) and the contract's storage. Do not relax one side without the
	// other — two matching halves is the whole property.
	expect(c.postState).toEqual(TRUSTED_SENDER_POST_STATE);

	// the async (non-sync) variant still returns a real hash and mines
	expect(c.asyncVariant.hashIsReal).toBe(true);
	expect(c.asyncVariant.receiptFound).toBe(true);
	expect(c.asyncVariant.status).toBe('0x1');

	await h.dispose();
});
