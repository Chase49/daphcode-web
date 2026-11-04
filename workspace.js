(function (root) {
  "use strict";

  const STORAGE_KEY = "daphcode.folder.v1";

  function create(options) {
    const Host = options.Host;
    const document = options.document;
    const el = options.el;
    const icon = options.icon;
    const aside = document.querySelector("#workspace");
    const tree = document.querySelector("#workspace-tree");
    const title = document.querySelector("#workspace-title");
    const explorerButton = document.querySelector("#explorer-button");
    const nodes = new Map();
    let rootNode = null;
    let visible = false;
    let generation = 0;

    function savedFolder() {
      try {
        const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        return value && typeof value.uri === "string" && typeof value.name === "string" ? value : null;
      } catch (_) {
        return null;
      }
    }

    function persist() {
      try {
        if (rootNode && !rootNode.transient) localStorage.setItem(STORAGE_KEY, JSON.stringify({ uri: rootNode.uri, name: rootNode.name }));
        else localStorage.removeItem(STORAGE_KEY);
      } catch (_) {}
    }

    function layout() {
      aside.hidden = !rootNode || !visible;
      explorerButton.hidden = !rootNode;
      explorerButton.setAttribute("aria-pressed", rootNode && visible ? "true" : "false");
      document.body.classList.toggle("workspace-open", !!(rootNode && visible));
      if (options.onLayout) options.onLayout();
    }

    function nodeFor(entry) {
      const existing = nodes.get(entry.uri);
      if (existing) {
        existing.name = entry.name;
        existing.dir = !!entry.dir;
        return existing;
      }
      const node = {
        uri: entry.uri,
        name: entry.name,
        dir: !!entry.dir,
        expanded: false,
        loaded: false,
        loading: false,
        children: [],
        error: ""
      };
      nodes.set(node.uri, node);
      return node;
    }

    function messageRow(text, level, kind) {
      const row = el("div", "ws-message" + (kind ? " " + kind : ""), text);
      row.style.setProperty("--ws-level", level);
      return row;
    }

    function render() {
      const focused = tree.contains(document.activeElement) ? document.activeElement.closest(".ws-row") : null;
      const focusedUri = focused && focused.dataset.uri;
      tree.textContent = "";
      title.textContent = "EXPLORER";
      title.title = rootNode ? rootNode.name : "";
      if (!rootNode) return;

      function appendNode(node, level) {
        const row = el("div", "ws-row" + (node.dir ? " ws-dir" : " ws-file"));
        row.dataset.uri = node.uri;
        row.dataset.dir = node.dir ? "true" : "false";
        row.style.setProperty("--ws-level", level);
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", level);
        row.setAttribute("aria-label", node.name);
        row.tabIndex = node === rootNode ? 0 : -1;
        if (node.dir) row.setAttribute("aria-expanded", node.expanded ? "true" : "false");
        const twisty = el("span", "ws-twisty");
        if (node.dir) twisty.append(icon(node.expanded ? "codicon-chevron-down" : "codicon-chevron-right"));
        const glyph = node.dir ? icon(node.expanded ? "codicon-folder-opened" : "codicon-folder") : options.fileIcon(node.name);
        row.append(twisty, glyph, el("span", "ws-name", node.name));
        tree.append(row);
        if (!node.dir || !node.expanded) return;
        if (node.loading) tree.append(messageRow("Loading…", level + 1));
        else if (node.error) tree.append(messageRow(node.error, level + 1, "ws-error"));
        else if (node.loaded && !node.children.length) tree.append(messageRow("Empty folder", level + 1));
        else for (const child of node.children) appendNode(child, level + 1);
      }

      appendNode(rootNode, 1);
      if (focusedUri) {
        const replacement = Array.from(tree.querySelectorAll(".ws-row")).find((row) => row.dataset.uri === focusedUri);
        if (replacement) replacement.focus({ preventScroll: true });
      }
    }

    async function load(node) {
      if (!node || !node.dir || node.loading || node.loaded) return;
      const stamp = generation;
      node.loading = true;
      node.error = "";
      render();
      try {
        const entries = await Promise.resolve().then(() => Host.listFolder(node.uri));
        if (stamp !== generation || !nodes.has(node.uri)) return;
        const valid = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.uri === "string" && typeof entry.name === "string") : [];
        node.children = valid.map(nodeFor).sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1);
        node.loaded = true;
      } catch (error) {
        if (stamp !== generation) return;
        node.children = [];
        node.loaded = true;
        node.error = error && error.message ? error.message : "Could not read this folder.";
      } finally {
        if (stamp === generation) {
          node.loading = false;
          render();
        }
      }
    }

    function activate(node) {
      if (!node) return;
      if (!node.dir) {
        options.onOpenFile(node.uri, node.name);
        if (matchMedia("(max-width: 767px)").matches) {
          visible = false;
          layout();
        }
        return;
      }
      node.expanded = !node.expanded;
      render();
      if (node.expanded) load(node);
    }

    function opened(meta, quiet) {
      if (!meta || typeof meta.uri !== "string" || typeof meta.name !== "string") return;
      generation++;
      nodes.clear();
      rootNode = nodeFor({ uri: meta.uri, name: meta.name, dir: true });
      rootNode.transient = !!meta.transient;
      rootNode.expanded = true;
      visible = true;
      persist();
      render();
      layout();
      load(rootNode);
      if (!quiet && options.toast) options.toast(meta.transient ? "Opened folder " + meta.name + " for this session. Save downloads edited copies." : "Opened folder " + meta.name);
    }

    function open() {
      try {
        const result = Host.openFolder();
        if (result && typeof result.catch === "function") result.catch((error) => {
          if (error && error.name === "AbortError") return;
          if (options.toast) options.toast(error && error.message ? error.message : "Could not open folder.", "error");
        });
        return result;
      } catch (error) {
        if (options.toast) options.toast(error && error.message ? error.message : "Could not open folder.", "error");
        return null;
      }
    }

    function close() {
      generation++;
      nodes.clear();
      rootNode = null;
      visible = false;
      persist();
      render();
      layout();
    }

    function refresh() {
      if (!rootNode) return;
      const current = rootNode;
      opened({ uri: current.uri, name: current.name, transient: current.transient }, true);
    }

    function toggle() {
      if (!rootNode) {
        open();
        return;
      }
      visible = !visible;
      layout();
    }

    function restore() {
      const saved = savedFolder();
      if (saved) opened(saved, true);
    }

    function back() {
      if (!rootNode || !visible) return false;
      visible = false;
      layout();
      return true;
    }

    options.tapper(tree, ".ws-row", (row) => activate(nodes.get(row.dataset.uri)), { scroller: () => tree });
    tree.addEventListener("keydown", (event) => {
      const row = event.target.closest(".ws-row");
      if (!row) return;
      const node = nodes.get(row.dataset.uri);
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(node);
      } else if (event.key === "ArrowRight" && node && node.dir) {
        event.preventDefault();
        if (!node.expanded) activate(node);
      } else if (event.key === "ArrowLeft" && node && node.dir && node.expanded) {
        event.preventDefault();
        activate(node);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const rows = Array.from(tree.querySelectorAll(".ws-row"));
        const index = rows.indexOf(row);
        const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
        if (rows[next]) rows[next].focus();
      }
    });
    render();
    layout();

    return { open, opened, close, refresh, toggle, restore, back, hasFolder: () => !!rootNode, isVisible: () => visible };
  }

  root.DaphWorkspace = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = root.DaphWorkspace;
})(typeof self !== "undefined" ? self : globalThis);
