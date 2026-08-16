/**
 * revm-sender-recovery.spec.ts — `senderMode:'recover'` recovers the sender with
 * the engine's `ecrecover` when one is installed, and authenticates IDENTICALLY
 * to the implementation it replaces.
 *
 * The suite is helpers/sender-recovery.ts; this file asserts its report. What it
 * is really guarding is the worst outcome available on this path: a recovery that
 * returns a PLAUSIBLE WRONG ADDRESS throws nothing, produces a receipt that looks
 * right, and authenticates the transaction as somebody else. So the assertions
 * below weigh the REFUSALS as heavily as the successes — a malformed signature, a
 * high-`s` one (EIP-2) and a wrong recovery id must be refused by BOTH
 * implementations, with nothing mined and no balance moved.
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

test("senderMode:'recover' on the revm engine: the engine's ecrecover authenticates identically", async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape, as in `revm-conformance.spec.ts`.
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'sender-recovery'}});

	console.log('\n[revm-sender-recovery] errors:', r.errors);
	const c = r.results.revmSenderRecovery as Record<string, any>;
	console.log('[revm-sender-recovery]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// The seam really carries an ecrecover, and the two nodes really are the two
	// implementations — not the same one twice.
	expect(c.engineExposesEcrecover).toBe(true);
	expect(c.engineNodeEngineId).toBe('revm-wasm');
	expect(c.fallbackEngineId).toBe('@ethereumjs/evm');

	// EVERYTHING the suite checks, in one list.
	expect(c.mismatches).toEqual([]);
	expect(c.totalMismatches).toBe(0);

	// 1) THE PRIMITIVE. Every row agrees, and two of them are named here because
	// they are the ones a reader should not have to take on trust: a high-`s`
	// signature is ACCEPTED by both curve implementations (EIP-2 is a rule about
	// transactions, not about the `0x01` precompile), and a wrong recovery id is
	// REFUSED by both.
	const row = (label: string) =>
		(c.primitiveTable as {label: string; js: string; engine: string}[]).find(
			(x) => x.label === label,
		)!;
	expect(row('valid').engine).toBe(row('valid').js);
	expect(row('real-tx-signature').engine).toBe(row('real-tx-signature').js);
	expect(row('high-s/malleable-twin').js).not.toBe('REFUSED');
	expect(row('high-s/malleable-twin').engine).toBe(
		row('high-s/malleable-twin').js,
	);
	for (const label of ['r=0', 's=0', 'r=n', 's=n', 'recovery-id=2']) {
		expect(row(label).js).toBe('REFUSED');
		expect(row(label).engine).toBe('REFUSED');
	}

	// 2a) A RECOVERED SENDER IS THE KNOWN SIGNER, on both implementations, for
	// legacy, EIP-2930 and EIP-1559 transactions.
	for (const label of ['legacy', 'eip2930', 'eip1559']) {
		const s = (
			c.senders as {label: string; fallback: string; engine: string}[]
		).find((x) => x.label === label)!;
		expect(s.engine).toBe(c.expectedSigner);
		expect(s.fallback).toBe(c.expectedSigner);
	}

	// 2b) THE REFUSALS, which are the bar. Both implementations refuse all three,
	// and a refused transaction is REFUSED rather than attributed: no block, no
	// moved balance, no advanced nonce.
	for (const label of [
		'legacy-malformed-r0',
		'legacy-unrecoverable-r',
		'legacy-high-s',
		'legacy-bad-v',
	]) {
		const f = (c.refusals as Record<string, any>[]).find(
			(x) => x.label === label,
		)!;
		expect(f.fallbackThrew).toBe(true);
		expect(f.engineThrew).toBe(true);
		expect(f.fallbackMined).toBe(false);
		expect(f.engineMined).toBe(false);
		expect(f.fallbackStateMoved).toBe(false);
		expect(f.engineStateMoved).toBe(false);
	}

	// 3) THE WIRING. The engine really recovered those senders (a node that had
	// quietly kept recovering in JS satisfies every assertion above), and
	// `senderMode:'trusted'` still skips recovery ENTIRELY — measured, not argued.
	expect(c.ecrecoverCalls.recover).toBeGreaterThanOrEqual(3);
	expect(c.trustedEcrecoverCalls).toBe(0);
	expect(c.trustedReceiptFrom).toBe(
		'0x00000000000000000000000000000000000000cc',
	);
	expect(c.cheatInRecoverMode).toBe('threw:-32601');

	// 4) The seam carries a 0/1 recovery id, never the wire's `v`.
	expect(c.recoveryIdsHandedToTheEngine.allZeroOrOne).toBe(true);
	expect(c.recoveryIdsHandedToTheEngine.seen.length).toBe(2);

	await h.dispose();
});
