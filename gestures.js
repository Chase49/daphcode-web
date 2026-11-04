(function (root) {
  "use strict";

  const EXCLUDE = [
    ".minimap", ".scrollbar", ".suggest-widget", ".find-widget", ".monaco-hover",
    ".parameter-hints-widget", ".monaco-menu-container", ".context-view", ".quick-input-widget",
    ".rename-box", ".zone-widget", ".sticky-widget", ".monaco-inputbox",
  ].join(",");

  const HOLD_MS = 420;
  const SLOP = 9;
  const MULTI_TAP_MS = 330;
  const EDGE = 44;

  function attach(monaco, editor, host, handles, cb) {
    const T = monaco.editor.MouseTargetType;
    // Keyboard policy lives in the host: only a single tap on the text asks for the IME.
    const focusEd = (wantKeyboard) => (cb.focus ? cb.focus(!!wantKeyboard) : editor.focus());
    const pts = new Map();
    let mode = "idle";
    let start = null;
    let holdTimer = 0;
    let lastTap = { t: 0, x: 0, y: 0, n: 0, line: 0, col: 0 };
    let samples = [];
    let momentumRaf = 0;
    let axis = null;
    let pinch = null;
    let pinchRaf = 0;
    let pinchPending = 0;
    let anchor = null;
    let lastPoint = null;
    let edgeRaf = 0;
    let handleDrag = null;
    let enabled = true;

    const excluded = (t) => !!(t && t.closest && t.closest(EXCLUDE));
    const rect = () => host.getBoundingClientRect();

    function stopMomentum() {
      if (momentumRaf) cancelAnimationFrame(momentumRaf);
      momentumRaf = 0;
    }

    function clearHold() {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = 0;
    }

    function layoutInfo() {
      return editor.getLayoutInfo();
    }

    function positionAt(x, y) {
      const r = rect();
      const li = layoutInfo();
      const minX = r.left + li.contentLeft + 1;
      const maxX = r.left + li.contentLeft + li.contentWidth - li.verticalScrollbarWidth - 2;
      const cx = Math.max(minX, Math.min(maxX, x));
      const cy = Math.max(r.top + 1, Math.min(r.bottom - 2, y));
      const model = editor.getModel();
      if (!model) return null;
      // The selection handles (and their enlarged touch area) sit right under the finger while
      // selecting; if the hit-test lands on them Monaco reports "end of line" and the selection
      // jumps. Make them transparent to hit-testing for this lookup.
      const ha = handles.a.style.pointerEvents, hb = handles.b.style.pointerEvents;
      handles.a.style.pointerEvents = "none";
      handles.b.style.pointerEvents = "none";
      let t;
      try { t = editor.getTargetAtClientPoint(cx, cy); } finally { handles.a.style.pointerEvents = ha; handles.b.style.pointerEvents = hb; }
      if (t && t.position && t.type !== T.CONTENT_TEXT && t.type !== T.CONTENT_EMPTY && x >= minX) {
        // Hit something that is not text (a widget/decoration): fall back to the column under x.
        const col = columnAtX(t.position.lineNumber, cx - r.left);
        if (col) return { lineNumber: t.position.lineNumber, column: col };
      }
      if (t && t.position) {
        if (x < minX && t.type !== T.CONTENT_TEXT) return { lineNumber: t.position.lineNumber, column: 1 };
        return t.position;
      }
      const top = editor.getScrollTop() + (cy - r.top);
      const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
      const line = Math.max(1, Math.min(model.getLineCount(), Math.floor(top / lh) + 1));
      return { lineNumber: line, column: model.getLineMaxColumn(line) };
    }

    // Column whose left edge is closest to x (editor-relative px), using Monaco's own layout.
    function columnAtX(line, xRel) {
      const model = editor.getModel();
      if (!model || editor.getOption(monaco.editor.EditorOption.wordWrap) !== "off") return 0;
      const li = layoutInfo();
      const target = xRel - li.contentLeft + editor.getScrollLeft();
      let lo = 1, hi = model.getLineMaxColumn(line);
      if (editor.getOffsetForColumn(line, hi) < 0) return 0;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (editor.getOffsetForColumn(line, mid + 1) <= target) lo = mid + 1; else hi = mid;
      }
      const a = editor.getOffsetForColumn(line, lo);
      const b = lo < model.getLineMaxColumn(line) ? editor.getOffsetForColumn(line, lo + 1) : a;
      return target - a > (b - a) / 2 ? Math.min(lo + 1, model.getLineMaxColumn(line)) : lo;
    }

    function wordRange(pos) {
      const model = editor.getModel();
      const w = model.getWordAtPosition(pos);
      if (w) return new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn);
      const max = model.getLineMaxColumn(pos.lineNumber);
      if (pos.column < max) return new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column + 1);
      if (pos.column > 1) return new monaco.Range(pos.lineNumber, pos.column - 1, pos.lineNumber, pos.column);
      return new monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1);
    }

    function lineRange(line) {
      const model = editor.getModel();
      if (line < model.getLineCount()) return new monaco.Range(line, 1, line + 1, 1);
      return new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
    }

    function before(a, b) {
      return a.lineNumber < b.lineNumber || (a.lineNumber === b.lineNumber && a.column < b.column);
    }

    // Long-press selects the word; once the finger actually slides, the selection follows it
    // character by character (anchored at the word start going forward, word end going back),
    // so "someth" inside "(something)" can be selected.
    let slid = false;
    function extendTo(pos) {
      if (!anchor || !pos) return;
      const s = anchor.getStartPosition();
      const e = anchor.getEndPosition();
      let sel;
      if (before(pos, s)) sel = new monaco.Selection(e.lineNumber, e.column, pos.lineNumber, pos.column);
      else if (before(e, pos)) sel = new monaco.Selection(s.lineNumber, s.column, pos.lineNumber, pos.column);
      else if (slid && before(s, pos)) sel = new monaco.Selection(s.lineNumber, s.column, pos.lineNumber, pos.column);
      else sel = new monaco.Selection(s.lineNumber, s.column, e.lineNumber, e.column);
      editor.setSelection(sel);
    }

    function edgeLoop() {
      edgeRaf = 0;
      if ((mode !== "select" && mode !== "handle") || !lastPoint) return;
      const r = rect();
      let d = 0;
      if (lastPoint.y < r.top + EDGE) d = -Math.ceil((r.top + EDGE - lastPoint.y) / 3);
      else if (lastPoint.y > r.bottom - EDGE) d = Math.ceil((lastPoint.y - (r.bottom - EDGE)) / 3);
      if (d) {
        editor.setScrollTop(editor.getScrollTop() + d);
        if (mode === "select") extendTo(positionAt(lastPoint.x, lastPoint.y));
        else dragHandleTo(lastPoint.x, lastPoint.y);
      }
      edgeRaf = requestAnimationFrame(edgeLoop);
    }

    function ensureEdgeLoop() {
      if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeLoop);
    }

    function beginSelect() {
      holdTimer = 0;
      if (mode !== "pending" || !start) return;
      const pos = positionAt(start.x, start.y);
      if (!pos) return;
      const t = editor.getTargetAtClientPoint(start.x, start.y);
      if (t && (t.type === T.GUTTER_LINE_NUMBERS || t.type === T.GUTTER_LINE_DECORATIONS || t.type === T.GUTTER_GLYPH_MARGIN)) {
        anchor = lineRange(pos.lineNumber);
      } else {
        anchor = wordRange(pos);
      }
      mode = "select";
      slid = false;
      editor.setSelection(anchor);
      cb.haptic && cb.haptic();
      cb.onSelecting && cb.onSelecting();
      lastPoint = { x: start.x, y: start.y };
      ensureEdgeLoop();
    }

    function foldTap(line, el) {
      const model = editor.getModel();
      const contrib = editor.getContribution && editor.getContribution("editor.contrib.folding");
      // Toggle through the folding model directly. Monaco's fold/unfold *actions* reveal the
      // caret afterwards, which teleported the view to the caret when it was off-screen.
      const fmP = contrib && contrib.getFoldingModel ? contrib.getFoldingModel() : null;
      if (fmP && fmP.then) {
        const keep = { scrollTop: editor.getScrollTop(), scrollLeft: editor.getScrollLeft() };
        fmP.then((fm) => {
          if (!fm) return;
          const reg = fm.getRegionAtLine(line);
          if (!reg || reg.startLineNumber !== line) return;
          const collapse = !reg.isCollapsed;
          fm.toggleCollapseState([reg]);
          // If the caret was inside the folded block Monaco moves it; keep the view still anyway.
          editor.setScrollPosition(keep);
          requestAnimationFrame(() => editor.setScrollPosition(keep));
          cb.onFold && cb.onFold(line, collapse);
        });
        return true;
      }
      if (model) {
        const keep = { scrollTop: editor.getScrollTop(), scrollLeft: editor.getScrollLeft() };
        const collapsed = !!(el && el.className && /folding-collapsed|codicon-chevron-right/.test(el.className));
        editor.trigger("touch", collapsed ? "editor.unfold" : "editor.fold", { selectionLines: [line - 1], levels: 1, direction: "down" });
        setTimeout(() => editor.setScrollPosition(keep), 0);
        cb.onFold && cb.onFold(line, !collapsed);
        return true;
      }
      return false;
    }

    function tap(x, y) {
      const t = editor.getTargetAtClientPoint(x, y);
      if (!t) return;
      const now = performance.now();
      if (t.type === T.GUTTER_LINE_DECORATIONS && t.position) {
        foldTap(t.position.lineNumber, t.element);
        lastTap = { t: 0, x, y, n: 0 };
        return;
      }
      if (t.type === T.GUTTER_LINE_NUMBERS && t.position) {
        editor.setSelection(lineRange(t.position.lineNumber));
        focusEd(false);
        cb.onSelectEnd && cb.onSelectEnd("line");
        return;
      }
      if (!t.position) {
        focusEd(false);
        return;
      }
      const near = Math.hypot(x - lastTap.x, y - lastTap.y) < 28;
      const n = now - lastTap.t < MULTI_TAP_MS && near ? lastTap.n + 1 : 1;
      const pos = t.position;
      const prev = editor.getSelection();
      const wasCaretHere = prev && prev.isEmpty() && prev.positionLineNumber === pos.lineNumber && prev.positionColumn === pos.column;
      lastTap = { t: now, x, y, n };
      if (n === 1) {
        editor.setPosition(pos);
        focusEd(true);
        if (wasCaretHere && editor.hasTextFocus()) cb.onCaretTap && cb.onCaretTap();
        else cb.onTap && cb.onTap();
      } else if (n === 2) {
        editor.setSelection(wordRange(pos));
        focusEd(false);
        cb.onSelectEnd && cb.onSelectEnd("word");
      } else {
        editor.setSelection(lineRange(pos.lineNumber));
        focusEd(false);
        cb.onSelectEnd && cb.onSelectEnd("line");
        lastTap.n = 0;
      }
    }

    function momentum() {
      const now = performance.now();
      const recent = samples.filter((s) => now - s.t < 90);
      if (recent.length < 2) return;
      const a = recent[0], b = recent[recent.length - 1];
      const dt = Math.max(8, b.t - a.t);
      let vx = axis === "y" ? 0 : -(b.x - a.x) / dt * 16;
      let vy = axis === "x" ? 0 : -(b.y - a.y) / dt * 16;
      if (Math.hypot(vx, vy) < 2) return;
      const step = () => {
        vx *= 0.95; vy *= 0.95;
        if (Math.abs(vx) < 0.3 && Math.abs(vy) < 0.3) { momentumRaf = 0; cb.onScrollEnd && cb.onScrollEnd(); return; }
        editor.setScrollPosition({ scrollTop: editor.getScrollTop() + vy, scrollLeft: editor.getScrollLeft() + vx });
        momentumRaf = requestAnimationFrame(step);
      };
      momentumRaf = requestAnimationFrame(step);
    }

    function pinchStart() {
      const [a, b] = [...pts.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r = rect();
      const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
      const pos = positionAt(mid.x, mid.y);
      const line = pos ? pos.lineNumber : 1;
      const inLine = (mid.y - r.top) - (editor.getTopForLineNumber(line) - editor.getScrollTop());
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), font: cb.getFont(), line, frac: inLine / lh, midY: mid.y - r.top };
      mode = "pinch";
      clearHold();
      stopMomentum();
      cb.onPinchStart && cb.onPinchStart();
    }

    function pinchApply() {
      pinchRaf = 0;
      if (!pinch || !pinchPending) return;
      const size = pinchPending;
      pinchPending = 0;
      if (size === cb.getFont()) return;
      cb.setFont(size);
      const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
      editor.setScrollTop(editor.getTopForLineNumber(pinch.line) + pinch.frac * lh - pinch.midY);
    }

    function pinchMove() {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      pinchPending = root.DaphCore.pinchFont(pinch.font, pinch.dist, d, 8, 32);
      if (!pinchRaf) pinchRaf = requestAnimationFrame(pinchApply);
    }

    function isTouch(e) {
      return e.pointerType === "touch" || e.pointerType === "pen";
    }

    function onDown(e) {
      if (!enabled || !isTouch(e) || excluded(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      try { host.setPointerCapture(e.pointerId); } catch (_) {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        stopMomentum();
        mode = "pending";
        axis = null;
        start = { x: e.clientX, y: e.clientY, t: performance.now(), top: editor.getScrollTop(), left: editor.getScrollLeft(), id: e.pointerId };
        samples = [{ x: e.clientX, y: e.clientY, t: start.t }];
        clearHold();
        holdTimer = setTimeout(beginSelect, HOLD_MS);
      } else if (pts.size === 2 && mode !== "select") {
        pinchStart();
      }
    }

    function onMove(e) {
      if (!pts.has(e.pointerId)) return;
      e.stopPropagation();
      e.preventDefault();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === "pinch") { if (pts.size >= 2) pinchMove(); return; }
      if (e.pointerId !== (start && start.id)) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (mode === "pending" && Math.hypot(dx, dy) > SLOP) {
        clearHold();
        mode = "scroll";
        const ax = Math.abs(dx), ay = Math.abs(dy);
        axis = ay > ax * 1.8 ? "y" : ax > ay * 1.8 ? "x" : null;
        start.x = e.clientX; start.y = e.clientY;
        start.top = editor.getScrollTop(); start.left = editor.getScrollLeft();
        cb.onScrollStart && cb.onScrollStart();
      }
      if (mode === "scroll") {
        const ndx = e.clientX - start.x, ndy = e.clientY - start.y;
        const pos = {};
        if (axis !== "x") pos.scrollTop = start.top - ndy;
        if (axis !== "y") pos.scrollLeft = start.left - ndx;
        editor.setScrollPosition(pos);
        samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
        if (samples.length > 12) samples.shift();
      } else if (mode === "select") {
        if (!slid && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) slid = true;
        lastPoint = { x: e.clientX, y: e.clientY };
        extendTo(positionAt(e.clientX, e.clientY));
        ensureEdgeLoop();
      }
    }

    function finish(e, cancelled) {
      if (!pts.has(e.pointerId)) return;
      e.stopPropagation();
      e.preventDefault();
      pts.delete(e.pointerId);
      try { host.releasePointerCapture(e.pointerId); } catch (_) {}
      if (mode === "pinch") {
        if (pts.size === 0) {
          if (pinchPending) pinchApply();
          pinch = null;
          mode = "idle";
          cb.onPinchEnd && cb.onPinchEnd(cb.getFont());
        }
        return;
      }
      if (pts.size > 0) return;
      clearHold();
      const m = mode;
      mode = "idle";
      if (m === "pending") {
        const dur = performance.now() - start.t;
        if (!cancelled || dur < HOLD_MS) tap(start.x, start.y);
      } else if (m === "scroll") {
        if (!cancelled) momentum();
        if (!momentumRaf) cb.onScrollEnd && cb.onScrollEnd();
      } else if (m === "select") {
        anchor = null;
        lastPoint = null;
        cb.onSelectEnd && cb.onSelectEnd("hold");
      }
    }

    function swallowTouch(e) {
      if (!enabled || excluded(e.target)) return;
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    }

    function dragHandleTo(x, y) {
      if (!handleDrag) return;
      const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
      const pos = positionAt(x, y - handleDrag.dy - lh / 2);
      if (!pos) return;
      const f = handleDrag.fixed;
      editor.setSelection(new monaco.Selection(f.lineNumber, f.column, pos.lineNumber, pos.column));
    }

    function handleDown(which, e) {
      e.stopPropagation();
      e.preventDefault();
      const el = which === "start" ? handles.a : handles.b;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      const sel = editor.getSelection();
      if (!sel) return;
      const fixed = which === "start" ? sel.getEndPosition() : sel.getStartPosition();
      const hr = el.getBoundingClientRect();
      handleDrag = { which, fixed, dy: e.clientY - hr.top, id: e.pointerId };
      mode = "handle";
      lastPoint = { x: e.clientX, y: e.clientY };
      cb.onSelecting && cb.onSelecting();
      ensureEdgeLoop();
    }

    function handleMove(e) {
      if (!handleDrag || e.pointerId !== handleDrag.id) return;
      e.stopPropagation();
      e.preventDefault();
      lastPoint = { x: e.clientX, y: e.clientY };
      dragHandleTo(e.clientX, e.clientY);
    }

    function handleUp(e) {
      if (!handleDrag || e.pointerId !== handleDrag.id) return;
      e.stopPropagation();
      e.preventDefault();
      handleDrag = null;
      mode = "idle";
      lastPoint = null;
      cb.onSelectEnd && cb.onSelectEnd("handle");
    }

    function placeHandles() {
      const sel = editor.getSelection();
      const show = sel && !sel.isEmpty() && cb.handlesWanted && cb.handlesWanted();
      for (const [el, p, side] of [[handles.a, sel && sel.getStartPosition(), "start"], [handles.b, sel && sel.getEndPosition(), "end"]]) {
        if (!show) { el.classList.remove("show"); continue; }
        const v = editor.getScrolledVisiblePosition(p);
        const li = layoutInfo();
        if (!v || v.top < -4 || v.top > li.height - 4 || v.left < li.contentLeft - 2 || v.left > li.width) { el.classList.remove("show"); continue; }
        el.style.top = (v.top + v.height) + "px";
        el.style.left = (side === "start" ? v.left - 22 : v.left) + "px";
        el.classList.add("show");
      }
    }

    const opt = { capture: true, passive: false };
    host.addEventListener("pointerdown", onDown, opt);
    host.addEventListener("pointermove", onMove, opt);
    host.addEventListener("pointerup", (e) => finish(e, false), opt);
    host.addEventListener("pointercancel", (e) => finish(e, true), opt);
    host.addEventListener("touchstart", swallowTouch, opt);
    host.addEventListener("touchmove", swallowTouch, opt);
    host.addEventListener("touchend", swallowTouch, opt);
    host.addEventListener("contextmenu", (e) => { if (!excluded(e.target)) { e.preventDefault(); e.stopPropagation(); } }, true);
    for (const [el, which] of [[handles.a, "start"], [handles.b, "end"]]) {
      el.addEventListener("pointerdown", (e) => handleDown(which, e), opt);
      el.addEventListener("pointermove", handleMove, opt);
      el.addEventListener("pointerup", handleUp, opt);
      el.addEventListener("pointercancel", handleUp, opt);
      el.addEventListener("touchstart", (e) => { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }, opt);
    }

    return {
      placeHandles,
      get mode() { return mode; },
      setEnabled(v) { enabled = !!v; },
      stop() { stopMomentum(); clearHold(); mode = "idle"; pts.clear(); },
    };
  }

  root.DaphGestures = { attach };
})(self);
