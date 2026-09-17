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

  // The question channel (27.2): the Director's questions and Wren's answers,
  // polled every two seconds so the latency the operator sees is Wren's own.
  var questions = [];
  var answers = [];
  var threadError = null;

  // What the Director has typed but not yet sent, per proposal. Kept out of the
  // DOM so a redraw cannot eat a half-written question.
  var drafts = {};
  var asking = {};

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

  function executeProposal(proposalId, buttonKey) {
    return send(proposalId, buttonKey || "execute", async function () {
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

    card.appendChild(renderThread(p));

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

  // --- the question channel (27.2) ---------------------------------------

  function questionsFor(proposalId) {
    return questions.filter(function (q) { return Number(q.proposal) === Number(proposalId); });
  }

  function answersTo(questionId) {
    return answers.filter(function (a) { return a.question === questionId; });
  }

  function timeOf(record) {
    var raw = record.at || record.ts;
    if (!raw) return "";
    var d = new Date(raw);
    return isNaN(d.getTime()) ? String(raw) : d.toLocaleTimeString();
  }

  // One input, one button, and the thread underneath. Nothing else: the Director
  // asks in a sentence and Wren answers in a sentence.
  function renderThread(p) {
    var wrap = el("section", "thread");
    var mine = questionsFor(p.id);
    var anyAnswered = mine.some(function (q) { return answersTo(q.id).length > 0; });

    var head = el("div", "thread-head");
    head.appendChild(el("h4", "thread-title", "Questions to Wren"));
    if (mine.length) {
      head.appendChild(el("span", "thread-count",
        mine.length + (mine.length === 1 ? " asked" : " asked") + " · " +
        answers.filter(function (a) { return Number(a.proposal) === p.id; }).length + " answered"));
    }
    wrap.appendChild(head);

    mine.forEach(function (q) {
      wrap.appendChild(renderQuestion(q));
    });

    if (threadError) {
      wrap.appendChild(el("p", "thread-note", "The question channel is unavailable: " + threadError));
      return wrap;
    }

    wrap.appendChild(renderAskBox(p));

    // 27.2: after an answer, the Director either closes it as a tie or asks for
    // a better proposal. Both are offered only once there is something to judge.
    if (anyAnswered) wrap.appendChild(renderAfterAnswer(p));

    return wrap;
  }

  function renderQuestion(q) {
    var item = el("article", "qa");
    var isRequest = q.type === "request-new-proposal";

    var qHead = el("div", "qa-head");
    qHead.appendChild(el("span", "qa-who qa-who-director",
      isRequest ? "Director asked for a new proposal" : "Director asked"));
    qHead.appendChild(el("span", "qa-time", timeOf(q)));
    item.appendChild(qHead);
    item.appendChild(el("p", "qa-text", q.text || q.summary || ""));

    var replies = answersTo(q.id);
    if (!replies.length) {
      item.appendChild(el("p", "qa-waiting",
        isRequest ? "Sent to the proposer. Awaiting a revised proposal." : "Waiting for Wren…"));
      return item;
    }

    replies.forEach(function (a) {
      var reply = el("div", "qa-reply");
      var rHead = el("div", "qa-head");
      rHead.appendChild(el("span", "qa-who qa-who-wren", R.labelFor(R.WREN) + " answered"));
      rHead.appendChild(el("span", "qa-time", timeOf(a)));
      reply.appendChild(rHead);
      reply.appendChild(el("p", "qa-text", a.text || a.summary || ""));

      // The technical part lives below a fold, as 27.2 asks.
      if (a.details && String(a.details).trim()) {
        var fold = el("details", "qa-details");
        fold.appendChild(el("summary", null, "Technical detail"));
        fold.appendChild(el("pre", "qa-pre", a.details));
        reply.appendChild(fold);
      }
      if (Array.isArray(a.refs) && a.refs.length) {
        reply.appendChild(el("p", "qa-refs", "refs: " + a.refs.join(", ")));
      }
      item.appendChild(reply);
    });

    return item;
  }

  function renderAskBox(p) {
    var box = el("form", "ask");
    var input = el("input", "ask-input");
    input.type = "text";
    input.placeholder = "Ask Wren about this proposal…";
    input.value = drafts[p.id] || "";
    input.setAttribute("data-draft", String(p.id));
    input.disabled = Boolean(asking[p.id]);
    input.addEventListener("input", function () { drafts[p.id] = input.value; });

    var button = el("button", "ask-send", asking[p.id] ? "sending…" : "Ask");
    button.type = "submit";
    button.disabled = Boolean(asking[p.id]);

    box.appendChild(input);
    box.appendChild(button);
    box.addEventListener("submit", function (event) {
      event.preventDefault();
      ask(p.id, drafts[p.id] || input.value, "question");
    });
    return box;
  }

  function renderAfterAnswer(p) {
    var wrap = el("div", "after-answer");
    var level = p.forVotes === p.againstVotes;
    var open = p.status === 0;
    var st = stateFor(p.id);

    var tie = el("button", "close-tie", st.busy === "close-tie" ? "working…" : "Close as tie");
    tie.disabled = !open || !level || st.busy !== null;
    if (!tie.disabled) {
      tie.addEventListener("click", function () { executeProposal(p.id, "close-tie"); });
    }
    wrap.appendChild(tie);

    var again = el("button", "ask-new", asking[p.id] ? "sending…" : "Ask for a new proposal");
    again.disabled = Boolean(asking[p.id]);
    if (!again.disabled) {
      again.addEventListener("click", function () {
        ask(p.id,
          drafts[p.id] || "This proposal is not it. Please file a revised one that links this.",
          "request-new-proposal");
      });
    }
    wrap.appendChild(again);

    var note = el("p", "hint");
    if (!open) {
      note.textContent = "Closed — " + p.statusLabel.toLowerCase() + ".";
    } else if (level) {
      note.textContent =
        "Tally is level at " + p.forVotes + "–" + p.againstVotes +
        ". Closing as a tie executes it, which rejects a level tally.";
    } else {
      note.textContent =
        "Close as tie needs a level tally; it stands at " + p.forVotes + "–" + p.againstVotes + ".";
    }
    wrap.appendChild(note);

    return wrap;
  }

  async function ask(proposalId, text, type) {
    var body = String(text || "").trim();
    if (!body) return;
    asking[proposalId] = true;
    threadError = null;
    render(lastData);
    try {
      var response = await window.fetch("/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal: proposalId, text: body, type: type })
      });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok || result.ok === false) {
        throw new Error((result.errors || ["HTTP " + response.status]).join("; "));
      }
      drafts[proposalId] = "";
    } catch (e) {
      stateFor(proposalId).error = "Could not send the question: " + (e.message || e);
    } finally {
      asking[proposalId] = false;
    }
    await refreshThreads();
    render(lastData);
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

  // A redraw replaces the DOM, which would steal focus from a half-typed
  // question. Remember where the caret was and put it back.
  function captureFocus() {
    var active = document.activeElement;
    if (!active || !active.getAttribute) return null;
    var draft = active.getAttribute("data-draft");
    if (draft === null) return null;
    return { draft: draft, start: active.selectionStart, end: active.selectionEnd };
  }

  function restoreFocus(mark) {
    if (!mark) return;
    var input = document.querySelector('[data-draft="' + mark.draft + '"]');
    if (!input) return;
    input.focus();
    try { input.setSelectionRange(mark.start, mark.end); } catch (e) { /* not a text input */ }
  }

  function render(data) {
    if (!data) return;
    var mark = captureFocus();
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
    restoreFocus(mark);
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

  // The question channel, polled every two seconds (27.2). Cheap: two small
  // files off the loopback server. Nothing here touches the chain.
  async function fetchJson(path) {
    var response = await window.fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(path + " returned HTTP " + response.status);
    var body = await response.json();
    if (!Array.isArray(body)) throw new Error(path + " did not return a JSON array");
    return body;
  }

  // Returns true when something actually changed, so the poll only redraws when
  // there is news -- a redraw every two seconds would fight the Director's typing.
  async function refreshThreads() {
    if (typeof window.fetch !== "function") {
      threadError = "this browser has no fetch";
      return false;
    }
    var before = questions.length + ":" + answers.length + ":" + (threadError || "");
    try {
      var pair = await Promise.all([fetchJson("/questions.json"), fetchJson("/answers.json")]);
      questions = pair[0];
      answers = pair[1];
      threadError = null;
    } catch (e) {
      questions = [];
      answers = [];
      threadError = e && e.message ? e.message : String(e);
    }
    return before !== questions.length + ":" + answers.length + ":" + (threadError || "");
  }

  async function refresh() {
    if (rendering) return;
    rendering = true;
    try {
      await refreshWrenVotes();
      await refreshThreads();
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

  async function pollThreads() {
    if (rendering) return;
    var changed = await refreshThreads();
    if (changed) render(lastData);
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
  // The question channel is the impatient one: two seconds, so the only delay
  // the Director feels between asking and reading the answer is Wren's own.
  setInterval(pollThreads, 2000);

  // Debugging handle: the live provider and contract, plus the render path, so
  // the page can be driven from a console or a CDP session without a chain that
  // happens to be in the right state.
  window.__governance = {
    provider: provider,
    contract: readContract,
    refresh: refresh,
    render: render,
    data: function () { return lastData; },
    wrenVotes: function () { return wrenVotes; },
    threads: function () { return { questions: questions, answers: answers, error: threadError }; },
    refreshThreads: refreshThreads,
    ask: ask
  };
})();
