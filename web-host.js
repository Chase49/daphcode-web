(function (root) {
  "use strict";

  const READ_BYTES = 1 << 20;
  const TEXT_CHARS = 1 << 20;
  const RECENTS_KEY = "daphcode.web.recents.v1";
  const DB_NAME = "daphcode.web.v1";
  const STORE_NAME = "handles";

  function splitText(text, max) {
    const size = max || TEXT_CHARS;
    const out = [];
    if (!text.length) return [""];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + size);
      const code = text.charCodeAt(end - 1);
      if (end < text.length && end > start + 1 && code >= 0xd800 && code <= 0xdbff) end--;
      out.push(text.slice(start, end));
      start = end;
    }
    return out;
  }

  function sniffBom(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: "UTF-8", bom: true, offset: 3 };
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: "UTF-16LE", bom: true, offset: 2 };
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "UTF-16BE", bom: true, offset: 2 };
    return { encoding: "UTF-8", bom: false, offset: 0 };
  }

  function decoderFor(encoding, fatal) {
    const label = encoding === "UTF-16LE" ? "utf-16le" : encoding === "UTF-16BE" ? "utf-16be" : "utf-8";
    return new TextDecoder(label, { fatal: !!fatal });
  }

  function decodeBytes(input, chunkChars) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const info = sniffBom(bytes);
    const size = chunkChars || TEXT_CHARS;
    const run = (fatal) => {
      const decoder = decoderFor(info.encoding, fatal);
      const chunks = [];
      for (let offset = info.offset; offset < bytes.length; offset += size) {
        const end = Math.min(bytes.length, offset + size);
        chunks.push(decoder.decode(bytes.subarray(offset, end), { stream: end < bytes.length }));
      }
      const last = decoder.decode();
      if (last) chunks.push(last);
      if (!chunks.length) chunks.push("");
      return chunks;
    };
    let lossy = false;
    let chunks;
    try {
      chunks = run(true);
    } catch (_) {
      lossy = true;
      chunks = run(false);
    }
    return { chunks, encoding: info.encoding, bom: info.bom, lossy, size: bytes.length };
  }

  async function decodeBlob(blob, chunkBytes, chunkChars) {
    const size = chunkBytes || READ_BYTES;
    const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    const info = sniffBom(head);
    const run = async (fatal) => {
      const decoder = decoderFor(info.encoding, fatal);
      const chunks = [];
      for (let offset = info.offset; offset < blob.size; offset += size) {
        const end = Math.min(blob.size, offset + size);
        const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
        chunks.push(decoder.decode(bytes, { stream: true }));
      }
      const last = decoder.decode();
      if (last) chunks.push(last);
      if (!chunks.length) chunks.push("");
      return chunks;
    };
    let lossy = false;
    let chunks;
    try {
      chunks = await run(true);
    } catch (_) {
      lossy = true;
      chunks = await run(false);
    }
    return { chunks, encoding: info.encoding, bom: info.bom, lossy, size: blob.size };
  }

  function utf16Bytes(text, littleEndian) {
    const out = new Uint8Array(text.length * 2);
    let offset = 0;
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          out[offset++] = littleEndian ? code & 255 : code >> 8;
          out[offset++] = littleEndian ? code >> 8 : code & 255;
          i++;
          code = next;
        } else code = 0xfffd;
      } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd;
      out[offset++] = littleEndian ? code & 255 : code >> 8;
      out[offset++] = littleEndian ? code >> 8 : code & 255;
    }
    return out;
  }

  function encodeChunks(chunks, encoding, bom, chunkChars) {
    const parts = [];
    if (bom) {
      if (encoding === "UTF-16LE") parts.push(new Uint8Array([0xff, 0xfe]));
      else if (encoding === "UTF-16BE") parts.push(new Uint8Array([0xfe, 0xff]));
      else parts.push(new Uint8Array([0xef, 0xbb, 0xbf]));
    }
    const encoder = encoding === "UTF-8" ? new TextEncoder() : null;
    for (const value of chunks) {
      for (const chunk of splitText(String(value), chunkChars || TEXT_CHARS)) {
        if (encoder) parts.push(encoder.encode(chunk));
        else parts.push(utf16Bytes(chunk, encoding !== "UTF-16BE"));
      }
    }
    return parts;
  }

  function encodeText(text, encoding, bom, chunkChars) {
    return encodeChunks([text], encoding || "UTF-8", !!bom, chunkChars);
  }

  function parseUri(uri) {
    const match = /^(webfs|webfile|download):\/\/([^/]+)\/(.+)$/.exec(uri || "");
    if (!match) return null;
    try {
      return { scheme: match[1], id: match[2], name: decodeURIComponent(match[3]) };
    } catch (_) {
      return null;
    }
  }

  function baseName(value) {
    const clean = String(value || "").replace(/[\\/]+$/, "");
    return clean.slice(clean.lastIndexOf("/") + 1) || "untitled.txt";
  }

  function createHost(env) {
    const memory = (env.__daphFiles = env.__daphFiles || {});
    const texts = new Map();
    const outgoing = new Map();
    const handles = new Map();
    const files = new Map();
    const downloads = new Map();
    const uris = new Map();
    const fingerprints = new Map();
    let clip = "";
    let tokenSeq = 0;
    let dbPromise = null;
    let recentItems = readRecents();

    function readRecents() {
      try {
        const value = JSON.parse(env.localStorage.getItem(RECENTS_KEY) || "[]");
        if (!Array.isArray(value)) return [];
        return value.filter((item) => item && typeof item.uri === "string" && typeof item.name === "string" && item.uri.startsWith("webfs://") && parseUri(item.uri)).slice(0, 50);
      } catch (_) {
        return [];
      }
    }

    function persistRecents() {
      try {
        env.localStorage.setItem(RECENTS_KEY, JSON.stringify(recentItems.filter((item) => item.uri.startsWith("webfs://")).slice(0, 50)));
      } catch (_) {}
    }

    function remember(uri, name) {
      recentItems = recentItems.filter((item) => item.uri !== uri);
      recentItems.unshift({ uri, name });
      if (recentItems.length > 50) recentItems.length = 50;
      persistRecents();
    }

    function randomId() {
      if (env.crypto && typeof env.crypto.randomUUID === "function") return env.crypto.randomUUID();
      if (env.crypto && typeof env.crypto.getRandomValues === "function") {
        const values = new Uint32Array(4);
        env.crypto.getRandomValues(values);
        return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
      }
      return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }

    function makeUri(scheme, name, id) {
      return scheme + "://" + (id || randomId()) + "/" + encodeURIComponent(name);
    }

    function openDatabase() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve) => {
        if (!env.indexedDB) return resolve(null);
        let request;
        try {
          request = env.indexedDB.open(DB_NAME, 1);
        } catch (_) {
          return resolve(null);
        }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      });
      return dbPromise;
    }

    async function databaseGet(id) {
      const db = await openDatabase();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });
    }

    async function databasePut(id, handle) {
      const db = await openDatabase();
      if (!db) return false;
      return new Promise((resolve) => {
        try {
          const transaction = db.transaction(STORE_NAME, "readwrite");
          transaction.objectStore(STORE_NAME).put(handle, id);
          transaction.oncomplete = () => resolve(true);
          transaction.onerror = () => resolve(false);
          transaction.onabort = () => resolve(false);
        } catch (_) {
          resolve(false);
        }
      });
    }

    async function databaseDelete(id) {
      const db = await openDatabase();
      if (!db) return;
      try {
        db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id);
      } catch (_) {}
    }

    function consume(req, text) {
      if (text != null) return [text];
      const chunks = outgoing.get(req) || [];
      outgoing.delete(req);
      return chunks;
    }

    function failOpen(error, req) {
      const message = error && error.message ? error.message : "The file could not be opened.";
      env.DaphHost.onOpenFailed(message, req);
    }

    function saveFailure(req, uri, error) {
      const cancelled = error && error.name === "AbortError";
      const message = cancelled ? "cancelled" : error && error.message ? error.message : "The browser did not allow this save.";
      env.DaphHost.onSaveResult(req, false, uri || "", "", message);
    }

    async function permission(handle, mode, interactive) {
      if (!handle || typeof handle.queryPermission !== "function") return true;
      const options = { mode };
      let state = await handle.queryPermission(options);
      if (state === "granted") return true;
      if (!interactive || typeof handle.requestPermission !== "function") return false;
      state = await handle.requestPermission(options);
      return state === "granted";
    }

    async function handleFor(id) {
      if (handles.has(id)) return handles.get(id);
      const handle = await databaseGet(id);
      if (handle) handles.set(id, handle);
      return handle;
    }

    async function uriForHandle(handle, name) {
      if (typeof handle.isSameEntry === "function") {
        for (const [id, existing] of handles) {
          try {
            if (await existing.isSameEntry(handle)) return { id, uri: uris.get(id) || makeUri("webfs", name, id) };
          } catch (_) {}
        }
      }
      const id = randomId();
      return { id, uri: makeUri("webfs", name, id) };
    }

    async function openHandle(handle, req, interactive) {
      const granted = await permission(handle, "read", interactive !== false);
      if (!granted) throw new Error("Permission to read this file was not granted. Choose it again to retry.");
      const file = await handle.getFile();
      const identity = await uriForHandle(handle, file.name);
      handles.set(identity.id, handle);
      files.set(identity.id, file);
      uris.set(identity.id, identity.uri);
      await databasePut(identity.id, handle);
      await deliverBlob(identity.uri, file, req);
    }

    async function openFile(file, req) {
      const fingerprint = file.name + "|" + file.size + "|" + file.lastModified;
      let id = fingerprints.get(fingerprint);
      let uri = id && uris.get(id);
      if (!uri) {
        id = randomId();
        uri = makeUri("webfile", file.name, id);
        fingerprints.set(fingerprint, id);
        uris.set(id, uri);
      }
      files.set(id, file);
      await deliverBlob(uri, file, req);
    }

    async function deliverBlob(uri, file, req) {
      const name = baseName(parseUri(uri) ? parseUri(uri).name : file.name);
      if (file.size > 16 * 1024 * 1024) env.DaphHost.onOpening(name, file.size);
      const result = await decodeBlob(file, READ_BYTES, env.__chunkChars || TEXT_CHARS);
      const token = "web-" + (++tokenSeq);
      texts.set(token, result.chunks);
      remember(uri, name);
      env.DaphHost.onOpened({ token, uri, name, encoding: result.encoding, bom: result.bom, lossy: result.lossy, size: result.size, req });
    }

    function deliverMemory(uri, req) {
      if (!(uri in memory)) {
        env.DaphHost.onOpenFailed("File no longer available: " + uri, req);
        return;
      }
      const token = "web-" + (++tokenSeq);
      texts.set(token, memory[uri]);
      const name = baseName(uri.replace(/^mem:\/\//, ""));
      env.DaphHost.onOpened({ token, uri, name, encoding: "UTF-8", bom: false, size: memory[uri].length, lossy: false, req });
    }

    function deliverDownload(uri, req) {
      const parsed = parseUri(uri);
      const item = parsed && downloads.get(parsed.id);
      if (!item) {
        env.DaphHost.onOpenFailed("This downloaded copy is no longer in the browser session. Open the downloaded file to continue.", req);
        return;
      }
      const token = "web-" + (++tokenSeq);
      texts.set(token, item.chunks.slice());
      env.DaphHost.onOpened({ token, uri, name: parsed.name, encoding: item.encoding, bom: item.bom, lossy: false, size: item.size, req });
    }

    async function reopen(req, uri, interactive) {
      try {
        if (uri.startsWith("mem://")) return deliverMemory(uri, req);
        if (uri.startsWith("download://")) return deliverDownload(uri, req);
        const parsed = parseUri(uri);
        if (!parsed) throw new Error("This file reference is not valid in the website.");
        if (parsed.scheme === "webfile") {
          const file = files.get(parsed.id);
          if (!file) throw new Error("This picker-only file is no longer available after reload. Choose it again.");
          return await deliverBlob(uri, file, req);
        }
        const handle = await handleFor(parsed.id);
        if (!handle) throw new Error("This file is no longer authorized. Choose it again to restore access.");
        return await openHandle(handle, req, interactive);
      } catch (error) {
        failOpen(error, req);
      }
    }

    async function writeHandle(handle, chunks, encoding, bom) {
      const parts = encodeChunks(chunks, encoding, bom, env.__chunkChars || TEXT_CHARS);
      const blob = new Blob(parts, { type: "text/plain;charset=utf-8" });
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        if (typeof writable.abort === "function") {
          try { await writable.abort(); } catch (_) {}
        }
        throw error;
      }
      const file = await handle.getFile();
      if (file.size !== blob.size) throw new Error("The saved file size did not match the encoded document. Use Save As and verify the file before closing it.");
      return file;
    }

    async function saveNative(req, uri, parsed, chunks, encoding, bom) {
      try {
        const handle = await handleFor(parsed.id);
        if (!handle) throw new Error("This file is no longer authorized. Use Save As to choose a destination.");
        if (!await permission(handle, "readwrite", true)) throw new Error("Write permission was not granted. Use Save As to choose a new destination.");
        const file = await writeHandle(handle, chunks, encoding, bom);
        files.set(parsed.id, file);
        remember(uri, parsed.name);
        env.DaphHost.onSaveResult(req, true, uri, parsed.name, "");
      } catch (error) {
        saveFailure(req, uri, error);
      }
    }

    function downloadChunks(req, oldUri, name, chunks, encoding, bom) {
      try {
        const parts = encodeChunks(chunks, encoding, bom, env.__chunkChars || TEXT_CHARS);
        const blob = new Blob(parts, { type: "text/plain;charset=utf-8" });
        const id = randomId();
        const uri = makeUri("download", name, id);
        const url = URL.createObjectURL(blob);
        const anchor = env.document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.style.display = "none";
        env.document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        env.setTimeout(() => URL.revokeObjectURL(url), 60000);
        downloads.set(id, { chunks: chunks.slice(), encoding, bom: !!bom, size: blob.size });
        uris.set(id, uri);
        remember(uri, name);
        env.DaphHost.onSaveResult(req, true, uri, name, "");
      } catch (error) {
        saveFailure(req, oldUri, error);
      }
    }

    async function saveAsChunks(req, oldUri, name, chunks, encoding, bom) {
      if (typeof env.showSaveFilePicker === "function" && env.isSecureContext !== false) {
        let handle;
        try {
          handle = await env.showSaveFilePicker({ suggestedName: name });
          const uri = makeUri("webfs", handle.name || name);
          const parsed = parseUri(uri);
          const file = await writeHandle(handle, chunks, encoding, bom);
          handles.set(parsed.id, handle);
          files.set(parsed.id, file);
          uris.set(parsed.id, uri);
          await databasePut(parsed.id, handle);
          remember(uri, parsed.name);
          env.DaphHost.onSaveResult(req, true, uri, parsed.name, "");
        } catch (error) {
          saveFailure(req, oldUri, error);
        }
        return;
      }
      downloadChunks(req, oldUri, name, chunks, encoding, bom);
    }

    function save(req, uri, text, encoding, bom) {
      const chunks = consume(req, text);
      if (uri.startsWith("mem://")) {
        memory[uri] = chunks.join("");
        const name = baseName(uri.replace(/^mem:\/\//, ""));
        remember(uri, name);
        env.DaphHost.onSaveResult(req, true, uri, name, "");
        return;
      }
      const parsed = parseUri(uri);
      if (parsed && parsed.scheme === "webfs") return saveNative(req, uri, parsed, chunks, encoding, bom);
      return saveAsChunks(req, uri, parsed ? parsed.name : baseName(uri), chunks, encoding, bom);
    }

    function saveAs(req, name, text, encoding, bom) {
      const chunks = consume(req, text);
      return saveAsChunks(req, "", name, chunks, encoding, bom);
    }

    async function rename(req, uri, name) {
      try {
        if (uri.startsWith("mem://")) {
          const next = "mem://" + name;
          memory[next] = memory[uri];
          delete memory[uri];
          remember(next, name);
          env.DaphHost.onRenameResult(req, true, next, name, "");
          return;
        }
        const parsed = parseUri(uri);
        if (!parsed || parsed.scheme !== "webfs") throw new Error("This browser cannot rename a picker-only or downloaded file. Use Save As instead.");
        const handle = await handleFor(parsed.id);
        if (!handle) throw new Error("The original file handle is unavailable. Use Save As instead.");
        if (typeof handle.move !== "function") throw new Error("This browser cannot rename a local file in place. Use Save As instead.");
        if (!await permission(handle, "readwrite", true)) throw new Error("Write permission was not granted. Use Save As instead.");
        const moved = await handle.move(name);
        const currentHandle = moved || handle;
        handles.set(parsed.id, currentHandle);
        files.set(parsed.id, await currentHandle.getFile());
        await databasePut(parsed.id, currentHandle);
        const next = makeUri("webfs", name, parsed.id);
        uris.set(parsed.id, next);
        recentItems = recentItems.filter((item) => item.uri !== uri);
        remember(next, name);
        env.DaphHost.onRenameResult(req, true, next, name, "");
      } catch (error) {
        env.DaphHost.onRenameResult(req, false, uri, name, error.message || "Rename was not completed.");
      }
    }

    function pickerFallback() {
      const input = env.document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.style.display = "none";
      env.document.body.appendChild(input);
      const cleanup = () => input.remove();
      input.addEventListener("change", async () => {
        const selected = Array.from(input.files || []);
        cleanup();
        for (const file of selected) {
          try { await openFile(file); } catch (error) { failOpen(error); }
        }
      }, { once: true });
      input.addEventListener("cancel", cleanup, { once: true });
      input.click();
    }

    async function openFiles() {
      if (typeof env.showOpenFilePicker === "function" && env.isSecureContext !== false) {
        try {
          const selected = await env.showOpenFilePicker({ multiple: true });
          for (const handle of selected) await openHandle(handle);
        } catch (error) {
          if (error.name !== "AbortError") failOpen(error);
        }
        return;
      }
      pickerFallback();
    }

    async function openDataTransfer(dataTransfer) {
      const items = Array.from(dataTransfer.items || []);
      if (items.length && typeof items[0].getAsFileSystemHandle === "function" && env.isSecureContext !== false) {
        try {
          const dropped = await Promise.all(items.map((item) => item.kind === "file" ? item.getAsFileSystemHandle() : null));
          let handled = false;
          for (const handle of dropped) {
            if (!handle) continue;
            handled = true;
            if (handle.kind !== "file") {
              env.DaphHost.onOpenFailed("Folders cannot be opened as text documents. Select files instead.");
              continue;
            }
            await openHandle(handle);
          }
          if (handled) return;
        } catch (_) {}
      }
      const droppedFiles = Array.from(dataTransfer.files || []);
      for (const file of droppedFiles) {
        try { await openFile(file); } catch (error) { failOpen(error); }
      }
    }

    async function copy(text) {
      clip = text;
      env.__clip = text;
      if (env.navigator.clipboard && typeof env.navigator.clipboard.writeText === "function") {
        try { await env.navigator.clipboard.writeText(text); } catch (_) {}
      }
    }

    async function paste() {
      if (env.__clip != null) return env.__clip;
      if (clip) return clip;
      if (env.navigator.clipboard && typeof env.navigator.clipboard.readText === "function") {
        try { return await env.navigator.clipboard.readText(); } catch (_) {}
      }
      return "";
    }

    const host = {
      native: false,
      web: true,
      touch: !!(env.matchMedia && env.matchMedia("(pointer: coarse)").matches) || env.navigator.maxTouchPoints > 0,
      openFiles,
      openDataTransfer,
      chunked: true,
      canChunkSave: true,
      chunkCount(token) {
        if (!texts.has(token) && env.__pendingTexts && token in env.__pendingTexts) {
          texts.set(token, env.__pendingTexts[token]);
          delete env.__pendingTexts[token];
        }
        if (!texts.has(token)) return -1;
        const value = texts.get(token);
        if (typeof value === "string") texts.set(token, splitText(value, env.__chunkChars || TEXT_CHARS));
        return texts.get(token).length;
      },
      takeChunk(token, index) {
        const chunks = texts.get(token);
        if (!chunks) return null;
        const value = chunks[index];
        if (index === chunks.length - 1) texts.delete(token);
        return value;
      },
      release(token) {
        texts.delete(token);
      },
      writeBegin(req) {
        outgoing.set(req, []);
      },
      writeChunk(req, chunk) {
        const target = outgoing.get(req);
        if (!target) return false;
        target.push(chunk);
        env.__writeChunks = (env.__writeChunks || 0) + 1;
        return true;
      },
      take(token) {
        if (!texts.has(token) && env.__pendingTexts && token in env.__pendingTexts) {
          const value = env.__pendingTexts[token];
          delete env.__pendingTexts[token];
          return value;
        }
        const value = texts.get(token);
        texts.delete(token);
        return value;
      },
      save,
      saveAs,
      rename,
      reopen,
      revert: reopen,
      recents: () => recentItems.map((item) => ({ uri: item.uri, name: item.name })),
      forgetRecent(uri) {
        recentItems = recentItems.filter((item) => item.uri !== uri);
        persistRecents();
        const parsed = parseUri(uri);
        if (parsed && parsed.scheme === "webfs") databaseDelete(parsed.id);
      },
      copy,
      paste,
      haptic() {
        if (env.navigator.vibrate) env.navigator.vibrate(8);
      },
      setDirty() {},
      exit() {
        env.__exited = true;
        env.close();
        return false;
      },
      version: () => "Web 1.0.0",
      showKeyboard() {},
      hideKeyboard() {
        if (env.document.activeElement && typeof env.document.activeElement.blur === "function") env.document.activeElement.blur();
      },
      storageState: () => ({ granted: false, unsupported: true }),
      requestAllFiles() {},
      fileAccessLabel() {
        return typeof env.showOpenFilePicker === "function" && env.isSecureContext !== false ? "Direct local file editing" : "Picker and download mode";
      }
    };

    host.ready = (async () => {
      for (const item of recentItems) {
        const parsed = parseUri(item.uri);
        if (!parsed) continue;
        const handle = await databaseGet(parsed.id);
        if (handle) {
          handles.set(parsed.id, handle);
          uris.set(parsed.id, item.uri);
        }
      }
    })();

    return host;
  }

  const api = { splitText, sniffBom, decodeBytes, decodeBlob, encodeChunks, encodeText, parseUri, createHost };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.DaphWebCodec = api;
  if (typeof window !== "undefined" && typeof document !== "undefined") root.DaphWebHost = createHost(root);
})(typeof self !== "undefined" ? self : globalThis);
