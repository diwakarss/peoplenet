// governance/swarm.js -- what the swarm dashboard shows, with no browser in it.
//
// Proposal 59. The chain page is for deciding; this answers the Director's
// other question: what is stuck, what is being built, what is done, and what
// each agent is doing right now.
//
// Every shaping decision lives here so it can be tested without a browser, the
// way read.js is. swarm/app.js renders what this returns and does nothing else.
// Nothing here writes: it takes the messages and the proposals it is handed.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./adoption.js"), require("./read.js"));
  } else {
    root.GovernanceSwarm = factory(root.GovernanceAdoption, root.GovernanceRead);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (A, R) {
  "use strict";

  // A human block is filed as its own proposal on JD, titled like this, and it
  // clears when the Director's vote executes it (Kural's answer to the Director
  // on 59). The dashboard reads it straight off the chain: no message needed,
  // because the proposal IS the record.
  var HUMAN_BLOCK_TITLE = /^\s*blocked on the director\b/i;

  // Silent for longer than this and the agent is greyed. An agent working on
  // one thing for an hour without a word is not reporting; it is missing.
  var SILENT_MS = 60 * 60 * 1000;

  // The Director is not an agent. He is who the dashboard is for.
  var NOT_AN_AGENT = ["director", "casting"];

  function textOf(v) {
    return String(v === undefined || v === null ? "" : v);
  }

  function titleOf(proposal) {
    var p = proposal || {};
    if (p.format && p.format.doc && p.format.doc.title) return textOf(p.format.doc.title);
    try {
      var doc = JSON.parse(textOf(p.text));
      if (doc && doc.title) return textOf(doc.title);
    } catch (e) { /* a proposal filed before 27.1 is free text */ }
    return textOf(p.text).split(/\r?\n/)[0].slice(0, 120);
  }

  function isDirector(who) {
    return /\bdirector\b/i.test(textOf(who));
  }

  function timeOf(value) {
    var t = Date.parse(textOf(value));
    return isNaN(t) ? null : t;
  }

  // --- the three columns --------------------------------------------------

  // `decisions` is the raw message log; `proposals` is every proposal on every
  // organisation, as read.js returns them; `aaos` names the organisations.
  function columns(messages, proposals, aaos) {
    var byId = {};
    (proposals || []).forEach(function (p) { byId[p.id] = p; });
    var orgOf = {};
    (aaos || []).forEach(function (a) { orgOf[a.id] = a.topic; });

    var latest = A.indexDecisions(messages || []);
    var blocked = [];
    var building = [];
    var done = [];

    Object.keys(latest).forEach(function (id) {
      var adoption = A.adoptionOf(latest, id);
      var proposal = byId[Number(id)] || {};
      var row = {
        proposalId: Number(id),
        aaoId: proposal.aaoId === undefined ? null : proposal.aaoId,
        organisation: orgOf[proposal.aaoId] || "",
        title: titleOf(proposal) || adoption.message.subject || ("Proposal " + id),
        state: adoption.state.key,
        said: adoption.text,
        at: adoption.message.ts || null,
        source: "decision",
        who: "",
        what: ""
      };
      if (adoption.state.key === "blocked") {
        var on = A.blockedOn(adoption) || { who: "", what: "" };
        row.who = on.who;
        row.what = on.what;
        row.directors = isDirector(on.who);
        blocked.push(row);
      } else if (adoption.state.key === "building") {
        building.push(row);
      } else if (["built", "in-widget", "closed"].indexOf(adoption.state.key) !== -1) {
        done.push(row);
      }
    });

    // The Director's own blocks: filed as proposals, open until his vote
    // executes them. An executed one has cleared, so it is not a block any more.
    (proposals || []).forEach(function (p) {
      if (p.status !== 0) return;
      var title = titleOf(p);
      if (!HUMAN_BLOCK_TITLE.test(title)) return;
      blocked.push({
        proposalId: p.id,
        aaoId: p.aaoId,
        organisation: orgOf[p.aaoId] || "",
        title: title,
        state: "blocked",
        said: title,
        at: p.createdAt ? new Date(p.createdAt * 1000).toISOString() : null,
        source: "proposal",
        who: "the Director",
        what: title.replace(HUMAN_BLOCK_TITLE, "").replace(/^\s*:\s*/, "").trim(),
        directors: true
      });
    });

    return {
      blocked: sortBlocked(blocked),
      building: byProposal(building),
      done: byProposal(done)
    };
  }

  // The Director's own first: the top of the page is what only he can clear.
  // Then by proposal id, so the order does not shuffle between reloads.
  function sortBlocked(rows) {
    return rows.slice().sort(function (a, b) {
      if (Boolean(a.directors) !== Boolean(b.directors)) return a.directors ? -1 : 1;
      return a.proposalId - b.proposalId;
    });
  }

  function byProposal(rows) {
    return rows.slice().sort(function (a, b) { return b.proposalId - a.proposalId; });
  }

  // --- the street ---------------------------------------------------------

  // Which organisation an agent belongs to: the one whose rule set names it the
  // architect, or failing that the first that lets it vote. Read off the rule
  // sets rather than off membership, because membership does not say what an
  // agent is there to do.
  function organisationOf(address) {
    var topics = Object.keys(R.AAO_RULES);
    var voting = "";
    for (var i = 0; i < topics.length; i++) {
      var rules = R.AAO_RULES[topics[i]];
      if (rules.architect && R.sameAddress(rules.architect, address)) return topics[i];
      if (!voting && (rules.voters || []).some(function (a) { return R.sameAddress(a, address); })) {
        voting = topics[i];
      }
    }
    return voting;
  }

  // The latest `now` each agent posted, with how old it is. An agent that has
  // never posted one still gets a line: silence is information, and leaving it
  // off the street would read as "no such agent".
  function street(messages, nowMs, proposals, aaos) {
    var at = nowMs === undefined || nowMs === null ? Date.now() : nowMs;
    var latest = {};
    (messages || []).forEach(function (m) {
      if (!m || m.type !== "status") return;
      if (!textOf(m.now).trim()) return;
      var key = textOf(m.from).toLowerCase();
      var when = timeOf(m.ts);
      var held = latest[key];
      if (!held || (when !== null && held.when !== null && when > held.when)) {
        latest[key] = { now: textOf(m.now).trim(), when: when, ts: m.ts || null };
      }
    });

    return R.ROLES
      .filter(function (role) { return NOT_AN_AGENT.indexOf(role.key) === -1; })
      .map(function (role) {
        var said = latest[role.key] || null;
        var age = said && said.when !== null ? at - said.when : null;
        // The queue the agent's kolam draws (proposal 64). It travels with the
        // rest of the line so the page reads one object per agent, and so the
        // dashboard can tell whether a kolam needs redrawing at all.
        var tasks = tasksFor(role.key, messages, proposals, aaos);
        return {
          key: role.key,
          label: role.label,
          address: role.address,
          organisation: organisationOf(role.address),
          now: said ? said.now : "",
          at: said ? said.ts : null,
          ageMs: age,
          // Greyed: silent over an hour, or never heard from at all.
          silent: age === null || age > SILENT_MS,
          tasks: tasks,
          done: tasks.filter(function (t) { return t.state === "built"; }).length
        };
      });
  }

  // --- an agent's tasks ---------------------------------------------------
  //
  // Proposal 64, and Kural's answer to the Director on it: the dots are the
  // tasks. A task is a proposal the agent has picked up -- a decision message
  // from that agent on the proposal starts it -- and its state is read off that
  // agent's latest decision on it. An architect also holds the proposals it
  // filed that are still open.
  //
  // adoption.js knows nine states and a dot has four, so they fold:
  //
  //   blocked                    blocked    somebody else has to move
  //   building                   building   in hand
  //   built, in-widget, closed   built      finished, however it finished
  //   everything else            queued     held, not moving
  //
  // "waiting" folds to queued on purpose: a task deferred is still held. Only
  // the built bucket counts as done, because done is what the line is drawn to.
  var DOT_STATES = { blocked: "blocked", building: "building", built: "built", "in-widget": "built", closed: "built" };

  function dotStateOf(key) {
    return DOT_STATES[key] || "queued";
  }

  function addressOf(agent) {
    if (/^0x/i.test(textOf(agent))) return textOf(agent);
    var role = R.ROLES.filter(function (x) { return x.key === textOf(agent).toLowerCase(); })[0];
    return role ? role.address : "";
  }

  function isArchitect(address) {
    return Object.keys(R.AAO_RULES).some(function (topic) {
      var rules = R.AAO_RULES[topic];
      return rules.architect && R.sameAddress(rules.architect, address);
    });
  }

  // Every task this agent holds, oldest first -- the order a kolam is drawn in,
  // from the centre outward.
  function tasksFor(agent, messages, proposals, aaos) {
    var key = textOf(agent).toLowerCase();
    var address = addressOf(agent);
    var byId = {};
    (proposals || []).forEach(function (p) { byId[p.id] = p; });
    var orgOf = {};
    (aaos || []).forEach(function (a) { orgOf[a.id] = a.topic; });

    var own = (messages || []).filter(function (m) {
      return m && m.type === "decision" && textOf(m.from).toLowerCase() === key;
    });
    var latest = A.indexDecisions(own);

    // When the agent first said anything about it: that is when it picked it up.
    var pickedUp = {};
    own.forEach(function (m) {
      var id = A.proposalOf(m);
      if (id === null) return;
      var when = timeOf(m.ts);
      if (when === null) return;
      if (pickedUp[id] === undefined || when < pickedUp[id]) pickedUp[id] = when;
    });

    var tasks = [];
    var held = {};

    Object.keys(latest).forEach(function (id) {
      var adoption = A.adoptionOf(latest, id);
      var proposal = byId[Number(id)] || {};
      held[Number(id)] = true;
      var row = taskRow(Number(id), proposal, orgOf, dotStateOf(adoption.state.key),
        A.blockedOn(adoption), pickedUp[id] || timeOf(adoption.message.ts), adoption.text, address);
      if (row) tasks.push(row);
    });

    // An architect holds what it filed until the organisation closes it. These
    // never carry a decision of its own -- the filing IS the pickup.
    if (address && isArchitect(address)) {
      (proposals || []).forEach(function (p) {
        if (held[p.id] || !R.sameAddress(p.proposer, address)) return;
        var row = taskRow(p.id, p, orgOf, "queued", null,
          p.createdAt ? p.createdAt * 1000 : null, "", address);
        if (row) tasks.push(row);
      });
    }

    // Oldest first. A task with no clock sinks to the end rather than jumping
    // to the centre: the centre is for what has been waiting longest, and an
    // unknown age is not a long one.
    return tasks.sort(function (a, b) {
      if (a.at === null && b.at === null) return a.proposalId - b.proposalId;
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return a.at - b.at || a.proposalId - b.proposalId;
    });
  }

  // Returns null for a task that is not held any more.
  //
  // `filer` is the agent this list is for. The chain is the last word on a
  // proposal the agent filed (proposal 66): an architect's passed proposal used
  // to vanish from its kolam the moment it passed, so finished work disappeared
  // instead of filling its dot and the line could never complete; and a
  // rejected one lingered as a queued ring, overstating the queue. Both made
  // the drawing disagree with the chain it is drawn from.
  function taskRow(id, proposal, orgOf, state, blocked, at, said, filer) {
    var title = titleOf(proposal) || ("Proposal " + id);
    var filed = filer && proposal.proposer && R.sameAddress(proposal.proposer, filer);

    if (filed) {
      // Rejected: the organisation said no, so it is nobody's task any more.
      if (proposal.status === 2) return null;
      // Executed is executed AND passed -- the facet writes Rejected otherwise --
      // so the work is done however quiet the agent was about it.
      if (proposal.status === 1) {
        state = "built";
        blocked = null;
      }
    }

    // An open "Blocked on the Director" proposal is a block, whoever holds it:
    // the column above the kolam already reads it that way, and the kolam
    // showing the same proposal as merely queued would make the page argue with
    // itself. The title carries who and what.
    var human = proposal.status === 0 && HUMAN_BLOCK_TITLE.test(title);
    if (human && state !== "building") {
      state = "blocked";
      blocked = { who: "the Director", what: title.replace(HUMAN_BLOCK_TITLE, "").replace(/^\s*:\s*/, "").trim() };
    }
    return {
      proposalId: id,
      aaoId: proposal.aaoId === undefined ? null : proposal.aaoId,
      organisation: orgOf[proposal.aaoId] || "",
      title: title,
      state: state,
      who: blocked ? blocked.who : "",
      what: blocked ? blocked.what : "",
      at: at === undefined ? null : at,
      said: said || ""
    };
  }

  function dashboard(messages, proposals, aaos, nowMs) {
    var cols = columns(messages, proposals, aaos);
    return {
      blocked: cols.blocked,
      building: cols.building,
      done: cols.done,
      street: street(messages, nowMs, proposals, aaos)
    };
  }

  return {
    HUMAN_BLOCK_TITLE: HUMAN_BLOCK_TITLE,
    SILENT_MS: SILENT_MS,
    titleOf: titleOf,
    columns: columns,
    street: street,
    tasksFor: tasksFor,
    dotStateOf: dotStateOf,
    organisationOf: organisationOf,
    dashboard: dashboard
  };
});
