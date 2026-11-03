(function () {
  var hostNow = __wreGraphNow;
  var hostEntropy = __wreGraphEntropy;
  var hostUuid = __wreGraphUuid;
  var hostDigest = __wreGraphDigest;
  var hostSubtle = __wreGraphSubtle;
  var hostBlankPng = __wreGraphBlankPng;
  var hostEntries = __wreGraphEntries;
  var hostPage = __wreGraphPage;
  var hostMedia = __wreGraphMedia;
  var hostSend = __wreGraphSend;
  var hostSendLater = __wreGraphSendLater;
  var hostArrived = __wreGraphArrived;
  var hostCookieRead = __wreGraphCookieRead;
  var hostCookieWrite = __wreGraphCookieWrite;
  var hostMiss = __wreGraphMiss;
  var hostCodec = __wreGraphCodec;
  var hostWorkerShape = typeof __wreGraphWorkerShape === "function" ? __wreGraphWorkerShape : null;
  var hostUrl = __wreGraphUrl;

  var page = hostPage();
  var timers = [];
  var deferred = [];
  // Requests on the wire, by ticket, and taking the answers that came back into the task queue.
  var waiting = new Map();
  var pull = function () {
    if (!waiting.size) return;
    var arrived = hostArrived();
    for (var index = 0; index < arrived.length; index += 1) {
      var callback = waiting.get(arrived[index][0]);
      waiting.delete(arrived[index][0]);
      if (callback) deferred.push([callback, arrived[index][1]]);
    }
  };
  // The longest delay a timer keeps, as Chrome's (a signed 32-bit count of ms); longer ones
  // overflow and run at once. A page that lives for hours schedules work hours away (Kasada's
  // loader renews its clearance a day out), so nothing shorter may stand in for it.
  var MAX_DELAY = 2147483647;

  var spare = [];
  var frames = new Map();

  (function () {
    var count = globalThis.__wreFrameCount || 0;
    delete globalThis.__wreFrameCount;

    for (var index = 0; index < count; index += 1) {
      var view = globalThis["__wreFrameView" + index];
      var env = globalThis["__wreFrameEnv" + index];
      var pump = globalThis["__wreFramePump" + index];

      delete globalThis["__wreFrameView" + index];
      delete globalThis["__wreFrameEnv" + index];
      delete globalThis["__wreFramePump" + index];

      if (!view || !env) continue;

      spare.push({ view: view, env: env, pump: pump });
    }
  })();

  var schedule = function (id, delay, extra) {
    var wait = typeof delay === "number" && isFinite(delay) ? delay : 0;
    if (wait < 0) wait = 0;
    if (wait > MAX_DELAY) wait = 1;
    timers.push({ id: id, due: hostNow() + wait, extra: extra || [] });
  };

  var unschedule = function (id) {
    for (var index = 0; index < timers.length; index += 1) {
      if (timers[index].id === id) {
        timers.splice(index, 1);
        return;
      }
    }
  };

  var BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  var toBase64 = function (bytes) {
    var out = "";

    for (var index = 0; index < bytes.length; index += 3) {
      var first = bytes[index];
      var second = index + 1 < bytes.length ? bytes[index + 1] : 0;
      var third = index + 2 < bytes.length ? bytes[index + 2] : 0;
      var word = (first << 16) | (second << 8) | third;

      out += BASE64.charAt((word >> 18) & 63);
      out += BASE64.charAt((word >> 12) & 63);
      out += index + 1 < bytes.length ? BASE64.charAt((word >> 6) & 63) : "=";
      out += index + 2 < bytes.length ? BASE64.charAt(word & 63) : "=";
    }

    return out;
  };

  var fromBase64 = function (text) {
    var clean = String(text).replace(/[^A-Za-z0-9+/]/g, "");
    var bytes = [];
    var held = 0;
    var bits = 0;

    for (var index = 0; index < clean.length; index += 1) {
      held = (held << 6) | BASE64.indexOf(clean.charAt(index));
      bits += 6;

      if (bits >= 8) {
        bits -= 8;
        bytes.push((held >> bits) & 255);
      }
    }

    return bytes;
  };

  var hexOf = function (bytes) {
    var digits = "0123456789abcdef";
    var out = "";
    for (var index = 0; index < bytes.length; index += 1) {
      out += digits.charAt(bytes[index] >> 4) + digits.charAt(bytes[index] & 15);
    }
    return out;
  };

  var bytesOfHex = function (hex) {
    var out = [];
    for (var index = 0; index + 1 < hex.length; index += 2) {
      out.push(parseInt(hex.slice(index, index + 2), 16));
    }
    return out;
  };

  var bodyOf = function (body) {
    if (body === null || body === undefined) return null;
    if (typeof body === "string") return { text: body };

    if (body instanceof ArrayBuffer) return { bytes: toBase64(new Uint8Array(body)) };
    if (ArrayBuffer.isView(body)) {
      return { bytes: toBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) };
    }

    return { text: String(body) };
  };

  var sources = globalThis.__SOURCES || new WeakMap();
  delete globalThis.__SOURCES;

  // What every realm of the page shares (the window, its frames and workers): worker start
  // requests, broadcast channels, the origin private file system.
  var shared = globalThis.__wreShared || { workers: [] };
  delete globalThis.__wreShared;

  globalThis.__BRIDGE = {
    shared: shared,

    sources: sources,

    now: function () {
      return hostNow();
    },

    random: function (count) {
      return hexOf(fromBase64(hostEntropy(count)));
    },

    uuid: function () {
      return hostUuid();
    },

    // A SubtleCrypto operation over byte arrays (see crate::subtle): `fields` maps names to
    // Uint8Arrays or numbers/strings; answers a Uint8Array, or { failed: why }.
    subtle: function (op, fields) {
      var sent = {};
      Object.keys(fields).forEach(function (name) {
        var value = fields[name];
        sent[name] = value instanceof Uint8Array ? toBase64(value) : value;
      });
      var out = hostSubtle(String(op), sent);
      if (out && typeof out === "object") return out;
      return Uint8Array.from(fromBase64(out));
    },

    // A blank canvas's PNG (base64), as crate::subtle::blank_png encodes it.
    blankPng: function (width, height) {
      return hostBlankPng(Number(width), Number(height));
    },

    digest: function (algorithm, hex) {
      var out = hostDigest(String(algorithm), toBase64(bytesOfHex(String(hex))));
      return out === null ? null : hexOf(fromBase64(out));
    },

    entries: function (type) {
      return hostEntries(String(type));
    },

    pageUrl: function () {
      return page.url;
    },

    referrer: function () {
      return page.referrer;
    },

    // Compression and text decoding handles (see the sandbox's codec module): bytes go as
    // Uint8Arrays here and as base64 across to the host.
    codecLabel: function (label) {
      return hostCodec("label", String(label));
    },

    codecOpen: function (kind, name, ignoreBOM) {
      return hostCodec("open", String(kind), String(name), Boolean(ignoreBOM));
    },

    codecPush: function (id, bytes, last, fatal) {
      var answer = hostCodec("push", id, toBase64(bytes), Boolean(last), Boolean(fatal));
      if (answer && answer.chunks) answer.chunks = answer.chunks.map(function (chunk) { return Uint8Array.from(fromBase64(chunk)); });
      return answer;
    },

    codecDrop: function (id) {
      hostCodec("drop", id);
    },

    canPlayType: function (type) {
      return hostMedia(String(type));
    },

    schedule: schedule,
    unschedule: unschedule,

    // The page's cookies, from the host's jar (what document.cookie shows: no HttpOnly ones).
    cookieRead: function () { return String(hostCookieRead()); },
    cookieWrite: function (assignment) { hostCookieWrite(String(assignment)); },

    request: function (method, url, headerJson, body, callback) {
      var carried = bodyOf(body);

      var headers = {};

      try {
        headers = JSON.parse(String(headerJson || "{}")) || {};
      } catch (error) {
        headers = {};
      }

      // On the wire meanwhile; its answer comes back as a task (see `pull`).
      var ticket = hostSendLater({
        method: String(method || "GET"),
        url: String(url || ""),
        headers: headers,
        body: carried && carried.text !== undefined ? carried.text : null,
        bodyBytes: carried && carried.bytes !== undefined ? carried.bytes : null
      });

      waiting.set(ticket, callback);
    },

    // A request answered at once, for a synchronous XMLHttpRequest.
    requestNow: function (method, url, headerJson, body) {
      var carried = bodyOf(body);

      var headers = {};

      try {
        headers = JSON.parse(String(headerJson || "{}")) || {};
      } catch (error) {
        headers = {};
      }

      var answer = hostSend({
        method: String(method || "GET"),
        url: String(url || ""),
        headers: headers,
        body: carried && carried.text !== undefined ? carried.text : null,
        bodyBytes: carried && carried.bytes !== undefined ? carried.bytes : null
      });

      return answer;
    },

    createFrame: function () {
      var held = spare.shift();

      if (!held) {
        hostMiss("no spare child realm for an iframe");
        return null;
      }

      frames.set(held.view, held);
      return held.view;
    },

    runInFrame: function (view, source, name, inline) {
      var held = frames.get(view);
      if (!held) return false;

      try {
        held.env.beginScript(String(name || "frame.js"), Boolean(inline));
        held.env.evaluate(String(source));
        return true;
      } catch (error) {
        hostMiss("frame script " + String(name) + ": " + String(error && error.message));
        return false;
      } finally {
        held.env.endScript();
      }
    },

    frameLoaded: function (view) {
      var held = frames.get(view);
      if (held && typeof held.env.fireLoad === "function") held.env.fireLoad();
    },

    relocateFrame: function (view, href) {
      var held = frames.get(view);
      if (held && typeof held.env.relocate === "function") held.env.relocate(String(href));
    },

    // An iframe taken out of the document gives its child realm back for the next one, back on
    // about:blank, so a page that keeps opening frames (Kasada's loader refreshing) never runs out.
    releaseFrame: function (view) {
      var held = frames.get(view);
      if (!held) return;
      frames.delete(view);
      if (typeof held.env.relocate === "function") held.env.relocate("about:blank");
      spare.push(held);
    },

    adoptFrames: function (deliver) {
      spare.forEach(function (held) { held.env.toEmbedder = deliver; });
      frames.forEach(function (held) { held.env.toEmbedder = deliver; });
    },

    deliverMessage: function (view, message, origin, source) {
      var held = frames.get(view);
      if (!held) return false;

      try {
        held.env.deliverMessage(message, origin, source);
        return true;
      } catch (error) {
        hostMiss("frame postMessage: " + String(error && error.message));
        return false;
      }
    },

    miss: function (what) {
      hostMiss(String(what));
    },

    // A URL parsed by the host's WHATWG parser: { href, origin, protocol, ... } or null.
    parseUrl: function (input, base) {
      return hostUrl(String(input), base === undefined || base === null ? null : String(base));
    },

    adoptWorker: function (control) { workers.add(control); },
    releaseWorker: function (control) { workers.delete(control); },

    // The worker start the host takes next ({ id, url, source }), or null: the first request
    // (from this window, a frame or a worker) whose script is in hand.
    takeWorker: function () {
      for (var index = 0; index < shared.workers.length; index += 1) {
        var request = shared.workers[index];
        if (request.cancelled) {
          shared.workers.splice(index, 1);
          index -= 1;
          continue;
        }
        if (!request.ready) continue;
        shared.workers.splice(index, 1);
        starting.set(request.id, request);
        return { id: request.id, url: request.url, source: request.source };
      }
      return null;
    },

    // The host opened the worker's realm and left its control in `__wreWorkerSlot`: the realm
    // that asked for the worker builds it.
    bindWorker: function (id) {
      var slot = globalThis.__wreWorkerSlot;
      delete globalThis.__wreWorkerSlot;
      var request = starting.get(id);
      if (!request || !slot) return false;
      if (!workerShape) workerShape = JSON.parse(hostWorkerShape());
      return Boolean(request.bind(slot, { sources: sources, shared: shared, shape: workerShape }));
    },

    // The worker's script ran: its event loop starts.
    workerStarted: function (id) {
      var request = starting.get(id);
      starting.delete(id);
      if (request) request.started();
    }
  };

  // The realm's event loop, one task per call, as a browser runs it: the host calls `step` again
  // and again, and each call returns to the host, so V8 runs the microtasks a task queued before
  // the next task starts (a timer's promise reactions run before the next timer). A task is a
  // network answer, or the earliest due timer of this window or of a frame it embeds.
  var nextDue = function () {
    var best = null;
    for (var index = 0; index < timers.length; index += 1) {
      if (best === null || timers[index].due < best.due) best = timers[index];
    }
    return best;
  };

  // Dedicated workers this realm started: each has its own event loop (its control's due/step),
  // pumped from here between this realm's own tasks, as frames are.
  var workers = new Set();
  var starting = new Map();
  var workerShape = null;

  // A worker start is waiting for the host (see Graph::start_workers).
  var workerWaiting = function () {
    for (var index = 0; index < shared.workers.length; index += 1) {
      if (shared.workers[index].ready && !shared.workers[index].cancelled) return true;
    }
    return false;
  };

  globalThis.__PUMP = {
    // When this realm's next task is due (host clock, ms), or null when it has none; answers
    // waiting to be delivered are due now.
    due: function () {
      var due = deferred.length || workerWaiting() ? 0 : null;
      var timer = nextDue();
      if (timer && (due === null || timer.due < due)) due = timer.due;

      frames.forEach(function (held) {
        if (!held.pump) return;
        var inner = held.pump.due();
        if (inner !== null && (due === null || inner < due)) due = inner;
      });

      workers.forEach(function (control) {
        var inner = control.due();
        if (inner !== null && (due === null || inner < due)) due = inner;
      });

      return due;
    },

    // Runs the one task due soonest, if it is due by `until`; says whether it ran one.
    step: function (env, until) {
      var owner = env || globalThis.__ENV;
      var limit = typeof until === "number" ? until : hostNow();
      pull();

      if (deferred.length) {
        var waiting = deferred.shift();
        var answer = waiting[1];
        var headers = {};

        (answer.headers || []).forEach(function (pair) { headers[pair[0]] = pair[1]; });

        try {
          waiting[0](answer.status, JSON.stringify(headers), answer.body || "");
        } catch (error) {
          hostMiss("response callback: " + String(error && error.message));
        }

        return 1;
      }

      var timer = nextDue();
      var frame = null;
      var frameDue = null;

      frames.forEach(function (held) {
        if (!held.pump) return;
        var inner = held.pump.due();
        if (inner !== null && (frameDue === null || inner < frameDue)) {
          frameDue = inner;
          frame = held;
        }
      });

      var worker = null;
      var workerDue = null;

      workers.forEach(function (control) {
        var inner = control.due();
        if (inner !== null && (workerDue === null || inner < workerDue)) {
          workerDue = inner;
          worker = control;
        }
      });

      if (worker && workerDue <= limit && (!timer || workerDue < timer.due) && (!frame || workerDue < frameDue)) {
        try {
          return worker.step(limit);
        } catch (error) {
          hostMiss("worker pump: " + String(error && error.message));
          return 0;
        }
      }

      if (frame && frameDue <= limit && (!timer || frameDue < timer.due)) {
        try {
          return frame.pump.step(frame.env, limit);
        } catch (error) {
          hostMiss("frame pump: " + String(error && error.message));
          return 0;
        }
      }

      if (!timer || timer.due > limit) return 0;

      timers.splice(timers.indexOf(timer), 1);

      try {
        owner.fire(timer.id, timer.extra);
      } catch (error) {
        hostMiss("timer " + timer.id + ": " + String(error && error.message));
      }

      return 1;
    },

    pending: function () {
      var count = timers.length + deferred.length + waiting.size;

      frames.forEach(function (held) {
        if (held.pump) count += held.pump.pending();
      });

      workers.forEach(function (control) { count += control.pending(); });

      return count;
    }
  };

  delete globalThis.__wreGraphNow;
  delete globalThis.__wreGraphEntropy;
  delete globalThis.__wreGraphUuid;
  delete globalThis.__wreGraphDigest;
  delete globalThis.__wreGraphEntries;
  delete globalThis.__wreGraphPage;
  delete globalThis.__wreGraphMedia;
  delete globalThis.__wreGraphSend;
  delete globalThis.__wreGraphSendLater;
  delete globalThis.__wreGraphArrived;
  delete globalThis.__wreGraphCookieRead;
  delete globalThis.__wreGraphCookieWrite;
  delete globalThis.__wreGraphMiss;
  delete globalThis.__wreGraphCodec;
  delete globalThis.__wreGraphWorkerShape;
  delete globalThis.__wreGraphUrl;
  delete globalThis.__wreGraphSubtle;
  delete globalThis.__wreGraphBlankPng;
})();
