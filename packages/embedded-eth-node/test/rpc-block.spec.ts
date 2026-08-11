/**
 * rpc-block.spec.ts — the RPC block and the EVM describe the same block, and go
 * on describing it the same way after a `dumpState` / `loadState` round trip.
 *
 * The suite is helpers/rpc-block.ts. What it catches is a header field that
 * reports a value the block does not have: a constant-zero `miner`, an absent
 * `mixHash`, and a hard-coded zero `logsBloom` on a block whose receipts carry
 * real ones. All three are invisible to every other bar in this repo — receipts,
 * gas and post-state are all correct while the block header lies about them.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('the RPC block reports the block the EVM ran, before and after a reload', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'rpc-block'}});

	console.log('\n[rpc-block] errors:', r.errors);
	const c = r.results.rpcBlock as Record<string, any>;
	console.log('[rpc-block]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);
	expect(c.engineId).toBe('@ethereumjs/evm');

	// Everything the suite diffed agreed: the RPC block against the EVM, the
	// origin node against the reloaded one, and an old dump against zero.
	expect(c.mismatches).toEqual([]);

	// The absolute statements, so a suite that silently stopped comparing anything
	// cannot pass by having nothing to disagree about.
	expect(c.origin.mined.miner).toBe(c.configured.coinbase);
	expect(c.origin.mined.mixHash).toBe(c.configured.prevRandao);
	expect(c.reloaded.mined.miner).toBe(c.configured.coinbase);
	expect(c.reloaded.mined.mixHash).toBe(c.configured.prevRandao);
	expect(c.reloaded.evm.coinbase).toBe(c.configured.coinbase);
	expect(c.reloaded.evm.prevRandao).toBe(c.configured.prevRandao);
	// Genesis honours `blockEnv` too — it used to be the one block that did not.
	expect(c.origin.genesis.miner).toBe(c.configured.coinbase);
	expect(c.reloaded.genesis.miner).toBe(c.configured.coinbase);
	// The header bloom admits the block's own log, on both sides.
	expect(c.origin.mined.bloomAdmitsLogAddress).toBe(true);
	expect(c.origin.mined.bloomAdmitsLogTopic).toBe(true);
	expect(c.reloaded.mined.bloomAdmitsLogAddress).toBe(true);
	expect(c.reloaded.mined.bloomAdmitsLogTopic).toBe(true);

	// The reloaded chain continues from the head it reports: the block mined after
	// the reload names the reported hash of the block before it as its parent, and
	// that parent resolves. (The rebuilt `Block` object's own hash is what feeds
	// the next block's `parentHash`, so this is where a lossy reconstruction shows.)
	expect(c.chainContinuesAfterReload.newBlockParentHash).toBe(
		c.chainContinuesAfterReload.headHashBeforeMining,
	);
	expect(c.chainContinuesAfterReload.parentIsResolvable).toBe(true);

	// A state dumped by the PREVIOUS version still loads (the fields are optional
	// and the format is still `version: 1`), reads as ZERO rather than undefined,
	// and gets a bloom rebuilt from the receipts the dump does carry.
	expect(c.oldDump.loads).toBe(true);
	expect(c.oldDump.miner).toBe('0x0000000000000000000000000000000000000000');
	expect(c.oldDump.mixHash).toBe('0x' + '00'.repeat(32));
	expect(c.oldDump.bloomAdmitsLogTopic).toBe(true);
	expect(c.oldDump.counterNumber).toBe('1');

	await h.dispose();
});
