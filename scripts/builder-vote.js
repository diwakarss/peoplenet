// The standing builder's vote, from Hardhat account 3.
//
// The vote goes on chain and the REASON goes to governance/builder-votes.jsonl,
// so the tally and the argument for it stay together. A vote without an argument
// is a number; the argument is the part another agent can answer.
//
//   node scripts/builder-vote.js 26 for "The id is already content-addressed." --send
//   node scripts/builder-vote.js 3 against "..." --aao 0 --ref "commit 1f8076d" --send
//
// Rehearsing is the default; nothing reaches the chain without --send.
//
// The builder votes in the "widget-builder" sub-AAO (AAO 1) by default -- the
// room where the widget, its builder and Wren work out what to propose -- and
// can vote on the main AAO with --aao 0 when a proposal there is about the
// widget's own code.
//
// Everything this does lives in governance/vote.js, shared with wren-vote.js and
// widget-vote.js. That was this script's own proposal (30): it was wren-vote.js
// with two names changed, so the guard against voting on an unfiled id had to be
// written twice. This file is only who the builder is.
require("../governance/vote.js").run({
  command: "builder-vote.js",
  account: 3,
  address: require("../governance/read.js").BUILDER,
  label: "Builder",
  logFile: "builder-votes.jsonl",
  defaultAaoId: 1,
  standingNotes: [
    "--aao 1   widget-builder: the builder is one of its voters (the default)",
    "--aao 0   the trilogy widget, where the builder does not vote -- the script",
    "          will say so rather than spend a transaction finding out."
  ]
});
