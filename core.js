(function (root) {
  "use strict";

  const EXT = {
    py: "python", pyw: "python", pyi: "python",
    java: "java",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
    html: "html", htm: "html", xhtml: "html", vue: "html", svelte: "html",
    css: "css", scss: "scss", sass: "scss", less: "less",
    json: "json", jsonc: "json", json5: "json", webmanifest: "json", har: "json",
    xml: "xml", xsd: "xml", xsl: "xml", xslt: "xml", svg: "xml", plist: "xml", csproj: "xml", fxml: "xml", xaml: "xml", pom: "xml",
    c: "c", h: "c",
    cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp", inl: "cpp",
    cs: "csharp", csx: "csharp",
    kt: "kotlin", kts: "kotlin",
    md: "markdown", markdown: "markdown", mdown: "markdown", mkd: "markdown",
    mdx: "mdx",
    txt: "plaintext", text: "plaintext", log: "plaintext", cfg: "ini",
    yml: "yaml", yaml: "yaml",
    sh: "shell", bash: "shell", zsh: "shell", ksh: "shell",
    ps1: "powershell", psm1: "powershell", psd1: "powershell",
    bat: "bat", cmd: "bat",
    sql: "sql", mysql: "mysql", pgsql: "pgsql",
    php: "php", phtml: "php",
    rb: "ruby", rake: "ruby", gemspec: "ruby",
    rs: "rust", go: "go", dart: "dart", swift: "swift",
    ini: "ini", conf: "ini", properties: "ini", toml: "ini", editorconfig: "ini", env: "ini",
    lua: "lua", pl: "perl", pm: "perl", r: "r",
    scala: "scala", sc: "scala", sbt: "scala",
    m: "objective-c", mm: "objective-c",
    graphql: "graphql", gql: "graphql",
    proto: "proto",
    rst: "restructuredtext",
    pug: "pug", jade: "pug",
    hbs: "handlebars", handlebars: "handlebars",
    cshtml: "razor", razor: "razor",
    vb: "vb", fs: "fsharp", fsx: "fsharp", fsi: "fsharp",
    jl: "julia", ex: "elixir", exs: "elixir",
    clj: "clojure", cljs: "clojure", edn: "clojure",
    coffee: "coffeescript",
    tf: "hcl", hcl: "hcl", tcl: "tcl", sol: "sol",
    sv: "systemverilog", svh: "systemverilog", v: "verilog",
    pas: "pascal", scm: "scheme", ss: "scheme",
    wgsl: "wgsl", twig: "twig", liquid: "liquid",
    gradle: "java", groovy: "java",
    dockerfile: "dockerfile",
    redis: "redis", cypher: "cypher", abap: "abap", apex: "apex",
    bicep: "bicep", dax: "msdax", qs: "qsharp", st: "st",
  };

  const NAMES = {
    "dockerfile": "dockerfile", "makefile": "shell", "gnumakefile": "shell",
    "cmakelists.txt": "plaintext", ".gitignore": "ini", ".gitattributes": "ini",
    ".bashrc": "shell", ".zshrc": "shell", ".profile": "shell", ".env": "ini",
    "jenkinsfile": "java", "gemfile": "ruby", "rakefile": "ruby", "podfile": "ruby",
    "package.json": "json", "tsconfig.json": "json", ".babelrc": "json", ".prettierrc": "json",
  };

  const MIME = {
    json: "application/json", xml: "text/xml", html: "text/html", css: "text/css",
    javascript: "text/javascript", markdown: "text/markdown",
  };

  function baseName(name) {
    const s = String(name || "");
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function extOf(name) {
    const b = baseName(name).toLowerCase();
    const i = b.lastIndexOf(".");
    return i > 0 ? b.slice(i + 1) : (i === 0 ? b.slice(1) : "");
  }

  function languageFor(name, firstLine) {
    const b = baseName(name).toLowerCase();
    if (NAMES[b]) return NAMES[b];
    if (b.startsWith("dockerfile")) return "dockerfile";
    const e = extOf(b);
    if (e && EXT[e]) return EXT[e];
    const l = String(firstLine || "");
    if (/^#!.*\bpython/.test(l)) return "python";
    if (/^#!.*\b(ba|z|k)?sh\b/.test(l)) return "shell";
    if (/^#!.*\bnode\b/.test(l)) return "javascript";
    if (/^<\?xml/.test(l)) return "xml";
    if (/^<!doctype html/i.test(l)) return "html";
    return "plaintext";
  }

  function mimeFor(lang) {
    return MIME[lang] || "text/plain";
  }

  function detectEol(text) {
    const s = String(text);
    const crlf = (s.match(/\r\n/g) || []).length;
    const lf = (s.match(/\n/g) || []).length - crlf;
    return crlf > lf ? "CRLF" : "LF";
  }

  function detectIndent(text) {
    const lines = String(text).split(/\r?\n/, 2000);
    let tabs = 0, spaces = 0;
    const widths = {};
    let prev = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = /^[\t ]*/.exec(line)[0];
      if (m.startsWith("\t")) { tabs++; prev = 0; continue; }
      const w = m.length;
      if (w > 0) spaces++;
      const d = Math.abs(w - prev);
      if (d >= 2 && d <= 8) widths[d] = (widths[d] || 0) + 1;
      prev = w;
    }
    if (tabs > spaces) return { insertSpaces: false, tabSize: 4 };
    let best = 4, n = 0;
    for (const k of Object.keys(widths)) if (widths[k] > n) { n = widths[k]; best = Number(k); }
    return { insertSpaces: true, tabSize: best };
  }

  function nextUntitled(existing) {
    const used = new Set();
    for (const n of existing) {
      const m = /^Untitled-(\d+)/.exec(n);
      if (m) used.add(Number(m[1]));
    }
    let i = 1;
    while (used.has(i)) i++;
    return "Untitled-" + i;
  }

  function validFileName(name) {
    const s = String(name || "").trim();
    if (!s || s === "." || s === "..") return false;
    if (s.length > 200) return false;
    return !/[\\/:*?"<>|\u0000-\u001f]/.test(s);
  }

  function zoomPercent(fontSize, base) {
    return Math.round((fontSize / (base || 14)) * 100);
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function pinchFont(startSize, startDist, dist, lo, hi) {
    if (!(startDist > 0)) return startSize;
    return clamp(Math.round(startSize * (dist / startDist) * 2) / 2, lo || 8, hi || 32);
  }

  function orderRange(a, b) {
    if (a.lineNumber < b.lineNumber || (a.lineNumber === b.lineNumber && a.column <= b.column)) return [a, b];
    return [b, a];
  }

  function sessionTrim(tabs, budget) {
    let used = 0;
    const out = [];
    for (const t of tabs) {
      const c = Object.assign({}, t);
      if (c.text != null) {
        const len = c.text.length * 2;
        if (used + len > budget) { c.text = null; c.textDropped = true; } else used += len;
      }
      out.push(c);
    }
    return out;
  }

  function humanSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  function isLarge(size, lines) {
    return size > 1048576 || lines > 20000;
  }

  const api = {
    EXT, baseName, extOf, languageFor, mimeFor, detectEol, detectIndent, nextUntitled,
    validFileName, zoomPercent, clamp, pinchFont, orderRange, sessionTrim, humanSize, isLarge,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DaphCore = api;
})(typeof self !== "undefined" ? self : this);
