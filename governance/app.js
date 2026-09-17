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

  var drafts = {};
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
        blockNumber: receipt.blockNumber
      };
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

  // --- filing a proposal from the page (27.6a) ---------------------------

  // The container in the organisation bar is already the one click, so this
  // returns the form itself -- a fold inside a fold is not allowed (27.6a).
  function renderNewProposalForm(data) {
    var form = el("form", "np-form");
    var fields = [
      ["title", "Title", "One line.", false, true],
      ["summary", "Summary", "Two to four sentences, plain English, for a person.", true, true],
      ["why", "Why", "The reason, in plain English.", true, true],
      ["technical", "Technical", "The details. Free form, kept whole.", true, false],
      ["risk", "Risk", "One line.", false, false],
      ["effort", "Effort", "One line.", false, false],
      ["refs", "Refs", "Tickets, commits, incidents, spec entries. One per line.", true, false]
    ];

    fields.forEach(function (spec) {
      var name = spec[0], label = spec[1], hint = spec[2], multiline = spec[3], required = spec[4];
      var row = el("label", "np-row");
      var head = el("span", "np-label", label);
      if (required) head.appendChild(el("span", "np-required", "required"));
      row.appendChild(head);
      var input = el(multiline ? "textarea" : "input", "np-input");
      if (!multiline) input.type = "text";
      if (multiline) input.rows = name === "technical" ? 4 : 2;
      input.name = name;
      input.placeholder = hint;
      input.setAttribute("data-draft", "np:" + name);
      input.value = newProposal[name] || "";
      input.addEventListener("input", function () { newProposal[name] = input.value; });
      row.appendChild(input);
      form.appendChild(row);
    });

    var actions = el("div", "np-actions");
    var submit = el("button", "np-send", newProposal.busy ? "filing…" : "File proposal");
    submit.type = "submit";
    submit.disabled = newProposal.busy;
    actions.appendChild(submit);
    actions.appendChild(el("span", "np-note",
      "Filed on " + data.aao.topic + " from the Director's account."));
    form.appendChild(actions);

    if (newProposal.error) form.appendChild(el("p", "err", newProposal.error));
    if (newProposal.filed) {
      form.appendChild(el("p", "np-filed",
        "Filed as proposal " + newProposal.filed.id + " in block " + newProposal.filed.blockNumber + "."));
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      fileProposal();
    });

    return form;
  }

  function draftDocument() {
    var doc = {
      title: (newProposal.title || "").trim(),
      summary: (newProposal.summary || "").trim(),
      why: (newProposal.why || "").trim(),
      technical: (newProposal.technical || "").trim(),
      risk: (newProposal.risk || "").trim(),
      effort: (newProposal.effort || "").trim(),
      refs: String(newProposal.refs || "").split(/\r?\n/)
        .map(function (r) { return r.trim(); }).filter(Boolean),
      from: "director",
      filed_at: new Date().toISOString()
    };
    Object.keys(doc).forEach(function (k) {
      if (doc[k] === "" || (Array.isArray(doc[k]) && !doc[k].length)) delete doc[k];
    });
    return doc;
  }

  // The same validation the scripts use -- one rule, not two.
  async function fileProposal() {
    var doc = draftDocument();
    var result = R.validateProposalDoc(doc);
    if (!result.ok) {
      newProposal.error = "Not ready to file: " + result.errors.join("; ");
      newProposal.filed = null;
      render(lastData);
      return;
    }

    newProposal.busy = true;
    newProposal.error = null;
    newProposal.filed = null;
    render(lastData);

    try {
      var signer = await signerFor(R.DIRECTOR);
      var contract = R.getContract(ethers, signer);
      // The organisation the Director chose, not the one last painted: a switch
      // still in flight must not misfile the proposal.
      var tx = await contract.submitProposal(selectedAaoId, JSON.stringify(doc));
      var receipt = await tx.wait();
      var id = null;
      for (var i = 0; i < receipt.logs.length; i++) {
        try {
          var parsed = contract.interface.parseLog(receipt.logs[i]);
          if (parsed && parsed.name === "ProposalSubmitted") id = Number(parsed.args.proposalId);
        } catch (e) { /* a log from another facet */ }
      }
      newProposal.filed = { id: id === null ? "?" : id, blockNumber: receipt.blockNumber };
      ["title", "summary", "why", "technical", "risk", "effort", "refs"].forEach(function (f) {
        newProposal[f] = "";
      });
    } catch (e) {
      newProposal.error = readableError(e);
    } finally {
      newProposal.busy = false;
    }
    await refresh();
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
      item.appendChild(el("p", "qa-waiting",
        isRequest ? "Sent to the proposer. Awaiting a revised proposal." : "Waiting for Wren…"));
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
      drafts[proposalId] = "";
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
    card.appendChild(head);

    card.appendChild(renderProposalBody(fmt, p.id));

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
      b.type = "button";
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
  var seen = { proposals: null, answers: null, ties: null, decisions: null };
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
      return R.castingVoteState(p).allowed;
    }).map(function (p) { return p.aaoId + ":" + p.id; });
    if (seen.ties === null) {
      seen.ties = new Set(tied);
    } else {
      (data.allProposals || []).forEach(function (p) {
        var key = p.aaoId + ":" + p.id;
        if (!R.castingVoteState(p).allowed) { seen.ties.delete(key); return; }
        if (seen.ties.has(key)) return;
        seen.ties.add(key);
        notify("Tie on proposal " + p.id + ", awaiting your casting vote",
          headline(p) + " — level at " + p.forVotes + "–" + p.againstVotes + ".",
          p.aaoId, p.id);
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
      test: function (p) { return p.status === 0 && !closedByBuild(p) && !R.hasVoted(p, R.DIRECTOR); }
    },
    {
      key: "tied", label: "Tied",
      test: function (p) { return R.castingVoteState(p).allowed; }
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
  function visibleCards(data) {
    if (!data) return [];
    var test = filterByKey(filterKey).test;
    var cards = data.proposals.filter(test).map(function (p) {
      return { kind: "proposal", id: p.id, key: "p" + p.id, proposal: p };
    });
    return cards.sort(function (a, b) {
      var pinned = (pinnedFirst(b) ? 1 : 0) - (pinnedFirst(a) ? 1 : 0);
      return pinned !== 0 ? pinned : a.id - b.id;
    });
  }

  // Filled in by 27.12: a trigger that fired pins its proposal to the front.
  function pinnedFirst() { return false; }

  // Filled in by 27.12(3): a decision message that closes the card.
  function closedByBuild() { return null; }

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
    byId("counter").textContent = cards.length
      ? "proposal " + (at + 1) + " of " + cards.length
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
    host.appendChild(renderProposal(card.proposal, data.aao, at));
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
        fetchJson("/messages.json")
      ]);
      questions = all[0];
      answers = all[1];
      messages = all[2];
      threadError = null;
    } catch (e) {
      questions = [];
      answers = [];
      messages = [];
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
      ":" + Object.keys(translations).length + ":" + (threadError || "");
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

  // Debugging handle: the live provider and contract, plus the render path, so
  // the page can be driven from a console or a CDP session.
  window.__governance = {
    provider: provider,
    contract: readContract,
    refresh: refresh,
    render: render,
    data: function () { return lastData; },
    wrenVotes: function () { return wrenVotes; },
    threads: function () { return { questions: questions, answers: answers, messages: messages, error: threadError }; },
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
