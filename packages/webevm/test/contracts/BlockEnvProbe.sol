// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// Reads the BLOCK ENVIRONMENT through a real contract, which is the only way a
/// divergence in it can be observed at all.
///
/// `BASEFEE`, `PREVRANDAO`, `COINBASE`, `NUMBER`, `TIMESTAMP` and `GASLIMIT` are
/// all fee- and gas-INDEPENDENT: two engines can hand a contract completely
/// different values while charging byte-identical gas, so the cross-backend gas
/// gate cannot see this class of bug and neither can a receipt diff. The engine
/// has to be asked, through EVM opcodes, what block it thinks it is running in.
///
/// One function returning all six in one `eth_call`, so a diff is a single
/// comparison of one return value rather than six calls that could each drift.
contract BlockEnvProbe {
    function env()
        external
        view
        returns (
            uint256 basefee,
            uint256 prevrandao,
            address coinbase,
            uint256 number,
            uint256 timestamp,
            uint256 gaslimit
        )
    {
        return (
            block.basefee,
            block.prevrandao,
            block.coinbase,
            block.number,
            block.timestamp,
            block.gaslimit
        );
    }
}
