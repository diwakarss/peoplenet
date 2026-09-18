// Wren's vote on a governance proposal (spec 24 WP17d, and 27.4a).
//
// Only the architect session runs this. The governance page never casts Wren's
// vote: Wren states the reason in the chat first, then this puts the vote on
// chain from Hardhat account 1 and appends the reason to
// governance/wren-votes.jsonl so the record and the tally stay together.
//
//   node scripts/wren-vote.js 3 for "The cache key is the real fix." --send
//   node scripts/wren-vote.js 34 for "Tied 1-1; this side is safer." --aao 1 --send
//   node scripts/wren-vote.js 3 for "..." --ref "commit 1f8076d" --send
//
// Rehearsing is the default; nothing reaches the chain without --send.
//
// Wren does not have the same standing on every organisation. On AAO 0, the
// trilogy widget, she is an ordinary voter alongside the Director. On AAO 1, the
// widget-builder, the standing rule is that the builder and the widget vote and
// Wren is the casting vote -- so this refuses there unless the tally is level
// with both of their votes in (27.4a). AAO 1 also has an interim rule, in force
// until account 4 has cast its first vote there, under which Wren is the second
// ordinary voter; which one applies is read off the chain and printed before
// anything is checked against it.
//
// Everything this does lives in governance/vote.js, shared with builder-vote.js
// and widget-vote.js (proposal 30). The rules live in governance/read.js, which
// the page reads too. This file is only who Wren is.
require("../governance/vote.js").run({
  command: "wren-vote.js",
  account: 1,
  address: require("../governance/read.js").WREN,
  label: "Wren",
  logFile: "wren-votes.jsonl",
  defaultAaoId: 0,
  standingNotes: [
    "--aao 0   the trilogy widget: Wren has an ordinary vote (the default)",
    "--aao 1   widget-builder: under the standing rule Wren votes only to break a",
    "          level tally, after the builder and the widget have voted. Until the",
    "          widget casts its first vote there the interim rule applies and Wren",
    "          is the second ordinary voter; the rule in force is printed first."
  ]
});
