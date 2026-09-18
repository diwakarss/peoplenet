// governance/app.js -- the page.
//
// Reads through governance/read.js, writes only when the Director clicks.
//
// Signing: the page never holds a private key. It asks the Hardhat node for a
// signer on one of its own unlocked accounts (eth_sendTransaction), so the key
// stays in the node where it already lives. On a real network this approach
// simply would not work -- which is the point.
//
// One click (27.6a): every function and every piece of information is at most
// one click away. A fold is one click. There are no folds inside folds, the
// tree and the search open in place, and nothing opens a modal.
(function () {
  "use strict";

  var R = window.GovernanceRead;
  var P = window.GovernanceProtocol;
  var A = window.GovernanceAdoption;
  var ethers = window.ethers;

  function byId(id) { return document.getElementById(id); }

  if (!ethers) {
    byId("conn").textContent = "ethers failed to load";
    return;
  }

  var provider = R.getProvider(ethers);
  var readContract = R.getContract(ethers, provider);

  // --- state -------------------------------------------------------------

  // Per-proposal UI state that must survive a re-render.
  var ui = {};
  function stateFor(id) {
    if (!ui[id]) ui[id] = { error: null, outcome: null, busy: null };
    return ui[id];
  }

  var rendering = false;
  var lastData = null;

  var wrenVotes = {};
  var wrenVotesError = null;

  // The question channel (27.2) and the agent traffic (27.5).
  var questions = [];
  var answers = [];
  var messages = [];
  var threadError = null;

  // Wren's translations of the legacy proposals (27.10), keyed by proposal id.
  var translations = {};

  // The Director's one-field drafts (27.12), awaiting Wren.
  var drafts = [];

  // Where each proposal has got to (27.9), read from Wren's decision messages.
  var adoptions = {};
  var waitDrafts = {};
  var waitBusy = {};

  // What the Director has typed into a question box but not yet sent, per proposal.
  var questionDrafts = {};
  var asking = {};
  var newProposal = { busy: false, error: null, filed: null, open: false };

  var view = remember("governance.view", "governance");
  var selectedAaoId = Number(remember("governance.aao", "0"));
  var searchQuery = "";
  var treeOpen = {};

  // One at a time (27.11): which filter, and which card the Director is on.
  // The cursor is a card key, not an index, so a refresh that changes the list
  // does not silently move the Director to a different proposal.
  var filterKey = remember("governance.filter", "mine");
  var cursorId = null;

  function remember(key, fallback) {
    try {
      var v = window.localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function store(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch (e) { /* fine */ }
  }

  // --- small DOM helpers -------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setConnection(kind, text) {
    var chip = byId("conn");
    if (!chip) return;
    chip.className = "chip " + (kind === "ok" ? "chip-ok" : kind === "err" ? "chip-err" : "chip-wait");
    chip.textContent = text;
  }

  function textOf(value) {
    return String(value === undefined || value === null ? "" : value);
  }

  // The one line that stands for a proposal in the tree, the search, a stream
  // row or a notification. A translated legacy proposal is named by Wren's
  // title, not by the first eighty characters of its wall of text (27.10).
  function headline(p) {
    var translated = p && p.format && p.format.legacy ? translations[p.id] : null;
    if (translated && translated.title) return String(translated.title);
    return R.proposalHeadline(p);
  }

  // --- writes ------------------------------------------------------------

  async function signerFor(address) {
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
    var reason = (e && (e.reason ||
      (e.info && e.info.error && e.info.error.message) ||
      e.shortMessage || e.message)) || String(e);
    return String(reason).replace(/^execution reverted:?\s*/i, "");
  }

  // The Director's vote settles the proposal there and then, unless it is tied.
  //
  // A proposal must never sit Active after the Director has voted: the vote is
  // the decision, and leaving it open makes the Director come back to press a
  // second button for an outcome the chain already knows. So when the tally is
  // not level after the vote confirms, the page executes immediately from
  // account 0 and shows what the chain said. When it is level it executes
  // nothing and the casting-vote buttons appear instead -- that is the one case
  // where a second decision is genuinely still needed.
  //
  // Only on the main organisation, and only for the Director's own votes --
  // their ordinary one and their casting one. Wren's votes, cast from
  // wren-vote.js, never execute anything.
  function castVote(proposalId, support, voterAddress, buttonKey) {
    return send(proposalId, buttonKey, async function () {
      var signer = await signerFor(voterAddress);
      var contract = R.getContract(ethers, signer);

      // The same guard the scripts use: an unfiled id reads back as a zero
      // struct that AAOFacet.vote() accepts, and the vote it records then
      // blocks the real one. Read the chain, refuse if there is nothing there,
      // and refuse if the text is not what the card is showing.
      var target = await contract.getProposal(proposalId);
      var shown = (lastData && (lastData.allProposals || []).filter(
        function (x) { return x.id === proposalId; })[0]) || null;
      var problem = R.voteTargetProblem(
        proposalId, target, shown ? { text: shown.text } : null);
      if (problem) throw new Error(problem);

      // The same standing check the scripts apply, from the same rule set: may
      // this account vote on this organisation at all, and if it is the casting
      // vote, is the tally level with the ordinary voters in? A disabled button
      // is a courtesy; this is the rule.
      if (shown) {
        var rules = rulesForProposal(shown);
        var standing = R.voterProblem(rules, voterAddress);
        if (standing) throw new Error(standing);
        var isCasting = rules.casting && R.sameAddress(rules.casting, voterAddress);
        if (isCasting) {
          var casting = R.castingStateUnder(rules, shown);
          if (!casting.allowed) throw new Error("The casting vote is not ready: " + casting.reason);
        }
      }

      var tx = await contract.vote(proposalId, support);
      await tx.wait();

      var directorsVote = R.sameAddress(voterAddress, R.DIRECTOR) ||
        R.sameAddress(voterAddress, R.CASTING);
      if (!directorsVote) return;

      var after = await contract.getProposal(proposalId);
      if (Number(after.aaoId) !== R.AAO_ID) return;      // main organisation only
      if (Number(after.status) !== 0) return;            // already settled
      if (Number(after.forVotes) === Number(after.againstVotes)) return;  // tied

      // Execute as the Director, whichever account cast the vote.
      var director = R.getContract(ethers, await signerFor(R.DIRECTOR));
      await runExecute(proposalId, director, "automatically, on your vote");
    });
  }

  // Send executeProposal and record what the chain reported. Shared by the
  // Execute button, "Close as tie", and the automatic execute above.
  async function runExecute(proposalId, contract, why) {
    var tx = await contract.executeProposal(proposalId);
    var receipt = await tx.wait();
    var passed = null;
    for (var i = 0; i < receipt.logs.length; i++) {
      try {
        var parsed = contract.interface.parseLog(receipt.logs[i]);
        if (parsed && parsed.name === "ProposalExecuted") passed = Boolean(parsed.args.passed);
      } catch (err) { /* a log from another facet */ }
    }
    stateFor(proposalId).outcome = {
      passed: passed,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      why: why || null
    };
    return passed;
  }

  function executeProposal(proposalId, buttonKey) {
    return send(proposalId, buttonKey || "execute", async function () {
      var signer = await signerFor(R.DIRECTOR);
      var contract = R.getContract(ethers, signer);
      await runExecute(proposalId, contract, null);
    });
  }

  // --- header and organisations ------------------------------------------

  function renderHeader(data) {
    byId("chain-id").textContent = String(R.CHAIN_ID);
    byId("diamond").textContent = R.DIAMOND;
    byId("block").textContent = String(data.blockNumber);
    byId("refreshed").textContent = "read " + new Date().toLocaleTimeString();
  }

  function renderAaoTabs(data) {
    var host = byId("aao-tabs");
    host.textContent = "";
    data.aaos.forEach(function (aao) {
      var tab = el("button", "aao-tab" + (aao.id === data.aao.id ? " is-current" : ""));
      tab.type = "button";
      tab.title = aao.note || "";
      tab.appendChild(el("span", "aao-tab-topic", aao.topic));
      var count = (data.allProposals || []).filter(function (p) { return p.aaoId === aao.id; }).length;
      tab.appendChild(el("span", "aao-tab-count", count));
      tab.addEventListener("click", function () { selectAao(aao.id); });
      host.appendChild(tab);
    });
    byId("org-summary").textContent = data.aao.topic + " · " + data.aao.members.length + " members";
  }

  function selectAao(id) {
    if (selectedAaoId === id) return;
    selectedAaoId = id;
    cursorId = null;            // a different organisation starts at its first card
    store("governance.aao", id);
    refresh();
  }

  function renderOrganisation(data) {
    var aao = data.aao;
    byId("fact-topic").textContent = aao.topic;
    byId("fact-note").textContent = aao.note || "—";
    byId("fact-created").textContent = R.formatTime(aao.createdAt);

    var creator = byId("fact-creator");
    creator.textContent = "";
    creator.appendChild(el("span", null, aao.creatorLabel + " "));
    creator.appendChild(el("span", "addr", aao.creator));

    // The organisation's rule set, in its own words (read.js owns the rules;
    // this only prints them). A rule nobody can read is a rule nobody can be
    // held to, so the first line sits on the bar and all of them in the fold.
    //
    // The widget-builder has two regimes and runs whichever one the chain says,
    // so the header names the one in force in a whole sentence before it quotes
    // the rule. An organisation with only one regime says nothing.
    var onThisAao = (data.allProposals || []).filter(function (p) { return p.aaoId === aao.id; });
    var rules = R.effectiveRules(aao, onThisAao);
    var regime = byId("orgbar-regime");
    regime.textContent = rules.regime || "";
    regime.className = "orgbar-regime" + (rules.interim ? " is-interim" : "");
    regime.hidden = !rules.regime;
    byId("orgbar-rule").textContent = rules.plain[0] || "";
    var ruleList = byId("rules");
    ruleList.textContent = "";
    rules.plain.forEach(function (line) { ruleList.appendChild(el("li", "rule-line", line)); });

    var list = byId("members");
    list.textContent = "";
    aao.members.forEach(function (m) {
      var li = el("li", "member");
      li.appendChild(el("span", "role" + (m.role === "casting" ? " role-casting" : ""), m.label));
      li.appendChild(el("span", "addr", m.address));
      if (m.isCreator) li.appendChild(el("span", "tag", "creator"));
      if (m.role === "casting") li.appendChild(el("span", "tag", "tie-break only"));
      list.appendChild(li);
    });
  }

  // --- the message stream (27.4, 27.5) -----------------------------------

  // Questions, answers and agent messages for one organisation, oldest first,
  // in one timeline. The sub-AAO is where this matters: it is the room the
  // widget, the builder and Wren talk in.
  function streamFor(aaoId) {
    var items = [];
    questions.forEach(function (q) { items.push(q); });
    answers.forEach(function (a) { items.push(a); });
    messages.forEach(function (m) { items.push(m); });
    return items
      .filter(function (m) {
        var on = m.aaoId === undefined || m.aaoId === null ? R.AAO_ID : Number(m.aaoId);
        return on === Number(aaoId);
      })
      .sort(function (a, b) { return String(a.ts || a.at) < String(b.ts || b.at) ? -1 : 1; });
  }

  function renderStream(data) {
    var items = streamFor(data.aao.id);
    byId("stream-count").textContent = "(" + items.length + ")";
    var host = byId("stream");
    host.textContent = "";

    if (threadError) {
      host.appendChild(el("li", "empty", "The message channel is unavailable: " + threadError));
      return;
    }
    if (!items.length) {
      host.appendChild(el("li", "empty", "No messages on this organisation yet."));
      return;
    }

    items.forEach(function (m, index) {
      var li = el("li", "stream-item stream-" + (m.type || "message"));
      var head = el("div", "stream-head");
      head.appendChild(el("span", "num", "1.3." + (index + 1)));
      head.appendChild(el("span", "stream-type", P.typeLabel(m.type)));
      head.appendChild(el("span", "stream-who",
        P.label(m.from) + " → " + P.label(m.to)));
      if (m.proposal !== undefined && m.proposal !== null) {
        var jump = el("button", "stream-jump", "proposal " + m.proposal);
        jump.type = "button";
        jump.addEventListener("click", function () { goToProposal(Number(m.aaoId || 0), Number(m.proposal)); });
        head.appendChild(jump);
      }
      head.appendChild(el("span", "stream-time", timeOf(m)));
      li.appendChild(head);

      if (m.subject) li.appendChild(el("p", "stream-subject", m.subject));
      var summary = m.summary || m.text || "";
      if (summary && summary !== m.subject) li.appendChild(el("p", "stream-summary", summary));

      if (m.details && String(m.details).trim()) {
        var fold = el("details", "stream-details");
        fold.appendChild(el("summary", null, "Technical detail"));
        fold.appendChild(el("pre", "pre", m.details));
        li.appendChild(fold);
      }
      if (Array.isArray(m.refs) && m.refs.length) {
        li.appendChild(el("p", "stream-refs", "Refs: " + m.refs.join(" · ")));
      }
      host.appendChild(li);
    });
  }

  // --- the proposal body (27.1) ------------------------------------------

  // 27.10: the chain will not let a proposal's text be edited, so the sixteen
  // free-text proposals are not rewritten. Wren's translations.json gives each
  // one a title, a summary, a why and the technical line in the 27.1 shape, and
  // the page renders that in place of the wall of text -- saying plainly that it
  // is a translation, with the chain's own words one click away.
  function renderProposalBody(fmt, proposalId) {
    var body = el("div", "proposal-body");

    if (fmt.legacy) {
      var translated = translations[proposalId];
      if (!translated) {
        body.appendChild(el("p", "proposal-text", fmt.raw));
        return body;
      }

      if (translated.title) body.appendChild(el("h3", "proposal-title", translated.title));
      if (translated.summary) body.appendChild(el("p", "proposal-summary", translated.summary));
      if (translated.why) {
        var tWhy = el("p", "proposal-why");
        tWhy.appendChild(el("span", "field-label", "Why"));
        tWhy.appendChild(document.createTextNode(translated.why));
        body.appendChild(tWhy);
      }
      if (translated.technical && String(translated.technical).trim()) {
        var tFold = el("details", "proposal-details");
        tFold.appendChild(el("summary", null, "Technical"));
        tFold.appendChild(el("p", "detail-technical", translated.technical));
        body.appendChild(tFold);
      }

      body.appendChild(el("p", "translated-note", "translated by Wren, chain text unchanged"));

      var rawFold = el("details", "proposal-details raw-fold");
      rawFold.appendChild(el("summary", null, "The chain text"));
      rawFold.appendChild(el("p", "proposal-text pre-wrap", fmt.raw));
      body.appendChild(rawFold);

      return body;
    }

    var doc = fmt.doc;
    if (doc.title) body.appendChild(el("h3", "proposal-title", doc.title));
    if (doc.summary) body.appendChild(el("p", "proposal-summary", doc.summary));
    if (doc.why) {
      var why = el("p", "proposal-why");
      why.appendChild(el("span", "field-label", "Why"));
      why.appendChild(document.createTextNode(doc.why));
      body.appendChild(why);
    }

    var hasDetail = ["technical", "risk", "effort"].some(function (f) {
      return doc[f] && String(doc[f]).trim();
    });
    if (hasDetail) {
      var fold = el("details", "proposal-details");
      fold.appendChild(el("summary", null, "Details"));
      var dl = el("dl", "detail-list");
      [["technical", "Technical"], ["risk", "Risk"], ["effort", "Effort"]].forEach(function (pair) {
        var value = doc[pair[0]];
        if (!value || !String(value).trim()) return;
        dl.appendChild(el("dt", null, pair[1]));
        dl.appendChild(el("dd", pair[0] === "technical" ? "detail-technical" : null, value));
      });
      fold.appendChild(dl);
      body.appendChild(fold);
    }

    if (Array.isArray(doc.refs) && doc.refs.length) {
      var refs = el("p", "proposal-refs");
      refs.appendChild(el("span", "field-label", "Refs"));
      doc.refs.forEach(function (ref, i) {
        if (i) refs.appendChild(document.createTextNode(" · "));
        if (R.isUrl(ref)) {
          var link = el("a", "ref-link", ref);
          link.href = ref;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          refs.appendChild(link);
        } else {
          refs.appendChild(el("span", "ref-plain", ref));
        }
      });
      body.appendChild(refs);
    }

    if (fmt.valid && !fmt.valid.ok) {
      body.appendChild(el("p", "proposal-warn",
        "This proposal is missing: " + fmt.valid.errors.join("; ")));
    }

    return body;
  }

  // --- one field to file (27.12) -----------------------------------------

  // One field and one button. No title, no why, no format -- the page must not
  // stand between the Director having the thought and writing it down. The draft
  // lands in governance/drafts.jsonl; Wren completes it into the 27.1 shape with
  // scripts/wren-file-draft.js, keeping these words as the summary's first
  // sentence.
  //
  // The container in the organisation bar is already the one click, so this
  // returns the form itself -- a fold inside a fold is not allowed (27.6a).
  function renderNewProposalForm(data) {
    var form = el("form", "np-form");

    var row = el("label", "np-row");
    row.appendChild(el("span", "np-label", "What should change?"));
    var box = el("textarea", "np-input");
    box.rows = 4;
    box.name = "draft";
    box.placeholder = "In your own words. Wren turns it into a proposal and files it on the chain.";
    box.setAttribute("data-draft", "np:draft");
    box.value = newProposal.text || "";
    box.disabled = newProposal.busy;
    box.addEventListener("input", function () { newProposal.text = box.value; });
    row.appendChild(box);
    form.appendChild(row);

    var actions = el("div", "np-actions");
    var submit = el("button", "np-send", newProposal.busy ? "sending…" : "Send to Wren");
    submit.type = "submit";
    submit.disabled = newProposal.busy;
    actions.appendChild(submit);
    actions.appendChild(el("span", "np-note",
      "Goes to " + data.aao.topic + " as a draft. Wren files it on the chain."));
    form.appendChild(actions);

    if (newProposal.error) form.appendChild(el("p", "err", newProposal.error));
    if (newProposal.filed) form.appendChild(el("p", "np-filed", newProposal.filed));

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      sendDraft();
    });

    return form;
  }

  async function sendDraft() {
    var text = String(newProposal.text || "").trim();
    if (!text) {
      newProposal.error = "Write what should change first.";
      render(lastData);
      return;
    }
    newProposal.busy = true;
    newProposal.error = null;
    newProposal.filed = null;
    render(lastData);
    try {
      var response = await window.fetch("/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, aaoId: selectedAaoId })
      });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok || result.ok === false) {
        throw new Error((result.errors || ["HTTP " + response.status]).join("; "));
      }
      newProposal.text = "";
      newProposal.filed = "Sent. It shows as “draft, awaiting Wren” until she files it.";
    } catch (e) {
      newProposal.error = "Could not send the draft: " + (e.message || e);
    } finally {
      newProposal.busy = false;
    }
    await refreshThreads();
    render(lastData);
  }

  function currentAaoId() {
    return lastData && lastData.aao ? lastData.aao.id : selectedAaoId;
  }

  // Which organisation a proposal belongs to. Proposal ids are global across
  // AAOs, so ask the proposal rather than the view -- a question filed while a
  // switch is still in flight must still land on the right organisation.
  function aaoOfProposal(proposalId) {
    var all = (lastData && lastData.allProposals) || (lastData && lastData.proposals) || [];
    var found = all.filter(function (p) { return Number(p.id) === Number(proposalId); })[0];
    return found ? found.aaoId : currentAaoId();
  }

  // --- the question channel (27.2) ---------------------------------------

  function questionsFor(proposalId) {
    return questions.filter(function (q) { return Number(q.proposal) === Number(proposalId); });
  }

  function answersTo(questionId) {
    return answers.filter(function (a) { return a.question === questionId; });
  }

  // "4 seconds" / "1 min 12 s" / "2 h 5 min", from the moment the question was
  // posted. Written out rather than as a raw count so it reads as a wait.
  function elapsedSince(record) {
    var raw = record.at || record.ts;
    var started = raw ? new Date(raw).getTime() : NaN;
    if (isNaN(started)) return "just now";
    var seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
    if (seconds < 60) return seconds + (seconds === 1 ? " second" : " seconds");
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + " min " + (seconds % 60) + " s";
    var hours = Math.floor(minutes / 60);
    return hours + " h " + (minutes % 60) + " min";
  }

  // Only the number moves, so tick it in place rather than redrawing the card --
  // a redraw every second would fight the Director's typing.
  function tickPending() {
    var nodes = document.querySelectorAll(".qa-pending .pending-seconds");
    if (!nodes.length) return;
    var open = [];
    questions.forEach(function (q) { if (!answersTo(q.id).length) open.push(q); });
    for (var i = 0; i < nodes.length && i < open.length; i++) {
      nodes[i].textContent = elapsedSince(open[i]);
    }
  }

  function timeOf(record) {
    var raw = record.at || record.ts;
    if (!raw) return "";
    var d = new Date(raw);
    return isNaN(d.getTime()) ? String(raw) : d.toLocaleTimeString();
  }

  function renderThread(p) {
    var wrap = el("section", "thread");
    var mine = questionsFor(p.id);
    var anyAnswered = mine.some(function (q) { return answersTo(q.id).length > 0; });

    var head = el("div", "thread-head");
    head.appendChild(el("h4", "thread-title", "Questions to Wren"));
    if (mine.length) {
      var answered = mine.filter(function (q) { return answersTo(q.id).length > 0; }).length;
      head.appendChild(el("span", "thread-count", mine.length + " asked · " + answered + " answered"));
    }
    wrap.appendChild(head);

    mine.forEach(function (q) { wrap.appendChild(renderQuestion(q)); });

    if (threadError) {
      wrap.appendChild(el("p", "thread-note", "The question channel is unavailable: " + threadError));
      return wrap;
    }

    wrap.appendChild(renderAskBox(p));
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
      // The Director must never mistake silence for absence. The line says the
      // question landed and counts the seconds, so the wait is a number rather
      // than a doubt.
      var pending = el("p", "qa-waiting qa-pending");
      pending.appendChild(el("span", "pending-dot", "●"));
      pending.appendChild(document.createTextNode(
        isRequest
          ? "Sent to the proposer. Awaiting a revised proposal — "
          : "Answer pending. Wren has it — "));
      pending.appendChild(el("b", "pending-seconds", elapsedSince(q)));
      item.appendChild(pending);
      return item;
    }

    replies.forEach(function (a) {
      var reply = el("div", "qa-reply");
      var rHead = el("div", "qa-head");
      rHead.appendChild(el("span", "qa-who qa-who-wren", P.label(a.from) + " answered"));
      rHead.appendChild(el("span", "qa-time", timeOf(a)));
      reply.appendChild(rHead);
      reply.appendChild(el("p", "qa-text", a.text || a.summary || ""));

      if (a.details && String(a.details).trim()) {
        var fold = el("details", "qa-details");
        fold.appendChild(el("summary", null, "Technical detail"));
        fold.appendChild(el("pre", "pre", a.details));
        reply.appendChild(fold);
      }
      if (Array.isArray(a.refs) && a.refs.length) {
        reply.appendChild(el("p", "qa-refs", "Refs: " + a.refs.join(" · ")));
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
    input.value = questionDrafts[p.id] || "";
    input.setAttribute("data-draft", String(p.id));
    input.disabled = Boolean(asking[p.id]);
    input.addEventListener("input", function () { questionDrafts[p.id] = input.value; });

    var button = el("button", "ask-send", asking[p.id] ? "sending…" : "Ask");
    button.type = "submit";
    button.disabled = Boolean(asking[p.id]);

    box.appendChild(input);
    box.appendChild(button);
    box.addEventListener("submit", function (event) {
      event.preventDefault();
      ask(p.id, questionDrafts[p.id] || input.value, "question");
    });
    return box;
  }

  function renderAfterAnswer(p) {
    var wrap = el("div", "after-answer");
    var level = p.forVotes === p.againstVotes;
    var open = p.status === 0;
    var st = stateFor(p.id);

    var tie = el("button", "close-tie", st.busy === "close-tie" ? "working…" : "Close as tie");
    tie.type = "button";
    tie.disabled = !open || !level || st.busy !== null;
    if (!tie.disabled) {
      tie.addEventListener("click", function () { executeProposal(p.id, "close-tie"); });
    }
    wrap.appendChild(tie);

    var again = el("button", "ask-new", asking[p.id] ? "sending…" : "Ask for a new proposal");
    again.type = "button";
    again.disabled = Boolean(asking[p.id]);
    if (!again.disabled) {
      again.addEventListener("click", function () {
        ask(p.id,
          questionDrafts[p.id] || "This proposal is not it. Please file a revised one that links this.",
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
        body: JSON.stringify({
          proposal: proposalId,
          aaoId: aaoOfProposal(proposalId),
          text: body,
          type: type
        })
      });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok || result.ok === false) {
        throw new Error((result.errors || ["HTTP " + response.status]).join("; "));
      }
      questionDrafts[proposalId] = "";
    } catch (e) {
      stateFor(proposalId).error = "Could not send the question: " + (e.message || e);
    } finally {
      asking[proposalId] = false;
    }
    await refreshThreads();
    render(lastData);
  }

  // --- proposal cards ----------------------------------------------------

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

  function renderProposal(p, aao, index) {
    var st = stateFor(p.id);
    var card = el("li", "proposal");
    card.id = "p-" + p.id;

    // The counter above the stage says where in the flow this is; the card says
    // which proposal it is, which is the number everyone quotes.
    var head = el("div", "proposal-head");
    head.appendChild(el("span", "pid", "#" + p.id));
    head.appendChild(el("span", "chip chip-" + p.statusLabel.toLowerCase(), p.statusLabel));
    var by = el("span", "by");
    by.appendChild(document.createTextNode("by "));
    by.appendChild(el("b", null, p.proposerLabel));
    by.appendChild(document.createTextNode(" · " + R.formatTime(p.createdAt)));
    head.appendChild(by);
    var fmt = p.format || R.parseProposalText(p.text);
    if (fmt.legacy) head.appendChild(el("span", "chip chip-legacy", "legacy format"));

    // 27.9: where it has got to, from Wren's latest decision.
    var adoption = adoptionFor(p);
    if (adoption) {
      var solved = A.solvedBy(adoption);
      head.appendChild(el("span", "chip chip-adopt chip-" + adoption.state.chip,
        solved ? "closed: solved by " + solved : adoption.state.label));
    }
    card.appendChild(head);

    card.appendChild(renderProposalBody(fmt, p.id));
    card.appendChild(renderAdoption(p, adoption));

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
        : st.outcome.passed ? "Executed on chain: passed." : "Executed on chain: rejected.";
      card.appendChild(el("p", "outcome", text + " Block " + st.outcome.blockNumber + "."));
    } else if (p.outcome !== null && p.status !== 0) {
      card.appendChild(el("p", "outcome",
        "Closed on chain: " + (p.outcome ? "passed" : "rejected") + "."));
    }

    if (st.error) card.appendChild(el("p", "err", st.error));

    card.appendChild(renderThread(p));

    return card;
  }

  // --- adoption and waiting (27.9, the Director's waiting ruling) ---------

  // What Wren last said about this proposal, and the two moves the Director has:
  // park it, or bring it back. Both are one click and both post a decision, so
  // the reason is on the record rather than in someone's memory.
  function renderAdoption(p, adoption) {
    var waiting = A.isWaiting(adoption);
    var wrap = el("section", "adoption" + (waiting ? " adoption-waiting" : ""));

    if (adoption) {
      var line = el("p", "adoption-line");
      line.appendChild(el("span", "adoption-state", adoption.state.label));
      line.appendChild(document.createTextNode(
        waiting ? A.waitingReason(adoption) : adoption.text));
      wrap.appendChild(line);

      if (adoption.message.details && String(adoption.message.details).trim()) {
        var fold = el("details", "proposal-details");
        fold.appendChild(el("summary", null, "What Wren did"));
        fold.appendChild(el("pre", "pre", adoption.message.details));
        wrap.appendChild(fold);
      }
      wrap.appendChild(el("p", "adoption-who",
        P.label(adoption.message.from) + " · " + timeOf(adoption.message)));
    }

    // 27.12(3): closed on the card is not the same as closed on the chain. Say
    // which is which, so nobody reads the chip as a chain state it is not.
    if (A.isClosedByBuild(adoption) && p.status === 0) {
      var cast = p.forVotes + p.againstVotes;
      wrap.appendChild(el("p", "adoption-chain",
        cast
          ? "Still Active on chain with " + p.forVotes + "–" + p.againstVotes +
            " cast. Execute settles it when you are ready."
          : "Still Active on chain, with no votes cast. Nothing needs executing: " +
            "the work is done and the card is closed."));
    }

    wrap.appendChild(renderWaitControls(p, waiting));
    return wrap;
  }

  function renderWaitControls(p, waiting) {
    var row = el("div", "wait-controls");
    var busy = waitBusy[p.id];

    if (waiting) {
      var back = el("button", "mini bring-back", busy ? "working…" : "Bring back");
      back.type = "button";
      back.disabled = Boolean(busy);
      if (!back.disabled) {
        back.addEventListener("click", function () {
          postWaitDecision(p, "back in the queue: brought back by the Director.");
        });
      }
      row.appendChild(back);
      row.appendChild(el("span", "wait-note",
        "Out of the main queue. It returns on its own if its trigger fires."));
      return row;
    }

    var input = el("input", "wait-input");
    input.type = "text";
    input.placeholder = "why it can wait…";
    input.value = waitDrafts[p.id] || "";
    input.setAttribute("data-draft", "wait:" + p.id);
    input.disabled = Boolean(busy);
    input.addEventListener("input", function () { waitDrafts[p.id] = input.value; });
    row.appendChild(input);

    var keep = el("button", "mini keep-waiting", busy ? "working…" : "Keep waiting");
    keep.type = "button";
    keep.disabled = Boolean(busy);
    if (!keep.disabled) {
      keep.addEventListener("click", function () {
        var words = String(waitDrafts[p.id] || "").trim();
        postWaitDecision(p, "waiting: " + (words || "parked by the Director, no reason given yet."));
      });
    }
    row.appendChild(keep);
    return row;
  }

  async function postWaitDecision(p, summary) {
    waitBusy[p.id] = true;
    render(lastData);
    try {
      var response = await window.fetch("/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "director",
          to: "wren",
          type: "decision",
          subject: "Proposal " + p.id + ": " + (/^waiting/i.test(summary) ? "waiting" : "back in the queue"),
          summary: summary,
          refs: ["proposal " + p.id],
          proposal: p.id,
          aaoId: p.aaoId
        })
      });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok || result.ok === false) {
        throw new Error((result.errors || ["HTTP " + response.status]).join("; "));
      }
      waitDrafts[p.id] = "";
    } catch (e) {
      stateFor(p.id).error = "Could not record that: " + (e.message || e);
    } finally {
      waitBusy[p.id] = false;
    }
    await refreshThreads();
    render(lastData);
  }

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

    var onChain = (p.votes || []).filter(function (v) { return R.sameAddress(v.voter, R.WREN); })[0];
    if (!onChain) {
      // The reason is on file but the chain has no VoteCast from Wren for this
      // proposal. That happens when a vote was refused -- an id that already
      // carried a stray vote, for instance. The reason still stands as Wren's
      // position; it just is not counted in the tally.
      block.appendChild(el("span", "wren-note wren-offchain",
        "not on chain — this is Wren's stated position, but no vote was recorded, " +
        "so it is not in the tally."));
    } else if (onChain.support !== support) {
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
    var rules = rulesForProposal(p);
    var casting = castingState(p);

    // The Director does not vote on every organisation. On the widget-builder
    // they watch: the builder and the widget vote, and Wren breaks a tie. The
    // rule lives in read.js, so the page and the scripts refuse the same things.
    var directorMayVote = R.mayVote(rules, R.DIRECTOR) &&
      R.sameAddress(rules.voters[0], R.DIRECTOR);
    var directorVoted = R.hasVoted(p, R.DIRECTOR);

    function button(className, label, key, disabled, onClick) {
      var b = el("button", className, st.busy === key ? "working…" : label);
      b.type = "button";
      b.disabled = disabled || busy;
      if (!b.disabled) b.addEventListener("click", onClick);
      return b;
    }

    if (directorMayVote) {
      wrap.appendChild(button("for", "Vote for", "for", !open || directorVoted, function () {
        castVote(p.id, true, R.DIRECTOR, "for");
      }));
      wrap.appendChild(button("against", "Vote against", "against", !open || directorVoted, function () {
        castVote(p.id, false, R.DIRECTOR, "against");
      }));
    }

    // The casting vote is the Director's only on the main organisation; on the
    // widget-builder it is Wren's, and Wren does not vote from this page.
    var castingIsDirectors = rules.casting && R.sameAddress(rules.casting, R.CASTING);
    if (castingIsDirectors) {
      wrap.appendChild(button("casting", "Casting vote: for", "casting-for", !casting.allowed, function () {
        castVote(p.id, true, rules.casting, "casting-for");
      }));
      wrap.appendChild(button("casting", "Casting vote: against", "casting-against", !casting.allowed, function () {
        castVote(p.id, false, rules.casting, "casting-against");
      }));
    }

    if (rules.autoExecute !== "automatic") {
      wrap.appendChild(button("execute", "Execute", "execute", !open, function () {
        executeProposal(p.id);
      }));
    }

    var hint = el("p", "hint");
    if (!open) {
      hint.textContent = "Closed — " + p.statusLabel.toLowerCase() + ".";
    } else if (rules.autoExecute === "automatic") {
      var auto = R.autoExecuteState(rules, p);
      var problem = R.voterProblem(rules, R.DIRECTOR);
      hint.textContent = (problem ? problem + " " : "") + auto.reason;
    } else if (casting.allowed) {
      hint.textContent = casting.reason;
    } else if (directorVoted) {
      hint.textContent = "You have voted. " + casting.reason;
    } else {
      hint.textContent =
        "Your vote settles it unless it ends level. " +
        "As it stands, executing would " + (R.predictedOutcome(p) ? "pass" : "reject") + " it.";
    }
    wrap.appendChild(hint);

    return wrap;
  }

  // --- the structure tree (27.3) -----------------------------------------

  // Every node carries its plain-English line. Branches open in place; the state
  // lives here, so a redraw does not collapse what the operator opened.
  function node(key, label, line, children, extraClass) {
    var wrap = el("div", "node" + (extraClass ? " " + extraClass : ""));
    var hasChildren = children && children.length;
    var row = el("div", "node-row");

    if (hasChildren) {
      var toggle = el("button", "node-toggle", treeOpen[key] ? "−" : "+");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", treeOpen[key] ? "true" : "false");
      toggle.addEventListener("click", function () {
        treeOpen[key] = !treeOpen[key];
        renderTree(lastData);
      });
      row.appendChild(toggle);
    } else {
      row.appendChild(el("span", "node-leaf", "·"));
    }

    row.appendChild(el("span", "node-label", label));
    if (line) row.appendChild(el("span", "node-line", line));
    wrap.appendChild(row);

    if (hasChildren && treeOpen[key]) {
      var kids = el("div", "node-children");
      children.forEach(function (child) { kids.appendChild(child); });
      wrap.appendChild(kids);
    }
    return wrap;
  }

  function renderTree(data) {
    var host = byId("tree");
    if (!host || !data) return;
    host.textContent = "";

    var aaoNodes = data.aaos.map(function (aao) {
      var proposals = (data.allProposals || []).filter(function (p) { return p.aaoId === aao.id; });

      var memberNodes = aao.members.map(function (m, i) {
        return node("m-" + aao.id + "-" + i, m.label, m.address + (m.isCreator ? " · creator" : ""));
      });

      var proposalNodes = proposals.map(function (p) {
        var voteNodes = p.votes.map(function (v, i) {
          var reason = wrenVotes[p.id] && R.sameAddress(v.voter, R.WREN)
            ? " — " + String(wrenVotes[p.id].reason || "").slice(0, 90)
            : "";
          return node("v-" + p.id + "-" + i, v.label + " voted " + (v.support ? "for" : "against"),
            "Block " + v.blockNumber + reason);
        });
        var qaNodes = [];
        questionsFor(p.id).forEach(function (q) {
          qaNodes.push(node("q-" + q.id, "Question", q.text || q.summary || ""));
          answersTo(q.id).forEach(function (a) {
            qaNodes.push(node("a-" + a.id, "Answer", a.text || a.summary || ""));
          });
        });
        var kids = [];
        if (voteNodes.length) kids.push(node("votes-" + p.id, "Votes", voteNodes.length + " cast", voteNodes));
        if (qaNodes.length) kids.push(node("qa-" + p.id, "Questions and answers", qaNodes.length + " entries", qaNodes));

        var n = node("p-" + p.id, "Proposal " + p.id + " · " + p.statusLabel,
          headline(p), kids);
        var jump = el("button", "node-jump", "open");
        jump.type = "button";
        jump.addEventListener("click", function () { goToProposal(aao.id, p.id); });
        n.querySelector(".node-row").appendChild(jump);
        return n;
      });

      return node("aao-" + aao.id, "AAO " + aao.id + " · " + aao.topic,
        aao.note || (aao.members.length + " members"),
        [
          node("members-" + aao.id, "Members", aao.members.length + " on the roll", memberNodes),
          node("proposals-" + aao.id, "Proposals", proposals.length + " filed", proposalNodes)
        ]);
    });

    var factoryLine = data.factories && data.factories.length
      ? data.factories.length + " approved to create organisations"
      : "None approved on this chain; organisations are created directly by the owner.";
    var factoryNodes = (data.factories || []).map(function (f, i) {
      return node("f-" + i, f.name || "Factory", f.address);
    });

    var root = node("root", "PeopleNet", "The network this page governs", [
      node("chain", "Local chain", "Hardhat node at " + R.RPC_URL + ", chain id " + R.CHAIN_ID, [
        node("diamond", "Diamond", R.DIAMOND + " — every facet behind one address", [
          node("factories", "Factories", factoryLine, factoryNodes)
        ].concat(aaoNodes))
      ])
    ]);

    host.appendChild(root);
  }

  // One at a time, so "go to" is not a scroll: it is a move of the cursor, and
  // it widens the filter when the wanted card is not under the current one --
  // silently showing nothing would be the worse answer.
  function goToProposal(aaoId, proposalId) {
    setView("governance");
    if (Number(aaoId) !== currentAaoId()) {
      selectAao(Number(aaoId));
      pendingJump = Number(proposalId);
      return;
    }
    showProposal(Number(proposalId));
  }

  function showProposal(proposalId) {
    var key = "p" + proposalId;
    if (!visibleCards(lastData).some(function (c) { return c.key === key; })) {
      filterKey = "all";
      store("governance.filter", filterKey);
    }
    cursorId = key;
    render(lastData);
    var card = byId("p-" + proposalId);
    if (!card) return;
    card.classList.add("is-target");
    window.setTimeout(function () { card.classList.remove("is-target"); }, 2400);
  }

  // Set when a jump has to wait for an organisation switch to land.
  var pendingJump = null;

  // --- global search (27.3) ----------------------------------------------

  // Everything the page knows, in one list: organisations, proposals, vote
  // reasons, questions, answers, agent messages. Results open in place.
  function searchIndex(data) {
    var rows = [];
    if (!data) return rows;

    data.aaos.forEach(function (aao) {
      rows.push({
        kind: "Organisation",
        where: "AAO " + aao.id,
        title: aao.topic,
        body: (aao.note || "") + " " + aao.members.map(function (m) { return m.label; }).join(" "),
        aaoId: aao.id,
        proposalId: null
      });
    });

    (data.allProposals || []).forEach(function (p) {
      var doc = p.format && p.format.doc;
      rows.push({
        kind: "Proposal",
        where: "AAO " + p.aaoId + " · #" + p.id,
        title: headline(p),
        body: doc
          ? [doc.summary, doc.why, doc.technical, doc.risk, doc.effort, (doc.refs || []).join(" ")].join(" ")
          : p.text,
        aaoId: p.aaoId,
        proposalId: p.id
      });
      var reason = wrenVotes[p.id];
      if (reason) {
        rows.push({
          kind: "Vote reason",
          where: "AAO " + p.aaoId + " · #" + p.id,
          title: "Wren voted " + (reason.support ? "for" : "against"),
          body: reason.reason || "",
          aaoId: p.aaoId,
          proposalId: p.id
        });
      }
    });

    questions.concat(answers).concat(messages).forEach(function (m) {
      rows.push({
        kind: P.typeLabel(m.type),
        where: m.proposal === undefined || m.proposal === null
          ? "AAO " + (m.aaoId || 0)
          : "AAO " + (m.aaoId || 0) + " · #" + m.proposal,
        title: m.subject || m.text || "",
        body: [m.summary, m.text, m.details, (m.refs || []).join(" ")].join(" "),
        aaoId: Number(m.aaoId || 0),
        proposalId: m.proposal === undefined || m.proposal === null ? null : Number(m.proposal)
      });
    });

    return rows;
  }

  function renderSearch(data) {
    var host = byId("search-results");
    if (!host) return;
    host.textContent = "";

    var q = searchQuery.trim().toLowerCase();
    if (!q) {
      var rows = searchIndex(data);
      host.appendChild(el("p", "block-note",
        rows.length + " records indexed: organisations, proposals, vote reasons, questions, answers and messages."));
      return;
    }

    var terms = q.split(/\s+/).filter(Boolean);
    var hits = searchIndex(data).filter(function (row) {
      var hay = (textOf(row.title) + " " + textOf(row.body) + " " + textOf(row.where) + " " + textOf(row.kind)).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) !== -1; });
    });

    if (!hits.length) {
      host.appendChild(el("p", "empty", "Nothing matches “" + searchQuery.trim() + "”."));
      return;
    }

    var list = el("ol", "hit-list");
    hits.slice(0, 120).forEach(function (row, i) {
      var li = el("li", "hit");
      var head = el("div", "hit-head");
      head.appendChild(el("span", "num", "3.1." + (i + 1)));
      head.appendChild(el("span", "hit-kind", row.kind));
      head.appendChild(el("span", "hit-where", row.where));
      li.appendChild(head);
      li.appendChild(el("p", "hit-title", row.title));
      var excerpt = makeExcerpt(row.body, terms[0]);
      if (excerpt) li.appendChild(el("p", "hit-body", excerpt));
      if (row.proposalId !== null) {
        var open = el("button", "hit-open", "Open proposal " + row.proposalId);
        open.type = "button";
        open.addEventListener("click", function () { goToProposal(row.aaoId, row.proposalId); });
        li.appendChild(open);
      } else {
        var openAao = el("button", "hit-open", "Open organisation");
        openAao.type = "button";
        openAao.addEventListener("click", function () { setView("governance"); selectAao(row.aaoId); });
        li.appendChild(openAao);
      }
      list.appendChild(li);
    });
    host.appendChild(list);
    if (hits.length > 120) {
      host.appendChild(el("p", "block-note", hits.length - 120 + " more matches not shown; narrow the search."));
    }
  }

  function makeExcerpt(body, term) {
    var text = textOf(body).replace(/\s+/g, " ").trim();
    if (!text) return "";
    var at = term ? text.toLowerCase().indexOf(term) : 0;
    if (at < 0) at = 0;
    var start = Math.max(0, at - 60);
    var slice = text.slice(start, start + 220);
    return (start ? "…" : "") + slice + (start + 220 < text.length ? "…" : "");
  }

  // --- notifications (27.7) ----------------------------------------------

  // Seen-sets, so the page does not re-announce what it announced before a
  // redraw. Seeded on the first read: the operator is not told about history.
  var seen = { proposals: null, answers: null, ties: null, decisions: null, triggers: null };
  var notifyAsked = remember("governance.notifyAsked", "0") === "1";

  function notificationsAllowed() {
    return typeof window.Notification === "function" && window.Notification.permission === "granted";
  }

  function renderNotifyToggle() {
    var button = byId("notify-toggle");
    if (!button) return;
    if (typeof window.Notification !== "function") { button.hidden = true; return; }
    if (window.Notification.permission === "granted") {
      button.hidden = true;
      return;
    }
    if (window.Notification.permission === "denied" || notifyAsked) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
  }

  function askForNotifications() {
    if (typeof window.Notification !== "function") return;
    notifyAsked = true;
    store("governance.notifyAsked", "1");
    window.Notification.requestPermission().then(function () { renderNotifyToggle(); });
  }

  function notify(title, body, aaoId, proposalId) {
    if (!notificationsAllowed()) return;
    try {
      var n = new window.Notification(title, { body: body, tag: "gov-" + aaoId + "-" + proposalId });
      n.onclick = function () {
        window.focus();
        goToProposal(aaoId, proposalId);
        n.close();
      };
    } catch (e) { /* a notification is never worth an exception */ }
  }

  // The four moments 27.7 names, each naming the proposal and deep-linking to it.
  function checkNotifications(data) {
    if (!data) return;

    var proposalIds = (data.allProposals || []).map(function (p) { return p.aaoId + ":" + p.id; });
    if (seen.proposals === null) {
      seen.proposals = new Set(proposalIds);
    } else {
      (data.allProposals || []).forEach(function (p) {
        var key = p.aaoId + ":" + p.id;
        if (seen.proposals.has(key)) return;
        seen.proposals.add(key);
        notify("New proposal " + p.id,
          headline(p) + " — filed by " + p.proposerLabel + ".", p.aaoId, p.id);
      });
    }

    var answerIds = answers.map(function (a) { return a.id; });
    if (seen.answers === null) {
      seen.answers = new Set(answerIds);
    } else {
      answers.forEach(function (a) {
        if (seen.answers.has(a.id)) return;
        seen.answers.add(a.id);
        var asked = questions.filter(function (q) { return q.id === a.question; })[0];
        if (!asked || asked.from !== "director") return;
        notify("Wren answered on proposal " + a.proposal,
          textOf(a.text || a.summary).slice(0, 180),
          Number(a.aaoId || 0), Number(a.proposal));
      });
    }

    var tied = (data.allProposals || []).filter(function (p) {
      return castingState(p).allowed;
    }).map(function (p) { return p.aaoId + ":" + p.id; });
    if (seen.ties === null) {
      seen.ties = new Set(tied);
    } else {
      (data.allProposals || []).forEach(function (p) {
        var key = p.aaoId + ":" + p.id;
        if (!castingState(p).allowed) { seen.ties.delete(key); return; }
        if (seen.ties.has(key)) return;
        seen.ties.add(key);
        notify("Tie on proposal " + p.id + ", awaiting your casting vote",
          headline(p) + " — level at " + p.forVotes + "–" + p.againstVotes + ".",
          p.aaoId, p.id);
      });
    }

    // A trigger that fired is the page telling the Director that the thing they
    // were waiting for happened. It is the most time-sensitive of the four.
    var watchIds = messages.filter(function (m) { return m && m.from === "watch"; })
      .map(function (m) { return m.id; });
    if (seen.triggers === null || seen.triggers === undefined) {
      seen.triggers = new Set(watchIds);
    } else {
      messages.filter(function (m) { return m && m.from === "watch"; }).forEach(function (m) {
        if (seen.triggers.has(m.id)) return;
        seen.triggers.add(m.id);
        if (m.proposal === undefined || m.proposal === null) return;
        notify("Proposal " + m.proposal + ": what you were waiting for happened",
          textOf(m.summary).slice(0, 180), Number(m.aaoId || 0), Number(m.proposal));
      });
    }

    // A passed proposal the builder has picked up arrives as a decision message.
    var decisions = messages.filter(function (m) { return m.type === "decision"; });
    var decisionIds = decisions.map(function (m) { return m.id; });
    if (seen.decisions === null) {
      seen.decisions = new Set(decisionIds);
    } else {
      decisions.forEach(function (m) {
        if (seen.decisions.has(m.id)) return;
        seen.decisions.add(m.id);
        if (m.proposal === undefined || m.proposal === null) return;
        notify("Proposal " + m.proposal + " picked up by " + P.label(m.from),
          textOf(m.summary || m.subject).slice(0, 180),
          Number(m.aaoId || 0), Number(m.proposal));
      });
    }
  }

  // --- views -------------------------------------------------------------

  function setView(name) {
    view = name;
    store("governance.view", name);
    ["governance", "structure", "search"].forEach(function (v) {
      byId("view-" + v).hidden = v !== name;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".view-tab"), function (tab) {
      tab.classList.toggle("is-current", tab.getAttribute("data-view") === name);
    });
    if (name === "structure") renderTree(lastData);
    if (name === "search") renderSearch(lastData);
  }

  // --- rendering ---------------------------------------------------------

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

  // --- one at a time (27.11) ---------------------------------------------

  // The filters, in the order 27.11 names them. Each is a plain predicate, so
  // the counts on the chips and the list under the pager come from one place.
  var FILTERS = [
    {
      key: "mine", label: "Open for my vote",
      // Waiting proposals are out of this queue and out of its count: the
      // Director parked them, and a parked proposal is not work in front of them.
      // A fired trigger overrides that -- something changed, so it is back.
      test: function (p) {
        if (p.status !== 0 || closedByBuild(p)) return false;
        if (isWaiting(p) && !pinnedFirst(p)) return false;
        return !R.hasVoted(p, R.DIRECTOR);
      }
    },
    {
      key: "waiting", label: "Waiting",
      test: function (p) { return isWaiting(p); }
    },
    {
      key: "tied", label: "Tied",
      test: function (p) { return castingState(p).allowed; }
    },
    {
      key: "executed", label: "Executed",
      test: function (p) { return p.status === 1; }
    },
    {
      key: "rejected", label: "Rejected",
      test: function (p) { return p.status === 2; }
    },
    {
      key: "closed", label: "Closed by a build",
      test: function (p) { return Boolean(closedByBuild(p)); }
    },
    { key: "all", label: "All", test: function () { return true; } }
  ];

  function filterByKey(key) {
    return FILTERS.filter(function (f) { return f.key === key; })[0] || FILTERS[0];
  }

  // What the flow is showing right now: this organisation's proposals and drafts
  // through the current filter, pinned ones first.
  // The Director's drafts that Wren has not filed yet, for this organisation.
  // They are the Director's own words, and they belong at the front of the flow:
  // an unfiled draft is the one thing the Director cannot act on themselves.
  function openDrafts(aaoId) {
    var filed = {};
    drafts.forEach(function (r) {
      if (r.draft && (r.state === "filed" || r.proposalId !== undefined)) filed[r.draft] = r;
    });
    return drafts
      .filter(function (r) {
        if (r.text === undefined || r.state === "filed") return false;
        if (filed[r.id]) return false;
        var on = r.aaoId === undefined || r.aaoId === null ? R.AAO_ID : Number(r.aaoId);
        return on === Number(aaoId);
      })
      .sort(function (a, b) { return String(a.at) < String(b.at) ? -1 : 1; });
  }

  function visibleCards(data) {
    if (!data) return [];
    var f = filterByKey(filterKey);
    var cards = data.proposals.filter(f.test).map(function (p) {
      return { kind: "proposal", id: p.id, key: "p" + p.id, proposal: p };
    });
    cards.sort(function (a, b) {
      var pinned = (pinnedFirst(b.proposal) ? 1 : 0) - (pinnedFirst(a.proposal) ? 1 : 0);
      return pinned !== 0 ? pinned : a.id - b.id;
    });

    // A draft is not on the chain and has no status, so it shows under the
    // filters that mean "still open to me", and under all.
    if (f.key === "mine" || f.key === "all") {
      var draftCards = openDrafts(data.aao.id).map(function (d) {
        return { kind: "draft", id: -1, key: "d" + d.id, draft: d };
      });
      cards = draftCards.concat(cards);
    }
    return cards;
  }

  // The casting-vote rule of whichever organisation the proposal is on.
  function rulesForProposal(p) {
    var aao = lastData && (lastData.aaos || []).filter(function (a) { return a.id === p.aaoId; })[0];
    // The rules in force, not the ones written down: the widget-builder runs an
    // interim regime until the widget can vote, and the chain says when it ends.
    var onThatAao = ((lastData && lastData.allProposals) || [])
      .filter(function (x) { return x.aaoId === p.aaoId; });
    return R.effectiveRules(aao || (lastData && lastData.aao), onThatAao);
  }

  function castingState(p) {
    return R.castingStateUnder(rulesForProposal(p), p);
  }

  function adoptionFor(p) {
    return p ? A.adoptionOf(adoptions, p.id) : null;
  }

  // 27.12(3): a decision that says another item solved this one.
  function closedByBuild(p) {
    var a = adoptionFor(p);
    return A.isClosedByBuild(a) ? a : null;
  }

  // A waiting proposal is out of the main queue until its trigger fires or the
  // Director brings it back. It is not closed and not decided -- it is parked.
  function isWaiting(p) {
    return A.isWaiting(adoptionFor(p));
  }

  // 27.12(2): a trigger that fired posts a status message from "watch". Until
  // the Director opens that card it sits at the front of the flow -- the whole
  // point of a trigger is that the thing you were waiting for happened.
  function firedTrigger(p) {
    if (!p) return null;
    return messages.filter(function (m) {
      return m && m.from === "watch" && Number(m.proposal) === Number(p.id);
    }).slice(-1)[0] || null;
  }

  function pinnedFirst(p) {
    var fired = firedTrigger(p);
    if (!fired) return false;
    return !openedSinceTrigger[fired.id];
  }

  // Opened cards stop being pinned, so the flow settles back to its own order.
  var openedSinceTrigger = {};

  function cursorIndex(cards) {
    if (!cards.length) return -1;
    if (cursorId === null) return 0;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].key === cursorId) return i;
    }
    return 0;   // the card fell out of the filter; start again at the front
  }

  function renderFilters(data) {
    var host = byId("filters");
    host.textContent = "";
    FILTERS.forEach(function (f) {
      var n = data ? data.proposals.filter(f.test).length : 0;
      var chip = el("button", "filter-chip" + (f.key === filterKey ? " is-current" : ""));
      chip.type = "button";
      chip.appendChild(document.createTextNode(f.label));
      chip.appendChild(el("span", "filter-n", n));
      chip.addEventListener("click", function () { setFilter(f.key); });
      host.appendChild(chip);
    });
  }

  function setFilter(key) {
    filterKey = key;
    cursorId = null;
    store("governance.filter", key);
    render(lastData);
  }

  function step(delta) {
    var cards = visibleCards(lastData);
    var at = cursorIndex(cards);
    if (at < 0) return;
    var next = at + delta;
    if (next < 0 || next >= cards.length) return;
    cursorId = cards[next].key;
    render(lastData);
  }

  function renderPager(cards, at) {
    // The card says what it is: a draft is not a proposal yet.
    var noun = at >= 0 && cards[at] && cards[at].kind === "draft" ? "draft" : "proposal";
    byId("counter").textContent = cards.length
      ? noun + " " + (at + 1) + " of " + cards.length
      : "nothing to show";
    byId("prev").disabled = at <= 0;
    byId("next").disabled = at < 0 || at >= cards.length - 1;
  }

  function renderStage(data) {
    var host = byId("stage");
    host.textContent = "";

    var cards = visibleCards(data);
    var at = cursorIndex(cards);
    renderPager(cards, at);

    if (!cards.length) {
      var f = filterByKey(filterKey);
      var empty = el("div", "stage-empty");
      empty.appendChild(document.createTextNode("Nothing under "));
      empty.appendChild(el("b", null, f.label.toLowerCase()));
      empty.appendChild(document.createTextNode(
        data && data.proposals.length
          ? ". " + data.proposals.length + " proposals on this organisation — try another filter."
          : ". No proposals on this organisation yet."
      ));
      host.appendChild(empty);
      return;
    }

    var card = cards[at];
    cursorId = card.key;
    if (card.kind === "proposal") {
      var fired = firedTrigger(card.proposal);
      if (fired) openedSinceTrigger[fired.id] = true;
    }
    host.appendChild(card.kind === "draft"
      ? renderDraft(card.draft)
      : renderProposal(card.proposal, data.aao, at));
  }

  // A draft is the Director's own words waiting on Wren. It gets a card in the
  // flow so it cannot be forgotten, and it carries no vote buttons: there is
  // nothing on the chain to vote on yet.
  function renderDraft(d) {
    var card = el("article", "proposal proposal-draft");
    card.id = "d-" + d.id;

    var head = el("div", "proposal-head");
    head.appendChild(el("span", "pid", d.id));
    head.appendChild(el("span", "chip chip-draft", "draft, awaiting Wren"));
    var by = el("span", "by");
    by.appendChild(document.createTextNode("by "));
    by.appendChild(el("b", null, "Director"));
    by.appendChild(document.createTextNode(" · " + R.formatTime(Math.floor(new Date(d.at).getTime() / 1000))));
    head.appendChild(by);
    card.appendChild(head);

    var body = el("div", "proposal-body");
    body.appendChild(el("p", "proposal-summary pre-wrap", d.text));
    card.appendChild(body);

    card.appendChild(el("p", "draft-note",
      "Wren turns this into a proposal and files it on the chain, keeping these words as the " +
      "summary's first sentence. Until then there is nothing to vote on."));

    var how = el("details", "proposal-details");
    how.appendChild(el("summary", null, "How it gets filed"));
    how.appendChild(el("p", "detail-technical",
      "node scripts/wren-file-draft.js " + d.id + " --title \"...\" --why \"...\""));
    card.appendChild(how);

    return card;
  }

  function render(data) {
    if (!data) return;
    var mark = captureFocus();
    var scrolled = byId("stage").scrollTop;
    lastData = data;

    renderHeader(data);
    renderAaoTabs(data);
    renderOrganisation(data);
    renderStream(data);
    renderFilters(data);

    var filing = byId("file-proposal");
    filing.textContent = "";
    filing.appendChild(renderNewProposalForm(data));

    renderStage(data);

    if (view === "structure") renderTree(data);
    if (view === "search") renderSearch(data);

    byId("stage").scrollTop = scrolled;
    restoreFocus(mark);
  }

  // --- refresh loop ------------------------------------------------------

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

  async function fetchJson(path) {
    var response = await window.fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(path + " returned HTTP " + response.status);
    var body = await response.json();
    if (!Array.isArray(body)) throw new Error(path + " did not return a JSON array");
    return body;
  }

  // Returns true when something actually changed, so the two-second poll only
  // redraws when there is news and cannot fight the Director's typing.
  async function refreshThreads() {
    if (typeof window.fetch !== "function") {
      threadError = "this browser has no fetch";
      return false;
    }
    var before = signature();
    try {
      var all = await Promise.all([
        fetchJson("/questions.json"),
        fetchJson("/answers.json"),
        fetchJson("/messages.json"),
        fetchJson("/drafts.json")
      ]);
      questions = all[0];
      answers = all[1];
      messages = all[2];
      drafts = all[3];
      adoptions = A.indexDecisions(messages);
      threadError = null;
    } catch (e) {
      questions = [];
      answers = [];
      messages = [];
      drafts = [];
      adoptions = {};
      threadError = e && e.message ? e.message : String(e);
    }
    // The translations are read the same way and are just as non-fatal: without
    // them the legacy proposals show the chain's own words, which is honest.
    try {
      var response = await window.fetch("/translations.json", { cache: "no-store" });
      var body = response.ok ? await response.json() : {};
      translations = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    } catch (e) {
      translations = {};
    }
    return before !== signature();
  }

  function signature() {
    return questions.length + ":" + answers.length + ":" + messages.length +
      ":" + drafts.length + ":" + Object.keys(translations).length + ":" + (threadError || "");
  }

  // A refresh asked for while one is in flight must not be dropped: dropping it
  // is how an organisation switch silently fails to happen. Coalesce instead --
  // remember that another was wanted and run exactly one more when this ends.
  var refreshAgain = false;

  async function refresh() {
    if (rendering) { refreshAgain = true; return; }
    rendering = true;
    try {
      await refreshWrenVotes();
      await refreshThreads();
      var data = await R.readGovernance(ethers, provider, { aaoId: selectedAaoId });
      data.allProposals = await R.readAllProposals(readContract, data.aaos);
      data.factories = [];
      setConnection("ok", "chain " + R.CHAIN_ID);
      render(data);
      checkNotifications(data);
      if (pendingJump !== null) {
        var wanted = pendingJump;
        pendingJump = null;
        showProposal(wanted);
      }
    } catch (e) {
      setConnection("err", "no chain at " + R.RPC_URL);
      console.error(e);
    } finally {
      rendering = false;
    }
    if (refreshAgain) {
      refreshAgain = false;
      await refresh();
    }
  }

  async function pollThreads() {
    if (rendering) return;
    var changed = await refreshThreads();
    if (!changed) return;
    render(lastData);
    checkNotifications(lastData);
  }

  // --- wiring ------------------------------------------------------------

  Array.prototype.forEach.call(document.querySelectorAll(".view-tab"), function (tab) {
    tab.addEventListener("click", function () { setView(tab.getAttribute("data-view")); });
  });
  setView(view);

  byId("prev").addEventListener("click", function () { step(-1); });
  byId("next").addEventListener("click", function () { step(1); });

  // The jump box takes a proposal number and goes to it, whatever the filter is.
  var jumpInput = byId("jump-input");
  byId("jump-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var wanted = Number(String(jumpInput.value).replace(/[^0-9]/g, ""));
    if (!Number.isInteger(wanted)) return;
    jumpInput.value = "";
    goToProposal(aaoOfProposal(wanted), wanted);
  });

  // Left and right move through the flow, when the Director is not typing.
  document.addEventListener("keydown", function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (view !== "governance") return;
    if (event.key === "ArrowLeft") { step(-1); event.preventDefault(); }
    if (event.key === "ArrowRight") { step(1); event.preventDefault(); }
  });

  var searchInput = byId("search-input");
  byId("search-form").addEventListener("submit", function (e) { e.preventDefault(); });
  searchInput.addEventListener("input", function () {
    searchQuery = searchInput.value;
    renderSearch(lastData);
  });

  byId("notify-toggle").addEventListener("click", askForNotifications);
  renderNotifyToggle();

  // A link straight to a card, from a notification or a pasted URL.
  window.addEventListener("hashchange", function () {
    var m = /^#p-(\d+)$/.exec(window.location.hash);
    if (m) showProposal(Number(m[1]));
  });

  refresh().then(function () {
    var m = /^#p-(\d+)$/.exec(window.location.hash);
    if (m) showProposal(Number(m[1]));
  });

  provider.on("block", function () { refresh(); });
  setInterval(refresh, 8000);
  // The question channel is the impatient one: two seconds, so the only delay
  // the Director feels between asking and reading the answer is Wren's own.
  setInterval(pollThreads, 2000);
  // The pending counter ticks on its own second, without a redraw.
  setInterval(tickPending, 1000);

  // Debugging handle: the live provider and contract, plus the render path, so
  // the page can be driven from a console or a CDP session.
  window.__governance = {
    provider: provider,
    contract: readContract,
    refresh: refresh,
    render: render,
    data: function () { return lastData; },
    wrenVotes: function () { return wrenVotes; },
    threads: function () { return { questions: questions, answers: answers, messages: messages, drafts: drafts, error: threadError }; },
    adoptions: function () { return adoptions; },
    refreshThreads: refreshThreads,
    ask: ask,
    setView: setView,
    selectAao: selectAao,
    search: function (q) { searchQuery = q; byId("search-input").value = q; renderSearch(lastData); },
    tree: function () { return treeOpen; },
    goToProposal: goToProposal,
    showProposal: showProposal,
    setFilter: setFilter,
    step: step,
    cards: function () { return visibleCards(lastData); },
    filterKey: function () { return filterKey; },
    translations: function () { return translations; }
  };
})();
