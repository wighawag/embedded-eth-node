// AUTO-GENERATED from contracts/DiscardedLogProbe.sol via solc 0.8.33 --optimize. Do not edit by hand.
export const discardedLogProbeAbi = [
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'who',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'bytes',
				name: 'data',
				type: 'bytes',
			},
		],
		name: 'After',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'uint256',
				name: 'key',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'value',
				type: 'uint256',
			},
		],
		name: 'Before',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'uint256',
				name: 'marker',
				type: 'uint256',
			},
		],
		name: 'Discarded',
		type: 'event',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'marker',
				type: 'uint256',
			},
		],
		name: 'emitThenRevert',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'a',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'b',
				type: 'uint256',
			},
		],
		name: 'emitTwo',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'a',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'b',
				type: 'uint256',
			},
		],
		name: 'emitTwoAroundRevertingSubCall',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'last',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'slot',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'val',
				type: 'uint256',
			},
		],
		name: 'store',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
] as const;

export const discardedLogProbeBytecode =
	'0x6080604052348015600e575f5ffd5b506104168061001c5f395ff3fe608060405234801561000f575f5ffd5b5060043610610055575f3560e01c8063311be98b1461005957806347799da81461006e5780636ed28ed014610088578063b534dde01461009a578063bb4c72e3146100ad575b5f5ffd5b61006c610067366004610339565b6100c0565b005b6100765f5481565b60405190815260200160405180910390f35b61006c610096366004610350565b9055565b61006c6100a8366004610350565b610123565b61006c6100bb366004610350565b6101c2565b60405181907f67ef19b7351fc4250417ca1463896199691867cb1765e6e0b8e24305768e4616905f90a260405162461bcd60e51b8152602060048201526009602482015268191a5cd8d85c99195960ba1b60448201526064015b60405180910390fd5b61012d8183610370565b5f5560405181815282907f8109768a56e88c60d18736270f3a79295428aaf1af5449b9fdf73c2a384de1df9060200160405180910390a2604080516020810184905290810182905233907f1a76b145018cf9bd628c786f931994af8b8d0cd28b4fee27bc02372ca0c1c6979060600160408051601f19818403018152908290526101b691610395565b60405180910390a25050565b6101cc8183610370565b5f5560405181815282907f8109768a56e88c60d18736270f3a79295428aaf1af5449b9fdf73c2a384de1df9060200160405180910390a260408051602480820185905282518083039091018152604490910182526020810180516001600160e01b031663311be98b60e01b17905290515f91309161024a91906103ca565b5f604051808303815f865af19150503d805f8114610283576040519150601f19603f3d011682016040523d82523d5f602084013e610288565b606091505b5050905080156102da5760405162461bcd60e51b815260206004820152601760248201527f7375622d63616c6c20646964206e6f7420726576657274000000000000000000604482015260640161011a565b604080516020810185905290810183905233907f1a76b145018cf9bd628c786f931994af8b8d0cd28b4fee27bc02372ca0c1c6979060600160408051601f198184030181529082905261032c91610395565b60405180910390a2505050565b5f60208284031215610349575f5ffd5b5035919050565b5f5f60408385031215610361575f5ffd5b50508035926020909101359150565b8082018082111561038f57634e487b7160e01b5f52601160045260245ffd5b92915050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b5f82518060208501845e5f92019182525091905056fea2646970667358221220e2282810e0631220e16da4b568f8e891370a73fb277bd9c885fa692363f49ba264736f6c63430008210033' as const;
