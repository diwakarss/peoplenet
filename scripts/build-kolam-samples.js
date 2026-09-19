// Writes the kolam samples the Director looks at (proposals 59 and 64).
//
// Kural's and Kalam's kolams are drawn from the REAL record: their tasks come
// from governance/messages.jsonl and the chain, through the same tasksFor() the
// dashboard uses. A sample drawn from invented data would be a picture of
// nothing, and the question the Director is answering is whether this reads.
//
// The fourth kolam is synthetic on purpose: it shows all four dot states beside
// each other, which the real record does not happen to do today.
//
// Usage:
//   npx hardhat run scripts/build-kolam-samples.js --network localhost

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const R = require("../governance/read.js");
const S = require("../governance/swarm.js");
const P = require("../governance/protocol.js");
const K = require("../governance/swarm/kolam.js");

const OUT = path.join(__dirname, "..", "governance", "swarm", "samples");
const KALAM = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

function escapeHtml(text) {
  return String(text).replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[ch]));
}

function tally(tasks) {
  const counts = { queued: 0, building: 0, built: 0, blocked: 0 };
  tasks.forEach((t) => { counts[t.state] = (counts[t.state] || 0) + 1; });
  return counts;
}

function inWords(label, tasks) {
  const c = tally(tasks);
  const parts = [];
  if (c.built) parts.push(c.built + " done");
  if (c.building) parts.push(c.building + " being built");
  if (c.blocked) parts.push(c.blocked + " blocked");
  if (c.queued) parts.push(c.queued + " queued");
  return `${label} holds ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
}

async function main() {
  const contract = await ethers.getContractAt("AAOFacet", R.DIAMOND);
  const aaos = await R.readAAOs(contract);
  const proposals = await R.readAllProposals(contract, aaos);
  const messages = P.parseJsonl(
    fs.readFileSync(path.join(__dirname, "..", "governance", "messages.jsonl"), "utf8")).records;
  const street = S.street(messages, Date.now(), proposals, aaos);
  const rowFor = (key) => street.filter((a) => a.key === key)[0];

  const real = ["kural", "kalam"].map((key) => {
    const row = rowFor(key);
    return {
      key,
      label: row.label,
      address: row.address,
      now: row.now,
      tasks: row.tasks,
      svg: K.toSVG(row.address, {
        tasks: row.tasks, agent: key, label: row.label, now: row.now, id: "kolam-" + key
      })
    };
  });

  // All four states side by side. Not from the record: today's record has no
  // agent holding one of each, and the Director is being asked to read the
  // states, not to read today.
  const hour = 3600 * 1000;
  const now = Date.now();
  const synthetic = [
    { proposalId: 101, aaoId: 2, title: "Done: the watcher executes on the Director's vote", state: "built", who: "", what: "", at: now - 30 * hour },
    { proposalId: 102, aaoId: 2, title: "Done: Execute is not offered with no votes", state: "built", who: "", what: "", at: now - 26 * hour },
    { proposalId: 103, aaoId: 2, title: "Being built: the swarm dashboard", state: "building", who: "", what: "", at: now - 5 * hour },
    { proposalId: 104, aaoId: 2, title: "Blocked: the Hetzner API token", state: "blocked", who: "the Director", what: "the Hetzner API token", at: now - 4 * hour },
    { proposalId: 105, aaoId: 2, title: "Queued: one secrets vault in the cloud", state: "queued", who: "", what: "", at: now - 2 * hour }
  ];
  const sampleSvg = K.toSVG("0x0000000000000000000000000000000000000004", {
    tasks: synthetic, agent: "sample", label: "The four states", now: "reading the states", id: "kolam-states"
  });

  // Standalone files, one per kolam, so each stands on its own.
  real.forEach((agent) => fs.writeFileSync(path.join(OUT, "kolam-" + agent.key + ".svg"), agent.svg, "utf8"));
  fs.writeFileSync(path.join(OUT, "kolam-states.svg"), sampleSvg, "utf8");
  fs.writeFileSync(path.join(OUT, "kolam-wren.svg"),
    K.toSVG(R.WREN, { tasks: rowFor("wren").tasks, agent: "wren", label: "Wren", id: "kolam-wren" }), "utf8");

  const legend = [
    ["is-queued", "Queued", "a ring: held, not moving"],
    ["is-building", "Being built", "pulsing: in hand now"],
    ["is-built", "Done", "filled: the line reaches it"],
    ["is-blocked", "Blocked", "amber: somebody else has to move"],
    ["is-open", "Open ground", "faint: no task on this dot"]
  ].map(([cls, name, what]) =>
    `      <li><svg width="16" height="16" viewBox="0 0 16 16" class="kolam" aria-hidden="true">` +
    `<style>.sw{stroke-width:1.4}.q{fill:none;stroke:#8b877f}.g{fill:#8b877f;stroke:#8b877f}` +
    `.d{fill:#1d1c1a}.b{fill:#a8322a}.o{fill:#d8d4cc}</style>` +
    `<circle cx="8" cy="8" r="4" class="sw ${{ "is-queued": "q", "is-building": "g", "is-built": "d", "is-blocked": "b", "is-open": "o" }[cls]}"/></svg>` +
    `<b>${name}</b> &mdash; ${what}</li>`).join("\n");

  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kolam samples: the dots are the tasks</title>
  <link rel="stylesheet" href="../kolam.css">
  <style>
    body { margin: 0; padding: 30px 22px 70px; background: #fbfaf7; color: #1d1c1a;
           font: 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
    .sheet { max-width: 1000px; margin: 0 auto; }
    h1, h2 { font-family: Georgia, "Times New Roman", serif; font-weight: 400; }
    h1 { font-size: 25px; margin: 0 0 6px; }
    h2 { font-size: 16px; margin: 36px 0 4px; padding-bottom: 6px; border-bottom: 1px solid #ddd9d1; }
    p { max-width: 66ch; color: #55524c; margin: 0 0 8px; }
    .row { display: flex; flex-wrap: wrap; gap: 38px; margin-top: 20px; align-items: flex-start; }
    figure { margin: 0; max-width: 210px; }
    figcaption { font-size: 12px; color: #55524c; margin-top: 8px; }
    figcaption b { display: block; font-family: Georgia, serif; font-size: 14.5px;
                   font-weight: 400; color: #1d1c1a; }
    .legend { list-style: none; padding: 0; margin: 16px 0 0; display: grid;
              grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 8px 22px; }
    .legend li { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: #55524c; }
    .legend b { color: #1d1c1a; font-weight: 600; }
    .legend svg { flex: 0 0 auto; }
  </style>
</head>
<body>
<div class="sheet" id="sheet">
  <h1>The dots are the tasks</h1>
  <p>
    Each dot is one task the agent holds. Tasks fill from the centre outward,
    oldest at the centre, the way a kolam is drawn. The line reaches a dot only
    when its task is done, so a finished kolam is a finished queue and bare dots
    are work still owed.
  </p>
  <p>
    Hover a dot for the task, or tab to it. Click it to open the proposal. Hover
    the line for the agent and its three words. Nothing here writes.
  </p>
  <ul class="legend">
${legend}
  </ul>

  <h2>Two agents, from today's record</h2>
  <p>
    Real tasks, read from the message log and the chain through the same
    function the dashboard uses.
  </p>
  <div class="row">
${real.map((a) => `    <figure>
${a.svg.split("\n").map((l) => "      " + l).join("\n")}
      <figcaption><b>${escapeHtml(a.label)}</b>${escapeHtml(inWords(a.label, a.tasks))}<br>
        ${a.now ? "Now: " + escapeHtml(a.now) : "Silent."}</figcaption>
    </figure>`).join("\n")}
  </div>

  <h2>All four states, side by side</h2>
  <p>
    Made up, on purpose: no agent holds one of each today, and this is about
    reading the states rather than reading today.
  </p>
  <div class="row">
    <figure>
${sampleSvg.split("\n").map((l) => "      " + l).join("\n")}
      <figcaption><b>The four states</b>Two done, one being built, one blocked,
        one queued. The line stops where the queue does.</figcaption>
    </figure>
  </div>
</div>

<script src="../interact.js"></script>
<script>
  GovernanceKolamInteract.attach(document.getElementById("sheet"));
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(OUT, "interactive.html"), page, "utf8");

  real.forEach((a) => console.log(inWords(a.label, a.tasks)));
  console.log("wrote", fs.readdirSync(OUT).join(", "));
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
