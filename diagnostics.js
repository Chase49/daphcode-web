/*
 * DaphCode diagnostics: error / warning markers for languages that Monaco has no language
 * service for. Pure functions (no DOM) so the same file runs in a Web Worker, on the main
 * thread as a fallback, and under Node for unit tests.
 *
 *   DaphDiag.check(languageId, text) -> [{severity, message, startLineNumber, startColumn, endLineNumber, endColumn, source, code}]
 *   DaphDiag.supports(languageId) -> boolean
 *
 * Python: tokenizer + logical-line analysis with Pylance-style messages:
 *   errors   - unclosed / unmatched / mismatched brackets, unterminated strings, missing ":",
 *              indentation errors, "Statements must be separated by newlines or semicolons",
 *              "Expected expression", invalid characters
 *   warnings - "X" is not defined (reportUndefinedVariable), Expression value is unused
 * C-family (Java, C, C++, C#, Kotlin, Go, Rust, Swift, Dart, Scala, Objective-C):
 *   errors   - unclosed / unmatched / mismatched brackets, unterminated strings, chars, comments
 */
(function (root) {
  "use strict";

  const ERROR = 8, WARNING = 4;
  const MAX_MARKERS = 300;

  function lineIndex(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
  }
  function posOf(starts, off) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: off - starts[lo] + 1 };
  }
  function makeSink(text, source) {
    const starts = lineIndex(text);
    const out = [];
    const add = (severity, message, from, to, code) => {
      if (out.length >= MAX_MARKERS) return;
      if (to <= from) to = from + 1;
      const a = posOf(starts, from), b = posOf(starts, Math.min(to, Math.max(text.length, from + 1)));
      out.push({ severity, message, startLineNumber: a.line, startColumn: a.col, endLineNumber: b.line, endColumn: b.col, source, code: code || undefined });
    };
    return { out, add, starts };
  }
  const lineEnd = (text, i) => { const k = text.indexOf("\n", i); return k < 0 ? text.length : k; };

  // =====================================================================================
  // Python
  // =====================================================================================
  const PY_KW = new Set(("False None True and as assert async await break class continue def del elif else except finally for " +
    "from global if import in is lambda nonlocal not or pass raise return try while with yield").split(" "));
  const PY_SOFT = new Set(["match", "case", "type", "_"]);
  const PY_VALUE_KW = new Set(["True", "False", "None"]);
  const PY_STMT_ONLY = new Set(["def", "class", "return", "import", "pass", "break", "continue", "raise", "try", "while", "with",
    "elif", "except", "finally", "global", "nonlocal", "del", "assert"]);
  const PY_COMPOUND = new Set(["if", "elif", "else", "while", "for", "try", "except", "finally", "with", "def", "class"]);
  const PY_BUILTINS = new Set((
    "abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex copyright credits " +
    "delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr hash help hex id input " +
    "int isinstance issubclass iter len license list locals map max memoryview min next object oct open ord pow print property quit " +
    "range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ __build_class__ " +
    "__debug__ __doc__ __name__ __file__ __package__ __spec__ __loader__ __builtins__ __annotations__ __path__ __dict__ __module__ " +
    "__qualname__ __class__ __all__ __cached__ NotImplemented Ellipsis reveal_type reveal_locals " +
    "BaseException BaseExceptionGroup Exception ExceptionGroup ArithmeticError AssertionError AttributeError BlockingIOError " +
    "BrokenPipeError BufferError BytesWarning ChildProcessError ConnectionAbortedError ConnectionError ConnectionRefusedError " +
    "ConnectionResetError DeprecationWarning EOFError EncodingWarning EnvironmentError FileExistsError FileNotFoundError " +
    "FloatingPointError FutureWarning GeneratorExit IOError ImportError ImportWarning IndentationError IndexError InterruptedError " +
    "IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError NotADirectoryError " +
    "NotImplementedError OSError OverflowError PendingDeprecationWarning PermissionError ProcessLookupError PythonFinalizationError " +
    "RecursionError ReferenceError ResourceWarning RuntimeError RuntimeWarning StopAsyncIteration StopIteration SyntaxError " +
    "SyntaxWarning SystemError SystemExit TabError TimeoutError TypeError UnboundLocalError UnicodeDecodeError UnicodeEncodeError " +
    "UnicodeError UnicodeTranslateError UnicodeWarning UserWarning ValueError Warning WindowsError ZeroDivisionError").split(" "));
  const PY_OPS = ["**=", "//=", ">>=", "<<=", "...", "->", ":=", "**", "//", "<<", ">>", "<=", ">=", "==", "!=", "+=", "-=", "*=", "/=",
    "%=", "&=", "|=", "^=", "@=", "+", "-", "*", "/", "%", "@", "&", "|", "^", "~", "<", ">", "(", ")", "[", "]", "{", "}", ",", ":",
    ".", ";", "=", "!"];
  const PY_BINOPS = new Set(["+", "-", "*", "/", "//", "%", "**", "@", "&", "|", "^", "<<", ">>", "<", ">", "<=", ">=", "==", "!=", "=",
    "+=", "-=", "*=", "/=", "//=", "%=", "**=", "@=", "&=", "|=", "^=", ">>=", "<<=", ":=", "->", "~", "and", "or", "not", "in", "is"]);
  const PY_ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "//=", "%=", "**=", "@=", "&=", "|=", "^=", ">>=", "<<="]);
  const OPEN = { "(": ")", "[": "]", "{": "}" };
  const CLOSE = { ")": "(", "]": "[", "}": "{" };
  const NAME_RE = /[A-Za-z_\u00AA-\uFFFF][0-9A-Za-z_\u00AA-\uFFFF]*/y;
  const NUM_RE = /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[jJlL]?/y;

  const indentWidth = (s, tab) => { let w = 0; for (const ch of s) w = ch === "\t" ? (Math.floor(w / tab) + 1) * tab : w + 1; return w; };

  function pyTokenize(text, sink, collectFStrings) {
    const n = text.length;
    const toks = [];
    const stack = [];
    let i = 0;
    let lineIndent = "";
    let lineFirst = true;
    let cont = false;

    const readIndent = (k) => { let j = k; while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\f")) j++; return j; };
    { const j = readIndent(0); lineIndent = text.slice(0, j); i = j; }

    // Returns index after the string starting at `s` (prefix already included in s..q).
    function readString(s, q, expressions) {
      const pre = text.slice(s, q).toLowerCase();
      const isF = pre.includes("f") || pre.includes("t");
      const quote = text[q];
      const triple = text.startsWith(quote + quote + quote, q);
      let k = q + (triple ? 3 : 1);
      while (k < n) {
        const c = text[k];
        if (c === "\\") { k += 2; continue; }
        if (triple ? text.startsWith(quote + quote + quote, k) : c === quote) return k + (triple ? 3 : 1);
        if (!triple && c === "\n") break;
        if (isF && c === "{") {
          if (text[k + 1] === "{") { k += 2; continue; }
          let depth = 1;
          const start = ++k;
          while (k < n && depth > 0) {
            const d = text[k];
            if (d === "'" || d === '"') { k = readString(k, k); continue; }
            if (d === "{" || d === "[" || d === "(") depth++;
            else if (d === "}" || d === "]" || d === ")") depth--;
            else if (d === "\n" && !triple && depth <= 1) break;
            k++;
          }
          if (expressions && text[k - 1] === "}" && k - 1 > start) {
            let bracketDepth = 0, format = false;
            for (const part of pyTokenize(text.slice(start, k - 1), { add() {} })) {
              if (part.t === "OP") {
                if (!bracketDepth && (part.v === ":" || part.v === "!" || part.v === "=")) format = true;
                if (OPEN[part.v]) bracketDepth++;
                else if (CLOSE[part.v]) bracketDepth = Math.max(0, bracketDepth - 1);
              } else if (part.t === "NAME" && (!format || bracketDepth > 0)) {
                expressions.push({ v: part.v, s: start + part.s, e: start + part.e });
              }
            }
          }
          if (k < n && text[k] === "\n" && !triple) break;
          continue;
        }
        k++;
      }
      const end = triple ? n : Math.min(k, lineEnd(text, q));
      sink.add(ERROR, "String literal is unterminated", s, triple ? Math.min(lineEnd(text, s), n) : end);
      return triple ? n : end;
    }

    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\f" || c === "\r") { i++; continue; }
      if (c === "#") { i = lineEnd(text, i); continue; }
      if (c === "\n") {
        toks.push({ t: "NL", v: "\n", s: i, e: i + 1, logical: stack.length === 0 && !cont });
        cont = false;
        i++;
        const j = readIndent(i);
        lineIndent = text.slice(i, j);
        lineFirst = true;
        i = j;
        continue;
      }
      if (c === "\\") {
        let j = i + 1;
        while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j++;
        if (j >= n || text[j] === "\n") { i = j; if (i < n) { i++; i = readIndent(i); lineFirst = false; } continue; } // explicit line join
        sink.add(ERROR, "Expected expression", i, i + 1);
        i++;
        continue;
      }
      const tok = { s: i, indent: lineIndent, first: lineFirst };
      lineFirst = false;
      // strings (with prefixes)
      let q = -1;
      if (c === "'" || c === '"') q = i;
      else if (/[rRbBuUfFtT]/.test(c)) {
        if (text[i + 1] === "'" || text[i + 1] === '"') q = i + 1;
        else if (/[rRbBfFtT]/.test(text[i + 1] || "") && (text[i + 2] === "'" || text[i + 2] === '"')) q = i + 2;
      }
      if (q >= 0) {
        const expressions = collectFStrings ? [] : null;
        const e = readString(i, q, expressions);
        tok.t = "STR"; tok.v = text.slice(i, e); tok.e = e;
        if (expressions && expressions.length) tok.expressions = expressions;
        toks.push(tok);
        i = e;
        continue;
      }
      NAME_RE.lastIndex = i;
      let m = NAME_RE.exec(text);
      if (m && m.index === i && !/[0-9]/.test(c)) {
        tok.t = "NAME"; tok.v = m[0]; tok.e = i + m[0].length;
        // Recovery: a statement keyword at the start of a line while brackets are open means
        // the bracket was never closed (report it there instead of swallowing the whole file).
        if (tok.first && stack.length && PY_STMT_ONLY.has(tok.v) && indentWidth(lineIndent, 8) <= stack[0].indentW) {
          for (const b of stack) sink.add(ERROR, '"' + b.ch + '" was not closed', b.s, b.s + 1);
          stack.length = 0;
          for (let k = toks.length - 1; k >= 0; k--) if (toks[k].t === "NL") { toks[k].logical = true; break; }
        }
        toks.push(tok);
        i = tok.e;
        continue;
      }
      NUM_RE.lastIndex = i;
      m = NUM_RE.exec(text);
      if (m && m.index === i && m[0].length && (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || "")))) {
        tok.t = "NUM"; tok.v = m[0]; tok.e = i + m[0].length;
        toks.push(tok);
        i = tok.e;
        continue;
      }
      let op = null;
      for (const o of PY_OPS) if (text.startsWith(o, i)) { op = o; break; }
      if (!op) {
        sink.add(ERROR, 'Invalid character "' + c + '" in token', i, i + 1);
        i++;
        continue;
      }
      tok.t = "OP"; tok.v = op; tok.e = i + op.length;
      if (OPEN[op]) stack.push({ ch: op, s: i, indentW: indentWidth(lineIndent, 8) });
      else if (CLOSE[op]) {
        if (!stack.length) sink.add(ERROR, '"' + op + '" was not expected', i, i + 1);
        else {
          const top = stack.pop();
          if (top.ch !== CLOSE[op]) sink.add(ERROR, '"' + op + '" does not match "' + top.ch + '"', i, i + 1);
        }
      }
      toks.push(tok);
      i = tok.e;
    }
    for (const b of stack) sink.add(ERROR, '"' + b.ch + '" was not closed', b.s, b.s + 1);
    return toks;
  }

  // Split a logical line at top-level ";" into simple statements, annotating bracket depth.
  function withDepth(line) {
    let d = 0;
    for (const t of line) {
      if (t.t === "OP" && CLOSE[t.v]) d = Math.max(0, d - 1);
      t.d = d;
      if (t.t === "OP" && OPEN[t.v]) d++;
    }
    return line;
  }
  function splitStatements(line) {
    const out = [];
    let cur = [];
    for (const t of line) {
      if (t.t === "OP" && t.v === ";" && t.d === 0) { if (cur.length) out.push(cur); cur = []; continue; }
      cur.push(t);
    }
    if (cur.length) out.push(cur);
    return out;
  }
  const isKw = (t) => t && t.t === "NAME" && PY_KW.has(t.v);
  const operandEnd = (t) => t && ((t.t === "NAME" && (!PY_KW.has(t.v) || PY_VALUE_KW.has(t.v))) || t.t === "NUM" || t.t === "STR" || (t.t === "OP" && (t.v === ")" || t.v === "]" || t.v === "}")));
  const operandStart = (t, prev) => t && ((t.t === "NAME" && (!PY_KW.has(t.v) || PY_VALUE_KW.has(t.v) || t.v === "lambda" || t.v === "await")) || t.t === "NUM" || (t.t === "STR" && !(prev && prev.t === "STR")));

  function pyCheck(text) {
    const sink = makeSink(text, "Python");
    const toks = pyTokenize(text, sink);
    // logical lines
    const lines = [];
    let cur = [];
    for (const t of toks) {
      if (t.t === "NL") { if (t.logical && cur.length) { lines.push(withDepth(cur)); cur = []; } continue; }
      cur.push(t);
    }
    if (cur.length) lines.push(withDepth(cur));

    // ---- indentation
    const stack = [""];
    let expect = false;
    let prevLast = null;
    for (const L of lines) {
      const first = L[0];
      const ind = first.indent || "";
      const top = stack[stack.length - 1];
      const w8 = indentWidth(ind, 8), w1 = indentWidth(ind, 1);
      const t8 = indentWidth(top, 8), t1 = indentWidth(top, 1);
      if (Math.sign(w8 - t8) !== Math.sign(w1 - t1)) sink.add(ERROR, "Inconsistent use of tabs", first.s - ind.length, first.s);
      if (w8 > t8) {
        if (!expect) sink.add(ERROR, "Unexpected indentation", first.s, first.e);
        stack.push(ind);
      } else {
        if (expect) sink.add(ERROR, "Expected indented block", first.s, first.e);
        if (w8 < t8) {
          while (stack.length > 1 && indentWidth(stack[stack.length - 1], 8) > w8) stack.pop();
          if (indentWidth(stack[stack.length - 1], 8) !== w8) { sink.add(ERROR, "Unindent amount does not match previous indent", first.s, first.e); stack.push(ind); }
        }
      }
      const last = L[L.length - 1];
      // A compound header opens a block even when its ":" is missing (that error is reported
      // separately), so its body is not also flagged as "Unexpected indentation".
      const hk = first.v === "async" && L[1] ? L[1] : first;
      const header = first.t === "NAME" && PY_COMPOUND.has(hk.v) && !L.some((t) => t.t === "OP" && t.v === ";" && t.d === 0);
      expect = (last.t === "OP" && last.v === ":" && last.d === 0) || (header && !L.some((t) => t.t === "OP" && t.v === ":" && t.d === 0));
      prevLast = last;
    }
    if (expect && prevLast) sink.add(ERROR, "Expected indented block", prevLast.s, prevLast.e);

    // ---- statement checks
    const stmts = [];
    for (const L of lines) for (const S of splitStatements(L)) stmts.push(S);
    let starImport = false;
    for (const S of stmts) {
      const f = S[0];
      let head = f.v === "async" && S[1] ? S[1] : f;
      if (f.v === "from" && S.some((t) => t.v === "import") && S[S.length - 1].v === "*") starImport = true;
      const soft = (f.v === "match" || f.v === "case") && S.length > 1 && S[S.length - 1].v === ":" && !(S[1].t === "OP" && S[1].v !== "(" && S[1].v !== "[" && S[1].v !== "-" && S[1].v !== "{");
      // missing ":" after a compound statement header
      if (f.t === "NAME" && (PY_COMPOUND.has(head.v) || soft)) {
        const hasColon = S.some((t) => t.t === "OP" && t.v === ":" && t.d === 0);
        const isTernaryElse = false;
        if (!hasColon && !isTernaryElse) { const l = S[S.length - 1]; sink.add(ERROR, 'Expected ":"', l.s, l.e); }
      }
      // two operands with nothing between them
      let separated = false;
      for (let k = 1; k < S.length; k++) {
        const a = S[k - 1], b = S[k];
        if (b.d !== 0 || a.d !== 0 && !(a.t === "OP" && CLOSE[a.v])) continue;
        if (k === 1 && (PY_SOFT.has(a.v) || a.v === "print" && false)) continue;
        if (operandEnd(a) && operandStart(b, a)) {
          if (a.t === "STR" && b.t === "STR") continue;
          sink.add(ERROR, "Statements must be separated by newlines or semicolons", b.s, b.e);
          separated = true;
          break;
        }
      }
      // dangling operator
      const l = S[S.length - 1];
      if (l.d === 0 && ((l.t === "OP" && PY_BINOPS.has(l.v)) || (l.t === "NAME" && PY_BINOPS.has(l.v))) && !(l.v === "*" && f.v === "from")) {
        sink.add(ERROR, "Expected expression", l.s, l.e);
      } else if (l.t === "OP" && l.v === "." && l.d === 0) {
        sink.add(ERROR, 'Expected member name after "."', l.s, l.e);
      }
      // unused expression (warning)
      if (!separated && !isKw(f) && f.v !== "@" && !(f.t === "OP" && f.v === "...") && !soft && !(PY_SOFT.has(f.v) && S[1] && S[1].t === "NAME")) {
        const hasAssign = S.some((t) => t.d === 0 && t.t === "OP" && (PY_ASSIGN.has(t.v) || t.v === ":=" || t.v === ":"));
        const hasCall = S.some((t) => t.t === "OP" && t.v === "(" || t.t === "NAME" && (t.v === "await" || t.v === "yield" || t.v === "lambda"));
        const allStr = S.every((t) => t.t === "STR");
        const dangling = l.d === 0 && (l.t === "OP" && PY_BINOPS.has(l.v));
        if (!hasAssign && !hasCall && !allStr && !dangling && !(S.length === 1 && S[0].t === "OP")) {
          sink.add(WARNING, "Expression value is unused", S[0].s, S[S.length - 1].e, "reportUnusedExpression");
        }
      }
    }

    // ---- undefined names (scope-insensitive: a name bound anywhere counts as defined)
    if (!starImport) {
      const bound = new Set();
      const nonLoad = new Set(); // token objects
      const bind = (t) => { if (t && t.t === "NAME" && !PY_KW.has(t.v)) { bound.add(t.v); nonLoad.add(t); } };
      for (const S of stmts) {
        const f = S[0];
        // attributes and keyword arguments are never loads
        for (let k = 0; k < S.length; k++) {
          const t = S[k];
          if (t.t !== "NAME") continue;
          const p = S[k - 1], nx = S[k + 1];
          if (p && p.t === "OP" && p.v === ".") nonLoad.add(t);
          if (t.d > 0 && p && p.t === "OP" && (p.v === "(" || p.v === ",") && nx && nx.t === "OP" && nx.v === "=") nonLoad.add(t);
          if (p && p.t === "NAME" && p.v === "as") bind(t);
          if (nx && nx.t === "OP" && nx.v === ":=") bind(t);
        }
        if (f.v === "import") {
          let clauseStart = true;
          for (let k = 1; k < S.length; k++) {
            const t = S[k];
            if (t.t === "NAME" && t.v !== "as") { nonLoad.add(t); if (clauseStart) { const asTok = S.slice(k).find((x, j) => x.v === "as" && S.slice(k, k + j).every((y) => y.v !== ",")); if (!asTok) bind(t); clauseStart = false; } }
            if (t.v === ",") clauseStart = true;
          }
          continue;
        }
        if (f.v === "from") {
          const ii = S.findIndex((t) => t.v === "import");
          for (let k = 1; k < S.length; k++) {
            const t = S[k];
            if (t.t !== "NAME" || t.v === "as" || t.v === "import") continue;
            nonLoad.add(t);
            if (ii >= 0 && k > ii) { const nx = S[k + 1]; const p = S[k - 1]; if (!(nx && nx.v === "as") && !(p && p.v === "as")) bind(t); }
          }
          continue;
        }
        if (f.v === "global" || f.v === "nonlocal") { for (const t of S.slice(1)) bind(t); continue; }
        let k0 = f.v === "async" ? 1 : 0;
        if (S[k0] && (S[k0].v === "def" || S[k0].v === "class")) {
          bind(S[k0 + 1]);
          let k = k0 + 2;
          if (S[k] && S[k].v === "[") { // type parameters
            const d0 = S[k].d;
            for (k++; k < S.length && !(S[k].v === "]" && S[k].d === d0); k++) {
              const p = S[k - 1];
              if (S[k].t === "NAME" && S[k].d === d0 + 1 && (p.v === "[" || p.v === "," || p.v === "*" || p.v === "**")) bind(S[k]);
            }
            k++;
          }
          if (S[k0].v === "def" && S[k] && S[k].v === "(") {
            const d0 = S[k].d;
            for (k++; k < S.length && !(S[k].v === ")" && S[k].d === d0); k++) {
              const p = S[k - 1];
              if (S[k].t === "NAME" && S[k].d === d0 + 1 && (p.v === "(" || p.v === "," || p.v === "*" || p.v === "**" || p.v === "/")) bind(S[k]);
            }
          }
        }
        // for-targets (statements and comprehensions) and lambda parameters
        for (let k = 0; k < S.length; k++) {
          const t = S[k];
          if (t.t === "NAME" && t.v === "for") {
            for (let j = k + 1; j < S.length && !(S[j].v === "in" && S[j].d === t.d); j++) {
              if (S[j].t === "NAME" && !(S[j - 1].v === ".")) bind(S[j]);
            }
          } else if (t.t === "NAME" && t.v === "lambda") {
            for (let j = k + 1; j < S.length && !(S[j].v === ":" && S[j].d === t.d); j++) {
              const p = S[j - 1];
              if (S[j].t === "NAME" && S[j].d === t.d && (p === t || p.v === "," || p.v === "*" || p.v === "**")) bind(S[j]);
            }
          }
        }
        // case patterns: bare names are capture targets
        if (f.v === "case" && S[S.length - 1].v === ":") {
          for (let k = 1; k < S.length; k++) {
            const t = S[k], p = S[k - 1], nx = S[k + 1];
            if (t.t !== "NAME" || PY_KW.has(t.v) || p.v === ".") continue;
            if (nx && (nx.v === "(" || nx.v === ".")) continue;
            if (nx && nx.v === "=" ) { nonLoad.add(t); continue; }
            bind(t);
          }
          continue;
        }
        // assignment targets: everything left of a top-level "=" (or augmented op / annotation)
        const eqIdx = [];
        S.forEach((t, k) => { if (t.d === 0 && t.t === "OP" && PY_ASSIGN.has(t.v)) eqIdx.push(k); });
        let annEnd = -1;
        if (S.length > 1 && S[0].t === "NAME" && !PY_KW.has(S[0].v) && S[1].t === "OP" && S[1].v === ":") { bind(S[0]); annEnd = 1; }
        let from = 0;
        for (const e of eqIdx) {
          if (annEnd >= 0 && from === 0) { from = e + 1; continue; }
          const seg = S.slice(from, e);
          const brackets = [];
          for (let j = 0; j < seg.length; j++) {
            const t = seg[j];
            if (t.t === "OP" && OPEN[t.v]) { brackets.push(t.v === "[" && operandEnd(seg[j - 1]) ? "sub" : t.v === "(" && operandEnd(seg[j - 1]) ? "call" : "group"); continue; }
            if (t.t === "OP" && CLOSE[t.v]) { brackets.pop(); continue; }
            if (t.t !== "NAME" || PY_KW.has(t.v)) continue;
            if (brackets.some((b) => b !== "group")) continue;
            const p = seg[j - 1], nx = seg[j + 1];
            if (p && p.v === ".") continue;
            if (nx && (nx.v === "." || nx.v === "[" || nx.v === "(")) continue;
            bind(t);
          }
          from = e + 1;
        }
      }
      const reported = new Set();
      for (const S of stmts) {
        for (const t of S) {
          if (t.t !== "NAME" || PY_KW.has(t.v) || nonLoad.has(t) || bound.has(t.v) || PY_BUILTINS.has(t.v) || PY_SOFT.has(t.v)) continue;
          const directPrint = S.length === 4 && S[0].v === "print" && S[1].v === "(" && S[2] === t && S[3].v === ")";
          sink.add(directPrint ? ERROR : WARNING, '"' + t.v + '" is not defined', t.s, t.e, "reportUndefinedVariable");
          reported.add(t.v);
        }
      }
    }
    return sink.out;
  }

  // =====================================================================================
  // C-family: brackets, strings, chars, comments
  // =====================================================================================
  const C_LANGS = {
    java: { char: true, triple: true },
    c: { char: true, pre: true },
    cpp: { char: true, pre: true, raw: true, digitSep: true },
    "objective-c": { char: true, pre: true, at: true },
    csharp: { char: true, pre: true, verbatim: true, triple: true, interp: "csharp" },
    kotlin: { char: true, nested: true, triple: true, interp: "dollar" },
    go: { char: true, backtick: true },
    rust: { char: true, nested: true, lifetime: true, rawRust: true },
    swift: { nested: true, triple: true, interp: "swift" },
    dart: { single: true, nested: true, triple: true, interp: "dollar" },
    scala: { char: true, nested: true, triple: true, lifetime: true, interp: "dollar" },
  };

  function cCheck(text, lang) {
    const o = C_LANGS[lang];
    const sink = makeSink(text, lang === "csharp" ? "C#" : lang === "cpp" ? "C++" : lang[0].toUpperCase() + lang.slice(1));
    const n = text.length;
    const stack = [];
    let i = 0;
    let lineStart = true;
    const ppStack = []; // #if branches: bracket-stack snapshot at #if, so #else branches start from the same state

    function readInterp(k, closer) {
      // k at first char of the interpolated code; returns index after the closer
      let depth = 0;
      while (k < n) {
        const c = text[k];
        if (c === '"' || (o.single && c === "'")) { k = readStr(k, c, false); continue; }
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") { if (depth === 0 && c === closer) return k + 1; depth--; }
        else if (c === "\n") return k;
        k++;
      }
      return k;
    }
    function readStr(s, quote, verbatim) {
      const triple = o.triple && text.startsWith(quote + quote + quote, s);
      let k = s + (triple ? 3 : 1);
      const interp = o.interp;
      const isInterpCs = interp === "csharp" && (text[s - 1] === "$" || (text[s - 1] === "@" && text[s - 2] === "$"));
      while (k < n) {
        const c = text[k];
        if (c === "\\" && !verbatim) { k += 2; continue; }
        if (verbatim && c === quote && text[k + 1] === quote && !triple) { k += 2; continue; }
        if (triple ? text.startsWith(quote + quote + quote, k) : c === quote) {
          if (triple) { let e = k + 3; while (text[e] === quote) e++; return e; }
          return k + 1;
        }
        if (c === "\n" && !triple && !verbatim) break;
        if (interp === "dollar" && c === "$" && text[k + 1] === "{") { k = readInterp(k + 2, "}"); continue; }
        if (interp === "swift" && c === "\\" && text[k + 1] === "(") { k = readInterp(k + 2, ")"); continue; }
        if (isInterpCs && c === "{") { if (text[k + 1] === "{") { k += 2; continue; } k = readInterp(k + 1, "}"); continue; }
        k++;
      }
      sink.add(ERROR, triple || verbatim ? "Unterminated string literal" : "Unterminated string literal", s, triple || verbatim ? lineEnd(text, s) : Math.min(k, lineEnd(text, s)));
      return triple || verbatim ? n : k;
    }

    while (i < n) {
      const c = text[i];
      if (c === "\n") { lineStart = true; i++; continue; }
      if (c === " " || c === "\t" || c === "\r") { i++; continue; }
      if (lineStart && c === "#" && o.pre) {
        // preprocessor directive (line continuations + comments inside): skip, its brackets are not code
        let k = i + 1;
        while (k < n) {
          if (text[k] === "/" && text[k + 1] === "*") { const e = text.indexOf("*/", k + 2); k = e < 0 ? n : e + 2; continue; }
          if (text[k] === "/" && text[k + 1] === "/") { k = lineEnd(text, k); break; }
          if (text[k] === "\\" && (text[k + 1] === "\n" || (text[k + 1] === "\r" && text[k + 2] === "\n"))) { k += text[k + 1] === "\r" ? 3 : 2; continue; }
          if (text[k] === "\n") break;
          k++;
        }
        const dir = /^#\s*(\w+)/.exec(text.slice(i, i + 40));
        const d = dir ? dir[1] : "";
        if (d === "if" || d === "ifdef" || d === "ifndef") ppStack.push({ snap: stack.slice(), after: null });
        else if ((d === "else" || d === "elif" || d === "elifdef" || d === "elifndef") && ppStack.length) {
          const top = ppStack[ppStack.length - 1];
          if (!top.after) top.after = stack.slice();
          stack.length = 0; stack.push(...top.snap);
        } else if (d === "endif" && ppStack.length) {
          const top = ppStack.pop();
          if (top.after) { stack.length = 0; stack.push(...top.after); }
        }
        i = k;
        continue;
      }
      lineStart = false;
      if (c === "/" && text[i + 1] === "/") { i = lineEnd(text, i); continue; }
      if (c === "/" && text[i + 1] === "*") {
        let depth = 1, k = i + 2;
        while (k < n && depth > 0) {
          if (text[k] === "*" && text[k + 1] === "/") { depth--; k += 2; continue; }
          if (o.nested && text[k] === "/" && text[k + 1] === "*") { depth++; k += 2; continue; }
          k++;
        }
        if (depth > 0) { sink.add(ERROR, "Unterminated comment", i, i + 2); i = n; continue; }
        i = k;
        continue;
      }
      if (o.raw && c === "R" && text[i + 1] === '"' && !/[\w]/.test(text[i - 1] || "")) {
        const m = /^R"([^()\\\s]{0,16})\(/.exec(text.slice(i, i + 20));
        if (m) {
          const endTok = ")" + m[1] + '"';
          const e = text.indexOf(endTok, i + m[0].length);
          if (e < 0) { sink.add(ERROR, "Unterminated raw string literal", i, lineEnd(text, i)); i = n; continue; }
          i = e + endTok.length;
          continue;
        }
      }
      if (o.rawRust && c === "r" && (text[i + 1] === '"' || text[i + 1] === "#") && !/[\w]/.test(text[i - 1] || "")) {
        const m = /^r(#*)"/.exec(text.slice(i, i + 40));
        if (m) {
          const endTok = '"' + m[1];
          const e = text.indexOf(endTok, i + m[0].length);
          if (e < 0) { sink.add(ERROR, "Unterminated raw string literal", i, lineEnd(text, i)); i = n; continue; }
          i = e + endTok.length;
          continue;
        }
      }
      if (o.backtick && c === "`") {
        const e = text.indexOf("`", i + 1);
        if (e < 0) { sink.add(ERROR, "Unterminated raw string literal", i, lineEnd(text, i)); i = n; continue; }
        i = e + 1;
        continue;
      }
      if (c === '"') { const verbatim = o.verbatim && (text[i - 1] === "@" || (text[i - 1] === "$" && text[i - 2] === "@")); i = readStr(i, '"', verbatim); continue; }
      if (c === "'") {
        if (o.single) { i = readStr(i, "'", false); continue; }
        if (o.digitSep && /[0-9a-fA-F]/.test(text[i - 1] || "") && /[0-9a-fA-F]/.test(text[i + 1] || "") && /[0-9]/.test(prevNumStart(i))) { i++; continue; }
        if (!o.char) { i++; continue; }
        if (o.lifetime && /[A-Za-z_]/.test(text[i + 1] || "") && text[i + 2] !== "'" && !(text[i + 1] === "\\")) {
          // Rust lifetime / Scala symbol: 'a, 'static
          let k = i + 1; while (k < n && /\w/.test(text[k])) k++;
          if (text[k] !== "'") { i = k; continue; }
        }
        let k = i + 1;
        while (k < n && text[k] !== "'" && text[k] !== "\n") { if (text[k] === "\\") k++; k++; }
        if (text[k] !== "'") { sink.add(ERROR, "Unterminated character literal", i, k); i = k; continue; }
        i = k + 1;
        continue;
      }
      if (OPEN[c]) { stack.push({ ch: c, s: i }); i++; continue; }
      if (CLOSE[c]) {
        // (inside #if blocks the opener may live in another conditional block - e.g. extern "C" {)
        if (!stack.length) { if (!ppStack.length) sink.add(ERROR, '"' + c + '" was not expected', i, i + 1); }
        else { const top = stack.pop(); if (top.ch !== CLOSE[c]) sink.add(ERROR, '"' + c + '" does not match "' + top.ch + '"', i, i + 1); }
        i++;
        continue;
      }
      i++;
    }
    for (const b of stack) sink.add(ERROR, '"' + b.ch + '" was not closed', b.s, b.s + 1);
    return sink.out;

    function prevNumStart(k) { let j = k - 1; while (j > 0 && /[\w']/.test(text[j - 1])) j--; return text[j] || ""; }
  }

  function maskSource(text, lang, keepStrings) {
    const out = text.split("");
    const n = text.length;
    const hash = lang === "python" || lang === "shell" || lang === "ruby" || lang === "php";
    const slash = lang !== "python" && lang !== "shell" && lang !== "ruby";
    const blank = (from, to) => {
      for (let k = from; k < to; k++) if (text[k] !== "\n" && text[k] !== "\r") out[k] = " ";
    };
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (slash && c === "/" && text[i + 1] === "/") {
        const e = lineEnd(text, i);
        blank(i, e);
        i = e;
        continue;
      }
      if (hash && c === "#") {
        const e = lineEnd(text, i);
        blank(i, e);
        i = e;
        continue;
      }
      if (slash && c === "/" && text[i + 1] === "*") {
        const x = text.indexOf("*/", i + 2);
        const e = x < 0 ? n : x + 2;
        blank(i, e);
        i = e;
        continue;
      }
      const triple = lang === "python" && (c === "\"" || c === "'") && text.startsWith(c + c + c, i);
      if (c === "\"" || c === "'" || (c === "`" && (lang === "javascript" || lang === "typescript" || lang === "go"))) {
        let k = i + (triple ? 3 : 1);
        let closed = false;
        while (k < n) {
          if (text[k] === "\\" && lang !== "c") { k += 2; continue; }
          if (triple && text.startsWith(c + c + c, k)) { k += 3; closed = true; break; }
          if (!triple && text[k] === c) {
            if ((lang === "csharp" || lang === "python") && text[k + 1] === c) { k += 2; continue; }
            k++;
            closed = true;
            break;
          }
          if (!triple && text[k] === "\n" && lang !== "javascript" && lang !== "typescript" && lang !== "go") break;
          k++;
        }
        if (!closed && !triple) k = Math.min(k, lineEnd(text, i));
        if (!keepStrings) blank(i, k);
        i = k;
        continue;
      }
      i++;
    }
    return out.join("");
  }

  function identifierCounts(text, lang) {
    const counts = Object.create(null);
    const visible = maskSource(text, lang, true);
    const re = /[A-Za-z_][A-Za-z0-9_]*/g;
    let m;
    while ((m = re.exec(visible))) counts[m[0]] = (counts[m[0]] || 0) + 1;
    return counts;
  }

  function unusedCheck(text, lang, counts, skipNames, baseMarkers) {
    if (lang === "go" || lang === "html" || lang === "css") return [];
    const sink = makeSink(text, "DaphCode");
    const visible = maskSource(text, lang, false);
    const occupied = new Set((baseMarkers || []).map((m) => m.startLineNumber));
    const modulePython = lang === "python" && /^(?:async\s+def|def|class)\s/m.test(visible);
    const typed = /^(\s*)(?:(?:public|private|protected|internal|static|final|const|volatile|unsigned|signed|readonly|late)\s+)*([A-Za-z_][\w]*(?:<[^;=]+>)?(?:\[\])*\s*(?:\*+\s*)?)([A-Za-z_]\w*)\s*(?:\[\])*\s*=\s*(?![=])/;
    const patterns = [];
    if (lang === "python" || lang === "ruby") patterns.push([/^(\s*)([A-Za-z_]\w*)\s*=\s*(?![=])/, 2]);
    else if (lang === "shell") patterns.push([/^(\s*)([A-Za-z_]\w*)=(?!=)/, 2]);
    else if (lang === "php") patterns.push([/^(\s*)\$([A-Za-z_]\w*)\s*=\s*(?![=>])/, 2]);
    else {
      if (lang === "javascript" || lang === "typescript") patterns.push([/^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?![=])/, 2]);
      if (lang === "kotlin" || lang === "swift") patterns.push([/^(\s*)(?:val|var|let)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?![=])/, 2]);
      if (lang === "rust") patterns.push([/^(\s*)let\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?![=])/, 2]);
      if (lang === "dart") patterns.push([/^(\s*)(?:var|final|const)\s+(?:[A-Za-z_]\w*\s+)?([A-Za-z_]\w*)\s*=\s*(?![=])/, 2]);
      if (lang !== "javascript" && lang !== "typescript" && lang !== "kotlin" && lang !== "swift" && lang !== "rust") patterns.push([typed, 3]);
    }
    const excludedTypes = new Set(["return", "throw", "new", "using", "else", "case", "let", "val", "var", "const"]);
    let offset = 0, lineNumber = 1;
    while (offset <= visible.length) {
      const end = visible.indexOf("\n", offset);
      const e = end < 0 ? visible.length : end;
      const line = visible.slice(offset, e);
      for (const [re, group] of patterns) {
        const m = re.exec(line);
        if (!m) continue;
        const name = m[group];
        if (group === 3 && excludedTypes.has(m[2].trim())) continue;
        if (!name || name.startsWith("_") || (skipNames && skipNames.has(name)) || occupied.has(lineNumber) || counts[name] !== 1) continue;
        // Python ALL_CAPS names are constants/public class data, regardless of indentation or scope.
        if (lang === "python" && /^[A-Z][A-Z0-9_]*$/.test(name)) continue;
        if (modulePython && lang === "python" && !/^\s/.test(line)) continue;
        const within = m[0].lastIndexOf(name);
        const start = offset + within;
        sink.add(WARNING, '"' + name + '" is assigned a value but never used', start, start + name.length, "unusedVariable");
        break;
      }
      if (end < 0) break;
      offset = e + 1;
      lineNumber++;
    }
    return sink.out;
  }

  function undefinedOutputCheck(text, lang, counts) {
    if (lang === "python" || lang === "html" || lang === "css" || lang === "shell") return [];
    const sink = makeSink(text, "DaphCode");
    const visible = maskSource(text, lang, false);
    const reported = new Set();
    const globals = new Set(["this", "self", "super", "nil", "null", "true", "false", "undefined", "NaN", "Infinity", "ARGV", "ENV", "__FILE__", "__LINE__"]);
    const add = (name, start) => {
      const key = name + ":" + start;
      if (reported.has(key) || globals.has(name) || counts[name] !== 1) return;
      reported.add(key);
      sink.add(ERROR, '"' + name + '" is not defined', start, start + name.length, "undefinedVariable");
    };
    const direct = /\b(?:console\s*\.\s*log|System\s*\.\s*out\s*\.\s*println|Console\s*\.\s*WriteLine|fmt\s*\.\s*Println|print|println|puts|echo)\s*(?:\(\s*)?\$?([A-Za-z_][A-Za-z0-9_]*)\s*(?=[),;]|\r?$)/gm;
    let m;
    while ((m = direct.exec(visible))) {
      const start = m.index + m[0].lastIndexOf(m[1]);
      add(m[1], start);
    }
    const printf = /\bprintf\s*\(\s*[^,()]*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,)])/g;
    while ((m = printf.exec(visible))) add(m[1], m.index + m[0].lastIndexOf(m[1]));
    const rust = /\b(?:println|print|eprintln|format)!\s*\(\s*[^,;()]*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,)])/g;
    while ((m = rust.exec(visible))) add(m[1], m.index + m[0].lastIndexOf(m[1]));
    const cout = /\bstd\s*::\s*cout([^;]*);/g;
    while ((m = cout.exec(visible))) {
      const base = m.index + m[0].indexOf(m[1]);
      const insertion = /<<\s*([A-Za-z_][A-Za-z0-9_]*)/g;
      let x;
      while ((x = insertion.exec(m[1]))) add(x[1], base + x.index + x[0].lastIndexOf(x[1]));
    }
    return sink.out;
  }

  function shellCheck(text) {
    const sink = makeSink(text, "Shell");
    const visible = maskSource(text, "shell", false);
    const re = /\b(?:if|fi|for|while|until|select|done|case|esac)\b/g;
    const stack = [];
    const closes = { fi: ["if", "if"], done: ["loop", "done"], esac: ["case", "case"] };
    let m;
    while ((m = re.exec(visible))) {
      const word = m[0];
      if (word === "if" || word === "case") stack.push({ word, kind: word, start: m.index });
      else if (word === "for" || word === "while" || word === "until" || word === "select") stack.push({ word, kind: "loop", start: m.index });
      else {
        const expected = closes[word];
        const top = stack[stack.length - 1];
        if (!top || top.kind !== expected[0]) sink.add(ERROR, "Unexpected '" + word + "'", m.index, m.index + word.length, "shellBlock");
        else stack.pop();
      }
    }
    for (const item of stack) {
      const closer = item.kind === "if" ? "fi" : item.kind === "case" ? "esac" : "done";
      sink.add(ERROR, "Missing '" + closer + "' for this '" + item.word + "'", item.start, item.start + item.word.length, "shellBlock");
    }
    return sink.out;
  }

  function goCheck(text) {
    const sink = makeSink(text, "Go");
    const visible = maskSource(text, "go", false);
    const states = new Map();
    let offset = 0;
    let depth = 0;
    while (offset <= visible.length) {
      const end = visible.indexOf("\n", offset);
      const e = end < 0 ? visible.length : end;
      const line = visible.slice(offset, e);
      const assignment = /^(\s*)([A-Za-z_]\w*)\s*(:?=)\s*(?!=)/.exec(line);
      const readText = assignment ? line.slice(assignment[0].length) : line;
      for (const [key, state] of states) {
        const name = key.slice(key.indexOf(":") + 1);
        if (new RegExp("\\b" + name + "\\b").test(readText)) state.unread = false;
      }
      if (assignment) {
        const name = assignment[2];
        const key = depth + ":" + name;
        const previous = states.get(key);
        const start = offset + assignment[0].lastIndexOf(name);
        if (previous && previous.unread) sink.add(WARNING, 'Previous assignment to "' + name + '" is never used', start, start + name.length, "ineffectualAssignment");
        states.set(key, { unread: true });
      }
      for (const c of line) {
        if (c === "{") depth++;
        else if (c === "}") depth = Math.max(0, depth - 1);
      }
      if (end < 0) break;
      offset = e + 1;
    }
    return sink.out;
  }

  function editDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const old = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = old;
      }
    }
    return row[b.length];
  }

  const CSS_PROPERTIES = new Set(("align-items align-content animation appearance aspect-ratio background background-color background-image background-position background-repeat background-size border border-bottom border-collapse border-color border-left border-radius border-right border-style border-top border-width bottom box-shadow box-sizing color column-gap content cursor display filter flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap float font font-family font-size font-style font-weight gap grid grid-area grid-column grid-row grid-template-columns grid-template-rows height inset justify-content justify-items left letter-spacing line-height list-style margin margin-bottom margin-left margin-right margin-top max-height max-width min-height min-width object-fit opacity order outline overflow overflow-x overflow-y padding padding-bottom padding-left padding-right padding-top pointer-events position right row-gap text-align text-decoration text-overflow text-shadow text-transform top transform transition vertical-align visibility white-space width word-break z-index").split(" "));

  function cssCheck(text, nativeService) {
    const sink = makeSink(text, "CSS");
    const visible = maskSource(text, "css", false);
    let offset = 0, depth = 0;
    while (offset <= visible.length) {
      const end = visible.indexOf("\n", offset);
      const e = end < 0 ? visible.length : end;
      const line = visible.slice(offset, e);
      const important = /!important/gi;
      let m;
      while ((m = important.exec(line))) sink.add(WARNING, 'Avoid "!important" when possible', offset + m.index, offset + m.index + m[0].length, "importantDeclaration");
      if (depth > 0) {
        const declaration = /^(\s*)([A-Za-z-][A-Za-z0-9-]*)\s*:/.exec(line);
        if (declaration && !declaration[2].startsWith("--") && !declaration[2].startsWith("-")) {
          const property = declaration[2].toLowerCase();
          if (!nativeService && !CSS_PROPERTIES.has(property)) {
            let nearest = "", distance = 2;
            for (const candidate of CSS_PROPERTIES) {
              const d = editDistance(property, candidate);
              if (d < distance) { distance = d; nearest = candidate; }
            }
            if (nearest && distance === 1) {
              const start = offset + declaration[0].lastIndexOf(declaration[2]);
              sink.add(ERROR, 'Unknown property: "' + declaration[2] + '". Did you mean "' + nearest + '"?', start, start + declaration[2].length, "unknownProperty");
            }
          }
        }
      }
      for (const c of line) {
        if (c === "{") depth++;
        else if (c === "}") depth = Math.max(0, depth - 1);
      }
      if (end < 0) break;
      offset = e + 1;
    }
    return sink.out;
  }

  function htmlCheck(text) {
    const sink = makeSink(text, "HTML");
    const chars = text.split("");
    const blank = (from, to) => {
      for (let i = from; i < to; i++) if (text[i] !== "\n" && text[i] !== "\r") chars[i] = " ";
    };
    let m;
    const comments = /<!--[\s\S]*?-->/g;
    while ((m = comments.exec(text))) blank(m.index, m.index + m[0].length);
    let visible = chars.join("");
    const embedded = /(<(?:script|style)\b[^>]*>)([\s\S]*?)(<\/(?:script|style)\s*>)/gi;
    while ((m = embedded.exec(visible))) blank(m.index + m[1].length, m.index + m[1].length + m[2].length);
    visible = chars.join("");
    const ids = new Map();
    const tags = /<\s*([A-Za-z][\w:-]*)([^<>]*?)>/g;
    while ((m = tags.exec(visible))) {
      const tag = m[1].toLowerCase();
      const attrs = m[2];
      const tagStart = m.index + m[0].indexOf(m[1]);
      if (tag === "img" && !/(?:^|\s)alt(?:\s*=|\s|$)/i.test(attrs)) sink.add(WARNING, 'Image is missing an "alt" attribute', tagStart, tagStart + m[1].length, "missingAlt");
      const id = /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attrs);
      if (!id) continue;
      const value = id[1] != null ? id[1] : id[2] != null ? id[2] : id[3];
      if (!value) continue;
      const relative = id.index + id[0].lastIndexOf(value);
      const start = m.index + m[0].indexOf(attrs) + relative;
      if (ids.has(value)) sink.add(ERROR, 'Duplicate id "' + value + '"', start, start + value.length, "duplicateId");
      else ids.set(value, start);
    }
    return sink.out;
  }

  function javaCheck(text) {
    const sink = makeSink(text, "Java");
    const visible = maskSource(text, "java", false);
    const re = /\bnew\s+Thread\s*\([^()]*\)\s*\.\s*(stop|suspend|resume)\s*\(\s*\)/g;
    let m;
    while ((m = re.exec(visible))) {
      const start = m.index + m[0].lastIndexOf(m[1]);
      sink.add(WARNING, "Thread." + m[1] + "() is deprecated", start, start + m[1].length, "deprecatedMethod");
    }
    return sink.out;
  }

  function typescriptCheck(text) {
    const sink = makeSink(text, "TypeScript");
    const visible = maskSource(text, "typescript", false);
    const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*(string|number|boolean)\s*=/g;
    const skip = new Set();
    let m;
    while ((m = re.exec(visible))) {
      let start = re.lastIndex;
      while (/\s/.test(text[start] || "")) start++;
      let kind = "", end = start + 1;
      if (text[start] === "\"" || text[start] === "'" || text[start] === "`") {
        kind = "string";
        const quote = text[start];
        end = start + 1;
        while (end < text.length && text[end] !== quote && text[end] !== "\n") { if (text[end] === "\\") end++; end++; }
        if (text[end] === quote) end++;
      } else {
        const literal = /^(?:true|false|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/i.exec(text.slice(start));
        if (!literal) continue;
        kind = literal[0] === "true" || literal[0] === "false" ? "boolean" : "number";
        end = start + literal[0].length;
      }
      if (kind === m[2]) continue;
      skip.add(m[1]);
      sink.add(ERROR, "Type '" + kind + "' is not assignable to type '" + m[2] + "'", start, end, "typeMismatch");
    }
    return { markers: sink.out, skip };
  }

  function generalCheck(lang, text, baseMarkers, options) {
    if (C_LANGS[lang] && baseMarkers.some((m) => m.severity === ERROR)) return [];
    if (lang === "html") return htmlCheck(text);
    if (lang === "css") return cssCheck(text, !!(options && options.native));
    const counts = identifierCounts(text, lang);
    let markers = [];
    let skip;
    if (lang === "typescript") {
      const result = typescriptCheck(text);
      if (!(options && options.native)) markers = markers.concat(result.markers);
      skip = result.skip;
    }
    markers = markers.concat(unusedCheck(text, lang, counts, skip, baseMarkers));
    if (lang !== "typescript" || !(options && options.native)) markers = markers.concat(undefinedOutputCheck(text, lang, counts));
    if (lang === "shell") markers = markers.concat(shellCheck(text));
    if (lang === "go") markers = markers.concat(goCheck(text));
    if (lang === "java") markers = markers.concat(javaCheck(text));
    return markers;
  }

  const GENERAL_LANGS = new Set(["python", "javascript", "typescript", "shell", "php", "ruby", "html", "css"]);

  function check(lang, text, options) {
    text = String(text == null ? "" : text);
    let base = [];
    if (lang === "python") base = pyCheck(text);
    else if (C_LANGS[lang]) base = cCheck(text, lang);
    else if (!GENERAL_LANGS.has(lang)) return [];
    return base.concat(generalCheck(lang, text, base, options));
  }
  const supports = (lang) => GENERAL_LANGS.has(lang) || !!C_LANGS[lang];

  const api = { check, supports, tokenizePython: (text) => ({ tokens: pyTokenize(text, { add() {} }, true), starts: lineIndex(text) }), languages: Array.from(new Set(["python"].concat(Object.keys(C_LANGS), Array.from(GENERAL_LANGS)))) };
  root.DaphDiag = api;
  if (typeof module === "object" && module.exports) module.exports = api;

  // Worker mode
  if (typeof importScripts === "function" && typeof document === "undefined") {
    self.onmessage = (e) => {
      const d = e.data || {};
      if (d.kind === "highlight") {
        try {
          if (!self.DaphHighlight) importScripts(d.script);
          const data = self.DaphHighlight.pythonSemantic(d.text);
          self.postMessage({ id: d.id, kind: "highlight", data }, [data.buffer]);
        } catch (_) { self.postMessage({ id: d.id, kind: "highlight", failed: true }); }
        return;
      }
      let markers = [];
      try { markers = check(d.lang, d.text, { native: !!d.native }); } catch (err) { markers = []; }
      self.postMessage({ id: d.id, markers });
    };
  }
})(typeof self !== "undefined" ? self : globalThis);
