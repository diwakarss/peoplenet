// The widget's own vote, from Hardhat account 4.
//
// 27.4 gives the widget a vote on the widget-builder, on proposals that touch
// its own behaviour. Until now it had no way to cast one: there was no script,
// and writing a third copy of wren-vote.js was the cost nobody wanted to pay.
// That is what proposal 30 was about, and with governance/vote.js shared this
// file is the five lines that say who the widget is.
//
//   node scripts/widget-vote.js 34 for "This is the cache key I actually use." --send
//   node scripts/widget-vote.js 34 against "..." --ref "incident-2026-09-17-03" --send
//
// Rehearsing is the default; nothing reaches the chain without --send.
//
// This vote matters beyond its own tally. AAO 1 runs an interim rule -- Wren as
// the second ordinary voter -- precisely because account 4 has never cast
// anything there, and the chain is what says when that rule ends. The widget's
// first vote through this script ends it: the builder and the widget become the
// two voters, Wren goes back to breaking ties, and the window goes from one hour
// to twenty-four. Nothing is unset anywhere and nobody has to remember.
require("../governance/vote.js").run({
  command: "widget-vote.js",
  account: 4,
  address: require("../governance/read.js").WIDGET,
  label: "Widget",
  logFile: "widget-votes.jsonl",
  defaultAaoId: 1,
  standingNotes: [
    "--aao 1   widget-builder: the widget is one of its voters (the default)",
    "--aao 0   the trilogy widget, where the widget does not vote -- the script",
    "          will say so rather than spend a transaction finding out.",
    "",
    "The widget's FIRST vote on AAO 1 ends the interim rule there. Until it lands,",
    "Wren votes in the widget's place and a lone vote carries after one hour;",
    "afterwards the builder and the widget vote, Wren only breaks ties, and the",
    "window is twenty-four hours."
  ]
});
