// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// The fixture for THE LOG THAT MUST NOT APPEAR: an event emitted inside a frame
/// that then REVERTS is discarded with the frame, and must be absent from the
/// receipt's logs, from its bloom, and from `eth_getLogs`.
///
/// WHY IT IS ITS OWN CONTRACT rather than two more functions on
/// `ConformanceProbe`. That probe's CREATION BYTECODE is a shared fixture: the
/// trusted-sender suite deploys it too, and pins the resulting sender balance as
/// an absolute literal (`test/trusted-sender-post-state.ts`). Growing it moves a
/// deploy's gas and therefore that pinned number, which would mean editing
/// another suite's oracle to match an observation — the one edit that makes an
/// absolute pin worthless. A separate contract costs one deploy and leaves every
/// existing fixture byte-identical.
///
/// `emitTwo` and `emitTwoAroundRevertingSubCall` are a MATCHED PAIR, and that is
/// the point of the contract: they emit the same two events, from the same
/// address, with the same indexed arguments, and differ only by the sub-call that
/// emits `Discarded` and reverts in between. A bloom is over log addresses and
/// topics only, so their receipts' blooms must be BYTE-IDENTICAL — which is how
/// the discarded log's absence from the bloom is asserted without computing a
/// bloom anywhere on the test side.
contract DiscardedLogProbe {
    /// The two events that SURVIVE, named for where they sit around the dead
    /// frame in `emitTwoAroundRevertingSubCall`. Two different events (rather
    /// than one emitted twice) so emission ORDER is readable off the topics.
    event Before(uint256 indexed key, uint256 value);
    event After(address indexed who, bytes data);
    /// The event emitted by a frame that then REVERTS, so it is the one event
    /// that must appear NOWHERE. Its own event, so a leak is identifiable BY
    /// TOPIC and not only by a log count.
    event Discarded(uint256 indexed marker);

    uint256 public last;

    /// The BASELINE: the two survivors, back to back, no dead frame.
    function emitTwo(uint256 a, uint256 b) public {
        last = a + b;
        emit Before(a, b);
        emit After(msg.sender, abi.encodePacked(a, b));
    }

    /// The SAME two events, with a sub-call that emits `Discarded` and reverts
    /// between them. The survivors bracket the dead frame, so a receipt that
    /// kept the discarded log would show it in the MIDDLE of them.
    function emitTwoAroundRevertingSubCall(uint256 a, uint256 b) public {
        last = a + b;
        emit Before(a, b);
        (bool ok, ) = address(this).call(
            abi.encodeWithSelector(this.emitThenRevert.selector, a)
        );
        require(!ok, "sub-call did not revert");
        emit After(msg.sender, abi.encodePacked(a, b));
    }

    /// Emits `Discarded` and then REVERTS, so the log dies with the frame.
    /// Reached BOTH ways on purpose: as the sub-call above, and as a whole
    /// transaction of its own. They are the same bug in two shapes — a
    /// SUCCESSFUL receipt that must not carry the log, and a FAILED receipt that
    /// must carry nothing at all (including an all-zero bloom).
    function emitThenRevert(uint256 marker) public {
        emit Discarded(marker);
        revert("discarded");
    }

    /// Writes storage and emits NOTHING: the zero-log transaction sitting between
    /// two log-emitting ones, which is what proves a block's running `logIndex`
    /// counts logs rather than transactions.
    function store(uint256 slot, uint256 val) public {
        assembly {
            sstore(slot, val)
        }
    }
}
