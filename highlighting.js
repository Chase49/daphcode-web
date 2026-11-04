(function (root) {
  "use strict";

  const TYPES = ["namespace", "class", "function", "property", "parameter", "definitionKeyword", "numericPrefix", "numericBody"];
  const TYPE = Object.fromEntries(TYPES.map((name, index) => [name, index]));
  const MAX_CHARS = 1000000;

  function indentation(value) {
    let width = 0;
    for (const ch of value) width = ch === "\t" ? (Math.floor(width / 8) + 1) * 8 : width + 1;
    return width;
  }

  function pythonSemantic(text) {
    if (!root.DaphDiag || !root.DaphDiag.tokenizePython || text.length > MAX_CHARS) return new Uint32Array(0);
    const { tokens, starts } = root.DaphDiag.tokenizePython(text);
    const marks = [];
    const scopes = [{ indent: -1, kind: "module", bindings: new Map() }];
    let pendingScope = null;
    let definition = null;
    let signature = null;
    let importPhase = "";
    let importItem = null;
    let importAlias = false;
    let firstLogicalToken = true;

    const scope = () => scopes[scopes.length - 1];
    const mark = (token, type, length) => marks.push([token.s, length == null ? token.e - token.s : length, TYPE[type]]);
    const lookup = (name) => {
      for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].bindings.has(name)) return scopes[i].bindings.get(name);
      return null;
    };
    const finishImport = () => {
      if (importItem) scope().bindings.set(importItem.alias || importItem.name, "namespace");
      importItem = null;
      importAlias = false;
    };

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.t === "NL") {
        if (token.logical) {
          finishImport();
          importPhase = "";
          definition = null;
          signature = null;
          firstLogicalToken = true;
        }
        continue;
      }

      if (firstLogicalToken && token.first) {
        firstLogicalToken = false;
        const depth = indentation(token.indent || "");
        while (scopes.length > 1 && depth <= scope().indent) scopes.pop();
        if (pendingScope && depth > pendingScope.indent) scopes.push(pendingScope);
        pendingScope = null;
      }

      if (token.t === "OP") {
        if (importPhase === "targets" && (token.v === "," || token.v === ";")) finishImport();
        if (token.v === ";") importPhase = "";
        if (signature && signature.started) {
          if (token.v === "(" || token.v === "[" || token.v === "{") signature.depth++;
          else if (token.v === ")" || token.v === "]" || token.v === "}") {
            signature.depth--;
            if (signature.depth === 0) signature = null;
          } else if (signature.depth === 1 && token.v === ",") signature.expect = true;
          else if (signature.depth === 1 && (token.v === ":" || token.v === "=")) signature.expect = false;
        } else if (signature && token.v === "(") {
          signature.started = true;
          signature.depth = 1;
          signature.expect = true;
        }
        continue;
      }

      if (token.t === "STR") {
        for (const part of token.expressions || []) {
          const binding = text[part.s - 1] === "." ? null : lookup(part.v);
          if (binding) mark(part, binding);
          else if (/^[A-Z][A-Z\d_]*$/.test(part.v)) mark(part, "property");
        }
        continue;
      }
      if (token.t === "NUM") {
        if (/^0(?:[xX][0-9a-fA-F_]+|[bB][01_]+|[oO][0-7_]+)$/.test(token.v)) {
          mark(token, "numericPrefix", 2);
          marks.push([token.s + 2, token.e - token.s - 2, TYPE.numericBody]);
        }
        continue;
      }
      if (token.t !== "NAME") continue;

      const value = token.v;
      if (value === "from" && !importPhase) {
        importPhase = "source";
        continue;
      }
      if (value === "import" && importPhase !== "targets") {
        importPhase = "targets";
        continue;
      }
      if (importPhase === "source") {
        mark(token, "namespace");
        continue;
      }
      if (importPhase === "targets") {
        if (value === "as") {
          importAlias = true;
          continue;
        }
        mark(token, "namespace");
        if (importAlias && importItem) {
          importItem.alias = value;
          importAlias = false;
        } else if (!importItem) importItem = { name: value };
        continue;
      }

      if (value === "class" || value === "def") {
        mark(token, "definitionKeyword");
        definition = { kind: value === "class" ? "class" : "function", indent: indentation(token.indent || "") };
        continue;
      }
      if (definition) {
        mark(token, definition.kind);
        scope().bindings.set(value, definition.kind);
        pendingScope = { indent: definition.indent, kind: definition.kind, bindings: new Map() };
        signature = definition.kind === "function" ? { started: false, depth: 0, expect: false, bindings: pendingScope.bindings } : null;
        definition = null;
        continue;
      }
      if (signature && signature.started && signature.depth === 1 && signature.expect) {
        mark(token, "parameter");
        signature.bindings.set(value, "parameter");
        signature.expect = false;
        continue;
      }

      const previous = tokens[i - 1];
      const following = tokens[i + 1];
      const assignment = (token.first || (previous && previous.v === ";")) && following && following.t === "OP" && (following.v === "=" || following.v === ":=");
      if (assignment && scope().kind === "class") {
        mark(token, "property");
        scope().bindings.set(value, "property");
      } else if (assignment && !/^[A-Z][A-Z\d_]*$/.test(value)) {
        scope().bindings.set(value, null);
      } else {
        const binding = previous && previous.v === "." ? null : lookup(value);
        if (binding) mark(token, binding);
        else if (/^[A-Z][A-Z\d_]*$/.test(value)) mark(token, "property");
      }
    }

    const result = new Uint32Array(marks.length * 5);
    let line = 0, previousLine = 0, previousColumn = 0;
    for (let i = 0; i < marks.length; i++) {
      const [offset, length, type] = marks[i];
      while (line + 1 < starts.length && starts[line + 1] <= offset) line++;
      const column = offset - starts[line];
      const deltaLine = line - previousLine;
      result.set([deltaLine, deltaLine ? column : column - previousColumn, length, type, 0], i * 5);
      previousLine = line;
      previousColumn = column;
    }
    return result;
  }

  function install(monaco, request) {
    monaco.languages.registerDocumentSemanticTokensProvider("python", {
      getLegend() { return { tokenTypes: TYPES, tokenModifiers: [] }; },
      provideDocumentSemanticTokens(model, _previousId, cancellation) {
        if (cancellation.isCancellationRequested || model.getValueLength() > MAX_CHARS) return { data: new Uint32Array(0) };
        return Promise.resolve(request(model.getValue(), cancellation)).then((data) =>
          cancellation.isCancellationRequested || !data ? null : { data: data instanceof Uint32Array ? data : new Uint32Array(data) });
      },
      releaseDocumentSemanticTokens() {},
    });
  }

  const api = { pythonSemantic, install, tokenTypes: TYPES, maxChars: MAX_CHARS };
  root.DaphHighlight = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
