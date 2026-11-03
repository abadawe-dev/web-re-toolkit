// A dedicated worker's realm. The host (src/graph.rs) opens a fresh V8 context for each worker,
// registers the __wreW_* host functions, evaluates channels.js and this file, then hands the
// worker control left in `globalThis.__WORKER` to the page realm that made the Worker, whose
// `bind` builds the worker's global surface: Chrome's DedicatedWorkerGlobalScope as the capture
// recorded it (assets/graph/worker-shape.json.gz, from assets/worker-capture.js), with real
// behaviour for what a worker script reaches (messaging, timers, navigator, location, crypto,
// encoding, blobs, URLs, fetch, importScripts, the origin private file system) and inert,
// native-looking members for the rest. The host then runs the worker's script, and the realm that
// owns the worker pumps its event loop (`due`/`step`) between its own tasks.
(function () {
  var host = {
    now: __wreW_now,
    entropy: __wreW_entropy,
    uuid: __wreW_uuid,
    digest: __wreW_digest,
    send: __wreW_send,
    url: __wreW_url,
    flush: __wreW_flush,
    miss: __wreW_miss,
  };
  ["now", "entropy", "uuid", "digest", "send", "url", "flush", "miss"].forEach(function (name) { delete globalThis["__wreW_" + name]; });

  var channelsFactory = globalThis.__wreChannels;
  delete globalThis.__wreChannels;

  var apply = Reflect.apply;
  var hasOwn = Object.prototype.hasOwnProperty;
  var defineProperty = Object.defineProperty;
  var getProto = Object.getPrototypeOf;
  var setProto = Object.setPrototypeOf;
  var nativeToString = Function.prototype.toString;

  // The worker's state, filled in by bind().
  var sources = null;
  var shared = null;
  var facts = null;
  var owner = null;
  var channels = null;
  var started = false;
  var closing = false;
  var dead = false;
  var startNow = 0;
  var scriptUrl = "";

  // --- natives -----------------------------------------------------------------------------

  var nativeSource = function (name) { return "function " + name + "() { [native code] }"; };

  var factories = Object.create(null);
  var IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  // A function that stringifies as native: a method (not constructible, no prototype), a getter
  // or setter, or a constructor, each named as Chrome names it.
  var native = function (kind, name, length, impl) {
    var key = kind + ":" + name;
    var made;
    if (!IDENTIFIER.test(name)) {
      made = kind === "ctor" ? function () { return impl(this, arguments, new.target); } : ({ m: function () { return impl(this, arguments); } }).m;
    } else {
      if (!factories[key]) {
        var body;
        if (kind === "ctor") body = "return function " + name + "() { return impl(this, arguments, new.target); };";
        else if (kind === "get") body = "return Object.getOwnPropertyDescriptor({ get " + name + "() { return impl(this, arguments); } }, '" + name + "').get;";
        else if (kind === "set") body = "return Object.getOwnPropertyDescriptor({ set " + name + "(value) { return impl(this, arguments); } }, '" + name + "').set;";
        else body = "return ({ " + name + "() { return impl(this, arguments); } })." + name + ";";
        factories[key] = Function("impl", body);
      }
      made = factories[key](impl);
    }
    var shown = kind === "get" ? "get " + name : kind === "set" ? "set " + name : name;
    // A factory-made function already has Chrome's name ("get x" for a getter) and the length its
    // parameter list gives (0, or 1 for a setter); only other lengths and odd names are set.
    if (!IDENTIFIER.test(name)) defineProperty(made, "name", { value: shown, configurable: true });
    if ((length || 0) !== (kind === "set" ? 1 : 0)) defineProperty(made, "length", { value: length || 0, configurable: true });
    sources.set(made, nativeSource(shown));
    return made;
  };

  var illegal = function () {
    throw new TypeError("Illegal invocation");
  };

  // --- base64, UTF-8 ----------------------------------------------------------------------

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  var toBase64 = function (bytes) {
    var out = "";
    for (var index = 0; index < bytes.length; index += 3) {
      var a = bytes[index], b = bytes[index + 1], c = bytes[index + 2];
      var word = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64.charAt((word >> 18) & 63) + B64.charAt((word >> 12) & 63);
      out += index + 1 < bytes.length ? B64.charAt((word >> 6) & 63) : "=";
      out += index + 2 < bytes.length ? B64.charAt(word & 63) : "=";
    }
    return out;
  };

  // Forgiving-base64 decode (HTML): null when the input is not valid.
  var fromBase64 = function (text) {
    var clean = String(text).replace(/[\t\n\f\r ]/g, "");
    if (clean.length % 4 === 0) clean = clean.replace(/==?$/, "");
    if (clean.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(clean)) return null;
    var bytes = [];
    var held = 0;
    var bits = 0;
    for (var index = 0; index < clean.length; index += 1) {
      held = (held << 6) | B64.indexOf(clean.charAt(index));
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((held >> bits) & 255);
      }
    }
    return new Uint8Array(bytes);
  };

  var encodeUtf8 = function (text) {
    var input = String(text);
    var out = [];
    for (var index = 0; index < input.length; index += 1) {
      var code = input.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
        var next = input.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          index += 1;
        } else {
          code = 0xfffd;
        }
      } else if (code >= 0xd800 && code <= 0xdfff) {
        code = 0xfffd;
      }
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return new Uint8Array(out);
  };

  // UTF-8 decoding per the Encoding standard (each ill-formed sequence one U+FFFD); `fatal`
  // throws on the first one instead.
  var decodeUtf8 = function (view, fatal) {
    var units = [];
    var out = "";
    var index = 0;
    while (index < view.length) {
      var byte = view[index];
      if (byte < 0x80) {
        units.push(byte);
        index += 1;
      } else {
        var need = 0, point = 0, lower = 0x80, upper = 0xbf;
        if (byte >= 0xc2 && byte <= 0xdf) { need = 1; point = byte & 0x1f; }
        else if (byte >= 0xe0 && byte <= 0xef) { need = 2; point = byte & 0xf; if (byte === 0xe0) lower = 0xa0; if (byte === 0xed) upper = 0x9f; }
        else if (byte >= 0xf0 && byte <= 0xf4) { need = 3; point = byte & 0x7; if (byte === 0xf0) lower = 0x90; if (byte === 0xf4) upper = 0x8f; }
        var seen = 0;
        var cursor = index + 1;
        if (need) {
          while (seen < need && cursor < view.length) {
            var next = view[cursor];
            if (next < lower || next > upper) break;
            lower = 0x80;
            upper = 0xbf;
            point = (point << 6) | (next & 0x3f);
            seen += 1;
            cursor += 1;
          }
        }
        if (!need || seen < need) {
          if (fatal) throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The encoded data was not valid for encoding utf-8");
          units.push(0xfffd);
          index = need ? cursor : index + 1;
        } else {
          if (point > 0xffff) {
            point -= 0x10000;
            units.push(0xd800 + (point >> 10), 0xdc00 + (point & 1023));
          } else {
            units.push(point);
          }
          index = cursor;
        }
      }
      if (units.length > 4096) {
        out += String.fromCharCode.apply(null, units);
        units = [];
      }
    }
    return out + String.fromCharCode.apply(null, units);
  };

  var viewBytes = function (value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  };

  // --- the event loop -------------------------------------------------------------------------

  var tasks = [];
  var sequence = 0;
  var timers = new Map();
  var nextTimer = 1;
  var nesting = 0;

  var now = function () { return host.now(); };

  var queueTask = function (run, delay) {
    var task = { due: now() + (delay || 0), order: sequence++, run: run, cancelled: false };
    tasks.push(task);
    return task;
  };

  var nextTask = function () {
    var best = null;
    for (var index = 0; index < tasks.length; index += 1) {
      var task = tasks[index];
      if (task.cancelled) continue;
      if (!best || task.due < best.due || (task.due === best.due && task.order < best.order)) best = task;
    }
    return best;
  };

  var children = new Set();

  var control = {
    // When this worker's next task is due (or a worker it started has one), null when idle.
    due: function () {
      if (dead) return null;
      var due = null;
      if (started) {
        var task = nextTask();
        if (task) due = task.due;
      }
      children.forEach(function (child) {
        var inner = child.due();
        if (inner !== null && (due === null || inner < due)) due = inner;
      });
      return due;
    },
    step: function (until) {
      if (dead) return 0;
      var task = started ? nextTask() : null;
      var child = null;
      var childDue = null;
      children.forEach(function (held) {
        var inner = held.due();
        if (inner !== null && (childDue === null || inner < childDue)) {
          childDue = inner;
          child = held;
        }
      });
      if (child && childDue <= until && (!task || childDue < task.due)) return child.step(until);
      if (!task || task.due > until) return 0;
      tasks.splice(tasks.indexOf(task), 1);
      try {
        task.run();
      } catch (error) {
        reportException(error);
      }
      tasks = tasks.filter(function (held) { return !held.cancelled; });
      return 1;
    },
    pending: function () { return dead ? 0 : tasks.length; },
    post: function (record) {
      if (dead || closing) return;
      queueTask(function () { deliverMessage(record); });
    },
    terminate: function () {
      dead = true;
      closing = true;
      tasks = [];
      timers.clear();
      children.forEach(function (child) { child.terminate(); });
      children.clear();
    },
    started: function () {
      started = true;
    },
  };

  var adoptChild = function (child) { children.add(child); };
  var releaseChild = function (child) { children.delete(child); };

  // --- events ---------------------------------------------------------------------------------

  var eventState = new WeakMap();
  var listeners = new WeakMap();

  var listenersFor = function (target, type) {
    var byType = listeners.get(target);
    if (!byType) {
      byType = new Map();
      listeners.set(target, byType);
    }
    var list = byType.get(type);
    if (!list) {
      list = [];
      byType.set(type, list);
    }
    return list;
  };

  var takeOut = function (list, entry) {
    entry.removed = true;
    var at = list.indexOf(entry);
    if (at !== -1) list.splice(at, 1);
  };

  var handlerValues = new WeakMap();

  var setHandler = function (target, name, value) {
    var own = handlerValues.get(target);
    if (!own) {
      own = {};
      handlerValues.set(target, own);
    }
    own[name] = typeof value === "function" || (value !== null && typeof value === "object") ? value : null;
    var list = listenersFor(target, name.slice(2));
    var held = null;
    list.forEach(function (entry) { if (entry.inline) held = entry; });
    if (!own[name]) {
      if (held) takeOut(list, held);
    } else if (!held) {
      list.push({ inline: true, capture: false, once: false, passive: false, removed: false });
    }
  };

  var getHandler = function (target, name) {
    var own = handlerValues.get(target);
    return own && own[name] ? own[name] : null;
  };

  var makeEvent = function (iface, type, init, trusted) {
    var Interface = globalThis[iface] && typeof globalThis[iface] === "function" ? globalThis[iface] : globalThis.Event;
    var made = Object.create(Interface.prototype);
    var state = {
      type: String(type), bubbles: false, cancelable: false, composed: false, eventPhase: 0,
      isTrusted: Boolean(trusted), timeStamp: now() - startNow, target: null, currentTarget: null,
      srcElement: null, canceled: false, stop: false, stopImmediate: false, passive: false, dispatching: false,
    };
    var defaults = EVENT_DEFAULTS[iface];
    if (defaults) for (var key in defaults) state[key] = defaults[key];
    if (init !== null && init !== undefined && typeof init === "object") {
      for (var given in init) state[given] = init[given];
      state.bubbles = Boolean(state.bubbles);
      state.cancelable = Boolean(state.cancelable);
      state.composed = Boolean(state.composed);
    }
    eventState.set(made, state);
    defineProperty(made, "isTrusted", { get: isTrustedGetter, enumerable: true, configurable: false });
    return made;
  };

  var EVENT_DEFAULTS = {
    MessageEvent: { data: null, origin: "", lastEventId: "", source: null, ports: Object.freeze([]), userActivation: null },
    ErrorEvent: { message: "", filename: "", lineno: 0, colno: 0, error: null },
    CustomEvent: { detail: null },
    ProgressEvent: { lengthComputable: false, loaded: 0, total: 0 },
    PromiseRejectionEvent: { promise: null, reason: undefined },
    CloseEvent: { wasClean: false, code: 0, reason: "" },
    TaskPriorityChangeEvent: { previousPriority: "user-visible" },
  };

  var isTrustedGetter = null;

  var dispatch = function (target, event) {
    var state = eventState.get(event);
    if (!state) throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
    if (state.dispatching) throw makeException("Failed to execute 'dispatchEvent' on 'EventTarget': The event is already being dispatched.", "InvalidStateError");
    state.dispatching = true;
    state.target = target;
    state.srcElement = target;
    state.currentTarget = target;
    state.eventPhase = 2;
    var list = listeners.get(target);
    list = list ? list.get(state.type) : null;
    if (list && list.length) {
      var snapshot = list.slice();
      for (var index = 0; index < snapshot.length && !state.stopImmediate; index += 1) {
        var entry = snapshot[index];
        if (entry.removed) continue;
        if (entry.once) takeOut(list, entry);
        state.passive = entry.passive;
        try {
          if (entry.inline) {
            var handler = getHandler(target, "on" + state.type);
            if (typeof handler === "function") {
              var errorForm = state.type === "error" && target === globalThis && event instanceof globalThis.ErrorEvent;
              var returned = errorForm ? handler.call(target, state.message, state.filename, state.lineno, state.colno, state.error) : handler.call(target, event);
              if (errorForm ? returned === true : returned === false) {
                if (state.cancelable) state.canceled = true;
              }
            }
          } else if (typeof entry.callback === "function") {
            entry.callback.call(target, event);
          } else {
            entry.callback.handleEvent(event);
          }
        } catch (error) {
          state.passive = false;
          if (!(state.type === "error" && target === globalThis)) reportException(error);
        }
        state.passive = false;
      }
    }
    state.eventPhase = 0;
    state.currentTarget = null;
    state.dispatching = false;
    state.stopImmediate = false;
    return !state.canceled;
  };

  // HTML's "report an exception" in a worker: an ErrorEvent at the worker's global first; if no
  // one cancels it there, at the Worker object in the realm that owns it.
  var locate = function (error) {
    var stack = "";
    try {
      stack = String(error && error.stack || "");
    } catch (ignored) {}
    var lines = stack.split("\n");
    for (var index = 1; index < lines.length; index += 1) {
      var match = /\(?((?:blob|data|https?):[^\s()]*?):(\d+):(\d+)\)?\s*$/.exec(lines[index]);
      if (match) return { filename: match[1], lineno: Number(match[2]), colno: Number(match[3]) };
    }
    return { filename: scriptUrl, lineno: 0, colno: 0 };
  };

  var messageOf = function (error) {
    try {
      if (error !== null && typeof error === "object" && "message" in error && "name" in error) return "Uncaught " + String(error.name) + ": " + String(error.message);
      return "Uncaught " + String(error);
    } catch (ignored) {
      return "Uncaught exception";
    }
  };

  var reportException = function (error, where) {
    if (dead) return;
    var place = where || locate(error);
    var message = messageOf(error);
    var event = makeEvent("ErrorEvent", "error", { message: message, filename: place.filename, lineno: place.lineno, colno: place.colno, error: error, cancelable: true }, true);
    if (!dispatch(globalThis, event)) return;
    if (owner && !closing) owner.error({ message: message, filename: place.filename, lineno: place.lineno, colno: place.colno });
  };


  var makeException = function (message, name) {
    var made = new globalThis.DOMException(message, name);
    var trace = new Error(message);
    var held = { value: String(trace.stack).replace(/^Error/, name) };
    defineProperty(made, "stack", {
      get: native("get", "stack", 0, function () { return held.value; }),
      set: native("set", "stack", 1, function (self, args) { held.value = args[0]; }),
      enumerable: false,
      configurable: true,
    });
    return made;
  };

  // --- messaging ------------------------------------------------------------------------------

  var deliverMessage = function (record) {
    var opened;
    try {
      opened = channels.deserialize(record);
    } catch (error) {
      dispatch(globalThis, makeEvent("MessageEvent", "messageerror", {}, true));
      return;
    }
    dispatch(globalThis, makeEvent("MessageEvent", "message", { data: opened.value, ports: Object.freeze(opened.ports) }, true));
  };

  var transferOf = function (second, where) {
    if (second === undefined || second === null) return undefined;
    if (typeof second === "object" && typeof second[Symbol.iterator] === "function") return second;
    if (typeof second === "object" || typeof second === "function") return second.transfer;
    throw new TypeError("Failed to execute 'postMessage' on '" + where + "': The provided value cannot be converted to a sequence.");
  };

  var required = function (count, given, method, where) {
    if (given < count) throw new TypeError("Failed to execute '" + method + "' on '" + where + "': " + count + " argument" + (count === 1 ? "" : "s") + " required, but only " + given + " present.");
  };

  // --- per-object state -----------------------------------------------------------------------

  var blobs = new WeakMap();
  var objectUrls = new Map();

  var makeBlob = function (bytes, type, file) {
    var made = Object.create((file ? globalThis.File : globalThis.Blob).prototype);
    var text = type === undefined ? "" : String(type);
    var state = { bytes: bytes, type: /^[\x20-\x7e]*$/.test(text) ? text.toLowerCase() : "" };
    if (file) {
      state.name = String(file.name);
      state.lastModified = file.lastModified;
    }
    blobs.set(made, state);
    return made;
  };

  var blobOf = function (value) {
    var state = blobs.get(value);
    if (!state) illegal();
    return state;
  };

  var readParts = function (parts, options, where) {
    if (parts !== undefined && (parts === null || typeof parts[Symbol.iterator] !== "function")) {
      throw new TypeError("Failed to construct '" + where + "': The object must have a callable @@iterator property.");
    }
    var type = options && options.type !== undefined ? options.type : "";
    var endings = options && options.endings !== undefined ? String(options.endings) : "transparent";
    var chunks = [];
    var size = 0;
    if (parts !== undefined) {
      for (var part of parts) {
        var bytes = blobs.has(part) ? blobs.get(part).bytes : viewBytes(part);
        if (!bytes) bytes = encodeUtf8(endings === "native" ? String(part).replace(/\r\n|\r/g, "\n") : part);
        chunks.push(bytes.slice());
        size += bytes.length;
      }
    }
    var out = new Uint8Array(size);
    var at = 0;
    chunks.forEach(function (chunk) { out.set(chunk, at); at += chunk.length; });
    return { bytes: out, type: type };
  };

  var parseUrl = function (input, base) {
    return host.url(String(input), base === undefined ? null : String(base));
  };

  var urlState = new WeakMap();
  var navigatorObject = null;
  var locationObject = null;
  var performanceObject = null;
  var cryptoObject = null;
  var subtleObject = null;
  var schedulerObject = null;
  var storageObject = null;
  var uaDataObject = null;
  var namedObjects = Object.create(null);

  var instanceOf = function (iface) {
    var Interface = globalThis[iface];
    return Object.create(Interface && Interface.prototype ? Interface.prototype : Object.prototype);
  };

  var later = function (work) {
    return new Promise(function (resolve, reject) {
      queueTask(function () {
        try {
          resolve(work());
        } catch (error) {
          reject(error);
        }
      });
    });
  };

  // --- fetch ----------------------------------------------------------------------------------

  var decodeDataUrl = function (href) {
    var match = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(href);
    if (!match) return null;
    var type = match[1] || "text/plain;charset=US-ASCII";
    if (match[2]) {
      var decoded = fromBase64(decodeURIComponent(match[3]));
      return decoded ? { type: type, bytes: decoded } : null;
    }
    var raw = match[3];
    var bytes = [];
    for (var index = 0; index < raw.length; index += 1) {
      if (raw.charAt(index) === "%" && /^[0-9A-Fa-f]{2}$/.test(raw.substr(index + 1, 2))) {
        bytes.push(parseInt(raw.substr(index + 1, 2), 16));
        index += 2;
      } else {
        var piece = encodeUtf8(raw.charAt(index));
        for (var at = 0; at < piece.length; at += 1) bytes.push(piece[at]);
      }
    }
    return { type: type, bytes: new Uint8Array(bytes) };
  };

  // Loads a script or resource synchronously (the host's transport, a data: URL, or a blob URL this
  // worker made): { status, type, bytes, headers } or null for a network error.
  var load = function (href) {
    var parsed = parseUrl(href, location().href);
    if (!parsed) return null;
    if (parsed.protocol === "data:") {
      var data = decodeDataUrl(parsed.href);
      return data ? { status: 200, type: data.type, bytes: data.bytes, headers: [["content-type", data.type]], url: parsed.href } : null;
    }
    if (parsed.protocol === "blob:") {
      var blob = objectUrls.get(parsed.href);
      if (!blob) return null;
      var state = blobs.get(blob);
      return { status: 200, type: state.type, bytes: state.bytes.slice(), headers: [["content-type", state.type], ["content-length", String(state.bytes.length)]], url: parsed.href };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    var answer = host.send({ method: "GET", url: parsed.href, headers: {}, body: null, bodyBytes: null });
    if (!answer || !answer.status) return null;
    return { status: answer.status, type: "", bytes: encodeUtf8(answer.body || ""), headers: answer.headers || [], url: parsed.href };
  };

  var responseState = new WeakMap();

  var makeHeaders = function (pairs) {
    var made = instanceOf("Headers");
    headerState.set(made, (pairs || []).map(function (pair) { return [String(pair[0]).toLowerCase(), String(pair[1])]; }));
    return made;
  };

  var headerState = new WeakMap();

  var makeResponse = function (loaded) {
    var made = instanceOf("Response");
    responseState.set(made, { status: loaded.status, statusText: loaded.status === 200 ? "OK" : "", url: loaded.url, bytes: loaded.bytes, used: false, headers: makeHeaders(loaded.headers), type: loaded.url.indexOf("data:") === 0 ? "basic" : "basic" });
    return made;
  };

  var consume = function (self, method, convert) {
    var state = responseState.get(self);
    if (!state) illegal();
    if (state.used) return Promise.reject(new TypeError("Failed to execute '" + method + "' on 'Response': body stream already read"));
    state.used = true;
    var bytes = state.bytes;
    return later(function () { return convert(bytes); });
  };

  // --- the global surface --------------------------------------------------------------------

  var location = function () { return facts.location; };

  var timer = function (label, callback, delay, extra, repeat) {
    var id = nextTimer++;
    var level = nesting + 1;
    var wait = Number(delay);
    wait = isFinite(wait) && wait > 0 ? wait : 0;
    if (level >= 5 && wait < 4) wait = 4;
    var entry = { callback: callback, extra: extra, every: repeat ? Number(delay) : undefined, nesting: level, task: null };
    var arm = function (ms) {
      entry.task = queueTask(function fire() {
        if (!timers.has(id)) return;
        if (entry.every !== undefined) {
          entry.nesting += 1;
          var next = isFinite(entry.every) && entry.every > 0 ? entry.every : 0;
          if (entry.nesting >= 5 && next < 4) next = 4;
          arm(next);
        } else {
          timers.delete(id);
        }
        var outer = nesting;
        nesting = entry.nesting;
        try {
          if (typeof entry.callback === "function") apply(entry.callback, globalThis, entry.extra);
          else (0, eval)(String(entry.callback));
        } finally {
          nesting = outer;
        }
      }, ms);
    };
    timers.set(id, entry);
    arm(wait);
    return id;
  };

  var clearTimer = function (id) {
    var entry = timers.get(Number(id));
    if (!entry) return;
    timers.delete(Number(id));
    if (entry.task) entry.task.cancelled = true;
  };

  var behaviours = Object.create(null);
  var constructors = Object.create(null);

  var B = function (key, impl) { behaviours[key] = impl; };

  // Global functions and accessors (DedicatedWorkerGlobalScope and WorkerGlobalScope members).
  B("global.postMessage", function (self, args) {
    required(1, args.length, "postMessage", "DedicatedWorkerGlobalScope");
    var record = channels.serialize(args[0], transferOf(args[1], "DedicatedWorkerGlobalScope"), "DedicatedWorkerGlobalScope", "postMessage");
    if (closing || dead) return;
    owner.message(record);
  });
  B("global.close", function () {
    if (closing) return;
    closing = true;
    tasks = [];
    timers.clear();
    owner.closed();
  });
  B("global.requestAnimationFrame", function (self, args) {
    var callback = args[0];
    if (typeof callback !== "function") throw new TypeError("Failed to execute 'requestAnimationFrame' on 'DedicatedWorkerGlobalScope': The callback provided as parameter 1 is not a function.");
    return timer("raf", function () { callback(Math.round((now() - startNow) * 1000) / 1000); }, 16, [], false);
  });
  B("global.cancelAnimationFrame", function (self, args) { clearTimer(args[0]); });
  B("global.get name", function () { return facts.name; });
  B("global.set name", function (self, args) { facts.name = String(args[0]); });
  B("WorkerGlobalScope.get self", function () { return globalThis; });
  B("WorkerGlobalScope.get location", function () { return locationObject; });
  B("WorkerGlobalScope.get navigator", function () { return navigatorObject; });
  B("WorkerGlobalScope.get origin", function () { return facts.origin; });
  B("WorkerGlobalScope.get performance", function () { return performanceObject; });
  B("WorkerGlobalScope.get crypto", function () { return cryptoObject; });
  B("WorkerGlobalScope.get isSecureContext", function () { return facts.secure; });
  B("WorkerGlobalScope.get crossOriginIsolated", function () { return false; });
  B("WorkerGlobalScope.get scheduler", function () { return schedulerObject; });
  ["indexedDB", "caches", "fonts", "trustedTypes"].forEach(function (name) {
    B("WorkerGlobalScope.get " + name, function () { return namedObjects[name] || null; });
  });
  B("WorkerGlobalScope.setTimeout", function (self, args) { return timer("setTimeout", args[0], args[1], Array.prototype.slice.call(args, 2), false); });
  B("WorkerGlobalScope.setInterval", function (self, args) { return timer("setInterval", args[0], args[1], Array.prototype.slice.call(args, 2), true); });
  B("WorkerGlobalScope.clearTimeout", function (self, args) { clearTimer(args[0]); });
  B("WorkerGlobalScope.clearInterval", function (self, args) { clearTimer(args[0]); });
  B("WorkerGlobalScope.queueMicrotask", function (self, args) {
    var callback = args[0];
    if (typeof callback !== "function") throw new TypeError("Failed to execute 'queueMicrotask' on 'WorkerGlobalScope': The callback provided as parameter 1 is not a function.");
    Promise.resolve().then(function () {
      try {
        callback();
      } catch (error) {
        reportException(error);
      }
    });
  });
  B("WorkerGlobalScope.structuredClone", function (self, args) {
    required(1, args.length, "structuredClone", "WorkerGlobalScope");
    var options = args[1];
    return channels.clone(args[0], options === undefined || options === null ? undefined : options.transfer, "WorkerGlobalScope");
  });
  B("WorkerGlobalScope.reportError", function (self, args) {
    required(1, args.length, "reportError", "WorkerGlobalScope");
    reportException(args[0]);
  });
  B("WorkerGlobalScope.btoa", function (self, args) {
    required(1, args.length, "btoa", "WorkerGlobalScope");
    var text = String(args[0]);
    var bytes = [];
    for (var index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);
      if (code > 255) throw makeException("Failed to execute 'btoa' on 'WorkerGlobalScope': The string to be encoded contains characters outside of the Latin1 range.", "InvalidCharacterError");
      bytes.push(code);
    }
    return toBase64(bytes);
  });
  B("WorkerGlobalScope.atob", function (self, args) {
    required(1, args.length, "atob", "WorkerGlobalScope");
    var bytes = fromBase64(args[0]);
    if (!bytes) throw makeException("Failed to execute 'atob' on 'WorkerGlobalScope': The string to be decoded is not correctly encoded.", "InvalidCharacterError");
    var out = "";
    for (var index = 0; index < bytes.length; index += 1) out += String.fromCharCode(bytes[index]);
    return out;
  });
  B("WorkerGlobalScope.importScripts", function (self, args) {
    for (var index = 0; index < args.length; index += 1) {
      var parsed = parseUrl(args[index], location().href);
      if (!parsed) throw makeException("Failed to execute 'importScripts' on 'WorkerGlobalScope': The URL '" + String(args[index]) + "' is invalid.", "SyntaxError");
      var loaded = load(parsed.href);
      if (!loaded || loaded.status < 200 || loaded.status > 299) {
        throw makeException("Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '" + parsed.href + "' failed to load.", "NetworkError");
      }
      (0, eval)(decodeUtf8(loaded.bytes) + "\n//# sourceURL=" + parsed.href);
    }
  });
  B("WorkerGlobalScope.fetch", function (self, args) {
    required(1, args.length, "fetch", "WorkerGlobalScope");
    var input = args[0];
    var href = urlState.has(input) ? urlState.get(input).href : String(input);
    var parsed = parseUrl(href, location().href);
    if (!parsed) return Promise.reject(new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Failed to parse URL from " + href));
    return new Promise(function (resolve, reject) {
      queueTask(function () {
        var loaded = load(parsed.href);
        if (!loaded) reject(new TypeError("Failed to fetch"));
        else resolve(makeResponse(loaded));
      });
    });
  });
  B("WorkerGlobalScope.createImageBitmap", function () {
    return Promise.reject(makeException("The source image could not be decoded.", "InvalidStateError"));
  });

  // EventTarget, Event and its kinds.
  constructors.EventTarget = function () { return instanceOf("EventTarget"); };
  B("EventTarget.addEventListener", function (self, args) {
    required(2, args.length, "addEventListener", "EventTarget");
    var callback = args[1];
    if (callback === null || callback === undefined) return;
    if (typeof callback !== "function" && typeof callback !== "object") throw new TypeError("Failed to execute 'addEventListener' on 'EventTarget': parameter 2 is not of type 'Object'.");
    var options = args[2];
    var detailed = options !== null && typeof options === "object";
    var capture = typeof options === "boolean" ? options : Boolean(detailed && options.capture);
    var list = listenersFor(self === undefined ? globalThis : self, String(args[0]));
    for (var index = 0; index < list.length; index += 1) {
      if (!list[index].inline && list[index].callback === callback && list[index].capture === capture) return;
    }
    var entry = { callback: callback, capture: capture, once: detailed && Boolean(options.once), passive: detailed && Boolean(options.passive), removed: false };
    var signal = detailed ? options.signal : undefined;
    var signalHeld = signal && abortState.get(signal);
    if (signalHeld && signalHeld.aborted) return;
    list.push(entry);
    if (signalHeld) signalHeld.algorithms.push(function () { takeOut(list, entry); });
  });
  B("EventTarget.removeEventListener", function (self, args) {
    var options = args[2];
    var capture = typeof options === "boolean" ? options : Boolean(options && options.capture);
    var list = listenersFor(self === undefined ? globalThis : self, String(args[0]));
    for (var index = 0; index < list.length; index += 1) {
      if (!list[index].inline && list[index].callback === args[1] && list[index].capture === capture) {
        takeOut(list, list[index]);
        return;
      }
    }
  });
  B("EventTarget.dispatchEvent", function (self, args) {
    required(1, args.length, "dispatchEvent", "EventTarget");
    return dispatch(self === undefined ? globalThis : self, args[0]);
  });

  var eventOf = function (self) {
    var state = eventState.get(self);
    if (!state) illegal();
    return state;
  };

  B("Event.preventDefault", function (self) { var s = eventOf(self); if (s.cancelable && !s.passive) s.canceled = true; });
  B("Event.stopPropagation", function (self) { eventOf(self).stop = true; });
  B("Event.stopImmediatePropagation", function (self) { var s = eventOf(self); s.stop = true; s.stopImmediate = true; });
  B("Event.composedPath", function (self) { var s = eventOf(self); return s.dispatching ? [s.currentTarget] : []; });
  B("Event.initEvent", function (self, args) { var s = eventOf(self); if (s.dispatching) return; s.type = String(args[0]); s.bubbles = Boolean(args[1]); s.cancelable = Boolean(args[2]); });
  B("Event.get defaultPrevented", function (self) { return eventOf(self).canceled; });
  B("Event.get returnValue", function (self) { return !eventOf(self).canceled; });
  B("Event.set returnValue", function (self, args) { var s = eventOf(self); if (!args[0] && s.cancelable) s.canceled = true; });
  B("Event.get cancelBubble", function (self) { return eventOf(self).stop; });
  B("Event.set cancelBubble", function (self, args) { if (args[0]) eventOf(self).stop = true; });

  var EVENT_INTERFACES = ["Event", "MessageEvent", "ErrorEvent", "CustomEvent", "ProgressEvent", "PromiseRejectionEvent", "CloseEvent", "TaskPriorityChangeEvent", "SecurityPolicyViolationEvent"];
  EVENT_INTERFACES.forEach(function (iface) {
    constructors[iface] = function (args) {
      if (args.length < 1) throw new TypeError("Failed to construct '" + iface + "': 1 argument required, but only 0 present.");
      return makeEvent(iface, args[0], args[1], false);
    };
  });

  // DOMException.
  var exceptions = new WeakMap();
  var DOM_CODES = { IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5, NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10, InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14, InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20, URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25 };
  constructors.DOMException = function (args, target) {
    var made = Object.create(target.prototype);
    var name = args[1] === undefined ? "Error" : String(args[1]);
    exceptions.set(made, { message: args[0] === undefined ? "" : String(args[0]), name: name, code: DOM_CODES[name] || 0 });
    return made;
  };
  ["message", "name", "code"].forEach(function (field) {
    B("DOMException.get " + field, function (self) {
      var state = exceptions.get(self);
      if (!state) illegal();
      return state[field];
    });
  });

  // AbortController and AbortSignal.
  var abortState = new WeakMap();
  var controllerSignals = new WeakMap();
  var makeSignal = function (proto) {
    var signal = Object.create(proto || globalThis.AbortSignal.prototype);
    abortState.set(signal, { aborted: false, reason: undefined, algorithms: [] });
    return signal;
  };
  var abort = function (signal, reason) {
    var state = abortState.get(signal);
    if (!state || state.aborted) return;
    state.aborted = true;
    state.reason = reason === undefined ? makeException("signal is aborted without reason", "AbortError") : reason;
    var waiting = state.algorithms;
    state.algorithms = [];
    waiting.forEach(function (run) { run(); });
    dispatch(signal, makeEvent("Event", "abort", {}, true));
  };
  var signalOf = function (self) {
    var state = abortState.get(self);
    if (!state) illegal();
    return state;
  };
  constructors.AbortController = function (args, target) {
    var made = Object.create(target.prototype);
    controllerSignals.set(made, makeSignal());
    return made;
  };
  B("AbortController.get signal", function (self) {
    var signal = controllerSignals.get(self);
    if (!signal) illegal();
    return signal;
  });
  B("AbortController.abort", function (self, args) {
    var signal = controllerSignals.get(self);
    if (!signal) illegal();
    abort(signal, args[0]);
  });
  B("AbortSignal.get aborted", function (self) { return signalOf(self).aborted; });
  B("AbortSignal.get reason", function (self) { return signalOf(self).reason; });
  B("AbortSignal.throwIfAborted", function (self) { var s = signalOf(self); if (s.aborted) throw s.reason; });
  B("AbortSignal.static abort", function (self, args) { var signal = makeSignal(); abort(signal, args[0]); return signal; });
  B("AbortSignal.static timeout", function (self, args) {
    var signal = makeSignal();
    queueTask(function () { abort(signal, makeException("signal timed out", "TimeoutError")); }, Math.max(0, Number(args[0]) || 0));
    return signal;
  });
  B("AbortSignal.static any", function (self, args) {
    var signal = makeSignal();
    var list = Array.from(args[0] || []);
    for (var index = 0; index < list.length; index += 1) {
      if (signalOf(list[index]).aborted) {
        abort(signal, signalOf(list[index]).reason);
        return signal;
      }
    }
    list.forEach(function (input) { signalOf(input).algorithms.push(function () { abort(signal, signalOf(input).reason); }); });
    return signal;
  });

  // The scheduler (scheduler.postTask/yield, TaskController, TaskSignal).
  var PRIORITIES = ["user-blocking", "user-visible", "background"];
  var RANK = { "user-blocking-continuation": 0, "user-blocking": 1, "user-visible-continuation": 2, "user-visible": 3, "background-continuation": 4, "background": 5 };
  var taskQueue = [];
  var idleRunners = 0;
  var taskSignals = new WeakMap();
  var runOne = function () {
    if (idleRunners > 0) {
      idleRunners -= 1;
      return;
    }
    if (!taskQueue.length) return;
    var best = 0;
    for (var index = 1; index < taskQueue.length; index += 1) {
      var a = taskQueue[index], b = taskQueue[best];
      if (RANK[a.rank()] < RANK[b.rank()] || (RANK[a.rank()] === RANK[b.rank()] && a.order < b.order)) best = index;
    }
    taskQueue.splice(best, 1)[0].run();
  };
  var enqueueTask = function (task, delay) {
    var go = function () {
      if (task.cancelled) return;
      task.order = sequence++;
      taskQueue.push(task);
      queueTask(runOne);
    };
    if (delay > 0) queueTask(go, delay);
    else go();
  };
  B("Scheduler.postTask", function (self, args) {
    var callback = args[0];
    var opts = args[1] === undefined || args[1] === null ? {} : args[1];
    return new Promise(function (resolve, reject) {
      if (typeof callback !== "function") {
        reject(new TypeError("Failed to execute 'postTask' on 'Scheduler': parameter 1 is not of type 'Function'."));
        return;
      }
      var fixed = opts.priority === undefined ? null : String(opts.priority);
      if (fixed !== null && PRIORITIES.indexOf(fixed) === -1) {
        reject(new TypeError("Failed to execute 'postTask' on 'Scheduler': Failed to read the 'priority' property from 'SchedulerPostTaskOptions': The provided value '" + fixed + "' is not a valid enum value of type TaskPriority."));
        return;
      }
      var signal = opts.signal;
      var held = signal && abortState.get(signal);
      if (held && held.aborted) {
        reject(held.reason);
        return;
      }
      var task = {
        cancelled: false,
        rank: function () { return fixed || (signal && taskSignals.has(signal) ? taskSignals.get(signal).priority : "user-visible"); },
        run: function () {
          if (task.cancelled) return;
          task.cancelled = true;
          try {
            resolve(callback.call(undefined));
          } catch (error) {
            reject(error);
          }
        },
      };
      if (held) {
        held.algorithms.push(function () {
          if (task.cancelled) return;
          task.cancelled = true;
          var at = taskQueue.indexOf(task);
          if (at !== -1) {
            taskQueue.splice(at, 1);
            idleRunners += 1;
          }
          reject(held.reason);
        });
      }
      enqueueTask(task, Math.max(0, Number(opts.delay) || 0));
    });
  });
  B("Scheduler.yield", function () {
    return new Promise(function (resolve) {
      enqueueTask({ cancelled: false, rank: function () { return "user-visible-continuation"; }, run: function () { resolve(undefined); } }, 0);
    });
  });
  constructors.TaskController = function (args, target) {
    var init = args[0];
    var priority = init === undefined || init === null || init.priority === undefined ? "user-visible" : String(init.priority);
    if (PRIORITIES.indexOf(priority) === -1) throw new TypeError("Failed to construct 'TaskController': Failed to read the 'priority' property from 'TaskControllerInit': The provided value '" + priority + "' is not a valid enum value of type TaskPriority.");
    var made = Object.create(target.prototype);
    var signal = makeSignal(globalThis.TaskSignal.prototype);
    taskSignals.set(signal, { priority: priority, changing: false });
    controllerSignals.set(made, signal);
    return made;
  };
  B("TaskController.setPriority", function (self, args) {
    var signal = controllerSignals.get(self);
    var held = signal && taskSignals.get(signal);
    if (!held) illegal();
    var next = String(args[0]);
    if (PRIORITIES.indexOf(next) === -1) throw new TypeError("Failed to execute 'setPriority' on 'TaskController': The provided value '" + next + "' is not a valid enum value of type TaskPriority.");
    if (held.priority === next) return;
    var previous = held.priority;
    held.priority = next;
    dispatch(signal, makeEvent("TaskPriorityChangeEvent", "prioritychange", { previousPriority: previous }, true));
  });
  B("TaskSignal.get priority", function (self) {
    var held = taskSignals.get(self);
    if (!held) illegal();
    return held.priority;
  });

  // Messaging interfaces.
  var channelPorts = new WeakMap();
  constructors.MessageChannel = function (args, target) {
    var made = Object.create(target.prototype);
    channelPorts.set(made, channels.channel());
    return made;
  };
  B("MessageChannel.get port1", function (self) { var pair = channelPorts.get(self); if (!pair) illegal(); return pair[0]; });
  B("MessageChannel.get port2", function (self) { var pair = channelPorts.get(self); if (!pair) illegal(); return pair[1]; });
  B("MessagePort.postMessage", function (self, args) {
    if (!channels.isPort(self)) illegal();
    required(1, args.length, "postMessage", "MessagePort");
    channels.portPost(self, args[0], transferOf(args[1], "MessagePort"));
  });
  B("MessagePort.start", function (self) { if (!channels.isPort(self)) illegal(); channels.portStart(self); });
  B("MessagePort.close", function (self) { if (!channels.isPort(self)) illegal(); channels.portClose(self); });
  B("MessagePort.set onmessage", function (self, args) {
    setHandler(self, "onmessage", args[0]);
    if (getHandler(self, "onmessage")) channels.portStart(self);
  });
  constructors.BroadcastChannel = function (args, target) {
    if (args.length < 1) throw new TypeError("Failed to construct 'BroadcastChannel': 1 argument required, but only 0 present.");
    var made = Object.create(target.prototype);
    channels.openBroadcast(made, args[0]);
    return made;
  };
  B("BroadcastChannel.get name", function (self) { var entry = channels.broadcastState(self); if (!entry) illegal(); return entry.name; });
  B("BroadcastChannel.postMessage", function (self, args) {
    if (!channels.broadcastState(self)) illegal();
    required(1, args.length, "postMessage", "BroadcastChannel");
    channels.broadcastPost(self, args[0]);
  });
  B("BroadcastChannel.close", function (self) { if (!channels.broadcastState(self)) illegal(); channels.broadcastClose(self); });

  // Nested dedicated workers.
  var workerState = new WeakMap();
  constructors.Worker = function (args, target) {
    if (args.length < 1) throw new TypeError("Failed to construct 'Worker': 1 argument required, but only 0 present.");
    var parsed = parseUrl(args[0], location().href);
    if (!parsed) throw makeException("Failed to construct 'Worker': '" + String(args[0]) + "' is not a valid URL.", "SyntaxError");
    var sameOrigin = parsed.protocol === "data:" || (parsed.protocol === "blob:" ? objectUrls.has(parsed.href) || parsed.origin === facts.origin : parsed.origin === facts.origin);
    if (!sameOrigin) throw makeException("Failed to construct 'Worker': Script at '" + parsed.href + "' cannot be accessed from origin '" + facts.origin + "'.", "SecurityError");
    var made = Object.create(target.prototype);
    var options = args[1] || {};
    var loaded = load(parsed.href);
    var state = { control: null, pending: [], dead: false };
    workerState.set(made, state);
    if (!loaded || loaded.status < 200 || loaded.status > 299) {
      queueTask(function () { if (!state.dead) dispatch(made, makeEvent("Event", "error", {}, true)); });
      return made;
    }
    var childFacts = {};
    for (var key in facts) childFacts[key] = facts[key];
    childFacts.originTime = Date.now();
    childFacts.name = options.name === undefined ? "" : String(options.name);
    childFacts.url = parsed.href;
    childFacts.origin = parsed.protocol === "data:" ? "null" : facts.origin;
    shared.workers.push({
      id: shared.nextWorker = (shared.nextWorker || 0) + 1,
      ready: true,
      cancelled: false,
      url: parsed.href,
      source: decodeUtf8(loaded.bytes),
      bind: function (slot, kit) {
        if (state.dead) return null;
        state.control = slot.bind(childFacts, kit, {
          message: function (record) {
            queueTask(function () {
              if (state.dead) return;
              var opened = channels.deserialize(record);
              dispatch(made, makeEvent("MessageEvent", "message", { data: opened.value, ports: Object.freeze(opened.ports) }, true));
            });
          },
          error: function (info) {
            queueTask(function () {
              if (state.dead) return;
              dispatch(made, makeEvent("ErrorEvent", "error", { message: info.message, filename: info.filename, lineno: info.lineno, colno: info.colno, error: null, cancelable: true }, true));
            });
          },
          closed: function () { state.dead = true; },
        });
        adoptChild(state.control);
        return state.control;
      },
      started: function () {
        if (!state.control) return;
        state.control.started();
        state.pending.forEach(function (record) { state.control.post(record); });
        state.pending = [];
      },
    });
    return made;
  };
  B("Worker.postMessage", function (self, args) {
    var state = workerState.get(self);
    if (!state) illegal();
    required(1, args.length, "postMessage", "Worker");
    var record = channels.serialize(args[0], transferOf(args[1], "Worker"), "Worker", "postMessage");
    if (state.dead) return;
    if (state.control) state.control.post(record);
    else state.pending.push(record);
  });
  B("Worker.terminate", function (self) {
    var state = workerState.get(self);
    if (!state) illegal();
    state.dead = true;
    if (state.control) {
      state.control.terminate();
      releaseChild(state.control);
    }
  });

  // Navigator, location, performance, crypto, storage.
  ["hardwareConcurrency", "appCodeName", "appName", "appVersion", "platform", "product", "userAgent", "language", "onLine", "deviceMemory"].forEach(function (field) {
    B("WorkerNavigator.get " + field, function () { return facts.navigator[field]; });
  });
  var languages = null;
  B("WorkerNavigator.get languages", function () {
    if (!languages) languages = Object.freeze(facts.navigator.languages.slice());
    return languages;
  });
  B("WorkerNavigator.get userAgentData", function () { return uaDataObject; });
  B("WorkerNavigator.get storage", function () { return storageObject; });
  ["connection", "hid", "mediaCapabilities", "permissions", "serial", "usb", "locks", "gpu", "storageBuckets"].forEach(function (field) {
    var iface = { connection: "NetworkInformation", hid: "HID", mediaCapabilities: "MediaCapabilities", permissions: "Permissions", serial: "Serial", usb: "USB", locks: "LockManager", gpu: "GPU", storageBuckets: "StorageBucketManager" }[field];
    var held = null;
    B("WorkerNavigator.get " + field, function () {
      if (!held) held = instanceOf(iface);
      return held;
    });
  });
  var brands = null;
  B("NavigatorUAData.get brands", function () {
    if (!brands) brands = Object.freeze(facts.uaData.brands.map(function (item) { return { brand: item.brand, version: item.version }; }));
    return brands;
  });
  B("NavigatorUAData.get mobile", function () { return facts.uaData.mobile; });
  B("NavigatorUAData.get platform", function () { return facts.uaData.platform; });
  B("NavigatorUAData.toJSON", function () {
    return { brands: facts.uaData.brands.map(function (item) { return { brand: item.brand, version: item.version }; }), mobile: facts.uaData.mobile, platform: facts.uaData.platform };
  });
  B("NavigatorUAData.getHighEntropyValues", function (self, args) {
    var hints = Array.from(args[0] || []);
    return later(function () {
      var out = { brands: facts.uaData.brands.map(function (item) { return { brand: item.brand, version: item.version }; }), mobile: facts.uaData.mobile, platform: facts.uaData.platform };
      var known = facts.uaData.highEntropy || {};
      hints.forEach(function (hint) {
        if (hasOwn.call(known, hint)) out[hint] = JSON.parse(JSON.stringify(known[hint]));
      });
      return out;
    });
  });

  ["origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash", "href"].forEach(function (field) {
    B("WorkerLocation.get " + field, function () { return facts.location[field]; });
  });
  B("WorkerLocation.toString", function () { return facts.location.href; });

  B("Performance.now", function () { return Math.round((now() - startNow) * 10) / 10; });
  B("Performance.get timeOrigin", function () { return facts.timeOrigin; });
  B("Performance.toJSON", function () { return { timeOrigin: facts.timeOrigin }; });
  ["getEntries", "getEntriesByType", "getEntriesByName"].forEach(function (name) { B("Performance." + name, function () { return []; }); });

  B("Crypto.getRandomValues", function (self, args) {
    var view = args[0];
    var kinds = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array"];
    var tag = ArrayBuffer.isView(view) ? Object.prototype.toString.call(view).slice(8, -1) : "";
    if (kinds.indexOf(tag) === -1) throw makeException("Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type '" + (tag || typeof view) + "', which is not an integer array type.", "TypeMismatchError");
    if (view.byteLength > 65536) throw makeException("Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (" + view.byteLength + ") exceeds the number of bytes of entropy available via this API (65536).", "QuotaExceededError");
    var bytes = fromBase64(host.entropy(view.byteLength));
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
    return view;
  });
  B("Crypto.randomUUID", function () { return host.uuid(); });
  B("Crypto.get subtle", function () { return subtleObject; });
  B("SubtleCrypto.digest", function (self, args) {
    var algorithm = typeof args[0] === "string" ? args[0] : args[0] && args[0].name;
    var bytes = viewBytes(args[1]);
    return new Promise(function (resolve, reject) {
      queueTask(function () {
        if (!bytes) {
          reject(new TypeError("Failed to execute 'digest' on 'SubtleCrypto': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'."));
          return;
        }
        var out = host.digest(String(algorithm), toBase64(bytes));
        if (out === null) {
          reject(makeException("Unrecognized name.", "NotSupportedError"));
          return;
        }
        resolve(fromBase64(out).buffer);
      });
    });
  });

  // TextEncoder and TextDecoder (UTF-8).
  constructors.TextEncoder = function (args, target) { return Object.create(target.prototype); };
  B("TextEncoder.get encoding", function () { return "utf-8"; });
  B("TextEncoder.encode", function (self, args) { return encodeUtf8(args[0] === undefined ? "" : args[0]); });
  B("TextEncoder.encodeInto", function (self, args) {
    var source = String(args[0]);
    var target = args[1];
    var read = 0, written = 0;
    for (var index = 0; index < source.length; index += 1) {
      var code = source.charCodeAt(index);
      var pair = code >= 0xd800 && code <= 0xdbff && index + 1 < source.length && source.charCodeAt(index + 1) >= 0xdc00 && source.charCodeAt(index + 1) <= 0xdfff;
      var piece = encodeUtf8(pair ? source.substr(index, 2) : source.charAt(index));
      if (written + piece.length > target.length) break;
      target.set(piece, written);
      written += piece.length;
      read += pair ? 2 : 1;
      if (pair) index += 1;
    }
    return { read: read, written: written };
  });
  var decoders = new WeakMap();
  constructors.TextDecoder = function (args, target) {
    var label = args[0] === undefined ? "utf-8" : String(args[0]).trim().toLowerCase();
    if (["utf-8", "utf8", "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "x-unicode20utf8"].indexOf(label) === -1) {
      throw new RangeError("Failed to construct 'TextDecoder': The encoding label provided ('" + String(args[0]) + "') is invalid.");
    }
    var made = Object.create(target.prototype);
    var options = args[1] || {};
    decoders.set(made, { fatal: Boolean(options.fatal), ignoreBOM: Boolean(options.ignoreBOM) });
    return made;
  };
  B("TextDecoder.get encoding", function () { return "utf-8"; });
  B("TextDecoder.get fatal", function (self) { return decoders.get(self).fatal; });
  B("TextDecoder.get ignoreBOM", function (self) { return decoders.get(self).ignoreBOM; });
  B("TextDecoder.decode", function (self, args) {
    var state = decoders.get(self);
    if (!state) illegal();
    if (args[0] === undefined) return "";
    var bytes = viewBytes(args[0]);
    if (!bytes) throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.");
    if (!state.ignoreBOM && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
    return decodeUtf8(bytes, state.fatal);
  });

  // Blob and File.
  constructors.Blob = function (args, target) {
    var read = readParts(args[0], args[1], "Blob");
    var made = makeBlob(read.bytes, read.type);
    if (target !== globalThis.Blob) setProto(made, target.prototype);
    return made;
  };
  constructors.File = function (args, target) {
    if (args.length < 2) throw new TypeError("Failed to construct 'File': 2 arguments required, but only " + args.length + " present.");
    var read = readParts(args[0], args[2], "File");
    var modified = args[2] && args[2].lastModified !== undefined ? Number(args[2].lastModified) : Date.now();
    var made = makeBlob(read.bytes, read.type, { name: args[1], lastModified: Math.trunc(modified) || 0 });
    if (target !== globalThis.File) setProto(made, target.prototype);
    return made;
  };
  B("Blob.get size", function (self) { return blobOf(self).bytes.length; });
  B("Blob.get type", function (self) { return blobOf(self).type; });
  B("Blob.slice", function (self, args) {
    var bytes = blobOf(self).bytes;
    var size = bytes.length;
    var clamp = function (value, fallback) {
      if (value === undefined) return fallback;
      var at = Math.trunc(Number(value)) || 0;
      return at < 0 ? Math.max(size + at, 0) : Math.min(at, size);
    };
    var from = clamp(args[0], 0);
    var to = clamp(args[1], size);
    return makeBlob(bytes.slice(from, Math.max(from, to)), args[2] === undefined ? "" : args[2]);
  });
  B("Blob.text", function (self) { var bytes = blobOf(self).bytes; return later(function () { return decodeUtf8(bytes); }); });
  B("Blob.arrayBuffer", function (self) { var bytes = blobOf(self).bytes; return later(function () { return bytes.slice().buffer; }); });
  B("Blob.bytes", function (self) { var bytes = blobOf(self).bytes; return later(function () { return bytes.slice(); }); });
  B("File.get name", function (self) { return blobOf(self).name; });
  B("File.get lastModified", function (self) { return blobOf(self).lastModified; });
  B("File.get webkitRelativePath", function (self) { blobOf(self); return ""; });

  // URL and URLSearchParams (parsing by the host's WHATWG URL parser).
  var URL_FIELDS = ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"];
  constructors.URL = function (args, target) {
    if (args.length < 1) throw new TypeError("Failed to construct 'URL': 1 argument required, but only 0 present.");
    var parsed = parseUrl(args[0], args[1]);
    if (!parsed) throw new TypeError("Failed to construct 'URL': Invalid URL");
    var made = Object.create(target.prototype);
    urlState.set(made, parsed);
    return made;
  };
  URL_FIELDS.forEach(function (field) {
    B("URL.get " + field, function (self) { var state = urlState.get(self); if (!state) illegal(); return state[field]; });
  });
  B("URL.toString", function (self) { var state = urlState.get(self); if (!state) illegal(); return state.href; });
  B("URL.toJSON", function (self) { var state = urlState.get(self); if (!state) illegal(); return state.href; });
  B("URL.static canParse", function (self, args) { return parseUrl(args[0], args[1]) !== null; });
  B("URL.static parse", function (self, args) {
    var parsed = parseUrl(args[0], args[1]);
    if (!parsed) return null;
    var made = Object.create(globalThis.URL.prototype);
    urlState.set(made, parsed);
    return made;
  });
  B("URL.static createObjectURL", function (self, args) {
    if (!blobs.has(args[0])) throw new TypeError("Failed to execute 'createObjectURL' on 'URL': Overload resolution failed.");
    var address = "blob:" + facts.origin + "/" + host.uuid();
    objectUrls.set(address, args[0]);
    return address;
  });
  B("URL.static revokeObjectURL", function (self, args) { objectUrls.delete(String(args[0])); });

  // Response and Headers, enough for fetch's answers.
  B("Response.get status", function (self) { return responseState.get(self).status; });
  B("Response.get ok", function (self) { var s = responseState.get(self).status; return s >= 200 && s <= 299; });
  B("Response.get statusText", function (self) { return responseState.get(self).statusText; });
  B("Response.get url", function (self) { return responseState.get(self).url; });
  B("Response.get type", function (self) { return responseState.get(self).type; });
  B("Response.get redirected", function () { return false; });
  B("Response.get headers", function (self) { return responseState.get(self).headers; });
  B("Response.get bodyUsed", function (self) { return responseState.get(self).used; });
  B("Response.text", function (self) { return consume(self, "text", function (bytes) { return decodeUtf8(bytes); }); });
  B("Response.json", function (self) { return consume(self, "json", function (bytes) { return JSON.parse(decodeUtf8(bytes)); }); });
  B("Response.arrayBuffer", function (self) { return consume(self, "arrayBuffer", function (bytes) { return bytes.slice().buffer; }); });
  B("Response.bytes", function (self) { return consume(self, "bytes", function (bytes) { return bytes.slice(); }); });
  B("Response.blob", function (self) {
    var type = self.headers.get("content-type") || "";
    return consume(self, "blob", function (bytes) { return makeBlob(bytes.slice(), type); });
  });
  B("Headers.get", function (self, args) {
    var name = String(args[0]).toLowerCase();
    var found = (headerState.get(self) || []).filter(function (pair) { return pair[0] === name; }).map(function (pair) { return pair[1]; });
    return found.length ? found.join(", ") : null;
  });
  B("Headers.has", function (self, args) {
    var name = String(args[0]).toLowerCase();
    return (headerState.get(self) || []).some(function (pair) { return pair[0] === name; });
  });

  // StorageManager and the origin private file system.
  B("StorageManager.getDirectory", function () { return channels.opfs.root(); });
  B("StorageManager.estimate", function () {
    return facts.estimate().then(function (estimate) {
      return { quota: estimate.quota, usage: estimate.usage, usageDetails: {} };
    });
  });
  B("StorageManager.persisted", function () { return later(function () { return false; }); });
  B("StorageManager.persist", function () { return later(function () { return false; }); });
  var OPFS_MEMBERS = {
    FileSystemHandle: ["isSameEntry", "queryPermission", "requestPermission", "remove"],
    FileSystemDirectoryHandle: ["getFileHandle", "getDirectoryHandle", "removeEntry", "resolve", "entries", "keys", "values"],
    FileSystemFileHandle: ["getFile", "createWritable", "createSyncAccessHandle", "move"],
  };
  Object.keys(OPFS_MEMBERS).forEach(function (iface) {
    OPFS_MEMBERS[iface].forEach(function (name) {
      B(iface + "." + name, function (self, args) { return apply(channels.opfs[name], self, args); });
    });
  });
  B("FileSystemHandle.get kind", function (self) { return apply(channels.opfs.handle_kind, self, []); });
  B("FileSystemHandle.get name", function (self) { return apply(channels.opfs.handle_name, self, []); });
  ["read", "write", "truncate", "getSize", "flush", "close"].forEach(function (name) {
    B("FileSystemSyncAccessHandle." + name, function (self, args) { return apply(channels.opfs["sync_" + name], self, args); });
  });
  var writables = new WeakMap();
  var writableOf = function (self) {
    var state = writables.get(self);
    if (!state) illegal();
    if (state.scratch.closed) return null;
    return state;
  };
  B("FileSystemWritableFileStream.write", function (self, args) {
    var state = writableOf(self);
    return later(function () {
      if (!state) throw new TypeError("Cannot write to a CLOSED writable stream");
      channels.opfs.writeChunk(state.scratch, args[0]);
    });
  });
  B("FileSystemWritableFileStream.seek", function (self, args) {
    var state = writableOf(self);
    return later(function () { if (state) state.scratch.cursor = Number(args[0]) || 0; });
  });
  B("FileSystemWritableFileStream.truncate", function (self, args) {
    var state = writableOf(self);
    return later(function () { if (state) channels.opfs.writeChunk(state.scratch, { type: "truncate", size: args[0] }); });
  });
  B("WritableStream.close", function (self) {
    var state = writables.get(self);
    return later(function () {
      if (!state || state.scratch.closed) throw new TypeError("Failed to execute 'close' on 'WritableStream': Cannot close a CLOSED writable stream");
      state.scratch.closed = true;
      state.commit();
    });
  });
  B("WritableStream.abort", function (self) {
    var state = writables.get(self);
    return later(function () { if (state) state.scratch.closed = true; });
  });
  B("WritableStream.get locked", function () { return false; });

  // --- building the surface ------------------------------------------------------------------

  var built = Object.create(null);

  var memberFor = function (iface, entry, holder, isStatic) {
    var key = entry[0];
    var kind = entry[1];
    var flags = entry[2];
    var descriptor = { enumerable: Boolean(flags & 1), configurable: Boolean(flags & 2) };
    var label = iface + "." + (isStatic ? "static " : "");
    if (kind === "f") {
      var impl = behaviours[label + key];
      var length = entry[3];
      var proto = holder;
      descriptor.writable = Boolean(flags & 4);
      descriptor.value = native("method", entry[4] || key, length, impl ? function (self, args) {
        return impl(self, args);
      } : function (self) {
        if (!isStatic && iface !== "global" && !(self !== null && typeof self === "object" && proto.isPrototypeOf(self))) illegal();
        return undefined;
      });
      return descriptor;
    }
    if (kind === "a") {
      var getter = behaviours[label + "get " + key];
      var setter = behaviours[label + "set " + key];
      var handler = /^on[a-z]+$/.test(key) && entry[4];
      var home = holder;
      var eventField = !getter && !handler && (iface === "Event" || /Event$/.test(iface));
      if (entry[3]) {
        descriptor.get = native("get", key, 0, getter ? function (self) { return getter(self === undefined ? globalThis : self, []); } : eventField ? function (self) {
          return eventOf(self)[key];
        } : handler ? function (self) {
          return getHandler(self === undefined ? globalThis : self, key);
        } : function (self) {
          if (iface !== "global" && !(self !== null && typeof self === "object" && (home === self || home.isPrototypeOf(self)))) illegal();
          return undefined;
        });
      }
      if (entry[4]) {
        descriptor.set = native("set", key, 1, setter ? function (self, args) { setter(self === undefined ? globalThis : self, args); } : handler ? function (self, args) {
          setHandler(self === undefined ? globalThis : self, key, args[0]);
        } : function () {});
      }
      return descriptor;
    }
    descriptor.writable = Boolean(flags & 4);
    switch (kind) {
      case "n": descriptor.value = typeof entry[3] === "number" ? entry[3] : Number(entry[3]); break;
      case "s": descriptor.value = entry[3]; break;
      case "b": descriptor.value = entry[3]; break;
      case "u": descriptor.value = undefined; break;
      case "l": descriptor.value = null; break;
      default: return null;
    }
    return descriptor;
  };

  var ES_BUILTINS = {
    SuppressedError: true, DisposableStack: true, AsyncDisposableStack: true, Iterator: true, AggregateError: true,
    FinalizationRegistry: true, WeakRef: true, Float16Array: true, BigInt64Array: true, BigUint64Array: true,
    SharedArrayBuffer: true, Atomics: true, Temporal: true, TypedArray: true,
  };

  var buildInterfaces = function (shape) {
    var hidden = shape.hidden || {};
    Object.keys(hidden).forEach(function (name) {
      if (!shape.interfaces[name]) shape.interfaces[name] = hidden[name];
    });
    var names = Object.keys(shape.interfaces);
    // Constructors and prototypes first, then members, so members can name any interface.
    names.forEach(function (name) {
      // An ECMAScript built-in this V8 lacks stays missing rather than becoming an inert stub.
      if (hasOwn.call(globalThis, name) || ES_BUILTINS[name]) return;
      var record = shape.interfaces[name];
      var construct = constructors[name];
      var ctor = native("ctor", name, record.l, function (self, args, target) {
        if (target === undefined) {
          if (construct) throw new TypeError("Failed to construct '" + name + "': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
          throw new TypeError("Illegal constructor");
        }
        if (!construct) throw new TypeError("Illegal constructor");
        var made = construct(Array.prototype.slice.call(args), target);
        if (target !== ctor && made && getProto(made) !== target.prototype) setProto(made, target.prototype);
        return made;
      });
      var proto = {};
      defineProperty(ctor, "prototype", { value: proto, writable: false, enumerable: false, configurable: false });
      built[name] = { ctor: ctor, proto: proto, record: record };
    });
    names.forEach(function (name) {
      var held = built[name];
      if (!held) return;
      var record = held.record;
      var parent = record.p === null ? null : record.p === "Object" ? Object.prototype : built[record.p] ? built[record.p].proto : globalThis[record.p] && globalThis[record.p].prototype ? globalThis[record.p].prototype : Object.prototype;
      setProto(held.proto, parent);
      if (record.c) {
        var ctorParent = built[record.c] ? built[record.c].ctor : globalThis[record.c];
        if (ctorParent) setProto(held.ctor, ctorParent);
      }
      record.m.forEach(function (entry) {
        var key = entry[0];
        if (key === "constructor") {
          defineProperty(held.proto, "constructor", { value: held.ctor, writable: true, enumerable: false, configurable: true });
          return;
        }
        var descriptor;
        if (key.indexOf("@@Symbol.") === 0) {
          var symbol = Symbol[key.slice(9)];
          if (!symbol) return;
          if (entry[1] === "f") {
            var alias = record.m.filter(function (other) { return other[1] === "f" && other[4] === entry[4] && other[0] !== key; })[0];
            descriptor = alias ? { value: null, writable: Boolean(entry[2] & 4), enumerable: Boolean(entry[2] & 1), configurable: Boolean(entry[2] & 2), alias: alias[0] } : memberFor(name, [entry[4] || "values"].concat(entry.slice(1)), held.proto, false);
          } else {
            descriptor = memberFor(name, entry, held.proto, false);
          }
          if (!descriptor) return;
          if (descriptor.alias) {
            var target = descriptor.alias;
            delete descriptor.alias;
            descriptor.value = held.proto[target];
          }
          defineProperty(held.proto, symbol, descriptor);
          return;
        }
        descriptor = memberFor(name, entry, held.proto, false);
        if (descriptor) defineProperty(held.proto, key, descriptor);
      });
      record.s.forEach(function (entry) {
        if (entry[0] === "length" || entry[0] === "name" || entry[0] === "prototype") return;
        var descriptor = memberFor(name, entry, held.ctor, true);
        if (descriptor) defineProperty(held.ctor, entry[0], descriptor);
      });
    });
  };

  var buildGlobal = function (shape) {
    // `globalThis` itself is one of the globals put back in order: hold the global meanwhile.
    var scope = globalThis;
    var globalProto = built.DedicatedWorkerGlobalScope ? built.DedicatedWorkerGlobalScope.proto : Object.prototype;
    var wanted = Object.create(null);
    shape.global.forEach(function (entry) { wanted[entry[0]] = true; });

    // What this V8 has that Chrome's worker does not (SharedArrayBuffer without cross-origin
    // isolation, say) goes; then the globals take Chrome's order: past the longest prefix that
    // already matches, each is taken out and put back in turn (a global's own keys keep
    // insertion order).
    Object.getOwnPropertyNames(scope).forEach(function (key) {
      if (!wanted[key]) delete scope[key];
    });
    var current = Object.getOwnPropertyNames(scope);
    var order = shape.global.map(function (entry) { return entry[0]; }).filter(function (key) { return key.indexOf("@@") !== 0; });
    var kept = 0;
    while (kept < current.length && kept < order.length && current[kept] === order[kept]) kept += 1;
    var moving = {};
    order.slice(kept).forEach(function (key) {
      var descriptor = Object.getOwnPropertyDescriptor(scope, key);
      if (descriptor && descriptor.configurable) {
        moving[key] = descriptor;
        delete scope[key];
      }
    });

    shape.global.forEach(function (entry) {
      var key = entry[0];
      if (key.indexOf("@@") === 0) return;
      if (moving[key]) {
        defineProperty(scope, key, moving[key]);
        return;
      }
      if (built[key] && shape.interfaces[key] && !(shape.hidden && shape.hidden[key])) {
        defineProperty(scope, key, { value: built[key].ctor, writable: Boolean(entry[2] & 4), enumerable: Boolean(entry[2] & 1), configurable: Boolean(entry[2] & 2) });
        return;
      }
      if (hasOwn.call(scope, key)) return;
      if (entry[1] === "o") {
        var namespace = shape.namespaces[key];
        if (!namespace) return;
        var object = {};
        namespace.forEach(function (inner) {
          var descriptor = inner[0].indexOf("@@Symbol.") === 0 ? null : memberFor(key, inner, object, true);
          if (inner[0] === "@@Symbol.toStringTag") defineProperty(object, Symbol.toStringTag, { value: inner[3], writable: false, enumerable: false, configurable: true });
          else if (descriptor) defineProperty(object, inner[0], descriptor);
        });
        defineProperty(scope, key, { value: object, writable: Boolean(entry[2] & 4), enumerable: Boolean(entry[2] & 1), configurable: Boolean(entry[2] & 2) });
        return;
      }
      var descriptor = memberFor("global", entry, scope, false);
      if (descriptor) defineProperty(scope, key, descriptor);
    });
    setProto(scope, globalProto);
  };

  var instance = function (iface) { return built[iface] ? Object.create(built[iface].proto) : Object.create(Object.prototype); };

  globalThis.__WORKER = {
    // The host hands the top-level script's exception here, with where V8 says it happened.
    uncaught: function (error, line, column) {
      reportException(error, { filename: scriptUrl, lineno: line, colno: column });
    },

    // Builds the worker's global from Chrome's worker shape and the facts of the page that made
    // it, then returns its control. `kit` carries what every realm of the page shares.
    bind: function (given, kit, ownerHooks) {
      delete globalThis.__WORKER;
      sources = kit.sources;
      shared = kit.shared;
      facts = given;
      owner = ownerHooks;
      scriptUrl = facts.url;
      startNow = now();
      facts.timeOrigin = facts.originTime;

      var parsed = parseUrl(facts.url);
      facts.location = parsed;
      facts.secure = facts.origin === "null" ? Boolean(facts.parentSecure) : /^https:|^wss:/.test(facts.origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(facts.origin);

      var patched = native("method", "toString", 0, function (self) {
        var recorded = typeof self === "function" ? sources.get(self) : undefined;
        if (recorded) return recorded;
        return apply(nativeToString, self, []);
      });
      defineProperty(Function.prototype, "toString", { value: patched, writable: true, enumerable: false, configurable: true });

      buildInterfaces(kit.shape);
      buildGlobal(kit.shape);
      isTrustedGetter = native("get", "isTrusted", 0, function (self) {
        var state = eventState.get(self);
        return state ? state.isTrusted : undefined;
      });

      navigatorObject = instance("WorkerNavigator");
      locationObject = instance("WorkerLocation");
      performanceObject = instance("Performance");
      cryptoObject = instance("Crypto");
      subtleObject = instance("SubtleCrypto");
      schedulerObject = instance("Scheduler");
      storageObject = instance("StorageManager");
      uaDataObject = instance("NavigatorUAData");
      namedObjects.indexedDB = instance("IDBFactory");
      namedObjects.caches = instance("CacheStorage");
      namedObjects.fonts = instance("FontFaceSet");
      namedObjects.trustedTypes = instance("TrustedTypePolicyFactory");

      channels = channelsFactory({
        later: function (callback, ms) { queueTask(callback, ms); },
        shared: shared,
        origin: function () { return facts.origin; },
        isPlatform: function (value) {
          for (var current = value, depth = 0; current && depth < 32; depth += 1) {
            if (current === Object.prototype || current === Function.prototype) return false;
            var own = Object.getOwnPropertyDescriptor(current, "constructor");
            if (own && typeof own.value === "function" && sources.has(own.value) && own.value.prototype === current) return true;
            current = getProto(current);
          }
          return false;
        },
        brandOf: function (value) { return Object.prototype.toString.call(value).slice(8, -1); },
        typeError: function (message) { return new TypeError(message); },
        domException: makeException,
        blobState: function (value) {
          var state = value !== null && typeof value === "object" ? blobs.get(value) : null;
          return state ? { bytes: state.bytes, type: state.type, name: state.name, lastModified: state.lastModified } : null;
        },
        makeBlob: makeBlob,
        exceptionState: function (value) {
          var state = value !== null && typeof value === "object" ? exceptions.get(value) : null;
          return state ? { name: state.name, message: state.message } : null;
        },
        makeDomException: function (message, name) { return new globalThis.DOMException(message, name); },
        makePort: function () { return instance("MessagePort"); },
        portEvent: function (port, data, ports) { dispatch(port, makeEvent("MessageEvent", "message", { data: data, ports: ports }, true)); },
        portError: function (port) { dispatch(port, makeEvent("MessageEvent", "messageerror", {}, true)); },
        broadcastEvent: function (channel, data, origin) { dispatch(channel, makeEvent("MessageEvent", "message", { data: data, origin: origin }, true)); },
        broadcastError: function (channel, origin) { dispatch(channel, makeEvent("MessageEvent", "messageerror", { origin: origin }, true)); },
        makeHandle: function (kind) { return instance(kind === "directory" ? "FileSystemDirectoryHandle" : "FileSystemFileHandle"); },
        makeSyncHandle: function () { return instance("FileSystemSyncAccessHandle"); },
        makeWritable: function (scratch, commit) {
          var made = instance("FileSystemWritableFileStream");
          writables.set(made, { scratch: scratch, commit: commit });
          return made;
        },
        asyncIteratorProto: getProto(getProto((async function* () {})())),
        flush: function () { host.flush(); },
      });

      return control;
    },
  };
})();
