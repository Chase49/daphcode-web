/*
 * DaphCode built-in file browser (used when "All files access" is on).
 * Modeled on VS Code's simple file dialog: breadcrumb path, a filter / file-name box,
 * folders first, language icons, size + date, hidden-file toggle. It is a picker for
 * Open and Save As only - not a file manager (no delete/move/copy).
 *
 * deps: { Host, el, icon, langIcon(name) -> [cls, color], humanSize, validName, dialog, tapper, toast }
 * Host must provide: storageRoots() -> [{path,label}], listDir(path, hidden) -> {ok, path, parent, entries, error},
 *                    fileInfo(path) -> {exists, dir, parentWritable}
 */
(function (root) {
  "use strict";

  const LAST_DIR_KEY = "daphcode.fd.dir";
  const HIDDEN_KEY = "daphcode.fd.hidden";
  const MAX_ROWS = 3000;

  function create(deps) {
    const { Host, el, icon } = deps;
    const st = { open: false, mode: "open", dir: "", parent: null, entries: [], roots: [], hidden: false, resolve: null, writable: true, canGrant: false, generation: 0 };
    const layer = el("div", null);
    layer.id = "file-dialog";
    layer.hidden = true;
    const box = el("div", "fd-box");
    const title = el("div", "fd-title");
    const crumbs = el("div", "fd-crumbs");
    const input = document.createElement("input");
    input.type = "text";
    input.id = "fd-input";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.spellcheck = false;
    const msg = el("div", "fd-msg");
    const list = el("div", "fd-list");
    const actions = el("div", "fd-actions");
    const grantBtn = el("button", "fd-icon-btn");
    grantBtn.dataset.fd = "grant";
    grantBtn.setAttribute("aria-label", "Add authorized folder");
    grantBtn.title = "Add authorized folder";
    grantBtn.append(icon("codicon-new-folder"));
    const hiddenBtn = el("button", "fd-icon-btn");
    hiddenBtn.dataset.fd = "hidden";
    hiddenBtn.setAttribute("aria-label", "Show hidden files");
    const spacer = el("div", "fd-spacer");
    const cancelBtn = el("button", "dlg-btn", "Cancel");
    cancelBtn.dataset.fd = "cancel";
    const okBtn = el("button", "dlg-btn primary", "Open");
    okBtn.dataset.fd = "ok";
    actions.append(grantBtn, hiddenBtn, spacer, cancelBtn, okBtn);
    box.append(title, crumbs, input, msg, list, actions);
    layer.append(box);
    document.body.append(layer);

    function setMsg(text, kind) {
      msg.textContent = text || "";
      msg.className = "fd-msg" + (kind ? " " + kind : "");
    }

    function parse(json) {
      try { return typeof json === "string" ? JSON.parse(json) : json; } catch (_) { return null; }
    }

    function absolutePath(value) {
      return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
    }

    async function roots() {
      const value = parse(await Promise.resolve().then(() => Host.storageRoots())) || [];
      if (value.length) return value;
      return st.canGrant ? [] : [{ path: "/storage/emulated/0", label: "Internal storage" }];
    }

    function rootOf(path) {
      let best = null;
      for (const r of st.roots) {
        const base = r.path.replace(/\/+$/, "");
        const match = path === r.path || path === base || (base ? path.startsWith(base + "/") : path.startsWith("/"));
        if (match && (!best || r.path.length > best.path.length)) best = r;
      }
      return best;
    }

    function join(dir, name) {
      return dir.replace(/\/+$/, "") + "/" + name;
    }

    function renderCrumbs() {
      crumbs.textContent = "";
      if (!st.dir) return;
      const r = rootOf(st.dir);
      const segs = [];
      if (r) {
        segs.push({ label: r.label, path: r.path, root: true, icon: r.icon });
        const rest = st.dir.slice(r.path.length).split("/").filter(Boolean);
        let acc = r.path;
        for (const s of rest) { acc = join(acc, s); segs.push({ label: s, path: acc }); }
      } else {
        let acc = "";
        segs.push({ label: "/", path: "/" });
        for (const s of st.dir.split("/").filter(Boolean)) { acc += "/" + s; segs.push({ label: s, path: acc }); }
      }
      segs.forEach((s, i) => {
        const c = el("span", "fd-crumb" + (i === segs.length - 1 ? " last" : ""));
        if (s.root) c.append(icon(s.icon || (st.roots.length > 1 ? "codicon-device-mobile" : "codicon-home")));
        c.append(el("span", null, s.label));
        c.dataset.fdPath = s.path;
        if (s.root && st.roots.length > 1) c.dataset.fdRoots = "1";
        crumbs.append(c);
        if (i < segs.length - 1) crumbs.append(icon("codicon-chevron-right fd-sep"));
      });
      crumbs.scrollLeft = crumbs.scrollWidth;
    }

    function fmtDate(ms) {
      if (!ms) return "";
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function appendGrantRow(target) {
      if (!st.canGrant) return;
      const row = el("div", "fd-item dir");
      row.dataset.fd = "grant";
      row.append(icon("codicon-new-folder"), el("span", "fd-name", "Add authorized folder"), el("span", "fd-desc", "Grant browser access to a local folder"));
      target.append(row);
    }

    function renderEmptyRoots() {
      st.dir = "";
      st.parent = null;
      st.entries = [];
      crumbs.textContent = "";
      list.textContent = "";
      if (st.canGrant) appendGrantRow(list);
      else list.append(el("div", "fd-more", "No local folders are available"));
    }

    function renderList() {
      list.textContent = "";
      const q = st.mode === "open" ? input.value.trim().toLowerCase() : "";
      const items = q && !absolutePath(q) ? st.entries.filter((e) => e.n.toLowerCase().includes(q)) : st.entries;
      const frag = document.createDocumentFragment();
      const r = rootOf(st.dir);
      if (st.dir && (!r || st.dir !== r.path)) {
        const up = el("div", "fd-item");
        up.dataset.fdUp = "1";
        const ic = icon("codicon-folder");
        ic.style.color = "#dcb67a";
        up.append(ic, el("span", "fd-name", ".."));
        frag.append(up);
      }
      let n = 0;
      for (const e of items) {
        if (n++ >= MAX_ROWS) {
          frag.append(el("div", "fd-more", (items.length - MAX_ROWS) + " more - type in the box to filter"));
          break;
        }
        const row = el("div", "fd-item" + (e.d ? " dir" : ""));
        row.dataset.fdName = e.n;
        let ic;
        if (e.d) { ic = icon("codicon-folder"); ic.style.color = "#dcb67a"; }
        else { const [cls, color] = deps.langIcon(e.n); ic = icon(cls); if (color) ic.style.color = color; }
        row.append(ic, el("span", "fd-name", e.n));
        if (!e.d) row.append(el("span", "fd-desc", deps.humanSize(e.s || 0) + "  " + fmtDate(e.m)));
        frag.append(row);
      }
      if (!items.length) frag.append(el("div", "fd-more", q ? "No matching files" : "This folder is empty"));
      list.append(frag);
    }

    function renderHiddenBtn() {
      hiddenBtn.textContent = "";
      hiddenBtn.append(icon(st.hidden ? "codicon-eye" : "codicon-eye-closed"));
      hiddenBtn.classList.toggle("on", st.hidden);
    }

    async function go(dir) {
      const ticket = ++st.generation;
      let res;
      try {
        res = parse(await Promise.resolve().then(() => Host.listDir(dir, st.hidden)));
      } catch (error) {
        res = { ok: false, error: error && error.message ? error.message : "Cannot open " + dir };
      }
      if (!st.open || ticket !== st.generation) return false;
      if (!res || !res.ok) {
        setMsg((res && res.error) || "Cannot open " + dir, "err");
        return false;
      }
      st.dir = res.path;
      st.parent = res.parent || null;
      st.writable = res.writable !== false;
      st.entries = (res.entries || []).sort((a, b) => (a.d !== b.d ? (a.d ? -1 : 1) : a.n.localeCompare(b.n, undefined, { numeric: true, sensitivity: "base" })));
      try { localStorage.setItem(LAST_DIR_KEY, st.dir); } catch (_) {}
      if (st.mode === "open") input.value = "";
      setMsg(st.mode === "save" && !st.writable ? "This folder is read-only - choose another folder." : "", st.mode === "save" && !st.writable ? "err" : "");
      renderCrumbs();
      renderList();
      list.scrollTop = 0;
      return true;
    }

    function up() {
      if (st.parent) go(st.parent);
      else if (st.roots.length > 1) pickRoot();
    }

    function pickRoot() {
      st.generation++;
      st.dir = "";
      st.parent = null;
      crumbs.textContent = "";
      list.textContent = "";
      for (const r of st.roots) {
        const row = el("div", "fd-item dir");
        row.dataset.fdRoot = r.path;
        row.append(icon(r.icon || (r.label === "Internal storage" ? "codicon-device-mobile" : "codicon-save")), el("span", "fd-name", r.label), el("span", "fd-desc", r.path));
        list.append(row);
      }
      if (!st.roots.length) renderEmptyRoots();
      else appendGrantRow(list);
    }

    function finish(value) {
      if (!st.open) return;
      st.open = false;
      st.generation++;
      layer.hidden = true;
      input.blur();
      const r = st.resolve;
      st.resolve = null;
      if (r) r(value);
    }

    async function acceptSave() {
      const name = input.value.trim();
      if (!st.dir) { setMsg("Add or choose a folder before saving.", "err"); return; }
      if (!deps.validName(name)) { setMsg("Type a file name (it cannot contain \\ / : * ? \" < > |)", "err"); return; }
      if (!st.writable) { setMsg("This folder is read-only - choose another folder.", "err"); return; }
      const path = join(st.dir, name);
      let info;
      try {
        info = parse(await Promise.resolve().then(() => Host.fileInfo(path))) || {};
      } catch (error) {
        setMsg(error && error.message ? error.message : "Cannot inspect " + name, "err");
        return;
      }
      if (!st.open || st.mode !== "save") return;
      if (info.dir) { setMsg(name + " is a folder", "err"); return; }
      if (info.exists) {
        deps.dialog("'" + name + "' already exists. Do you want to replace it?", "A file with that name already exists in " + st.dir + ". Replacing it will overwrite its contents.", [
          { label: "Replace", primary: true, run: () => finish(path) },
          { label: "Cancel" },
        ]);
        return;
      }
      finish(path);
    }

    async function acceptOpenTyped() {
      const v = input.value.trim();
      if (absolutePath(v)) {
        const typed = v.replace(/\\/g, "/");
        let info;
        try {
          info = parse(await Promise.resolve().then(() => Host.fileInfo(typed))) || {};
        } catch (error) {
          setMsg(error && error.message ? error.message : "Cannot inspect " + typed, "err");
          return;
        }
        if (!st.open || st.mode !== "open") return;
        if (info.dir) { go(typed); return; }
        if (info.exists) { finish(typed); return; }
        setMsg("Not found: " + typed, "err");
        return;
      }
      const matches = st.entries.filter((e) => e.n.toLowerCase().includes(v.toLowerCase()));
      if (matches.length === 1) { const m = matches[0]; if (m.d) go(join(st.dir, m.n)); else finish(join(st.dir, m.n)); }
    }

    async function grant() {
      if (!st.canGrant || grantBtn.disabled) return;
      grantBtn.disabled = true;
      setMsg("");
      try {
        const result = await Promise.resolve().then(() => Host.requestAllFiles());
        if (result === false) return;
        const next = await roots();
        if (!st.open) return;
        st.roots = next;
        if (!next.length) { renderEmptyRoots(); return; }
        let last = null;
        try { last = localStorage.getItem(LAST_DIR_KEY); } catch (_) {}
        for (const dir of [next[next.length - 1].path, last].filter(Boolean)) if (await go(dir)) break;
      } catch (error) {
        if (st.open) setMsg(error && error.message ? error.message : "Could not authorize this folder.", "err");
      } finally {
        grantBtn.disabled = false;
      }
    }

    deps.tapper(layer, "[data-fd], .fd-item, .fd-crumb", (t) => {
      if (t.dataset.fd === "cancel") return finish(null);
      if (t.dataset.fd === "ok") return st.mode === "save" ? acceptSave() : acceptOpenTyped();
      if (t.dataset.fd === "grant") { grant(); return; }
      if (t.dataset.fd === "hidden") {
        st.hidden = !st.hidden;
        try { localStorage.setItem(HIDDEN_KEY, st.hidden ? "1" : ""); } catch (_) {}
        renderHiddenBtn();
        if (st.dir) go(st.dir);
        return;
      }
      if (t.classList.contains("fd-crumb")) {
        if (t.dataset.fdRoots && t.classList.contains("last")) return pickRoot();
        return go(t.dataset.fdPath);
      }
      if (t.dataset.fdUp) return up();
      if (t.dataset.fdRoot) return go(t.dataset.fdRoot);
      const name = t.dataset.fdName;
      if (!name) return;
      const e = st.entries.find((x) => x.n === name);
      if (!e) return;
      if (e.d) return go(join(st.dir, name));
      if (st.mode === "open") return finish(join(st.dir, name));
      input.value = name;
      const dot = name.lastIndexOf(".");
      setMsg("Tap Save to replace " + name + ", or edit the name.", "");
      if (document.activeElement === input) input.setSelectionRange(0, dot > 0 ? dot : name.length);
    }, { scroller: (t) => (t.classList.contains("fd-crumb") ? crumbs : list) });
    layer.addEventListener("pointerdown", (e) => { if (e.target === layer) { e.preventDefault(); finish(null); } });
    input.addEventListener("input", () => { if (st.mode === "open") renderList(); else setMsg(""); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); if (st.mode === "save") acceptSave(); else acceptOpenTyped(); }
      else if (e.key === "Escape") { e.preventDefault(); finish(null); }
    });

    function show(mode, o) {
      if (st.open) finish(null);
      st.mode = mode;
      st.open = true;
      st.generation++;
      st.dir = "";
      st.parent = null;
      st.entries = [];
      st.roots = [];
      try { st.hidden = localStorage.getItem(HIDDEN_KEY) === "1"; } catch (_) { st.hidden = false; }
      renderHiddenBtn();
      title.textContent = mode === "save" ? (o.title || "Save As") : (o.title || "Open File");
      okBtn.textContent = mode === "save" ? "Save" : "Open";
      okBtn.style.display = mode === "save" ? "" : "none";
      input.placeholder = mode === "save" ? "File name" : "Filter, or type a full path and press Enter";
      input.value = mode === "save" ? o.name || "" : "";
      setMsg("");
      list.textContent = "";
      crumbs.textContent = "";
      layer.hidden = false;
      const result = new Promise((resolve) => { st.resolve = resolve; });
      (async () => {
        const state = parse(await Promise.resolve().then(() => Host.storageState ? Host.storageState() : null)) || {};
        st.canGrant = !!state.canGrant;
        grantBtn.style.display = st.canGrant ? "" : "none";
        st.roots = await roots();
        if (!st.open) return;
        if (!st.roots.length) { renderEmptyRoots(); return; }
        let last = null;
        try { last = localStorage.getItem(LAST_DIR_KEY); } catch (_) {}
        const tries = [o.dir, last, o.home, st.roots[0].path].filter(Boolean);
        for (const d of tries) if (await go(d)) break;
      })().catch((error) => {
        if (st.open) setMsg(error && error.message ? error.message : "Could not open the file browser.", "err");
      });
      return result;
    }

    return {
      open: (o) => show("open", o || {}),
      save: (o) => show("save", o || {}),
      close: () => finish(null),
      get isOpen() { return st.open; },
      get dir() { return st.dir; },
    };
  }

  root.DaphFileDialog = { create };
})(self);
