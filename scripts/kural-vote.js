// Kural's vote on a governance proposal. Only the Kural architect session runs this.
//
//   node scripts/kural-vote.js 42 for "The reason." --aao 2 --ref "proposal 40" --send
//
// Rehearsing is the default; nothing reaches the chain without --send.
// Kural sits on JD (AAO 2) as an ordinary voter, from Hardhat account 5.
// Everything this does lives in governance/vote.js; this file is only who Kural is.
require("../governance/vote.js").run({
  command: "kural-vote.js",
  account: 5,
  address: require("../governance/read.js").KURAL,
  label: "Kural",
  logFile: "kural-votes.jsonl",
  defaultAaoId: 2,
  standingNotes: [
    "--aao 2   JD: Kural has an ordinary vote (the default)"
  ]
});
