(function (root) {
  "use strict";

  const ICONS = {
    python: ["codicon-symbol-namespace", "#3572a5"],
    java: ["codicon-coffee", "#cc3e44"],
    javascript: ["codicon-symbol-variable", "#cbcb41"],
    typescript: ["codicon-symbol-variable", "#519aba"],
    html: ["codicon-code", "#e37933"],
    css: ["codicon-symbol-color", "#519aba"],
    scss: ["codicon-symbol-color", "#f55385"],
    less: ["codicon-symbol-color", "#519aba"],
    json: ["codicon-json", "#cbcb41"],
    xml: ["codicon-code", "#e37933"],
    c: ["codicon-symbol-structure", "#519aba"],
    cpp: ["codicon-symbol-structure", "#a074c4"],
    csharp: ["codicon-symbol-class", "#8dc149"],
    kotlin: ["codicon-symbol-class", "#a97bff"],
    markdown: ["codicon-markdown", "#519aba"],
    yaml: ["codicon-list-tree", "#a074c4"],
    shell: ["codicon-terminal", "#4d5a5e"],
    powershell: ["codicon-terminal-powershell", "#519aba"],
    sql: ["codicon-database", "#f55385"],
    rust: ["codicon-gear", "#dea584"],
    go: ["codicon-symbol-method", "#519aba"],
    plaintext: ["codicon-file", "#cccccc"],
  };

  const FEATURED = [
    "plaintext", "python", "java", "javascript", "typescript", "html", "css", "json", "xml",
    "c", "cpp", "csharp", "kotlin", "markdown",
  ];

  let registry = null;

  function build(monaco) {
    const map = new Map();
    for (const l of monaco.languages.getLanguages()) {
      map.set(l.id, {
        id: l.id,
        name: (l.aliases && l.aliases[0]) || l.id,
        extensions: l.extensions || [],
      });
    }
    if (!map.has("plaintext")) {
      monaco.languages.register({ id: "plaintext", aliases: ["Plain Text", "text"], extensions: [".txt"] });
      map.set("plaintext", { id: "plaintext", name: "Plain Text", extensions: [".txt"] });
    }
    map.get("plaintext").name = "Plain Text";
    if (map.has("cpp")) map.get("cpp").name = "C++";
    if (map.has("c")) map.get("c").name = "C";
    if (map.has("csharp")) map.get("csharp").name = "C#";
    registry = map;
    return map;
  }

  function resolve(monaco, fileName, firstLine) {
    if (!registry) build(monaco);
    let id = root.DaphCore.languageFor(fileName, firstLine);
    if (!registry.has(id)) {
      const ext = "." + root.DaphCore.extOf(fileName);
      id = "plaintext";
      for (const l of registry.values()) if (l.extensions.includes(ext)) { id = l.id; break; }
    }
    return id;
  }

  function list(monaco) {
    if (!registry) build(monaco);
    const all = [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
    return all;
  }

  function name(monaco, id) {
    if (!registry) build(monaco);
    const l = registry.get(id);
    return l ? l.name : id;
  }

  function icon(id) {
    return ICONS[id] || ["codicon-file-code", "#9d9d9d"];
  }

  function has(monaco, id) {
    if (!registry) build(monaco);
    return registry.has(id);
  }

  root.DaphLanguages = { build, resolve, list, name, icon, has, FEATURED };
})(self);
