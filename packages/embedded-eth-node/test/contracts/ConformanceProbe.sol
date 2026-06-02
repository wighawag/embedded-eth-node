// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// Small contract used by the differential conformance suite to exercise the
/// receipt/log/return-data surface the slim node owns:
/// - `emitTwo(a,b)` emits TWO events in one tx (assert logIndex ordering),
/// - `boom()` reverts with a reason (assert status 0, gas still charged),
/// - `store(slot,val)` writes storage (assert post-state getStorageAt),
/// - `echo(x)` is a view call returning its argument (assert eth_call data).
contract ConformanceProbe {
    event A(uint256 indexed key, uint256 value);
    event B(address indexed who, bytes data);

    uint256 public last;

    function emitTwo(uint256 a, uint256 b) public {
        last = a + b;
        emit A(a, b);
        emit B(msg.sender, abi.encodePacked(a, b));
    }

    function boom() public pure {
        revert("boom");
    }

    function store(uint256 slot, uint256 val) public {
        assembly {
            sstore(slot, val)
        }
    }

    function echo(uint256 x) public pure returns (uint256) {
        return x;
    }
}
