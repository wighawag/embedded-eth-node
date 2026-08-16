// AUTO-GENERATED from contracts/ConformanceProbe.sol via solc 0.8.33 --optimize. Do not edit by hand.
export const probeAbi = [
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
		name: 'A',
		type: 'event',
	},
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
		name: 'B',
		type: 'event',
	},
	{
		inputs: [],
		name: 'boom',
		outputs: [],
		stateMutability: 'pure',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'x',
				type: 'uint256',
			},
		],
		name: 'echo',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'pure',
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

export const probeBytecode =
	'0x6080604052348015600e575f5ffd5b506102538061001c5f395ff3fe608060405234801561000f575f5ffd5b5060043610610055575f3560e01c806347799da8146100595780636279e43c146100735780636ed28ed014610084578063a169ce0914610098578063b534dde0146100a0575b5f5ffd5b6100615f5481565b60405190815260200160405180910390f35b61006161008136600461018c565b90565b6100966100923660046101a3565b9055565b005b6100966100b3565b6100966100ae3660046101a3565b6100ed565b60405162461bcd60e51b81526004016100e490602080825260049082015263626f6f6d60e01b604082015260600190565b60405180910390fd5b6100f781836101c3565b5f5560405181815282907f83f86eb20c894914ecf65cefc94682009cdb5066a609e8428699fa87b19b5c579060200160405180910390a2604080516020810184905290810182905233907f840c9a467ef6ef6b6b42e530f663febb09e330b21d727d520f2ce6f34c36fbbc9060600160408051601f1981840301815290829052610180916101e8565b60405180910390a25050565b5f6020828403121561019c575f5ffd5b5035919050565b5f5f604083850312156101b4575f5ffd5b50508035926020909101359150565b808201808211156101e257634e487b7160e01b5f52601160045260245ffd5b92915050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f8301168401019150509291505056fea264697066735822122016475e34b011d745d6c6be1cb0beea5f895c8d9f4004769ae5d6b1169236f14864736f6c63430008210033' as const;
