// Kalam's vote on a governance proposal. Only the Kalam builder session runs this.
//
//   node scripts/kalam-vote.js 66 for "The reason." --ref "proposal 64" --send
//
// Rehearsing is the default; nothing reaches the chain without --send.
// Kalam votes on JD-build (AAO 3) and nowhere else, from Hardhat account 6:
// builders never join JD, and the Director watches JD-build without voting.
// Everything this does lives in governance/vote.js; this file is only who Kalam is.
require("../governance/vote.js").run({
  command: "kalam-vote.js",
  account: 6,
  address: require("../governance/read.js").KALAM,
  label: "Kalam",
  logFile: "kalam-votes.jsonl",
  defaultAaoId: 3,
  standingNotes: [
    "--aao 3   JD-build: Kalam is the voter here (the default), and votes nowhere else"
  ]
});
