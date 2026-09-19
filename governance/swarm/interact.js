// Hover, focus and click on a kolam (proposal 64). Plain DOM, no library, and
// nothing here writes: a dot is a link to a proposal card and that is all.
//
// Every dot already carries a <title>, so the kolam reads with no script at
// all -- a native tooltip and a screen reader both get the task. This adds the
// positioned box, the keyboard path, and the line's own tooltip.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GovernanceKolamInteract = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STATE_WORDS = {
    queued: "queued",
    building: "being built",
    built: "done",
    blocked: "blocked"
  };

  function age(fromMs, nowMs) {
    if (!fromMs) return "";
    var minutes = Math.round((nowMs - Number(fromMs)) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " minutes";
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + " hour" + (hours === 1 ? "" : "s");
    var days = Math.round(hours / 24);
    return days + " day" + (days === 1 ? "" : "s");
  }

  // The chain page opens a proposal by its own hash route.
  function href(dot) {
    return "/#aao=" + (dot.getAttribute("data-aao") || "") +
      "&proposal=" + dot.getAttribute("data-proposal");
  }

  function linesForDot(dot, nowMs) {
    if (!dot.hasAttribute("data-proposal")) {
      return [{ className: "tip-title", text: "Open ground" },
              { className: "tip-line", text: "No task on this dot." }];
    }
    var state = dot.getAttribute("data-state");
    var held = age(dot.getAttribute("data-at"), nowMs);
    var lines = [
      { className: "tip-title", text: "#" + dot.getAttribute("data-proposal") + " " + dot.getAttribute("data-title") },
      { className: "tip-line", text: (STATE_WORDS[state] || state) + (held ? " · " + held : "") }
    ];
    if (state === "blocked") {
      var who = dot.getAttribute("data-who");
      var what = dot.getAttribute("data-what");
      lines.push({
        className: "tip-block",
        text: "waiting on " + (who || "someone") + (what ? " for " + what : "")
      });
    }
    lines.push({ className: "tip-foot", text: "Click to open the proposal" });
    return lines;
  }

  function linesForLine(svg) {
    var label = svg.getAttribute("data-label") || svg.getAttribute("data-agent") || "This agent";
    var now = svg.getAttribute("data-now");
    var done = svg.getAttribute("data-done");
    var total = svg.getAttribute("data-total");
    var lines = [{ className: "tip-title", text: label }];
    lines.push({ className: "tip-line", text: now ? now : "silent" });
    if (total) {
      lines.push({ className: "tip-foot", text: done + " of " + total + " done" });
    }
    return lines;
  }

  function attach(root, options) {
    var o = options || {};
    var doc = root.ownerDocument || document;
    var tip = doc.createElement("div");
    tip.className = "kolam-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    doc.body.appendChild(tip);

    function show(lines, x, y) {
      tip.textContent = "";
      lines.forEach(function (line) {
        var p = doc.createElement("p");
        p.className = line.className;
        p.textContent = line.text;
        tip.appendChild(p);
      });
      tip.hidden = false;
      // Placed after it is measurable, and kept inside the window: a tooltip
      // half off the right edge is a tooltip nobody can read.
      var box = tip.getBoundingClientRect();
      var left = Math.min(x + 14, doc.documentElement.clientWidth - box.width - 8);
      var top = y + 16 + box.height > doc.documentElement.clientHeight ? y - box.height - 12 : y + 16;
      tip.style.left = Math.max(8, left) + "px";
      tip.style.top = Math.max(8, top) + "px";
    }

    function hide() { tip.hidden = true; }

    function at(target) {
      var box = target.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }

    root.addEventListener("mousemove", function (event) {
      var dot = event.target.closest && event.target.closest(".pulli");
      if (dot) return show(linesForDot(dot, o.now ? o.now() : Date.now()), event.clientX, event.clientY);
      var line = event.target.closest && event.target.closest(".line");
      if (line) {
        return show(linesForLine(line.closest("svg")), event.clientX, event.clientY);
      }
      hide();
    });

    root.addEventListener("mouseleave", hide);

    // The keyboard path. Focus is not hover: the box is placed on the dot.
    root.addEventListener("focusin", function (event) {
      var dot = event.target.closest && event.target.closest(".pulli");
      if (!dot) return;
      var point = at(dot);
      show(linesForDot(dot, o.now ? o.now() : Date.now()), point.x, point.y);
    });
    root.addEventListener("focusout", hide);
    root.addEventListener("scroll", hide, true);

    function open(dot) {
      if (!dot || !dot.hasAttribute("data-proposal")) return;
      hide();
      (o.open || function (target) { doc.defaultView.location.href = target; })(href(dot));
    }

    root.addEventListener("click", function (event) {
      var dot = event.target.closest && event.target.closest(".pulli");
      open(dot);
    });

    root.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      var dot = event.target.closest && event.target.closest(".pulli");
      if (!dot || !dot.hasAttribute("data-proposal")) return;
      event.preventDefault();
      open(dot);
    });

    return { tip: tip, hide: hide };
  }

  return { attach: attach, linesForDot: linesForDot, linesForLine: linesForLine, age: age, href: href };
});
