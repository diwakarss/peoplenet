// The swarm dashboard (proposal 59). Renders what swarm.js shapes and does
// nothing else: no chain writes, no button that leads to one. Every row is a
// link to that proposal's card on the chain page.
(function () {
  "use strict";

  var R = window.GovernanceRead;
  var S = window.GovernanceSwarm;
  var K = window.GovernanceKolam;
  var REFRESH_MS = 15000;

  // A kolam is redrawn only when its queue actually changed. Rebuilding the
  // SVG on every poll would restart a pulsing dot's animation four times a
  // minute and throw away the dot the operator is hovering.
  var drawn = {};

  function signatureOf(agent) {
    return agent.tasks.map(function (t) { return t.proposalId + ":" + t.state; }).join("|") +
      "#" + agent.now + "#" + (agent.ctx === null ? "" : agent.ctx);
  }

  function byId(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // The chain page opens a proposal by its own hash route, so a row here is an
  // ordinary link: it survives a middle click, and it cannot write.
  function proposalHref(row) {
    return "/#aao=" + row.aaoId + "&proposal=" + row.proposalId;
  }

  function age(ms) {
    if (ms === null || ms === undefined) return "never";
    var minutes = Math.round(ms / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + "m ago";
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + "h ago";
    return Math.round(hours / 24) + "d ago";
  }

  // How long something has been waiting, as a duration rather than a moment.
  // "4h ago" reads as when it happened; this list is about how long it has gone
  // on.
  function waited(ms) {
    var hours = Math.floor((ms || 0) / 3600000);
    if (hours < 48) return hours + "h";
    return Math.floor(hours / 24) + "d";
  }

  function rowNode(row) {
    var item = el("li", "row" + (row.directors ? " is-directors" : ""));
    var link = el("a", "row-link");
    link.href = proposalHref(row);
    link.appendChild(el("span", "row-id", "#" + row.proposalId));
    link.appendChild(el("span", "row-title", row.title));
    item.appendChild(link);

    var line = el("p", "row-line");
    if (row.state === "blocked") {
      line.appendChild(el("span", "row-who", row.who || "someone"));
      line.appendChild(el("span", "row-for", row.what ? " for " + row.what : ""));
    } else {
      line.textContent = row.said || "";
    }
    item.appendChild(line);

    var foot = el("p", "row-foot");
    foot.appendChild(el("span", "row-org", row.organisation || "—"));
    // Where the row came from: a block the Director filed as a proposal is
    // cleared by his vote, and a block an agent reported is cleared by a later
    // decision. Saying which is saying how it ends.
    if (row.state === "blocked") {
      foot.appendChild(el("span", "row-source",
        row.source === "proposal" ? "his vote clears it" : "reported by an agent"));
    }
    item.appendChild(foot);
    return item;
  }

  // Proposal 91. One line per unclaimed proposal: the organisation, the
  // proposal, its title, how long it has waited, and who was told.
  function unclaimedNode(row) {
    var item = el("li", "row is-unclaimed");
    var link = el("a", "row-link");
    link.href = proposalHref(row);
    link.appendChild(el("span", "row-id", "#" + row.proposalId));
    link.appendChild(el("span", "row-title", row.title));
    item.appendChild(link);

    var foot = el("p", "row-foot");
    foot.appendChild(el("span", "row-org", row.organisation || "—"));
    foot.appendChild(el("span", "row-waited", "waiting " + waited(row.waitedMs)));
    foot.appendChild(el("span", "row-architect", row.architect + " was told"));
    item.appendChild(foot);
    return item;
  }

  // Hidden when it is empty: an empty red band at the top of the page every day
  // is a band nobody reads on the day it matters.
  function renderUnclaimed(rows) {
    var section = byId("unclaimed");
    var host = byId("rows-unclaimed");
    host.textContent = "";
    byId("count-unclaimed").textContent = rows.length;
    section.hidden = rows.length === 0;
    rows.forEach(function (row) { host.appendChild(unclaimedNode(row)); });
  }

  function renderColumn(name, rows) {
    var host = byId("rows-" + name);
    host.textContent = "";
    byId("count-" + name).textContent = rows.length;
    if (!rows.length) {
      host.appendChild(el("li", "row is-empty", "Nothing here."));
      return;
    }
    rows.forEach(function (row) { host.appendChild(rowNode(row)); });
  }

  function renderStreet(agents) {
    var host = byId("agents");
    var fresh = {};
    agents.forEach(function (agent) { fresh[agent.key] = signatureOf(agent); });

    // Nothing moved: leave the street exactly as it is, animations and focus
    // and all.
    if (agents.every(function (a) { return drawn[a.key] === fresh[a.key]; }) &&
        host.children.length === agents.length) {
      return;
    }
    drawn = fresh;

    host.textContent = "";
    agents.forEach(function (agent) {
      var item = el("li", "agent" + (agent.silent ? " is-silent" : ""));

      // The agent's threshold: its dots are its tasks, and the line is drawn as
      // far as the queue is done (proposal 64, carried on the Director's vote).
      var threshold = el("div", "threshold");
      threshold.innerHTML = K.toSVG(agent.address, {
        tasks: agent.tasks,
        agent: agent.key,
        label: agent.label,
        now: agent.now,
        ctx: agent.ctx,
        id: "kolam-" + agent.key,
        width: 96,
        height: 96
      });
      item.appendChild(threshold);

      var body = el("div", "agent-body");
      body.appendChild(el("p", "agent-name", agent.label));
      body.appendChild(el("p", "agent-org", agent.organisation || "—"));

      // The three words, and beside them how full the agent is (proposal 96).
      // Beside, not below: what it is doing and whether it is about to stop are
      // one fact, and reading them apart is what let a builder stall mid-item.
      var doing = el("p", "agent-now", agent.now || "silent");
      if (agent.ctx !== null && agent.ctx !== undefined) {
        doing.appendChild(el("span", "agent-ctx is-" + (agent.ctxBand || "quiet"),
          agent.ctx + "%"));
      }
      body.appendChild(doing);
      body.appendChild(el("p", "agent-age", age(agent.ageMs)));
      body.appendChild(el("p", "agent-queue", agent.tasks.length
        ? agent.done + " of " + agent.tasks.length + " done"
        : "no tasks"));
      item.appendChild(body);
      host.appendChild(item);
    });
  }

  async function read() {
    var messages = [];
    try {
      var response = await fetch("/messages.json", { cache: "no-store" });
      if (response.ok) messages = await response.json();
    } catch (e) { /* the page still shows the chain without the log */ }

    var proposals = [];
    var aaos = [];
    try {
      var contract = R.getContract(window.ethers, R.getProvider(window.ethers));
      aaos = await R.readAAOs(contract);
      proposals = await R.readAllProposals(contract, aaos);
      byId("chain").textContent = "chain id " + R.CHAIN_ID;
    } catch (e) {
      byId("chain").textContent = "chain unreachable — showing the message log only";
    }

    var data = S.dashboard(messages, proposals, aaos, Date.now());
    renderUnclaimed(data.unclaimed);
    renderColumn("blocked", data.blocked);
    renderColumn("building", data.building);
    renderColumn("done", data.done);
    renderStreet(data.street);
    byId("read-at").textContent = "read " + new Date().toLocaleTimeString();
  }

  read();
  window.setInterval(read, REFRESH_MS);

  // One listener for the whole street, attached once: the kolams come and go
  // under it, and a listener per kolam would leak one on every redraw.
  window.GovernanceKolamInteract.attach(byId("agents"));
}());
