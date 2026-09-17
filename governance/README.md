# The governance page

A one-page view of AAO 0, the "trilogy widget" AAO, on the local chain: every
proposal, who voted, and the three buttons that move one along. Static HTML,
ethers v6 from a CDN, no framework, no build step.

Spec: `LEARNING-MODEL-ARCHITECTURE.md` section 24, WP17d-UI.

## Running it

You need two things up: the chain, and the page.

```bash
npm run node                    # terminal 1 -- Hardhat node on 127.0.0.1:8545 (chain id 31337)
npm run deploy:local            # once, if the diamond is not deployed yet
npm run governance:members      # once, puts the three roles on AAO 0
npm run governance              # terminal 2 -- http://127.0.0.1:8787
```

Then open <http://127.0.0.1:8787>. The page redraws on every new block, so a vote
cast from a script shows up without a reload.

Two more commands worth knowing:

```bash
npm run governance:check        # render the data layer in the terminal and assert it
npx hardhat test test/governance/tiebreak.test.js
```

### The keys

The page signs by asking the Hardhat node for a signer on one of the node's own
unlocked accounts. It holds no private key, asks for none, and shows none. The
keys involved are Hardhat's published defaults, worth nothing outside a local
chain, and the approach only works against a node that unlocks its accounts --
which is exactly why it cannot follow this page anywhere real. A banner at the
top of the page says so.

Reads are free and happen on their own. Every write is one deliberate click.

## The three roles

All three are Hardhat default accounts, all three are members of AAO 0, and the
contract gives each of them exactly one vote.

| Role | Account | Address | Votes how |
|---|---|---|---|
| **Director** | 0 | `0xf39Fd6e5…92266` | The operator, from the page. Also the deployer and the AAO's creator. |
| **Wren** | 1 | `0x70997970…c79C8` | The architect session, from `scripts/wren-vote.js` only. Never from the page. |
| **Casting vote** | 2 | `0x3C44CdDd…293BC` | The Director's tie-break. The page only offers it on a tie. |

Wren states the reason in the chat first, then casts:

```bash
node scripts/wren-vote.js 3 for "The cache key is the real fix; the rest is a workaround."
```

The vote goes on chain and the reason is appended to `governance/wren-votes.jsonl`
with the tally it produced, so the record and the number stay together.

## The tie rule

`AAOFacet` is one member, one vote, and `executeProposal` passes a proposal only
on `forVotes > againstVotes`. A 1&ndash;1 tie therefore **rejects**. There is no
tie-break in the contract, and WP17d deliberately did not add one.

So the tie-break lives in membership instead: a third member, account 2, that
exists for nothing else. The page enables its two buttons only when all of this
is true:

1. the proposal is still Active,
2. both ordinary members (Director and Wren) have voted,
3. their votes are level (`forVotes == againstVotes`),
4. the casting account has not already voted.

Nothing on chain enforces that. The chain just sees a third member with one vote,
like everyone else -- it cannot vote twice, and it cannot turn a 2&ndash;0 into a
2&ndash;2. The rule is the page's, it lives in one function,
`castingVoteState()` in `governance/read.js`, and `test/governance/tiebreak.test.js`
pins down both halves: what the chain does (the same 1&ndash;1 tie rejects on
execute, and passes once the casting vote is cast) and what the rule does (it
refuses to offer the casting vote when there is no tie).

`Execute` is a separate, later click. It calls `executeProposal` from the Director
and then shows the outcome the chain reported in its `ProposalExecuted` event --
not a prediction, the event. Once executed a proposal is closed for good.

## The files

| File | What it is |
|---|---|
| `read.js` | The data layer. `require()`-able from Node, `<script>`-able in the browser. Owns the ABI, the role labels, the reads, and `castingVoteState()`. |
| `app.js` | The page. Renders, wires the buttons, refreshes on every block. |
| `index.html`, `style.css` | One column, proposal cards, tally bars, status chips. |
| `server.js` | A loopback static server for this directory and nothing else. `npm run governance`. |
| `check.js` | Runs `read.js` against the live node, prints what the page would show, asserts the AAO, the three members, and the proposal floor. |
| `wren-votes.jsonl` | Wren's votes with their stated reasons, one JSON object per line. |

`read.js` is the join: the page, `check.js`, and the Hardhat test all read through
the same functions, so a change that would break the page breaks a test first.

## Notes

- `check.js` asserts **at least** seven proposals, the seven WP17d builder
  suggestions AAO 0 was seeded with. Proposals only ever get added, and other
  sessions file more as the work goes on, so a floor is the honest assertion.
  Set `GOVERNANCE_EXPECTED_PROPOSALS=12` to demand an exact count instead.
- `AAOFacet.joinAAO` is open: the creator approves nobody, each account joins for
  itself. `scripts/setup-governance-members.js` is idempotent for that reason.
- The AAO struct has no `createdAt`, so the page takes it from the block that
  carried the `AAOCreated` event.
- The facet has no `proposalCount` getter, so the proposal list comes from
  `ProposalSubmitted` events and the tallies come from `getProposal` -- the page
  always shows the chain, not the event history.
- `GOVERNANCE_PORT` and `GOVERNANCE_HOST` override the server's defaults.
