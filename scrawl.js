/*!
 * Scrawl v0.2.0
 * Hand drawn annotation strokes for HTML text. No dependencies.
 * Draws seeded, slightly wonky SVG paths behind (or over) inline text,
 * one stroke per line box, and arrows from one element to another, with
 * an optional draw on reveal.
 * MIT licence.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Scrawl = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var EASE = 'cubic-bezier(.25,.6,.35,1)';

  /* Shapes that get one stroke per line box, versus one stroke for the
     whole run. Wrapping text needs the former, boxes and circles need
     the latter or you end up with a box around every line. */
  var PER_LINE = {
    underline: 1, curve: 1, scribble: 1, marker: 1, strike: 1, double: 1, swoosh: 1
  };

  /* Shapes that join this element to the one named by `to`, rather than
     marking this element on its own. */
  var CONNECTORS = { arrow: 1, curl: 1 };

  var DEFAULTS = {
    type: 'underline',
    color: null,        // null means "use the element's computed colour"
    thickness: null,    // px, null means fontSize * 0.085
    opacity: null,      // null means per shape default
    passes: 2,          // 2 gives the classic scratchy double stroke
    jitter: 1,          // 0 is ruler straight, 2 is had a big night
    animate: true,
    duration: 650,      // ms, per stroke
    delay: 0,           // ms, before the first stroke
    stagger: 0.35,      // fraction of duration between strokes
    direction: 'right', // or 'left'
    front: null,        // true paints over the glyphs, null means per shape default
    seed: null,         // any string or number, null hashes the text
    repeat: false,      // replay every time it scrolls back into view
    threshold: 0.2,     // IntersectionObserver visibility trigger
    respectReducedMotion: true, // set false to draw even when the OS asks not to
    to: null,           // arrow and curl: the element or selector to point at
    within: null,       // arrow and curl: where the SVG goes, null means the nearest shared ancestor
    gap: null,          // arrow and curl: px left clear at each end, null means thickness * 2.5
    head: 'end'         // arrow and curl: 'end', 'start', 'both' or 'none'
  };

  var SHAPES = [
    'underline', 'curve', 'double', 'scribble', 'strike',
    'marker', 'box', 'circle', 'bracket', 'cross', 'swoosh'
  ];

  /* ---------------------------------------------------------------- utils */

  /* mulberry32: tiny, fast, good enough. Seeded so a given bit of text
     always draws the same wobble, which matters for screenshots and diffs. */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function n2(v) { return Math.round(v * 100) / 100; }

  /* Catmull-Rom through the points, emitted as cubic beziers. This turns a
     jittered point cloud into something that looks drawn rather than
     plotted. */
  function smooth(pts) {
    if (pts.length < 2) return '';
    var d = 'M' + n2(pts[0][0]) + ' ' + n2(pts[0][1]);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[i + 2] || pts[i + 1];
      d += 'C' + n2(p1[0] + (p2[0] - p0[0]) / 6) + ' ' + n2(p1[1] + (p2[1] - p0[1]) / 6) +
           ' ' + n2(p2[0] - (p3[0] - p1[0]) / 6) + ' ' + n2(p2[1] - (p3[1] - p1[1]) / 6) +
           ' ' + n2(p2[0]) + ' ' + n2(p2[1]);
    }
    return d;
  }

  function jit(rnd, amt) { return (rnd() - 0.5) * amt; }

  /* Passes are the pen going over the same mark again. Each repeat is a
     little thinner and lighter than the last, which reads as retracing
     rather than as one fat stroke. */
  function passCount(o) { return Math.max(1, Math.round(o.passes) || 1); }
  function passWeight(p) { return p === 0 ? 1 : Math.max(0.55, 1 - p * 0.18); }
  function passAlpha(p) { return p === 0 ? 1 : Math.max(0.38, 1 - p * 0.3); }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ----------------------------------------------------------- generators */
  /* Each takes a rect in local SVG coords, the resolved options and a seeded
     rng, and returns an array of stroke descriptors: {d, w, o, cap}. */

  function gUnderline(r, o, rnd) {
    var out = [];
    for (var p = 0; p < passCount(o); p++) {
      var n = clamp(Math.round(r.w / 24), 3, 90);
      var base = r.y + r.h + o.thickness * 0.4 + p * o.thickness * 0.7 * (0.6 + rnd() * 0.8);
      var over = o.thickness * 1.8 * o.jitter;
      var pts = [];
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        var x = r.x + t * r.w;
        if (i === 0) x -= over * rnd();
        if (i === n) x += over * rnd();
        var y = base + jit(rnd, o.thickness * o.jitter) - Math.sin(t * Math.PI) * o.thickness * 0.3;
        pts.push([x, y]);
      }
      out.push({ d: smooth(pts), w: o.thickness * passWeight(p), o: passAlpha(p) });
    }
    return out;
  }

  /* One sweeping arc that dips below the baseline, the shape you get from
     dragging a pen without lifting your wrist. */
  function gCurve(r, o, rnd) {
    var out = [];
    for (var p = 0; p < passCount(o); p++) {
      var n = clamp(Math.round(r.w / 36), 4, 60);
      var base = r.y + r.h + o.thickness * 0.3 + p * o.thickness * 0.6;
      /* Sag has to scale with the length of the run, otherwise a long
         phrase gets what looks like a slightly bent ruler. */
      var amp = clamp(r.w * 0.035, o.thickness * 1.6, o.thickness * 7) * (0.85 + rnd() * 0.35) * o.jitter;
      var tilt = jit(rnd, o.thickness * 1.4 * o.jitter);
      var pts = [];
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        var x = r.x + t * r.w + (i === 0 ? -o.thickness * rnd() : i === n ? o.thickness * 2 * rnd() : 0);
        var y = base + Math.sin(t * Math.PI) * amp + tilt * (t - 0.5) * 2 + jit(rnd, o.thickness * 0.3);
        pts.push([x, y]);
      }
      out.push({ d: smooth(pts), w: o.thickness * passWeight(p), o: passAlpha(p) });
    }
    return out;
  }

  /* Two clearly separated rules, like a proofreader marking emphasis. */
  function gDouble(r, o, rnd) {
    var out = [];
    for (var p = 0; p < passCount(o); p++) {
      /* Both rules get redrawn on each pass, so passes still means retrace
         rather than "add another rule". */
      for (var rule = 0; rule < 2; rule++) {
        var n = clamp(Math.round(r.w / 30), 3, 70);
        var base = r.y + r.h + o.thickness * 0.5 + rule * o.thickness * 2.1 +
                   p * o.thickness * 0.4;
        var pts = [];
        for (var i = 0; i <= n; i++) {
          var t = i / n;
          var x = r.x + t * r.w + (i === n ? o.thickness * 1.4 * rnd() : 0);
          pts.push([x, base + jit(rnd, o.thickness * 0.7 * o.jitter)]);
        }
        out.push({
          d: smooth(pts),
          w: o.thickness * (rule ? 0.72 : 0.9) * passWeight(p),
          o: (rule ? 0.8 : 1) * passAlpha(p)
        });
      }
    }
    return out;
  }

  function gScribble(r, o, rnd) {
    var out = [];
    var cy = r.y + r.h + o.thickness * 1.3;
    var amp = o.thickness * 1.6 * o.jitter;
    var cycles = clamp(Math.round(r.w / 20), 3, 55);
    for (var p = 0; p < passCount(o); p++) {
      var n = clamp(cycles * 4, 8, 200);
      var phase = p * Math.PI * 0.8 + rnd() * 0.7;
      var pts = [];
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        var x = r.x + t * r.w + jit(rnd, o.thickness * 0.5);
        var y = cy + Math.sin(t * cycles * Math.PI * 2 + phase) * amp * (0.7 + rnd() * 0.6) +
                (p ? o.thickness * 0.5 : 0);
        pts.push([x, y]);
      }
      out.push({ d: smooth(pts), w: o.thickness * 0.95 * passWeight(p), o: passAlpha(p) });
    }
    return out;
  }

  function gStrike(r, o, rnd) {
    var out = [];
    for (var p = 0; p < passCount(o); p++) {
      var n = clamp(Math.round(r.w / 30), 3, 70);
      var base = r.y + r.h * 0.58 + p * o.thickness * 0.6;
      var over = o.thickness * 2 * o.jitter;
      var pts = [];
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        var x = r.x + t * r.w;
        if (i === 0) x -= over * rnd();
        if (i === n) x += over * rnd();
        pts.push([x, base + jit(rnd, o.thickness * 0.9 * o.jitter)]);
      }
      out.push({ d: smooth(pts), w: o.thickness * passWeight(p), o: passAlpha(p) });
    }
    return out;
  }

  /* One fat round capped stroke through the middle of the line box, which
     reads as a highlighter far better than a rectangle does. */
  function gMarker(r, o, rnd) {
    var out = [];
    /* A second swipe of a highlighter makes the mark darker, not lighter,
       so these do not fade out the way the pen shapes do. */
    for (var p = 0; p < passCount(o); p++) {
      var n = clamp(Math.round(r.w / 40), 3, 40);
      var cy = r.y + r.h * 0.56 + (p ? jit(rnd, r.h * 0.12) : 0);
      var pts = [];
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        var x = r.x + t * r.w;
        if (i === 0) x -= r.h * (0.18 - p * 0.04);
        if (i === n) x += r.h * (0.22 - p * 0.05);
        pts.push([x, cy + jit(rnd, r.h * 0.2 * o.jitter)]);
      }
      out.push({ d: smooth(pts), w: r.h * (0.92 - p * 0.08), o: 1, cap: 'square' });
    }
    return out;
  }

  function gBox(r, o, rnd) {
    var out = [];
    var j = o.thickness * 1.2 * o.jitter;
    for (var p = 0; p < passCount(o); p++) {
      var pad = o.thickness * 2 + p * o.thickness * 0.9;
      var L = r.x - pad, R = r.x + r.w + pad, T = r.y - pad, B = r.y + r.h + pad;
      var pts = [];
      pushEdge(pts, L, T, R, T, clamp(Math.round(r.w / 45), 3, 20), rnd, j);
      pushEdge(pts, R, T, R, B, clamp(Math.round(r.h / 20), 2, 10), rnd, j);
      pushEdge(pts, R, B, L, B, clamp(Math.round(r.w / 45), 3, 20), rnd, j);
      pushEdge(pts, L, B, L, T, clamp(Math.round(r.h / 20), 2, 10), rnd, j);
      pts.push([L + jit(rnd, j), T + jit(rnd, j)]);
      pts.push([L + r.w * 0.06 + rnd() * r.w * 0.06, T + jit(rnd, j)]); // overshoot
      out.push({ d: smooth(pts), w: o.thickness * passWeight(p), o: passAlpha(p) });
    }
    return out;
  }

  function pushEdge(pts, x1, y1, x2, y2, steps, rnd, j) {
    for (var i = 0; i < steps; i++) {
      var t = i / steps;
      pts.push([x1 + (x2 - x1) * t + jit(rnd, j), y1 + (y2 - y1) * t + jit(rnd, j)]);
    }
  }

  function gCircle(r, o, rnd) {
    var out = [];
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    var rx = r.w / 2 + o.thickness * 3, ry = r.h / 2 + o.thickness * 3;
    for (var p = 0; p < passCount(o); p++) {
      var n = 48;
      var start = -Math.PI * 0.55 + rnd() * 0.35;
      var sweep = Math.PI * 2 * (1.05 + rnd() * 0.14);
      var pts = [];
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        var a = start + sweep * t;
        var wob = 1 + Math.sin(a * 2.3 + p) * 0.035 * o.jitter + jit(rnd, 0.022 * o.jitter);
        pts.push([cx + Math.cos(a) * rx * wob + p * 1.4, cy + Math.sin(a) * ry * wob]);
      }
      out.push({ d: smooth(pts), w: o.thickness * passWeight(p), o: passAlpha(p) });
    }
    return out;
  }

  function gBracket(r, o, rnd) {
    var pad = o.thickness * 2.5;
    var L = r.x - pad, R = r.x + r.w + pad, T = r.y - pad, B = r.y + r.h + pad;
    var arm = clamp(r.h * 0.3, 4, 26);
    var j = o.thickness * 1.1 * o.jitter;
    function side(x, dir, p) {
      var pts = [
        [x + dir * arm + jit(rnd, j), T + jit(rnd, j)],
        [x + jit(rnd, j), T + jit(rnd, j * 0.6)],
        [x + jit(rnd, j * 0.6), T + (B - T) * 0.5 + jit(rnd, j)],
        [x + jit(rnd, j), B + jit(rnd, j * 0.6)],
        [x + dir * arm + jit(rnd, j), B + jit(rnd, j)]
      ];
      return { d: smooth(pts), w: o.thickness * passWeight(p), o: passAlpha(p) };
    }
    var out = [];
    for (var p = 0; p < passCount(o); p++) {
      out.push(side(L - p, 1, p), side(R + p, -1, p));
    }
    return out;
  }

  function gCross(r, o, rnd) {
    var pad = o.thickness * 1.5;
    var L = r.x - pad, R = r.x + r.w + pad, T = r.y - pad, B = r.y + r.h + pad;
    var j = o.thickness * 1.4 * o.jitter;
    function diag(x1, y1, x2, y2, p) {
      var pts = [];
      for (var i = 0; i <= 6; i++) {
        var t = i / 6;
        pts.push([x1 + (x2 - x1) * t + jit(rnd, j), y1 + (y2 - y1) * t + jit(rnd, j)]);
      }
      return { d: smooth(pts), w: o.thickness * passWeight(p), o: passAlpha(p) };
    }
    var out = [];
    for (var p = 0; p < passCount(o); p++) {
      out.push(diag(L, T, R, B, p), diag(R, T, L, B, p));
    }
    return out;
  }

  /* One tapered mark: the top edge of a flat ellipse, full weight in the
     middle and thinning to a point at both ends. It has no wobble, which
     suits display type, where the pen shapes above get scaled up until they
     look scratchy. jitter only sets the tilt here, and passes is ignored
     because retracing a tapered mark just blunts its ends.

     A fill cannot be drawn on with a dash, so this returns the outline as
     `fill` and a spine as `d`. render() masks the outline with the spine and
     animates the spine like any other stroke. */
  function gSwoosh(r, o) {
    var t = o.thickness;
    /* At 2px thick under 24px type this is a 7px tall ellipse reaching 3px
       left and 4px right of the word. */
    var rx = (r.w + t * 3.5) / 2;
    var ry = t * 1.75;
    var cx = r.x - t * 1.5 + rx;
    var cy = r.y + r.h + t * 1.35;
    var tilt = -o.jitter; // degrees, and negative lifts the right end
    var a = tilt * Math.PI / 180;
    var dx = rx * Math.cos(a), dy = rx * Math.sin(a);
    var left = n2(cx - dx) + ' ' + n2(cy - dy);
    var right = n2(cx + dx) + ' ' + n2(cy + dy);
    /* The tips sit on the ends of the ellipse's long axis, so each arc is
       exactly half an ellipse and the sweep flag picks the top half. */
    function arc(radius, sweep, to) {
      return 'A' + n2(rx) + ' ' + n2(radius) + ' ' + n2(tilt) + ' 0 ' + sweep + ' ' + to;
    }
    return [{
      d: 'M' + left + arc(ry - t / 2, 1, right),
      fill: 'M' + left + arc(ry, 1, right) + arc(ry - t, 0, left) + 'Z',
      w: t * 2,
      cap: 'butt',
      o: 1
    }];
  }

  /* ----------------------------------------------------------- connectors */
  /* Arrow and curl join two elements rather than marking one. Their
     generators get a second rect, the element named by `to`, and return the
     shaft first with each head flagged `then`, so the reveal draws the line
     and only then flicks the head on. The routing, the head and the curl all
     follow the diagrams Mike Cann drew for Build Your Own Convex. */

  /* Where a connector leaves one box and arrives at the other. Boxes side by
     side join edge to edge across the space between them, boxes stacked
     above and below join bottom to top, and when there is space both ways
     the wider gap wins. dx, dy is the way the line is travelling as it
     leaves and as it arrives. Boxes that overlap have no facing sides, so
     there is nothing sensible to draw. */
  function facing(a, b, gap) {
    var ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    var bx = b.x + b.w / 2, by = b.y + b.h / 2;
    var hx = Math.max(b.x - a.x - a.w, a.x - b.x - b.w);
    var vy = Math.max(b.y - a.y - a.h, a.y - b.y - b.h);
    if (hx <= 0 && vy <= 0) return null;
    /* A gap wider than a third of the space would cross the two ends over. */
    var g;
    if (hx >= vy) {
      var s = bx > ax ? 1 : -1;
      g = Math.min(gap, hx / 3);
      return { sx: ax + s * (a.w / 2 + g), sy: ay, ex: bx - s * (b.w / 2 + g), ey: by, dx: s, dy: 0 };
    }
    var t = by > ay ? 1 : -1;
    g = Math.min(gap, vy / 3);
    return { sx: ax, sy: ay + t * (a.h / 2 + g), ex: bx, ey: by - t * (b.h / 2 + g), dx: 0, dy: t };
  }

  function connectorGap(o) { return o.gap != null ? o.gap : Math.max(4, o.thickness * 2.5); }

  function dist(a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function bez(p, t) {
    var u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0],
            a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]];
  }

  /* Walks a chain of cubic segments, dropping a point every `step` px or so,
     and jitters each one the way the pen shapes do before smooth() joins
     them back up. The jitter tapers to nothing at both ends, so the line
     still starts and stops exactly where it was aimed and the head sits on
     its tip. */
  function penAlong(segs, rnd) {
    var pts = [segs[0].p[0]], amps = [0];
    var s, i;
    for (s = 0; s < segs.length; s++) {
      var g = segs[s].p;
      var rough = (dist(g[0], g[1]) + dist(g[1], g[2]) + dist(g[2], g[3]) + dist(g[0], g[3])) / 2;
      var n = Math.max(2, Math.ceil(rough / segs[s].step));
      for (i = 1; i <= n; i++) { pts.push(bez(g, i / n)); amps.push(segs[s].amp); }
    }
    var last = pts.length - 1;
    for (i = 1; i < last; i++) {
      var taper = Math.sin(Math.PI * i / last);
      pts[i] = [pts[i][0] + jit(rnd, amps[i]) * taper, pts[i][1] + jit(rnd, amps[i]) * taper];
    }
    return pts;
  }

  /* An open chevron on one end of a line, angled to the way the line comes
     in over its last few px rather than to the straight line between the
     ends, so it still points true at the end of a curve. Both wings lean
     away from the shaft, so neither disappears into it. */
  function arrowHead(pts, end, o, rnd, p) {
    var step = end ? -1 : 1, i = end ? pts.length - 1 : 0;
    var tip = pts[i], back = tip, size = Math.max(7, o.thickness * 5.5);
    for (var j = i + step; j >= 0 && j < pts.length; j += step) {
      back = pts[j];
      if (dist(back, tip) >= size * 0.6) break;
    }
    var d = dist(back, tip) || 1;
    var ux = (tip[0] - back[0]) / d, uy = (tip[1] - back[1]) / d;
    var w = [];
    for (var side = 1; side >= -1; side -= 2) {
      var a = side * (0.5 + jit(rnd, 0.16 * o.jitter));
      var len = size * (1 + jit(rnd, 0.24 * o.jitter));
      var c = Math.cos(a), sn = Math.sin(a);
      /* Back along the shaft, swung out to one side. */
      w.push([tip[0] - len * (ux * c - uy * sn), tip[1] - len * (ux * sn + uy * c)]);
    }
    return {
      d: 'M' + n2(w[0][0]) + ' ' + n2(w[0][1]) + 'L' + n2(tip[0]) + ' ' + n2(tip[1]) +
         'L' + n2(w[1][0]) + ' ' + n2(w[1][1]),
      w: o.thickness * passWeight(p),
      o: passAlpha(p),
      then: true,
      span: 0.3
    };
  }

  function pushHeads(out, pts, o, rnd, p) {
    if (o.head === 'end' || o.head === 'both') out.push(arrowHead(pts, true, o, rnd, p));
    if (o.head === 'start' || o.head === 'both') out.push(arrowHead(pts, false, o, rnd, p));
  }

  /* Leaves the middle of one box's facing side and arrives square on the
     other's, on an S whose two bends sit halfway across the space between
     them. jitter adds a bow, so two boxes level with each other get a hand
     drawn arc rather than a ruled line. At jitter 0 it is a clean curve. */
  function gArrow(r, o, rnd, to) {
    var f = facing(r, to, connectorGap(o));
    if (!f) return [];
    var reach = Math.abs(f.dx ? f.ex - f.sx : f.ey - f.sy) / 2;
    var nx = -f.dy, ny = f.dx;
    var bow = jit(rnd, dist([f.sx, f.sy], [f.ex, f.ey]) * 0.14) * o.jitter;
    var out = [];
    for (var p = 0; p < passCount(o); p++) {
      var b = bow + (p ? jit(rnd, o.thickness * 2 * o.jitter) : 0);
      var pts = penAlong([{
        p: [[f.sx, f.sy],
            [f.sx + f.dx * reach + nx * b, f.sy + f.dy * reach + ny * b],
            [f.ex - f.dx * reach + nx * b, f.ey - f.dy * reach + ny * b],
            [f.ex, f.ey]],
        step: 28,
        amp: o.thickness * 0.9 * o.jitter
      }], rnd);
      out.push({ d: smooth(pts), w: o.thickness * passWeight(p), o: passAlpha(p) });
      pushHeads(out, pts, o, rnd, p);
    }
    return out;
  }

  /* The curl's control points, as px along the way out and px off to one
     side, for a line CURL_PEN px thick. Thicker lines get a bigger loop. It
     heads out, loops back on itself once, and the last point aims the run
     to the target, which reads as a note dashed off in the margin rather
     than a diagram. The loop reaches 46 units out. */
  var CURL_PEN = 1.7;
  var CURL = [[28, -12], [46, 4], [36, 22], [24, 40], [10, 17], [32, 15], [46, 13]];

  function curlPoint(c, f, k, side, nx, ny, rnd, wob) {
    var fw = (c[0] + jit(rnd, wob)) * k, sd = (c[1] + jit(rnd, wob)) * k * side;
    return [f.sx + f.dx * fw + nx * sd, f.sy + f.dy * fw + ny * sd];
  }

  /* An arrow with a small loop just after it sets off. The loop curls
     towards the side the target is on, or downwards (rightwards, for a line
     travelling vertically) when the target is dead ahead, and never takes
     more than half the distance between the ends. */
  function gCurl(r, o, rnd, to) {
    var f = facing(r, to, connectorGap(o));
    if (!f) return [];
    var S = [f.sx, f.sy], E = [f.ex, f.ey];
    var nx = f.dy, ny = -f.dx;
    var lean = (E[0] - S[0]) * nx + (E[1] - S[1]) * ny;
    var side = Math.abs(lean) > o.thickness ? (lean > 0 ? 1 : -1) : ((f.dx ? ny : nx) > 0 ? 1 : -1);
    var k = Math.min(clamp(o.thickness / CURL_PEN, 0.85, 2.4), dist(S, E) * 0.5 / 46);
    var fine = o.thickness * 0.3 * o.jitter;
    var out = [];
    for (var p = 0; p < passCount(o); p++) {
      var c = [];
      for (var i = 0; i < CURL.length; i++) c.push(curlPoint(CURL[i], f, k, side, nx, ny, rnd, 4 * o.jitter));
      /* The run to the target leaves the loop the way the last point aims it
         and comes in square on the target's side, a touch off the line so it
         lands with a little hook. */
      var run = dist(c[5], E);
      var aim = dist(c[5], c[6]) || 1;
      var lead = Math.max(14 * k, run * 0.18);
      var land = Math.max(24 * k, run * 0.16);
      var c1 = [c[5][0] + (c[6][0] - c[5][0]) / aim * lead, c[5][1] + (c[6][1] - c[5][1]) / aim * lead];
      var c2 = [E[0] - f.dx * land - nx * 8 * k * side, E[1] - f.dy * land - ny * 8 * k * side];
      var pts = penAlong([
        { p: [S, c[0], c[1], c[2]], step: 6, amp: fine },
        { p: [c[2], c[3], c[4], c[5]], step: 6, amp: fine },
        { p: [c[5], c1, c2, E], step: 28, amp: o.thickness * 0.9 * o.jitter }
      ], rnd);
      out.push({ d: smooth(pts), w: o.thickness * passWeight(p), o: passAlpha(p) });
      pushHeads(out, pts, o, rnd, p);
    }
    return out;
  }

  var GENERATORS = {
    underline: gUnderline, curve: gCurve, double: gDouble, scribble: gScribble,
    strike: gStrike, marker: gMarker, box: gBox, circle: gCircle,
    bracket: gBracket, cross: gCross, swoosh: gSwoosh,
    arrow: gArrow, curl: gCurl
  };

  /* Masks need document-unique ids, and a redraw builds fresh ones. */
  var maskSeq = 0;

  var DEFAULT_OPACITY = { marker: 0.32 };

  /* -------------------------------------------------------------- instance */

  function Annotation(el, opts) {
    this.el = el;
    this.opts = opts;
    this.svg = null;
    this.strokes = [];
    this._seq = [];
    this.shown = false;
    this._hidden = false;
    this._revealed = false;
    this._host = null;
    this._io = null;
    this._ro = null;
    this._anims = null;
    this._revealTimer = null;
  }

  Annotation.prototype._stopAnims = function () {
    if (!this._anims) return;
    for (var i = 0; i < this._anims.length; i++) {
      try { this._anims[i].cancel(); } catch (e) { /* already gone */ }
    }
    this._anims = null;
  };

  Annotation.prototype._muted = function (o) {
    return o.respectReducedMotion !== false && prefersReduced();
  };

  Annotation.prototype._resolve = function () {
    var cs = window.getComputedStyle(this.el);
    var fontSize = parseFloat(cs.fontSize) || 16;
    var o = {};
    for (var k in this.opts) { if (hasOwn(this.opts, k)) o[k] = this.opts[k]; }
    /* Normalise an unknown shape here rather than at the generator lookup.
       PER_LINE and DEFAULT_OPACITY are keyed on the same string, so a typo
       used to fall back to underline's geometry but not to its per line
       layout, and wrapped text got one stroke under the whole run. */
    if (!GENERATORS[o.type]) o.type = 'underline';
    o.thickness = o.thickness != null ? o.thickness : Math.max(1.4, fontSize * 0.085);
    o.color = o.color || cs.color || '#000';
    o.jitter = o.jitter == null ? 1 : o.jitter;
    if (o.opacity == null) o.opacity = DEFAULT_OPACITY[o.type] != null ? DEFAULT_OPACITY[o.type] : 1;
    var link = !!CONNECTORS[o.type];
    /* A connector usually ends on something with a background of its own,
       a card or a code block, and behind that it would vanish. */
    if (o.front == null) o.front = link;
    if (link) {
      /* The pen always sets off from this element. To point the other way,
         swap the ends or set head to 'start'. */
      o.direction = 'right';
      if (o.head !== 'start' && o.head !== 'both' && o.head !== 'none') o.head = 'end';
    }
    return o;
  };

  Annotation.prototype.render = function () {
    this.destroySvg();
    var el = this.el;
    if (!el.parentNode || !el.getClientRects || !el.getClientRects().length) return this;

    var o = this._resolve();
    var parent = el.parentNode;
    var to = null;
    if (CONNECTORS[o.type]) {
      to = toElement(o.to);
      if (!to || to === el || !to.getClientRects().length) return this;
      parent = toElement(o.within) || sharedHost(el, to);
    }
    if (!parent || !parent.getBoundingClientRect) return this;

    var pRect = parent.getBoundingClientRect();
    var pcs = window.getComputedStyle(parent);
    /* Remember what the host looked like before any annotation touched it,
       so the last one to leave can put it back. The record lives on the host
       itself: kept per annotation, a second one arriving later saved the
       first one's position: relative as the original, and the host never
       got its own value back. */
    if (this._host !== parent) {
      this._releaseHost();
      this._host = parent;
      if (!parent.__scrawlHost) {
        parent.__scrawlHost = { pos: parent.style.position, iso: parent.style.isolation };
      }
    }
    if (pcs.position === 'static') parent.style.position = 'relative';
    /* The stroke sits at z-index -1 so the glyphs stay on top. Without a
       stacking context on the parent, that -1 escapes all the way to the
       root and hides behind any ancestor's background. isolation pins it. */
    if (!o.front && pcs.isolation !== 'isolate') parent.style.isolation = 'isolate';
    var bl = parseFloat(pcs.borderLeftWidth) || 0;
    var bt = parseFloat(pcs.borderTopWidth) || 0;

    /* getClientRects and getBoundingClientRect both report post transform
       viewport pixels, but the left/top we write below are read back in the
       parent's own untransformed space and then scaled again. Divide any
       ancestor scale out first. The deadband keeps offsetWidth's integer
       rounding from adding drift in the ordinary unscaled case. */
    var sx = 1, sy = 1, ratio;
    if (parent.offsetWidth > 0 && pRect.width > 0) {
      ratio = pRect.width / parent.offsetWidth;
      if (Math.abs(ratio - 1) > 0.005) sx = ratio;
    }
    if (parent.offsetHeight > 0 && pRect.height > 0) {
      ratio = pRect.height / parent.offsetHeight;
      if (Math.abs(ratio - 1) > 0.005) sy = ratio;
    }

    /* A connector may point at an empty span dropped in as a marker, which
       has height but no width, so its ends keep thin boxes. */
    function measure(node, thin) {
      var list = node.getClientRects(), out = [];
      for (var j = 0; j < list.length; j++) {
        var r = list[j];
        if (r.width < 0.5 && !(thin && r.height > 0)) continue;
        out.push({
          x: (r.left - pRect.left) / sx - bl + parent.scrollLeft,
          y: (r.top - pRect.top) / sy - bt + parent.scrollTop,
          w: r.width / sx,
          h: r.height / sy
        });
      }
      return out;
    }

    var i;
    var boxes = measure(el, !!to);
    if (!boxes.length) return this;

    var targets, toBox = null;
    if (to) {
      var toBoxes = measure(to, true);
      if (!toBoxes.length) return this;
      /* An inline end that wraps is several line boxes. Join the pair that
         sit nearest each other, because the union of a wrapped run would
         aim the arrow at the middle of its paragraph. */
      targets = [nearestBox(boxes, unionOf(toBoxes))];
      toBox = nearestBox(toBoxes, targets[0]);
    } else {
      targets = PER_LINE[o.type] ? boxes : [unionOf(boxes)];
    }

    /* Draw in a generously padded space so overshoot, marker width and
       circle sweep all fit. fitToInk() then shrinks the box to what was
       drawn, because an empty padded box still counts towards the page's
       scroll width and pushed narrow phone layouts sideways. */
    var pad = Math.max(o.thickness * 6, targets[0].h * 0.9, 14);
    var u = unionOf(toBox ? [targets[0], toBox] : targets);
    var ox = u.x - pad, oy = u.y - pad;
    var W = u.w + pad * 2, H = u.h + pad * 2;

    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'scrawl-svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', '0 0 ' + n2(W) + ' ' + n2(H));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var s = svg.style;
    s.position = 'absolute';
    s.left = n2(ox) + 'px';
    s.top = n2(oy) + 'px';
    s.width = n2(W) + 'px';
    s.height = n2(H) + 'px';
    s.pointerEvents = 'none';
    s.overflow = 'visible';
    s.zIndex = o.front ? '1' : '-1';

    var seed = o.seed != null ? (typeof o.seed === 'number' ? o.seed : hashString(String(o.seed)))
                              : hashString((el.textContent || '') + (to ? to.textContent || '' : '') + o.type);
    var rnd = makeRng(seed);
    var gen = GENERATORS[o.type] || GENERATORS.underline;
    var toLocal = toBox ? { x: toBox.x - ox, y: toBox.y - oy, w: toBox.w, h: toBox.h } : undefined;

    this.strokes = [];
    this._seq = [];
    var inks = [];
    for (i = 0; i < targets.length; i++) {
      var local = {
        x: targets[i].x - ox, y: targets[i].y - oy,
        w: targets[i].w, h: targets[i].h
      };
      var defs = gen(local, o, rnd, toLocal);
      for (var k = 0; k < defs.length; k++) {
        var path = document.createElementNS(SVGNS, 'path');
        var opacity = (defs[k].o != null ? defs[k].o : 1) * o.opacity;
        path.setAttribute('d', defs[k].d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', o.color);
        path.setAttribute('stroke-width', n2(defs[k].w));
        path.setAttribute('stroke-linecap', defs[k].cap || 'round');
        path.setAttribute('stroke-linejoin', 'round');
        if (defs[k].fill) {
          /* The spine strokes white inside a mask, so the outline shows
             wherever the spine has reached. Hide, reveal and animation all
             keep working on the spine in this.strokes. */
          var mask = document.createElementNS(SVGNS, 'mask');
          var maskId = 'scrawl-mask-' + (++maskSeq);
          mask.setAttribute('id', maskId);
          mask.setAttribute('maskUnits', 'userSpaceOnUse');
          /* The default mask region is a percentage of the viewport, which
             fitToInk() shrinks, so pin it to the whole drawing space. */
          mask.setAttribute('x', 0);
          mask.setAttribute('y', 0);
          mask.setAttribute('width', n2(W));
          mask.setAttribute('height', n2(H));
          path.setAttribute('stroke', '#fff');
          mask.appendChild(path);
          svg.appendChild(mask);
          var shape = document.createElementNS(SVGNS, 'path');
          shape.setAttribute('d', defs[k].fill);
          shape.setAttribute('fill', o.color);
          shape.setAttribute('mask', 'url(#' + maskId + ')');
          shape.setAttribute('opacity', opacity);
          svg.appendChild(shape);
          inks.push({ node: shape, reach: 0 });
        } else {
          path.setAttribute('opacity', opacity);
          svg.appendChild(path);
          /* A square cap's corner can sit half the width out on both axes. */
          inks.push({ node: path, reach: defs[k].w / 2 * (defs[k].cap === 'square' ? Math.SQRT2 : 1) });
        }
        this.strokes.push(path);
        this._seq.push({ then: !!defs[k].then, span: defs[k].span || 1 });
      }
    }

    /* A connector between overlapping boxes draws nothing, and an empty SVG
       left in the page still has its padded size. */
    if (!this.strokes.length) return this;
    parent.appendChild(svg);
    fitToInk(svg, inks, ox, oy);
    this.svg = svg;
    this._resolved = o;

    if (this.shown) this._paint(false);
    else this._hideStrokes(this._hidden);
    return this;
  };

  Annotation.prototype._hideStrokes = function (force) {
    var o = this._resolved || this.opts;
    if (!o.animate || this._muted(o)) {
      /* Nothing to arm, so the only way to take the strokes back off the page
         is to hide the SVG. Only when hide() asked: a first render with
         animate off is still meant to paint. */
      if (force && this.svg) this.svg.style.visibility = 'hidden';
      return;
    }
    for (var i = 0; i < this.strokes.length; i++) {
      var len = safeLength(this.strokes[i]);
      var st = this.strokes[i].style;
      st.transition = 'none';
      st.strokeDasharray = len + ' ' + len;
      st.strokeDashoffset = (o.direction === 'left' ? -len : len);
    }
  };

  Annotation.prototype._paint = function (animate) {
    var o = this._resolved || this.opts;
    var doAnim = animate && o.animate && !this._muted(o);
    var i, node, st;

    this._stopAnims();
    if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
    /* render() bails without an SVG for an element with no line boxes, a
       display:none ancestor or no parent. Painting one anyway used to throw
       out of init() and take every later annotation on the page with it. */
    if (!this.svg || !this.strokes.length) return;

    this._hidden = false;
    this.svg.style.visibility = '';

    if (!doAnim) {
      for (i = 0; i < this.strokes.length; i++) {
        st = this.strokes[i].style;
        st.transition = 'none';
        st.strokeDasharray = 'none';
        st.strokeDashoffset = '0';
      }
      this._revealed = true;
      return;
    }

    this._revealed = false;
    /* The Web Animations API rather than a CSS transition. A page level
       "* { transition: none }", which plenty of resets and reduced motion
       blocks ship, silently kills a transition based reveal and leaves you
       staring at a finished stroke wondering what broke. WAAPI ignores that
       entirely. Falls back to a transition where element.animate is missing. */
    var waapi = this.strokes.length && typeof this.strokes[0].animate === 'function';
    var total = o.delay + o.duration;
    var times = this._timing(o);
    this._anims = [];

    for (i = 0; i < this.strokes.length; i++) {
      node = this.strokes[i];
      st = node.style;
      var len = safeLength(node);
      var from = (o.direction === 'left' ? -len : len);
      total = Math.max(total, times[i].wait + times[i].dur);
      st.strokeDasharray = len + ' ' + len;

      if (waapi) {
        st.transition = 'none';
        st.strokeDashoffset = '0';
        this._anims.push(node.animate(
          [{ strokeDashoffset: from }, { strokeDashoffset: 0 }],
          { duration: times[i].dur, delay: times[i].wait, easing: EASE, fill: 'backwards' }
        ));
      } else {
        st.transition = 'none';
        st.strokeDashoffset = from;
      }
    }

    if (!waapi) {
      void this.svg.getBoundingClientRect(); // reflow so the transition takes
      for (i = 0; i < this.strokes.length; i++) {
        this.strokes[i].style.transition = 'stroke-dashoffset ' + (times[i].dur / 1000) +
          's ' + EASE + ' ' + (times[i].wait / 1000) + 's';
        this.strokes[i].style.strokeDashoffset = '0';
      }
    }

    /* Once the reveal has played out there is nothing left to protect, so a
       later resize or font swap can repaint statically. */
    var self = this;
    this._revealTimer = setTimeout(function () {
      self._revealed = true;
      self._revealTimer = null;
    }, total + 60);
  };

  /* When each stroke starts and how long it runs. Strokes set off a stagger
     apart, except one flagged `then`, which waits for the stroke before it
     to all but finish. That is how an arrowhead lands once its shaft has
     arrived rather than part way along it. The ease out leaves the last
     fifth of a stroke barely moving, so waiting for all of it reads as a
     pause. */
  Annotation.prototype._timing = function (o) {
    var out = [], n = 0;
    for (var i = 0; i < this.strokes.length; i++) {
      var seq = this._seq[i] || {};
      var prev = out[i - 1];
      out.push({
        wait: seq.then && prev ? prev.wait + prev.dur * 0.8 : o.delay + (n++) * o.duration * o.stagger,
        dur: o.duration * (seq.span || 1)
      });
    }
    return out;
  };

  Annotation.prototype.show = function (animate) {
    this.shown = true;
    if (!this.svg) this.render();
    this._paint(animate !== false);
    return this;
  };

  Annotation.prototype.hide = function () {
    this.shown = false;
    this._hidden = true;
    /* A running WAAPI animation outranks the style attribute, so without
       cancelling it first the stroke carries on drawing itself in and then
       snaps away when the fill ends. */
    this._stopAnims();
    if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
    this._revealed = false;
    this._hideStrokes(true);
    return this;
  };

  Annotation.prototype.refresh = function () {
    var wasShown = this.shown;
    /* render() paints statically on the way through and sets this flag, so
       read it first. A refresh that lands mid reveal (a late web font, a
       resize) replays the animation rather than snapping it to the end. */
    var wasRevealed = this._revealed;
    this.render();
    if (wasShown) this._paint(!wasRevealed);
    return this;
  };

  Annotation.prototype.destroySvg = function () {
    this._stopAnims();
    if (this.svg && this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
    this.svg = null;
    this.strokes = [];
    this._seq = [];
  };

  /* Only the last annotation drawing into a host restores it, or two in the
     same paragraph would undo each other. */
  Annotation.prototype._releaseHost = function () {
    var host = this._host;
    this._host = null;
    if (!host) return;
    for (var j = 0; j < registry.length; j++) {
      if (registry[j] !== this && registry[j]._host === host) return;
    }
    var saved = host.__scrawlHost;
    if (!saved) return;
    host.style.position = saved.pos;
    host.style.isolation = saved.iso;
    host.__scrawlHost = null;
  };

  Annotation.prototype.remove = function () {
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
    var idx = registry.indexOf(this);
    if (idx > -1) registry.splice(idx, 1);
    if (this.el && this.el.__scrawl === this) this.el.__scrawl = null;
    this._releaseHost();
    this.destroySvg();
    return this;
  };

  Annotation.prototype.observe = function () {
    var self = this;
    if (!('IntersectionObserver' in window)) { this.show(true); return this; }
    if (this._io) { this._io.disconnect(); this._io = null; }
    /* The constructor throws on a non-finite or out of range threshold, and
       that throw would escape init() and leave every later element blank. */
    var th = this.opts.threshold;
    if (typeof th !== 'number' || !isFinite(th)) th = DEFAULTS.threshold;
    th = clamp(th, 0, 1);
    this._io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          self.show(true);
          if (!self.opts.repeat && self._io) { self._io.disconnect(); self._io = null; }
        } else if (self.opts.repeat) {
          self.hide();
        }
      }
    }, { threshold: th });
    this._io.observe(this.el);
    return this;
  };

  /* ---------------------------------------------------------------- helpers */

  function hasOwn(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }

  function unionOf(boxes) {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (var i = 0; i < boxes.length; i++) {
      x1 = Math.min(x1, boxes[i].x);
      y1 = Math.min(y1, boxes[i].y);
      x2 = Math.max(x2, boxes[i].x + boxes[i].w);
      y2 = Math.max(y2, boxes[i].y + boxes[i].h);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function nearestBox(boxes, ref) {
    var cx = ref.x + ref.w / 2, cy = ref.y + ref.h / 2;
    var best = boxes[0], bestD = Infinity;
    for (var i = 0; i < boxes.length; i++) {
      var dx = boxes[i].x + boxes[i].w / 2 - cx, dy = boxes[i].y + boxes[i].h / 2 - cy;
      if (dx * dx + dy * dy < bestD) { bestD = dx * dx + dy * dy; best = boxes[i]; }
    }
    return best;
  }

  /* An element or a selector. A selector that does not parse throws, and
     that throw would escape init() and leave every later element blank. */
  function toElement(v) {
    if (!v) return null;
    if (typeof v === 'string') {
      try { return document.querySelector(v); } catch (e) { return null; }
    }
    return v.nodeType === 1 ? v : null;
  }

  /* A connector's SVG has to sit somewhere both ends can be measured from,
     so it goes in the nearest ancestor holding the pair. An inline or
     display: contents box makes a poor positioning context, so those are
     passed over, and the root element hands off to body. */
  function sharedHost(a, b) {
    for (var n = a.parentNode; n && n.nodeType === 1; n = n.parentNode) {
      if (n === b || !n.contains(b)) continue;
      if (n === document.documentElement) break;
      var d = window.getComputedStyle(n).display;
      if (d !== 'contents' && d !== 'inline') return n;
    }
    return document.body;
  }

  /* Shrinks an annotation's SVG to the paint it holds. The paths keep their
     coordinates in the padded drawing space, and only the viewBox and the
     box move, so nothing on screen shifts. getBBox() is geometry only, so
     each path's stroke reach is added back, plus a pixel for anti-aliasing.
     If a browser cannot measure a path, the padded box stays. */
  function fitToInk(svg, inks, ox, oy) {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (var i = 0; i < inks.length; i++) {
      var bb;
      try { bb = inks[i].node.getBBox(); } catch (e) { return; }
      var m = inks[i].reach + 1;
      x1 = Math.min(x1, bb.x - m);
      y1 = Math.min(y1, bb.y - m);
      x2 = Math.max(x2, bb.x + bb.width + m);
      y2 = Math.max(y2, bb.y + bb.height + m);
    }
    if (!(x2 > x1 && y2 > y1)) return;
    /* Whole pixel steps from the padded origin keep the box's fractional
       offset, so the strokes land on the same sub-pixel positions. */
    x1 = Math.floor(x1); y1 = Math.floor(y1);
    var w = Math.ceil(x2) - x1, h = Math.ceil(y2) - y1;
    svg.setAttribute('width', n2(w));
    svg.setAttribute('height', n2(h));
    svg.setAttribute('viewBox', n2(x1) + ' ' + n2(y1) + ' ' + n2(w) + ' ' + n2(h));
    var s = svg.style;
    s.left = n2(ox + x1) + 'px';
    s.top = n2(oy + y1) + 'px';
    s.width = n2(w) + 'px';
    s.height = n2(h) + 'px';
  }

  function safeLength(node) {
    var len = 0;
    try { len = node.getTotalLength(); } catch (e) { len = 0; }
    return len || 1;
  }

  function prefersReduced() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* Values that would throw or draw nothing at the far end. WAAPI rejects a
     negative duration, IntersectionObserver rejects a threshold outside 0..1. */
  function clampOption(name, v) {
    if (name === 'threshold') return clamp(v, 0, 1);
    if (name === 'duration' || name === 'delay' || name === 'stagger') return Math.max(0, v);
    if (name === 'opacity') return clamp(v, 0, 1);
    if (name === 'thickness' || name === 'jitter' || name === 'passes' || name === 'gap') return Math.max(0, v);
    return v;
  }

  var NUMERIC = { thickness: 1, opacity: 1, passes: 1, jitter: 1, duration: 1, delay: 1, stagger: 1, threshold: 1, gap: 1 };
  var BOOLEAN = { animate: 1, front: 1, repeat: 1, respectReducedMotion: 1 };

  function readAttrs(el) {
    var o = {};
    var d = el.dataset || {};
    if (d.scrawl) o.type = d.scrawl;
    for (var key in d) {
      if (!hasOwn(d, key) || key === 'scrawl') continue;
      if (key.indexOf('scrawl') !== 0) continue;
      var name = key.charAt(6).toLowerCase() + key.slice(7);
      var raw = d[key];
      if (NUMERIC[name]) {
        /* A mistyped number used to sail through as NaN: every guard below
           tests != null, so it reached the generators and produced a path of
           "MNaN NaN", or reached element.animate and threw. Drop the key
           instead and let the default merge cover it. */
        var num = parseFloat(raw);
        if (isFinite(num)) o[name] = clampOption(name, num);
      } else if (BOOLEAN[name]) o[name] = !(raw === 'false' || raw === '0');
      /* A numeric looking seed has to become a number, because a number
         supplied from JS is used raw while a string is hashed. Same value in
         an attribute and in an options object, same wobble. */
      else if (name === 'seed' && /^-?\d+(?:\.\d+)?$/.test(raw)) o[name] = parseFloat(raw);
      else o[name] = raw;
    }
    return o;
  }

  var registry = [];
  var rafPending = false;

  function refreshAll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      for (var i = 0; i < registry.length; i++) registry[i].refresh();
    });
  }

  /* Strokes are revealed on scroll, so anything below the fold would print
     blank, and paper lays the text out again, so strokes measured on screen
     would print beside their words. beforeprint only fixes the first part:
     Chrome still reports the screen's line boxes there. Once the print media
     query matches they are the paper's, so every annotation is redrawn then.
     Firefox prints a static copy of the page without running script, so it
     only gets the reveal. When printing ends, each annotation is measured on
     screen again and put back how it was, so one the reader has not reached
     yet still draws itself on when they scroll to it. */
  var printState = null;

  function startPrint(measure) {
    var i, a;
    if (!printState) {
      printState = [];
      for (i = 0; i < registry.length; i++) {
        a = registry[i];
        printState.push({ a: a, shown: a.shown, hidden: a._hidden });
      }
    }
    for (i = 0; i < registry.length; i++) {
      a = registry[i];
      if (measure) {
        a.shown = true;
        a.render();
      } else {
        a.show(false);
      }
    }
  }

  function endPrint() {
    if (!printState) return;
    var saved = printState;
    printState = null;
    for (var i = 0; i < saved.length; i++) {
      var a = saved[i].a;
      if (registry.indexOf(a) < 0) continue;
      a.shown = saved[i].shown;
      a._hidden = saved[i].hidden;
      a.render();
    }
  }

  /* ------------------------------------------------------------------- API */

  function annotate(el, opts) {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return null;
    var merged = {};
    var k;
    for (k in DEFAULTS) { if (hasOwn(DEFAULTS, k)) merged[k] = DEFAULTS[k]; }
    var fromAttrs = readAttrs(el);
    for (k in fromAttrs) { if (hasOwn(fromAttrs, k)) merged[k] = fromAttrs[k]; }
    if (opts) { for (k in opts) { if (hasOwn(opts, k)) merged[k] = opts[k]; } }

    var inst = new Annotation(el, merged);
    registry.push(inst);
    el.__scrawl = inst;
    inst.render();

    if ('ResizeObserver' in window && el.parentNode) {
      /* A connector also redraws when either end changes size, because a
         card growing in place moves the side its arrow leaves from without
         the host noticing. */
      var watched = [el.parentNode];
      if (CONNECTORS[merged.type]) {
        var far = toElement(merged.to);
        watched = [inst._host || el.parentNode, el];
        if (far && far !== watched[0]) watched.push(far);
      }
      watchSizes(inst, watched);
    }
    return inst;
  }

  /* observe() delivers a callback straight away for each element it is
     given. Redrawing on that first delivery would tear down the SVG we have
     only just built, so each element's first size is only noted, and the
     redraw waits until one of them has actually moved. */
  function watchSizes(inst, nodes) {
    var seen = [];
    inst._ro = new ResizeObserver(function (entries) {
      var moved = false;
      for (var i = 0; i < entries.length; i++) {
        var box = entries[i].contentRect, last = null;
        for (var j = 0; j < seen.length; j++) {
          if (seen[j].node === entries[i].target) { last = seen[j]; break; }
        }
        if (!last) {
          seen.push({ node: entries[i].target, w: box.width, h: box.height });
          continue;
        }
        if (Math.abs(box.width - last.w) > 0.5 || Math.abs(box.height - last.h) > 0.5) moved = true;
        last.w = box.width;
        last.h = box.height;
      }
      if (moved) inst.refresh();
    });
    for (var i = 0; i < nodes.length; i++) inst._ro.observe(nodes[i]);
  }

  function init(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-scrawl]');
    var made = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].__scrawl) continue;
      var inst = annotate(nodes[i]);
      if (!inst) continue;
      /* One bad element must not cost the rest of the page its strokes. */
      try { inst.observe(); }
      catch (e) { inst.show(true); }
      made.push(inst);
    }
    return made;
  }

  var api = {
    version: '0.2.0',
    shapes: SHAPES,
    defaults: DEFAULTS,
    annotate: annotate,
    init: init,
    refresh: refreshAll,
    instances: registry,
    generators: GENERATORS, // add your own: Scrawl.generators.myShape = fn
    perLine: PER_LINE,      // Scrawl.perLine.myShape = 1 for one stroke per line box
    connectors: CONNECTORS, // Scrawl.connectors.myShape = 1 for one that joins el to opts.to
    rng: makeRng
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', refreshAll);
    window.addEventListener('beforeprint', function () { startPrint(false); });
    window.addEventListener('afterprint', endPrint);
    /* Some browsers only signal printing through this query, and it is where
       Chrome has the paper layout ready to measure. */
    if (window.matchMedia) {
      var printQuery = window.matchMedia('print');
      if (printQuery.addEventListener) {
        printQuery.addEventListener('change', function (e) {
          if (e.matches) startPrint(true);
          else endPrint();
        });
      }
    }
    if (document.fonts) {
      if (document.fonts.ready) document.fonts.ready.then(refreshAll).catch(function () {});
      /* ready is a one shot: it settles as soon as the fonts needed at that
         instant have loaded, which on a page that has not painted any text yet
         is immediately. A font arriving after that would leave every stroke
         measured against the fallback metrics and visibly out of register, so
         listen for later batches as well. */
      if (document.fonts.addEventListener) {
        document.fonts.addEventListener('loadingdone', refreshAll);
      }
    }
    if (!window.SCRAWL_NO_AUTOINIT) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { init(); });
      } else {
        init();
      }
    }
  }

  return api;
}));
