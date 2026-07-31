/**
 * trusted-sender.spec.ts — the gate for `senderMode:'trusted'`.
 *
 * `'trusted'` skips ecrecover (a FIXED ~2ms/tx, ~80% of a small tx) by pinning the
 * sender to a caller-supplied address. It is only worth having if it changes
 * NOTHING else, so this asserts equivalence rather than speed:
 *   - the same signed raw txs produce receipts equal FIELD BY FIELD (gas, status,
 *     logs, effectiveGasPrice) and identical post-state, across both modes;
 *   - the cheat methods do NOT exist in the default 'recover' mode (-32601);
 *   - trusted mode really does impersonate (the documented footgun, pinned).
 *
 * Gas equality is the load-bearing assertion: two paths disagreeing on gas means
 * an op near the limit OOGs on one and not the other, i.e. a state fork.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

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

	// 1) DIFFERENTIAL: zero mismatches across the whole battery (deploy, 1559 call,
	// value transfer, legacy call, multi-log, revert) plus post-state.
	expect(c.mismatches).toEqual([]);
	expect(c.totalMismatches).toBe(0);

	// 2) SAFETY: the cheat must be absent in the DEFAULT mode, and fail loudly.
	expect(c.gap_evm_sendRawTransactionAs).toBe('threw:-32601');
	expect(c.gap_evm_sendRawTransactionSyncAs).toBe('threw:-32601');

	// 3) HONESTY: trusted mode charges the CLAIMED sender, not the real signer.
	// This is the footgun, asserted so it can never become a surprise.
	expect(c.impersonation.chargedTheClaimedSender).toBe(true);
	expect(c.impersonation.receiptFrom).not.toBe(c.impersonation.actualSigner);

	// the async (non-sync) variant still returns a real hash and mines
	expect(c.asyncVariant.hashIsReal).toBe(true);
	expect(c.asyncVariant.receiptFound).toBe(true);
	expect(c.asyncVariant.status).toBe('0x1');

	await h.dispose();
});
