(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const icon = (name) => el("i", "codicon " + name);
  const C = self.DaphCore;
  const L = self.DaphLanguages;

  const SETTINGS_KEY = "daphcode.settings.v1";
  const SESSION_KEY = "daphcode.session.v1";
  const BASE_FONT = 14;
  const MAX_TABS = 24;
  // No file-size limit. Text crosses the Android bridge in chunks of this many chars.
  const CHUNK_CHARS = 1 << 20;
  // Largest string V8 can hold is ~2^29 chars; above this the document is streamed into the
  // model chunk by chunk ("huge" mode) instead of being joined into one string.
  const MAX_JS_STRING = 500 * 1000 * 1000;

  function splitChunks(text, max) {
    const out = [];
    let i = 0;
    if (!text.length) return [""];
    while (i < text.length) {
      let end = Math.min(text.length, i + max);
      const cc = text.charCodeAt(end - 1);
      if (end < text.length && end > i + 1 && cc >= 0xd800 && cc <= 0xdbff) end--;
      out.push(text.slice(i, end));
      i = end;
    }
    return out;
  }

  const settings = Object.assign(
    { fontSize: BASE_FONT, wordWrap: "off", minimap: true, whitespace: "selection", stickyScroll: true },
    safeJson(localStorage.getItem(SETTINGS_KEY)) || {}
  );

  function safeJson(s) {
    try { return s ? JSON.parse(s) : null; } catch (_) { return null; }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
  }

  const Host = (() => {
    const A = self.Android;
    if (A) {
      return {
        native: true,
        openFiles: () => A.openFiles(),
        openFolder: () => A.openFolder(),
        listFolder: (uri) => { const r = safeJson(A.listFolder(uri)) || {}; if (!r.ok) throw new Error(r.error || "Could not read folder."); return r.entries || []; },
        take: (t) => A.take(t),
        chunked: typeof A.takeChunk === "function",
        chunkCount: (t) => (typeof A.chunkCount === "function" ? A.chunkCount(t) : -1),
        takeChunk: (t, i) => A.takeChunk(t, i),
        release: (t) => { if (typeof A.release === "function") A.release(t); },
        writeBegin: (req) => A.writeBegin(req),
        writeChunk: (req, c) => A.writeChunk(req, c),
        save: (req, uri, text, enc, bom) => A.save(req, uri, text, enc, !!bom),
        canChunkSave: typeof A.writeBegin === "function",
        saveAs: (req, name, text, enc, bom) => A.saveAs(req, name, text, enc, !!bom),
        rename: (req, uri, name) => A.rename(req, uri, name),
        reopen: (req, uri) => A.reopen(req, uri),
        recents: () => safeJson(A.getRecents()) || [],
        forgetRecent: (uri) => A.forgetRecent(uri),
        copy: (s) => A.copyText(s),
        paste: () => A.readClipboard() || "",
        haptic: () => A.haptic(),
        setDirty: (n) => A.setDirty(n),
        exit: () => A.exitApp(),
        version: () => A.version(),
        showKeyboard: () => { if (A.showKeyboard) A.showKeyboard(); },
        // All files access + built-in file browser (1.0.5)
        storageState: () => (typeof A.storageState === "function" ? safeJson(A.storageState()) || { granted: false } : { granted: false, unsupported: true }),
        requestAllFiles: () => A.requestAllFiles(),
        storageRoots: () => safeJson(A.storageRoots()) || [],
        listDir: (path, hidden) => safeJson(A.listDir(path, !!hidden)) || { ok: false, error: "Cannot read folder" },
        fileInfo: (path) => safeJson(A.fileInfo(path)) || { exists: false },
        openPath: (path) => A.openPath(path),
        saveToPath: (req, path, text, enc, bom) => A.saveToPath(req, path, text, enc, !!bom),
      };
    }
    if (self.DaphWebHost) return self.DaphWebHost;
    const mem = (self.__daphFiles = self.__daphFiles || {});
    let clip = "";
    const texts = new Map();
    const outgoing = new Map();
    let tok = 0;
    const later = (f) => setTimeout(f, 0);
    return {
      native: false,
      openFiles: () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.multiple = true;
        inp.onchange = () => {
          for (const f of inp.files) {
            f.text().then((t) => {
              const token = "t" + (++tok);
              texts.set(token, t);
              DaphHost.onOpened({ token, uri: "mem://" + f.name, name: f.name, encoding: "UTF-8", bom: false, size: f.size, lossy: false });
            });
          }
        };
        inp.click();
      },
      openFolder: () => later(() => { if (self.__folderRoot) DaphHost.onFolderOpened(self.__folderRoot); }),
      listFolder: (uri) => { const entries = (self.__folders || {})[uri]; if (!entries) throw new Error("Could not read folder."); return entries; },
      chunked: true,
      canChunkSave: true,
      chunkCount: (t) => {
        if (!texts.has(t) && self.__pendingTexts && t in self.__pendingTexts) { texts.set(t, self.__pendingTexts[t]); delete self.__pendingTexts[t]; }
        if (!texts.has(t)) return -1;
        const v = texts.get(t);
        if (typeof v === "string") texts.set(t, splitChunks(v, self.__chunkChars || CHUNK_CHARS));
        return texts.get(t).length;
      },
      takeChunk: (t, i) => { const c = texts.get(t); if (!c) return null; const v = c[i]; if (i === c.length - 1) texts.delete(t); return v; },
      release: (t) => texts.delete(t),
      writeBegin: (req) => outgoing.set(req, []),
      writeChunk: (req, c) => { const o = outgoing.get(req); if (!o) return false; o.push(c); self.__writeChunks = (self.__writeChunks || 0) + 1; return true; },
      take: (t) => { if (!texts.has(t) && self.__pendingTexts && t in self.__pendingTexts) { const v = self.__pendingTexts[t]; delete self.__pendingTexts[t]; return v; } const v = texts.get(t); texts.delete(t); return v; },
      save: (req, uri, text) => later(() => { if (text == null) { text = (outgoing.get(req) || []).join(""); outgoing.delete(req); } if (uri.startsWith("file://")) { const p = decodeURI(uri.slice(7)); (self.__fs = self.__fs || {})[p] = text; DaphHost.onSaveResult(req, true, uri, C.baseName(p), ""); return; } mem[uri] = text; DaphHost.onSaveResult(req, true, uri, C.baseName(uri.replace("mem://", "")), ""); }),
      saveAs: (req, name, text) => later(() => { if (text == null) { text = (outgoing.get(req) || []).join(""); outgoing.delete(req); } const uri = "mem://" + name; mem[uri] = text; DaphHost.onSaveResult(req, true, uri, name, ""); }),
      rename: (req, uri, name) => later(() => {
        const nu = "mem://" + name;
        mem[nu] = mem[uri]; delete mem[uri];
        DaphHost.onRenameResult(req, true, nu, name, "");
      }),
      reopen: (req, uri) => later(() => {
        if (uri.startsWith("file://")) {
          const p = decodeURI(uri.slice(7)), fs = self.__fs || {};
          if (!(p in fs) || fs[p] == null) { DaphHost.onOpenFailed("File no longer available: " + p, req); return; }
          const token = "t" + (++tok);
          texts.set(token, fs[p]);
          DaphHost.onOpened({ token, uri, name: C.baseName(p), encoding: "UTF-8", bom: false, size: fs[p].length, lossy: false, req });
          return;
        }
        if (!(uri in mem)) { DaphHost.onOpenFailed("File no longer available: " + uri, req); return; }
        const token = "t" + (++tok);
        texts.set(token, mem[uri]);
        DaphHost.onOpened({ token, uri, name: C.baseName(uri.replace("mem://", "")), encoding: "UTF-8", bom: false, size: mem[uri].length, lossy: false, req });
      }),
      recents: () => Object.keys(mem).map((u) => ({ uri: u, name: C.baseName(u.replace("mem://", "")) })),
      forgetRecent: () => {},
      copy: (s) => { clip = s; self.__clip = s; },
      paste: () => (self.__clip != null ? self.__clip : clip),
      haptic: () => {},
      setDirty: () => {},
      exit: () => { self.__exited = true; },
      version: () => "web",
      showKeyboard: () => {},
      // Fake device storage for tests / browser preview: self.__fs = { "/storage/emulated/0/a/b.py": "text", "/storage/emulated/0/empty/": null }
      storageState: () => ({ granted: !!self.__fsGranted, api: 35, home: "/storage/emulated/0" }),
      requestAllFiles: () => { self.__fsRequested = (self.__fsRequested || 0) + 1; },
      storageRoots: () => [{ path: "/storage/emulated/0", label: "Internal storage" }].concat(self.__fsSd ? [{ path: "/storage/1A2B-3C4D", label: "SD card" }] : []),
      listDir: (path, hidden) => {
        const fs = self.__fs || {};
        const dir = path.replace(/\/+$/, "") || "/";
        const pre = dir === "/" ? "/" : dir + "/";
        const seen = new Map();
        let exists = dir === "/";
        for (const k of Object.keys(fs)) {
          if (!k.startsWith(pre)) continue;
          exists = true;
          const rest = k.slice(pre.length);
          if (!rest) continue;
          const i = rest.indexOf("/");
          const n = i < 0 ? rest : rest.slice(0, i);
          if (!hidden && n.startsWith(".")) continue;
          const d = i >= 0;
          if (!seen.has(n)) seen.set(n, d ? { n, d: true, m: 1700000000000 } : { n, d: false, s: (fs[k] || "").length, m: 1700000000000 });
        }
        if (!exists) return { ok: false, path: dir, error: "Folder not found: " + dir };
        const parent = dir === "/" ? null : dir.slice(0, dir.lastIndexOf("/")) || "/";
        return { ok: true, path: dir, parent, entries: [...seen.values()], writable: !(self.__fsReadOnly || []).includes(dir) };
      },
      fileInfo: (path) => {
        const fs = self.__fs || {};
        if (path in fs && fs[path] != null) return { exists: true, dir: false, size: fs[path].length, parentWritable: true };
        const pre = path.replace(/\/+$/, "") + "/";
        if (Object.keys(fs).some((k) => k.startsWith(pre))) return { exists: true, dir: true };
        return { exists: false, parentWritable: true };
      },
      openPath: (path) => later(() => {
        const fs = self.__fs || {};
        if (!(path in fs) || fs[path] == null) { DaphHost.onOpenFailed("File not found: " + path); return; }
        const token = "t" + (++tok);
        texts.set(token, fs[path]);
        DaphHost.onOpened({ token, uri: "file://" + encodeURI(path), name: C.baseName(path), encoding: "UTF-8", bom: false, size: fs[path].length, lossy: false });
      }),
      saveToPath: (req, path, text) => later(() => {
        if (text == null) { text = (outgoing.get(req) || []).join(""); outgoing.delete(req); }
        (self.__fs = self.__fs || {})[path] = text;
        DaphHost.onSaveResult(req, true, "file://" + encodeURI(path), C.baseName(path), "");
      }),
    };
  })();

  let monaco = null;
  let editor = null;
  let gestures = null;
  const tabs = [];
  let active = null;
  let seq = 0;
  let reqSeq = 0;
  const pending = new Map();
  let touchSelection = false;
  let imeVisible = false;
  let imeFromHost = false;
  let editorFocused = false;
  let suggestAfterDeleteSeq = 0;
  let suggestAfterDeletePending = null;
  let suggestAfterDeleteCache = null;
  let suggestAfterDeleteForwardKey = null;
  const notifications = [];

  function toast(msg, kind) {
    const k = kind || "info";
    notifications.unshift({ msg, kind: k, t: new Date() });
    if (notifications.length > 30) notifications.pop();
    const t = el("div", "toast");
    t.append(icon("codicon-" + k), el("span", null, msg));
    $("#toasts").append(t);
    setTimeout(() => t.remove(), k === "error" ? 6000 : 3200);
  }

  // ---- All files access: when granted, Open / Save As use the built-in file browser.
  const storage = { granted: false, home: "/storage/emulated/0" };
  let fileDlg = null;
  let workspace = null;

  function folderWorkspace() {
    if (!workspace) {
      workspace = DaphWorkspace.create({
        Host, document, el, icon, tapper, toast,
        fileIcon: (name) => {
          const [ic, color] = L.icon(monaco ? L.resolve(monaco, name, "") : "plaintext");
          const i = icon(ic);
          if (color) i.style.color = color;
          return i;
        },
        onOpenFile: (uri) => reopen(uri),
        onLayout: () => { if (editor) editor.layout(); },
      });
    }
    return workspace;
  }

  function refreshStorage() {
    const s = Host.storageState ? Host.storageState() : null;
    if (s) { storage.granted = !!s.granted; if (s.home) storage.home = s.home; storage.unsupported = !!s.unsupported; }
    return storage.granted;
  }

  function fileDialog() {
    if (!fileDlg) {
      fileDlg = DaphFileDialog.create({
        Host, el, icon, tapper, dialog, toast,
        humanSize: C.humanSize,
        validName: C.validFileName,
        langIcon: (name) => L.icon(monaco ? L.resolve(monaco, name, "") : "plaintext"),
      });
    }
    return fileDlg;
  }

  function dirOfUri(uri) {
    if (Host.directoryForUri) {
      const directory = Host.directoryForUri(uri);
      if (directory) return directory;
    }
    if (!uri || !uri.startsWith("file://")) return null;
    try { const p = decodeURI(uri.slice(7)); return p.slice(0, p.lastIndexOf("/")) || "/"; } catch (_) { return null; }
  }

  function openFileFlow() {
    if (!refreshStorage()) { Host.openFiles(); return; }
    fileDialog().open({ dir: dirOfUri(active && active.uri), home: storage.home }).then((path) => {
      if (path) Host.openPath(path);
    });
  }

  function allFilesAccessFlow() {
    if (Host.web) {
      if (Host.storageState && Host.storageState().granted) {
        dialog("Built-in file browser", "Open File and Save As use DaphCode's VS Code-style file browser. Choose Add Folder to authorize a local folder, then browse and save inside it without another file picker. Browser security limits access to the folders you authorize.", [
          { label: "Add Folder", primary: true, run: () => Host.requestAllFiles() },
          { label: "OK" },
        ]);
        return;
      }
      const direct = Host.fileAccessLabel && Host.fileAccessLabel() === "Direct local file editing";
      dialog("Browser file access", direct ? "This browser can open authorized local files, save them in place, and remember their file handles. Your documents stay on this device. Use Open File or drop files onto the editor to grant access." : "This browser uses standard file pickers and downloads. You can edit and save every text document, but saving creates a downloaded copy unless the browser offers a save destination. Your documents stay on this device.", [{ label: "OK", primary: true }]);
      return;
    }
    refreshStorage();
    if (storage.granted) {
      dialog("All files access is on", "Open File and Save As use DaphCode's built-in file browser, and Save / Rename work directly on files in your storage.\nTo turn it off, open Android Settings and switch off \"Allow access to manage all files\" for DaphCode.", [
        { label: "Open Settings", run: () => Host.requestAllFiles() },
        { label: "OK", primary: true },
      ]);
      return;
    }
    dialog("Turn on All files access?", "DaphCode will open and save files with its own VS Code-style file browser instead of the Android picker, and Rename will work for every file.\nAndroid will open a settings page: switch on \"Allow access to manage all files\", then come back. You can keep using the Android picker if you skip this.", [
      { label: "Continue", primary: true, run: () => Host.requestAllFiles() },
      { label: "Not Now" },
    ]);
  }

  // Every tappable (buttons, menu items, list rows, tabs) keeps focus by default: letting the
  // tap's synthetic mousedown move focus closes whatever the command just opened (e.g. the
  // Command Palette) and flashes the keyboard. Pass { keepFocus: false } to opt out.
  // Last time each element scrolled (scroll events do not bubble, so listen in the capture phase).
  const scrollTimes = new WeakMap();
  document.addEventListener("scroll", (e) => { if (e.target && e.target.nodeType === 1) scrollTimes.set(e.target, performance.now()); }, true);
  const FLING_GUARD_MS = 160;
  // Only scrolling that follows a real finger swipe counts as a fling (not programmatic
  // scrollIntoView of tabs, list resets, etc.). A swipe = touch that moved or was cancelled.
  const lastSwipe = { t: -1e9, el: null };
  const swipe = { id: null, x: 0, y: 0, moved: false, el: null };
  const endSwipe = () => { lastSwipe.t = performance.now(); lastSwipe.el = swipe.el; };
  document.addEventListener("pointerdown", (e) => { swipe.id = e.pointerId; swipe.x = e.clientX; swipe.y = e.clientY; swipe.moved = false; swipe.el = e.target; }, true);
  document.addEventListener("pointermove", (e) => { if (e.pointerId === swipe.id && Math.hypot(e.clientX - swipe.x, e.clientY - swipe.y) > 10) swipe.moved = true; }, true);
  document.addEventListener("pointerup", (e) => { if (e.pointerId === swipe.id && swipe.moved) endSwipe(); swipe.id = null; }, true);
  document.addEventListener("pointercancel", (e) => { if (e.pointerId === swipe.id) endSwipe(); swipe.id = null; }, true);

  function tapper(rootEl, selector, fn, opts) {
    const o = Object.assign({ keepFocus: true }, opts || {});
    const slop = o.scroller ? 10 : 12;
    let cur = null;
    rootEl.addEventListener("pointerdown", (e) => {
      const target = e.target.closest(selector);
      if (!target || !rootEl.contains(target)) return;
      if (o.keepFocus) e.preventDefault();
      const sc = o.scroller ? o.scroller(target) : null;
      const now = performance.now();
      // Finger landed while the list was still scrolling (fling): that touch only stops the list.
      const flinging = !!sc && now - (scrollTimes.get(sc) || -1e9) < FLING_GUARD_MS && now - lastSwipe.t < 3000 && !!lastSwipe.el && sc.contains(lastSwipe.el);
      cur = { target, x: e.clientX, y: e.clientY, t: now, id: e.pointerId, sc, sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0, moved: false, long: false, timer: 0, flinging, maxMove: 0 };
      target.classList.add("pressed");
      if (o.onLong) {
        cur.timer = setTimeout(() => {
          if (cur && !cur.moved) { cur.long = true; target.classList.remove("pressed"); Host.haptic(); o.onLong(target, cur); }
        }, 480);
      }
    });
    rootEl.addEventListener("pointermove", (e) => {
      if (!cur || e.pointerId !== cur.id) return;
      const d = Math.hypot(e.clientX - cur.x, e.clientY - cur.y);
      if (d > cur.maxMove) cur.maxMove = d;
      if (d > slop) {
        cur.moved = true;
        cur.target.classList.remove("pressed");
        clearTimeout(cur.timer);
      }
    });
    const end = (e, cancelled) => {
      if (!cur || e.pointerId !== cur.id) return;
      const c = cur;
      cur = null;
      clearTimeout(c.timer);
      c.target.classList.remove("pressed");
      if (c.moved || c.long || c.flinging) return;
      if (c.sc && (Math.abs(c.sc.scrollLeft - c.sl) > 3 || Math.abs(c.sc.scrollTop - c.st) > 3)) return;
      // pointercancel = the WebView claimed the gesture (it starts scrolling the list only AFTER the
      // cancel, so scroll offsets have not changed yet). Inside a scrollable list that is never a tap.
      if (cancelled && (c.sc || c.maxMove > 4)) return;
      if (cancelled && performance.now() - c.t > 700) return;
      if (o.keepFocus) e.preventDefault();
      fn(c.target, e);
    };
    rootEl.addEventListener("pointerup", (e) => end(e, false));
    rootEl.addEventListener("pointercancel", (e) => end(e, true));
    rootEl.addEventListener("click", (e) => { if (e.target.closest(selector)) { e.preventDefault(); e.stopPropagation(); } }, true);
  }

  function isDirty(t) {
    return t.model && !t.loading && (t.savedAlt === -1 || t.model.getAlternativeVersionId() !== t.savedAlt);
  }

  function dirtyTabs() {
    return tabs.filter(isDirty);
  }

  function tabById(id) {
    return tabs.find((t) => t.id === id);
  }

  function modelUri(id, name) {
    return monaco.Uri.from({ scheme: "inmemory", authority: "daph", path: "/" + id + "/" + name });
  }

  // Build a model from chunks without ever creating one giant string (documents beyond V8's
  // string limit). EOL is fixed from the first chunk; a trailing "\r" is carried over so a
  // CRLF split across two chunks is not doubled.
  function appendChunks(model, chunks) {
    model.setEOL(C.detectEol(chunks[0] || "") === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    let carry = "";
    for (let i = 0; i < chunks.length; i++) {
      let c = carry + chunks[i];
      chunks[i] = null;
      carry = "";
      if (i < chunks.length - 1 && c.endsWith("\r")) { carry = "\r"; c = c.slice(0, -1); }
      if (!c) continue;
      const ln = model.getLineCount(), col = model.getLineMaxColumn(ln);
      model.applyEdits([{ range: new monaco.Range(ln, col, ln, col), text: c }]);
    }
    if (carry) {
      const ln = model.getLineCount(), col = model.getLineMaxColumn(ln);
      model.applyEdits([{ range: new monaco.Range(ln, col, ln, col), text: carry }]);
    }
  }

  // Pull an opened document across the bridge chunk by chunk.
  function pullText(meta) {
    const n = Host.chunked ? Host.chunkCount(meta.token) : -1;
    if (n < 0) {
      const t = Host.take(meta.token);
      return t == null ? null : { text: t };
    }
    const parts = new Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const c = Host.takeChunk(meta.token, i);
      if (c == null) { Host.release(meta.token); return null; }
      parts[i] = c;
      total += c.length;
    }
    if (n === 1) return { text: parts[0] };
    if (total <= (self.__maxJsString || MAX_JS_STRING)) {
      try { return { text: parts.join("") }; } catch (_) { /* RangeError: too long -> huge mode */ }
    }
    return { chunks: parts, total };
  }

  // Serialize a model in chunks (line by line, never one giant string).
  function modelChunks(model, max) {
    const out = [];
    const eol = model.getEOL();
    const n = model.getLineCount();
    let buf = [], len = 0;
    const flush = () => { if (buf.length) { out.push(buf.join("")); buf = []; len = 0; } };
    for (let i = 1; i <= n; i++) {
      let line = model.getLineContent(i);
      if (i < n) line += eol;
      while (line.length > max) {
        let cut = max;
        const cc = line.charCodeAt(cut - 1);
        if (cc >= 0xd800 && cc <= 0xdbff) cut--;
        flush();
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
      buf.push(line);
      len += line.length;
      if (len >= max) flush();
    }
    flush();
    if (!out.length) out.push("");
    return out;
  }

  function createTab(o) {
    if (tabs.length >= MAX_TABS) {
      toast("Too many editors open (" + MAX_TABS + "). Close some tabs first.", "warning");
      return null;
    }
    const id = "t" + (++seq);
    const head = o.chunks ? o.chunks[0] || "" : o.text || "";
    const firstLine = head.slice(0, 200).split(/\r?\n/, 1)[0];
    let lang = o.lang && L.has(monaco, o.lang) ? o.lang : L.resolve(monaco, o.name, firstLine);
    if (o.chunks) lang = "plaintext";
    const model = monaco.editor.createModel(o.chunks ? "" : o.text || "", lang, modelUri(id, o.name));
    if (o.chunks) appendChunks(model, o.chunks);
    const t = {
      id, name: o.name, uri: o.uri || null, model, viewState: o.viewState || null,
      savedAlt: model.getAlternativeVersionId(), encoding: o.encoding || "UTF-8", bom: !!o.bom,
      lossy: !!o.lossy, loading: !!o.loading, size: o.size || (o.text || "").length, huge: !!o.chunks,
    };
    if (o.dirty) t.savedAlt = -1;
    t.large = C.isLarge(t.size, model.getLineCount());
    model.onDidChangeContent(() => onContentChanged(t));
    model.onDidChangeLanguage(() => scheduleDiag(t, 30));
    scheduleDiag(t, 120);
    const idx = o.index != null ? Math.min(o.index, tabs.length) : (active ? tabs.indexOf(active) + 1 : tabs.length);
    tabs.splice(idx, 0, t);
    return t;
  }

  // ---- Diagnostics for languages without a Monaco language service (Python, C-family, XML).
  // Runs in a Web Worker (web/diagnostics.js) so typing stays smooth; XML uses DOMParser.
  const DIAG_OWNER = "daphcode";
  const DIAG_MAX_CHARS = 3000000;
  let diagWorker = null, diagWorkerFailed = false, diagSeq = 0;
  const diagPending = new Map();
  const highlightPending = new Map();

  function highlightDone(id, data, failed) {
    const pending = highlightPending.get(id);
    if (!pending) return;
    highlightPending.delete(id);
    if (pending.cancel) pending.cancel.dispose();
    pending.resolve(failed ? DaphHighlight.pythonSemantic(pending.text) : data);
  }

  function requestHighlight(text, cancellation) {
    const worker = diagWorkerGet();
    if (!worker) return DaphHighlight.pythonSemantic(text);
    return new Promise((resolve) => {
      const id = ++diagSeq;
      const pending = { resolve, text, cancel: null };
      highlightPending.set(id, pending);
      pending.cancel = cancellation.onCancellationRequested(() => highlightDone(id, null, false));
      if (cancellation.isCancellationRequested) { highlightDone(id, null, false); return; }
      try { worker.postMessage({ id, kind: "highlight", text, script: new URL("highlighting.js", location.href).href }); }
      catch (_) { highlightDone(id, null, true); }
    });
  }

  function diagWorkerGet() {
    if (diagWorker || diagWorkerFailed || typeof Worker === "undefined") return diagWorker;
    try {
      const url = new URL("diagnostics.js", location.href).href;
      const source = "importScripts('" + url + "');";
      diagWorker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
      diagWorker.onmessage = (e) => {
        const data = e.data || {};
        if (data.kind === "highlight") {
          self.__highlightViaWorker = (self.__highlightViaWorker || 0) + 1;
          highlightDone(data.id, data.data, data.failed);
        } else {
          self.__diagViaWorker = (self.__diagViaWorker || 0) + 1;
          diagDone(data.id, data.markers);
        }
      };
      diagWorker.onerror = () => {
        diagWorkerFailed = true;
        diagWorker = null;
        for (const [id, p] of diagPending) diagDone(id, self.DaphDiag ? DaphDiag.check(p.lang, p.t.model.getValue()) : []);
        for (const id of highlightPending.keys()) highlightDone(id, null, true);
      };
    } catch (_) { diagWorkerFailed = true; diagWorker = null; }
    return diagWorker;
  }

  function diagDone(id, markers) {
    const p = diagPending.get(id);
    diagPending.delete(id);
    if (!p || !tabs.includes(p.t) || p.t.model.isDisposed()) return;
    if (p.t.model.getVersionId() !== p.ver || p.t.model.getLanguageId() !== p.lang) return; // stale; a newer run is scheduled
    monaco.editor.setModelMarkers(p.t.model, DIAG_OWNER, markers || []);
    self.__diagRuns = (self.__diagRuns || 0) + 1;
  }

  function xmlDiagnostics(text) {
    if (typeof DOMParser === "undefined" || !text.trim()) return [];
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const err = doc.getElementsByTagName("parsererror")[0];
    if (!err) return [];
    const m = /line (\d+) at column (\d+): ([^\n]+)/.exec(err.textContent || "");
    if (!m) return [{ severity: 8, message: "XML is not well-formed", startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2, source: "XML" }];
    const line = Math.max(1, +m[1]), col = Math.max(1, +m[2]);
    return [{ severity: 8, message: m[3].trim(), startLineNumber: line, startColumn: Math.max(1, col - 1), endLineNumber: line, endColumn: col + 1, source: "XML" }];
  }

  function scheduleDiag(t, delay) {
    clearTimeout(t.diagTimer);
    t.diagTimer = setTimeout(() => runDiag(t), delay != null ? delay : 450);
  }

  function runDiag(t) {
    if (!monaco || !tabs.includes(t) || !t.model || t.model.isDisposed() || t.loading) return;
    const lang = t.model.getLanguageId();
    const ok = lang === "xml" || (self.DaphDiag && DaphDiag.supports(lang));
    if (!ok || t.huge || t.model.getValueLength() > DIAG_MAX_CHARS) {
      if (monaco.editor.getModelMarkers({ owner: DIAG_OWNER, resource: t.model.uri }).length) monaco.editor.setModelMarkers(t.model, DIAG_OWNER, []);
      return;
    }
    const id = ++diagSeq;
    diagPending.set(id, { t, ver: t.model.getVersionId(), lang });
    const text = t.model.getValue();
    if (lang === "xml") { let ms = []; try { ms = xmlDiagnostics(text); } catch (_) {} diagDone(id, ms); return; }
    const w = diagWorkerGet();
    if (w) w.postMessage({ id, lang, text });
    else diagDone(id, DaphDiag.check(lang, text));
  }

  function onContentChanged(t) {
    if (t.loading) return;
    scheduleDiag(t);
    renderTabs();
    updateTitle();
    reportDirty();
    scheduleSession();
    if (t === active) hideSelbar();
  }

  function reportDirty() {
    Host.setDirty(dirtyTabs().length);
  }

  // Features that scan the whole document; switched off only for "huge" (chunk-built) tabs.
  const HUGE_OFF = { folding: false, wordBasedSuggestions: "off", occurrencesHighlight: "off", selectionHighlight: false, matchBrackets: "never", bracketPairColorization: { enabled: false }, guides: { indentation: false, bracketPairs: false } };
  let HUGE_ON = {};

  function activate(t, opts) {
    if (!t) return;
    if (active && active !== t && active.model) active.viewState = editor.saveViewState();
    active = t;
    editor.setModel(t.model);
    editor.updateOptions(Object.assign({ minimap: { enabled: settings.minimap && !t.large } }, t.huge ? HUGE_OFF : HUGE_ON));
    if (t.viewState) editor.restoreViewState(t.viewState);
    document.body.classList.remove("no-editor");
    editor.layout();
    renderTabs();
    updateStatus();
    updateBreadcrumbs();
    updateTitle();
    hideSelbar();
    touchSelection = false;
    if (!opts || !opts.noFocus) quietFocus();
    const tabEl = document.querySelector('.tab[data-id="' + t.id + '"]');
    if (tabEl) tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    scheduleSession();
  }

  function openText(o) {
    if (o.uri) {
      const existing = tabs.find((t) => t.uri === o.uri);
      if (existing) {
        if (existing.loading) fillTab(existing, o);
        activate(existing);
        return existing;
      }
    }
    const t = createTab(o);
    if (t) activate(t, { noFocus: true });
    if (t && t.lossy) toast(t.name + " is not valid UTF-8. Invalid bytes were replaced; saving will write them as U+FFFD.", "warning");
    if (t && t.huge) toast(t.name + " is very large (" + C.humanSize(t.size) + "); opened as plain text with heavy features off.", "info");
    else if (t && t.large) toast(t.name + " is large (" + C.humanSize(t.size) + "). Minimap and some features are disabled for speed.", "info");
    return t;
  }

  function fillTab(t, o) {
    t.loading = true;
    const head = o.chunks ? o.chunks[0] || "" : o.text || "";
    if (o.chunks) { t.model.setValue(""); appendChunks(t.model, o.chunks); } else t.model.setValue(o.text || "");
    t.huge = !!o.chunks;
    const lang = o.chunks ? "plaintext" : L.resolve(monaco, o.name || t.name, head.slice(0, 200).split(/\r?\n/, 1)[0]);
    if (t.model.getLanguageId() !== lang) monaco.editor.setModelLanguage(t.model, lang);
    t.name = o.name || t.name;
    t.encoding = o.encoding || "UTF-8";
    t.bom = !!o.bom;
    t.lossy = !!o.lossy;
    t.size = o.size || 0;
    t.large = C.isLarge(t.size, t.model.getLineCount());
    t.loading = false;
    t.savedAlt = t.model.getAlternativeVersionId();
    scheduleDiag(t, 30);
    if (t.viewState && t === active) editor.restoreViewState(t.viewState);
    renderTabs();
    if (t === active) { updateStatus(); updateBreadcrumbs(); updateTitle(); }
  }

  function renderTabs() {
    const box = $("#tabs");
    box.textContent = "";
    for (const t of tabs) {
      const d = el("div", "tab" + (t === active ? " active" : "") + (isDirty(t) ? " dirty" : ""));
      d.dataset.id = t.id;
      d.setAttribute("role", "tab");
      d.setAttribute("aria-selected", t === active ? "true" : "false");
      d.setAttribute("aria-label", t.name + (isDirty(t) ? ", unsaved changes" : ""));
      d.tabIndex = t === active ? 0 : -1;
      const [ic, color] = L.icon(t.model.getLanguageId());
      const i = icon("tab-icon " + ic);
      i.style.color = color;
      const close = el("div", "tab-close");
      close.dataset.close = t.id;
      close.append(icon(isDirty(t) ? "codicon-circle-filled" : "codicon-close"));
      d.append(i, el("span", "tab-label", t.name + (t.loading ? " …" : "")), close);
      box.append(d);
    }
    if (!tabs.length) document.body.classList.add("no-editor");
  }

  function updateTitle() {
    const t = active;
    const name = t ? (isDirty(t) ? "● " : "") + t.name + " — DaphCode" : "DaphCode";
    $("#title-text").textContent = name;
    document.title = name;
  }

  function breadcrumbSegments(t) {
    if (!t.uri) return ["Untitled", t.name];
    if (t.uri.startsWith("mem://")) return ["memory", t.name];
    if (t.uri.startsWith("webfs://")) return ["Local file", t.name];
    if (t.uri.startsWith("webfile://")) return ["Browser file", t.name];
    if (t.uri.startsWith("download://")) return ["Downloaded copy", t.name];
    try {
      const u = decodeURIComponent(t.uri);
      const m = /\/document\/([^?#]+)$/.exec(u) || /\/tree\/[^/]+\/document\/([^?#]+)$/.exec(u);
      if (m) {
        let p = m[1];
        const colon = p.indexOf(":");
        let vol = "";
        if (colon >= 0) { vol = p.slice(0, colon); p = p.slice(colon + 1); }
        const segs = p.split("/").filter(Boolean);
        if (segs.length) {
          segs[segs.length - 1] = t.name;
          if (vol === "primary") segs.unshift("Internal storage");
          else if (vol && !/^\d+$/.test(vol) && !/^(raw|msf|document)$/.test(vol)) segs.unshift(vol);
          return segs.slice(-4);
        }
      }
      if (u.startsWith("file://")) {
        let p = u.slice(7);
        let head = [];
        const m2 = /^\/storage\/emulated\/\d+(\/|$)/.exec(p) || /^\/sdcard(\/|$)/.exec(p);
        if (m2) { head = ["Internal storage"]; p = p.slice(m2[0].length); }
        else { const m3 = /^\/storage\/([0-9A-F]{4}-[0-9A-F]{4})(\/|$)/i.exec(p); if (m3) { head = ["SD card"]; p = p.slice(m3[0].length); } }
        const segs = head.concat(p.split("/").filter(Boolean));
        return segs.length > 4 ? segs.slice(-4) : segs;
      }
    } catch (_) {}
    return [t.name];
  }

  function updateBreadcrumbs() {
    const b = $("#breadcrumbs");
    b.textContent = "";
    if (!active) return;
    const segs = breadcrumbSegments(active);
    segs.forEach((s, i) => {
      const last = i === segs.length - 1;
      const seg = el("span", "bc-seg" + (last ? " bc-last" : ""));
      if (last) {
        const [ic, color] = L.icon(active.model.getLanguageId());
        const ii = icon(ic);
        ii.style.color = color;
        seg.append(ii);
      }
      seg.append(el("span", null, s));
      b.append(seg);
      if (!last) b.append(icon("codicon-chevron-right"));
    });
  }

  function updateStatus() {
    if (!active || !editor.getModel()) return;
    const sel = editor.getSelection();
    const model = editor.getModel();
    let pos = "Ln " + sel.positionLineNumber + ", Col " + sel.positionColumn;
    const sels = editor.getSelections() || [];
    if (sels.length > 1) pos += " (" + sels.length + " selections)";
    else if (!sel.isEmpty()) pos += " (" + model.getValueLengthInRange(sel) + " selected)";
    $("#sb-pos").textContent = pos;
    const o = model.getOptions();
    $("#sb-indent").textContent = (o.insertSpaces ? "Spaces: " : "Tab Size: ") + o.tabSize;
    $("#sb-enc").textContent = active.encoding + (active.bom ? " with BOM" : "") + (active.lossy ? " (lossy)" : "");
    $("#sb-eol").textContent = model.getEOL() === "\r\n" ? "CRLF" : "LF";
    $("#sb-lang").textContent = L.name(monaco, model.getLanguageId());
    $("#sb-zoom").textContent = C.zoomPercent(settings.fontSize, BASE_FONT) + "%";
    updateMarkers();
  }

  function updateMarkers() {
    let e = 0, w = 0;
    if (active) {
      for (const m of monaco.editor.getModelMarkers({ resource: active.model.uri })) {
        if (m.severity === monaco.MarkerSeverity.Error) e++;
        else if (m.severity === monaco.MarkerSeverity.Warning) w++;
      }
    }
    $("#sb-err").textContent = e;
    $("#sb-warn").textContent = w;
    if (!$("#problems-panel").hidden) renderProblems();
  }

  function renderProblems() {
    const list = $("#pp-list");
    list.textContent = "";
    const ms = active ? monaco.editor.getModelMarkers({ resource: active.model.uri }) : [];
    if (!ms.length) { list.append(el("div", "pp-empty", "No problems have been detected in the file.")); return; }
    ms.sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber);
    for (const m of ms) {
      const r = el("div", "pp-row");
      const k = m.severity === monaco.MarkerSeverity.Error ? "error" : m.severity === monaco.MarkerSeverity.Warning ? "warning" : "info";
      r.append(icon("codicon-" + k), el("span", null, m.message), el("span", "pp-pos", "[Ln " + m.startLineNumber + ", Col " + m.startColumn + "]"));
      r.dataset.line = m.startLineNumber;
      r.dataset.col = m.startColumn;
      list.append(r);
    }
  }

  function closeTab(t, force) {
    return new Promise((resolve) => {
      const doClose = () => {
        const i = tabs.indexOf(t);
        if (i < 0) return resolve(true);
        tabs.splice(i, 1);
        if (active === t) {
          active = null;
          const next = tabs[Math.min(i, tabs.length - 1)];
          if (next) activate(next, { noFocus: true });
          else { editor.setModel(null); document.body.classList.add("no-editor"); renderWelcome(); updateTitle(); hideSelbar(); }
        }
        clearTimeout(t.diagTimer);
        t.model.dispose();
        renderTabs();
        reportDirty();
        scheduleSession();
        resolve(true);
      };
      if (force || !isDirty(t)) return doClose();
      activate(t, { noFocus: true });
      dialog("Do you want to save the changes you made to " + t.name + "?", "Your changes will be lost if you don't save them.", [
        { label: "Save", primary: true, run: () => saveTab(t).then((ok) => ok ? doClose() : resolve(false)) },
        { label: "Don't Save", run: doClose },
        { label: "Cancel", run: () => resolve(false) },
      ]);
    });
  }

  async function closeMany(list) {
    for (const t of list.slice()) {
      const ok = await closeTab(t);
      if (!ok) return false;
    }
    return true;
  }

  function saveTab(t, forceAs) {
    return new Promise(async (resolve) => {
      if (!t) return resolve(false);
      if (t.loading) { toast("Still loading " + t.name, "warning"); return resolve(false); }
      let path = null;
      if ((forceAs || !t.uri) && refreshStorage()) {
        path = await fileDialog().save({ name: t.name, dir: dirOfUri(t.uri), home: storage.home, title: forceAs ? "Save As" : "Save " + t.name });
        if (!path) return resolve(false);
        if (!tabs.includes(t)) return resolve(false);
      }
      const req = "r" + (++reqSeq);
      const alt = t.model.getAlternativeVersionId();
      const chunk = self.__chunkChars || CHUNK_CHARS;
      let text = null;
      if (!Host.canChunkSave || t.model.getValueLength() <= chunk) {
        text = t.model.getValue();
      } else {
        Host.writeBegin(req);
        for (const c of modelChunks(t.model, chunk)) {
          if (!Host.writeChunk(req, c)) { toast("Not enough memory to save " + t.name, "error"); return resolve(false); }
        }
      }
      pending.set(req, { kind: "save", t, alt, resolve });
      if (path) Host.saveToPath(req, path, text, t.encoding, t.bom);
      else if (t.uri && !forceAs) Host.save(req, t.uri, text, t.encoding, t.bom);
      else Host.saveAs(req, t.name, text, t.encoding, t.bom);
    });
  }

  async function saveAll() {
    for (const t of dirtyTabs()) {
      const ok = await saveTab(t);
      if (!ok) return false;
    }
    return true;
  }

  function renameTab(t) {
    if (!t) return;
    const dot = t.name.lastIndexOf(".");
    inputBox({
      title: "Rename",
      prompt: t.uri ? "Rename the file on the device" : "Rename this editor (it will be used when you save)",
      value: t.name,
      selection: [0, dot > 0 ? dot : t.name.length],
      validate: (v) => (C.validFileName(v) ? "" : "A file name cannot be empty or contain \\ / : * ? \" < > |"),
    }).then((v) => {
      if (v == null || v === t.name) return;
      if (!t.uri) { applyName(t, v, null); toast("Renamed to " + v); return; }
      const req = "r" + (++reqSeq);
      pending.set(req, { kind: "rename", t });
      Host.rename(req, t.uri, v);
    });
  }

  function applyName(t, name, uri) {
    t.name = name;
    if (uri) t.uri = uri;
    const lang = L.resolve(monaco, name, t.model.getLineContent(1));
    if (lang !== "plaintext" || C.extOf(name)) {
      if (t.model.getLanguageId() !== lang) monaco.editor.setModelLanguage(t.model, lang);
    }
    renderTabs();
    if (t === active) { updateStatus(); updateBreadcrumbs(); updateTitle(); }
    scheduleSession();
  }

  function newUntitled(name, text, lang) {
    const n = name || C.nextUntitled(tabs.map((t) => t.name));
    const t = createTab({ name: n, text: text || "", lang });
    if (t) activate(t);
    return t;
  }

  function newNamed() {
    inputBox({
      title: "New File...",
      prompt: "Type a file name, e.g. main.py, App.java, index.html",
      value: "",
      validate: (v) => (v === "" || C.validFileName(v) ? "" : "A file name cannot contain \\ / : * ? \" < > |"),
    }).then((v) => {
      if (v == null) return;
      if (!v) { newUntitled(); return; }
      newUntitled(v);
    });
  }

  function currentMenuLayer() {
    return $("#menu-layer");
  }

  function closeMenu() {
    const m = currentMenuLayer();
    m.classList.remove("open");
    m.textContent = "";
  }

  function showMenu(anchor, items) {
    closeMenu();
    const layer = currentMenuLayer();
    const menu = el("div", "menu");
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;
    for (const it of items) {
      if (it === "-") { menu.append(el("div", "menu-sep")); continue; }
      const row = el("div", "menu-item" + (it.disabled ? " disabled" : ""));
      row.setAttribute("role", "menuitem");
      row.setAttribute("aria-disabled", it.disabled ? "true" : "false");
      row.tabIndex = -1;
      const chk = el("span", "mi-check");
      if (it.checked) chk.append(icon("codicon-check"));
      row.append(chk, el("span", "mi-label", it.label));
      if (it.key) row.append(el("span", "mi-key", it.key));
      if (it.sub) row.append(icon("mi-sub codicon-chevron-right"));
      row._item = it;
      menu.append(row);
    }
    layer.append(menu);
    layer.classList.add("open");
    const vw = innerWidth, vh = innerHeight;
    const mr = menu.getBoundingClientRect();
    let x, y;
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      x = r.left; y = r.bottom + 2;
      if (x + mr.width > vw - 4) x = r.right - mr.width;
    } else { x = anchor.x; y = anchor.y; }
    x = Math.max(4, Math.min(vw - mr.width - 4, x));
    if (y + mr.height > vh - 4) y = Math.max(4, vh - mr.height - 4);
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    if (Host.web && matchMedia("(pointer: fine)").matches) menu.focus({ preventScroll: true });
  }

  const qi = { resolve: null, items: [], filtered: [], active: 0, mode: "", validate: null, onChange: null };

  function closeQuickInput(value) {
    const box = $("#quick-input");
    if (box.hidden) return;
    box.hidden = true;
    const r = qi.resolve;
    qi.resolve = null;
    $("#qi-input").blur();
    if (r) r(value);
    if (active) setTimeout(() => quietFocus(), 0);
  }

  function highlight(label, q) {
    const span = el("span", "qi-label");
    if (!q) { span.textContent = label; return span; }
    const i = label.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) { span.textContent = label; return span; }
    span.append(document.createTextNode(label.slice(0, i)), el("span", "qi-hl", label.slice(i, i + q.length)), document.createTextNode(label.slice(i + q.length)));
    return span;
  }

  function score(item, q) {
    if (!q) return 1;
    const l = item.label.toLowerCase(), s = q.toLowerCase();
    if (l.startsWith(s)) return 3;
    if (l.includes(s)) return 2;
    if ((item.desc || "").toLowerCase().includes(s)) return 1;
    let j = 0;
    for (const ch of l) if (ch === s[j]) j++;
    return j === s.length ? 0.5 : 0;
  }

  function renderQuickList() {
    const list = $("#qi-list");
    list.textContent = "";
    const q = $("#qi-input").value.trim();
    qi.filtered = qi.items
      .map((it, i) => ({ it, s: score(it, q), i }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.it);
    if (qi.active >= qi.filtered.length) qi.active = 0;
    qi.filtered.forEach((it, i) => {
      if (it.sep && (i === 0 || qi.filtered[i - 1].group !== it.group)) list.append(el("div", "qi-sep", it.sep));
      const row = el("div", "qi-item" + (i === qi.active ? " active" : ""));
      if (it.icon) { const ic = icon(it.icon); if (it.color) ic.style.color = it.color; row.append(ic); }
      row.append(highlight(it.label, q));
      if (it.desc) row.append(el("span", "qi-desc", it.desc));
      row.dataset.idx = i;
      list.append(row);
    });
    if (!qi.filtered.length) list.append(el("div", "qi-msg", "No matching results"));
  }

  function quickPick(items, o) {
    const opts = o || {};
    closeQuickInput(undefined);
    return new Promise((resolve) => {
      qi.mode = "pick";
      qi.items = items;
      qi.resolve = resolve;
      qi.validate = null;
      qi.active = Math.max(0, items.findIndex((i) => i.id === opts.activeId));
      $("#qi-title").textContent = opts.title || "";
      const inp = $("#qi-input");
      inp.value = "";
      inp.placeholder = opts.placeholder || "";
      $("#qi-msg").textContent = "";
      $("#qi-msg").className = "qi-msg";
      $("#quick-input").hidden = false;
      renderQuickList();
      const act = $("#qi-list .qi-item.active");
      if (act) act.scrollIntoView({ block: "nearest" });
      if (opts.focus !== false) inp.focus();
    });
  }

  function inputBox(o) {
    closeQuickInput(undefined);
    return new Promise((resolve) => {
      qi.mode = "input";
      qi.items = [];
      qi.resolve = resolve;
      qi.validate = o.validate || null;
      $("#qi-title").textContent = o.title || "";
      $("#qi-list").textContent = "";
      const inp = $("#qi-input");
      inp.value = o.value || "";
      inp.placeholder = o.placeholder || "";
      const msg = $("#qi-msg");
      msg.textContent = o.prompt || "";
      msg.className = "qi-msg";
      qi.prompt = o.prompt || "";
      $("#quick-input").hidden = false;
      inp.focus();
      if (o.selection) inp.setSelectionRange(o.selection[0], o.selection[1]);
    });
  }

  function acceptQuick() {
    if (qi.mode === "pick") {
      const it = qi.filtered[qi.active];
      if (it) closeQuickInput(it);
    } else {
      const v = $("#qi-input").value.trim();
      const err = qi.validate ? qi.validate(v) : "";
      if (err) { $("#qi-msg").textContent = err; $("#qi-msg").className = "qi-msg err"; return; }
      closeQuickInput(v);
    }
  }

  const dlgState = { buttons: [] };

  function dialog(msg, detail, buttons) {
    $("#dlg-msg").textContent = msg;
    $("#dlg-detail").textContent = detail || "";
    const box = $("#dlg-buttons");
    box.textContent = "";
    dlgState.buttons = buttons;
    buttons.forEach((b, i) => {
      const bt = el("button", "dlg-btn" + (b.primary ? " primary" : ""), b.label);
      bt.dataset.idx = i;
      box.append(bt);
    });
    $("#dialog-layer").hidden = false;
    if (Host.web) {
      const target = box.querySelector(".primary") || box.querySelector("button");
      if (target) target.focus({ preventScroll: true });
    }
    if (editor) editor.getContainerDomNode().querySelector("textarea")?.blur();
  }

  function closeDialog(idx) {
    const layer = $("#dialog-layer");
    if (layer.hidden) return;
    layer.hidden = true;
    const b = dlgState.buttons[idx];
    dlgState.buttons = [];
    if (b && b.run) b.run();
  }

  function selbarItems(kind) {
    if (kind === "caret") return [["Paste", "edit.paste"], ["Select", "edit.selectWord"], ["Select All", "edit.selectAll"]];
    return [["Cut", "edit.cut"], ["Copy", "edit.copy"], ["Paste", "edit.paste"], ["All", "edit.selectAll"], ["codicon-ellipsis", "menu.selection"]];
  }

  let selbarKind = null;

  function showSelbar(kind) {
    const bar = $("#selbar");
    const sel = editor.getSelection();
    if (!sel || !active) return;
    if (kind !== "caret" && sel.isEmpty()) { hideSelbar(); return; }
    selbarKind = kind;
    bar.textContent = "";
    for (const [label, cmd] of selbarItems(kind)) {
      const b = el("div", "sel-btn");
      b.dataset.cmd = cmd;
      if (label.startsWith("codicon-")) b.append(icon(label));
      else b.textContent = label;
      bar.append(b);
    }
    bar.classList.add("open");
    placeSelbar();
  }

  function placeSelbar() {
    const bar = $("#selbar");
    if (!bar.classList.contains("open")) return;
    const sel = editor.getSelection();
    const area = $("#editor-area").getBoundingClientRect();
    const a = editor.getScrolledVisiblePosition(sel.getStartPosition());
    const b = editor.getScrolledVisiblePosition(sel.getEndPosition());
    if (!a || !b) { bar.style.visibility = "hidden"; return; }
    bar.style.visibility = "";
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let top = a.top - bh - 8;
    if (top < 4) top = b.top + b.height + 30;
    if (top > area.height - bh - 4) top = Math.max(4, area.height / 2 - bh / 2);
    let left = Math.min(a.left, b.left) - bw / 2 + 20;
    left = Math.max(4, Math.min(area.width - bw - 4, left));
    bar.style.top = top + "px";
    bar.style.left = left + "px";
  }

  function hideSelbar() {
    $("#selbar").classList.remove("open");
    selbarKind = null;
  }

  function selectedText() {
    const model = editor.getModel();
    const sels = (editor.getSelections() || []).filter((s) => !s.isEmpty());
    if (!model || !sels.length) return "";
    return sels.map((s) => model.getValueInRange(s)).join(model.getEOL());
  }

  async function doCopy(cut) {
    const text = selectedText();
    if (!text) return;
    await Host.copy(text);
    if (cut) {
      editor.pushUndoStop();
      editor.executeEdits("cut", editor.getSelections().filter((s) => !s.isEmpty()).map((s) => ({ range: s, text: "" })));
      editor.pushUndoStop();
    } else {
      toast("Copied " + text.length + " characters");
    }
    hideSelbar();
    quietFocus();
  }

  async function doPaste() {
    const text = await Host.paste();
    if (!text) { toast("Clipboard is empty"); return; }
    quietFocus();
    editor.trigger("keyboard", "paste", { text, pasteOnNewLine: false, multicursorText: null, mode: null });
    hideSelbar();
  }

  function setFont(size) {
    settings.fontSize = C.clamp(size, 8, 32);
    editor.updateOptions({ fontSize: settings.fontSize });
    $("#sb-zoom").textContent = C.zoomPercent(settings.fontSize, BASE_FONT) + "%";
  }

  function zoomBy(d) {
    setFont(settings.fontSize + d);
    saveSettings();
  }

  function pickLanguage() {
    if (!active) return;
    const cur = active.model.getLanguageId();
    const items = L.list(monaco).map((l) => {
      const [ic, color] = L.icon(l.id);
      return { id: l.id, label: l.name, desc: "(" + l.id + ")", icon: ic, color, group: L.FEATURED.includes(l.id) ? 0 : 1, sep: L.FEATURED.includes(l.id) ? "popular" : "all languages" };
    }).sort((a, b) => a.group - b.group || a.label.localeCompare(b.label));
    quickPick(items, { title: "Select Language Mode", placeholder: "Select Language Mode", activeId: cur }).then((it) => {
      if (!it) return;
      monaco.editor.setModelLanguage(active.model, it.id);
      renderTabs(); updateStatus(); updateBreadcrumbs(); scheduleSession();
    });
  }

  function pickIndent() {
    if (!active) return;
    const o = active.model.getOptions();
    const items = [
      { id: "spaces", label: "Indent Using Spaces", desc: o.insertSpaces ? "current" : "" },
      { id: "tabs", label: "Indent Using Tabs", desc: !o.insertSpaces ? "current" : "" },
      { id: "detect", label: "Detect Indentation from Content" },
      { id: "toSpaces", label: "Convert Indentation to Spaces" },
      { id: "toTabs", label: "Convert Indentation to Tabs" },
    ];
    quickPick(items, { title: "Select Action", placeholder: "Select Action" }).then((it) => {
      if (!it) return;
      if (it.id === "detect") { active.model.detectIndentation(true, 4); updateStatus(); return; }
      if (it.id === "toSpaces") { editor.trigger("menu", "editor.action.indentationToSpaces"); updateStatus(); return; }
      if (it.id === "toTabs") { editor.trigger("menu", "editor.action.indentationToTabs"); updateStatus(); return; }
      const spaces = it.id === "spaces";
      const sizes = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: n, label: String(n), desc: n === o.tabSize ? "Configured Tab Size" : "" }));
      quickPick(sizes, { title: "Select Tab Size for Current File", activeId: o.tabSize }).then((s) => {
        if (!s) return;
        active.model.updateOptions({ insertSpaces: spaces, tabSize: s.id, indentSize: s.id });
        updateStatus();
      });
    });
  }

  function pickEol() {
    if (!active) return;
    const cur = active.model.getEOL() === "\r\n" ? "CRLF" : "LF";
    quickPick([{ id: "LF", label: "LF", desc: "Unix, Android, macOS" }, { id: "CRLF", label: "CRLF", desc: "Windows" }], { title: "Select End of Line Sequence", activeId: cur }).then((it) => {
      if (!it) return;
      active.model.pushEOL(it.id === "LF" ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
      updateStatus();
    });
  }

  function pickEncoding() {
    if (!active) return;
    const cur = active.encoding;
    const encs = ["UTF-8", "UTF-16LE", "UTF-16BE"];
    const items = [];
    for (const e of encs) items.push({ id: e + "|0", label: e, desc: e === cur && !active.bom ? "current" : "" });
    items.push({ id: "UTF-8|1", label: "UTF-8 with BOM", desc: cur === "UTF-8" && active.bom ? "current" : "" });
    quickPick(items, { title: "Save with Encoding", activeId: cur + "|" + (active.bom ? 1 : 0) }).then((it) => {
      if (!it) return;
      const [e, b] = it.id.split("|");
      active.encoding = e;
      active.bom = b === "1" || e !== "UTF-8" ? b === "1" || e !== "UTF-8" : false;
      if (e === "UTF-8") active.bom = b === "1";
      active.savedAlt = -1;
      renderTabs(); updateStatus(); updateTitle(); reportDirty();
    });
  }

  function pickZoom() {
    const cur = settings.fontSize;
    const sizes = [8, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32];
    quickPick(sizes.map((s) => ({ id: s, label: C.zoomPercent(s, BASE_FONT) + "%", desc: s + " px" + (s === BASE_FONT ? " (default)" : "") })), { title: "Editor Zoom", activeId: cur }).then((it) => {
      if (it) { setFont(it.id); saveSettings(); }
    });
  }

  function quickOpen() {
    const items = tabs.map((t) => {
      const [ic, color] = L.icon(t.model.getLanguageId());
      return { id: t.id, label: t.name, desc: (isDirty(t) ? "● " : "") + breadcrumbSegments(t).slice(0, -1).join(" › "), icon: ic, color, group: 0, sep: "open editors" };
    });
    for (const r of Host.recents()) {
      if (tabs.some((t) => t.uri === r.uri)) continue;
      items.push({ id: "recent:" + r.uri, uri: r.uri, label: r.name, desc: "recently opened", icon: "codicon-history", group: 1, sep: "recently opened" });
    }
    items.push({ id: "cmd:open", label: "Open File...", icon: "codicon-folder-opened", group: 2, sep: "other" });
    items.push({ id: "cmd:openFolder", label: "Open Folder...", icon: "codicon-folder-opened", group: 2 });
    quickPick(items, { title: "", placeholder: "Search open editors and recent files by name", activeId: active && active.id }).then((it) => {
      if (!it) return;
      if (it.id === "cmd:open") { run("file.open"); return; }
      if (it.id === "cmd:openFolder") { run("folder.open"); return; }
      if (it.uri) { reopen(it.uri); return; }
      activate(tabById(it.id));
    });
  }

  function reopen(uri, extra) {
    const req = "r" + (++reqSeq);
    pending.set(req, Object.assign({ kind: "open" }, extra || {}));
    Host.reopen(req, uri, !(extra && extra.interactive === false));
  }

  function openSamples() {
    fetch("samples/index.json").then((r) => r.json()).then(async (names) => {
      let first = null;
      for (const n of names) {
        if (tabs.some((t) => t.name === n && !t.uri)) continue;
        const text = await fetch("samples/" + encodeURIComponent(n)).then((r) => r.text());
        const t = createTab({ name: n, text });
        if (t && !first) first = t;
      }
      if (first) activate(first);
      renderTabs();
    }).catch((e) => toast("Could not load samples: " + e.message, "error"));
  }

  function toggleProblems() {
    const p = $("#problems-panel");
    p.hidden = !p.hidden;
    if (!p.hidden) renderProblems();
  }

  function editorAction(id) {
    if (!active) return;
    quietFocus();
    const a = editor.getAction(id);
    if (a) a.run();
    else editor.trigger("daphcode", id, null);
    if (id === "editor.action.quickCommand") {
      // Standalone Monaco can populate Quick Access before its editor-scoped layout
      // has emitted an update. The model then has commands but the virtual list has
      // no rows. Force one real dimension change and restore it in the same frame;
      // this emits onDidLayout without changing the final geometry or using private APIs.
      const ensureQuickAccessRows = (remaining) => {
        const widget = document.querySelector(".quick-input-widget");
        if (!widget || widget.style.display === "none" || widget.querySelector(".monaco-list-row")) return;
        const rect = editor.getContainerDomNode().getBoundingClientRect();
        if (rect.width && rect.height) {
          editor.layout({ width: rect.width + 1, height: rect.height });
          editor.layout({ width: rect.width, height: rect.height });
        }
        if (remaining) setTimeout(() => ensureQuickAccessRows(remaining - 1), 80);
      };
      setTimeout(() => ensureQuickAccessRows(2), 0);
    }
  }

  function mainMenu(anchor) {
    refreshStorage();
    showMenu(anchor, [
      { label: "New Text File", key: "Ctrl+N", cmd: "file.newUntitled" },
      { label: "New File...", cmd: "file.newNamed" },
      { label: "Open File...", key: "Ctrl+O", cmd: "file.open" },
      { label: "Open Folder...", key: "Ctrl+K Ctrl+O", cmd: "folder.open" },
      { label: "Open Recent...", key: "Ctrl+R", cmd: "quickOpen" },
      "-",
      { label: "Save", key: "Ctrl+S", cmd: "file.save", disabled: !active },
      { label: "Save As...", key: "Ctrl+Shift+S", cmd: "file.saveAs", disabled: !active },
      { label: "Save All", cmd: "file.saveAll", disabled: !dirtyTabs().length },
      { label: "Rename...", key: "F2", cmd: "file.rename", disabled: !active },
      { label: "Revert File", cmd: "file.revert", disabled: !active || !active.uri },
      "-",
      { label: "Close Editor", key: Host.web ? "Alt+W" : "Ctrl+W", cmd: "file.close", disabled: !active },
      { label: "Close All Editors", cmd: "file.closeAll", disabled: !tabs.length },
      "-",
      { label: "Open Sample Files", cmd: "samples" },
      { label: "About DaphCode", cmd: "about" },
      { label: Host.web ? (Host.fileAccessLabel ? Host.fileAccessLabel() : "Browser File Access") : storage.granted ? "All Files Access: On" : "Turn On All Files Access...", cmd: "storage.access" },
      { label: Host.web ? "Close Window" : "Exit", cmd: "exit" },
    ]);
  }

  function moreMenu(anchor) {
    const has = !!active;
    showMenu(anchor, [
      { label: "Command Palette...", key: "F1", cmd: "palette", disabled: !has },
      { label: "Go to File...", key: "Ctrl+P", cmd: "quickOpen" },
      { label: "Go to Line...", key: "Ctrl+G", cmd: "gotoLine", disabled: !has },
      { label: "Go to Symbol...", key: "Ctrl+Shift+O", cmd: "gotoSymbol", disabled: !has },
      "-",
      { label: "Find", key: "Ctrl+F", cmd: "find", disabled: !has },
      { label: "Replace", key: "Ctrl+H", cmd: "replace", disabled: !has },
      { label: "Format Document", key: "Shift+Alt+F", cmd: "format", disabled: !has },
      { label: "Toggle Line Comment", key: "Ctrl+/", cmd: "comment", disabled: !has },
      "-",
      { label: "Fold All", key: "Ctrl+K Ctrl+0", cmd: "fold.all", disabled: !has },
      { label: "Unfold All", key: "Ctrl+K Ctrl+J", cmd: "unfold.all", disabled: !has },
      { label: "Fold Level 1", cmd: "fold.level1", disabled: !has },
      { label: "Fold Level 2", cmd: "fold.level2", disabled: !has },
      "-",
      { label: "Word Wrap", key: "Alt+Z", cmd: "toggle.wrap", checked: settings.wordWrap === "on" },
      { label: "Minimap", cmd: "toggle.minimap", checked: settings.minimap },
      { label: "Sticky Scroll", cmd: "toggle.sticky", checked: settings.stickyScroll },
      { label: "Render Whitespace", cmd: "toggle.whitespace", checked: settings.whitespace === "all" },
      "-",
      { label: "Zoom In", key: "Ctrl+=", cmd: "zoom.in" },
      { label: "Zoom Out", key: "Ctrl+-", cmd: "zoom.out" },
      { label: "Reset Zoom", key: "Ctrl+0", cmd: "zoom.reset" },
    ]);
  }

  function tabMenu(anchor, t) {
    const target = t || active;
    if (!target) return;
    showMenu(anchor, [
      { label: "Close", key: Host.web ? "Alt+W" : "Ctrl+W", cmd: "tab.close", arg: target },
      { label: "Close Others", cmd: "tab.closeOthers", arg: target, disabled: tabs.length < 2 },
      { label: "Close to the Right", cmd: "tab.closeRight", arg: target, disabled: tabs.indexOf(target) === tabs.length - 1 },
      { label: "Close Saved", cmd: "file.closeSaved" },
      { label: "Close All", cmd: "file.closeAll" },
      "-",
      { label: "Save", cmd: "tab.save", arg: target },
      { label: "Save As...", cmd: "tab.saveAs", arg: target },
      { label: "Rename...", cmd: "tab.rename", arg: target },
      "-",
      { label: "Copy Name", cmd: "tab.copyName", arg: target },
      { label: "Copy Path", cmd: "tab.copyPath", arg: target, disabled: !target.uri },
    ]);
  }

  function selectionMenu() {
    const bar = $("#selbar");
    showMenu(bar, [
      { label: "Cut", key: "Ctrl+X", cmd: "edit.cut" },
      { label: "Copy", key: "Ctrl+C", cmd: "edit.copy" },
      { label: "Paste", key: "Ctrl+V", cmd: "edit.paste" },
      "-",
      { label: "Find in Selection", cmd: "find" },
      { label: "Add Next Occurrence", key: "Ctrl+D", cmd: "editor:editor.action.addSelectionToNextFindMatch" },
      { label: "Select All Occurrences", key: "Ctrl+Shift+L", cmd: "editor:editor.action.selectHighlights" },
      { label: "Expand Selection", key: "Shift+Alt+→", cmd: "editor:editor.action.smartSelect.expand" },
      "-",
      { label: "Toggle Line Comment", key: "Ctrl+/", cmd: "comment" },
      { label: "Indent Line", key: "Ctrl+]", cmd: "editor:editor.action.indentLines" },
      { label: "Outdent Line", key: "Ctrl+[", cmd: "editor:editor.action.outdentLines" },
      { label: "Fold Selection", cmd: "editor:editor.createFoldingRangeFromSelection" },
      { label: "Format Selection", cmd: "editor:editor.action.formatSelection" },
      { label: "Transform to Uppercase", cmd: "editor:editor.action.transformToUppercase" },
      { label: "Transform to Lowercase", cmd: "editor:editor.action.transformToLowercase" },
    ]);
  }

  function about() {
    const platform = Host.web ? "The Visual Studio Code editor, as a standalone local-first website." : "The Visual Studio Code editor, as a standalone Android app.";
    dialog("DaphCode " + Host.version(), platform + "\nEditor engine: Monaco " + (self.__monacoVersion || "") + ". Font: Cascadia Mono.", [{ label: "OK", primary: true }]);
  }

  function closeHostWindow() {
    flushSession();
    const result = Host.exit();
    if (result === false) toast("Your session is saved. You can close this browser tab.", "info");
  }

  function exitFlow() {
    const d = dirtyTabs();
    if (!d.length) { closeHostWindow(); return; }
    dialog("Do you want to save the changes to " + d.length + " file" + (d.length > 1 ? "s" : "") + "?", "Your changes will be lost if you don't save them.\n" + d.map((t) => t.name).join(", "), [
      { label: "Save All", primary: true, run: () => saveAll().then((ok) => { if (ok) closeHostWindow(); }) },
      { label: "Don't Save", run: () => { for (const t of d) { t.savedAlt = t.model.getAlternativeVersionId(); t.discarded = true; } flushSession(true); closeHostWindow(); } },
      { label: "Cancel" },
    ]);
  }

  function revert() {
    if (!active || !active.uri) return;
    const t = active;
    const go = () => { t.viewState = editor.saveViewState(); t.loading = true; renderTabs(); reopen(t.uri, { revert: t }); };
    if (!isDirty(t)) { go(); return; }
    dialog("Revert " + t.name + "?", "Your unsaved changes will be discarded and the file reloaded from the device.", [
      { label: "Revert", primary: true, run: go },
      { label: "Cancel" },
    ]);
  }

  const commands = {
    "menu.main": (a) => mainMenu(a),
    "menu.more": (a) => moreMenu(a),
    "menu.tabs": (a) => tabMenu(a),
    "menu.selection": () => selectionMenu(),
    "file.newUntitled": () => newUntitled(),
    "file.newNamed": () => newNamed(),
    "file.open": () => openFileFlow(),
    "folder.open": () => folderWorkspace().open(),
    "folder.close": () => folderWorkspace().close(),
    "folder.refresh": () => folderWorkspace().refresh(),
    "folder.toggle": () => folderWorkspace().toggle(),
    "storage.access": () => allFilesAccessFlow(),
    "file.save": () => saveTab(active),
    "file.saveAs": () => saveTab(active, true),
    "file.saveAll": () => saveAll(),
    "file.rename": () => renameTab(active),
    "file.revert": () => revert(),
    "file.close": () => active && closeTab(active),
    "file.closeAll": () => closeMany(tabs),
    "file.closeSaved": () => closeMany(tabs.filter((t) => !isDirty(t))),
    "tab.close": (a, t) => closeTab(t),
    "tab.closeOthers": (a, t) => closeMany(tabs.filter((x) => x !== t)),
    "tab.closeRight": (a, t) => closeMany(tabs.slice(tabs.indexOf(t) + 1)),
    "tab.save": (a, t) => saveTab(t),
    "tab.saveAs": (a, t) => saveTab(t, true),
    "tab.rename": (a, t) => renameTab(t),
    "tab.copyName": (a, t) => { Host.copy(t.name); toast("Copied name"); },
    "tab.copyPath": (a, t) => { Host.copy(t.uri); toast("Copied path"); },
    "edit.undo": () => { if (active) { quietFocus(); editor.trigger("daphcode", "undo", null); } },
    "edit.redo": () => { if (active) { quietFocus(); editor.trigger("daphcode", "redo", null); } },
    "edit.cut": () => doCopy(true),
    "edit.copy": () => doCopy(false),
    "edit.paste": () => doPaste(),
    "edit.selectAll": () => { quietFocus(); editor.setSelection(active.model.getFullModelRange()); touchSelection = true; showSelbar("sel"); gestures.placeHandles(); },
    "edit.selectWord": () => {
      const p = editor.getPosition();
      const w = active.model.getWordAtPosition(p);
      if (w) { editor.setSelection(new monaco.Range(p.lineNumber, w.startColumn, p.lineNumber, w.endColumn)); touchSelection = true; showSelbar("sel"); gestures.placeHandles(); }
      else hideSelbar();
    },
    "find": () => editorAction("actions.find"),
    "replace": () => editorAction("editor.action.startFindReplaceAction"),
    "gotoLine": () => editorAction("editor.action.gotoLine"),
    "gotoSymbol": () => editorAction("editor.action.quickOutline"),
    "palette": () => editorAction("editor.action.quickCommand"),
    "quickOpen": () => quickOpen(),
    "format": () => editorAction("editor.action.formatDocument"),
    "comment": () => editorAction("editor.action.commentLine"),
    "fold.all": () => editorAction("editor.foldAll"),
    "unfold.all": () => editorAction("editor.unfoldAll"),
    "fold.level1": () => editorAction("editor.foldLevel1"),
    "fold.level2": () => editorAction("editor.foldLevel2"),
    "toggle.wrap": () => { settings.wordWrap = settings.wordWrap === "on" ? "off" : "on"; editor.updateOptions({ wordWrap: settings.wordWrap }); saveSettings(); },
    "toggle.minimap": () => { settings.minimap = !settings.minimap; editor.updateOptions({ minimap: { enabled: settings.minimap && !(active && active.large) } }); saveSettings(); },
    "toggle.sticky": () => { settings.stickyScroll = !settings.stickyScroll; editor.updateOptions({ stickyScroll: { enabled: settings.stickyScroll } }); saveSettings(); },
    "toggle.whitespace": () => { settings.whitespace = settings.whitespace === "all" ? "selection" : "all"; editor.updateOptions({ renderWhitespace: settings.whitespace }); saveSettings(); },
    "zoom.in": () => zoomBy(1),
    "zoom.out": () => zoomBy(-1),
    "zoom.reset": () => { setFont(BASE_FONT); saveSettings(); },
    "pick.language": () => pickLanguage(),
    "pick.indent": () => pickIndent(),
    "pick.eol": () => pickEol(),
    "pick.encoding": () => pickEncoding(),
    "pick.zoom": () => pickZoom(),
    "problems": () => toggleProblems(),
    "notifications": (a) => showMenu(a, notifications.length ? notifications.slice(0, 10).map((n) => ({ label: n.msg.length > 60 ? n.msg.slice(0, 60) + "…" : n.msg })) : [{ label: "No new notifications", disabled: true }]),
    "samples": () => openSamples(),
    "about": () => about(),
    "exit": () => exitFlow(),
  };

  function run(cmd, anchor, arg) {
    if (cmd.startsWith("editor:")) { editorAction(cmd.slice(7)); return; }
    const f = commands[cmd];
    if (f) f(anchor, arg);
  }

  let sessionTimer = 0;

  function scheduleSession() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => flushSession(), 900);
  }

  function flushSession(dropDirty) {
    clearTimeout(sessionTimer);
    if (!monaco) return;
    if (active && editor.getModel()) active.viewState = editor.saveViewState();
    const list = tabs.map((t) => {
      const dirty = isDirty(t) && !dropDirty;
      const want = dirty || (!t.uri && !(dropDirty && t.discarded));
      // The session store holds ~4 MB; copying a big document on every edit would only waste time.
      const tooBig = t.model.getValueLength() > 2 * 1024 * 1024;
      return {
        name: t.name, uri: t.uri, lang: t.model.getLanguageId(), encoding: t.encoding, bom: t.bom,
        viewState: t.viewState, dirty,
        text: want && !tooBig ? t.model.getValue() : null,
        textDropped: want && tooBig ? true : undefined,
      };
    });
    const out = { tabs: C.sessionTrim(list, 4 * 1024 * 1024), active: active ? tabs.indexOf(active) : -1 };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(out)); } catch (_) {
      try { localStorage.setItem(SESSION_KEY, JSON.stringify({ tabs: C.sessionTrim(list, 512 * 1024), active: out.active })); } catch (__) {}
    }
  }

  function restoreSession() {
    const s = safeJson(localStorage.getItem(SESSION_KEY));
    if (!s || !Array.isArray(s.tabs) || !s.tabs.length) return false;
    let want = null;
    s.tabs.forEach((x, i) => {
      let t = null;
      if (x.text != null) {
        t = createTab({ name: x.name, uri: x.uri, text: x.text, lang: x.lang, encoding: x.encoding, bom: x.bom, viewState: x.viewState, dirty: x.dirty, index: tabs.length });
      } else if (x.uri) {
        t = createTab({ name: x.name, uri: x.uri, text: "", lang: x.lang, encoding: x.encoding, bom: x.bom, viewState: x.viewState, loading: true, index: tabs.length });
        if (t) reopen(x.uri, { fill: t, interactive: false });
      }
      if (i === s.active) want = t;
    });
    if (!tabs.length) return false;
    activate(want || tabs[0], { noFocus: true });
    return true;
  }

  function renderWelcome() {
    const box = $("#wm-recent");
    box.textContent = "";
    const rec = Host.recents().slice(0, 8);
    if (!rec.length) { box.append(el("div", "wm-empty", "No recent files")); }
    for (const r of rec) {
      const a = el("div", "wm-recent-item");
      a.dataset.uri = r.uri;
      a.setAttribute("role", "button");
      a.tabIndex = 0;
      a.append(icon("codicon-file"), el("span", null, r.name));
      box.append(a);
    }
    $("#wm-version").textContent = "DaphCode " + Host.version();
  }

  function setKbdState() {
    const on = editorFocused && !!active && (Host.web ? Host.touch && imeVisible : imeVisible || !Host.native);
    document.body.classList.toggle("kbd", on);
  }

  // ---- Soft-keyboard policy -------------------------------------------------
  // The IME must only appear when the user taps into the text (or into a real
  // input such as Find / Go to Line). Buttons, tabs, menus and dialogs refocus the
  // editor "quietly": the Monaco textarea gets inputmode="none", which keeps the
  // caret, hardware-keyboard input and all commands working without the IME.
  let kbdForcing = false;
  let kbdRetry = 0;

  function editorTextarea() {
    if (!editor) return null;
    const dom = editor.getContainerDomNode();
    return dom.querySelector("textarea.inputarea") || dom.querySelector("textarea");
  }

  function setQuiet(ta) {
    if (ta && ta.getAttribute("inputmode") !== "none") ta.setAttribute("inputmode", "none");
  }

  function quietFocus() {
    if (!editor) return;
    const ta = editorTextarea();
    // If the keyboard is already up (user is typing), leave it up; otherwise stay quiet.
    if (!ta) { editor.focus(); return; }
    if (imeVisible) ta.removeAttribute("inputmode");
    else setQuiet(ta);
    editor.focus();
  }

  function keyboardFocus() {
    if (!editor) return;
    const ta = editorTextarea();
    clearTimeout(kbdRetry);
    if (ta) {
      const wasQuiet = ta.getAttribute("inputmode") === "none";
      ta.removeAttribute("inputmode");
      if (document.activeElement === ta && (!imeVisible || wasQuiet)) {
        // Re-focus inside the user gesture so the WebView raises the IME.
        kbdForcing = true;
        ta.blur();
        kbdForcing = false;
      }
    }
    editor.focus();
    if (Host.native) {
      kbdRetry = setTimeout(() => {
        if (!imeVisible && editor.hasTextFocus()) Host.showKeyboard();
      }, 320);
    }
  }

  function installKeyboardPolicy() {
    setQuiet(editorTextarea());
    // Whenever the editor text loses focus, the next programmatic refocus must be quiet.
    // Delegated, because Monaco may recreate its textarea (e.g. on setModel).
    const container = editor.getContainerDomNode();
    container.addEventListener("focusout", (e) => {
      const t = e.target;
      if (!kbdForcing && t && t.tagName === "TEXTAREA" && t.classList.contains("inputarea")) setQuiet(t);
    }, true);
    if (Host.web) {
      container.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && editor.hasTextFocus() && container.querySelector(".suggest-widget.visible")) editor.trigger("daphcode.shiftEnter", "hideSuggestWidget", null);
      }, true);
    }
    if (Host.web && Host.touch) {
      container.addEventListener("pointerup", (e) => {
        if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
        const row = e.target && e.target.closest && e.target.closest(".suggest-widget .monaco-list-row");
        if (!row || !container.contains(row)) return;
        const ta = editorTextarea();
        if (!ta) return;
        setTimeout(() => {
          if (ta.isConnected && editorTextarea() === ta && ta.classList.contains("ime-input")) ta.dispatchEvent(new Event("-monaco-textarea-synthetic-tap"));
        }, 0);
      }, true);
    }
  }

  const ACC = [
    ["codicon-arrow-right", "tab", "Tab"], ["codicon-arrow-left", "outdent", "Shift+Tab"], ["Esc", "esc"], "|",
    ["codicon-chevron-left", "cursorLeft", null, true], ["codicon-chevron-down", "cursorDown", null, true],
    ["codicon-chevron-up", "cursorUp", null, true], ["codicon-chevron-right", "cursorRight", null, true],
    ["Sel", "selmode"], "|",
    ["{"], ["}"], ["("], [")"], ["["], ["]"], [";"], [":"], ["\""], ["'"], ["="], ["<"], [">"], ["/"], ["\\"],
    ["|"], ["&"], ["!"], ["-"], ["_"], ["+"], ["*"], ["#"], ["$"], ["%"], ["`"], ["?"], ["@"], ["~"], "|",
    ["codicon-discard", "undo"], ["codicon-redo", "redo"], ["//", "comment"],
  ];
  let selMode = false;

  function buildAccessory() {
    const box = $("#accessory");
    ACC.forEach((k, i) => {
      if (k === "|") { box.append(el("div", "acc-sep")); return; }
      const b = el("div", "acc-key");
      b.dataset.acc = i;
      if (k[0].startsWith("codicon-")) b.append(icon(k[0]));
      else b.textContent = k[0];
      box.append(b);
    });
  }

  function accessoryAction(k) {
    const cmd = k[1];
    if (!cmd) { editor.trigger("keyboard", "type", { text: k[0] }); return; }
    if (cmd === "selmode") {
      selMode = !selMode;
      document.querySelector('.acc-key[data-acc="' + ACC.indexOf(k) + '"]').classList.toggle("on", selMode);
      return;
    }
    if (cmd === "esc") {
      editor.trigger("keyboard", "hideSuggestWidget", null);
      editor.trigger("keyboard", "closeFindWidget", null);
      editor.trigger("keyboard", "cancelSelection", null);
      editor.trigger("keyboard", "removeSecondaryCursors", null);
      hideSelbar();
      return;
    }
    if (cmd === "comment") { editor.trigger("keyboard", "editor.action.commentLine", null); return; }
    if (cmd.startsWith("cursor")) { editor.trigger("keyboard", cmd + (selMode ? "Select" : ""), null); return; }
    editor.trigger("keyboard", cmd, null);
  }

  function wireAccessory() {
    const box = $("#accessory");
    let rep = null;
    const stopRep = () => { if (rep) { clearTimeout(rep.t); clearInterval(rep.i); rep = null; } };
    box.addEventListener("pointerdown", (e) => {
      const b = e.target.closest(".acc-key");
      if (!b) return;
      e.preventDefault();
      const k = ACC[Number(b.dataset.acc)];
      b.classList.add("pressed");
      stopRep();
      rep = { b, k, x: e.clientX, fired: false, sl: box.scrollLeft };
      if (k[3]) {
        rep.t = setTimeout(() => {
          if (!rep) return;
          rep.fired = true;
          rep.i = setInterval(() => accessoryAction(k), 55);
          accessoryAction(k);
        }, 380);
      }
    });
    box.addEventListener("pointermove", (e) => {
      if (rep && Math.abs(e.clientX - rep.x) > 12) { rep.b.classList.remove("pressed"); stopRep(); }
    });
    const up = (e) => {
      if (!rep) return;
      e.preventDefault();
      const r = rep;
      r.b.classList.remove("pressed");
      stopRep();
      if (!r.fired && Math.abs(box.scrollLeft - r.sl) < 3) accessoryAction(r.k);
    };
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", (e) => { if (rep) { rep.b.classList.remove("pressed"); } stopRep(); });
    box.addEventListener("mousedown", (e) => e.preventDefault());
  }

  // Hidden-overflow containers must never scroll: when an off-screen input gets focus the
  // browser would scroll them and the whole editor ("camera") jumps sideways.
  function lockContainerScroll() {
    const LOCK = "html, body, #editor, .monaco-editor, .overflow-guard, .overlayWidgets, .overflowingContentWidgets";
    document.addEventListener("scroll", (e) => {
      const t = e.target;
      if (!t || t.nodeType !== 1 || !t.matches(LOCK)) return;
      if (t.scrollLeft) t.scrollLeft = 0;
      if (t.scrollTop) t.scrollTop = 0;
    }, true);
  }

  // Strip desktop shortcut hints like "Match Case (Alt+C)" from Monaco tooltips.
  const KEY_HINT = /\s*\((?:Ctrl|Alt|Shift|Cmd|Meta|Enter|Escape|Esc|F\d+|Up|Down|Left|Right|Tab)[^)]*\)\s*$/;
  function stripKeyHints(root) {
    for (const n of root.querySelectorAll("[title], [aria-label]")) {
      for (const a of ["title", "aria-label"]) {
        const v = n.getAttribute(a);
        if (v && KEY_HINT.test(v)) n.setAttribute(a, v.replace(KEY_HINT, ""));
      }
    }
  }
  function watchKeyHints() {
    const target = $("#editor");
    if (!target) return;
    let pendingStrip = 0;
    new MutationObserver(() => {
      if (pendingStrip) return;
      pendingStrip = requestAnimationFrame(() => { pendingStrip = 0; stripKeyHints(target); });
    }).observe(target, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
    stripKeyHints(target);
  }

  function wireBrowser() {
    if (!Host.web) return;
    const tabStrip = $("#tabs");
    tabStrip.addEventListener("contextmenu", (e) => {
      if (!matchMedia("(pointer: fine)").matches) return;
      const row = e.target.closest(".tab");
      const tab = row && tabById(row.dataset.id);
      if (tab) { e.preventDefault(); tabMenu({ x: e.clientX, y: e.clientY }, tab); }
    });
    tabStrip.addEventListener("keydown", (e) => {
      const row = e.target.closest(".tab");
      if (!row) return;
      const tab = tabById(row.dataset.id);
      if (!tab) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const offset = e.key === "ArrowRight" ? 1 : tabs.length - 1;
        activate(tabs[(tabs.indexOf(tab) + offset) % tabs.length]);
        const next = tabStrip.querySelector(".tab.active");
        if (next) next.focus();
      } else if (e.key === "Delete") { e.preventDefault(); closeTab(tab); }
    });
    $("#wm-recent").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const row = e.target.closest(".wm-recent-item");
      if (row) { e.preventDefault(); reopen(row.dataset.uri); }
    });
    document.addEventListener("keydown", (e) => {
      const dialogLayer = $("#dialog-layer");
      if (!dialogLayer.hidden) {
        if (e.key === "Escape") {
          e.preventDefault();
          let index = dlgState.buttons.findIndex((button) => /cancel|not now/i.test(button.label));
          closeDialog(index < 0 ? dlgState.buttons.length - 1 : index);
        } else if (e.key === "Enter") {
          e.preventDefault();
          let index = dlgState.buttons.findIndex((button) => button.primary);
          closeDialog(index < 0 ? 0 : index);
        } else if (e.key === "Tab") {
          const buttons = Array.from($("#dlg-buttons").querySelectorAll("button"));
          if (buttons.length) {
            e.preventDefault();
            const current = buttons.indexOf(document.activeElement);
            const offset = e.shiftKey ? buttons.length - 1 : 1;
            buttons[(current + offset + buttons.length) % buttons.length].focus();
          }
        }
        return;
      }
      const menuLayer = currentMenuLayer();
      if (menuLayer.classList.contains("open")) {
        const rows = Array.from(menuLayer.querySelectorAll(".menu-item:not(.disabled)"));
        if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          let index = rows.indexOf(document.activeElement);
          if (e.key === "Home") index = 0;
          else if (e.key === "End") index = rows.length - 1;
          else index = (index + (e.key === "ArrowDown" ? 1 : rows.length - 1) + rows.length) % rows.length;
          if (rows[index]) rows[index].focus();
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          const row = document.activeElement.closest && document.activeElement.closest(".menu-item");
          if (row && row._item) {
            e.preventDefault();
            const item = row._item;
            closeMenu();
            if (item.cmd) run(item.cmd, null, item.arg);
          }
          return;
        }
      }
      if (!$("#quick-input").hidden) return;
      if ((e.key === "Enter" || e.key === " ") && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
        const target = e.target.closest && e.target.closest("[data-cmd]");
        if (target) { e.preventDefault(); run(target.dataset.cmd, target); return; }
      }
      if (!e.repeat && (e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        let command = null;
        if (key === "s") command = e.shiftKey ? "file.saveAs" : "file.save";
        else if (!e.shiftKey && key === "o") command = "file.open";
        else if (key === "p") command = e.shiftKey ? "palette" : "quickOpen";
        else if (!e.shiftKey && key === "n") command = "file.newUntitled";
        if (command) { e.preventDefault(); e.stopImmediatePropagation(); run(command); return; }
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "w") { e.preventDefault(); run("file.close"); }
      else if (e.key === "F2" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); run("file.rename"); }
    }, true);
    let dragDepth = 0;
    const overlay = el("div", "drop-overlay", "Drop text files to open them in DaphCode");
    overlay.hidden = true;
    overlay.setAttribute("role", "status");
    document.body.appendChild(overlay);
    const hasFiles = (e) => {
      const transfer = e.dataTransfer;
      if (!transfer) return false;
      if (Array.from(transfer.types || []).includes("Files")) return true;
      return Array.from(transfer.items || []).some((item) => item.kind === "file") || !!(transfer.files && transfer.files.length);
    };
    document.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      overlay.hidden = false;
    });
    document.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    document.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) overlay.hidden = true;
    });
    document.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      overlay.hidden = true;
      if (Host.openDataTransfer) Host.openDataTransfer(e.dataTransfer);
    });
    addEventListener("dragend", () => { dragDepth = 0; overlay.hidden = true; });
    addEventListener("daphcode:toast", (e) => { if (e.detail && e.detail.text) toast(e.detail.text, e.detail.kind); });
    addEventListener("beforeunload", (e) => {
      if (!dirtyTabs().length) return;
      e.preventDefault();
      e.returnValue = "";
    });
    const syncViewport = () => {
      if (!Host.touch || imeFromHost) return;
      const viewport = self.visualViewport;
      const available = viewport ? viewport.height : innerHeight;
      const covered = Math.max(innerHeight, screen.height || 0) - available - (viewport ? viewport.offsetTop : 0);
      const next = editorFocused && covered > 140;
      if (next === imeVisible) return;
      const was = imeVisible;
      imeVisible = next;
      if (was && !next) setQuiet(editorTextarea());
      setKbdState();
    };
    if (self.visualViewport) {
      self.visualViewport.addEventListener("resize", syncViewport);
      self.visualViewport.addEventListener("scroll", syncViewport);
    }
    addEventListener("resize", syncViewport);
    document.addEventListener("focusin", () => setTimeout(syncViewport, 0));
    document.addEventListener("focusout", () => setTimeout(syncViewport, 100));
  }

  function wireChrome() {
    folderWorkspace();
    lockContainerScroll();
    // keepFocus: the button must not steal focus, otherwise the tap's synthetic mousedown
    // blurs whatever the command just focused (e.g. the Command Palette input closes itself).
    tapper(document.body, "[data-cmd]", (t) => {
      const cmd = t.dataset.cmd;
      closeMenu();
      run(cmd, t);
    }, { keepFocus: true });
    tapper($("#tabs"), ".tab", (t, e) => {
      const tab = tabById(t.dataset.id);
      if (!tab) return;
      if (e.button === 1) { closeTab(tab); return; }
      const close = e.target.closest && e.target.closest(".tab-close");
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (close || (hit && hit.closest(".tab-close"))) closeTab(tab);
      else activate(tab);
    }, { keepFocus: true, scroller: () => $("#tabs"), onLong: (t) => { const tab = tabById(t.dataset.id); if (tab) tabMenu(t, tab); } });
    tapper($("#menu-layer"), ".menu-item, .menu", (t, e) => {
      if (!t.classList.contains("menu-item")) return;
      const it = t._item;
      if (!it || it.disabled) return;
      closeMenu();
      if (it.cmd) run(it.cmd, null, it.arg);
    }, { scroller: (t) => t.closest(".menu") || t });
    $("#menu-layer").addEventListener("pointerdown", (e) => { if (e.target === $("#menu-layer")) { e.preventDefault(); closeMenu(); } });
    tapper($("#qi-list"), ".qi-item", (t) => { qi.active = Number(t.dataset.idx); acceptQuick(); }, { scroller: () => $("#qi-list") });
    $("#quick-input").addEventListener("pointerdown", (e) => { if (e.target === $("#quick-input")) { e.preventDefault(); closeQuickInput(undefined); } });
    tapper($("#dlg-buttons"), ".dlg-btn", (t) => closeDialog(Number(t.dataset.idx)));
    tapper($("#wm-recent"), ".wm-recent-item", (t) => reopen(t.dataset.uri), { scroller: () => $("#welcome") });
    tapper($("#pp-list"), ".pp-row", (t) => {
      const ln = Number(t.dataset.line), col = Number(t.dataset.col);
      editor.setPosition({ lineNumber: ln, column: col });
      editor.revealPositionInCenter({ lineNumber: ln, column: col });
      quietFocus();
    }, { scroller: () => $("#pp-list") });
    const inp = $("#qi-input");
    inp.addEventListener("input", () => {
      if (qi.mode === "pick") { qi.active = 0; renderQuickList(); }
      else { const m = $("#qi-msg"); m.textContent = qi.prompt || ""; m.className = "qi-msg"; }
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); acceptQuick(); }
      else if (e.key === "Escape") { e.preventDefault(); closeQuickInput(undefined); }
      else if (qi.mode === "pick" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const n = qi.filtered.length;
        if (!n) return;
        qi.active = (qi.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        renderQuickList();
        const a = $("#qi-list .qi-item.active");
        if (a) a.scrollIntoView({ block: "nearest" });
      }
    });
    buildAccessory();
    wireAccessory();
    wireBrowser();
  }

  function registerActions() {
    const K = monaco.KeyMod, KC = monaco.KeyCode;
    const acts = [
      ["daph.save", "File: Save", [K.CtrlCmd | KC.KeyS], "file.save"],
      ["daph.saveAs", "File: Save As...", [K.CtrlCmd | K.Shift | KC.KeyS], "file.saveAs"],
      ["daph.saveAll", "File: Save All", [], "file.saveAll"],
      ["daph.new", "File: New Text File", [K.CtrlCmd | KC.KeyN], "file.newUntitled"],
      ["daph.newNamed", "File: New File...", [K.CtrlCmd | K.Alt | KC.KeyN], "file.newNamed"],
      ["daph.open", "File: Open File...", [K.CtrlCmd | KC.KeyO], "file.open"],
      ["daph.openFolder", "File: Open Folder...", [K.CtrlCmd | KC.KeyK, K.CtrlCmd | KC.KeyO], "folder.open"],
      ["daph.rename", "File: Rename...", [Host.web ? KC.F2 : KC.F2 | K.Shift], "file.rename"],
      ["daph.revert", "File: Revert File", [], "file.revert"],
      ["daph.close", "View: Close Editor", [Host.web ? K.Alt | KC.KeyW : K.CtrlCmd | KC.KeyW], "file.close"],
      ["daph.closeAll", "View: Close All Editors", [], "file.closeAll"],
      ["daph.quickOpen", "Go to File...", [K.CtrlCmd | KC.KeyP], "quickOpen"],
      ["daph.recent", "File: Open Recent...", [K.CtrlCmd | KC.KeyR], "quickOpen"],
      ["daph.lang", "Change Language Mode", [K.CtrlCmd | KC.KeyK, KC.KeyM], "pick.language"],
      ["daph.eol", "Change End of Line Sequence", [], "pick.eol"],
      ["daph.indent", "Change Indentation", [], "pick.indent"],
      ["daph.encoding", "Change File Encoding", [], "pick.encoding"],
      ["daph.wrap", "View: Toggle Word Wrap", [K.Alt | KC.KeyZ], "toggle.wrap"],
      ["daph.minimap", "View: Toggle Minimap", [], "toggle.minimap"],
      ["daph.sticky", "View: Toggle Sticky Scroll", [], "toggle.sticky"],
      ["daph.ws", "View: Toggle Render Whitespace", [], "toggle.whitespace"],
      ["daph.zin", "View: Zoom In", [K.CtrlCmd | KC.Equal], "zoom.in"],
      ["daph.zout", "View: Zoom Out", [K.CtrlCmd | KC.Minus], "zoom.out"],
      ["daph.zreset", "View: Reset Zoom", [K.CtrlCmd | KC.Digit0], "zoom.reset"],
      ["daph.problems", "View: Toggle Problems", [K.CtrlCmd | K.Shift | KC.KeyM], "problems"],
      ["daph.samples", "Help: Open Sample Files", [], "samples"],
    ];
    for (const [id, label, keys, cmd] of acts) {
      editor.addAction({ id, label, keybindings: keys.length === 2 ? [monaco.KeyMod.chord(keys[0], keys[1])] : keys, run: () => run(cmd) });
    }
    editor.addAction({ id: "daph.nextTab", label: "View: Open Next Editor", keybindings: [K.WinCtrl | KC.Tab, K.CtrlCmd | KC.PageDown], run: () => { if (tabs.length > 1) activate(tabs[(tabs.indexOf(active) + 1) % tabs.length]); } });
    editor.addAction({ id: "daph.prevTab", label: "View: Open Previous Editor", keybindings: [K.WinCtrl | K.Shift | KC.Tab, K.CtrlCmd | KC.PageUp], run: () => { if (tabs.length > 1) activate(tabs[(tabs.indexOf(active) + tabs.length - 1) % tabs.length]); } });
  }

  function defineTheme() {
    monaco.editor.defineTheme("daphcode-dark-plus", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "8B949E" },
        { token: "identifier.python", foreground: "C9D1D9" },
        { token: "keyword", foreground: "C586C0" },
        { token: "keyword.control", foreground: "C586C0" },
        { token: "keyword.flow", foreground: "C586C0" },
        { token: "number.hex", foreground: "B5CEA8" },
        { token: "namespace", foreground: "4EC9B0" },
        { token: "class", foreground: "4EC9B0" },
        { token: "property", foreground: "79C0FF" },
        { token: "parameter", foreground: "9CDCFE" },
        { token: "definitionKeyword", foreground: "FF7B72" },
        { token: "numericPrefix", foreground: "FF7B72" },
        { token: "numericBody", foreground: "B5CEA8" },
        { token: "type", foreground: "4EC9B0" },
        { token: "type.identifier", foreground: "4EC9B0" },
        { token: "annotation", foreground: "DCDCAA" },
        { token: "tag", foreground: "569CD6" },
        { token: "attribute.name", foreground: "9CDCFE" },
        { token: "attribute.value", foreground: "CE9178" },
        { token: "variable", foreground: "9CDCFE" },
        { token: "variable.predefined", foreground: "4FC1FF" },
        { token: "function", foreground: "DCDCAA" },
        { token: "regexp", foreground: "D16969" },
      ],
      colors: {
        "editor.background": "#121314",
        "editor.foreground": "#D4D4D4",
        "editorLineNumber.foreground": "#858889",
        "editorLineNumber.activeForeground": "#C6C6C6",
        "editor.lineHighlightBorder": "#282828",
        "editor.selectionBackground": "#264F78",
        "editor.inactiveSelectionBackground": "#3A3D41",
        "editor.selectionHighlightBackground": "#ADD6FF26",
        "editorIndentGuide.background1": "#404040",
        "editorIndentGuide.activeBackground1": "#707070",
        "editorBracketMatch.background": "#0064001A",
        "editorBracketMatch.border": "#888888",
        "editorCursor.foreground": "#AEAFAD",
        "editorWhitespace.foreground": "#E3E4E229",
        "editorGutter.background": "#121314",
        "editorGutter.foldingControlForeground": "#C5C5C5",
        "editorWidget.background": "#252526",
        "editorWidget.border": "#454545",
        "editorSuggestWidget.background": "#252526",
        "editorSuggestWidget.border": "#454545",
        "editorSuggestWidget.selectedBackground": "#04395E",
        "editorHoverWidget.background": "#252526",
        "editorHoverWidget.border": "#454545",
        "minimap.background": "#121314",
        "minimapSlider.background": "#79797933",
        "scrollbarSlider.background": "#79797966",
        "scrollbarSlider.hoverBackground": "#646464B3",
        "scrollbarSlider.activeBackground": "#BFBFBF66",
        "scrollbar.shadow": "#000000",
        "editorStickyScroll.background": "#121314",
        "editorStickyScroll.shadow": "#000000",
        "quickInput.background": "#252526",
        "quickInputList.focusBackground": "#04395E",
        "list.activeSelectionBackground": "#04395E",
        "list.highlightForeground": "#2AAAFF",
        "input.background": "#3C3C3C",
        "focusBorder": "#007FD4",
        "editorError.foreground": "#F14C4C",
        "editorWarning.foreground": "#CCA700",
        "editorInfo.foreground": "#3794FF",
        "editorOverviewRuler.border": "#7F7F7F4D",
        "editorBracketHighlight.foreground1": "#FFD700",
        "editorBracketHighlight.foreground2": "#DA70D6",
        "editorBracketHighlight.foreground3": "#179FFF",
      },
    });
  }

  // Monaco restarts quick suggestions for typed text, but not after a closed
  // suggestion session is deleted with Backspace/Delete. Keep one compatible
  // provider-item set as a fallback: trigger-character providers often need
  // the original item set (HTML doctype is an example) when the caret returns
  // to an intermediate prefix. Fresh suggestions always get the first chance.
  function reusableSuggestItems(model, position) {
    const cache = suggestAfterDeleteCache;
    if (!cache || cache.model !== model || cache.line !== position.lineNumber) return null;
    const line = model.getLineContent(position.lineNumber);
    if (cache.lineText.startsWith(line)) return cache.items;
    // A cached trigger-character session may have started at a shorter prefix
    // (for example < before an accepted doctype snippet). Only extend that
    // exact trigger prefix; never reuse an unrelated line's items.
    if (!cache.triggerCharacter || !line.startsWith(cache.lineText)) return null;
    const at = line.lastIndexOf(cache.triggerCharacter);
    return at >= 0 && line.substring(0, at + cache.triggerCharacter.length) === cache.triggerPrefix ? cache.items : null;
  }

  function cancelSuggestAfterDeletePending() {
    const pending = suggestAfterDeletePending;
    if (pending && pending.cts) pending.cts.cancel();
    suggestAfterDeletePending = null;
  }

  function finishSuggestAfterDelete(pending) {
    if (suggestAfterDeletePending === pending) suggestAfterDeletePending = null;
  }

  function loadSuggestAfterDeleteApi() {
    return new Promise((resolve, reject) => {
      try {
        require([
          "vs/editor/contrib/suggest/browser/suggest",
          "vs/editor/contrib/suggest/browser/suggestModel",
        ], (suggest, model) => resolve({ suggest, model }), reject);
      } catch (error) { reject(error); }
    });
  }

  function suggestAfterDeleteStillCurrent(pending, model, position, version) {
    return suggestAfterDeletePending === pending && pending.ticket === suggestAfterDeleteSeq &&
      editor.getModel() === model && !model.isDisposed() && model.getVersionId() === version &&
      editor.getPosition() && editor.getPosition().equals(position) && editor.hasWidgetFocus() && !(active && active.huge);
  }

  async function primeSuggestAfterDelete(pending) {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position || !suggestAfterDeleteStillCurrent(pending, model, position, model.getVersionId())) return;
    const controller = editor.getContribution("editor.contrib.suggestController");
    const registry = controller && controller.model && controller.model._languageFeaturesService.completionProvider;
    if (!registry || typeof registry.all !== "function" || !editor.getOption(monaco.editor.EditorOption.suggestOnTriggerCharacters)) {
      finishSuggestAfterDelete(pending);
      return;
    }
    pending.priming = true;
    const providers = Array.from(registry.all(model));
    const byTrigger = new Map();
    for (const provider of providers) {
      for (const ch of provider.triggerCharacters || []) {
        if (!byTrigger.has(ch)) byTrigger.set(ch, new Set());
        byTrigger.get(ch).add(provider);
      }
    }
    const before = model.getLineContent(position.lineNumber).substring(0, position.column - 1);
    let triggerCharacter = "";
    let triggerAt = -1;
    let providerFilter = null;
    byTrigger.forEach((providersForCharacter, ch) => {
      const at = before.lastIndexOf(ch);
      if (at > triggerAt) {
        triggerCharacter = ch;
        triggerAt = at;
        providerFilter = providersForCharacter;
      }
    });
    if (!triggerCharacter || triggerAt < 0 || !providerFilter || !providerFilter.size) {
      finishSuggestAfterDelete(pending);
      return;
    }
    const version = model.getVersionId();
    let api;
    try { api = await loadSuggestAfterDeleteApi(); }
    catch (_) { finishSuggestAfterDelete(pending); return; }
    if (!suggestAfterDeleteStillCurrent(pending, model, position, version)) return;
    const snippetProvider = api.suggest.getSnippetSuggestSupport && api.suggest.getSnippetSuggestSupport();
    if (snippetProvider) providerFilter.add(snippetProvider);
    const filter = api.model.SuggestModel.createSuggestFilter(editor);
    const snippetSetting = editor.getOption(monaco.editor.EditorOption.snippetSuggestions);
    const snippetSortOrder = snippetSetting === "top" ? 0 : snippetSetting === "bottom" ? 2 : 1;
    const options = new api.suggest.CompletionOptions(snippetSortOrder, filter.itemKind, providerFilter, undefined, filter.showDeprecated);
    const cts = new monaco.CancellationTokenSource();
    pending.cts = cts;
    let result;
    try {
      result = await api.suggest.provideSuggestionItems(
        registry, model, new monaco.Position(position.lineNumber, triggerAt + triggerCharacter.length + 1),
        options, { triggerKind: 1, triggerCharacter }, cts.token,
      );
    } catch (_) {
      finishSuggestAfterDelete(pending);
      cts.dispose();
      return;
    }
    cts.dispose();
    pending.cts = null;
    if (!suggestAfterDeleteStillCurrent(pending, model, position, version)) {
      if (result && result.disposable) result.disposable.dispose();
      return;
    }
    if (!result || !result.items.length) {
      if (result && result.disposable) result.disposable.dispose();
      finishSuggestAfterDelete(pending);
      return;
    }
    const items = new Map();
    for (const item of result.items) {
      if (!items.has(item.provider)) items.set(item.provider, []);
      items.get(item.provider).push(item);
    }
    if (controller.model._completionDisposables && result.disposable) controller.model._completionDisposables.add(result.disposable);
    finishSuggestAfterDelete(pending);
    controller.model.trigger({ auto: true, retrigger: true, completionOptions: { providerItemsToReuse: items } });
    editor.revealPosition(position);
    editor.focus();
  }

  function reuseSuggestAfterDelete(pending) {
    if (suggestAfterDeletePending !== pending || pending.ticket !== suggestAfterDeleteSeq || pending.priming) return;
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position || model !== pending.model || !position.equals(pending.position) || !editor.hasWidgetFocus() || (active && active.huge)) {
      finishSuggestAfterDelete(pending);
      return;
    }
    const items = reusableSuggestItems(model, position);
    const controller = editor.getContribution("editor.contrib.suggestController");
    if (!controller || !controller.model) { finishSuggestAfterDelete(pending); return; }
    if (items) {
      finishSuggestAfterDelete(pending);
      controller.model.trigger({ auto: true, retrigger: true, completionOptions: { providerItemsToReuse: items } });
      editor.revealPosition(position);
      editor.focus();
    } else {
      primeSuggestAfterDelete(pending).catch(() => finishSuggestAfterDelete(pending));
    }
  }

  function queueSuggestReuse(pending) {
    if (!pending || pending.starting || pending.priming || suggestAfterDeletePending !== pending) return;
    setTimeout(() => reuseSuggestAfterDelete(pending), 0);
  }

  function scheduleSuggestAfterDelete() {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position || (active && active.huge)) return;
    const ticket = ++suggestAfterDeleteSeq;
    const version = model.getVersionId();
    const delay = editor.getOption(monaco.editor.EditorOption.quickSuggestionsDelay);
    setTimeout(() => {
      if (ticket !== suggestAfterDeleteSeq || model.isDisposed() || editor.getModel() !== model || model.getVersionId() !== version) return;
      const current = editor.getPosition();
      if (!current || !position.equals(current) || (active && active.huge) || !editor.hasWidgetFocus()) return;

      // Do not open a list on an empty line or after whitespace. Punctuation
      // is intentionally allowed: HTML's useful prefix after deletion is <.
      const before = model.getLineContent(current.lineNumber).substring(0, current.column - 1);
      if (!before || /\s$/.test(before)) return;
      const word = model.getWordAtPosition(current);
      if (word && word.endColumn === current.column && !isNaN(Number(word.word))) return;

      const quick = editor.getOption(monaco.editor.EditorOption.quickSuggestions);
      const enabled = (value) => value === true || value === "on";
      const other = quick === true ? "on" : quick && quick.other;
      const comments = quick === true ? "on" : quick && quick.comments;
      const strings = quick === true ? "on" : quick && quick.strings;
      if (!enabled(other) && !enabled(comments) && !enabled(strings)) return;

      const suggest = editor.getOption(monaco.editor.EditorOption.suggest);
      if (suggest && suggest.snippetsPreventQuickSuggestions) {
        const snippets = editor.getContribution("snippetController2");
        if (snippets && snippets.isInSnippet()) return;
      }
      if (!enabled(other) || !enabled(comments) || !enabled(strings)) {
        model.tokenization.tokenizeIfCheap(current.lineNumber);
        const tokens = model.tokenization.getLineTokens(current.lineNumber);
        const type = tokens.getStandardTokenType(tokens.findTokenIndexAtOffset(Math.max(current.column - 2, 0)));
        if (!enabled(type === 1 ? comments : type === 2 ? strings : other)) return;
      }
      const pending = { ticket, model, position: current, starting: true };
      suggestAfterDeletePending = pending;
      editor.trigger("daphcode.delete", "editor.action.triggerSuggest", { auto: true });
      pending.starting = false;
    }, delay);
  }

  function createEditor() {
    editor = monaco.editor.create($("#editor"), {
      model: null,
      theme: "daphcode-dark-plus",
      fontFamily: "'Cascadia Mono', Consolas, 'Droid Sans Mono', 'Courier New', monospace",
      fontSize: settings.fontSize,
      fontLigatures: false,
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 10,
      glyphMargin: false,
      folding: true,
      foldingStrategy: "auto",
      showFoldingControls: "always",
      foldingHighlight: true,
      unfoldOnClickAfterEndOfLine: true,
      renderLineHighlight: "all",
      cursorBlinking: "blink",
      cursorSmoothCaretAnimation: "on",
      cursorStyle: "line",
      cursorWidth: 2,
      smoothScrolling: true,
      minimap: { enabled: settings.minimap, renderCharacters: true, maxColumn: 80, showSlider: "always", scale: 1 },
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: true, alwaysConsumeMouseWheel: false },
      bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: false },
      guides: { indentation: true, highlightActiveIndentation: true, bracketPairs: "active", bracketPairsHorizontal: "active", highlightActiveBracketPair: true },
      matchBrackets: "always",
      stickyScroll: { enabled: settings.stickyScroll, maxLineCount: 3 },
      automaticLayout: true,
      wordWrap: settings.wordWrap,
      renderWhitespace: settings.whitespace,
      occurrencesHighlight: "singleFile",
      selectionHighlight: true,
      contextmenu: false,
      fixedOverflowWidgets: true,
      padding: { top: 4, bottom: 4 },
      largeFileOptimizations: true,
      accessibilitySupport: "off",
      mouseWheelZoom: true,
      dragAndDrop: false,
      emptySelectionClipboard: false,
      overviewRulerBorder: true,
      scrollBeyondLastLine: true,
      roundedSelection: true,
      autoClosingBrackets: "languageDefined",
      autoClosingQuotes: "languageDefined",
      autoIndent: "full",
      formatOnPaste: false,
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      tabCompletion: "on",
      wordBasedSuggestions: "currentDocument",
      links: false,
      colorDecorators: true,
      "semanticHighlighting.enabled": true,
      detectIndentation: true,
      insertSpaces: true,
      tabSize: 4,
      hover: { enabled: true, delay: 600 },
      lightbulb: { enabled: "off" },
    });
    {
      const raw = editor.getRawOptions();
      HUGE_ON = {};
      for (const k of Object.keys(HUGE_OFF)) if (raw[k] !== undefined) HUGE_ON[k] = raw[k];
      HUGE_ON.folding = raw.folding !== undefined ? raw.folding : true;
      HUGE_ON.bracketPairColorization = raw.bracketPairColorization || { enabled: true };
      HUGE_ON.guides = raw.guides || { indentation: true, bracketPairs: false };
    }
    self.__editor = editor;
    self.__monaco = monaco;
    const suggestController = editor.getContribution("editor.contrib.suggestController");
    if (suggestController && suggestController.model) {
      suggestController.model.onDidSuggest((event) => {
        const items = event.completionModel.getItemsByProvider();
        let count = 0;
        items.forEach((entries) => { count += entries.length; });
        const model = editor.getModel();
        const position = editor.getPosition();
        if (count && model && position && !(active && active.huge)) {
          let triggerCharacter = "";
          let triggerPrefix = "";
          const options = event.triggerOptions || {};
          if (options.triggerCharacter) {
            const before = model.getLineContent(position.lineNumber).substring(0, position.column - 1);
            const at = before.lastIndexOf(options.triggerCharacter);
            if (at >= 0) {
              triggerCharacter = options.triggerCharacter;
              triggerPrefix = before.substring(0, at + triggerCharacter.length);
            }
          }
          suggestAfterDeleteCache = { model, line: position.lineNumber, lineText: model.getLineContent(position.lineNumber), items, triggerCharacter, triggerPrefix };
        }
        const pending = suggestAfterDeletePending;
        if (pending && pending.model === model && position && pending.position.equals(position)) {
          if (count) suggestAfterDeletePending = null;
          else queueSuggestReuse(pending);
        }
      });
      suggestController.model.onDidCancel(() => queueSuggestReuse(suggestAfterDeletePending));
    }
    editor.onDidChangeModel(() => {
      suggestAfterDeleteCache = null;
      cancelSuggestAfterDeletePending();
      suggestAfterDeleteSeq++;
    });
    editor.onDidChangeModelContent(() => {
      const forwardDelete = suggestAfterDeleteForwardKey !== null;
      suggestAfterDeleteForwardKey = null;
      cancelSuggestAfterDeletePending();
      suggestAfterDeleteSeq++;
      if (forwardDelete && editor.getSelection() && editor.getSelection().isEmpty()) scheduleSuggestAfterDelete();
    });
    editor.onDidChangeCursorSelection((event) => {
      cancelSuggestAfterDeletePending();
      if (event.source === "deleteLeft" || event.source === "deleteRight") suggestAfterDeleteSeq++;
      updateStatus();
      const sel = editor.getSelection();
      if (sel && sel.isEmpty()) touchSelection = false;
      gestures && gestures.placeHandles();
      if (selbarKind && selbarKind !== "caret") placeSelbar();
      if ((event.source === "deleteLeft" || event.source === "deleteRight") && event.selection.isEmpty()) scheduleSuggestAfterDelete();
    });
    editor.onDidScrollChange(() => { gestures && gestures.placeHandles(); placeSelbar(); });
    editor.onDidChangeModelOptions(() => updateStatus());
    editor.onDidChangeModelLanguage(() => { suggestAfterDeleteCache = null; cancelSuggestAfterDeletePending(); suggestAfterDeleteSeq++; updateStatus(); renderTabs(); });
    editor.onDidFocusEditorText(() => { editorFocused = true; setKbdState(); });
    editor.onDidBlurEditorText(() => { editorFocused = false; cancelSuggestAfterDeletePending(); setTimeout(setKbdState, 120); });
    editor.onDidChangeConfiguration(() => { gestures && gestures.placeHandles(); });
    editor.onKeyDown((event) => {
      const key = event.browserEvent.key;
      if (key === "Delete") {
        const marker = {};
        suggestAfterDeleteForwardKey = marker;
        setTimeout(() => { if (suggestAfterDeleteForwardKey === marker) suggestAfterDeleteForwardKey = null; }, 0);
      } else if (key !== "Backspace") {
        suggestAfterDeleteForwardKey = null;
      }
      if (key === "Escape") { cancelSuggestAfterDeletePending(); suggestAfterDeleteSeq++; }
      if (selbarKind) hideSelbar();
      touchSelection = false;
    });
    monaco.editor.onDidChangeMarkers(() => updateMarkers());
    gestures = DaphGestures.attach(monaco, editor, $("#editor"), { a: $("#handle-a"), b: $("#handle-b") }, {
      getFont: () => settings.fontSize,
      setFont: (s) => setFont(s),
      haptic: () => Host.haptic(),
      focus: (wantKeyboard) => (wantKeyboard ? keyboardFocus() : quietFocus()),
      handlesWanted: () => touchSelection,
      onTap: () => { hideSelbar(); touchSelection = false; },
      onCaretTap: () => showSelbar("caret"),
      onSelecting: () => { hideSelbar(); touchSelection = true; },
      onSelectEnd: () => { touchSelection = true; gestures.placeHandles(); showSelbar("sel"); },
      onScrollStart: () => { $("#selbar").style.visibility = "hidden"; },
      onScrollEnd: () => { $("#selbar").style.visibility = ""; placeSelbar(); },
      onPinchStart: () => hideSelbar(),
      onPinchEnd: () => saveSettings(),
      onFold: () => {},
    });
    self.__gestures = gestures;
    installKeyboardPolicy();
    watchKeyHints();
  }

  self.DaphHost = {
    onFolderOpened(meta) { folderWorkspace().opened(meta); },
    onOpening(name, size) {
      toast("Opening " + name + " (" + C.humanSize(size) + ")…");
    },
    onOpened(meta) {
      let got;
      try { got = pullText(meta); } catch (e) { got = null; toast("Not enough memory to open " + meta.name + " on this phone.", "error"); return; }
      if (got == null) { toast("Could not read " + meta.name, "error"); return; }
      const p = meta.req ? pending.get(meta.req) : null;
      if (meta.req) pending.delete(meta.req);
      const o = { name: meta.name, uri: meta.uri, text: got.text, chunks: got.chunks, encoding: meta.encoding, bom: meta.bom, lossy: meta.lossy, size: meta.size };
      if (p && p.fill) { fillTab(p.fill, o); return; }
      if (p && p.revert) { fillTab(p.revert, o); reportDirty(); toast("Reverted " + meta.name); return; }
      openText(o);
      reportDirty();
    },
    onOpenFailed(msg, req) {
      const p = req ? pending.get(req) : null;
      if (req) pending.delete(req);
      if (p && (p.fill || p.revert)) {
        const t = p.fill || p.revert;
        t.loading = false;
        t.uri = null;
        renderTabs();
        toast(msg + " — the tab was kept as an unsaved copy.", "warning");
      } else toast(msg, "error");
      renderWelcome();
    },
    onSaveResult(req, ok, uri, name, err) {
      const p = pending.get(req);
      pending.delete(req);
      if (!p) return;
      const t = p.t;
      if (!ok) {
        if (err !== "cancelled") toast("Failed to save '" + t.name + "': " + err, "error");
        p.resolve(false);
        return;
      }
      if (tabs.includes(t)) {
        if (uri) t.uri = uri;
        if (name && name !== t.name) applyName(t, name, uri);
        t.savedAlt = p.alt;
        t.lossy = false;
        renderTabs();
        if (t === active) { updateTitle(); updateBreadcrumbs(); updateStatus(); }
        reportDirty();
        scheduleSession();
      }
      const downloaded = uri && uri.startsWith("download://");
      toast((downloaded ? "Downloaded " : "Saved ") + (name || t.name));
      p.resolve(true);
    },
    onStorageAccess(granted) {
      const was = storage.granted;
      storage.granted = !!granted;
      if (granted && !was) toast("All files access is on. Open File and Save As now use the built-in file browser.");
      else if (!granted && was) { if (fileDlg) fileDlg.close(); toast("All files access is off. DaphCode will use the Android file picker.", "warning"); }
    },
    onRenameResult(req, ok, uri, name, err) {
      const p = pending.get(req);
      pending.delete(req);
      if (!p) return;
      if (!ok) { toast("Rename failed: " + err, "error"); return; }
      applyName(p.t, name, uri);
      toast("Renamed to " + name);
    },
    onInsets(t, r, b, l, ime) {
      if (Host.web) imeFromHost = true;
      const s = document.documentElement.style;
      s.setProperty("--sat", t + "px");
      s.setProperty("--sar", r + "px");
      // While the IME is up it covers the bottom system bar (which Android re-shows with the
      // keyboard), so no bottom padding is needed; otherwise the status bar grows tall.
      s.setProperty("--sab", (ime ? 0 : b) + "px");
      s.setProperty("--sal", l + "px");
      const wasIme = imeVisible;
      imeVisible = !!ime;
      if (wasIme && !imeVisible) setQuiet(editorTextarea());
      setKbdState();
    },
    onBack() {
      if (!$("#dialog-layer").hidden) { closeDialog(dlgState.buttons.length - 1); return; }
      if (fileDlg && fileDlg.isOpen) { fileDlg.close(); return; }
      if (!$("#quick-input").hidden) { closeQuickInput(undefined); return; }
      if (currentMenuLayer().classList.contains("open")) { closeMenu(); return; }
      if (!$("#problems-panel").hidden) { toggleProblems(); return; }
      if (workspace && workspace.back()) return;
      const dom = editor && editor.getDomNode();
      const widget = dom && document.querySelector(".suggest-widget.visible, .find-widget.visible, .quick-input-widget:not([style*='display: none'])");
      if (widget) {
        editor.trigger("back", "hideSuggestWidget", null);
        editor.trigger("back", "closeFindWidget", null);
        const qw = document.querySelector(".quick-input-widget");
        if (qw && qw.style.display !== "none") {
          // Monaco's palette closes itself when its input loses focus (no workbench command here).
          const qi = qw.querySelector("input.input");
          if (qi) qi.blur();
          if (qw.style.display !== "none") qw.style.display = "none";
          quietFocus();
        }
        return;
      }
      if (selbarKind || (editor && editor.getSelection() && !editor.getSelection().isEmpty())) {
        hideSelbar();
        if (editor.getSelection()) editor.setPosition(editor.getSelection().getPosition());
        return;
      }
      exitFlow();
    },
    flushSession() { flushSession(); },
    run(cmd) { run(cmd); },
  };

  const isCanceled = (r) => r && (r.name === "Canceled" || r.message === "Canceled");
  addEventListener("unhandledrejection", (e) => { if (isCanceled(e.reason)) e.preventDefault(); });
  addEventListener("error", (e) => { if (isCanceled(e.error)) e.preventDefault(); });

  function boot() {
    const vsBase = new URL("vs", location.href).href;
    const root = new URL("./", location.href).href;
    self.MonacoEnvironment = {
      getWorkerUrl() {
        // workerMain probes eval through its Trusted Types hook. Declining script
        // compilation there selects its importScripts path without Firefox emitting
        // a CSP page error for the caught probe; the page policy remains unchanged.
        const source = "self.MonacoEnvironment={baseUrl:'" + root + "',createTrustedTypesPolicy:function(){return{createScriptURL:function(u){return u;},createScript:function(){throw new Error('Dynamic script evaluation is disabled by CSP');}};}};importScripts('" + vsBase + "/base/worker/workerMain.js');";
        return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      },
    };
    require.config({ paths: { vs: vsBase } });
    require(["vs/editor/editor.main"], (m) => {
      monaco = m || self.monaco;
      fetch("vs/VENDOR_MANIFEST.json").then((r) => r.json()).then((j) => { self.__monacoVersion = j.monaco; }).catch(() => {});
      L.build(monaco);
      defineTheme();
      DaphHighlight.install(monaco, requestHighlight);
      createEditor();
      registerActions();
      wireChrome();
      renderWelcome();
      if (!restoreSession()) { renderTabs(); updateTitle(); }
      folderWorkspace().restore();
      document.fonts && document.fonts.ready.then(() => monaco.editor.remeasureFonts());
      addEventListener("pagehide", () => flushSession());
      document.addEventListener("visibilitychange", () => { if (document.hidden) flushSession(); });
      self.__daphReady = true;
      if (self.Android && self.Android.ready) self.Android.ready();
    }, (err) => {
      document.body.innerHTML = "<pre style='color:#f48771;padding:16px'>DaphCode failed to load the editor: " + String(err && err.message || err) + "</pre>";
    });
  }

  if (Host.ready && typeof Host.ready.then === "function") Host.ready.then(boot, boot);
  else boot();
})();
