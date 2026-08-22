/*!
 * Scrawl v0.1.0
 * Hand drawn annotation strokes for HTML text. No dependencies.
 * Draws seeded, slightly wonky SVG paths behind (or over) inline text,
 * one stroke per line box, with an optional draw on reveal.
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
    underline: 1, curve: 1, scribble: 1, marker: 1, strike: 1, double: 1
  };

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
    front: false,       // true paints over the glyphs instead of behind
    seed: null,         // any string or number, null hashes the text
    repeat: false,      // replay every time it scrolls back into view
    threshold: 0.2,     // IntersectionObserver visibility trigger
    respectReducedMotion: true // set false to draw even when the OS asks not to
  };

  var SHAPES = [
    'underline', 'curve', 'double', 'scribble', 'strike',
    'marker', 'box', 'circle', 'bracket', 'cross'
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

  /* Catmull-Rom through the points, emitted as cubic beziers. This is what
     turns a jittered point cloud into something that looks drawn rather
     than plotted. */
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

/* Passes are the pen going over the same mark again. Each repeat is a little
   thinner and lighter than the last, which is what reads as retracing rather
   than as one fat stroke. */
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

  var GENERATORS = {
    underline: gUnderline, curve: gCurve, double: gDouble, scribble: gScribble,
    strike: gStrike, marker: gMarker, box: gBox, circle: gCircle,
    bracket: gBracket, cross: gCross
  };

  var DEFAULT_OPACITY = { marker: 0.32 };

  /* -------------------------------------------------------------- instance */

  function Annotation(el, opts) {
    this.el = el;
    this.opts = opts;
    this.svg = null;
    this.strokes = [];
    this.shown = false;
    this._revealed = false;
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
    o.thickness = o.thickness != null ? o.thickness : Math.max(1.4, fontSize * 0.085);
    o.color = o.color || cs.color || '#000';
    o.jitter = o.jitter == null ? 1 : o.jitter;
    if (o.opacity == null) o.opacity = DEFAULT_OPACITY[o.type] != null ? DEFAULT_OPACITY[o.type] : 1;
    return o;
  };

  Annotation.prototype.render = function () {
    this.destroySvg();
    var el = this.el;
    var parent = el.parentNode;
    if (!parent || !el.getClientRects) return this;

    var rects = el.getClientRects();
    if (!rects.length) return this;

    var o = this._resolve();
    var pRect = parent.getBoundingClientRect();
    var pcs = window.getComputedStyle(parent);
    if (pcs.position === 'static') parent.style.position = 'relative';
    /* The stroke sits at z-index -1 so the glyphs stay on top. Without a
       stacking context on the parent, that -1 escapes all the way to the
       root and hides behind any ancestor's background. isolation pins it. */
    if (!o.front && pcs.isolation !== 'isolate') parent.style.isolation = 'isolate';
    var bl = parseFloat(pcs.borderLeftWidth) || 0;
    var bt = parseFloat(pcs.borderTopWidth) || 0;

    var boxes = [];
    var i;
    for (i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r.width < 0.5) continue;
      boxes.push({
        x: r.left - pRect.left - bl + parent.scrollLeft,
        y: r.top - pRect.top - bt + parent.scrollTop,
        w: r.width,
        h: r.height
      });
    }
    if (!boxes.length) return this;

    var perLine = !!PER_LINE[o.type];
    var targets = perLine ? boxes : [unionOf(boxes)];

    /* Pad generously so overshoot, marker width and circle sweep are not
       clipped by the SVG viewport. */
    var pad = Math.max(o.thickness * 6, targets[0].h * 0.9, 14);
    var u = unionOf(targets);
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
                              : hashString((el.textContent || '') + o.type);
    var rnd = makeRng(seed);
    var gen = GENERATORS[o.type] || GENERATORS.underline;

    this.strokes = [];
    for (i = 0; i < targets.length; i++) {
      var local = {
        x: targets[i].x - ox, y: targets[i].y - oy,
        w: targets[i].w, h: targets[i].h
      };
      var defs = gen(local, o, rnd);
      for (var k = 0; k < defs.length; k++) {
        var path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('d', defs[k].d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', o.color);
        path.setAttribute('stroke-width', n2(defs[k].w));
        path.setAttribute('stroke-linecap', defs[k].cap || 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('opacity', (defs[k].o != null ? defs[k].o : 1) * o.opacity);
        svg.appendChild(path);
        this.strokes.push(path);
      }
    }

    parent.appendChild(svg);
    this.svg = svg;
    this._resolved = o;

    if (this.shown) this._paint(false);
    else this._hideStrokes();
    return this;
  };

  Annotation.prototype._hideStrokes = function () {
    var o = this._resolved || this.opts;
    if (!o.animate || this._muted(o)) return;
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
    this._anims = [];

    for (i = 0; i < this.strokes.length; i++) {
      node = this.strokes[i];
      st = node.style;
      var len = safeLength(node);
      var from = (o.direction === 'left' ? -len : len);
      var wait = o.delay + i * o.duration * o.stagger;
      total = Math.max(total, wait + o.duration);
      st.strokeDasharray = len + ' ' + len;

      if (waapi) {
        st.transition = 'none';
        st.strokeDashoffset = '0';
        this._anims.push(node.animate(
          [{ strokeDashoffset: from }, { strokeDashoffset: 0 }],
          { duration: o.duration, delay: wait, easing: EASE, fill: 'backwards' }
        ));
      } else {
        st.transition = 'none';
        st.strokeDashoffset = from;
      }
    }

    if (!waapi) {
      void this.svg.getBoundingClientRect(); // reflow so the transition takes
      for (i = 0; i < this.strokes.length; i++) {
        this.strokes[i].style.transition = 'stroke-dashoffset ' + (o.duration / 1000) +
          's ' + EASE + ' ' + ((o.delay + i * o.duration * o.stagger) / 1000) + 's';
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

  Annotation.prototype.show = function (animate) {
    this.shown = true;
    if (!this.svg) this.render();
    this._paint(animate !== false);
    return this;
  };

  Annotation.prototype.hide = function () {
    this.shown = false;
    this._hideStrokes();
    return this;
  };

  Annotation.prototype.refresh = function () {
    var wasShown = this.shown;
    this.render();
    /* A refresh that lands mid reveal (a late web font, a resize) used to
       repaint statically and swallow the animation. Replay it instead. */
    if (wasShown) this._paint(!this._revealed);
    return this;
  };

  Annotation.prototype.destroySvg = function () {
    this._stopAnims();
    if (this.svg && this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
    this.svg = null;
    this.strokes = [];
  };

  Annotation.prototype.remove = function () {
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
    var idx = registry.indexOf(this);
    if (idx > -1) registry.splice(idx, 1);
    this.destroySvg();
    return this;
  };

  Annotation.prototype.observe = function () {
    var self = this;
    if (!('IntersectionObserver' in window)) { this.show(true); return this; }
    this._io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          self.show(true);
          if (!self.opts.repeat && self._io) { self._io.disconnect(); self._io = null; }
        } else if (self.opts.repeat) {
          self.hide();
        }
      }
    }, { threshold: this.opts.threshold });
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

  function safeLength(node) {
    var len = 0;
    try { len = node.getTotalLength(); } catch (e) { len = 0; }
    return len || 1;
  }

  function prefersReduced() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  var NUMERIC = { thickness: 1, opacity: 1, passes: 1, jitter: 1, duration: 1, delay: 1, stagger: 1, threshold: 1 };
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
      if (NUMERIC[name]) o[name] = parseFloat(raw);
      else if (BOOLEAN[name]) o[name] = !(raw === 'false' || raw === '0');
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
    inst.render();

    if ('ResizeObserver' in window && el.parentNode) {
      /* observe() delivers a callback immediately. Redrawing on that first
         delivery would tear down the SVG we have only just built, so skip it
         and only react once the parent's size has actually moved. */
      var lastW = -1, lastH = -1;
      inst._ro = new ResizeObserver(function (entries) {
        var box = entries[0] && entries[0].contentRect;
        if (!box) return;
        var settled = lastW >= 0;
        var moved = Math.abs(box.width - lastW) > 0.5 || Math.abs(box.height - lastH) > 0.5;
        lastW = box.width;
        lastH = box.height;
        if (settled && moved) inst.refresh();
      });
      inst._ro.observe(el.parentNode);
    }
    return inst;
  }

  function init(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-scrawl]');
    var made = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].__scrawl) continue;
      var inst = annotate(nodes[i]);
      if (!inst) continue;
      nodes[i].__scrawl = inst;
      inst.observe();
      made.push(inst);
    }
    return made;
  }

  var api = {
    version: '0.1.0',
    shapes: SHAPES,
    defaults: DEFAULTS,
    annotate: annotate,
    init: init,
    refresh: refreshAll,
    instances: registry,
    generators: GENERATORS, // add your own: Scrawl.generators.myShape = fn
    rng: makeRng
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', refreshAll);
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
