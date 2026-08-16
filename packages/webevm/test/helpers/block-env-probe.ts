// AUTO-GENERATED from contracts/BlockEnvProbe.sol via
// `solc 0.8.33 --optimize --evm-version cancun`. Do not edit by hand.
export const blockEnvProbeAbi = [
	{
		inputs: [],
		name: 'env',
		outputs: [
			{
				internalType: 'uint256',
				name: 'basefee',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'prevrandao',
				type: 'uint256',
			},
			{
				internalType: 'address',
				name: 'coinbase',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'number',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'timestamp',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'gaslimit',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
] as const;

/** Creation (init) code — what a deployment transaction carries. */
export const blockEnvProbeBytecode =
	'0x6080604052348015600e575f5ffd5b50609080601a5f395ff3fe6080604052348015600e575f5ffd5b50600436106026575f3560e01c80639dca003214602a575b5f5ffd5b6040805148815244602082015241818301524360608201524260808201524560a082015290519081900360c00190f3fea26469706673582212202a37b7f72dd5f4a717b6ca551b03bbedabd2e8a5d43b33cae78f0c627bb4519864736f6c63430008210033' as const;

/**
 * Runtime code — what lives AT the address, for the `evm_setCode` cheat. Placing
 * it directly (rather than deploying) is what lets a test use the probe's own
 * address as an `eth_call` sender that HOLDS CODE, which is the EIP-3607 case.
 */
export const blockEnvProbeRuntimeBytecode =
	'0x6080604052348015600e575f5ffd5b50600436106026575f3560e01c80639dca003214602a575b5f5ffd5b6040805148815244602082015241818301524360608201524260808201524560a082015290519081900360c00190f3fea26469706673582212202a37b7f72dd5f4a717b6ca551b03bbedabd2e8a5d43b33cae78f0c627bb4519864736f6c63430008210033' as const;
