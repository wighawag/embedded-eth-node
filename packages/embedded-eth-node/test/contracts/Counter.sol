// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// Minimal contract used by the in-browser-EVM benchmark.
/// - `increment()` and `add(n)` exercise SSTORE/SLOAD state transitions.
/// - `number()` is a cheap view call (eth_call path).
/// - `sumTo(n)` is a compute-heavy loop to surface interpreter throughput.
contract Counter {
    uint256 public number;

    event Incremented(uint256 newValue);

    function increment() public {
        number += 1;
        emit Incremented(number);
    }

    function add(uint256 n) public {
        number += n;
        emit Incremented(number);
    }

    /// Pure compute loop — no storage — to measure raw opcode throughput.
    function sumTo(uint256 n) public pure returns (uint256 acc) {
        for (uint256 i = 0; i < n; i++) {
            acc += i;
        }
    }

    /// KECCAK256-heavy pure loop. keccak is the #1 ethereumjs hotspot (#3227),
    /// so this stresses the real EVM hot path far better than an ADD loop and
    /// gives an honest cross-backend "compute" comparison. Chains each hash into
    /// the next so the optimizer can't elide it.
    function keccakLoop(uint256 n) public pure returns (bytes32 h) {
        for (uint256 i = 0; i < n; i++) {
            h = keccak256(abi.encodePacked(h, i));
        }
    }
}
