// A pulli kolam, drawn from a chain address (proposal 59).
//
// A pulli kolam is a grid of dots (pulli) and a line that loops around them.
// The line never touches a dot and never ends: it is one continuous closed
// curve, and the figure is symmetric. This file obeys those rules and asserts
// them rather than claiming them -- kolam() throws if the curve it built is not
// a single closed loop, or if the tiling is not symmetric.
//
// How the curve is built
//
//   The dots sit on the interior corners of an n-by-n grid of cells. In each
//   cell the line is two quarter-circles of radius half a cell, each centred on
//   a cell corner -- that is, on a dot -- so the line curves around the dots and
//   never crosses one. A cell has two ways to do that, and which one it takes is
//   the only choice in the whole drawing:
//
//     type 0    north-east and south-west quarters
//     type 1    north-west and south-east quarters
//
//   Every interior edge midpoint is shared by exactly two cells, so it carries
//   exactly two arc ends. The midpoints on the border are joined in pairs by
//   arcs that bulge outward around the border dots -- the scalloped edge a real
//   kolam has. Every point on the curve therefore has exactly two arcs, so the
//   figure is always a set of closed loops. Making it ONE loop is the work.
//
// How it becomes one loop
//
//   Flipping a cell's type either joins two loops or splits one. So: trace the
//   loops, and while there is more than one, flip the cell whose flip joins two.
//   Each successful flip removes one loop, so it ends.
//
// The symmetry
//
//   180-degree rotation. It maps cell (r,c) to (n-1-r, n-1-c) and maps a tile to
//   its own type -- the north-east quarter becomes the south-west quarter of the
//   same type -- so the symmetry costs nothing in the drawing and is exact.
//   Cells therefore flip in pairs, or the centre cell flips alone.
//
//   The centre cell is why n is odd. A pair of flips changes the number of
//   loops by an even number, so pairs alone can never turn an even count into
//   one: under the rotation a loop is either its own mirror or one of a pair,
//   so an all-paired figure has an even count and stays that way. The centre
//   cell is its own partner, and flipping it changes the count by one. Without
//   it half the addresses have no kolam at all.
//
// The seed is the address: the same agent draws the same kolam every time, and
// no two addresses draw the same one.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../protocol.js"));
  } else {
    root.GovernanceKolam = factory(root.GovernanceProtocol);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (P) {
  "use strict";

  var DEFAULTS = { cells: 7, unit: 20, pad: 14 };

  // --- the seed ----------------------------------------------------------

  // The address, as a stream of bits. sha256 is already in protocol.js and
  // gives the same digest in Node and in a browser, so a kolam drawn on the
  // page and one written to a file are the same drawing.
  function bitsFrom(seed, count) {
    var bits = [];
    var round = 0;
    while (bits.length < count) {
      var hex = P.sha256Hex(String(seed).toLowerCase() + ":" + round);
      for (var i = 0; i < hex.length && bits.length < count; i++) {
        var nibble = parseInt(hex[i], 16);
        for (var b = 3; b >= 0 && bits.length < count; b--) {
          bits.push((nibble >> b) & 1);
        }
      }
      round++;
    }
    return bits;
  }

  // --- the tiling --------------------------------------------------------

  function partnerOf(n, r, c) { return { r: n - 1 - r, c: n - 1 - c }; }

  // Half the cells decide; the other half are their 180-degree partners.
  function tilingFrom(seed, n, salt) {
    var types = [];
    for (var r = 0; r < n; r++) types.push(new Array(n).fill(-1));
    var orbits = [];
    for (r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (types[r][c] !== -1) continue;
        var p = partnerOf(n, r, c);
        types[r][c] = 0;
        types[p.r][p.c] = 0;
        // The centre cell is its own partner. It must appear once, not twice:
        // a flip walks the orbit, and flipping the same cell twice is no flip
        // at all -- which is exactly the move the parity argument needs.
        orbits.push(p.r === r && p.c === c ? [{ r: r, c: c }] : [{ r: r, c: c }, p]);
      }
    }
    var bits = bitsFrom(String(seed) + "#" + (salt || 0), orbits.length);
    orbits.forEach(function (orbit, i) {
      orbit.forEach(function (cell) { types[cell.r][cell.c] = bits[i]; });
    });
    return { types: types, orbits: orbits };
  }

  function isSymmetric(types, n) {
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var p = partnerOf(n, r, c);
        if (types[r][c] !== types[p.r][p.c]) return false;
      }
    }
    return true;
  }

  // --- the geometry ------------------------------------------------------

  // A node is an edge midpoint of the cell grid, named by the edge it sits on.
  function vName(r, c) { return "v:" + r + ":" + c; }   // vertical edge left of column c
  function hName(r, c) { return "h:" + r + ":" + c; }   // horizontal edge above row r

  function nodesOfCell(r, c) {
    return { n: hName(r, c), s: hName(r + 1, c), w: vName(r, c), e: vName(r, c + 1) };
  }

  function pointOf(name, g) {
    var bits = name.split(":");
    var r = Number(bits[1]);
    var c = Number(bits[2]);
    return bits[0] === "h"
      ? { x: g.pad + (c + 0.5) * g.unit, y: g.pad + r * g.unit }
      : { x: g.pad + c * g.unit, y: g.pad + (r + 0.5) * g.unit };
  }

  function corner(r, c, g) {
    return { x: g.pad + c * g.unit, y: g.pad + r * g.unit };
  }

  // The two dots an edge midpoint sits between. Two midpoints next to each
  // other on the border share exactly one of them, and that shared dot is what
  // the scallop loops around -- along an edge or around a corner alike.
  function latticeOf(name) {
    var bits = name.split(":");
    var r = Number(bits[1]);
    var c = Number(bits[2]);
    return bits[0] === "h" ? [[r, c], [r, c + 1]] : [[r, c], [r + 1, c]];
  }

  function sharedDot(a, b) {
    var ends = latticeOf(a);
    var other = latticeOf(b);
    for (var i = 0; i < ends.length; i++) {
      for (var j = 0; j < other.length; j++) {
        if (ends[i][0] === other[j][0] && ends[i][1] === other[j][1]) return ends[i];
      }
    }
    return null;
  }

  // Where an arc reaches when it is halfway round, so the border scallop can be
  // sent outward by measuring rather than by guessing a sign.
  function arcMidpoint(from, to, centre, sweep) {
    var a = Math.atan2(from.y - centre.y, from.x - centre.x);
    var b = Math.atan2(to.y - centre.y, to.x - centre.x);
    var span = sweep === 1 ? mod2pi(b - a) : -mod2pi(a - b);
    var mid = a + span / 2;
    var r = Math.hypot(from.x - centre.x, from.y - centre.y);
    return { x: centre.x + r * Math.cos(mid), y: centre.y + r * Math.sin(mid) };
  }

  function mod2pi(v) {
    var t = v % (2 * Math.PI);
    return t < 0 ? t + 2 * Math.PI : t;
  }

  // Which way round the circle the arc goes, on a screen whose y grows down.
  function sweepFor(from, to, centre) {
    var cross = (from.x - centre.x) * (to.y - centre.y) - (from.y - centre.y) * (to.x - centre.x);
    return cross > 0 ? 1 : 0;
  }

  function arc(fromName, toName, centre, g) {
    var from = pointOf(fromName, g);
    var to = pointOf(toName, g);
    return {
      a: fromName, b: toName,
      cx: centre.x, cy: centre.y, r: g.unit / 2,
      sweep: sweepFor(from, to, centre)
    };
  }

  // Every arc in the figure: two per cell, plus the border scallops.
  function arcsOf(types, n, g) {
    var out = [];
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var m = nodesOfCell(r, c);
        if (types[r][c] === 0) {
          out.push(arc(m.n, m.e, corner(r, c + 1, g), g));       // around the NE dot
          out.push(arc(m.s, m.w, corner(r + 1, c, g), g));       // around the SW dot
        } else {
          out.push(arc(m.n, m.w, corner(r, c, g), g));           // around the NW dot
          out.push(arc(m.s, m.e, corner(r + 1, c + 1, g), g));   // around the SE dot
        }
      }
    }
    return out.concat(borderArcs(n, g));
  }

  // The border midpoints, clockwise from the top left.
  function borderRing(n) {
    var ring = [];
    var c, r;
    for (c = 0; c < n; c++) ring.push(hName(0, c));
    for (r = 0; r < n; r++) ring.push(vName(r, n));
    for (c = n - 1; c >= 0; c--) ring.push(hName(n, c));
    for (r = n - 1; r >= 0; r--) ring.push(vName(r, 0));
    return ring;
  }

  // Joined in consecutive pairs, each bulging outward around the dot between
  // them: the scalloped edge. n is even, so no pair straddles a corner.
  function borderArcs(n, g) {
    var ring = borderRing(n);
    var mid = { x: g.pad + (n * g.unit) / 2, y: g.pad + (n * g.unit) / 2 };
    var out = [];
    for (var i = 0; i < ring.length; i += 2) {
      var a = ring[i];
      var b = ring[i + 1];
      var dot = sharedDot(a, b);
      if (!dot) throw new Error("kolam: border midpoints " + a + " and " + b + " share no dot");
      var centre = corner(dot[0], dot[1], g);
      var pa = pointOf(a, g);
      var pb = pointOf(b, g);
      // Bulge away from the middle of the figure. Measured, not guessed: the
      // half-circles along an edge and the quarters at a corner turn opposite
      // ways, and a sign rule that suits one puts the other inside the figure.
      var far = arcMidpoint(pa, pb, centre, 1);
      var near = arcMidpoint(pa, pb, centre, 0);
      var piece = arc(a, b, centre, g);
      piece.sweep = Math.hypot(far.x - mid.x, far.y - mid.y) >
        Math.hypot(near.x - mid.x, near.y - mid.y) ? 1 : 0;
      out.push(piece);
    }
    return out;
  }

  // --- loops -------------------------------------------------------------

  // Every node carries exactly two arcs, so the figure is a set of cycles.
  function loopsOf(arcs) {
    var at = {};
    arcs.forEach(function (piece, i) {
      (at[piece.a] = at[piece.a] || []).push(i);
      (at[piece.b] = at[piece.b] || []).push(i);
    });
    var names = Object.keys(at);
    for (var k = 0; k < names.length; k++) {
      if (at[names[k]].length !== 2) {
        throw new Error("kolam: node " + names[k] + " carries " + at[names[k]].length + " arcs, not 2");
      }
    }

    var used = arcs.map(function () { return false; });
    var loops = [];
    for (var start = 0; start < arcs.length; start++) {
      if (used[start]) continue;
      var loop = [];
      var index = start;
      var from = arcs[start].a;
      while (!used[index]) {
        used[index] = true;
        var piece = arcs[index];
        var to = piece.a === from ? piece.b : piece.a;
        loop.push({ arc: index, from: from, to: to });
        var pair = at[to];
        index = pair[0] === index ? pair[1] : pair[0];
        from = to;
      }
      loops.push(loop);
    }
    return loops;
  }

  // Flipping a cell joins two loops or splits one. While there is more than
  // one loop, take any flip that joins. Each one removes a loop, so it ends.
  // Cells move in 180-degree pairs, so the symmetry is never broken.
  function joinIntoOneLoop(types, orbits, n, g) {
    var count = loopsOf(arcsOf(types, n, g)).length;
    var guard = orbits.length * 4;
    while (count > 1 && guard-- > 0) {
      var improved = false;
      for (var i = 0; i < orbits.length; i++) {
        orbits[i].forEach(function (cell) { types[cell.r][cell.c] ^= 1; });
        var after = loopsOf(arcsOf(types, n, g)).length;
        if (after < count) { count = after; improved = true; break; }
        orbits[i].forEach(function (cell) { types[cell.r][cell.c] ^= 1; });
      }
      if (!improved) return null;   // this seed cannot get there; the caller re-salts
    }
    return count === 1 ? types : null;
  }

  // --- the drawing -------------------------------------------------------

  // One "A" command. Both path builders go through this, so they cannot drift.
  //
  // The large-arc flag is computed, not assumed. The scallop that rounds a
  // corner of the figure sweeps 270 degrees around the corner dot, and with the
  // flag left at 0 the renderer silently draws the 90-degree complement
  // instead -- the endpoints still meet, so the loop still closes, and the
  // corner quietly turns inside out.
  function arcCommand(step, arcs, g) {
    var piece = arcs[step.arc];
    var to = pointOf(step.to, g);
    // Traversed backwards, the arc turns the other way.
    var sweep = step.from === piece.a ? piece.sweep : 1 - piece.sweep;
    var large = Math.abs(spanOf(step, arcs, g)) > Math.PI + 1e-9 ? 1 : 0;
    return ["A", round(piece.r), round(piece.r), 0, large, sweep, round(to.x), round(to.y)];
  }

  function pathOf(loop, arcs, g) {
    var first = pointOf(loop[0].from, g);
    var d = ["M", round(first.x), round(first.y)];
    loop.forEach(function (step) { d = d.concat(arcCommand(step, arcs, g)); });
    return d.join(" ") + " Z";
  }

  function round(v) { return Math.round(v * 100) / 100; }

  function spanOf(step, arcs, g) {
    var piece = arcs[step.arc];
    var from = pointOf(step.from, g);
    var to = pointOf(step.to, g);
    var a = Math.atan2(from.y - piece.cy, from.x - piece.cx);
    var b = Math.atan2(to.y - piece.cy, to.x - piece.cx);
    var sweep = step.from === piece.a ? piece.sweep : 1 - piece.sweep;
    return sweep === 1 ? mod2pi(b - a) : -mod2pi(a - b);
  }

  function lengthOf(loop, arcs, g) {
    return loop.reduce(function (total, step) {
      return total + arcs[step.arc].r * Math.abs(spanOf(step, arcs, g));
    }, 0);
  }

  function dotsOf(n, g) {
    var dots = [];
    for (var r = 1; r < n; r++) {
      for (var c = 1; c < n; c++) dots.push(corner(r, c, g));
    }
    return dots;
  }

  // One kolam. Throws if it is not a single closed loop, or not symmetric:
  // a drawing that quietly breaks the rule is worse than no drawing.
  function kolam(seed, options) {
    var g = Object.assign({}, DEFAULTS, options || {});
    var n = g.cells;
    // Odd, so one cell is its own 180-degree partner. See "The symmetry" above:
    // without it, an even number of loops can never be joined into one.
    if (n % 2 !== 1) throw new Error("kolam: the cell count must be odd");

    var types = null;
    var orbits = null;
    for (var salt = 0; salt < 64 && !types; salt++) {
      var built = tilingFrom(seed, n, salt);
      var joined = joinIntoOneLoop(built.types, built.orbits, n, g);
      if (joined) { types = joined; orbits = built.orbits; }
    }
    if (!types) throw new Error("kolam: no single-loop tiling found for " + seed);
    if (!isSymmetric(types, n)) throw new Error("kolam: the tiling lost its symmetry");

    var arcs = arcsOf(types, n, g);
    var loops = loopsOf(arcs);
    if (loops.length !== 1) throw new Error("kolam: " + loops.length + " loops, not 1");

    var size = round(g.pad * 2 + n * g.unit);
    return {
      seed: String(seed),
      cells: n,
      size: size,
      dots: dotsOf(n, g),
      arcs: arcs,
      loop: loops[0],
      path: pathOf(loops[0], arcs, g),
      // The true length of the line, arc by arc, so a partly drawn kolam stops
      // where it is meant to rather than where a guess put it.
      length: round(lengthOf(loops[0], arcs, g)),
      grid: g
    };
  }

  // The line stops short and the dot it stops at is lit: the kolam a blocked
  // agent leaves on its threshold. The line is open, which is the whole point.
  function openPath(k, at) {
    var cut = Math.max(1, Math.min(k.loop.length - 1, at === undefined ? Math.floor(k.loop.length / 2) : at));
    // The line must stop at a DOT, so the cut has to land on an arc that circles
    // one. The border scallops circle the lattice points outside the dot grid;
    // ending there would light nothing and the drawing would just look broken.
    cut = nearestInteriorCut(k, cut);
    var rest = k.loop.slice(cut).concat(k.loop.slice(0, cut - 1));
    var first = pointOf(rest[0].from, k.grid);
    var d = ["M", round(first.x), round(first.y)];
    rest.forEach(function (step) { d = d.concat(arcCommand(step, k.arcs, k.grid)); });
    var ended = k.arcs[k.loop[cut - 1].arc];
    return { path: d.join(" "), lit: { x: round(ended.cx), y: round(ended.cy) } };
  }

  // --- one standalone SVG -------------------------------------------------

  function isDotOf(k, x, y) {
    return k.dots.some(function (dot) {
      return Math.abs(dot.x - x) < 0.01 && Math.abs(dot.y - y) < 0.01;
    });
  }

  // The cut asked for, or the closest one on either side that ends at a dot.
  function nearestInteriorCut(k, wanted) {
    for (var step = 0; step < k.loop.length; step++) {
      var forward = wanted + step;
      var back = wanted - step;
      if (forward < k.loop.length && endsAtDot(k, forward)) return forward;
      if (back >= 1 && endsAtDot(k, back)) return back;
    }
    return wanted;
  }

  function endsAtDot(k, cut) {
    var piece = k.arcs[k.loop[cut - 1].arc];
    return isDotOf(k, piece.cx, piece.cy);
  }

  var NEWLINE = String.fromCharCode(10);
  var INK = "#1d1c1a";
  var DOT = "#8b877f";
  var LIT = "#a8322a";

  // state: "idle" -- the line closed and complete, the agent at rest
  //        "working" -- the line part drawn, and still being drawn
  //        "blocked" -- the line open, stopped at a dot, and that dot lit
  function toSVG(seed, options) {
    var o = options || {};
    var k = kolam(seed, o);
    var state = o.state || "idle";
    var stroke = o.stroke || 2;
    var lit = null;
    var d = k.path;
    var dash = "";

    if (state === "blocked") {
      var open = openPath(k, o.at);
      d = open.path;
      lit = open.lit;
    } else if (state === "working") {
      var drawn = round(k.length * (o.progress === undefined ? 0.45 : o.progress));
      dash = ' stroke-dasharray="' + drawn + ' ' + round(k.length) + '"';
    }

    var parts = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + k.size + ' ' + k.size +
        '" width="' + k.size + '" height="' + k.size + '" role="img">',
      '  <title>' + state + ' kolam for ' + escapeXml(String(seed)) + '</title>',
      '  <rect width="' + k.size + '" height="' + k.size + '" fill="none"/>'
    ];
    k.dots.forEach(function (dot) {
      var isLit = lit && Math.abs(dot.x - lit.x) < 0.01 && Math.abs(dot.y - lit.y) < 0.01;
      parts.push('  <circle cx="' + round(dot.x) + '" cy="' + round(dot.y) + '" r="' +
        (isLit ? stroke * 1.9 : stroke * 0.85) + '" fill="' + (isLit ? LIT : DOT) + '"/>');
    });
    parts.push('  <path d="' + d + '" fill="none" stroke="' + (state === "blocked" ? LIT : INK) +
      '" stroke-width="' + stroke + '" stroke-linecap="round"' + dash + '/>');
    parts.push('</svg>');
    return parts.join(NEWLINE) + NEWLINE;
  }

  function escapeXml(text) {
    return String(text).replace(/[<>&"]/g, function (ch) {
      return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[ch];
    });
  }

  return {
    DEFAULTS: DEFAULTS,
    kolam: kolam,
    toSVG: toSVG,
    lengthOf: lengthOf,
    openPath: openPath,
    loopsOf: loopsOf,
    arcsOf: arcsOf,
    tilingFrom: tilingFrom,
    isSymmetric: isSymmetric,
    pointOf: pointOf
  };
});
