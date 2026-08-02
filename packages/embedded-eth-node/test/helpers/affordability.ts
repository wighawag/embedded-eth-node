/**
 * affordability.ts — how a VALUE-BEARING read's outcome is classified, shared by
 * the two bars that assert it: the conformance battery's `value-bearing read
 * affordability` step (./conformance.ts) and the engine-against-engine checks
 * (./revm-engine.ts).
 *
 * WHY THIS IS NOT A BARE `catch`. Both bars exist to catch ONE bug: an engine
 * that fabricates the caller's balance to serve an `eth_call` answers a transfer
 * the chain could never make (`disableBalanceCheck` on revm, see
 * `docs/spikes/revm-wasm-upgrade-honest-block-environment/measurements.md`).
 * `catch {}` classifies EVERY throw as "the transfer was refused", so a
 * param-validation refusal, an engine that failed to construct, a typo'd
 * address or a changed RPC shape would all keep the negative cases GREEN while
 * the affordability rule they name had stopped being exercised at all. A bar
 * that cannot go red for the right reason is not a bar.
 *
 * TWO LAYERS OF EVIDENCE, because the node and the engine see different things:
 *
 *  1. **Through the node** ({@link classifyValueRead}) — the SHAPE. The node
 *     flattens every engine's execution failure into one JSON-RPC error
 *     (`execution reverted`, code 3, `data` = the return data), so above the
 *     seam there is no engine message to read. What is still checkable is that
 *     the failure came from the ENGINE (code 3) and produced no data a caller
 *     could mistake for the CALLEE's answer, and — the part that actually names
 *     affordability — that the rejection tracks the sender's balance TO THE WEI:
 *     `value == balance` succeeds and `value == balance + 1` fails. Nothing but
 *     a balance check draws that line, and an unrelated failure at the same call
 *     site fails BOTH sides of it (and does not carry code 3), so it turns the
 *     step red.
 *  2. **At the engine seam** ({@link namesLackOfFunds}) — the WORDS. A
 *     `ReadEngine.call` result still carries the engine's own error, and the two
 *     engines are meant to differ there: `@ethereumjs/evm` reports
 *     `insufficient balance` (`EVMError`, thrown by `_reduceSenderBalance`),
 *     revm reports `Transaction(LackOfFundForMaxFee { fee, balance })`. The
 *     predicate is a VOCABULARY both must use, never one engine's string
 *     asserted on the other.
 *
 * CAN IT GO RED? Checked by MUTATION on 2026-08-02, chromium, every mutation
 * reverted afterwards:
 *
 *   - `classifyValueRead` returning {@link REJECTED} for any throw (the bare
 *     `catch` this replaced) -> `value-bearing read affordability` RED on both
 *     engines and both state modes, on the two negative controls the step
 *     issues (a malformed sender, a callee reverting with a reason).
 *   - one negative case's sender replaced by `0xnotanaddress` (an unrelated
 *     error at the SAME call site) -> RED, reported as
 *     `NOT an engine rejection (code undefined): Invalid address input=...`.
 *   - either half of {@link namesLackOfFunds} forced true -> `revm-engine.spec`
 *     RED on the near-miss controls (`ERC20: transfer amount exceeds balance`,
 *     `ERC20: insufficient allowance`).
 */

/** A value-bearing read that SUCCEEDED. */
export const OK = 'ok';

/**
 * A value-bearing read the ENGINE refused, with no callee answer attached — the
 * only failure shape the negative cases accept. Anything else classifies as its
 * own sentence and therefore MISMATCHES, which is the whole point.
 */
export const REJECTED = 'rejected by the engine, no callee return data';

/**
 * Run one `eth_call` through the node and say what happened, in the vocabulary
 * the affordability bars compare against.
 *
 * Every classification other than {@link OK} / {@link REJECTED} is a sentence
 * describing what ACTUALLY failed, so a mismatch report names the unrelated
 * error rather than hiding it: that string can never equal an expected outcome.
 */
export async function classifyValueRead(
	call: () => Promise<unknown>,
): Promise<string> {
	try {
		await call();
		return OK;
	} catch (err) {
		return describeReadFailure(err);
	}
}

/**
 * Classify a THROW from `eth_call`.
 *
 * Code 3 is the node's execution-failure code (`node.ts` throws
 * `RpcError(3, 'execution reverted', returnData)` for every engine error).
 * Anything else — a `-32602` param refusal, a `-32601` method gap, a plain
 * `TypeError`, a construction error — is NOT a transfer being refused, and is
 * reported as itself.
 */
function describeReadFailure(err: unknown): string {
	const code = (err as {code?: unknown} | null)?.code;
	const data = (err as {data?: unknown} | null)?.data;
	const message = String((err as Error)?.message ?? err);
	if (code !== 3)
		return `NOT an engine rejection (code ${String(code)}): ${message}`;
	// A refused transfer never produces the CALLEE's answer; a contract that
	// reverted with a reason does. Keeping those apart is what stops "the callee
	// reverted" from passing as "the sender could not afford it".
	if (isCalleeAnswer(data))
		return `engine rejection carrying callee return data (${String(data)})`;
	return REJECTED;
}

/**
 * Is this return data the CALLEE's answer — bytes a caller would decode as a
 * contract result or a revert reason?
 *
 * Empty is not. Neither, and this is the one wrinkle, is revm's own error text:
 * `revm-wasm` puts the message of a VALIDATION error into `returnData`, so the
 * node's `eth_call` surfaces `Transaction(LackOfFundForMaxFee { fee, balance })`
 * as hex where `@ethereumjs/evm` surfaces `0x`. That divergence is real and is
 * NOT this bar's business to fix (see
 * `work/notes/observations/revm-validation-errors-surface-their-message-as-eth-call-return-data.md`);
 * what matters here is that the bytes are the ENGINE explaining the shortfall
 * and not something the callee produced, which is exactly what
 * {@link namesLackOfFunds} decides — the same predicate, applied to both
 * engines, rather than either engine's string asserted on the other.
 */
export function isCalleeAnswer(data: unknown): boolean {
	const text = asText(data);
	if (text === '') return false;
	return !namesLackOfFunds(text);
}

/**
 * Does an ENGINE's own error name a shortfall of FUNDS?
 *
 * Deliberately a vocabulary rather than either engine's exact string, because
 * the two engines fail this differently BY DESIGN and both must be held to the
 * same predicate:
 *
 *   `@ethereumjs/evm` : `insufficient balance`
 *   revm             : `Transaction(LackOfFundForMaxFee { fee: 1, balance: 0 })`
 *
 * Both name a LACK (`insufficient` / `lack of`) and the thing lacked (`fund` /
 * `balance`). No other failure either engine produces on the read path does:
 * `execution reverted`, `out of gas`, `Transaction(GasPriceLessThanBasefee)`,
 * `CallerGasLimitMoreThanBlock` and `Transaction(RejectCallerWithCode)` all
 * classify as false (asserted as a control in ./revm-engine.ts).
 */
export function namesLackOfFunds(error: unknown): boolean {
	const text = asText(error).toLowerCase();
	const lack = /insufficient|lack\s*of|lackof/.test(text);
	const funds = /fund|balance/.test(text);
	return lack && funds;
}

/**
 * Whatever an engine or the RPC layer handed us, as text: a `0x`-prefixed hex
 * string is decoded as UTF-8 bytes (that is how revm's message arrives through
 * `eth_call`'s `data`), anything else is stringified.
 */
function asText(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	const text = String(value);
	if (!/^0x([0-9a-fA-F]{2})*$/.test(text)) return text;
	const body = text.slice(2);
	const bytes = new Uint8Array(body.length / 2);
	for (let i = 0; i < bytes.length; i++)
		bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
	return new TextDecoder().decode(bytes);
}
