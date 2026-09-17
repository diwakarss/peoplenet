// governance/app.js -- the page. Reads through governance/read.js, writes only
// when the Director clicks.
//
// Signing: the page never holds a private key. It asks the Hardhat node for a
// signer on one of its own unlocked accounts (eth_sendTransaction), so the key
// stays in the node where it already lives. On a real network this approach
// simply would not work -- which is the point.
(function () {
  "use strict";

  var R = window.GovernanceRead;
  var ethers = window.ethers;

  if (!ethers) {
    document.getElementById("aao-topic").textContent = "ethers failed to load";
    setConnection("err", "no ethers");
    return;
  }

  var provider = R.getProvider(ethers);
  var readContract = R.getContract(ethers, provider);

  // Per-proposal UI state that must survive a re-render: the last error and the
  // last execution outcome, plus which button is mid-flight.
  var ui = {};
  function stateFor(id) {
    if (!ui[id]) ui[id] = { error: null, outcome: null, busy: null };
    return ui[id];
  }

  var rendering = false;
  var lastData = null;

  // Wren's reasons, keyed by proposal id, from GET /wren-votes.json. Absent when
  // the page is opened straight off the filesystem instead of through the server.
  var wrenVotes = {};
  var wrenVotesError = null;

  // "Hide closed" survives a reload; it is a per-viewer convenience, nothing more.
  var hideClosed = false;
  try {
    hideClosed = window.localStorage.getItem("governance.hideClosed") === "1";
  } catch (e) { /* private window, blocked storage: the default is fine */ }

  // --- small DOM helpers -------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function setConnection(kind, text) {
    var chip = byId("conn");
    if (!chip) return;
    chip.className = "chip " + (kind === "ok" ? "chip-ok" : kind === "err" ? "chip-err" : "chip-wait");
    chip.textContent = text;
  }

  // --- writes ------------------------------------------------------------

  async function signerFor(address) {
    // Throws if the node does not have this account unlocked.
    return provider.getSigner(address);
  }

  async function send(proposalId, buttonKey, action) {
    var st = stateFor(proposalId);
    st.busy = buttonKey;
    st.error = null;
    render(lastData);
    try {
      await action();
      st.error = null;
    } catch (e) {
      st.error = readableError(e);
    } finally {
      st.busy = null;
    }
    await refresh();
  }

  function readableError(e) {
    // Hardhat puts the require() string somewhere different depending on how the
    // call failed; dig for the useful sentence before falling back.
    var reason = (e && (e.reason || (e.info && e.info.error && e.info.error.message) || e.shortMessage || e.message)) || String(e);
    return String(reason).replace(/^execution reverted:?\s*/i, "");
  }

  function castVote(proposalId, support, voterAddress, buttonKey) {
    return send(proposalId, buttonKey, async function () {
      var signer = await signerFor(voterAddress);
      var tx = await R.getContract(ethers, signer).vote(proposalId, support);
      await tx.wait();
    });
  }

  function executeProposal(proposalId) {
    return send(proposalId, "execute", async function () {
      var signer = await signerFor(R.DIRECTOR);
      var contract = R.getContract(ethers, signer);
      var tx = await contract.executeProposal(proposalId);
      var receipt = await tx.wait();
      // The chain's own answer, not ours: read it off ProposalExecuted.
      var passed = null;
      for (var i = 0; i < receipt.logs.length; i++) {
        try {
          var parsed = contract.interface.parseLog(receipt.logs[i]);
          if (parsed && parsed.name === "ProposalExecuted") passed = Boolean(parsed.args.passed);
        } catch (err) { /* a log from another facet; ignore */ }
      }
      stateFor(proposalId).outcome = {
        passed: passed,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber
      };
    });
  }

  // --- rendering ---------------------------------------------------------

  function renderHeader(data) {
    byId("aao-topic").textContent = data.aao.topic || "(untitled AAO)";
    byId("aao-id").textContent = String(data.aao.id);
    byId("diamond").textContent = R.DIAMOND;
    byId("block").textContent = String(data.blockNumber);
    byId("refreshed").textContent = "read " + new Date().toLocaleTimeString();

    byId("fact-topic").textContent = data.aao.topic;
    byId("fact-created").textContent = R.formatTime(data.aao.createdAt);

    var creator = byId("fact-creator");
    creator.textContent = "";
    creator.appendChild(el("span", null, data.aao.creatorLabel + " "));
    creator.appendChild(el("span", "addr", data.aao.creator));

    byId("fact-members").textContent =
      data.aao.members.length + (data.aao.active ? "" : " (AAO inactive)");

    var list = byId("members");
    list.textContent = "";
    data.aao.members.forEach(function (m) {
      var li = el("li", "member");
      li.appendChild(el("span", "role" + (m.role === "casting" ? " role-casting" : ""), m.label));
      li.appendChild(el("span", "addr", m.address));
      if (m.isCreator) li.appendChild(el("span", "tag", "creator"));
      if (m.role === "casting") li.appendChild(el("span", "tag", "tie-break only"));
      list.appendChild(li);
    });
  }

  function bar(kind, label, count, total) {
    var row = el("div", "bar-row bar-" + kind);
    row.appendChild(el("span", null, label));
    var track = el("div", "bar-track");
    var fill = el("div", "bar-fill");
    fill.style.width = (total > 0 ? Math.round((count / total) * 100) : 0) + "%";
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("span", "bar-num", count));
    return row;
  }

  function renderProposal(p, aao) {
    var st = stateFor(p.id);
    var card = el("article", "proposal");

    var head = el("div", "proposal-head");
    head.appendChild(el("span", "pid", "#" + p.id));
    head.appendChild(el("span", "chip chip-" + p.statusLabel.toLowerCase(), p.statusLabel));
    var by = el("span", "by");
    by.appendChild(document.createTextNode("by "));
    by.appendChild(el("b", null, p.proposerLabel));
    by.appendChild(document.createTextNode(" · " + R.formatTime(p.createdAt)));
    head.appendChild(by);
    card.appendChild(head);

    card.appendChild(el("p", "proposal-text", p.text));

    var total = Math.max(p.forVotes + p.againstVotes, aao.members.length, 1);
    var tally = el("div", "tally");
    tally.appendChild(bar("for", "For", p.forVotes, total));
    tally.appendChild(bar("against", "Against", p.againstVotes, total));
    card.appendChild(tally);

    var voters = el("div", "voters");
    if (!p.votes.length) {
      voters.appendChild(el("span", "no-votes", "no votes yet"));
    } else {
      p.votes.forEach(function (v) {
        var span = el("span", "voter voter-" + (v.support ? "for" : "against"));
        span.appendChild(el("b", null, v.label));
        span.appendChild(document.createTextNode(" " + (v.support ? "for" : "against")));
        voters.appendChild(span);
      });
    }
    card.appendChild(voters);

    card.appendChild(renderWrenReason(p));

    card.appendChild(renderActions(p, st));

    if (st.outcome) {
      var text = st.outcome.passed === null
        ? "Executed — no outcome event found."
        : st.outcome.passed
          ? "Executed on chain: passed."
          : "Executed on chain: rejected.";
      card.appendChild(el("p", "outcome", text + " Block " + st.outcome.blockNumber + "."));
    } else if (p.outcome !== null && p.status !== 0) {
      card.appendChild(el("p", "outcome",
        "Closed on chain: " + (p.outcome ? "passed" : "rejected") + "."));
    }

    if (st.error) card.appendChild(el("p", "err", st.error));

    return card;
  }

  // Wren's argument, under the chain's arithmetic. The tally above says what the
  // vote was; this says why, in Wren's own words, so the Director can weigh the
  // reason rather than just the count.
  function renderWrenReason(p) {
    var record = wrenVotes[p.id];
    var block = el("div", "wren");

    if (!record) {
      block.className = "wren wren-absent";
      block.appendChild(el("span", "wren-who", "Wren has not voted"));
      if (wrenVotesError) {
        block.appendChild(el("span", "wren-note", "(reasons unavailable: " + wrenVotesError + ")"));
      }
      return block;
    }

    var support = Boolean(record.support);
    block.className = "wren wren-" + (support ? "for" : "against");

    var who = el("span", "wren-who");
    who.appendChild(document.createTextNode("Wren voted "));
    who.appendChild(el("b", null, support ? "FOR" : "AGAINST"));
    block.appendChild(who);

    var reason = String(record.reason || "").trim();
    block.appendChild(el("blockquote", "wren-reason", reason || "(no reason recorded)"));

    // A record whose direction disagrees with the chain means the log and the
    // chain have drifted; say so rather than quietly presenting a wrong reason.
    var onChain = (p.votes || []).filter(function (v) { return R.sameAddress(v.voter, R.WREN); })[0];
    if (onChain && onChain.support !== support) {
      block.appendChild(el("span", "wren-note",
        "The chain records Wren voting " + (onChain.support ? "for" : "against") +
        " — the log disagrees. Trust the chain."));
    }

    return block;
  }

  function renderActions(p, st) {
    var wrap = el("div", "actions");
    var open = p.status === 0;
    var busy = st.busy !== null;
    var directorVoted = R.hasVoted(p, R.DIRECTOR);
    var casting = R.castingVoteState(p);

    function button(className, label, key, disabled, onClick) {
      var b = el("button", className, st.busy === key ? "working…" : label);
      b.disabled = disabled || busy;
      if (!b.disabled) b.addEventListener("click", onClick);
      return b;
    }

    wrap.appendChild(button("for", "Vote for", "for", !open || directorVoted, function () {
      castVote(p.id, true, R.DIRECTOR, "for");
    }));
    wrap.appendChild(button("against", "Vote against", "against", !open || directorVoted, function () {
      castVote(p.id, false, R.DIRECTOR, "against");
    }));

    wrap.appendChild(button("casting", "Casting vote: for", "casting-for", !casting.allowed, function () {
      castVote(p.id, true, R.CASTING, "casting-for");
    }));
    wrap.appendChild(button("casting", "Casting vote: against", "casting-against", !casting.allowed, function () {
      castVote(p.id, false, R.CASTING, "casting-against");
    }));

    wrap.appendChild(button("execute", "Execute", "execute", !open, function () {
      executeProposal(p.id);
    }));

    var hint = el("p", "hint");
    if (!open) {
      hint.textContent = "Closed — " + p.statusLabel.toLowerCase() + ".";
    } else if (casting.allowed) {
      hint.textContent = casting.reason;
    } else {
      hint.textContent =
        (directorVoted ? "The Director has voted. " : "") +
        "Casting vote: " + casting.reason.charAt(0).toLowerCase() + casting.reason.slice(1) +
        " Execute would " + (R.predictedOutcome(p) ? "pass" : "reject") + " it right now.";
    }
    wrap.appendChild(hint);

    return wrap;
  }

  function render(data) {
    if (!data) return;
    lastData = data;
    renderHeader(data);

    var all = data.proposals;
    var shown = hideClosed ? all.filter(function (p) { return p.status === 0; }) : all;

    byId("proposal-count").textContent = shown.length === all.length
      ? "(" + all.length + ")"
      : "(" + shown.length + " of " + all.length + ")";

    var host = byId("proposals");
    host.textContent = "";
    if (!all.length) {
      host.appendChild(el("p", "empty", "No proposals on this AAO yet."));
      return;
    }
    if (!shown.length) {
      host.appendChild(el("p", "empty", "Every proposal is closed. Untick “Hide closed” to see them."));
      return;
    }
    shown.forEach(function (p) {
      host.appendChild(renderProposal(p, data.aao));
    });
  }

  // --- refresh loop ------------------------------------------------------

  // Wren's reasons come from the page's own server, so a page opened over
  // file:// (or with the server down) simply loses the reasons and keeps the
  // chain. Never fatal.
  async function refreshWrenVotes() {
    if (typeof window.fetch !== "function") {
      wrenVotesError = "this browser has no fetch";
      return;
    }
    try {
      var records = await R.fetchWrenVotes(window.fetch.bind(window), "");
      wrenVotes = R.indexWrenVotes(records);
      wrenVotesError = null;
    } catch (e) {
      wrenVotes = {};
      wrenVotesError = e && e.message ? e.message : String(e);
    }
  }

  async function refresh() {
    if (rendering) return;
    rendering = true;
    try {
      await refreshWrenVotes();
      var data = await R.readGovernance(ethers, provider);
      setConnection("ok", "chain " + R.CHAIN_ID);
      render(data);
    } catch (e) {
      setConnection("err", "no chain at 127.0.0.1:8545");
      byId("aao-topic").textContent = "Cannot reach the local chain";
      console.error(e);
    } finally {
      rendering = false;
    }
  }

  var hideClosedBox = byId("hide-closed");
  hideClosedBox.checked = hideClosed;
  hideClosedBox.addEventListener("change", function () {
    hideClosed = hideClosedBox.checked;
    try {
      window.localStorage.setItem("governance.hideClosed", hideClosed ? "1" : "0");
    } catch (e) { /* not worth failing a redraw over */ }
    render(lastData);
  });

  refresh();
  // Every new block redraws: a vote from wren-vote.js shows up here without a reload.
  provider.on("block", function () { refresh(); });
  // Belt and braces if the websocket-less poller ever stalls.
  setInterval(refresh, 8000);

  // Debugging handle: the live provider and contract, plus the render path, so
  // the page can be driven from a console or a CDP session without a chain that
  // happens to be in the right state.
  window.__governance = {
    provider: provider,
    contract: readContract,
    refresh: refresh,
    render: render,
    data: function () { return lastData; },
    wrenVotes: function () { return wrenVotes; }
  };
})();
