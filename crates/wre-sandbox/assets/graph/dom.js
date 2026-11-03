(function () {
  var env = globalThis.__ENV;
  var bridge = env.bridge;
  var snapshot = env.snapshot;
  var traits = env.traits || {};

  var asMethod = env.asMethod;

  var asNative = function (fn, name) {
    try {
      Object.defineProperty(fn, "name", { value: name, configurable: true });
    } catch (error) {}

    env.sources.set(fn, env.nativeSource(name));
    return fn;
  };

  var shapeOwner = function (target, name) {
    var shapes = env.shapes;
    if (!shapes || !target) return target;
    if (Object.prototype.hasOwnProperty.call(target, name)) return target;

    var current = target;

    for (var steps = 0; steps < 12 && current && current !== Object.prototype && current !== Function.prototype; steps += 1) {
      var constructor = null;

      try {
        constructor = current.constructor;
      } catch (error) {
        constructor = null;
      }

      var owns = false;

      try {
        owns = Boolean(constructor) && constructor.prototype === current;
      } catch (error) {
        owns = false;
      }

      var owned = owns && constructor.name ? shapes[constructor.name] : null;
      if (owned && owned.indexOf(name) !== -1) return current;

      try {
        current = Object.getPrototypeOf(current);
      } catch (error) {
        current = null;
      }
    }

    return target;
  };

  var patch = function (target, name, implementation) {
    if (!target) return;

    target = shapeOwner(target, name);

    var inner = implementation;

    var traced = asMethod(function () {
      env.guard(target, this, name);
      var at = env.count(typeof arguments[0] === "string" ? name + ":" + arguments[0].slice(0, 24) : name);
      var outcome = inner.apply(this, arguments);
      if (at >= 0) env.note(at, arguments, outcome);
      return outcome;
    }, name, inner.length);

    try {
      Object.defineProperty(traced, "length", { value: inner.length, configurable: true });
    } catch (error) {}

    try {
      var descriptor = Object.getOwnPropertyDescriptor(target, name);
      Object.defineProperty(target, name, {
        value: asNative(traced, name),
        writable: descriptor ? descriptor.writable !== false : true,
        enumerable: descriptor ? descriptor.enumerable : true,
        configurable: descriptor ? descriptor.configurable !== false : true,
      });
    } catch (error) {}
  };

  var patchGetter = function (target, name, getter) {
    if (!target) return;

    target = shapeOwner(target, name);

    try {
      var descriptor = Object.getOwnPropertyDescriptor(target, name);
      var tracedGetter = asMethod(function () {
        env.guard(target, this, name);
        var at = env.count("get " + name);
        var outcome = getter.call(this);
        if (at >= 0) env.note(at, null, outcome);
        return outcome;
      }, "get " + name, 0);

      Object.defineProperty(target, name, {
        get: asNative(tracedGetter, "get " + name),
        set: descriptor && descriptor.set ? descriptor.set : undefined,
        enumerable: descriptor ? descriptor.enumerable : true,
        configurable: true,
      });
    } catch (error) {}
  };

  // Constructs a page constructor's shell: `construct(args, newTarget)` makes the instance; the
  // shell takes over the captured constructor's prototype, statics and global name, refuses a call
  // without `new` as Chrome does, and stringifies as native. `illegal` makes it refuse every call
  // ("Illegal constructor"), as for interfaces a page cannot construct.
  var installShell = function (name, construct, length, options) {
    var Original = (options && options.holder) || globalThis[name];
    if (typeof Original !== "function" || !Original.prototype) return null;

    var Shell = function () {
      if (options && options.illegal) {
        throw env.hideFrames(new TypeError("Failed to construct '" + name + "': Illegal constructor"));
      }
      if (new.target === undefined) {
        throw env.hideFrames(new TypeError("Failed to construct '" + name + "': Please use the 'new' operator, this DOM object constructor cannot be called as a function."));
      }
      var required = options && options.required !== undefined ? options.required : 0;
      if (arguments.length < required) {
        throw env.hideFrames(new TypeError("Failed to construct '" + name + "': " + required + " argument" + (required === 1 ? "" : "s") + " required, but only " + arguments.length + " present."));
      }
      var made = construct(Array.prototype.slice.call(arguments), new.target);
      if (new.target !== Shell && made && Object.getPrototypeOf(made) !== new.target.prototype) Object.setPrototypeOf(made, new.target.prototype);
      return made;
    };

    try {
      Object.defineProperty(Shell, "name", { value: name, configurable: true });
    } catch (error) {}
    env.sources.set(Shell, env.nativeSource(name));

    try {
      Object.defineProperty(Shell, "prototype", { value: Original.prototype, writable: false, enumerable: false, configurable: false });
      Object.defineProperty(Shell, "length", { value: length || 0, configurable: true });
      for (var key of Object.getOwnPropertyNames(Original)) {
        if (key === "prototype" || key === "length" || key === "name") continue;
        Object.defineProperty(Shell, key, Object.getOwnPropertyDescriptor(Original, key));
      }
      var parent = Object.getPrototypeOf(Original);
      if (parent && parent !== Function.prototype) Object.setPrototypeOf(Shell, parent);
      Object.defineProperty(Original.prototype, "constructor", { value: Shell, writable: true, enumerable: false, configurable: true });
      if (!options || !options.holder) {
        var descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { value: Shell, writable: true, enumerable: descriptor ? descriptor.enumerable : false, configurable: true });
      }
    } catch (error) {}

    return Shell;
  };

  var protoOf = function (value) {
    try {
      return value ? Object.getPrototypeOf(value) : null;
    } catch (error) {
      return null;
    }
  };

  var sampleOf = function (name) {
    var entry = snapshot.samples[name];
    return entry && entry.k === "ref" ? env.materialize(entry.id, "sample:" + name) : null;
  };

  var log = [];
  env.log = log;

  var record = function (kind, detail) {
    log.push({ kind: kind, detail: detail, at: Date.now() });
  };

  env.record = record;

  var utf8Encode = function (input) {
    var text = String(input);
    var bytes = [];

    for (var index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);

      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        var next = text.charCodeAt(index + 1);

        if (next >= 0xdc00 && next <= 0xdfff) {
          var point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 63), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
          index += 1;
        } else {
          bytes.push(0xef, 0xbf, 0xbd);
        }
      } else if (code >= 0xd800 && code <= 0xdfff) {
        bytes.push(0xef, 0xbf, 0xbd);
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      }
    }

    return Uint8Array.from(bytes);
  };

  // UTF-8 decoding as the Encoding standard does it: each ill-formed sequence (overlong, surrogate,
  // out of range, truncated) becomes one U+FFFD, and the decoder resumes at the offending byte.
  var utf8Decode = function (bytes) {
    var view = bytes instanceof Uint8Array ? bytes : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes || []);
    var units = [];
    var out = "";
    var index = 0;

    var flush = function () {
      out += String.fromCharCode.apply(null, units);
      units = [];
    };

    while (index < view.length) {
      var byte = view[index];
      var need = 0;
      var point = 0;
      var lower = 0x80;
      var upper = 0xbf;

      if (byte < 0x80) {
        units.push(byte);
        index += 1;
      } else {
        if (byte >= 0xc2 && byte <= 0xdf) {
          need = 1;
          point = byte & 0x1f;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          need = 2;
          point = byte & 0xf;
          if (byte === 0xe0) lower = 0xa0;
          if (byte === 0xed) upper = 0x9f;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          need = 3;
          point = byte & 0x7;
          if (byte === 0xf0) lower = 0x90;
          if (byte === 0xf4) upper = 0x8f;
        }

        if (need === 0) {
          units.push(0xfffd);
          index += 1;
        } else {
          var seen = 0;
          var cursor = index + 1;

          while (seen < need && cursor < view.length) {
            var next = view[cursor];
            if (next < lower || next > upper) break;
            lower = 0x80;
            upper = 0xbf;
            point = (point << 6) | (next & 0x3f);
            seen += 1;
            cursor += 1;
          }

          if (seen < need) {
            units.push(0xfffd);
            index = cursor;
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
      }

      if (units.length > 4096) flush();
    }

    flush();
    return out;
  };

  env.decodeUtf8 = utf8Decode;

  if (env.captureCipher) {
    var realJoin = Array.prototype.join;

    try {
      Object.defineProperty(Array.prototype, "join", {
        value: asNative(function join() {
          var out = realJoin.apply(this, arguments);
          if (typeof out === "string" && out.length > 5000) record("payload", out);
          return out;
        }, "join"),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } catch (error) {}
  }

  if (env.captureCipher) {
    var realFreeze = Object.freeze;

    try {
      Object.defineProperty(Object, "freeze", {
        value: asNative(function freeze(target) {
          try {
            if (Array.isArray(target) && target.length > 100) {
              var graft = env.vectorGraft;

              if (graft && graft.values && graft.values.length === target.length) {
                for (var slot = 0; slot < graft.slots.length; slot += 1) {
                  var index = graft.slots[slot];
                  if (index >= 2 && index < target.length) target[index] = graft.values[index];
                }
              }

              record("vector", env.rawStringify(target));
            }
          } catch (error) {}

          return realFreeze(target);
        }, "freeze"),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } catch (error) {}
  }

  var realStringify = JSON.stringify;

  try {
    Object.defineProperty(JSON, "stringify", {
      value: asNative(function stringify() {
        var out = realStringify.apply(JSON, arguments);
        if (typeof out === "string" && out.length > 2000) record("payload", out);
        return out;
      }, "stringify"),
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } catch (error) {}

  var TextEncoderShim = function TextEncoder() {};

  TextEncoderShim.prototype.encode = asNative(function encode(input) {
    if (typeof input === "string" && input.length > 2000) record("payload", input);
    return utf8Encode(input === undefined ? "" : input);
  }, "encode");

  TextEncoderShim.prototype.encodeInto = asNative(function encodeInto(input, target) {
    var bytes = utf8Encode(input);
    target.set(bytes.subarray(0, target.length));
    return { read: String(input).length, written: Math.min(bytes.length, target.length) };
  }, "encodeInto");

  Object.defineProperty(TextEncoderShim.prototype, "encoding", {
    get: asNative(function () { return "utf-8"; }, "get encoding"),
    configurable: true,
  });

  globalThis.TextEncoder = asNative(TextEncoderShim, "TextEncoder");

  var TextDecoderShim = function TextDecoder() {};

  TextDecoderShim.prototype.decode = asNative(function decode(input) {
    return input === undefined ? "" : utf8Decode(input);
  }, "decode");

  Object.defineProperty(TextDecoderShim.prototype, "encoding", {
    get: asNative(function () { return "utf-8"; }, "get encoding"),
    configurable: true,
  });

  globalThis.TextDecoder = asNative(TextDecoderShim, "TextDecoder");

  var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  globalThis.btoa = asNative(function btoa(input) {
    var text = String(input);
    var out = "";

    for (var index = 0; index < text.length; index += 3) {
      var a = text.charCodeAt(index);
      var b = text.charCodeAt(index + 1);
      var c = text.charCodeAt(index + 2);
      var triple = (a << 16) | ((isNaN(b) ? 0 : b) << 8) | (isNaN(c) ? 0 : c);

      out += ALPHABET[(triple >> 18) & 63] + ALPHABET[(triple >> 12) & 63];
      out += isNaN(b) ? "=" : ALPHABET[(triple >> 6) & 63];
      out += isNaN(c) ? "=" : ALPHABET[triple & 63];
    }

    return out;
  }, "btoa");

  globalThis.atob = asNative(function atob(input) {
    var text = String(input).replace(/=+$/, "");
    var out = "";
    var buffer = 0;
    var bits = 0;

    for (var index = 0; index < text.length; index += 1) {
      var value = ALPHABET.indexOf(text[index]);
      if (value === -1) continue;

      buffer = (buffer << 6) | value;
      bits += 6;

      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buffer >> bits) & 255);
      }
    }

    return out;
  }, "atob");

  var consoleReads = traits.consoleReads || {};

  var readLikeConsole = function (level, argv) {
    var counts = consoleReads[level];
    if (!counts) return;

    for (var index = 0; index < argv.length; index += 1) {
      var value = argv[index];
      if (!(value instanceof Error)) continue;

      for (var stackRead = 0; stackRead < counts[0]; stackRead += 1) void value.stack;
      for (var nameRead = 0; nameRead < counts[1]; nameRead += 1) void value.name;
      for (var messageRead = 0; messageRead < counts[2]; messageRead += 1) void value.message;
    }
  };

  if (typeof globalThis.console !== "object" || globalThis.console === null) {
    globalThis.console = {};
  }
  // Every console method must stringify as native code: Kasada enumerates console and reads
  // Function.prototype.toString on each (the `ofc` check). The realm prelude installs plain JS
  // functions, so re-present them as native here, keeping whatever logging they already do.
  var levels = ["log", "warn", "error", "info", "debug", "trace", "table", "dir", "dirxml", "group", "groupCollapsed", "groupEnd", "time", "timeLog", "timeEnd", "timeStamp", "assert", "count", "countReset", "clear", "profile", "profileEnd", "context", "createTask"];
  for (var l = 0; l < levels.length; l += 1) {
    (function (level) {
      var existing = globalThis.console[level];
      var body = typeof existing === "function" ? existing : function () {};
      globalThis.console[level] = asNative(function () {
        readLikeConsole(level, arguments);
        return body.apply(this, arguments);
      }, level);
    })(levels[l]);
  }
  try {
    globalThis.console[Symbol.toStringTag] = "console";
    env.sources.set(globalThis.console, "[object console]");
  } catch (error) {}

  var hexOf = function (value) {
    var view = value instanceof Uint8Array ? value : new Uint8Array(value.buffer || value);
    var out = "";

    for (var index = 0; index < view.length; index += 1) {
      out += (view[index] < 16 ? "0" : "") + view[index].toString(16);
    }

    return out;
  };

  var isBytes = function (value) {
    return value instanceof Uint8Array || (value && typeof value === "object" && typeof value.byteLength === "number" && typeof value.length === "number");
  };

  if (env.debugFunctions) {
    var RealFunction = globalThis.Function;
    env.functionSources = [];

    globalThis.__KT = {
      get: function (receiver, key) {
        if (receiver === undefined || receiver === null) {
          env.count("read " + String(key) + " of " + String(receiver));
          return undefined;
        }

        return receiver[key];
      },
      glob: function (key) {
        var value = globalThis[key];
        if (value === undefined) env.count("missing global " + String(key));
        return value;
      },
    };

    var watch = function (fn) {
      if (!env.captureCipher || typeof fn !== "function") return fn;

      return new Proxy(fn, {
        apply: function (target, self, args) {
          for (var index = 0; index < args.length; index += 1) {
            var value = args[index];

            if (typeof value === "string" && value.length > 1000) {
              record("payload", value);
              break;
            }

            if (value && typeof value === "object" && typeof value.length === "number" && value.length > 1000) {
              record("cipher", {
                position: index,
                arity: args.length,
                key: index > 0 && args[0] && args[0].length ? hexOf(args[0]) : null,
                iv: index > 1 && args[1] && args[1].length ? hexOf(args[1]) : null,
                data: hexOf(value),
              });
              break;
            }
          }

          return Reflect.apply(target, self, args);
        },
      });
    };

    var rewrite = function (source) {
      if (!env.debugFunctions) return source;

      return String(source)
        .replace(/i\[0\]\s*\[\s*e\(n\)\s*\]/g, "__KT.glob(e(n))")
        .replace(/e\(n\)\s*\[\s*e\(n\)\s*\]\s*=/g, "__KT.get(e(n),e(n))=")
        .replace(/e\(n\)\s*\[\s*e\(n\)\s*\]/g, "__KT.get(e(n),e(n))")
        .replace(/__KT\.get\(e\(n\),e\(n\)\)=/g, "e(n)[e(n)]=");
    };

    var rewriteArgs = function (args) {
      var copy = Array.prototype.slice.call(args);
      if (copy.length) copy[copy.length - 1] = rewrite(copy[copy.length - 1]);
      env.functionSources.push(copy[copy.length - 1]);
      return copy;
    };

    var functionProxy = new Proxy(RealFunction, {
      construct: function (target, args) {
        return watch(Reflect.construct(target, rewriteArgs(args)));
      },
      apply: function (target, self, args) {
        return watch(target.apply(self, rewriteArgs(args)));
      },
    });

    globalThis.Function = functionProxy;

    try {
      Object.defineProperty(Function.prototype, "constructor", {
        value: functionProxy,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } catch (error) {}
  }

  // Timer id -> its callback, or for setTimeout/setInterval { callback, every, extra, nesting }
  // (`every`, an interval's period, makes it fire again until cleared).
  var timers = new Map();
  var nextTimer = 1;

  // Chrome's timer nesting: a timer set while another runs is one level deeper (an interval goes
  // one deeper each time it repeats), and from the fifth level a delay under 4 ms becomes 4 ms.
  var MAX_NESTING = 5;
  var CLAMP_MS = 4;
  var nesting = 0;

  // A timer's delay as a browser reads it: converted to a number, never negative, clamped once
  // timers nest deep.
  var delayOf = function (delay, level) {
    var ms = Number(delay);
    ms = isFinite(ms) && ms > 0 ? ms : 0;
    return level >= MAX_NESTING && ms < CLAMP_MS ? CLAMP_MS : ms;
  };

  var schedule = function (label, callback, delay, extra, repeat) {
    var id = nextTimer++;
    var level = nesting + 1;
    var wait = delayOf(delay, level);
    env.count(label + ":" + String(typeof delay === "number" ? delay : 0));
    timers.set(id, { callback: callback, every: repeat ? Number(delay) : undefined, extra: extra, nesting: level });
    bridge.schedule(id, wait, extra);
    return id;
  };

  globalThis.setTimeout = asNative(function setTimeout(callback, delay) {
    return schedule("setTimeout", callback, delay, Array.prototype.slice.call(arguments, 2), false);
  }, "setTimeout");

  globalThis.setInterval = asNative(function setInterval(callback, delay) {
    return schedule("setInterval", callback, delay, Array.prototype.slice.call(arguments, 2), true);
  }, "setInterval");

  globalThis.clearTimeout = asNative(function clearTimeout(id) {
    timers.delete(id);
    bridge.unschedule(id);
  }, "clearTimeout");

  globalThis.clearInterval = asNative(function clearInterval(id) {
    return globalThis.clearTimeout(id);
  }, "clearInterval");

  var noiseSeed = 0x2545f491;

  var noise = function () {
    noiseSeed ^= noiseSeed << 13;
    noiseSeed ^= noiseSeed >>> 17;
    noiseSeed ^= noiseSeed << 5;
    return (noiseSeed >>> 0) / 4294967296;
  };

  var noiseUuid = function () {
    var digits = "0123456789abcdef";
    var out = "";

    for (var index = 0; index < 36; index += 1) {
      if (index === 8 || index === 13 || index === 18 || index === 23) {
        out += "-";
        continue;
      }

      if (index === 14) {
        out += "4";
        continue;
      }

      var value = Math.floor(noise() * 16);
      if (index === 19) value = (value & 3) | 8;
      out += digits.charAt(value);
    }

    return out;
  };

  var nextInternal = -1;

  var later = function (callback, delay) {
    var id = nextInternal;
    nextInternal -= 1;
    timers.set(id, callback);
    bridge.schedule(id, delay, []);
    return id;
  };

  env.later = later;

  var frameCallbacks = new Map();
  var idleCallbacks = new Map();
  var nextFrameCallback = 1;
  var nextIdleCallback = 1;

  globalThis.requestAnimationFrame = asNative(function requestAnimationFrame(callback) {
    var id = nextFrameCallback;
    nextFrameCallback += 1;

    frameCallbacks.set(id, later(function () {
      frameCallbacks.delete(id);
      callback(env.clock());
    }, 16));

    return id;
  }, "requestAnimationFrame");

  globalThis.cancelAnimationFrame = asNative(function cancelAnimationFrame(id) {
    var timer = frameCallbacks.get(id);
    if (timer === undefined) return undefined;
    frameCallbacks.delete(id);
    timers.delete(timer);
    bridge.unschedule(timer);
    return undefined;
  }, "cancelAnimationFrame");

  globalThis.requestIdleCallback = asNative(function requestIdleCallback(callback) {
    var id = nextIdleCallback;
    nextIdleCallback += 1;

    idleCallbacks.set(id, later(function () {
      idleCallbacks.delete(id);
      callback({ didTimeout: false, timeRemaining: function () { return 12; } });
    }, 24));

    return id;
  }, "requestIdleCallback");

  globalThis.cancelIdleCallback = asNative(function cancelIdleCallback(id) {
    var timer = idleCallbacks.get(id);
    if (timer === undefined) return undefined;
    idleCallbacks.delete(id);
    timers.delete(timer);
    bridge.unschedule(timer);
    return undefined;
  }, "cancelIdleCallback");

  globalThis.queueMicrotask = asNative(function queueMicrotask(callback) {
    Promise.resolve().then(callback);
  }, "queueMicrotask");

  env.fire = function (id, extra) {
    var entry = timers.get(id);
    if (!entry) return false;
    var callback = typeof entry === "function" ? entry : entry.callback;
    var level = typeof entry === "function" ? 0 : entry.nesting;

    // An interval goes round again before its callback runs, so the callback can clear it.
    if (typeof entry !== "function" && entry.every !== undefined) {
      entry.nesting = level + 1;
      bridge.schedule(id, delayOf(entry.every, entry.nesting), entry.extra);
    } else {
      timers.delete(id);
    }

    var outer = nesting;
    nesting = level;

    try {
      if (typeof callback === "function") callback.apply(null, extra || []);
      else if (typeof callback === "string") (0, eval)(callback);
    } finally {
      nesting = outer;
    }

    return true;
  };

  env.pendingTimers = function () {
    return timers.size;
  };

  // Event targets, as the DOM standard runs them: each target keeps its listeners per type, in the
  // order they were added (an event handler attribute holds its place from when it was first set),
  // a listener is added once per callback and capture flag, and `once` and `signal` take it out.
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

  var captureOf = function (options) {
    if (typeof options === "boolean") return options;
    return Boolean(options && (typeof options === "object" || typeof options === "function") && options.capture);
  };

  var takeOut = function (list, entry) {
    entry.removed = true;
    var at = list.indexOf(entry);
    if (at !== -1) list.splice(at, 1);
  };

  var addListener = function addEventListener(type, callback, options) {
    if (arguments.length < 2) {
      throw env.hideFrames(new TypeError("Failed to execute 'addEventListener' on 'EventTarget': 2 arguments required, but only " + arguments.length + " present."));
    }
    if (callback === null || callback === undefined) return undefined;
    if (typeof callback !== "function" && typeof callback !== "object") {
      throw env.hideFrames(new TypeError("Failed to execute 'addEventListener' on 'EventTarget': parameter 2 is not of type 'Object'."));
    }

    var detailed = options !== null && (typeof options === "object" || typeof options === "function");
    var capture = captureOf(options);
    var signal = detailed ? options.signal : undefined;
    if (signal && signalState.has(signal) && signalState.get(signal).aborted) return undefined;

    var list = listenersFor(this, String(type));

    for (var index = 0; index < list.length; index += 1) {
      if (!list[index].inline && list[index].callback === callback && list[index].capture === capture) return undefined;
    }

    var entry = {
      callback: callback,
      capture: capture,
      once: detailed && Boolean(options.once),
      passive: detailed && Boolean(options.passive),
      removed: false,
    };

    list.push(entry);

    if (signal && signalState.has(signal)) {
      signalState.get(signal).algorithms.push(function () { takeOut(list, entry); });
    }

    return undefined;
  };

  var removeListener = function removeEventListener(type, callback, options) {
    var capture = captureOf(options);
    var list = listenersFor(this, String(type));

    for (var index = 0; index < list.length; index += 1) {
      if (!list[index].inline && list[index].callback === callback && list[index].capture === capture) {
        takeOut(list, list[index]);
        break;
      }
    }

    return undefined;
  };

  // An event handler attribute (onload = ...) is a listener at the place it was first set; setting
  // it to null takes it out, and setting it again puts it at the end.
  env.handlerSet = function (target, type, value) {
    var list = listenersFor(target, type);
    var held = null;

    for (var index = 0; index < list.length; index += 1) {
      if (list[index].inline) held = list[index];
    }

    if (value === null || value === undefined || typeof value !== "function") {
      if (held) takeOut(list, held);
      return;
    }

    if (!held) list.push({ inline: true, capture: false, once: false, passive: false, removed: false });
  };

  var reportException = function (error) {
    var message = error && typeof error === "object" && "message" in error ? String(error.name || "Error") + ": " + String(error.message) : String(error);
    var stack = error && error.stack ? String(error.stack) : "";
    var where = /\((https?:[^)]*?):(\d+):(\d+)\)/.exec(stack) || /at (https?:\S*?):(\d+):(\d+)/.exec(stack);

    record("listenerError", { message: message });

    var event = makeEvent("error", {
      message: "Uncaught " + message,
      filename: where ? where[1] : "",
      lineno: where ? Number(where[2]) : 0,
      colno: where ? Number(where[3]) : 0,
      error: error,
      cancelable: true,
    }, "ErrorEvent");

    dispatch(globalThis, event);
  };

  env.reportException = reportException;

  // The node a target's event goes to next on its way up: its parent, then from the document the
  // window (except for "load", which a window hears from its own document only).
  var parentFor = function (target, event) {
    if (target === globalThis) return null;

    var parent = null;

    try {
      parent = target.parentNode;
    } catch (error) {
      return null;
    }

    if (parent) return parent;

    if (target === globalThis.document || (target && target.nodeType === 9)) {
      return event.type === "load" || target !== globalThis.document ? null : globalThis;
    }

    return null;
  };

  var invoke = function (target, event, fields, phase) {
    var list = listeners.get(target);
    list = list ? list.get(event.type) : null;
    if (!list || !list.length) return;

    var snapshot = list.slice();

    for (var index = 0; index < snapshot.length; index += 1) {
      var entry = snapshot[index];
      if (entry.removed) continue;
      if (phase === "capture" && !entry.capture) continue;
      if (phase === "bubble" && entry.capture) continue;
      if (entry.once) takeOut(list, entry);

      fields.passive = entry.passive;

      try {
        if (entry.inline) {
          var handler = target["on" + event.type];

          if (typeof handler === "function") {
            var returned = event.type === "error" && target === globalThis && event instanceof globalThis.ErrorEvent
              ? handler.call(target, fields.message, fields.filename, fields.lineno, fields.colno, fields.error)
              : handler.call(target, event);

            if (event.type === "error" && target === globalThis ? returned === true : returned === false) {
              if (fields.cancelable) fields.canceled = true;
            }
          }
        } else if (typeof entry.callback === "function") {
          entry.callback.call(target, event);
        } else {
          var handle = entry.callback.handleEvent;
          if (typeof handle !== "function") throw new TypeError("handleEvent is not a function");
          handle.call(entry.callback, event);
        }
      } catch (error) {
        fields.passive = false;
        if (event.type === "error" && target === globalThis) record("listenerError", { message: String(error && error.message) });
        else reportException(error);
      }

      fields.passive = false;
      if (fields.stopImmediate) return;
    }
  };

  var dispatch = function (target, event) {
    var fields = eventFields.get(event);

    if (!fields) {
      throw env.hideFrames(new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'."));
    }

    if (fields.dispatching) {
      throw domException("Failed to execute 'dispatchEvent' on 'EventTarget': The event is already being dispatched.", "InvalidStateError");
    }

    // A stop set before dispatch (cancelBubble = true) does not keep the target's own listeners
    // from running, and stays set afterwards, as in Chrome.
    var stoppedBefore = fields.stop;
    fields.stop = false;
    fields.dispatching = true;
    fields.target = target;
    fields.srcElement = target;

    var path = [target];

    for (var up = parentFor(target, event); up && path.length < 256; up = parentFor(up, event)) path.push(up);

    fields.path = path;

    for (var down = path.length - 1; down > 0 && !fields.stop; down -= 1) {
      fields.currentTarget = path[down];
      fields.eventPhase = 1;
      invoke(path[down], event, fields, "capture");
    }

    if (!fields.stop) {
      fields.currentTarget = target;
      fields.eventPhase = 2;
      invoke(target, event, fields, "capture");
      if (!fields.stop) invoke(target, event, fields, "bubble");
    }

    if (fields.bubbles) {
      for (var out = 1; out < path.length && !fields.stop; out += 1) {
        fields.currentTarget = path[out];
        fields.eventPhase = 3;
        invoke(path[out], event, fields, "bubble");
      }
    }

    fields.eventPhase = 0;
    fields.currentTarget = null;
    fields.path = [];
    fields.dispatching = false;
    fields.stop = fields.stop || stoppedBefore;
    fields.stopImmediate = false;

    return !fields.canceled;
  };

  env.dispatch = dispatch;

  // Abort controllers and signals: an aborted signal runs what was waiting on it (listeners added
  // with it come out), then fires "abort".
  var signalState = new WeakMap();

  var makeSignal = function () {
    var signal = Object.create(globalThis.AbortSignal.prototype);
    signalState.set(signal, { aborted: false, reason: undefined, algorithms: [] });
    return signal;
  };

  var abortSignal = function (signal, reason) {
    var state = signalState.get(signal);
    if (!state || state.aborted) return;

    state.aborted = true;
    state.reason = reason === undefined ? domException("signal is aborted without reason", "AbortError") : reason;

    var waiting = state.algorithms;
    state.algorithms = [];
    for (var index = 0; index < waiting.length; index += 1) waiting[index]();

    dispatch(signal, makeEvent("abort"));
  };

  var domException = function (message, name) {
    var made;

    try {
      made = new globalThis.DOMException(message, name);
    } catch (error) {
      made = new Error(message);
      made.name = name;
    }

    return made;
  };

  env.domException = domException;
  env.makeSignal = makeSignal;
  env.abortSignal = abortSignal;
  env.signalState = signalState;

  // The event a browser makes itself (isTrusted true), of the interface it fires: "load" is an
  // Event, a message a MessageEvent, a failed script an ErrorEvent. `extra` sets its fields.
  var makeEvent = function (type, extra, iface) {
    return createEvent(iface || "Event", type, extra || {}, true);
  };

  // A frame's document finished loading: its window hears "load" before the iframe element does.
  env.fireLoad = function () { dispatch(globalThis, makeEvent("load")); };

  env.makeEvent = makeEvent;
  env.hooks.handlerSet = env.handlerSet;

  var eventFields = new WeakMap();

  var eventInitMembers = function (name) {
    var recorded = traits.eventInit && traits.eventInit[name];
    if (!recorded) return null;

    var members = [];

    for (var index = 0; index < recorded.length; index += 1) {
      if (recorded[index].indexOf("g:") === 0) members.push(recorded[index].slice(2));
    }

    return members.length ? members : null;
  };

  var EVENT_CONSTRUCTORS = [
    "Event", "CustomEvent", "UIEvent", "MouseEvent", "PointerEvent", "KeyboardEvent", "WheelEvent",
    "FocusEvent", "InputEvent", "CompositionEvent", "MessageEvent", "ErrorEvent", "PromiseRejectionEvent",
    "ProgressEvent", "StorageEvent", "PageTransitionEvent", "HashChangeEvent", "PopStateEvent",
    "AnimationEvent", "TransitionEvent", "ClipboardEvent", "DragEvent", "SubmitEvent", "ToggleEvent",
    "SecurityPolicyViolationEvent", "GamepadEvent", "DeviceMotionEvent", "DeviceOrientationEvent",
    "TouchEvent", "MediaQueryListEvent", "CloseEvent", "OfflineAudioCompletionEvent",
    "RTCPeerConnectionIceEvent", "RTCDataChannelEvent", "SpeechSynthesisEvent", "SpeechSynthesisErrorEvent",
    "BlobEvent", "FormDataEvent", "TrackEvent", "MessageEvent", "BeforeUnloadEvent",
  ];

  var eventDefaults = {
    MouseEvent: { screenX: 0, screenY: 0, clientX: 0, clientY: 0, pageX: 0, pageY: 0, offsetX: 0, offsetY: 0, movementX: 0, movementY: 0, button: 0, buttons: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, relatedTarget: null, detail: 0, view: null },
    PointerEvent: { pointerId: 0, width: 1, height: 1, pressure: 0, tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0, pointerType: "", isPrimary: false, clientX: 0, clientY: 0, screenX: 0, screenY: 0, button: 0, buttons: 0, detail: 0, view: null },
    KeyboardEvent: { key: "", code: "", location: 0, repeat: false, isComposing: false, charCode: 0, keyCode: 0, which: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, detail: 0, view: null },
    CustomEvent: { detail: null },
    UIEvent: { detail: 0, view: null },
    MessageEvent: { data: null, origin: "", lastEventId: "", source: null, ports: [] },
    ProgressEvent: { lengthComputable: false, loaded: 0, total: 0 },
    ErrorEvent: { message: "", filename: "", lineno: 0, colno: 0, error: null },
    CloseEvent: { wasClean: false, code: 0, reason: "" },
    PageTransitionEvent: { persisted: false },
    PromiseRejectionEvent: { promise: null, reason: undefined },
    OfflineAudioCompletionEvent: { renderedBuffer: null },
    RTCPeerConnectionIceEvent: { candidate: null, url: null },
    MediaQueryListEvent: { media: "", matches: false },
  };

  var eventProto = function (iface) {
    var holder = globalThis[iface];
    return holder && holder.prototype ? holder.prototype : globalThis.Event.prototype;
  };

  // Each event's own `isTrusted`, one getter for them all, as Chrome's [LegacyUnforgeable] field.
  var isTrustedGetter = asNative(function () {
    var state = eventFields.get(this);
    return state ? state.isTrusted : undefined;
  }, "get isTrusted");

  var fieldGetters = Object.create(null);

  var fieldGetter = function (field) {
    if (!fieldGetters[field]) {
      fieldGetters[field] = asNative(function () {
        var state = eventFields.get(this);
        return state ? state[field] : undefined;
      }, "get " + field);
    }
    return fieldGetters[field];
  };

  // An interface's fields read the event's state, as prototype getters (Chrome's shape): those the
  // capture recorded keep their place, and any it lacks are added.
  var defineEventFields = function (holder, fields) {
    if (!holder) return;

    for (var index = 0; index < fields.length; index += 1) {
      var field = fields[index];
      var setter;

      if (field === "returnValue") {
        setter = asNative(function (value) {
          var state = eventFields.get(this);
          if (state && !value && state.cancelable && !state.passive) state.canceled = true;
        }, "set returnValue");
      } else if (field === "cancelBubble") {
        setter = asNative(function (value) {
          var state = eventFields.get(this);
          if (state && value) state.stop = true;
        }, "set cancelBubble");
      }

      try {
        Object.defineProperty(holder, field, { get: fieldGetter(field), set: setter, enumerable: true, configurable: true });
      } catch (error) {}
    }
  };

  var COMMON_EVENT_FIELDS = [
    "type", "bubbles", "cancelable", "composed", "defaultPrevented", "eventPhase", "timeStamp",
    "target", "currentTarget", "srcElement", "returnValue", "cancelBubble",
  ];

  var definedOn = new WeakMap();

  var ensureFields = function (iface, keys) {
    var holder = eventProto(iface);
    var done = definedOn.get(holder);

    if (!done) {
      done = Object.create(null);
      definedOn.set(holder, done);
    }

    var missing = [];

    for (var index = 0; index < keys.length; index += 1) {
      if (!done[keys[index]]) {
        done[keys[index]] = true;
        missing.push(keys[index]);
      }
    }

    if (missing.length) defineEventFields(holder, missing);
  };

  // A new event of `iface`: its state lives beside it (the prototype's getters read it), and its
  // one own property is `isTrusted`.
  var createEvent = function (iface, type, init, trusted) {
    var made = Object.create(eventProto(iface));
    var fields = {
      type: String(type),
      bubbles: false,
      cancelable: false,
      composed: false,
      eventPhase: 0,
      isTrusted: Boolean(trusted),
      timeStamp: env.clock(),
      target: null,
      currentTarget: null,
      srcElement: null,
      canceled: false,
      stop: false,
      stopImmediate: false,
      passive: false,
      dispatching: false,
      path: [],
      initialized: true,
    };

    var defaults = eventDefaults[iface];
    if (defaults) for (var key in defaults) fields[key] = Array.isArray(defaults[key]) ? [] : defaults[key];

    if (init !== null && init !== undefined && (typeof init === "object" || typeof init === "function")) {
      var members = trusted ? null : eventInitMembers(iface);

      if (members) {
        for (var at = 0; at < members.length; at += 1) {
          var value = init[members[at]];
          if (value !== undefined) fields[members[at]] = value;
        }
      } else {
        var extra = [];

        for (var given in init) {
          if (!(given in fields)) extra.push(given);
          fields[given] = init[given];
        }

        if (extra.length) ensureFields(iface, extra);
      }

      fields.bubbles = Boolean(fields.bubbles);
      fields.cancelable = Boolean(fields.cancelable);
      fields.composed = Boolean(fields.composed);
    }

    eventFields.set(made, fields);
    env.overrides.set(made, fields);

    Object.defineProperty(made, "isTrusted", { get: isTrustedGetter, set: undefined, enumerable: true, configurable: false });

    return made;
  };

  env.createEvent = createEvent;

  (function installEventPrototype() {
    var proto = globalThis.Event && globalThis.Event.prototype;
    if (!proto) return;

    defineEventFields(proto, COMMON_EVENT_FIELDS);

    patchGetter(proto, "defaultPrevented", function () {
      var state = eventFields.get(this);
      return state ? state.canceled : undefined;
    });
    patchGetter(proto, "returnValue", function () {
      var state = eventFields.get(this);
      return state ? !state.canceled : undefined;
    });
    patchGetter(proto, "cancelBubble", function () {
      var state = eventFields.get(this);
      return state ? state.stop : undefined;
    });

    patch(proto, "preventDefault", function preventDefault() {
      var state = eventFields.get(this);
      if (state && state.cancelable && !state.passive) state.canceled = true;
    });
    patch(proto, "stopPropagation", function stopPropagation() {
      var state = eventFields.get(this);
      if (state) state.stop = true;
    });
    patch(proto, "stopImmediatePropagation", function stopImmediatePropagation() {
      var state = eventFields.get(this);
      if (state) {
        state.stop = true;
        state.stopImmediate = true;
      }
    });
    patch(proto, "composedPath", function composedPath() {
      var state = eventFields.get(this);
      return state && state.dispatching ? state.path.slice() : [];
    });
    patch(proto, "initEvent", function initEvent(type, bubbles, cancelable) {
      var state = eventFields.get(this);
      if (arguments.length < 1) throw env.hideFrames(new TypeError("Failed to execute 'initEvent' on 'Event': 1 argument required, but only 0 present."));
      if (!state || state.dispatching) return;
      state.type = String(type);
      state.bubbles = Boolean(bubbles);
      state.cancelable = Boolean(cancelable);
      state.canceled = false;
      state.stop = false;
      state.stopImmediate = false;
    });

    for (var name in eventDefaults) ensureFields(name, Object.keys(eventDefaults[name]));
  })();

  for (var eventIndex = 0; eventIndex < EVENT_CONSTRUCTORS.length; eventIndex += 1) {
    (function (name) {
      if (typeof globalThis[name] !== "function" || globalThis[name].__wreEventShell) return;

      var Original = globalThis[name];

      var Shell = function (type, init) {
        if (new.target === undefined) {
          throw env.hideFrames(new TypeError("Failed to construct '" + name + "': Please use the 'new' operator, this DOM object constructor cannot be called as a function."));
        }

        if (arguments.length === 0) {
          throw env.hideFrames(new TypeError("Failed to construct '" + name + "': 1 argument required, but only 0 present."));
        }

        var made = createEvent(name, type, init, false);
        if (new.target !== Shell) Object.setPrototypeOf(made, new.target.prototype);
        return made;
      };

      asNative(Shell, name);

      try {
        Object.defineProperty(Shell, "prototype", { value: Original.prototype, writable: false, enumerable: false, configurable: false });
        Object.defineProperty(Shell, "length", { value: 1, configurable: true });
        Object.defineProperty(Original.prototype, "constructor", { value: Shell, writable: true, enumerable: false, configurable: true });
        Object.defineProperty(globalThis, name, { value: Shell, writable: true, enumerable: false, configurable: true });
      } catch (error) {}
    })(EVENT_CONSTRUCTORS[eventIndex]);
  }

  // DOMException, as Chrome's: no own fields, its name, message and code read through prototype
  // getters, its code taken from the legacy table by name. One the platform throws also carries an
  // own `stack` accessor (see `env.domException`).
  var DOM_CODES = {
    IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5,
    NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10,
    InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14,
    InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20,
    URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25,
  };

  var exceptionState = new WeakMap();
  env.exceptionState = exceptionState;

  (function installDomException() {
    var Original = globalThis.DOMException;
    if (typeof Original !== "function" || !Original.prototype) return;

    var proto = Original.prototype;

    var build = function (message, name, target) {
      var made = Object.create(target || proto);
      var named = name === undefined ? "Error" : String(name);
      exceptionState.set(made, { message: message === undefined ? "" : String(message), name: named, code: DOM_CODES[named] || 0 });
      return made;
    };

    var Shell = function DOMException(message, name) {
      if (new.target === undefined) {
        throw env.hideFrames(new TypeError("Failed to construct 'DOMException': Please use the 'new' operator, this DOM object constructor cannot be called as a function."));
      }
      return build(message, name, new.target.prototype);
    };

    asNative(Shell, "DOMException");

    ["message", "name", "code"].forEach(function (field) {
      patchGetter(proto, field, function () {
        var state = exceptionState.get(this);
        if (!state) throw env.hideFrames(new TypeError("Illegal invocation"));
        return state[field];
      });
    });

    try {
      Object.defineProperty(Shell, "prototype", { value: proto, writable: false, enumerable: false, configurable: false });
      Object.defineProperty(Shell, "length", { value: 0, configurable: true });
      for (var legacy of Object.getOwnPropertyNames(Original)) {
        if (legacy === "prototype" || legacy === "length" || legacy === "name") continue;
        Object.defineProperty(Shell, legacy, Object.getOwnPropertyDescriptor(Original, legacy));
      }
      Object.defineProperty(proto, "constructor", { value: Shell, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(globalThis, "DOMException", { value: Shell, writable: true, enumerable: false, configurable: true });
    } catch (error) {}

    // One the platform throws: it carries the stack of where it was thrown, as an own accessor.
    domException = function (message, name) {
      var made = build(message, name);
      var trace = env.hideFrames(new Error(String(message)));
      var stack = String(trace.stack).replace(/^Error/, String(name));
      var held = { value: stack };
      Object.defineProperty(made, "stack", {
        get: asNative(function () { return held.value; }, "get stack"),
        set: asNative(function (value) { held.value = value; }, "set stack"),
        enumerable: false,
        configurable: true,
      });
      return made;
    };

    env.domException = domException;
  })();

  (function installAbort() {
    var Controller = globalThis.AbortController;
    var Signal = globalThis.AbortSignal;
    if (typeof Controller !== "function" || typeof Signal !== "function") return;

    var controllers = new WeakMap();
    env.abortControllers = controllers;

    var ControllerShell = function AbortController() {
      if (new.target === undefined) {
        throw env.hideFrames(new TypeError("Failed to construct 'AbortController': Please use the 'new' operator, this DOM object constructor cannot be called as a function."));
      }
      var made = Object.create(new.target.prototype);
      controllers.set(made, makeSignal());
      return made;
    };

    asNative(ControllerShell, "AbortController");

    patchGetter(Controller.prototype, "signal", function () {
      var signal = controllers.get(this);
      if (!signal) throw env.hideFrames(new TypeError("Illegal invocation"));
      return signal;
    });
    patch(Controller.prototype, "abort", function abort(reason) {
      var signal = controllers.get(this);
      if (!signal) throw env.hideFrames(new TypeError("Illegal invocation"));
      abortSignal(signal, reason);
    });

    var stateOf = function (signal) {
      var state = signalState.get(signal);
      if (!state) throw env.hideFrames(new TypeError("Illegal invocation"));
      return state;
    };

    patchGetter(Signal.prototype, "aborted", function () { return stateOf(this).aborted; });
    patchGetter(Signal.prototype, "reason", function () { return stateOf(this).reason; });
    patch(Signal.prototype, "throwIfAborted", function throwIfAborted() {
      var state = stateOf(this);
      if (state.aborted) throw state.reason;
    });

    var SignalShell = function AbortSignal() {
      throw env.hideFrames(new TypeError("Failed to construct 'AbortSignal': Illegal constructor"));
    };

    asNative(SignalShell, "AbortSignal");

    patch(SignalShell, "abort", function abort(reason) {
      var signal = makeSignal();
      abortSignal(signal, reason);
      return signal;
    });
    patch(SignalShell, "timeout", function timeout(ms) {
      if (arguments.length < 1) throw env.hideFrames(new TypeError("Failed to execute 'timeout' on 'AbortSignal': 1 argument required, but only 0 present."));
      var signal = makeSignal();
      env.later(function () { abortSignal(signal, domException("signal timed out", "TimeoutError")); }, Math.max(0, Number(ms) || 0));
      return signal;
    });
    patch(SignalShell, "any", function any(signals) {
      var signal = makeSignal();
      var list = Array.from(signals || []);

      for (var index = 0; index < list.length; index += 1) {
        var state = stateOf(list[index]);
        if (state.aborted) {
          abortSignal(signal, state.reason);
          return signal;
        }
      }

      list.forEach(function (source) {
        stateOf(source).algorithms.push(function () { abortSignal(signal, stateOf(source).reason); });
      });

      return signal;
    });


    try {
      Object.defineProperty(ControllerShell, "prototype", { value: Controller.prototype, writable: false, enumerable: false, configurable: false });
      Object.defineProperty(ControllerShell, "length", { value: 0, configurable: true });
      Object.defineProperty(Controller.prototype, "constructor", { value: ControllerShell, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(globalThis, "AbortController", { value: ControllerShell, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(SignalShell, "prototype", { value: Signal.prototype, writable: false, enumerable: false, configurable: false });
      Object.defineProperty(SignalShell, "length", { value: 0, configurable: true });
      Object.defineProperty(Signal.prototype, "constructor", { value: SignalShell, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(globalThis, "AbortSignal", { value: SignalShell, writable: true, enumerable: false, configurable: true });
    } catch (error) {}
  })();

  // Blobs and files hold their bytes (a Uint8Array) and type beside them; everything that reads a
  // blob (FileReader, Response, object URLs, workers, streams) reads it through `env.blobBytes`.
  var blobState = new WeakMap();

  var blobType = function (type) {
    var text = type === undefined ? "" : String(type);
    return /^[\x20-\x7e]*$/.test(text) ? text.toLowerCase() : "";
  };

  var partBytes = function (part, endings) {
    if (part !== null && typeof part === "object") {
      if (blobState.has(part)) return blobState.get(part).bytes;
      if (part instanceof ArrayBuffer) return new Uint8Array(part.slice(0));
      if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
    }

    var text = String(part);
    if (endings === "native") text = text.replace(/\r\n|\r/g, "\n");
    return utf8Encode(text);
  };

  var joinBytes = function (chunks) {
    var size = 0;
    for (var index = 0; index < chunks.length; index += 1) size += chunks[index].length;
    var out = new Uint8Array(size);
    var at = 0;
    for (var next = 0; next < chunks.length; next += 1) {
      out.set(chunks[next], at);
      at += chunks[next].length;
    }
    return out;
  };

  env.joinBytes = joinBytes;
  env.utf8Encode = utf8Encode;

  var blobOf = function (holder, method) {
    var state = blobState.get(holder);
    if (!state) throw env.hideFrames(new TypeError("Illegal invocation"));
    return state;
  };

  // A new Blob (or File) holding `bytes`, made as the page's own constructor would make it.
  var makeBlob = function (bytes, type, file) {
    var made = Object.create((file ? globalThis.File : globalThis.Blob).prototype);
    var state = { bytes: bytes, type: blobType(type) };
    if (file) {
      state.name = String(file.name);
      state.lastModified = file.lastModified;
    }
    blobState.set(made, state);
    return made;
  };

  env.makeBlob = makeBlob;
  env.blobBytes = function (blob) {
    var state = blobState.get(blob);
    return state ? state.bytes : null;
  };
  env.blobTypeOf = function (blob) {
    var state = blobState.get(blob);
    return state ? state.type : null;
  };

  (function installBlob() {
    var shape = traits.blob;
    var Original = globalThis.Blob;

    if (typeof Original !== "function" || !Original.prototype) return;

    var readParts = function (parts, options, where) {
      if (parts !== undefined) {
        var iterator = parts === null ? undefined : parts[Symbol.iterator];

        if (typeof iterator !== "function") {
          throw env.hideFrames(new TypeError(shape && shape.thrown ? shape.thrown.message.replace("'Blob'", "'" + where + "'") : "Failed to construct '" + where + "': The object must have a callable @@iterator property."));
        }
      }

      var type = "";
      var endings = "transparent";

      if (options !== null && options !== undefined && (typeof options === "object" || typeof options === "function")) {
        var members = (shape && shape.options) || ["g:endings", "g:type"];

        for (var index = 0; index < members.length; index += 1) {
          if (members[index].indexOf("g:") !== 0) continue;
          var member = members[index].slice(2);
          var value = options[member];
          if (member === "type" && value !== undefined) type = value;
          if (member === "endings" && value !== undefined) {
            endings = String(value);
            if (endings !== "transparent" && endings !== "native") {
              throw env.hideFrames(new TypeError("Failed to construct '" + where + "': Failed to read the 'endings' property from 'BlobPropertyBag': The provided value '" + endings + "' is not a valid enum value of type EndingType."));
            }
          }
        }
      } else if (options !== undefined && options !== null) {
        throw env.hideFrames(new TypeError("Failed to construct '" + where + "': The provided value is not of type 'BlobPropertyBag'."));
      }

      var chunks = [];
      if (parts !== undefined && parts !== null) for (var part of parts) chunks.push(partBytes(part, endings));
      return { bytes: joinBytes(chunks), type: type };
    };

    var Shell = function Blob(parts, options) {
      if (new.target === undefined) {
        throw env.hideFrames(new TypeError("Failed to construct 'Blob': Please use the 'new' operator, this DOM object constructor cannot be called as a function."));
      }

      var read = readParts(parts, options, "Blob");
      var made = makeBlob(read.bytes, read.type);
      if (new.target !== Shell) Object.setPrototypeOf(made, new.target.prototype);
      return made;
    };

    asNative(Shell, "Blob");

    var proto = Original.prototype;

    patchGetter(proto, "size", function () { return blobOf(this).bytes.length; });
    patchGetter(proto, "type", function () { return blobOf(this).type; });

    patch(proto, "slice", function slice(start, end, contentType) {
      var bytes = blobOf(this).bytes;
      var size = bytes.length;
      var clamp = function (value, fallback) {
        if (value === undefined) return fallback;
        var at = Math.trunc(Number(value)) || 0;
        return at < 0 ? Math.max(size + at, 0) : Math.min(at, size);
      };
      var from = clamp(start, 0);
      var to = clamp(end, size);
      return makeBlob(bytes.slice(from, Math.max(from, to)), contentType === undefined ? "" : contentType);
    });

    // Reading a blob completes as a task, as Chrome's blob reads do.
    var settleLater = function (value) {
      return new Promise(function (resolve) { env.later(function () { resolve(value()); }, 0); });
    };

    patch(proto, "text", function text() {
      var bytes = blobOf(this).bytes;
      return settleLater(function () { return env.decodeUtf8(bytes); });
    });
    patch(proto, "arrayBuffer", function arrayBuffer() {
      var bytes = blobOf(this).bytes;
      return settleLater(function () { return bytes.slice(0).buffer; });
    });
    if (typeof proto.bytes === "function") {
      patch(proto, "bytes", function bytes() {
        var held = blobOf(this).bytes;
        return settleLater(function () { return held.slice(0); });
      });
    }

    try {
      Object.defineProperty(Shell, "prototype", { value: proto, writable: false, enumerable: false, configurable: false });
      Object.defineProperty(Shell, "length", { value: 0, configurable: true });
      Object.defineProperty(proto, "constructor", { value: Shell, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(globalThis, "Blob", { value: Shell, writable: true, enumerable: false, configurable: true });
    } catch (error) {}

    var OriginalFile = globalThis.File;
    if (typeof OriginalFile !== "function" || !OriginalFile.prototype) return;

    var FileShell = function File(parts, name, options) {
      if (new.target === undefined) {
        throw env.hideFrames(new TypeError("Failed to construct 'File': Please use the 'new' operator, this DOM object constructor cannot be called as a function."));
      }
      if (arguments.length < 2) {
        throw env.hideFrames(new TypeError("Failed to construct 'File': 2 arguments required, but only " + arguments.length + " present."));
      }

      var read = readParts(parts, options, "File");
      var modified = options && options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
      var made = makeBlob(read.bytes, read.type, { name: name, lastModified: Math.trunc(modified) || 0 });
      if (new.target !== FileShell) Object.setPrototypeOf(made, new.target.prototype);
      return made;
    };

    asNative(FileShell, "File");

    var fileProto = OriginalFile.prototype;

    patchGetter(fileProto, "name", function () { return blobOf(this).name; });
    patchGetter(fileProto, "lastModified", function () { return blobOf(this).lastModified; });
    patchGetter(fileProto, "lastModifiedDate", function () { return new Date(blobOf(this).lastModified); });
    patchGetter(fileProto, "webkitRelativePath", function () { blobOf(this); return ""; });

    try {
      Object.defineProperty(FileShell, "prototype", { value: fileProto, writable: false, enumerable: false, configurable: false });
      Object.defineProperty(FileShell, "length", { value: 2, configurable: true });
      Object.defineProperty(fileProto, "constructor", { value: FileShell, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(globalThis, "File", { value: FileShell, writable: true, enumerable: false, configurable: true });
    } catch (error) {}
  })();

  env.eventFields = eventFields;

  var document = globalThis.document;
  var Document = globalThis.Document;
  var Element = globalThis.Element;
  var HTMLElement = globalThis.HTMLElement;
  var Node = protoOf(Element && Element.prototype) ? (Element.prototype && protoOf(Element.prototype).constructor) : null;
  var EventTargetPrototype = Node && Node.prototype ? protoOf(Node.prototype) : null;

  var targets = [EventTargetPrototype || (Document && Document.prototype), globalThis];

  for (var t = 0; t < targets.length; t += 1) {
    if (!targets[t]) continue;
    patch(targets[t], "addEventListener", addListener);
    patch(targets[t], "removeEventListener", removeListener);
    patch(targets[t], "dispatchEvent", function dispatchEvent(event) { return dispatch(this, event); });
  }

  var dashedName = function (key) {
    return String(key).replace(/^webkit/, "-webkit-").replace(/([A-Z])/g, function (match) { return "-" + match.toLowerCase(); });
  };

  var camelNames = null;
  var camelSet = null;
  var camelEnumerable = null;

  var styleNames = function () {
    if (camelNames !== null) return camelNames;

    var shape = env.styleShape;
    camelNames = shape && shape.camel && shape.camel.length ? shape.camel : [];
    camelSet = Object.create(null);
    camelEnumerable = Object.create(null);

    for (var index = 0; index < camelNames.length; index += 1) camelSet[camelNames[index]] = true;

    var enumerable = shape && Array.isArray(shape.keys) ? shape.keys : camelNames;
    for (var at = 0; at < enumerable.length; at += 1) camelEnumerable[enumerable[at]] = true;

    return camelNames;
  };

  var styleProtoOf = function () {
    try {
      return globalThis.CSSStyleDeclaration ? globalThis.CSSStyleDeclaration.prototype : null;
    } catch (error) {
      return null;
    }
  };

  var styleOwners = new WeakMap();

  // Each style object's parser, so setting the style attribute re-reads the declarations.
  var styleParsers = new WeakMap();

  var makeStyle = function (owner) {
    var values = Object.create(null);
    var order = [];

    var reparse = function (text) {
      order.length = 0;
      for (var name in values) delete values[name];
      var declarations = String(text).split(";");
      for (var index = 0; index < declarations.length; index += 1) {
        var pair = declarations[index].split(":");
        if (pair.length < 2) continue;
        write(pair[0].trim(), pair.slice(1).join(":").trim(), true);
      }
    };

    // A declaration changed: the element's style attribute follows (an observer hears it).
    var reflect = function () {
      if (owner && nodeState(owner)) setAttr(owner, "style", cssText(), true);
    };

    var write = function (key, value, quiet) {
      var name = dashedName(key);
      var text = value === null || value === undefined ? "" : String(value);

      if (!text) {
        if (name in values) {
          delete values[name];
          order.splice(order.indexOf(name), 1);
          if (!quiet) reflect();
        }

        return;
      }

      if (!(name in values)) order.push(name);
      values[name] = text;
      if (!quiet) reflect();
    };

    var cssText = function () {
      var parts = [];
      for (var index = 0; index < order.length; index += 1) parts.push(order[index] + ": " + values[order[index]] + ";");
      return parts.join(" ");
    };

    var members = {
      getPropertyValue: asNative(function getPropertyValue(key) { return values[dashedName(key)] || ""; }, "getPropertyValue"),
      getPropertyPriority: asNative(function getPropertyPriority() { return ""; }, "getPropertyPriority"),
      setProperty: asNative(function setProperty(key, value) { write(key, value); }, "setProperty"),
      removeProperty: asNative(function removeProperty(key) {
        var name = dashedName(key);
        var had = values[name] || "";
        write(name, "");
        return had;
      }, "removeProperty"),
      item: asNative(function item(index) { return order[Number(index)] || ""; }, "item"),
    };

    var style = new Proxy(members, {
      get: function (target, key) {
        if (key === "length") return order.length;
        if (key === "cssText") return cssText();
        if (key === "parentRule") return null;
        if (key in target) return target[key];
        if (typeof key !== "string") return undefined;
        if (/^\d+$/.test(key)) return order[Number(key)];
        return values[dashedName(key)] || "";
      },
      set: function (target, key, value) {
        if (key === "cssText") {
          reparse(value);
          reflect();
          return true;
        }

        write(key, value);
        return true;
      },
      has: function (target, key) {
        if (key === "length" || key === "cssText" || key === "parentRule") return true;
        if (key in target) return true;
        return typeof key === "string" && dashedName(key) in values;
      },
      getPrototypeOf: function () {
        return styleProtoOf() || Object.prototype;
      },
      ownKeys: function (target) {
        var camel = styleNames();
        if (!camel.length) return order.concat(["length", "cssText"]);

        var keys = [];
        for (var index = 0; index < order.length; index += 1) keys.push(String(index));
        return keys.concat(camel);
      },
      getOwnPropertyDescriptor: function (target, key) {
        var camel = styleNames();

        if (!camel.length) {
          if (key === "length") return { value: order.length, writable: false, enumerable: true, configurable: true };
          if (key === "cssText") return { value: cssText(), writable: true, enumerable: true, configurable: true };
          if (typeof key === "string" && dashedName(key) in values) {
            return { value: values[dashedName(key)], writable: true, enumerable: true, configurable: true };
          }

          return Object.getOwnPropertyDescriptor(target, key);
        }

        if (typeof key !== "string") return undefined;

        if (/^\d+$/.test(key)) {
          if (Number(key) >= order.length) return undefined;
          return { value: order[Number(key)], writable: false, enumerable: true, configurable: true };
        }

        if (!camelSet[key]) return undefined;
        return { value: values[dashedName(key)] || "", writable: true, enumerable: camelEnumerable[key] === true, configurable: true };
      },
    });

    styleParsers.set(style, reparse);
    return style;
  };

  var canvasSample = sampleOf("document.createElement(canvas)");
  var divSample = sampleOf("document.createElement(div)");
  var iframeSample = sampleOf("document.createElement(iframe)");
  var videoSample = sampleOf("document.createElement(video)");
  var audioSample = sampleOf("document.createElement(audio)");

  var INTERFACE_FOR_TAG = {
    a: "HTMLAnchorElement", area: "HTMLAreaElement", audio: "HTMLAudioElement", base: "HTMLBaseElement",
    blockquote: "HTMLQuoteElement", body: "HTMLBodyElement", br: "HTMLBRElement", button: "HTMLButtonElement",
    canvas: "HTMLCanvasElement", caption: "HTMLTableCaptionElement", col: "HTMLTableColElement",
    colgroup: "HTMLTableColElement", data: "HTMLDataElement", datalist: "HTMLDataListElement",
    del: "HTMLModElement", details: "HTMLDetailsElement", dialog: "HTMLDialogElement", dir: "HTMLDirectoryElement",
    div: "HTMLDivElement", dl: "HTMLDListElement", embed: "HTMLEmbedElement", fieldset: "HTMLFieldSetElement",
    font: "HTMLFontElement", form: "HTMLFormElement", frame: "HTMLFrameElement", frameset: "HTMLFrameSetElement",
    h1: "HTMLHeadingElement", h2: "HTMLHeadingElement", h3: "HTMLHeadingElement", h4: "HTMLHeadingElement",
    h5: "HTMLHeadingElement", h6: "HTMLHeadingElement", head: "HTMLHeadElement", hr: "HTMLHRElement",
    html: "HTMLHtmlElement", iframe: "HTMLIFrameElement", img: "HTMLImageElement", input: "HTMLInputElement",
    ins: "HTMLModElement", label: "HTMLLabelElement", legend: "HTMLLegendElement", li: "HTMLLIElement",
    link: "HTMLLinkElement", map: "HTMLMapElement", marquee: "HTMLMarqueeElement", menu: "HTMLMenuElement",
    meta: "HTMLMetaElement", meter: "HTMLMeterElement", object: "HTMLObjectElement", ol: "HTMLOListElement",
    optgroup: "HTMLOptGroupElement", option: "HTMLOptionElement", output: "HTMLOutputElement",
    p: "HTMLParagraphElement", param: "HTMLParamElement", picture: "HTMLPictureElement", pre: "HTMLPreElement",
    progress: "HTMLProgressElement", q: "HTMLQuoteElement", script: "HTMLScriptElement", select: "HTMLSelectElement",
    slot: "HTMLSlotElement", source: "HTMLSourceElement", span: "HTMLSpanElement", style: "HTMLStyleElement",
    table: "HTMLTableElement", tbody: "HTMLTableSectionElement", td: "HTMLTableCellElement",
    template: "HTMLTemplateElement", textarea: "HTMLTextAreaElement", tfoot: "HTMLTableSectionElement",
    th: "HTMLTableCellElement", thead: "HTMLTableSectionElement", time: "HTMLTimeElement", title: "HTMLTitleElement",
    tr: "HTMLTableRowElement", track: "HTMLTrackElement", ul: "HTMLUListElement", video: "HTMLVideoElement",
    xmp: "HTMLPreElement",
  };

  var PLAIN_TAGS = ("abbr address article aside b bdi bdo cite code dd dfn dt em figcaption figure footer header " +
    "hgroup i kbd main mark nav noscript rp rt ruby s samp search section small strong sub summary sup u var wbr " +
    "acronym big center nobr plaintext strike tt").split(" ");

  var prototypeFor = function (tag) {
    var name = INTERFACE_FOR_TAG[tag];

    if (!name) {
      if (PLAIN_TAGS.indexOf(tag) !== -1 || tag.indexOf("-") !== -1) name = "HTMLElement";
      else name = "HTMLUnknownElement";
    }

    var constructor = globalThis[name];
    if (constructor && constructor.prototype) return constructor.prototype;

    var sample =
      tag === "canvas" ? canvasSample :
      tag === "iframe" ? iframeSample :
      tag === "video" ? videoSample :
      tag === "audio" ? audioSample :
      divSample;

    return sample ? protoOf(sample) : (globalThis.HTMLElement && globalThis.HTMLElement.prototype) || Object.prototype;
  };

  var elementCount = 0;
  var canvasCount = 0;

  // Every node's state, in one table the window and its frames share (they are realms of one
  // isolate): a node one document made can be put in another, which adopts it, as in Chrome.
  var elementState = globalThis.__NODES || new WeakMap();
  delete globalThis.__NODES;

  var nodeState = function (node) {
    try {
      return elementState.get(node) || null;
    } catch (error) {
      return null;
    }
  };

  env.nodeState = nodeState;

  var NODE_FIELDS = [
    "nodeName", "nodeType", "parentNode", "parentElement", "firstChild", "lastChild", "nextSibling",
    "previousSibling", "ownerDocument", "childNodes",
  ];

  var ELEMENT_FIELDS = [
    "tagName", "localName", "className", "id", "children", "attributes", "outerHTML",
    "firstElementChild", "lastElementChild", "childElementCount", "previousElementSibling", "nextElementSibling",
  ];
  var HTML_FIELDS = ["style", "innerText", "offsetWidth", "offsetHeight"];

  var inherited = function (previous, self) {
    if (!previous) return undefined;
    if (previous.get) return previous.get.call(self);
    return previous.value;
  };

  var installFields = function (prototype, fields) {
    if (!prototype) return;

    for (var index = 0; index < fields.length; index += 1) {
      (function (field) {
        try {
          var previous = Object.getOwnPropertyDescriptor(prototype, field);

          Object.defineProperty(prototype, field, {
            get: asNative(function () {
              var state = nodeState(this);
              if (state && field === "childNodes") return childNodesOf(this);
              if (state && field === "children") return childrenOf(this);
              if (state) return state[field];
              return inherited(previous, this);
            }, "get " + field),
            // Only what Chrome lets a page set (id, className, style, innerText) has a setter.
            set: previous && previous.set ? asNative(function (value) {
              var state = nodeState(this);
              if (state && (field === "id" || field === "className") && state.nodeType === 1) setAttr(this, field === "id" ? "id" : "class", String(value));
              else if (state) state[field] = value;
              else previous.set.call(this, value);
            }, "set " + field) : undefined,
            enumerable: previous ? previous.enumerable : true,
            configurable: true,
          });
        } catch (error) {}
      })(fields[index]);
    }
  };

  var layoutTable = null;
  var layoutMisses = [];

  // The markup or text a script last gave an element whole (innerHTML or textContent), as it gave
  // it: the layout the capture recorded is keyed by that source, which re-serialising the parsed
  // children would not always reproduce (whitespace, attribute quoting). Any other change to the
  // children forgets it.
  var forgetLayoutSource = function (node) {
    var state = nodeState(node);
    if (state) state.layoutSource = undefined;
  };

  var layoutTexts = function (element, state) {
    var texts = [];
    if (typeof state.layoutSource === "string") texts.push(state.layoutSource);
    if (state.childNodes && state.childNodes.length) {
      texts.push(serializeChildren(element, 0, Boolean(RAW_TEXT_TAGS[state.tag])));
      texts.push(textOf(element));
    }
    if (state.html) texts.push(state.html);
    if (!texts.length) texts.push("");
    return texts;
  };

  var layoutKey = function (element, text) {
    var state = nodeState(element);
    if (!state) return null;

    var css = "";

    try {
      css = String(state.style.cssText || "");
    } catch (error) {}

    var attrs = [];

    try {
      var names = Object.keys(state.attrs || {}).sort();

      for (var index = 0; index < names.length; index += 1) {
        if (names[index] === "style") continue;
        attrs.push(names[index] + "=" + String(state.attrs[names[index]]).slice(0, 60));
      }
    } catch (error) {}

    var value = "";

    try {
      if (typeof element.value === "string") value = element.value.slice(0, 80);
    } catch (error) {}

    return state.tag + "|" + css + "|" + attrs.join(" ") + "|" + value + "|" + String(text).slice(0, 400);
  };

  var noteLayout = function (key) {
    if (layoutMisses.length < 400 && layoutMisses.indexOf(key) === -1) layoutMisses.push(key);
  };

  // The layout the capture recorded for an element like this one, or null (noted as a miss).
  var recordedLayout = function (element) {
    var state = nodeState(element);
    if (!state) return null;

    if (!layoutTable) layoutTable = env.layout || null;
    var texts = layoutTexts(element, state);

    for (var index = 0; index < texts.length; index += 1) {
      var found = layoutTable ? layoutTable[layoutKey(element, texts[index])] : null;
      if (found) return found;
    }

    noteLayout(layoutKey(element, texts[0]));
    return null;
  };

  env.boxOf = function (element) {
    var empty = { x: 0, y: 0, width: 0, height: 0 };
    var found = recordedLayout(element);
    if (!found) return empty;

    return { x: found.x || 0, y: found.y || 0, width: found.width || 0, height: found.height || 0 };
  };

  var viewportFacts = env.viewport || null;

  var HIDDEN_TAGS = { script: 1, style: 1, link: 1, meta: 1, title: 1, head: 1, base: 1, template: 1, noscript: 1 };

  var INLINE_TAGS = {
    a: 1, abbr: 1, audio: 1, b: 1, bdi: 1, bdo: 1, br: 1, button: 1, canvas: 1, cite: 1, code: 1, data: 1,
    del: 1, dfn: 1, em: 1, embed: 1, i: 1, iframe: 1, img: 1, input: 1, ins: 1, kbd: 1, label: 1, map: 1,
    mark: 1, meter: 1, object: 1, output: 1, picture: 1, progress: 1, q: 1, ruby: 1, s: 1, samp: 1,
    select: 1, slot: 1, small: 1, span: 1, strong: 1, sub: 1, sup: 1, textarea: 1, time: 1, u: 1,
    "var": 1, video: 1, wbr: 1,
  };

  var strutHeight = traits.bodyStrut && typeof traits.bodyStrut.withInline === "number" ? traits.bodyStrut.withInline : 0;

  env.sizeOf = function (element, which) {
    if (viewportFacts) {
      var owner = nodeState(element);
      var recorded = owner && owner.tag === "html" ? viewportFacts.documentElement : owner && owner.tag === "body" ? viewportFacts.body : null;

      if (recorded && typeof recorded[which] === "number") {
        if (which !== "clientHeight" && which !== "scrollHeight") return recorded[which];
        if (recorded[which] > 0) return recorded[which];
      }
    }

    var state = nodeState(element);
    if (!state) return 0;
    var found = recordedLayout(element);

    var stacks = state && (state.tag === "body" || state.tag === "html");

    if (found && !(stacks && !found[which] && (which === "clientHeight" || which === "scrollHeight"))) {
      return found[which] || 0;
    }

    if (!stacks || (which !== "clientHeight" && which !== "scrollHeight")) return 0;

    var children = state.childNodes;
    if (!Array.isArray(children)) return 0;

    var total = 0;
    var inline = false;

    for (var index = 0; index < children.length; index += 1) {
      var child = children[index];
      var childState = nodeState(child);
      if (!childState || HIDDEN_TAGS[childState.tag]) continue;

      var display = "";

      try {
        display = String(childState.style.display || "");
      } catch (error) {}

      if (display === "none") continue;

      if (INLINE_TAGS[childState.tag] && display !== "block") {
        inline = true;
        continue;
      }

      total += env.sizeOf(child, "offsetHeight");
    }

    if (inline && strutHeight) total += strutHeight;

    return total;
  };

  env.layoutMisses = function () { return layoutMisses; };

  if (viewportFacts && viewportFacts.view) {
    var view = viewportFacts.view;

    var WINDOW_METRICS = [
      "innerWidth", "innerHeight", "outerWidth", "outerHeight", "screenX", "screenY",
      "pageXOffset", "pageYOffset", "devicePixelRatio",
    ];

    for (var metric = 0; metric < WINDOW_METRICS.length; metric += 1) {
      (function (field) {
        if (typeof view[field] !== "number") return;
        patchGetter(globalThis, field, function () {
          if (field === "pageXOffset" && globalThis[Symbol.for("wre.scroll")]) return globalThis[Symbol.for("wre.scroll")].x;
          if (field === "pageYOffset" && globalThis[Symbol.for("wre.scroll")]) return globalThis[Symbol.for("wre.scroll")].y;
          return view[field];
        });
      })(WINDOW_METRICS[metric]);
    }

    patchGetter(globalThis, "scrollX", function () {
      return (globalThis[Symbol.for("wre.scroll")] && globalThis[Symbol.for("wre.scroll")].x) || view.pageXOffset || 0;
    });
    patchGetter(globalThis, "scrollY", function () {
      return (globalThis[Symbol.for("wre.scroll")] && globalThis[Symbol.for("wre.scroll")].y) || view.pageYOffset || 0;
    });

    var visual = globalThis.visualViewport;

    if (visual) {
      var visualPrototype = protoOf(visual) || visual;
      if (typeof view.visualViewportWidth === "number") patchGetter(visualPrototype, "width", function () { return view.visualViewportWidth; });
      if (typeof view.visualViewportHeight === "number") patchGetter(visualPrototype, "height", function () { return view.visualViewportHeight; });
      if (typeof view.visualViewportScale === "number") patchGetter(visualPrototype, "scale", function () { return view.visualViewportScale; });
    }
  }

  var installMetrics = function (prototype, fields) {
    if (!prototype) return;

    for (var index = 0; index < fields.length; index += 1) {
      (function (field) {
        try {
          var previous = Object.getOwnPropertyDescriptor(prototype, field);

          Object.defineProperty(prototype, field, {
            get: asNative(function () {
              var state = nodeState(this);
              if (!state) return inherited(previous, this);
              return env.sizeOf(this, field);
            }, "get " + field),
            enumerable: previous ? previous.enumerable : true,
            configurable: true,
          });
        } catch (error) {}
      })(fields[index]);
    }
  };

  var installCounts = function (prototype) {
    if (!prototype) return;

    var fields = { childElementCount: "children" };

    for (var field in fields) {
      (function (name, source) {
        try {
          var previous = Object.getOwnPropertyDescriptor(prototype, name);

          Object.defineProperty(prototype, name, {
            get: asNative(function () {
              var state = nodeState(this);
              if (!state) return inherited(previous, this);
              var kids = state[source] || [];
              return kids.length;
            }, "get " + name),
            enumerable: previous ? previous.enumerable : true,
            configurable: true,
          });
        } catch (error) {}
      })(field, fields[field]);
    }
  };

  var installSizes = function (prototype) {
    if (!prototype) return;

    for (var side = 0; side < 2; side += 1) {
      (function (field) {
        try {
          var previous = Object.getOwnPropertyDescriptor(prototype, field);

          Object.defineProperty(prototype, field, {
            get: asNative(function () {
              var state = nodeState(this);
              if (state && field === "childNodes") return childNodesOf(this);
              if (state && field === "children") return childrenOf(this);
              if (state) return state[field];
              return inherited(previous, this);
            }, "get " + field),
            set: asNative(function (value) {
              var state = nodeState(this);
              if (!state) return;
              state[field] = Number(value) || 0;
              if (env.recordGraphics) env.recordGraphics(state.handle, "size", [field, state[field]]);
            }, "set " + field),
            enumerable: true,
            configurable: true,
          });
        } catch (error) {}
      })(side === 0 ? "width" : "height");
    }
  };

  var childFrames = [];

  var syncFrames = function () {
    for (var slot = 0; slot < 64; slot += 1) {
      try {
        if (Object.getOwnPropertyDescriptor(globalThis, String(slot))) delete globalThis[String(slot)];
      } catch (error) {}
    }

    for (var at = 0; at < childFrames.length; at += 1) {
      try {
        Object.defineProperty(globalThis, String(at), {
          value: childFrames[at].view,
          writable: false,
          enumerable: true,
          configurable: true,
        });
      } catch (error) {}
    }
  };

  try {
    Object.defineProperty(globalThis, "length", {
      get: asNative(function () { return childFrames.length; }, "get length"),
      enumerable: true,
      configurable: true,
    });
  } catch (error) {}

  var connected = function (node) {
    var current = node;

    for (var step = 0; current && step < 64; step += 1) {
      if (current === globalThis.document || (env.tree && (current === env.tree.body || current === env.tree.html || current === env.tree.head))) return true;
      current = current.parentNode;
    }

    return false;
  };

  var navigateFrame = function (element, view) {
    var state = nodeState(element);
    if (!state || !view) return;

    var src = state.attrs.src || state.src || "";
    if (!src || /^(about:|javascript:|data:)/.test(String(src))) return;

    var absolute;

    try {
      absolute = new globalThis.URL(String(src), globalThis.location.href).href;
    } catch (error) {
      return;
    }

    if (state.navigated === absolute) return;
    state.navigated = absolute;

    bridge.request("GET", absolute, JSON.stringify({ accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }), null, function (status, headerJson, text) {
      if (!text || typeof bridge.runInFrame !== "function") return;

      record("frameLoad", { url: absolute, status: status, bytes: text.length });
      if (typeof bridge.relocateFrame === "function") bridge.relocateFrame(view, absolute);

      var pattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
      var found;
      // Scripts still loading; once none is, the document has loaded and the iframe says so.
      var loading = 1;
      var loaded = function () {
        loading -= 1;
        if (loading !== 0) return;
        env.later(function () {
          // An iframe taken out before its document loaded never says it loaded.
          if (nodeState(element).frame !== view || !connected(element)) return;
          if (typeof bridge.frameLoaded === "function") bridge.frameLoaded(view);
          dispatch(element, makeEvent("load"));
        }, 0);
      };

      while ((found = pattern.exec(text))) {
        var attributes = found[1] || "";
        var inlineSource = found[2] || "";
        var srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes);

        if (!srcMatch) {
          if (inlineSource.trim()) bridge.runInFrame(view, inlineSource, absolute, true);
          continue;
        }

        (function (address) {
          var target;

          try {
            target = new globalThis.URL(address.replace(/&amp;/g, "&"), absolute).href;
          } catch (error) {
            return;
          }

          loading += 1;
          bridge.request("GET", target, JSON.stringify({ accept: "*/*", referer: absolute }), null, function (childStatus, childHeaders, childText) {
            if (childText) bridge.runInFrame(view, childText, target, false);
            loaded();
          });
        })(srcMatch[1]);
      }

      loaded();
    });
  };

  var attachFrame = function (element) {
    var state = nodeState(element);
    if (!state || state.tag !== "iframe" || state.frame) return;

    var view = bridge.createFrame(state.attrs.src || state.src || "", element);
    if (!view) return;

    state.frame = view;
    childFrames.push({ element: element, view: view });
    syncFrames();
    navigateFrame(element, view);
  };

  env.navigateFrame = navigateFrame;

  var detachFrame = function (element) {
    var state = nodeState(element);

    for (var at = 0; at < childFrames.length; at += 1) {
      if (childFrames[at].element !== element) continue;

      var released = childFrames.splice(at, 1)[0];
      if (state) state.frame = undefined;
      if (typeof bridge.releaseFrame === "function") bridge.releaseFrame(released.view);
      syncFrames();
      return;
    }
  };

  var walkFrames = function (node, visit, depth) {
    if (!node || typeof node !== "object" || (depth || 0) > 16) return;

    var state = nodeState(node);
    if (state && state.tag === "iframe") visit(node);

    var children = state ? state.childNodes : node.childNodes;
    if (!Array.isArray(children)) return;

    for (var at = 0; at < children.length; at += 1) walkFrames(children[at], visit, (depth || 0) + 1);
  };

  var installFrame = function (prototype) {
    if (!prototype) return;

    try {
      Object.defineProperty(prototype, "contentWindow", {
        get: asNative(function () {
          var state = nodeState(this);
          if (!state) return null;

          if (state.frame === undefined && connected(this)) attachFrame(this);

          return state.frame === undefined ? null : state.frame;
        }, "get contentWindow"),
        enumerable: true,
        configurable: true,
      });

      Object.defineProperty(prototype, "contentDocument", {
        get: asNative(function () {
          if (env.opaqueFrame(this)) return null;
          var frame = this.contentWindow;
          return frame ? frame.document : null;
        }, "get contentDocument"),
        enumerable: true,
        configurable: true,
      });
    } catch (error) {}
  };

  var RAW_TEXT_TAGS = { script: 1, style: 1, xmp: 1, iframe: 1, noembed: 1, noframes: 1, noscript: 1, plaintext: 1 };

  var escapeText = function (value) {
    return String(value).replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };

  var escapeAttribute = function (value) {
    return String(value).replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/"/g, "&quot;");
  };

  var serializeNode = function (node, depth, raw) {
    if (!node || depth > 32) return "";

    if (node.nodeType === 3) return raw ? String(node.textContent) : escapeText(node.textContent);
    if (node.nodeType === 8) return "<!--" + String(node.textContent === undefined ? "" : node.textContent) + "-->";

    var state = nodeState(node);
    if (!state) return "";

    var tag = state.tag;
    var out = "<" + tag;
    var names = Object.keys(state.attrs || {});

    for (var index = 0; index < names.length; index += 1) {
      out += " " + names[index] + '="' + escapeAttribute(state.attrs[names[index]]) + '"';
    }

    out += ">";
    if (VOID_TAGS[tag]) return out;

    return out + serializeChildren(node, depth, Boolean(RAW_TEXT_TAGS[tag])) + "</" + tag + ">";
  };

  var serializeChildren = function (node, depth, raw) {
    var state = nodeState(node);
    var children = state ? state.childNodes : node.childNodes;
    if (!Array.isArray(children)) return "";

    var out = "";
    for (var index = 0; index < children.length; index += 1) out += serializeNode(children[index], depth + 1, raw);
    return out;
  };

  env.serializeNode = serializeNode;
  env.serializeChildren = serializeChildren;

  var installMarkup = function (prototype) {
    if (!prototype) return;

    try {
      Object.defineProperty(prototype, "outerHTML", {
        get: asNative(function () {
          return serializeNode(this, 0, false);
        }, "get outerHTML"),
        set: asNative(function () {}, "set outerHTML"),
        enumerable: true,
        configurable: true,
      });
    } catch (error) {}

    try {
      Object.defineProperty(prototype, "innerHTML", {
        get: asNative(function () {
          var state = nodeState(this);
          if (!state) return "";
          if (state.childNodes.length) return serializeChildren(this, 0, Boolean(RAW_TEXT_TAGS[state.tag]));
          return state.html || "";
        }, "get innerHTML"),
        set: asNative(function (value) {
          var state = nodeState(this);
          if (!state) return;
          var holder = globalThis.document.createDocumentFragment();
          env.parseHtml(value === null ? "" : String(value), holder);
          state.html = "";
          replaceAll(this, childListOf(holder).slice());
          state.layoutSource = value === null ? "" : String(value);
          env.textChanged(this);
        }, "set innerHTML"),
        enumerable: true,
        configurable: true,
      });
    } catch (error) {}
  };

  var sharedFieldsInstalled = false;
  var perTagInstalled = [];

  var VALUE_TAGS = ["input", "textarea", "select", "option", "button", "output", "progress", "meter", "param", "data", "li"];

  var REFLECTED = {
    input: ["type", "name", "size#20", "placeholder", "min", "max", "step", "pattern", "accept", "alt", "width#0", "height#0", "maxLength:maxlength", "minLength:minlength", "autocomplete", "list", "multiple?", "disabled?", "required?", "readOnly?readonly"],
    textarea: ["name", "rows#2", "cols#20", "placeholder", "maxLength:maxlength", "disabled?", "readOnly?readonly", "required?"],
    select: ["name", "size", "multiple?", "disabled?", "required?"],
    button: ["type", "name", "disabled?"],
    // src, width/height, loading, crossOrigin, preload, muted and the like are the element module's.
    img: ["alt", "srcset", "sizes", "referrerPolicy:referrerpolicy", "useMap:usemap", "isMap?ismap"],
    video: ["width#0", "height#0", "controls?", "loop?", "autoplay?", "playsInline?playsinline"],
    audio: ["controls?", "loop?", "autoplay?"],
    iframe: ["name", "width", "height", "allow", "referrerPolicy:referrerpolicy"],
    // URL attributes (a href, form action, input src, ...) are the element module's: resolved.
    a: ["target", "rel", "download", "ping", "hreflang", "type"],
    script: ["type", "integrity", "referrerPolicy:referrerpolicy", "defer?", "noModule?nomodule", "charset", "event", "htmlFor:for"],
    link: ["rel", "media", "type", "as", "integrity", "hreflang", "sizes"],
    form: ["name", "method", "target", "enctype", "autocomplete", "noValidate?novalidate"],
    option: ["label", "disabled?"],
    canvas: [],
  };

  var installEntries = function (prototype) {
    var shape = traits.webkitEntries;
    if (!prototype || !shape || shape.type !== "object") return;

    try {
      Object.defineProperty(prototype, "webkitEntries", {
        get: asNative(function () { return []; }, "get webkitEntries"),
        set: undefined,
        enumerable: shape.enumerable !== false,
        configurable: shape.configurable !== false,
      });
    } catch (error) {}
  };

  var installReflected = function (prototype, tag) {
    var fields = REFLECTED[tag];
    if (!prototype || !fields) return;

    for (var index = 0; index < fields.length; index += 1) {
      (function (spec) {
        var boolean = spec.indexOf("?") !== -1;
        var numeric = spec.indexOf("#") !== -1;
        var fallback = numeric ? Number(spec.slice(spec.indexOf("#") + 1)) : 0;
        var parts = (numeric ? spec.slice(0, spec.indexOf("#")) : spec).replace("?", ":").split(":");
        var property = parts[0];
        var attribute = (parts[1] || property).toLowerCase();

        try {
          var previous = Object.getOwnPropertyDescriptor(prototype, property);

          Object.defineProperty(prototype, property, {
            get: asNative(function () {
              var state = nodeState(this);
              if (!state) return boolean ? false : "";
              var raw = state.attrs[attribute];
              if (boolean) return raw !== undefined;
              if (numeric) {
                if (raw === undefined) return fallback;
                var parsed = parseInt(raw, 10);
                return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
              }
              return raw === undefined ? "" : raw;
            }, "get " + property),
            set: asNative(function (value) {
              var state = nodeState(this);
              if (!state) return;

              if (boolean) {
                setAttr(this, attribute, value ? "" : null);
                return;
              }

              setAttr(this, attribute, String(value));
            }, "set " + property),
            enumerable: previous ? previous.enumerable : true,
            configurable: true,
          });
        } catch (error) {}
      })(fields[index]);
    }
  };

  var installElementFields = function (tagPrototype, name) {
    if (!sharedFieldsInstalled) {
      sharedFieldsInstalled = true;

      var nodeProto = globalThis.Node && globalThis.Node.prototype;
      var elementProto = globalThis.Element && globalThis.Element.prototype;
      var htmlProto = globalThis.HTMLElement && globalThis.HTMLElement.prototype;

      installFields(nodeProto || tagPrototype, NODE_FIELDS);
      installFields(elementProto || tagPrototype, ELEMENT_FIELDS);
      installFields(htmlProto || tagPrototype, HTML_FIELDS);
      installCounts(elementProto || tagPrototype);
      installCounts(globalThis.Document && globalThis.Document.prototype);
      installMetrics(elementProto || tagPrototype, ["clientWidth", "clientHeight", "scrollWidth", "scrollHeight"]);
      installMetrics(htmlProto || tagPrototype, ["offsetWidth", "offsetHeight", "offsetLeft", "offsetTop"]);
      installMarkup(elementProto || tagPrototype);
      installText(nodeProto || tagPrototype);
    }

    if (!tagPrototype || perTagInstalled.indexOf(tagPrototype) !== -1) return;
    perTagInstalled.push(tagPrototype);

    installReflected(tagPrototype, name);

    if (VALUE_TAGS.indexOf(name) !== -1) installFields(tagPrototype, ["value"]);

    if (name === "canvas") installSizes(tagPrototype);
    if (name === "iframe") installFrame(tagPrototype);
    if (name === "input") installEntries(tagPrototype);
  };

  var contextHandles = new WeakMap();

  var handleOf = function (node) {
    var state = nodeState(node);
    return state ? state.handle : "canvas";
  };

  var attributesOf = function (node) {
    var state = nodeState(node);
    return state ? state.attrs : {};
  };

  var syncAttributes = function (node) {
    var state = nodeState(node);
    if (!state) return;

    var names = Object.keys(state.attrs);
    var list = state.attributes;

    if (!Array.isArray(list)) return;

    list.length = 0;

    for (var index = 0; index < names.length; index += 1) {
      list.push({ name: names[index], value: state.attrs[names[index]], localName: names[index], namespaceURI: null, specified: true });
    }
  };

  env.syncAttributes = syncAttributes;

  var hasAttributeNamed = function (node, key) {
    return Object.prototype.hasOwnProperty.call(attributesOf(node), key);
  };

  var makeElement = function (tag, owner) {
    var name = String(tag).toLowerCase();
    var prototype = prototypeFor(name);
    var element = Object.create(prototype);

    elementCount += 1;
    installElementFields(prototype, name);

    var state = {
      tag: name,
      handle: name === "canvas" ? "canvas" + (canvasCount += 1) : "element" + elementCount,
      html: "",
      frame: undefined,
      attrs: {},
      tagName: name.toUpperCase(),
      nodeName: name.toUpperCase(),
      localName: name,
      nodeType: 1,
      children: [],
      childNodes: [],
      childElementCount: 0,
      firstElementChild: null,
      lastElementChild: null,
      previousElementSibling: null,
      nextElementSibling: null,
      attributes: [],
      style: null,
      parentNode: null,
      parentElement: null,
      firstChild: null,
      lastChild: null,
      nextSibling: null,
      previousSibling: null,
      ownerDocument: owner || document,
      namespaceURI: "http://www.w3.org/1999/xhtml",
      prefix: null,
      attrNS: {},
      textContent: "",
      value: "",
      outerHTML: "",
      innerText: "",
      className: "",
      id: "",
      src: "",
      width: name === "canvas" ? 300 : 0,
      height: name === "canvas" ? 150 : 0,
      offsetWidth: 0,
      offsetHeight: 0,
      clientWidth: 0,
      clientHeight: 0,
    };

    state.style = makeStyle(element);
    elementState.set(element, state);
    styleOwners.set(state.style, element);

    if (!env.debugElements) return element;

    return new Proxy(element, {
      get: function (target, key) {
        var value = target[key];
        if (value === undefined && typeof key === "string") env.count("miss " + name + "." + key);
        return value;
      },
    });
  };

  env.makeElement = makeElement;

  var elementConstructor = function (name, tag, initialise) {
    var previous = globalThis[name];
    if (typeof previous !== "function") return;

    var made = function () {
      if (new.target === undefined) {
        throw env.hideFrames(new TypeError("Failed to construct '" + name + "': Please use the 'new' operator, this DOM object constructor cannot be called as a function."));
      }

      var element = makeElement(tag);
      initialise(element, arguments);
      return element;
    };

    asNative(made, name);

    try {
      Object.defineProperty(made, "length", { value: 0, configurable: true });
      Object.defineProperty(made, "prototype", { value: previous.prototype, writable: false, enumerable: false, configurable: false });
    } catch (error) {}

    try {
      Object.defineProperty(globalThis, name, { value: made, writable: true, enumerable: false, configurable: true });
    } catch (error) {}
  };

  elementConstructor("Audio", "audio", function (element, args) {
    element.preload = "auto";
    if (args.length) element.src = String(args[0]);
  });

  elementConstructor("Image", "img", function (element, args) {
    if (args.length > 0) element.width = Number(args[0]) || 0;
    if (args.length > 1) element.height = Number(args[1]) || 0;
  });

  elementConstructor("Option", "option", function (element, args) {
    if (args.length > 0) element.textContent = String(args[0]);
    if (args.length > 1) element.value = String(args[1]);
  });

  // NodeList and HTMLCollection as Chrome's: views whose indexed (and, for collections, id/name)
  // members are own properties read through to the items they show, live when the items are
  // (childNodes, children), with `length`, `item` and `namedItem` on the prototype and the very
  // functions of Array.prototype as forEach/keys/values/entries/@@iterator.
  var listItems = new WeakMap();
  var listContents = function (view) {
    var items = listItems.get(view);
    if (!items) throw env.hideFrames(new TypeError("Illegal invocation"));
    return items();
  };
  var listLength = function (view) { return listContents(view).length; };
  var NAMED_BRANDS = { HTMLCollection: true, HTMLFormControlsCollection: true, HTMLOptionsCollection: true, HTMLAllCollection: true };
  var INDEX = /^(0|[1-9][0-9]*)$/;

  var isIndex = function (key) {
    return typeof key === "string" && INDEX.test(key) && Number(key) < 4294967295;
  };

  var namedIn = function (items) {
    var names = [];
    for (var index = 0; index < items.length; index += 1) {
      var state = nodeState(items[index]);
      if (!state || state.nodeType !== 1) continue;
      var id = state.attrs && state.attrs.id;
      if (id && names.indexOf(id) === -1) names.push(id);
      var name = state.attrs && state.attrs.name;
      if (name && names.indexOf(name) === -1) names.push(name);
    }
    return names;
  };

  var namedItem = function (items, key) {
    for (var index = 0; index < items.length; index += 1) {
      var state = nodeState(items[index]);
      if (state && state.nodeType === 1 && state.attrs && (state.attrs.id === key || state.attrs.name === key)) return items[index];
    }
    return null;
  };

  // `naming` (keys, find) names members by something other than id and name (NamedNodeMap's
  // attribute names).
  var makeCollection = function (brand, items, naming) {
    var holder = globalThis[brand] && globalThis[brand].prototype;
    if (!holder) return items().slice();

    var named = Boolean(naming || NAMED_BRANDS[brand]);
    var namesOf = naming ? function (list) { return naming.keys(list); } : namedIn;
    var lookup = naming ? function (list, key) { return naming.find(list, key); } : namedItem;
    var target = Object.create(holder);
    var shadowed = function (key) { return key in holder; };

    var view = new Proxy(target, {
      get: function (base, key, receiver) {
        if (isIndex(key)) return items()[Number(key)];
        if (named && typeof key === "string" && !shadowed(key)) {
          var found = lookup(items(), key);
          if (found) return found;
        }
        return Reflect.get(base, key, receiver);
      },
      has: function (base, key) {
        if (isIndex(key)) return Number(key) < items().length;
        if (named && typeof key === "string" && lookup(items(), key)) return true;
        return Reflect.has(base, key);
      },
      ownKeys: function (base) {
        var list = items();
        var keys = [];
        for (var index = 0; index < list.length; index += 1) keys.push(String(index));
        if (named) keys = keys.concat(namesOf(list).filter(function (key) { return !isIndex(key); }));
        return keys.concat(Reflect.ownKeys(base));
      },
      getOwnPropertyDescriptor: function (base, key) {
        if (isIndex(key)) {
          var list = items();
          return Number(key) < list.length ? { value: list[Number(key)], writable: false, enumerable: true, configurable: true } : undefined;
        }
        if (named && typeof key === "string" && !Object.prototype.hasOwnProperty.call(base, key)) {
          var found = lookup(items(), key);
          if (found) return { value: found, writable: false, enumerable: false, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(base, key);
      },
      defineProperty: function (base, key, descriptor) {
        if (isIndex(key)) return false;
        return Reflect.defineProperty(base, key, descriptor);
      },
      set: function (base, key, value, receiver) {
        if (isIndex(key)) return false;
        return Reflect.set(base, key, value, receiver);
      },
      deleteProperty: function (base, key) {
        if (isIndex(key)) return Number(key) >= items().length;
        return Reflect.deleteProperty(base, key);
      },
    });

    listItems.set(view, items);
    return view;
  };

  // A list that shows `items` as they are now (querySelectorAll's, a mutation record's).
  var listOf = function (items, brand) {
    var held = Array.prototype.slice.call(items);
    return makeCollection(brand, function () { return held; });
  };

  var liveLists = { childNodes: new WeakMap(), children: new WeakMap() };

  var childNodesOf = function (node) {
    var cached = liveLists.childNodes.get(node);
    if (!cached) {
      cached = makeCollection("NodeList", function () {
        var state = nodeState(node);
        return state && Array.isArray(state.childNodes) ? state.childNodes : [];
      });
      liveLists.childNodes.set(node, cached);
    }
    return cached;
  };

  var childrenOf = function (node) {
    var cached = liveLists.children.get(node);
    if (!cached) {
      cached = makeCollection("HTMLCollection", function () {
        var state = nodeState(node);
        if (!state || !Array.isArray(state.childNodes)) return [];
        return state.childNodes.filter(function (kid) { var kidState = nodeState(kid); return kidState && kidState.nodeType === 1; });
      });
      liveLists.children.set(node, cached);
    }
    return cached;
  };

  env.childNodesOf = childNodesOf;
  env.childrenOf = childrenOf;

  (function installListPrototypes() {
    var lengthOf = function (view) {
      var items = listItems.get(view);
      if (!items) throw env.hideFrames(new TypeError("Illegal invocation"));
      return items();
    };

    var methods = function (holder) {
      Object.defineProperty(holder, "item", {
        value: asNative(function item(index) {
          if (arguments.length < 1) throw env.hideFrames(new TypeError("Failed to execute 'item' on '" + holder.constructor.name + "': 1 argument required, but only 0 present."));
          var found = lengthOf(this)[Number(index) >>> 0];
          return found === undefined ? null : found;
        }, "item"),
        writable: true, enumerable: true, configurable: true,
      });
      patchGetter(holder, "length", function () { return lengthOf(this).length; });
    };

    var nodeList = globalThis.NodeList && globalThis.NodeList.prototype;
    if (nodeList) {
      methods(nodeList);
      ["entries", "keys", "values", "forEach"].forEach(function (name) {
        Object.defineProperty(nodeList, name, { value: Array.prototype[name], writable: true, enumerable: true, configurable: true });
      });
      Object.defineProperty(nodeList, Symbol.iterator, { value: Array.prototype.values, writable: true, enumerable: false, configurable: true });
    }

    var collection = globalThis.HTMLCollection && globalThis.HTMLCollection.prototype;
    if (collection) {
      methods(collection);
      Object.defineProperty(collection, "namedItem", {
        value: asNative(function namedItem_(name) {
          if (arguments.length < 1) throw env.hideFrames(new TypeError("Failed to execute 'namedItem' on 'HTMLCollection': 1 argument required, but only 0 present."));
          return namedItem(lengthOf(this), String(name));
        }, "namedItem"),
        writable: true, enumerable: true, configurable: true,
      });
      Object.defineProperty(collection, Symbol.iterator, { value: Array.prototype.values, writable: true, enumerable: false, configurable: true });
    }
  })();

  var matchingElements = function (root, selector) {
    var wanted = String(selector).toLowerCase().trim();
    var everything = wanted === "*";
    var found = [];
    var roots = root === null || root === undefined
      ? (env.tree ? [env.tree.html, env.tree.head, env.tree.body] : [])
      : [root];

    var seen = new Set();

    var walk = function (node, depth) {
      if (!node || typeof node !== "object" || depth > 12 || seen.has(node) || found.length > 500) return;
      seen.add(node);

      var state = nodeState(node);
      var tag = state ? state.tag : String(node.tagName || "").toLowerCase();
      if (tag && (everything || tag === wanted)) found.push(node);

      var children = state ? state.childNodes : null;
      if (!Array.isArray(children)) return;

      for (var index = 0; index < children.length; index += 1) walk(children[index], depth + 1);
    };

    if (!everything && !/^[a-z][a-z0-9-]*$/.test(wanted)) return found;

    for (var index = 0; index < roots.length; index += 1) walk(roots[index], 0);
    return found;
  };

  env.matchingElements = matchingElements;
  env.listOf = listOf;
  env.connected = connected;

  var runningScript = null;

  // A script the host runs: `element` is the page's own script element when one is running (the
  // element module runs inserted scripts this way); otherwise the host's script gets an element of
  // its own, as a parser-inserted one, already started so it never loads itself again.
  env.beginScript = function (url, inline, element) {
    if (element) {
      runningScript = element;
      return element;
    }

    if (!inline && (!url || !/^https?:/.test(String(url)))) return null;

    var element = makeElement("script");
    nodeState(element).started = true;

    if (!inline) {
      element.src = String(url);
      element.async = false;
    }

    if (env.tree && env.tree.body) env.tree.body.appendChild(element);

    runningScript = element;
    return element;
  };

  env.endScript = function () {
    runningScript = null;
  };

  // The document a Document method runs on: `this` when it is one, else the page's.
  var documentOf = function (self) {
    var state = nodeState(self);
    return state && state.nodeType === 9 ? self : globalThis.document;
  };

  if (Document && Document.prototype) {
    // A valid XML name, as Chrome checks a tag name (letters and "_" or ":" first, then letters,
    // digits, ".", "-", "_", ":" and the non-ASCII name characters).
    var VALID_NAME = /^[A-Za-z_:\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][A-Za-z0-9_:.\-\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]*$/;

    patch(Document.prototype, "createElement", function createElement(tag) {
      if (arguments.length === 0) throw env.hideFrames(new TypeError("Failed to execute 'createElement' on 'Document': 1 argument required, but only 0 present."));
      if (!VALID_NAME.test(String(tag))) {
        throw domException("Failed to execute 'createElement' on 'Document': The tag name provided ('" + String(tag) + "') is not a valid name.", "InvalidCharacterError");
      }
      return makeElement(tag);
    });
    patch(Document.prototype, "createElementNS", function createElementNS(ns, tag) { return makeElement(tag); });
    // A text or comment node: character data whose state lives beside it like an element's.
    var makeCharacterData = function (iface, nodeType, nodeName, text, owner) {
      var holder = globalThis[iface] && globalThis[iface].prototype;
      var node = holder ? Object.create(holder) : {};
      var value = String(text);

      elementState.set(node, {
        tag: nodeName,
        handle: iface.toLowerCase(),
        attrs: {},
        nodeType: nodeType,
        nodeName: nodeName,
        data: value,
        textContent: value,
        wholeText: value,
        length: value.length,
        parentNode: null,
        parentElement: null,
        previousSibling: null,
        nextSibling: null,
        childNodes: [],
        ownerDocument: owner || globalThis.document,
      });

      env.overrides.set(node, nodeType === 3 ? { data: value, wholeText: value, length: value.length } : { data: value, length: value.length });
      return node;
    };

    env.makeCharacterData = makeCharacterData;

    patch(Document.prototype, "createTextNode", function createTextNode(text) {
      if (arguments.length < 1) throw env.hideFrames(new TypeError("Failed to execute 'createTextNode' on 'Document': 1 argument required, but only 0 present."));
      return makeCharacterData("Text", 3, "#text", text, documentOf(this));
    });
    patch(Document.prototype, "createComment", function createComment(text) {
      if (arguments.length < 1) throw env.hideFrames(new TypeError("Failed to execute 'createComment' on 'Document': 1 argument required, but only 0 present."));
      return makeCharacterData("Comment", 8, "#comment", text, documentOf(this));
    });
    installShell("Text", function (args) { return makeCharacterData("Text", 3, "#text", args.length ? args[0] : ""); }, 0);
    installShell("Comment", function (args) { return makeCharacterData("Comment", 8, "#comment", args.length ? args[0] : ""); }, 0);
    // A fragment: a node of its own (its children live in its state like an element's).
    var makeFragment = function (owner) {
      var fragment = globalThis.DocumentFragment && globalThis.DocumentFragment.prototype
        ? Object.create(globalThis.DocumentFragment.prototype)
        : {};

      elementState.set(fragment, {
        tag: "#document-fragment",
        handle: "fragment",
        attrs: {},
        nodeType: 11,
        nodeName: "#document-fragment",
        childNodes: [],
        children: [],
        childElementCount: 0,
        firstElementChild: null,
        lastElementChild: null,
        firstChild: null,
        lastChild: null,
        previousSibling: null,
        nextSibling: null,
        parentNode: null,
        parentElement: null,
        textContent: "",
        ownerDocument: owner || globalThis.document,
      });

      return fragment;
    };

    env.makeFragment = makeFragment;

    patch(Document.prototype, "createDocumentFragment", function createDocumentFragment() {
      return makeFragment(documentOf(this));
    });
    installShell("DocumentFragment", function () { return makeFragment(globalThis.document); }, 0);
    patch(Document.prototype, "getElementById", function getElementById() { return null; });
    patch(Document.prototype, "getElementsByTagName", function getElementsByTagName(tag) {
      return listOf(matchingElements(null, tag), "HTMLCollection");
    });
    patch(Document.prototype, "getElementsByClassName", function getElementsByClassName() { return listOf([], "HTMLCollection"); });
    patch(Document.prototype, "querySelector", function querySelector(selector) {
      var found = matchingElements(null, selector);
      return found.length ? found[0] : null;
    });
    patch(Document.prototype, "querySelectorAll", function querySelectorAll(selector) {
      return listOf(matchingElements(null, selector), "NodeList");
    });
    var refusedEvents = { touchevent: true, gamepadevent: true, devicemotionevent: true, deviceorientationevent: true };

    patch(Document.prototype, "createEvent", function createEvent(type) {
      var name = String(type).toLowerCase();

      if (refusedEvents[name]) {
        throw env.hideFrames(new DOMException("The provided event type ('" + type + "') is invalid.", "NotSupportedError"));
      }

      var constructors = {
        event: "Event",
        events: "Event",
        htmlevents: "Event",
        customevent: "CustomEvent",
        mouseevent: "MouseEvent",
        mouseevents: "MouseEvent",
        uievent: "UIEvent",
        uievents: "UIEvent",
        keyboardevent: "KeyboardEvent",
        messageevent: "MessageEvent",
        focusevent: "FocusEvent",
        wheelevent: "WheelEvent",
        pointerevent: "PointerEvent",
        progressevent: "ProgressEvent",
        storageevent: "StorageEvent",
      };

      var wanted = constructors[name];

      if (wanted && typeof globalThis[wanted] === "function") {
        try {
          return new globalThis[wanted]("");
        } catch (error) {}
      }

      return makeEvent(name);
    });
    patch(Document.prototype, "hasFocus", function hasFocus() { return false; });
    patch(Document.prototype, "createTreeWalker", function createTreeWalker() {
      return { nextNode: function () { return null; }, currentNode: null };
    });
    patch(Document.prototype, "evaluate", function evaluate() {
      return { iterateNext: function () { return null; }, snapshotLength: 0, snapshotItem: function () { return null; } };
    });
  }

  var VOID_TAGS = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
  var TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;

  var parseAttributes = function (text) {
    var out = {};
    var pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    var match;

    while ((match = pattern.exec(text))) {
      out[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : "";
    }

    return out;
  };

  var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

  var decodeEntities = function (text) {
    return String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, function (all, name) {
      if (name.charAt(0) === "#") {
        var code = name.charAt(1).toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : all;
      }
      var found = ENTITIES[name.toLowerCase()];
      return found === undefined ? all : found;
    });
  };

  var parseHtml = function (source, host) {
    var stack = [host];
    var match;

    TAG.lastIndex = 0;

    while ((match = TAG.exec(String(source)))) {
      var current = stack[stack.length - 1];

      if (match[5] !== undefined) {
        var text = match[5];

        if (text.trim()) insertChild(current, globalThis.document.createTextNode(decodeEntities(text)), null, "appendChild", true);

        continue;
      }

      if (match[2] === undefined) continue;

      var tag = match[2].toLowerCase();

      if (match[1] === "/") {
        if (stack.length > 1 && nodeState(stack[stack.length - 1]) && nodeState(stack[stack.length - 1]).tag === tag) stack.pop();
        continue;
      }

      var element = makeElement(tag);
      var attributes = parseAttributes(match[3] || "");
      var names = Object.keys(attributes);

      for (var index = 0; index < names.length; index += 1) {
        try {
          element.setAttribute(names[index], attributes[names[index]]);
        } catch (error) {}
      }

      // A script the parser inserts for innerHTML never runs.
      if (tag === "script") nodeState(element).started = true;
      insertChild(current, element, null, "appendChild", true);

      if (!VOID_TAGS[tag] && !match[4]) stack.push(element);
    }

    return host;
  };

  env.parseHtml = parseHtml;

  var relink = function (parent) {
    var state = nodeState(parent);
    if (!state || !Array.isArray(state.childNodes)) return;

    var kids = state.childNodes;
    state.firstChild = kids.length ? kids[0] : null;
    state.lastChild = kids.length ? kids[kids.length - 1] : null;

    var elements = [];

    for (var index = 0; index < kids.length; index += 1) {
      var childState = nodeState(kids[index]);
      if (childState && childState.nodeType === 1) elements.push(kids[index]);

      if (childState) {
        childState.previousSibling = index > 0 ? kids[index - 1] : null;
        childState.nextSibling = index + 1 < kids.length ? kids[index + 1] : null;
      }
    }

    state.children = elements;
    state.childElementCount = elements.length;
    state.firstElementChild = elements.length ? elements[0] : null;
    state.lastElementChild = elements.length ? elements[elements.length - 1] : null;
  };

  // The tree, as the DOM standard changes it: a node goes in at one place among its parent's
  // children (leaving any parent it had), a fragment gives up its children, and every change is a
  // mutation record for MutationObserver and a chance for an element to start loading (a script
  // runs, an iframe opens, an image already loading stays loading) once it is in the document.
  var childListOf = function (parent) {
    var state = nodeState(parent);
    return state && Array.isArray(state.childNodes) ? state.childNodes : null;
  };

  var takeChild = function (parent, child, quiet) {
    forgetLayoutSource(parent);
    var kids = childListOf(parent);
    var childState = nodeState(child);
    if (!kids || !childState) return child;

    var at = kids.indexOf(child);
    if (at === -1) return child;

    var previous = at > 0 ? kids[at - 1] : null;
    var next = at + 1 < kids.length ? kids[at + 1] : null;
    var wasConnected = connected(parent);

    kids.splice(at, 1);
    childState.parentNode = null;
    childState.parentElement = null;
    childState.previousSibling = null;
    childState.nextSibling = null;
    relink(parent);
    walkFrames(child, detachFrame);

    if (!quiet) env.queueMutation({ type: "childList", target: parent, addedNodes: [], removedNodes: [child], previousSibling: previous, nextSibling: next });
    if (wasConnected) env.nodeRemoved(child);

    return child;
  };

  var notChild = function (method) {
    return domException("Failed to execute '" + method + "' on 'Node': The node before which the new node is to be inserted is not a child of this node.", "NotFoundError");
  };

  // A node (and its subtree) moving into another document takes that document as its owner.
  var adopt = function (node, owner) {
    var state = nodeState(node);
    if (!state) return;
    if (state.nodeType !== 9) state.ownerDocument = owner;
    if (state.nodeType === 1 && typeof retag === "function") retag(state, owner);
    var kids = state.childNodes || [];
    for (var index = 0; index < kids.length; index += 1) adopt(kids[index], owner);
  };

  // The DOM standard's "ensure pre-insertion validity", with Chrome's messages: what may go where
  // (nothing into a text node; no text, and one element and one doctype only, in a document).
  var hierarchy = function (method, iface, message) {
    return domException("Failed to execute '" + method + "' on '" + (iface || "Node") + "': " + message, "HierarchyRequestError");
  };

  var ensureInsertable = function (parent, parentState, child, childState, before, method, replacing, iface) {
    if (parentState.nodeType !== 1 && parentState.nodeType !== 9 && parentState.nodeType !== 11) {
      throw hierarchy(method, iface, "This node type does not support this method.");
    }

    for (var up = parent; up; up = nodeState(up) ? nodeState(up).parentNode : null) {
      if (up === child) throw hierarchy(method, iface, "The new child element contains the parent.");
    }

    var type = childState.nodeType;
    if (type !== 1 && type !== 3 && type !== 4 && type !== 7 && type !== 8 && type !== 10 && type !== 11) {
      throw hierarchy(method, iface, "Nodes of type '" + childState.nodeName + "' may not be inserted inside nodes of type '" + parentState.nodeName + "'.");
    }
    if ((type === 3 && parentState.nodeType === 9) || (type === 10 && parentState.nodeType !== 9)) {
      throw hierarchy(method, iface, "Nodes of type '" + childState.nodeName + "' may not be inserted inside nodes of type '" + parentState.nodeName + "'.");
    }
    if (parentState.nodeType !== 9) return;

    var kids = parentState.childNodes.filter(function (kid) { return kid !== replacing; });
    var kindOf = function (node) { var state = nodeState(node); return state ? state.nodeType : 0; };
    var elementsIn = function (list) { return list.filter(function (node) { return kindOf(node) === 1; }).length; };
    var doctypeAfter = before ? kids.slice(kids.indexOf(before)).some(function (node) { return kindOf(node) === 10; }) : false;

    if (type === 11) {
      var moving = childState.childNodes || [];
      if (moving.some(function (node) { return kindOf(node) === 3; })) {
        throw hierarchy(method, iface, "Nodes of type '#text' may not be inserted inside nodes of type '#document'.");
      }
      var count = elementsIn(moving);
      if (count > 1 || (count === 1 && (elementsIn(kids) > 0 || doctypeAfter))) throw hierarchy(method, iface, "Only one element on document allowed.");
    } else if (type === 1) {
      if (elementsIn(kids) > 0) throw hierarchy(method, iface, "Only one element on document allowed.");
      if (doctypeAfter) throw hierarchy(method, iface, "Can't insert an element before a doctype.");
    } else if (type === 10) {
      if (kids.some(function (node) { return kindOf(node) === 10; })) throw hierarchy(method, iface, "Only one doctype on document allowed.");
      var at = before ? kids.indexOf(before) : kids.length;
      if (kids.slice(0, at).some(function (node) { return kindOf(node) === 1; })) throw hierarchy(method, iface, "Can't insert a doctype after an element.");
    }
  };

  var insertChild = function (parent, child, before, method, quiet, replacing, iface) {
    forgetLayoutSource(parent);
    var kids = childListOf(parent);
    var childState = nodeState(child);

    if (!childState || !kids) {
      throw env.hideFrames(new TypeError("Failed to execute '" + method + "' on '" + (iface || "Node") + "': parameter 1 is not of type 'Node'."));
    }

    ensureInsertable(parent, nodeState(parent), child, childState, before, method, replacing, iface);

    if (before !== null && before !== undefined && kids.indexOf(before) === -1) throw notChild(method);
    if (before === child) before = childState.nextSibling;

    var moving = [child];

    if (childState.nodeType === 11) {
      moving = childState.childNodes.slice();
      for (var each = 0; each < moving.length; each += 1) takeChild(child, moving[each], true);
    } else if (childState.parentNode) {
      takeChild(childState.parentNode, child, quiet);
    }

    if (!moving.length) return child;

    var at = before === null || before === undefined ? kids.length : kids.indexOf(before);
    var previous = at > 0 ? kids[at - 1] : null;
    var next = at < kids.length ? kids[at] : null;

    Array.prototype.splice.apply(kids, [at, 0].concat(moving));

    var parentIsElement = nodeState(parent) && nodeState(parent).nodeType === 1;

    var parentState = nodeState(parent);
    var owner = parentState && parentState.nodeType === 9 ? parent : parentState ? parentState.ownerDocument : null;

    for (var index = 0; index < moving.length; index += 1) {
      var movedState = nodeState(moving[index]);
      if (owner && movedState.ownerDocument !== owner) adopt(moving[index], owner);
      movedState.parentNode = parent;
      movedState.parentElement = parentIsElement ? parent : null;
      if (movedState.tag === "script" && movedState.attrs.src) record("script", movedState.attrs.src);
      if (movedState.tag === "iframe") record("iframe", movedState.attrs.src || "about:blank");
    }

    relink(parent);

    if (!quiet) env.queueMutation({ type: "childList", target: parent, addedNodes: moving, removedNodes: [], previousSibling: previous, nextSibling: next });

    if (connected(parent)) {
      for (var inserted = 0; inserted < moving.length; inserted += 1) {
        walkFrames(moving[inserted], attachFrame);
        env.nodeInserted(moving[inserted]);
      }
    }

    return child;
  };

  env.insertChild = insertChild;
  env.takeChild = takeChild;

  var appendChild = function appendChild(child) {
    if (arguments.length < 1) throw env.hideFrames(new TypeError("Failed to execute 'appendChild' on 'Node': 1 argument required, but only 0 present."));
    return insertChild(this, child, null, "appendChild", false);
  };

  // Removes every child at once and puts `replacement` (nodes) in their place, one mutation record
  // for it all, as textContent and innerHTML do.
  var replaceAll = function (parent, replacement) {
    var kids = childListOf(parent);
    if (!kids) return;

    var removed = kids.slice();
    for (var index = 0; index < removed.length; index += 1) takeChild(parent, removed[index], true);
    for (var add = 0; add < replacement.length; add += 1) insertChild(parent, replacement[add], null, "appendChild", true);

    if (removed.length || replacement.length) {
      env.queueMutation({ type: "childList", target: parent, addedNodes: replacement.slice(), removedNodes: removed, previousSibling: null, nextSibling: null });
    }
  };

  env.replaceAll = replaceAll;

  var detachChild = function (parent, child) {
    if (!parent) return child;
    return takeChild(parent, child, false);
  };

  // Hooks the element module fills in: a node entering or leaving the document, an attribute
  // changing, and mutation records (none are queued before an observer can exist).
  env.queueMutation = function () {};
  env.opaqueFrame = function () { return false; };
  env.nodeInserted = function () {};
  env.nodeRemoved = function () {};
  env.attributeChanged = function (node, key) {
    var state = nodeState(node);
    if (key === "src" && state && state.tag === "iframe" && state.frame) navigateFrame(node, state.frame);
  };

  // Sets (or with null removes) an attribute: the element's own fields that mirror it follow, an
  // observer hears it with the old value, and the element reacts (a new src loads).
  var setAttr = function (node, name, value, fromStyle) {
    var state = nodeState(node);
    if (!state || state.nodeType !== 1) return;

    var key = typeof attributeKey === "function" ? attributeKey(state, node, name) : String(name).toLowerCase();
    var had = Object.prototype.hasOwnProperty.call(state.attrs, key);
    var old = had ? state.attrs[key] : null;

    if (value === null) {
      if (!had) return;
      delete state.attrs[key];
    } else {
      state.attrs[key] = String(value);
    }

    syncAttributes(node);

    if (key === "class") state.className = value === null ? "" : String(value);
    if (key === "id") state.id = value === null ? "" : String(value);
    if (key === "src") state.src = value === null ? "" : String(value);
    if (key === "style" && !fromStyle && state.style && styleParsers.has(state.style)) styleParsers.get(state.style)(value === null ? "" : String(value));

    env.queueMutation({ type: "attributes", target: node, attributeName: key, attributeNamespace: null, oldValue: old });
    env.attributeChanged(node, key, old, value === null ? null : String(value));
  };

  env.setAttr = setAttr;

  // Text, as Node.textContent and CharacterData read and change it.
  var textOf = function (node) {
    var state = nodeState(node);
    if (!state) return "";
    if (state.nodeType === 3 || state.nodeType === 8 || state.nodeType === 4 || state.nodeType === 7) return state.data;
    var out = "";
    var kids = state.childNodes || [];
    for (var index = 0; index < kids.length; index += 1) {
      var kid = nodeState(kids[index]);
      if (kid && kid.nodeType !== 8 && kid.nodeType !== 7) out += textOf(kids[index]);
    }
    return out;
  };

  env.textOf = textOf;

  var setData = function (node, value) {
    var state = nodeState(node);
    if (!state) return;
    var old = state.data;
    var text = value === null ? "" : String(value);
    state.data = text;
    state.textContent = text;
    state.wholeText = text;
    state.length = text.length;
    env.overrides.set(node, { data: text, wholeText: text, length: text.length, nodeValue: text });
    env.queueMutation({ type: "characterData", target: node, addedNodes: [], removedNodes: [], oldValue: old });
    if (state.parentNode) env.textChanged(state.parentNode);
  };

  env.textChanged = function () {};

  var installText = function (nodeProto) {
    if (!nodeProto) return;

    try {
      Object.defineProperty(nodeProto, "textContent", {
        get: asNative(function () {
          var state = nodeState(this);
          if (!state) return null;
          if (state.nodeType === 9 || state.nodeType === 10) return null;
          return textOf(this);
        }, "get textContent"),
        set: asNative(function (value) {
          var state = nodeState(this);
          if (!state) return;
          if (state.nodeType === 3 || state.nodeType === 8) return setData(this, value);
          var text = value === null || value === undefined ? "" : String(value);
          replaceAll(this, text ? [globalThis.document.createTextNode(text)] : []);
          state.layoutSource = text;
          env.textChanged(this);
        }, "set textContent"),
        enumerable: true,
        configurable: true,
      });

      Object.defineProperty(nodeProto, "nodeValue", {
        get: asNative(function () {
          var state = nodeState(this);
          return state && (state.nodeType === 3 || state.nodeType === 8) ? state.data : null;
        }, "get nodeValue"),
        set: asNative(function (value) {
          var state = nodeState(this);
          if (state && (state.nodeType === 3 || state.nodeType === 8)) setData(this, value);
        }, "set nodeValue"),
        enumerable: true,
        configurable: true,
      });
    } catch (error) {}

    var characterData = globalThis.CharacterData && globalThis.CharacterData.prototype;

    if (characterData) {
      patchGetter(characterData, "data", function () { var state = nodeState(this); return state ? state.data : ""; });
      try {
        var dataDescriptor = Object.getOwnPropertyDescriptor(characterData, "data");
        Object.defineProperty(characterData, "data", {
          get: dataDescriptor.get,
          set: asNative(function (value) { setData(this, value); }, "set data"),
          enumerable: true,
          configurable: true,
        });
      } catch (error) {}
      patchGetter(characterData, "length", function () { var state = nodeState(this); return state ? state.data.length : 0; });
    }
  };

  var html = makeElement("html");
  var head = makeElement("head");
  var body = makeElement("body");

  var setOwn = function (target, key, value) {
    try {
      Object.defineProperty(target, key, { value: value, writable: true, enumerable: false, configurable: true });
    } catch (error) {}
  };

  insertChild(html, head, null, "appendChild", true);
  insertChild(html, body, null, "appendChild", true);

  // The document is a node too: its children are its doctype (when the page has one) and <html>.
  var doctype = null;
  try {
    doctype = document.doctype || null;
  } catch (error) {}

  var documentState = {
    nodeType: 9, nodeName: "#document", parentNode: null, parentElement: null, ownerDocument: null,
    previousSibling: null, nextSibling: null, childNodes: [], attrs: {},
  };
  var hasDocument = document !== null && typeof document === "object";
  if (hasDocument) elementState.set(document, documentState);

  if (hasDocument && doctype && typeof doctype === "object") {
    elementState.set(doctype, {
      nodeType: 10, nodeName: String(doctype.name || "html"), parentNode: document, parentElement: null,
      ownerDocument: document, previousSibling: null, nextSibling: null, childNodes: [], attrs: {},
    });
    documentState.childNodes.push(doctype);
  }

  documentState.childNodes.push(html);
  nodeState(html).parentNode = document;
  if (hasDocument) relink(document);

  env.tree = { html: html, head: head, body: body };


  var parseUrl = function (href) {
    var match = /^(https?:)\/\/([^/?#:]+)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(String(href));

    if (!match) {
      return { href: String(href), protocol: "about:", host: "", hostname: "", port: "", pathname: "blank", search: "", hash: "", origin: "null" };
    }

    return {
      href: String(href),
      protocol: match[1],
      host: match[2] + (match[3] ? ":" + match[3] : ""),
      hostname: match[2],
      port: match[3] || "",
      pathname: match[4] || "/",
      search: match[5] || "",
      hash: match[6] || "",
      origin: match[1] + "//" + match[2] + (match[3] ? ":" + match[3] : ""),
    };
  };

  var pageUrl = bridge.pageUrl();
  var referrer = bridge.referrer();
  var parsedUrl = parseUrl(pageUrl);

  if (globalThis.location) {
    var locationKeys = Object.keys(parsedUrl);

    for (var k = 0; k < locationKeys.length; k += 1) {
      (function (key) {
        try {
          Object.defineProperty(globalThis.location, key, {
            get: asNative(function () { return parsedUrl[key]; }, "get " + key),
            set: asNative(function () {}, "set " + key),
            enumerable: true,
            configurable: true,
          });
        } catch (error) {}
      })(locationKeys[k]);
    }

    try {
      var ancestors = [];
      if (referrer) ancestors.push(parseUrl(referrer).origin);
      ancestors.item = asNative(function item(index) { return ancestors[index] === undefined ? null : ancestors[index]; }, "item");
      Object.defineProperty(ancestors, "length", { value: ancestors.length, configurable: true });

      Object.defineProperty(globalThis.location, "ancestorOrigins", {
        get: asNative(function () { return ancestors; }, "get ancestorOrigins"),
        enumerable: true,
        configurable: true,
      });
    } catch (error) {}

    patch(globalThis.location, "toString", function toString() { return parsedUrl.href; });
    patch(globalThis.location, "reload", function reload() { return undefined; });
    patch(globalThis.location, "assign", function assign() { return undefined; });
    patch(globalThis.location, "replace", function replace() { return undefined; });
  }

  if (Document && Document.prototype) {
    var documentValues = {
      documentElement: html,
      body: body,
      head: head,

      all: [html, head, body],
      forms: [],
      links: [],
      images: [],
      scripts: [],
      embeds: [],
      plugins: [],
      styleSheets: [],
      anchors: [],
      readyState: "complete",
      hidden: false,
      visibilityState: "visible",
      title: "",
      referrer: referrer,
      URL: parsedUrl.href,
      documentURI: parsedUrl.href,
      baseURI: parsedUrl.href,
      domain: parsedUrl.hostname,
      characterSet: "UTF-8",
      charset: "UTF-8",
      contentType: "text/html",
      compatMode: "CSS1Compat",
      activeElement: body,
      currentScript: null,
      defaultView: globalThis,
      location: globalThis.location,
      nodeType: 9,
      nodeName: "#document",
    };

    ["firstChild", "lastChild", "firstElementChild", "lastElementChild", "childElementCount"].forEach(function (field) {
      Object.defineProperty(documentValues, field, { get: function () { return documentState[field]; }, enumerable: true, configurable: true });
    });
    Object.defineProperty(documentValues, "childNodes", { get: function () { return childNodesOf(document); }, enumerable: true, configurable: true });
    Object.defineProperty(documentValues, "children", { get: function () { return childrenOf(document); }, enumerable: true, configurable: true });

    Object.defineProperty(documentValues, "currentScript", {
      get: function () { return runningScript; },
      enumerable: true,
      configurable: true,
    });

    Object.defineProperty(documentValues, "scripts", {
      get: function () { return matchingElements(null, "script"); },
      enumerable: true,
      configurable: true,
    });

    var documentKeys = Object.keys(documentValues);

    for (var d = 0; d < documentKeys.length; d += 1) {
      (function (key) {
        try {
          delete document[key];
        } catch (error) {}

        // baseURI is every node's (Node.prototype), not only the document's: below.
        if (key === "baseURI") return;

        patchGetter(Document.prototype, key, function () {
          return typeof documentField === "function" ? documentField(this, key) : documentValues[key];
        });
      })(documentKeys[d]);
    }

    // A node's base URL, as the HTML standard gives it: its document's first <base href>
    // resolved against the document's URL, else that URL; a frame still on about:blank inherits
    // the base URL of the page that made it, and a document a script made is about:blank.
    var firstBaseHref = function (root) {
      var stack = [root];
      while (stack.length) {
        var node = stack.shift();
        var state = nodeState(node);
        if (!state) continue;
        if (state.nodeType === 1 && state.tag === "base" && state.attrs && typeof state.attrs.href === "string") return state.attrs.href;
        if (Array.isArray(state.childNodes)) stack = state.childNodes.concat(stack);
      }
      return null;
    };

    var baseOf = function (doc) {
      var docState = nodeState(doc);
      var fallback;
      if (doc === document || (docState && docState.main)) {
        fallback = documentValues.URL === "about:blank" && env.isFrame && referrerHref ? referrerHref : documentValues.baseURI;
      } else {
        fallback = docState && docState.URL ? docState.URL : "about:blank";
      }
      var href = firstBaseHref(doc);
      if (href === null) return fallback;
      try {
        return new globalThis.URL(href, fallback).href;
      } catch (error) {
        return fallback;
      }
    };

    if (Node && Node.prototype) {
      patchGetter(Node.prototype, "baseURI", function () {
        var state = nodeState(this);
        if (!state) throw env.hideFrames(new TypeError("Illegal invocation"));
        return baseOf(state.nodeType === 9 ? this : state.ownerDocument || document);
      });
    }

    // A frame starts on about:blank; when it navigates, its location and document take the URL
    // of the document it loaded, as a browser's do.
    env.relocate = function (href) {
      var next = parseUrl(String(href));
      var keys = Object.keys(next);
      for (var r = 0; r < keys.length; r += 1) parsedUrl[keys[r]] = next[keys[r]];
      documentValues.URL = next.href;
      documentValues.documentURI = next.href;
      documentValues.baseURI = next.href;
      documentValues.domain = next.hostname;
    };

    try {
      // document.cookie is the host's jar, as a page's is the browser's: what the server set (but
      // HttpOnly ones) shows, and an assignment goes to the jar, which parses its attributes.
      // (A document a script made reads none: the documents section wraps this for those.)
      env.cookies = function () { return bridge.cookieRead(); };

      Object.defineProperty(Document.prototype, "cookie", {
        get: asNative(function () { return bridge.cookieRead(); }, "get cookie"),
        set: asNative(function (value) { bridge.cookieWrite(String(value)); }, "set cookie"),
        enumerable: true,
        configurable: true,
      });
    } catch (error) {}
  }

  var nodePrototype = Node && Node.prototype ? Node.prototype : Element && Element.prototype;

  if (nodePrototype) {
    patch(nodePrototype, "appendChild", appendChild);
    patch(nodePrototype, "insertBefore", function insertBefore(child, before) {
      if (arguments.length < 2) throw env.hideFrames(new TypeError("Failed to execute 'insertBefore' on 'Node': 2 arguments required, but only " + arguments.length + " present."));
      return insertChild(this, child, before, "insertBefore", false);
    });
    patch(nodePrototype, "removeChild", function removeChild(child) {
      var kids = childListOf(this);
      if (!kids || kids.indexOf(child) === -1) {
        throw domException("Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.", "NotFoundError");
      }
      return takeChild(this, child, false);
    });
    patch(nodePrototype, "replaceChild", function replaceChild(child, old) {
      if (arguments.length < 2) throw env.hideFrames(new TypeError("Failed to execute 'replaceChild' on 'Node': 2 arguments required, but only " + arguments.length + " present."));
      var kids = childListOf(this);
      var childState = nodeState(child);
      if (!childState) throw env.hideFrames(new TypeError("Failed to execute 'replaceChild' on 'Node': parameter 1 is not of type 'Node'."));
      if (!nodeState(old)) throw env.hideFrames(new TypeError("Failed to execute 'replaceChild' on 'Node': parameter 2 is not of type 'Node'."));
      if (kids) ensureInsertable(this, nodeState(this), child, childState, null, "replaceChild", old, "Node");
      if (!kids || kids.indexOf(old) === -1) {
        throw domException("Failed to execute 'replaceChild' on 'Node': The node to be replaced is not a child of this node.", "NotFoundError");
      }
      var next = nodeState(old).nextSibling;
      takeChild(this, old, false);
      insertChild(this, child, next === child ? nodeState(child).nextSibling : next, "replaceChild", false);
      return old;
    });
    patch(nodePrototype, "contains", function contains(other) {
      var current = other;

      for (var step = 0; current && step < 64; step += 1) {
        if (current === this) return true;
        current = current.parentNode;
      }

      return false;
    });

    patch(Element.prototype, "matches", function matches(selector) {
      var state = nodeState(this);
      if (!state) return false;

      var wanted = String(selector).trim().toLowerCase();

      if (/^[a-z][a-z0-9-]*$/.test(wanted)) return state.tag === wanted;
      if (wanted.charAt(0) === "#") return state.attrs.id === wanted.slice(1);
      if (wanted.charAt(0) === ".") return String(state.attrs.class || "").split(/\s+/).indexOf(wanted.slice(1)) !== -1;

      return false;
    });

    patch(Element.prototype, "closest", function closest(selector) {
      var current = this;

      for (var step = 0; current && step < 64; step += 1) {
        if (typeof current.matches === "function" && current.matches(selector)) return current;
        current = current.parentNode;
      }

      return null;
    });

    patch(nodePrototype, "dispatchEvent", function dispatchEvent(event) {
      return dispatch(this, event);
    });

    patch(nodePrototype, "getRootNode", function getRootNode() {
      var current = this;

      for (var step = 0; step < 64; step += 1) {
        var parent = current.parentNode;
        if (!parent) return current;
        current = parent;
      }

      return current;
    });
    patch(nodePrototype, "cloneNode", function cloneNode() { return makeElement((nodeState(this) || {}).tag || "div"); });
  }

  if (Element && Element.prototype) {
    patch(Element.prototype, "setAttribute", function setAttribute(key, value) {
      if (arguments.length < 2) throw env.hideFrames(new TypeError("Failed to execute 'setAttribute' on 'Element': 2 arguments required, but only " + arguments.length + " present."));
      setAttr(this, key, String(value));
    });
    patch(Element.prototype, "getAttribute", function getAttribute(key) {
      var name = String(key).toLowerCase();
      return hasAttributeNamed(this, name) ? attributesOf(this)[name] : null;
    });
    patch(Element.prototype, "hasAttribute", function hasAttribute(key) {
      return hasAttributeNamed(this, String(key).toLowerCase());
    });
    patch(Element.prototype, "removeAttribute", function removeAttribute(key) {
      setAttr(this, key, null);
    });
    var makeRect = function (box) {
      var rect = globalThis.DOMRect && globalThis.DOMRect.prototype ? Object.create(globalThis.DOMRect.prototype) : {};

      var fields = {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        top: box.y,
        right: box.x + box.width,
        bottom: box.y + box.height,
        left: box.x,
      };

      env.overrides.set(rect, fields);

      for (var name in fields) {
        try {
          Object.defineProperty(rect, name, { value: fields[name], writable: true, enumerable: true, configurable: true });
        } catch (error) {}
      }

      try {
        Object.defineProperty(rect, "toJSON", {
          value: asNative(function toJSON() { return fields; }, "toJSON"),
          writable: true,
          enumerable: false,
          configurable: true,
        });
      } catch (error) {}

      return rect;
    };

    env.makeRect = makeRect;

    patch(Element.prototype, "getBoundingClientRect", function getBoundingClientRect() {
      var box = env.boxOf(this);
      var offset = globalThis[Symbol.for("wre.scroll")] || { x: 0, y: 0 };
      return makeRect({
        x: box.x - offset.x,
        y: box.y - offset.y,
        width: box.width,
        height: box.height,
      });
    });

    patch(Element.prototype, "getClientRects", function getClientRects() {
      var box = env.boxOf(this);
      if (!box.width && !box.height) return [];

      return [{
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        top: box.y,
        right: box.x + box.width,
        bottom: box.y + box.height,
        left: box.x,
      }];
    });
    patch(Element.prototype, "querySelector", function querySelector() { return null; });
    patch(Element.prototype, "querySelectorAll", function querySelectorAll(selector) {
      return listOf(matchingElements(this, selector), "NodeList");
    });
    var shadowRoots = new WeakMap();

    patch(Element.prototype, "checkVisibility", function checkVisibility() { return true; });

    patch(Element.prototype, "attachShadow", function attachShadow(init) {
      var mode = init && init.mode ? String(init.mode) : "open";
      var root = globalThis.ShadowRoot ? Object.create(globalThis.ShadowRoot.prototype) : {};

      env.overrides.set(root, {
        mode: mode,
        host: this,
        delegatesFocus: Boolean(init && init.delegatesFocus),
        clonable: Boolean(init && init.clonable),
        serializable: Boolean(init && init.serializable),
        slotAssignment: init && init.slotAssignment ? String(init.slotAssignment) : "named",
        innerHTML: "",
        childNodes: [],
        children: [],
        nodeType: 11,
        nodeName: "#document-fragment",
        activeElement: null,
        adoptedStyleSheets: [],
        styleSheets: [],
      });

      shadowRoots.set(this, { mode: mode, root: root });
      return root;
    });

    patchGetter(Element.prototype, "shadowRoot", function () {
      var found = shadowRoots.get(this);
      return found && found.mode === "open" ? found.root : null;
    });
  }

  // The ChildNode and ParentNode mixins (before, after, replaceWith, remove; append, prepend,
  // replaceChildren), as the DOM standard defines them: strings become text nodes, and several
  // nodes go in as one fragment.
  (function installNodeMixins() {
    var ifaceOf = function (node) {
      var state = nodeState(node);
      if (!state) return "Node";
      if (state.nodeType === 9) return "Document";
      if (state.nodeType === 11) return "DocumentFragment";
      if (state.nodeType === 10) return "DocumentType";
      if (state.nodeType === 3 || state.nodeType === 8) return "CharacterData";
      return "Element";
    };

    var convert = function (args, method, iface) {
      var nodes = [];
      for (var index = 0; index < args.length; index += 1) {
        var given = args[index];
        nodes.push(nodeState(given) ? given : globalThis.document.createTextNode(String(given)));
      }
      if (nodes.length === 1) return nodes[0];
      var fragment = globalThis.document.createDocumentFragment();
      for (var at = 0; at < nodes.length; at += 1) insertChild(fragment, nodes[at], null, method, true, undefined, iface);
      return fragment;
    };

    var viable = function (start, step, excluded) {
      for (var node = start; node; node = nodeState(node)[step]) {
        if (excluded.indexOf(node) === -1) return node;
      }
      return null;
    };

    var childNode = {
      before: function before() {
        var state = nodeState(this);
        var parent = state && state.parentNode;
        if (!parent) return;
        var args = Array.prototype.slice.call(arguments);
        var previous = viable(state.previousSibling, "previousSibling", args);
        var node = convert(args, "before", ifaceOf(this));
        var kids = childListOf(parent);
        var reference = previous === null ? kids[0] || null : nodeState(previous).nextSibling;
        insertChild(parent, node, reference, "before", false, undefined, ifaceOf(this));
      },
      after: function after() {
        var state = nodeState(this);
        var parent = state && state.parentNode;
        if (!parent) return;
        var args = Array.prototype.slice.call(arguments);
        var next = viable(state.nextSibling, "nextSibling", args);
        insertChild(parent, convert(args, "after", ifaceOf(this)), next, "after", false, undefined, ifaceOf(this));
      },
      replaceWith: function replaceWith() {
        var state = nodeState(this);
        var parent = state && state.parentNode;
        if (!parent) return;
        var args = Array.prototype.slice.call(arguments);
        var next = viable(state.nextSibling, "nextSibling", args);
        var node = convert(args, "replaceWith", ifaceOf(this));
        if (nodeState(this).parentNode === parent) {
          ensureInsertable(parent, nodeState(parent), node, nodeState(node), null, "replaceWith", this, ifaceOf(this));
          takeChild(parent, this, false);
        }
        insertChild(parent, node, next, "replaceWith", false, undefined, ifaceOf(this));
      },
      remove: function remove() {
        var state = nodeState(this);
        if (state && state.parentNode) takeChild(state.parentNode, this, false);
      },
    };

    var parentNode = {
      append: function append() {
        insertChild(this, convert(arguments, "append", ifaceOf(this)), null, "append", false, undefined, ifaceOf(this));
      },
      prepend: function prepend() {
        var kids = childListOf(this);
        insertChild(this, convert(arguments, "prepend", ifaceOf(this)), kids && kids.length ? kids[0] : null, "prepend", false, undefined, ifaceOf(this));
      },
      replaceChildren: function replaceChildren() {
        var node = convert(arguments, "replaceChildren", ifaceOf(this));
        ensureInsertable(this, nodeState(this), node, nodeState(node), null, "replaceChildren", undefined, ifaceOf(this));
        var kids = childListOf(this).slice();
        for (var index = 0; index < kids.length; index += 1) takeChild(this, kids[index], false);
        insertChild(this, node, null, "replaceChildren", false, undefined, ifaceOf(this));
      },
    };

    var install = function (holderName, methods) {
      var holder = globalThis[holderName] && globalThis[holderName].prototype;
      if (!holder) return;
      Object.keys(methods).forEach(function (name) {
        if (typeof holder[name] === "function") patch(holder, name, methods[name]);
      });
    };

    ["Element", "CharacterData", "DocumentType"].forEach(function (name) { install(name, childNode); });
    ["Element", "Document", "DocumentFragment"].forEach(function (name) { install(name, parentNode); });
  })();

  if (HTMLElement && HTMLElement.prototype) {
    patch(HTMLElement.prototype, "focus", function focus() { return undefined; });
    patch(HTMLElement.prototype, "blur", function blur() { return undefined; });
    patch(HTMLElement.prototype, "click", function click() { return undefined; });
  }

  var gfxCalls = [];
  var gfxReplies = env.graphicsReplies || [];
  var gfxIndex = 0;
  env.gfxCalls = gfxCalls;

  var simple = function (value) {
    if (value === null || value === undefined) return null;
    var type = typeof value;
    if (type === "number" || type === "string" || type === "boolean") return value;

    if (value && typeof value.length === "number" && type === "object") {
      var out = [];
      for (var index = 0; index < Math.min(value.length, 64); index += 1) out.push(simple(value[index]));
      return { list: out, length: value.length, kind: value.constructor ? value.constructor.name : "Array" };
    }

    if (value && contextHandles.has(value)) return { handle: contextHandles.get(value) };

    if (value && typeof value.width === "number" && typeof value.height === "number" && value.data && typeof value.data.length === "number") {
      var pixels = [];
      for (var p = 0; p < value.data.length; p += 1) pixels.push(value.data[p]);
      return { imagedata: { width: value.width, height: value.height, data: pixels } };
    }
    if (value && value.__extension) return { extension: value.__extension };

    if (type === "object") {
      var plain = {};
      for (var key in value) {
        try {
          var member = value[key];
          if (member === null || ["number", "string", "boolean"].indexOf(typeof member) !== -1) plain[key] = member;
        } catch (error) {}
      }
      return plain;
    }

    return null;
  };

  var materialiseReply = function (reply) {
    if (!reply || reply.kind === "primitive") return reply ? reply.value : null;

    if (reply.kind === "imagedata") {
      return env.makeImageData(new Uint8ClampedArray(reply.data), reply.width, reply.height);
    }

    if (reply.kind === "typed") {
      var Constructor = globalThis[reply.name] || Float32Array;
      return new Constructor(reply.values);
    }

    if (reply.kind === "array") return reply.values.slice();

    if (reply.kind === "extension") {
      var extension = {};
      var keys = Object.keys(reply.constants || {});
      for (var index = 0; index < keys.length; index += 1) extension[keys[index]] = reply.constants[keys[index]];
      extension.__extension = reply.id;
      return extension;
    }

    if (reply.kind === "object") {
      var object = {};
      var fields = Object.keys(reply.value || {});
      for (var f = 0; f < fields.length; f += 1) object[fields[f]] = reply.value[fields[f]];
      return object;
    }

    return null;
  };

  var replyIndex = {};
  var replyCursor = {};

  var keyFor = function (handle, method, args) {
    return handle + "|" + method + "|" + JSON.stringify(args);
  };

  for (var r = 0; r < gfxReplies.length; r += 1) {
    var stored = gfxReplies[r];
    var storedKey = keyFor(stored.handle, stored.method, stored.args);
    if (!replyIndex[storedKey]) replyIndex[storedKey] = [];
    replyIndex[storedKey].push(stored);
  }

  var webgl = env.webglProfiles || {};

  var profileFor = function (handle) {
    var kind = String(handle).split(":")[1];
    return webgl[kind] || null;
  };

  var fromProfile = function (handle, method, args) {
    var profile = profileFor(handle);
    if (!profile) return undefined;

    if (method === "getParameter") {
      var entry = profile.parameters[String(args[0])];
      return entry ? materialiseReply(entry) : undefined;
    }

    if (method === "getSupportedExtensions") return profile.supported.slice();

    if (method === "getExtension") {
      var constants = profile.extensions[String(args[0])];
      if (!constants) return null;
      var extension = {};
      var keys = Object.keys(constants);
      for (var index = 0; index < keys.length; index += 1) extension[keys[index]] = constants[keys[index]];
      return extension;
    }

    if (method === "getShaderPrecisionFormat") {
      var format = profile.precision[String(args[0]) + ":" + String(args[1])];
      return format ? { rangeMin: format.rangeMin, rangeMax: format.rangeMax, precision: format.precision } : undefined;
    }

    if (method === "getContextAttributes") {
      if (!profile.attributes) return undefined;
      var attributes = {};
      var fields = Object.keys(profile.attributes);
      for (var f = 0; f < fields.length; f += 1) attributes[fields[f]] = profile.attributes[fields[f]];
      return attributes;
    }

    return undefined;
  };

  env.makeMetrics = function (fields) {
    var metrics = globalThis.TextMetrics && globalThis.TextMetrics.prototype
      ? Object.create(globalThis.TextMetrics.prototype)
      : {};

    env.overrides.set(metrics, fields);

    for (var name in fields) {
      try {
        Object.defineProperty(metrics, name, { value: fields[name], writable: false, enumerable: true, configurable: true });
      } catch (error) {}
    }

    return metrics;
  };

  var shapeFor = function (method, args) {
    if (method === "measureText") {
      return env.makeMetrics({
        width: 0,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 0,
        fontBoundingBoxAscent: 10,
        fontBoundingBoxDescent: 2,
        actualBoundingBoxAscent: 0,
        actualBoundingBoxDescent: 0,
        hangingBaseline: 8,
        alphabeticBaseline: 0,
        ideographicBaseline: -2,
      });
    }

    if (method === "getImageData") {
      var width = Number(args[2]) || 1;
      var height = Number(args[3]) || 1;
      return { width: width, height: height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" };
    }

    if (method === "createImageData") {
      var w = Number(args[0]) || 1;
      var h = Number(args[1]) || 1;
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: "srgb" };
    }

    return undefined;
  };

  var recordGraphics = function (handle, method, args) {
    var encoded = [];
    for (var index = 0; index < args.length; index += 1) encoded.push(simple(args[index]));

    var entry = { handle: handle, method: method, args: encoded };
    gfxCalls.push(entry);
    gfxIndex += 1;

    var pure = fromProfile(handle, method, encoded);
    if (pure !== undefined) return pure;

    var key = keyFor(handle, method, encoded);
    var bucket = replyIndex[key];

    if (!bucket || !bucket.length) {
      if (gfxReplies.length) env.count("gfx miss " + method);
      return shapeFor(method, encoded);
    }

    var cursor = replyCursor[key] || 0;
    var reply = bucket[Math.min(cursor, bucket.length - 1)];
    replyCursor[key] = cursor + 1;

    return materialiseReply(reply.result);
  };

  env.graphicsCallCount = function () {
    return gfxCalls.length;
  };

  env.recordGraphics = recordGraphics;

  var wrapContextPrototype = function (constructor, label) {
    if (!constructor || !constructor.prototype) return;

    var names = Object.getOwnPropertyNames(constructor.prototype);

    for (var index = 0; index < names.length; index += 1) {
      var name = names[index];
      if (name === "constructor" || name === "canvas") continue;

      var descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, name);
      if (!descriptor || typeof descriptor.value !== "function") continue;

      (function (method, arity) {
        try {
          patch(constructor.prototype, method, function () {
            return recordGraphics(contextHandles.get(this) || label, method, arguments);
          });

          Object.defineProperty(constructor.prototype[method], "length", { value: arity, configurable: true });
        } catch (error) {}
      })(name, descriptor.value.length);
    }
  };

  wrapContextPrototype(globalThis.CanvasRenderingContext2D, "2d");
  wrapContextPrototype(globalThis.WebGLRenderingContext, "webgl");
  wrapContextPrototype(globalThis.WebGL2RenderingContext, "webgl2");

  var contextFor = function (canvas, kind) {
    var normalised = String(kind).toLowerCase();

    var constructor =
      normalised === "2d" ? globalThis.CanvasRenderingContext2D :
      normalised === "webgl2" ? globalThis.WebGL2RenderingContext :
      normalised === "webgl" || normalised === "experimental-webgl" ? globalThis.WebGLRenderingContext :
      null;

    if (!constructor || !constructor.prototype) return null;

    var context = Object.create(constructor.prototype);
    contextHandles.set(context, handleOf(canvas) + ":" + normalised);
    Object.defineProperty(context, "canvas", { value: canvas, enumerable: true });
    return context;
  };

  if (globalThis.HTMLCanvasElement && globalThis.HTMLCanvasElement.prototype) {
    patch(globalThis.HTMLCanvasElement.prototype, "getContext", function getContext(kind, attributes) {
            var answer = recordGraphics(handleOf(this), "getContext", [String(kind), attributes]);
      if (gfxReplies.length && answer === null) return null;
      return contextFor(this, kind);
    });

    // A canvas's encoding: what the capture recorded for this draw sequence, else the canvas as
    // a blank image of the asked type (platform.js's env.blankCanvas), as Chrome encodes an
    // untouched canvas; an empty canvas is "data:,". toBlob is platform.js's, built on this.
    patch(globalThis.HTMLCanvasElement.prototype, "toDataURL", function toDataURL(type) {
      var value = recordGraphics(handleOf(this), "toDataURL", arguments);
      if (typeof value === "string" && value !== "data:,") return value;
      var width = Number(this.width) || 0;
      var height = Number(this.height) || 0;
      return width && height && env.blankCanvas ? env.blankCanvas(width, height, type) : "data:,";
    });
  }

  if (globalThis.HTMLMediaElement && globalThis.HTMLMediaElement.prototype) {
    patch(globalThis.HTMLMediaElement.prototype, "canPlayType", function canPlayType(type) {
      var tag = (nodeState(this) || {}).tag || "media";
      var table = env.media ? env.media[tag === "audio" ? "audio" : "video"] : null;

      if (table && Object.prototype.hasOwnProperty.call(table, String(type))) return table[String(type)];

      var answer = env.recordGraphics ? env.recordGraphics(tag, "canPlayType", [String(type)]) : undefined;
      return typeof answer === "string" ? answer : bridge.canPlayType(String(type));
    });
    patch(globalThis.HTMLMediaElement.prototype, "play", function play() { return Promise.resolve(); });
    patch(globalThis.HTMLMediaElement.prototype, "load", function load() { return undefined; });
  }

  var storagePrototype = protoOf(globalThis.localStorage);

  if (storagePrototype) {
    var stores = new WeakMap();

    var stateOf = function (instance) {
      var state = stores.get(instance);

      if (!state) {
        state = Object.create(null);
        stores.set(instance, state);
      }

      return state;
    };

    patch(storagePrototype, "getItem", function getItem(key) {
      var state = stateOf(this);
      return Object.prototype.hasOwnProperty.call(state, String(key)) ? state[String(key)] : null;
    });
    patch(storagePrototype, "setItem", function setItem(key, value) {
      stateOf(this)[String(key)] = String(value);
    });
    patch(storagePrototype, "removeItem", function removeItem(key) {
      delete stateOf(this)[String(key)];
    });
    patch(storagePrototype, "clear", function clear() {
      stores.set(this, Object.create(null));
    });
    patch(storagePrototype, "key", function key(index) {
      return Object.keys(stateOf(this))[index] || null;
    });
    patchGetter(storagePrototype, "length", function () {
      return Object.keys(stateOf(this)).length;
    });
  }

  var cryptoPrototype = protoOf(globalThis.crypto);

  if (cryptoPrototype) {
    patch(cryptoPrototype, "getRandomValues", function getRandomValues(view) {
      var hex = bridge.random(view.byteLength);
      var out = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      for (var index = 0; index < out.length; index += 1) out[index] = parseInt(hex.substr(index * 2, 2), 16);
      return view;
    });
    patch(cryptoPrototype, "randomUUID", function randomUUID() { return bridge.uuid(); });
  }

  if (globalThis.SubtleCrypto && globalThis.SubtleCrypto.prototype && bridge.digest) {
    var hexOf = function (data) {
      var bytes = null;
      var brand = Object.prototype.toString.call(data);

      if (brand === "[object ArrayBuffer]") bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      else if (data && typeof data.length === "number" && typeof data[0] === "number") bytes = data;
      else if (typeof data === "string") bytes = utf8Encode(data);

      if (!bytes) return null;

      var out = "";
      for (var index = 0; index < bytes.length; index += 1) out += (bytes[index] < 16 ? "0" : "") + bytes[index].toString(16);
      return out;
    };

    patch(globalThis.SubtleCrypto.prototype, "digest", function digest(algorithm, data) {
      var name = algorithm && typeof algorithm === "object" ? algorithm.name : algorithm;
      var hex = hexOf(data);

      if (hex === null) {
        env.count("digest refused " + Object.prototype.toString.call(data));
        return Promise.reject(new TypeError("Failed to execute 'digest' on 'SubtleCrypto': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'."));
      }

      var out = bridge.digest(String(name), hex);

      if (out === null) {
        return Promise.reject(domException("Unrecognized name.", "NotSupportedError"));
      }

      var bytes = new Uint8Array(out.length / 2);
      for (var index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(out.substr(index * 2, 2), 16);
      return Promise.resolve(bytes.buffer);
    });
  }

  var performancePrototype = protoOf(globalThis.performance);

  if (performancePrototype) {
    patch(performancePrototype, "now", function now() { return env.clock(); });
    // The page's time origin is the moment its clock started, on the same timeline as Date (as in
    // a browser, timeOrigin + now() reads the wall clock); the captured one is hours stale.
    var timeOrigin = Date.now() - env.clock();
    patchGetter(performancePrototype, "timeOrigin", function () { return timeOrigin; });
    patch(performancePrototype, "getEntriesByType", function getEntriesByType(type) { return JSON.parse(bridge.entries(String(type))); });
    patch(performancePrototype, "getEntriesByName", function getEntriesByName() { return []; });
    patch(performancePrototype, "getEntries", function getEntries() { return JSON.parse(bridge.entries("navigation")); });
    patch(performancePrototype, "mark", function mark() { return undefined; });
    patch(performancePrototype, "measure", function measure() { return undefined; });
    patch(performancePrototype, "clearMarks", function clearMarks() { return undefined; });
  }


  var navigatorPrototype = protoOf(globalThis.navigator);


  var recordedDuration = function (name) {
    return (traits.durations && traits.durations[name]) || 0;
  };

  if (navigatorPrototype) {
    patch(navigatorPrototype, "sendBeacon", function sendBeacon() { return true; });
    patch(navigatorPrototype, "javaEnabled", function javaEnabled() { return false; });
    patch(navigatorPrototype, "vibrate", function vibrate() { return false; });
  }

  var keyboard = globalThis.navigator && globalThis.navigator.keyboard;

  if (keyboard && traits.keyboardLayout) {
    var layoutPairs = traits.keyboardLayout;

    var layoutMap = function () {
      var proto = globalThis.KeyboardLayoutMap && globalThis.KeyboardLayoutMap.prototype;
      var map = proto ? Object.create(proto) : {};
      var keys = [];
      var values = [];

      for (var index = 0; index < layoutPairs.length; index += 1) {
        keys.push(layoutPairs[index][0]);
        values.push(layoutPairs[index][1]);
      }

      var pairsOf = function () {
        var out = [];
        for (var at = 0; at < keys.length; at += 1) out.push([keys[at], values[at]]);
        return out;
      };

      var fields = {
        size: keys.length,
        get: asNative(function get(key) {
          var at = keys.indexOf(String(key));
          return at === -1 ? undefined : values[at];
        }, "get"),
        has: asNative(function has(key) { return keys.indexOf(String(key)) !== -1; }, "has"),
        keys: asNative(function keys_() { return keys.slice()[Symbol.iterator](); }, "keys"),
        values: asNative(function values_() { return values.slice()[Symbol.iterator](); }, "values"),
        entries: asNative(function entries() { return pairsOf()[Symbol.iterator](); }, "entries"),
        forEach: asNative(function forEach(callback, self) {
          for (var at = 0; at < keys.length; at += 1) callback.call(self, values[at], keys[at], map);
          return undefined;
        }, "forEach"),
      };

      for (var name in fields) {
        Object.defineProperty(map, name, { value: fields[name], writable: false, enumerable: false, configurable: true });
      }

      Object.defineProperty(map, Symbol.iterator, { value: fields.entries, writable: false, enumerable: false, configurable: true });
      return map;
    };

    patch(protoOf(keyboard) || keyboard, "getLayoutMap", function getLayoutMap() {
      var made = layoutMap();

      return new Promise(function (resolve) {
        later(function () {
          env.spend(recordedDuration("keyboardLayout"));
          resolve(made);
        }, 0);
      });
    });
  }

  var mediaDevices = globalThis.navigator && globalThis.navigator.mediaDevices;

  if (mediaDevices) {
    patch(protoOf(mediaDevices) || mediaDevices, "getSupportedConstraints", function getSupportedConstraints() {
      return {
        aspectRatio: true, autoGainControl: true, channelCount: true, deviceId: true, displaySurface: true,
        echoCancellation: true, facingMode: true, frameRate: true, groupId: true, height: true,
        noiseSuppression: true, sampleRate: true, sampleSize: true, width: true,
      };
    });
  }

  if (globalThis.FontFace && globalThis.FontFace.prototype) {
    patch(globalThis.FontFace.prototype, "load", function load() {
      var face = this;
      return Promise.resolve(face);
    });
  }


  var alsoAsks = { attributionReporting: true };

  var readInit = function (init, keys, asks) {
    var out = {};
    if (init === null || (typeof init !== "object" && typeof init !== "function")) return out;

    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      var value;

      try {
        value = init[key];
      } catch (error) {
        value = undefined;
      }

      if (asks && asks[key]) {
        try {
          key in init;
        } catch (error) {}
      }

      if (value !== undefined) out[key] = value;
    }

    return out;
  };

  var dictionaries = {
    UIEvent: ["bubbles", "cancelable", "composed", "detail", "sourceCapabilities", "view"],
    InputEvent: ["bubbles", "cancelable", "composed", "detail", "sourceCapabilities", "view", "data", "dataTransfer", "inputType", "isComposing", "targetRanges"],
  };

  for (var dictName in dictionaries) {
    (function (name, keys) {
      if (typeof globalThis[name] !== "function") return;

      env.behaviour["window." + name] = function (first, second) {
        var init = second;
        var read = readInit(init, keys, alsoAsks);

        try {
          this.type = String(first);
        } catch (error) {}

        return undefined;
      };
    })(dictName, dictionaries[dictName]);
  }

  var makeIterator = function (entries) {
    var index = 0;

    var iterator = {
      next: asNative(function next() {
        if (index >= entries.length) return { value: undefined, done: true };
        var value = entries[index];
        index += 1;
        return { value: value, done: false };
      }, "next"),
    };

    Object.defineProperty(iterator, Symbol.iterator, {
      value: asNative(function () { return iterator; }, "[Symbol.iterator]"),
      writable: true,
      configurable: true,
    });

    return iterator;
  };

  var defineIterable = function (holder, entriesOf, extras) {
    if (!holder) return;

    Object.defineProperty(holder, Symbol.iterator, {
      value: asNative(function () { return makeIterator(entriesOf.call(this)); }, "[Symbol.iterator]"),
      writable: true,
      enumerable: false,
      configurable: true,
    });

    if (!extras) return;

    patch(holder, "values", function values() {
      var entries = entriesOf.call(this);
      return makeIterator(extras === "map" ? entries.map(function (pair) { return pair[1]; }) : entries);
    });

    patch(holder, "keys", function keys() {
      var entries = entriesOf.call(this);
      return makeIterator(extras === "map" ? entries.map(function (pair) { return pair[0]; }) : entries);
    });

    patch(holder, "entries", function entries() {
      var found = entriesOf.call(this);
      return makeIterator(extras === "map" ? found : found.map(function (value, index) { return [index, value]; }));
    });

    patch(holder, "forEach", function forEach(visit, self) {
      var found = entriesOf.call(this);

      for (var index = 0; index < found.length; index += 1) {
        if (extras === "map") visit.call(self, found[index][1], found[index][0], this);
        else visit.call(self, found[index], index, this);
      }

      return undefined;
    });
  };

  var indexedEntries = function () {
    var out = [];
    var length = Number(this.length) || 0;
    for (var index = 0; index < length; index += 1) out.push(this[index]);
    return out;
  };

  var iterates = function (holder) {
    try {
      var existing = holder[Symbol.iterator];
      if (typeof existing !== "function") return false;
      var made = existing.call({ length: 0 });
      return Boolean(made) && typeof made.next === "function";
    } catch (error) {
      return false;
    }
  };

  var installIterators = function () {
    var names = Object.getOwnPropertyNames(globalThis);

    for (var index = 0; index < names.length; index += 1) {
      var value;

      try {
        value = globalThis[names[index]];
      } catch (error) {
        continue;
      }

      if (typeof value !== "function" || !value.prototype || !env.isHost(value.prototype)) continue;

      var proto = value.prototype;
      if (!Object.getOwnPropertyDescriptor(proto, "item") && !Object.getOwnPropertyDescriptor(proto, Symbol.iterator)) continue;
      if (iterates(proto)) continue;

      defineIterable(proto, indexedEntries, null);
    }
  };

  if (typeof globalThis.DataTransfer === "function" && globalThis.DataTransferItemList && globalThis.FileList && globalThis.DataTransferItem) {
    var transferOf = new WeakMap();

    var indexList = function (list, entries) {
      var index = 0;

      while (Object.prototype.hasOwnProperty.call(list, String(index))) {
        delete list[String(index)];
        index += 1;
      }

      for (index = 0; index < entries.length; index += 1) {
        Object.defineProperty(list, String(index), { value: entries[index], enumerable: true, configurable: true });
      }

      env.overrides.set(list, { length: entries.length });
    };

    var refreshTransfer = function (state) {
      var files = [];
      var types = [];

      for (var index = 0; index < state.entries.length; index += 1) {
        var entry = state.entries[index];
        if (entry.kind === "file") files.push(entry.data);
        else if (types.indexOf(entry.type) === -1) types.push(entry.type);
      }

      if (files.length && types.indexOf("Files") === -1) types.push("Files");

      indexList(state.items, state.entries.map(function (entry) { return entry.item; }));
      indexList(state.files, files);

      env.overrides.set(state.transfer, {
        dropEffect: "none",
        effectAllowed: "none",
        items: state.items,
        files: state.files,
        types: types,
      });
    };

    env.behaviour["window.DataTransfer"] = function () {
      var state = {
        transfer: this,
        entries: [],
        items: Object.create(globalThis.DataTransferItemList.prototype),
        files: Object.create(globalThis.FileList.prototype),
      };

      transferOf.set(state.items, state);
      refreshTransfer(state);
      return undefined;
    };

    patch(globalThis.DataTransferItemList.prototype, "add", function add(data, type) {
      var state = transferOf.get(this);
      if (!state) return null;

      var isFile = false;

      try {
        isFile = globalThis.File ? data instanceof globalThis.File : false;
      } catch (error) {
        isFile = false;
      }

      var item = Object.create(globalThis.DataTransferItem.prototype);
      var entry = isFile
        ? { kind: "file", type: String(data.type || ""), data: data, item: item }
        : { kind: "string", type: String(type === undefined ? "" : type), data: String(data), item: item };

      env.overrides.set(item, { kind: entry.kind, type: entry.type });
      state.entries.push(entry);
      refreshTransfer(state);

      return item;
    });

    patch(globalThis.DataTransferItemList.prototype, "remove", function remove(index) {
      var state = transferOf.get(this);
      if (!state) return undefined;
      state.entries.splice(Number(index), 1);
      refreshTransfer(state);
      return undefined;
    });

    patch(globalThis.DataTransferItemList.prototype, "clear", function clear() {
      var state = transferOf.get(this);
      if (!state) return undefined;
      state.entries.length = 0;
      refreshTransfer(state);
      return undefined;
    });

    patch(globalThis.FileList.prototype, "item", function item(index) {
      var value = this[String(Number(index))];
      return value === undefined ? null : value;
    });
  }

  var pairsFrom = function (init) {
    var pairs = [];

    if (init === undefined || init === null) return pairs;

    if (pairState.has(init)) return pairState.get(init).map(function (pair) { return [pair[0], pair[1]]; });

    if (typeof init === "string") {
      var text = init.charAt(0) === "?" ? init.slice(1) : init;
      var parts = text.split("&");

      for (var index = 0; index < parts.length; index += 1) {
        if (!parts[index]) continue;
        var at = parts[index].indexOf("=");
        var key = at === -1 ? parts[index] : parts[index].slice(0, at);
        var value = at === -1 ? "" : parts[index].slice(at + 1);

        try {
          pairs.push([decodeURIComponent(key.replace(/\+/g, " ")), decodeURIComponent(value.replace(/\+/g, " "))]);
        } catch (error) {
          pairs.push([key, value]);
        }
      }

      return pairs;
    }

    if (Array.isArray(init)) {
      for (var entry = 0; entry < init.length; entry += 1) pairs.push([String(init[entry][0]), String(init[entry][1])]);
      return pairs;
    }

    if (typeof init === "object") {
      var names = Object.keys(init);
      for (var name = 0; name < names.length; name += 1) pairs.push([names[name], String(init[names[name]])]);
    }

    return pairs;
  };

  var pairState = new WeakMap();
  var pairsOf = function (holder) {
    var found = pairState.get(holder);
    if (!found) {
      found = [];
      pairState.set(holder, found);
    }
    return found;
  };

  var installPairApi = function (constructor, lowercase) {
    if (typeof constructor !== "function" || !constructor.prototype) return;

    var proto = constructor.prototype;
    var normalise = function (name) { return lowercase ? String(name).toLowerCase() : String(name); };

    patch(proto, "append", function append(name, value) {
      pairsOf(this).push([normalise(name), String(value)]);
      return undefined;
    });

    patch(proto, "set", function set(name, value) {
      var pairs = pairsOf(this);
      var key = normalise(name);
      var replaced = false;

      for (var index = pairs.length - 1; index >= 0; index -= 1) {
        if (pairs[index][0] !== key) continue;
        if (replaced) pairs.splice(index, 1);
        else {
          pairs[index][1] = String(value);
          replaced = true;
        }
      }

      if (!replaced) pairs.push([key, String(value)]);
      return undefined;
    });

    patch(proto, "get", function get(name) {
      var pairs = pairsOf(this);
      var key = normalise(name);

      for (var index = 0; index < pairs.length; index += 1) if (pairs[index][0] === key) return pairs[index][1];
      return null;
    });

    patch(proto, "getAll", function getAll(name) {
      var key = normalise(name);
      return pairsOf(this).filter(function (pair) { return pair[0] === key; }).map(function (pair) { return pair[1]; });
    });

    patch(proto, "has", function has(name) {
      var key = normalise(name);
      return pairsOf(this).some(function (pair) { return pair[0] === key; });
    });

    patch(proto, "delete", function remove(name) {
      var key = normalise(name);
      var pairs = pairsOf(this);

      for (var index = pairs.length - 1; index >= 0; index -= 1) if (pairs[index][0] === key) pairs.splice(index, 1);
      return undefined;
    });

    patchGetter(proto, "size", function () { return pairsOf(this).length; });
    defineIterable(proto, function () { return pairsOf(this).map(function (pair) { return [pair[0], pair[1]]; }); }, "map");
  };

  if (typeof globalThis.URLSearchParams === "function") {
    env.behaviour["window.URLSearchParams"] = function (init) {
      pairState.set(this, pairsFrom(init));
      return undefined;
    };

    installPairApi(globalThis.URLSearchParams, false);

    patch(globalThis.URLSearchParams.prototype, "sort", function sort() {
      pairsOf(this).sort(function (left, right) { return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0; });
      return undefined;
    });

    patch(globalThis.URLSearchParams.prototype, "toString", function toString() {
      return pairsOf(this)
        .map(function (pair) { return encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]); })
        .join("&");
    });
  }


  if (typeof globalThis.URL === "function") {
    var urlState = new WeakMap();

    var splitUrl = function (text) {
      var match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/)?([^/?#]*)?([^?#]*)?(\?[^#]*)?(#.*)?$/.exec(String(text));
      if (!match) return null;

      return {
        scheme: match[1] || "",
        slashes: Boolean(match[2]),
        authority: match[3] || "",
        path: match[4] || "",
        query: match[5] || "",
        hash: match[6] || "",
      };
    };

    var normalisePath = function (path) {
      var parts = String(path).split("/");
      var out = [];

      for (var index = 0; index < parts.length; index += 1) {
        var part = parts[index];
        if (part === ".") continue;

        if (part === "..") {
          if (out.length > 1) out.pop();
          continue;
        }

        out.push(part);
      }

      return out.join("/");
    };

    var defaultPorts = { "http:": "80", "https:": "443", "ws:": "80", "wss:": "443", "ftp:": "21" };

    var buildUrl = function (input, base) {
      var text = String(input).trim();
      var piece = splitUrl(text);
      if (!piece) return null;

      var parent = base === undefined || base === null ? null : buildUrl(base, undefined);
      if (base !== undefined && base !== null && !parent) return null;

      var scheme = piece.scheme;
      var authority = piece.slashes ? piece.authority : "";
      var path = piece.slashes ? piece.path : (piece.authority || "") + piece.path;
      var query = piece.query;
      var hash = piece.hash;

      if (!scheme) {
        if (!parent) return null;
        scheme = parent.protocol;

        if (!piece.slashes) {
          authority = parent.host;

          if (!path) {
            path = parent.pathname;
            if (!query) query = parent.search;
          } else if (path.charAt(0) !== "/") {
            path = parent.pathname.replace(/[^/]*$/, "") + path;
          }
        }
      }

      var special = scheme === "http:" || scheme === "https:" || scheme === "ws:" || scheme === "wss:" || scheme === "ftp:" || scheme === "file:";

      if (special && !authority && !parent) return null;

      var credentials = "";
      var hostPort = authority;
      var at = authority.lastIndexOf("@");

      if (at !== -1) {
        credentials = authority.slice(0, at);
        hostPort = authority.slice(at + 1);
      }

      var username = "";
      var password = "";

      if (credentials) {
        var colon = credentials.indexOf(":");
        username = colon === -1 ? credentials : credentials.slice(0, colon);
        password = colon === -1 ? "" : credentials.slice(colon + 1);
      }

      var hostname = hostPort;
      var port = "";
      var portAt = hostPort.lastIndexOf(":");

      if (portAt !== -1 && hostPort.indexOf("]") < portAt) {
        hostname = hostPort.slice(0, portAt);
        port = hostPort.slice(portAt + 1);
      }

      if (special && port && defaultPorts[scheme] === port) port = "";
      if (special) hostname = hostname.toLowerCase();
      if (special && !path) path = "/";
      if (special && path && path.charAt(0) !== "/") path = "/" + path;

      path = normalisePath(path);

      var host = hostname + (port ? ":" + port : "");
      var origin = special && hostname ? scheme + "//" + host : "null";
      var href = scheme + (special || piece.slashes ? "//" : "") + (username ? username + (password ? ":" + password : "") + "@" : "") + host + path + query + hash;

      return {
        href: href,
        origin: origin,
        protocol: scheme,
        username: username,
        password: password,
        host: host,
        hostname: hostname,
        port: port,
        pathname: path,
        search: query === "?" ? "" : query,
        hash: hash === "#" ? "" : hash,
      };
    };

    var RealUrl = globalThis.URL;

    var UrlShell = function URL(input, base) {
      if (new.target === undefined) {
        throw env.hideFrames(new TypeError("Failed to construct 'URL': Please use the 'new' operator, this DOM object constructor cannot be called as a function."));
      }

      var parsed = buildUrl(input, base);

      if (!parsed) {
        throw env.hideFrames(new TypeError("Failed to construct 'URL': Invalid URL"));
      }

      var made = Object.create(RealUrl.prototype);
      urlState.set(made, parsed);
      return made;
    };

    asNative(UrlShell, "URL");

    try {
      Object.defineProperty(UrlShell, "prototype", { value: RealUrl.prototype, writable: false, enumerable: false, configurable: false });
      Object.defineProperty(UrlShell, "length", { value: 1, configurable: true });
      Object.defineProperty(RealUrl.prototype, "constructor", { value: UrlShell, writable: true, enumerable: false, configurable: true });
    } catch (error) {}

    for (var staticName of Object.getOwnPropertyNames(RealUrl)) {
      if (staticName === "prototype" || staticName === "length" || staticName === "name") continue;

      try {
        Object.defineProperty(UrlShell, staticName, Object.getOwnPropertyDescriptor(RealUrl, staticName));
      } catch (error) {}
    }

    try {
      Object.defineProperty(globalThis, "URL", { value: UrlShell, writable: true, enumerable: false, configurable: true });
      if (globalThis.webkitURL) Object.defineProperty(globalThis, "webkitURL", { value: UrlShell, writable: true, enumerable: false, configurable: true });
    } catch (error) {}

    var objectUrls = new Map();

    patch(UrlShell, "createObjectURL", function createObjectURL(source) {
      if (arguments.length === 0) {
        throw env.hideFrames(new TypeError("Failed to execute 'createObjectURL' on 'URL': 1 argument required, but only 0 present."));
      }

      if (source === null || (typeof source !== "object" && typeof source !== "function")) {
        throw env.hideFrames(new TypeError("Failed to execute 'createObjectURL' on 'URL': Overload resolution failed."));
      }

      var address = "blob:" + String(globalThis.location.origin) + "/" + noiseUuid();
      objectUrls.set(address, source);
      return address;
    });

    patch(UrlShell, "revokeObjectURL", function revokeObjectURL(address) {
      objectUrls.delete(String(address));
      return undefined;
    });

    env.objectUrls = objectUrls;

    var urlFields = ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"];

    for (var urlIndex = 0; urlIndex < urlFields.length; urlIndex += 1) {
      (function (name) {
        patchGetter(globalThis.URL.prototype, name, function () {
          var parsed = urlState.get(this);
          return parsed ? parsed[name] : "";
        });
      })(urlFields[urlIndex]);
    }

    patchGetter(globalThis.URL.prototype, "searchParams", function () {
      var parsed = urlState.get(this);
      return new globalThis.URLSearchParams(parsed ? parsed.search : "");
    });

    patch(globalThis.URL.prototype, "toString", function toString() {
      var parsed = urlState.get(this);
      return parsed ? parsed.href : "";
    });

    patch(globalThis.URL.prototype, "toJSON", function toJSON() {
      var parsed = urlState.get(this);
      return parsed ? parsed.href : "";
    });

    patch(UrlShell, "canParse", function canParse(input, base) {
      return Boolean(buildUrl(input, base));
    });

    patch(UrlShell, "parse", function parse(input, base) {
      if (!buildUrl(input, base)) return null;
      return new globalThis.URL(input, base);
    });

    env.parseUrlText = buildUrl;
  }

  if (globalThis.Animation && globalThis.Animation.prototype && globalThis.KeyframeEffect && globalThis.Element) {
    var effectTiming = new WeakMap();

    var computedTiming = function (timing) {
      var duration = typeof timing.duration === "number" ? timing.duration : 0;
      var activeDuration = duration * timing.iterations;

      return {
        delay: timing.delay,
        endDelay: timing.endDelay,
        fill: timing.fill === "auto" ? "none" : timing.fill,
        iterationStart: timing.iterationStart,
        iterations: timing.iterations,
        duration: timing.duration,
        direction: timing.direction,
        easing: timing.easing,
        endTime: Math.max(timing.delay + activeDuration + timing.endDelay, 0),
        activeDuration: activeDuration,
        localTime: 0,
        progress: 0,
        currentIteration: 0,
      };
    };

    patch(globalThis.KeyframeEffect.prototype, "getComputedTiming", function getComputedTiming() {
      var timing = effectTiming.get(this);
      return timing ? computedTiming(timing) : undefined;
    });

    patch(globalThis.KeyframeEffect.prototype, "getTiming", function getTiming() {
      var timing = effectTiming.get(this);
      if (!timing) return undefined;

      return {
        delay: timing.delay,
        endDelay: timing.endDelay,
        fill: timing.fill,
        iterationStart: timing.iterationStart,
        iterations: timing.iterations,
        duration: timing.duration,
        direction: timing.direction,
        easing: timing.easing,
      };
    });

    patch(globalThis.KeyframeEffect.prototype, "getKeyframes", function getKeyframes() {
      var timing = effectTiming.get(this);
      return timing ? timing.keyframes.slice() : [];
    });

    patch(globalThis.Animation.prototype, "play", function play() { return undefined; });
    patch(globalThis.Animation.prototype, "pause", function pause() { return undefined; });
    patch(globalThis.Animation.prototype, "cancel", function cancel() { return undefined; });
    patch(globalThis.Animation.prototype, "finish", function finish() { return undefined; });
    patch(globalThis.Animation.prototype, "reverse", function reverse() { return undefined; });

    patch(globalThis.Element.prototype, "animate", function animate(keyframes, options) {
      var timing = {
        delay: 0,
        endDelay: 0,
        fill: "auto",
        iterationStart: 0,
        iterations: 1,
        duration: "auto",
        direction: "normal",
        easing: "linear",
        keyframes: Array.isArray(keyframes) ? keyframes : [],
      };

      if (typeof options === "number") {
        timing.duration = options;
      } else if (options !== null && typeof options === "object") {
        var fields = ["delay", "endDelay", "fill", "iterationStart", "iterations", "duration", "direction", "easing"];
        for (var index = 0; index < fields.length; index += 1) {
          if (options[fields[index]] !== undefined) timing[fields[index]] = options[fields[index]];
        }
      }

      var effect = Object.create(globalThis.KeyframeEffect.prototype);
      effectTiming.set(effect, timing);

      env.overrides.set(effect, { target: this, pseudoElement: null, composite: "replace" });

      var animation = Object.create(globalThis.Animation.prototype);
      var timeline = globalThis.DocumentTimeline ? Object.create(globalThis.DocumentTimeline.prototype) : null;

      if (timeline) env.overrides.set(timeline, { currentTime: env.clock() });

      env.overrides.set(animation, {
        effect: effect,
        timeline: timeline,
        startTime: null,
        currentTime: 0,
        overallProgress: 0,
        playbackRate: 1,
        playState: "running",
        replaceState: "active",
        pending: false,
        id: "",
        finished: Promise.resolve(animation),
        ready: Promise.resolve(animation),
      });

      return animation;
    });

    patch(globalThis.Document.prototype, "getAnimations", function getAnimations() { return []; });
  }

  if (globalThis.FontFaceSet && globalThis.FontFaceSet.prototype) {
    var fontFaces = new WeakMap();
    var facesOf = function (holder) {
      var found = fontFaces.get(holder);
      if (!found) {
        found = [];
        fontFaces.set(holder, found);
      }
      return found;
    };

    var fontProto = globalThis.FontFaceSet.prototype;

    patch(fontProto, "add", function add(face) {
      var faces = facesOf(this);
      if (faces.indexOf(face) === -1) faces.push(face);
      return this;
    });

    patch(fontProto, "delete", function remove(face) {
      var faces = facesOf(this);
      var at = faces.indexOf(face);
      if (at === -1) return false;
      faces.splice(at, 1);
      return true;
    });

    patch(fontProto, "clear", function clear() {
      facesOf(this).length = 0;
      return undefined;
    });

    patch(fontProto, "has", function has(face) { return facesOf(this).indexOf(face) !== -1; });
    patch(fontProto, "check", function check() { return true; });
    patch(fontProto, "load", function load() { return Promise.resolve([]); });
    patchGetter(fontProto, "size", function () { return facesOf(this).length; });
    patchGetter(fontProto, "status", function () { return "loaded"; });
    patchGetter(fontProto, "ready", function () { return Promise.resolve(this); });

    defineIterable(fontProto, function () { return facesOf(this).slice(); }, "set");
  }

  if (globalThis.DOMTokenList && globalThis.DOMTokenList.prototype && globalThis.Element && globalThis.Element.prototype) {
    var tokenOwner = new WeakMap();
    var tokenLists = new WeakMap();

    // Each list reads and writes one attribute of its element (class for classList, rel for
    // relList, sandbox, blocking), and knows the tokens it supports (none for classList).
    var tokenAttribute = new WeakMap();
    var tokenSupported = new WeakMap();

    var tokensOf = function (list) {
      var owner = tokenOwner.get(list);
      var text = owner ? String(owner.getAttribute(tokenAttribute.get(list) || "class") || "") : "";
      var seen = [];
      text.split(/[\t\n\f\r ]+/).forEach(function (token) { if (token.length > 0 && seen.indexOf(token) === -1) seen.push(token); });
      return seen;
    };

    var writeTokens = function (list, tokens) {
      var owner = tokenOwner.get(list);
      if (owner) owner.setAttribute(tokenAttribute.get(list) || "class", tokens.join(" "));
    };

    var tokenProto = globalThis.DOMTokenList.prototype;

    patch(tokenProto, "contains", function contains(token) { return tokensOf(this).indexOf(String(token)) !== -1; });
    patch(tokenProto, "item", function item(index) {
      var tokens = tokensOf(this);
      return tokens[Number(index)] === undefined ? null : tokens[Number(index)];
    });

    patch(tokenProto, "add", function add() {
      var tokens = tokensOf(this);
      for (var index = 0; index < arguments.length; index += 1) if (tokens.indexOf(String(arguments[index])) === -1) tokens.push(String(arguments[index]));
      writeTokens(this, tokens);
      return undefined;
    });

    patch(tokenProto, "remove", function remove() {
      var tokens = tokensOf(this);
      for (var index = 0; index < arguments.length; index += 1) {
        var at = tokens.indexOf(String(arguments[index]));
        if (at !== -1) tokens.splice(at, 1);
      }
      writeTokens(this, tokens);
      return undefined;
    });

    patch(tokenProto, "toggle", function toggle(token) {
      var tokens = tokensOf(this);
      var at = tokens.indexOf(String(token));

      if (at === -1) tokens.push(String(token));
      else tokens.splice(at, 1);

      writeTokens(this, tokens);
      return at === -1;
    });

    patch(tokenProto, "replace", function replace(from, to) {
      var tokens = tokensOf(this);
      var at = tokens.indexOf(String(from));
      if (at === -1) return false;
      tokens[at] = String(to);
      writeTokens(this, tokens);
      return true;
    });

    patch(tokenProto, "supports", function supports(token) {
      var supported = tokenSupported.get(this);
      if (!supported) throw env.hideFrames(new TypeError("Failed to execute 'supports' on 'DOMTokenList': DOMTokenList has no supported tokens."));
      return supported.indexOf(String(token).toLowerCase()) !== -1;
    });
    patch(tokenProto, "toString", function toString() { return tokensOf(this).join(" "); });
    patchGetter(tokenProto, "length", function () { return tokensOf(this).length; });
    patchGetter(tokenProto, "value", function () { return tokensOf(this).join(" "); });
    defineIterable(tokenProto, function () { return tokensOf(this); }, "list");

    // The element's token list over `attribute`, the same object each time.
    var tokenListOf = function (element, attribute, supported) {
      var lists = tokenLists.get(element);
      if (!lists) {
        lists = Object.create(null);
        tokenLists.set(element, lists);
      }
      if (lists[attribute]) return lists[attribute];

      var list = Object.create(tokenProto);
      tokenOwner.set(list, element);
      tokenAttribute.set(list, attribute);
      if (supported) tokenSupported.set(list, supported);
      lists[attribute] = list;
      return list;
    };

    env.tokenList = tokenListOf;

    patchGetter(globalThis.Element.prototype, "classList", function () { return tokenListOf(this, "class", null); });
  }

  if (typeof globalThis.FormData === "function") {
    env.behaviour["window.FormData"] = function () {
      pairState.set(this, []);
      return undefined;
    };

    installPairApi(globalThis.FormData, false);
  }

  var embedderWindow = null;

  try {
    embedderWindow = bridge.embedder ? bridge.embedder() : null;
  } catch (error) {}

  try {
    Object.defineProperty(globalThis, "frameElement", {
      get: asNative(function () {
        try {
          return bridge.frameElement ? bridge.frameElement() : null;
        } catch (error) {
          return null;
        }
      }, "get frameElement"),
      enumerable: true,
      configurable: true,
    });
  } catch (error) {}

  var referrerHref = "";

  try {
    referrerHref = String(bridge.referrer() || "");
  } catch (error) {}

  var parent = embedderWindow || (referrerHref ? Object.create(protoOf(globalThis) || Object.prototype) : globalThis);

  var embedder = (function () {
    var href = "";

    try {
      href = String(bridge.referrer() || "");
    } catch (error) {}

    var match = href.match(/^(https?:\/\/([^:/]+)(?::(\d+))?)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/);
    if (!match) return null;

    return {
      href: href,
      origin: match[1],
      hostname: match[2],
      port: match[3] || "",
      pathname: match[4] || "/",
      search: match[5] || "",
      hash: match[6] || "",
      protocol: match[1].split(":")[0] + ":",
      host: match[2] + (match[3] ? ":" + match[3] : ""),
    };
  })();

  var ourOrigin = (function () {
    try {
      return String(globalThis.location.origin);
    } catch (error) {
      return "";
    }
  })();

  var frameLocation = {};

  if (embedder && !embedderWindow) {
    var acrossOrigins = embedder.origin !== ourOrigin;
    var locationFields = ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"];

    for (var lf = 0; lf < locationFields.length; lf += 1) {
      (function (field) {
        try {
          Object.defineProperty(frameLocation, field, {
            get: asNative(function () {
              if (!acrossOrigins) return embedder[field];

              throw domException(
                "Failed to read a named property '" + field + "' from 'Location': Blocked a frame with origin \"" +
                  ourOrigin +
                  "\" from accessing a cross-origin frame.",
                "SecurityError",
              );
            }, "get " + field),
            enumerable: true,
            configurable: true,
          });
        } catch (error) {}
      })(locationFields[lf]);
    }

    try {
      Object.defineProperty(parent, "location", { value: frameLocation, writable: false, enumerable: true, configurable: true });
    } catch (error) {}
  }

  // parent.postMessage (a frame messaging the window embedding it) is messaging.js's.

  try {
    var chromeApp = globalThis.chrome && globalThis.chrome.app;

    if (chromeApp) {
      var extensionApi = function (name, answer) {
        var existing = chromeApp[name];
        if (typeof existing !== "function") return;

        patch(chromeApp, name, function () {
          if (arguments.length !== 0) throw env.hideFrames(new TypeError("Error in invocation of app." + name + "(): "));
          return answer;
        });
      };

      extensionApi("runningState", "cannot_run");
      extensionApi("getIsInstalled", false);
    }
  } catch (error) {}

  patch(parent, "addEventListener", addListener);
  patch(parent, "removeEventListener", removeListener);

  try {
    Object.defineProperty(globalThis, "parent", { value: parent, writable: false, configurable: true });
    Object.defineProperty(globalThis, "top", { value: parent, writable: false, configurable: true });
    Object.defineProperty(globalThis, "self", { value: globalThis, writable: false, configurable: true });
    Object.defineProperty(globalThis, "frames", { value: globalThis, writable: false, configurable: true });
    Object.defineProperty(globalThis, "window", { value: globalThis, writable: false, configurable: true });
  } catch (error) {}

  var CLONEABLE = {
    Object: true, Array: true, Date: true, RegExp: true, Map: true, Set: true, ArrayBuffer: true,
    SharedArrayBuffer: true, DataView: true, Blob: true, File: true, FileList: true, ImageData: true,
    ImageBitmap: true, Error: true, EvalError: true, RangeError: true, ReferenceError: true,
    SyntaxError: true, TypeError: true, URIError: true, AggregateError: true, DOMException: true,
    Boolean: true, Number: true, String: true, BigInt: true, Int8Array: true, Uint8Array: true,
    Uint8ClampedArray: true, Int16Array: true, Uint16Array: true, Int32Array: true, Uint32Array: true,
    Float16Array: true, Float32Array: true, Float64Array: true, BigInt64Array: true, BigUint64Array: true,
    CryptoKey: true, DOMPoint: true, DOMRect: true, DOMMatrix: true, DOMQuad: true, DOMPointReadOnly: true,
    DOMRectReadOnly: true, DOMMatrixReadOnly: true,
  };

  var cloneLabel = function (value, seen, depth) {
    if (value === null || value === undefined) return null;

    var kind = typeof value;

    if (kind === "function") return String(value);
    if (kind === "symbol") return String(value);
    if (kind !== "object") return null;
    if (depth > 8 || seen.indexOf(value) !== -1) return null;

    seen.push(value);

    var brand = String(Object.prototype.toString.call(value)).slice(8, -1);

    if (brand === "Window" || brand === "global") return "#<Window>";
    if (brand === "Promise") return "#<Promise>";
    if (brand === "WeakMap" || brand === "WeakSet" || brand === "WeakRef") return "#<" + brand + ">";

    if (!CLONEABLE[brand]) return brand + " object";

    if (brand === "Array" || brand === "Object") {
      var keys;

      try {
        keys = Object.keys(value);
      } catch (error) {
        keys = [];
      }

      for (var index = 0; index < keys.length && index < 512; index += 1) {
        var found;

        try {
          found = cloneLabel(value[keys[index]], seen, depth + 1);
        } catch (error) {
          found = null;
        }

        if (found) return found;
      }
    }

    return null;
  };

  var refuseUncloneable = function (message, where, method) {
    var label = cloneLabel(message, [], 0);
    if (!label) return;

    throw domException("Failed to execute '" + (method || "postMessage") + "' on '" + where + "': " + label + " could not be cloned.", "DataCloneError");
  };

  // structuredClone, window.postMessage and message delivery are messaging.js's, which clones
  // as Chrome does (refuseUncloneable stays for callers that only need the refusal).

  var mediaNumber = function (name) {
    var dpr = Number(globalThis.devicePixelRatio) || 1;
    var screenWidth = Number(globalThis.screen && globalThis.screen.width) || 0;
    var screenHeight = Number(globalThis.screen && globalThis.screen.height) || 0;
    var viewWidth = Number(globalThis.innerWidth) || 0;
    var viewHeight = Number(globalThis.innerHeight) || 0;
    var depth = Number(globalThis.screen && globalThis.screen.colorDepth) || 24;

    switch (name) {
      case "width": return viewWidth;
      case "height": return viewHeight;
      case "device-width": return screenWidth;
      case "device-height": return screenHeight;
      case "aspect-ratio": return viewHeight ? viewWidth / viewHeight : 0;
      case "device-aspect-ratio": return screenHeight ? screenWidth / screenHeight : 0;
      case "resolution": return dpr;
      case "device-pixel-ratio":
      case "-webkit-device-pixel-ratio": return dpr;
      case "color": return Math.floor(depth / 3);
      case "color-index": return 0;
      case "monochrome": return 0;
      case "grid": return 0;
      default: return null;
    }
  };

  var mediaKeyword = {
    orientation: "landscape",
    "prefers-color-scheme": "light",
    "prefers-reduced-motion": "no-preference",
    "prefers-reduced-transparency": "no-preference",
    "prefers-reduced-data": "no-preference",
    "prefers-contrast": "no-preference",
    "forced-colors": "none",
    "inverted-colors": "none",
    hover: "hover",
    "any-hover": "hover",
    pointer: "fine",
    "any-pointer": "fine",
    update: "fast",
    scripting: "enabled",
    "display-mode": "browser",
    "overflow-block": "scroll",
    "overflow-inline": "scroll",
    "dynamic-range": "high",
    "color-gamut": "p3",
  };

  var gamutRank = { srgb: 1, p3: 2, rec2020: 3 };
  var rangeRank = { standard: 1, high: 2 };

  var mediaValue = function (text) {
    var value = String(text).trim().toLowerCase();
    var ratio = value.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (ratio) return Number(ratio[1]) / Number(ratio[2]);

    var unit = value.match(/^(-?\d+(?:\.\d+)?)(px|em|rem|pt|dppx|x|dpi|dpcm|cm|mm|in)?$/);
    if (!unit) return null;

    var number = Number(unit[1]);

    switch (unit[2]) {
      case "em":
      case "rem": return number * 16;
      case "pt": return number * (96 / 72);
      case "cm": return number * (96 / 2.54);
      case "mm": return number * (96 / 25.4);
      case "in": return number * 96;
      case "dpi": return number / 96;
      case "dpcm": return number / (96 / 2.54);
      default: return number;
    }
  };

  var degenerateRatio = function (feature) {
    if (feature === "aspect-ratio") return !(Number(globalThis.innerWidth) && Number(globalThis.innerHeight));
    if (feature === "device-aspect-ratio") return !(Number(globalThis.screen && globalThis.screen.width) && Number(globalThis.screen && globalThis.screen.height));
    return false;
  };

  var matchesFeature = function (name, value) {
    var bound = name.match(/^(min|max)-(.+)$/);
    var feature = bound ? bound[2] : name;
    var numeric = mediaNumber(feature);

    if (degenerateRatio(feature)) return true;

    if (numeric !== null) {
      if (value === null) return numeric !== 0;
      var wanted = mediaValue(value);
      if (wanted === null) return false;
      if (bound && bound[1] === "min") return numeric >= wanted;
      if (bound && bound[1] === "max") return numeric <= wanted;
      return numeric === wanted;
    }

    if (Object.prototype.hasOwnProperty.call(mediaKeyword, feature)) {
      var actual = mediaKeyword[feature];

      if (feature === "orientation") {
        var viewWide = (Number(globalThis.innerWidth) || 0) > (Number(globalThis.innerHeight) || 0);
        actual = viewWide ? "landscape" : "portrait";
      }
      if (value === null) return actual !== "none" && actual !== "no-preference";

      var asked = String(value).trim().toLowerCase();
      if (feature === "color-gamut") return (gamutRank[asked] || 9) <= (gamutRank[actual] || 0);
      if (feature === "dynamic-range") return (rangeRank[asked] || 9) <= (rangeRank[actual] || 0);
      return asked === actual;
    }

    return null;
  };

  var evaluateQuery = function (text) {
    var query = String(text).trim().toLowerCase();
    if (!query) return false;

    var negated = false;

    if (/^not\s+/.test(query)) {
      negated = true;
      query = query.replace(/^not\s+/, "");
    } else {
      query = query.replace(/^only\s+/, "");
    }

    var type = query.match(/^(all|screen|print|speech)\b/);

    if (type) {
      query = query.slice(type[0].length).replace(/^\s*and\s*/, "");
      if (type[1] === "print" || type[1] === "speech") return negated;
    }

    var result = true;
    var seen = false;
    var parts = query.split(/\s+and\s+/);

    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index].trim();
      if (!part) continue;

      var inner = part.match(/^\((.*)\)$/);
      if (!inner) return null;

      var body = inner[1].trim();
      var pair = body.match(/^([-a-z0-9]+)\s*:\s*(.+)$/);
      var answer;

      if (pair) {
        answer = matchesFeature(pair[1], pair[2]);
      } else if (/^[-a-z0-9]+$/.test(body)) {
        answer = matchesFeature(body, null);
      } else {
        var range = body.match(/^([-a-z0-9.\/]+)\s*(<=|>=|<|>|=)\s*([-a-z0-9.\/]+)$/);

        if (!range) return null;

        var left = mediaNumber(range[1]);
        var right = left === null ? mediaNumber(range[3]) : null;
        var feature = left === null ? range[3] : range[1];

        if (degenerateRatio(feature)) {
          seen = true;
          continue;
        }

        var against = mediaValue(left === null ? range[1] : range[3]);
        var actual = left === null ? right : left;

        if (actual === null || against === null) return null;

        var operator = range[2];
        if (left === null) operator = operator === "<=" ? ">=" : operator === ">=" ? "<=" : operator === "<" ? ">" : operator === ">" ? "<" : operator;

        answer =
          operator === "<=" ? actual <= against :
          operator === ">=" ? actual >= against :
          operator === "<" ? actual < against :
          operator === ">" ? actual > against : actual === against;
      }

      if (answer === null) return null;
      seen = true;
      result = result && answer;
    }

    if (!seen && !type) return null;
    return negated ? !result : result;
  };

  var preferenceQuery = /prefers-|forced-colors|inverted-colors|color-gamut|dynamic-range|hover|pointer|update|scripting|display-mode|monochrome|overflow-|video-dynamic-range/;

  var mediaMatches = function (query) {
    var text = String(query);

    if (preferenceQuery.test(text) && env.recordGraphics) {
      var replayed = env.recordGraphics("window", "matchMedia", [text]);
      if (replayed && typeof replayed.matches === "boolean") return replayed.matches;
    }

    var parts = text.split(",");
    var known = false;
    var matched = false;

    for (var index = 0; index < parts.length; index += 1) {
      var answer = evaluateQuery(parts[index]);
      if (answer === null) continue;
      known = true;
      if (answer) matched = true;
    }

    if (known) return matched;

    var recorded = env.recordGraphics ? env.recordGraphics("window", "matchMedia", [text]) : undefined;
    return recorded && typeof recorded.matches === "boolean" ? recorded.matches : false;
  };

  if (globalThis.Intl && globalThis.Intl.PluralRules) {
    var pluralOptions = globalThis.Intl.PluralRules.prototype.resolvedOptions;

    patch(globalThis.Intl.PluralRules.prototype, "resolvedOptions", function resolvedOptions() {
      var out = pluralOptions.call(this);
      if (!out || out.notation !== undefined) return out;

      var ordered = {};

      for (var key in out) {
        ordered[key] = out[key];
        if (key === "type") ordered.notation = "standard";
      }

      return ordered;
    });
  }

  if (globalThis.navigator && globalThis.navigator.plugins && globalThis.navigator.mimeTypes) {
    try {
      var types = [];

      for (var m = 0; m < globalThis.navigator.mimeTypes.length; m += 1) types.push(globalThis.navigator.mimeTypes[m]);

      for (var pi = 0; pi < globalThis.navigator.plugins.length; pi += 1) {
        var plugin = globalThis.navigator.plugins[pi];

        for (var ti = 0; ti < types.length; ti += 1) {
          Object.defineProperty(plugin, String(ti), { value: types[ti], writable: false, enumerable: true, configurable: true });
        }
      }
    } catch (error) {}
  }

  if (globalThis.CSS && typeof globalThis.CSS === "object") {
    var known = snapshot.computedStyle || {};

    var supported = function (property, value) {
      var name = String(property).trim().toLowerCase();
      if (!name || String(value).trim() === "") return false;
      if (Object.prototype.hasOwnProperty.call(known, name)) return true;
      return /^(-webkit-|-moz-|--)/.test(name);
    };

    patch(globalThis.CSS, "supports", function supports(property, value) {
      if (arguments.length >= 2) return supported(property, value);

      var condition = String(property).trim();
      var pair = condition.match(/^\((.+?)\s*:\s*(.+)\)$/);
      if (pair) return supported(pair[1], pair[2]);

      var bare = condition.match(/^(.+?)\s*:\s*(.+)$/);
      return bare ? supported(bare[1], bare[2]) : false;
    });

    patch(globalThis.CSS, "escape", function escape(value) {
      return String(value).replace(/[^a-zA-Z0-9_-]/g, function (character) {
        return "\\" + character;
      });
    });
  }

  var normaliseQuery = function (query) {
    return String(query)
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\s*:\s*/g, ": ")
      .replace(/\s*,\s*/g, ", ");
  };

  patch(globalThis, "matchMedia", function matchMedia(query) {
    var list = globalThis.MediaQueryList && globalThis.MediaQueryList.prototype
      ? Object.create(globalThis.MediaQueryList.prototype)
      : {};

    var fields = { matches: mediaMatches(query), media: normaliseQuery(query), onchange: null };

    env.overrides.set(list, fields);

    try {
      Object.defineProperty(list, "matches", { get: asNative(function () { return fields.matches; }, "get matches"), enumerable: true, configurable: true });
      Object.defineProperty(list, "media", { get: asNative(function () { return fields.media; }, "get media"), enumerable: true, configurable: true });
      Object.defineProperty(list, "onchange", { value: null, writable: true, enumerable: true, configurable: true });
      Object.defineProperty(list, "addListener", { value: asNative(function addListener() {}, "addListener"), writable: true, enumerable: false, configurable: true });
      Object.defineProperty(list, "removeListener", { value: asNative(function removeListener() {}, "removeListener"), writable: true, enumerable: false, configurable: true });
    } catch (error) {}

    return list;
  });

  var systemColors = snapshot.systemColors || {};
  var computedDefaults = snapshot.computedStyle || {};
  var shape = env.styleShape || null;
  var ownNames = shape && shape.own && shape.own.length ? shape.own : null;
  var ownSet = Object.create(null);

  if (ownNames) for (var o = 0; o < ownNames.length; o += 1) ownSet[ownNames[o]] = true;

  var enumerableNames = Object.create(null);
  var enumerableList = shape && Array.isArray(shape.keys) ? shape.keys : ownNames;

  if (enumerableList) for (var n = 0; n < enumerableList.length; n += 1) enumerableNames[enumerableList[n]] = true;

  var styleProto = null;

  try {
    styleProto = globalThis.CSSStyleDeclaration ? globalThis.CSSStyleDeclaration.prototype : null;
  } catch (error) {
    styleProto = null;
  }

  var computedFor = function (element) {
    var inline = element && element.style ? element.style : null;

    var resolve = function (name) {
      var property = String(name);
      var own = inline ? inline.getPropertyValue(property) : "";

      if (own) {
        if (Object.prototype.hasOwnProperty.call(systemColors, own)) return systemColors[own];
        return own;
      }

      if (Object.prototype.hasOwnProperty.call(computedDefaults, property)) return computedDefaults[property];
      var fallback = shape && (element === globalThis.document.body ? shape.body : shape.div);
      if (fallback && Object.prototype.hasOwnProperty.call(fallback, property)) return fallback[property];
      return "";
    };

    var names = shape && shape.dashed && shape.dashed.length ? shape.dashed : Object.keys(computedDefaults);

    var style = {
      getPropertyValue: asNative(function getPropertyValue(name) { return resolve(name); }, "getPropertyValue"),
      getPropertyPriority: asNative(function getPropertyPriority() { return ""; }, "getPropertyPriority"),
      item: asNative(function item(index) { return names[index] || ""; }, "item"),
      length: names.length,
    };

    var valueOfKey = function (key) {
      if (/^\d+$/.test(key)) return names[Number(key)];
      return resolve(key.replace(/[A-Z]/g, function (character) { return "-" + character.toLowerCase(); }));
    };

    return new Proxy(style, {
      get: function (target, key) {
        if (key in target) return target[key];
        if (typeof key !== "string") return undefined;
        return valueOfKey(key);
      },
      has: function (target, key) {
        return key in target || typeof key === "string";
      },
      getPrototypeOf: function () {
        return styleProto || Object.prototype;
      },
      ownKeys: function (target) {
        return ownNames ? ownNames.slice() : Object.getOwnPropertyNames(target);
      },
      getOwnPropertyDescriptor: function (target, key) {
        if (!ownNames) return Object.getOwnPropertyDescriptor(target, key);
        if (typeof key !== "string" || !ownSet[key]) return undefined;
        return { value: valueOfKey(key), writable: false, enumerable: enumerableNames[key] === true, configurable: true };
      },
    });
  };

  patch(globalThis, "getComputedStyle", function getComputedStyle(element) {
    return computedFor(element);
  });

  patch(globalThis, "getSelection", function getSelection() {
    return { toString: function () { return ""; }, rangeCount: 0 };
  });

  globalThis[Symbol.for("wre.scroll")] = globalThis[Symbol.for("wre.scroll")] || { x: 0, y: 0 };

  var moveScroll = function (x, y) {
    var at = globalThis[Symbol.for("wre.scroll")];
    var left = Math.max(0, Number(x) || 0);
    var top = Math.max(0, Number(y) || 0);

    if (left === at.x && top === at.y) return undefined;

    at.x = left;
    at.y = top;

    if (document.documentElement) document.documentElement.scrollTop = top;
    if (document.body) document.body.scrollTop = top;

    dispatch(globalThis, makeEvent("scroll"));
    return undefined;
  };

  patch(globalThis, "scrollTo", function scrollTo(x, y) {
    if (x && typeof x === "object") return moveScroll(x.left, x.top);
    return moveScroll(x, y);
  });

  patch(globalThis, "scrollBy", function scrollBy(x, y) {
    var at = globalThis[Symbol.for("wre.scroll")];
    if (x && typeof x === "object") return moveScroll(at.x + (Number(x.left) || 0), at.y + (Number(x.top) || 0));
    return moveScroll(at.x + (Number(x) || 0), at.y + (Number(y) || 0));
  });
  patch(globalThis, "focus", function focus() { return undefined; });
  patch(globalThis, "blur", function blur() { return undefined; });
  patch(globalThis, "open", function open() { return null; });
  patch(globalThis, "close", function close() { return undefined; });
  patch(globalThis, "btoa", globalThis.btoa);
  patch(globalThis, "atob", globalThis.atob);

  installIterators();

  var applyShapes = function () {
    var shapes = env.shapes;
    if (!shapes) return;

    var removed = [];
    var names = Object.keys(shapes);

    for (var index = 0; index < names.length; index += 1) {
      var constructor;

      try {
        constructor = globalThis[names[index]];
      } catch (error) {
        continue;
      }

      if (typeof constructor !== "function" || !constructor.prototype) continue;

      var wanted = Object.create(null);
      for (var w = 0; w < shapes[names[index]].length; w += 1) wanted[shapes[names[index]][w]] = true;

      var own = Object.getOwnPropertyNames(constructor.prototype);

      for (var o = 0; o < own.length; o += 1) {
        if (wanted[own[o]]) continue;

        try {
          var descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, own[o]);
          if (!descriptor || !descriptor.configurable) continue;
          delete constructor.prototype[own[o]];
          removed.push(names[index] + "." + own[o]);
        } catch (error) {}
      }
    }

    env.shapeRemovals = removed;
  };

  applyShapes();

  // The capture harness leaves a couple of its own markers on the captured window; a real page has
  // no such globals, so drop them before any script enumerates or probes the global object.
  for (var leak = 0, leaks = ["__wreCapture", "__G", "__PRISTINE", "plain", "readInterface", "readPlugins", "readMimeTypes"]; leak < leaks.length; leak += 1) {
    try { delete globalThis[leaks[leak]]; } catch (error) {}
  }

  if (globalThis.Window && globalThis.Window.prototype) {
    for (var storageKind = 0; storageKind < 2; storageKind += 1) {
      try {
        Object.defineProperty(globalThis.Window.prototype, ["TEMPORARY", "PERSISTENT"][storageKind], {
          value: storageKind,
          writable: false,
          enumerable: true,
          configurable: false,
        });
      } catch (error) {}
    }
  }

  if (env.orderWindow) env.orderWindow();

  if (env.windowOrder && env.windowOrder.length) {
    var wanted = env.windowOrder;
    var rank = Object.create(null);

    for (var w = 0; w < wanted.length; w += 1) rank[wanted[w]] = w;

    var harnessName = /^__/;

    var inRecordedOrder = function (names) {
      var indexed = [];
      var known = [];
      var rest = [];

      for (var index = 0; index < names.length; index += 1) {
        var name = names[index];

        if (typeof name === "string" && harnessName.test(name)) continue;
        if (typeof name === "string" && /^(0|[1-9]\d*)$/.test(name)) indexed.push(name);
        else if (typeof name === "string" && rank[name] !== undefined) known.push(name);
        else rest.push(name);
      }

      indexed.sort(function (left, right) { return Number(left) - Number(right); });
      known.sort(function (left, right) { return rank[left] - rank[right]; });
      return indexed.concat(known, rest);
    };

    var realNames = Object.getOwnPropertyNames;
    var realKeys = Reflect.ownKeys;

    var defineStatic = function (holder, name, implementation) {
      try {
        var previous = Object.getOwnPropertyDescriptor(holder, name);

        Object.defineProperty(holder, name, {
          value: asNative(implementation, name),
          writable: previous ? previous.writable !== false : true,
          enumerable: previous ? previous.enumerable : false,
          configurable: true,
        });
      } catch (error) {}
    };

    defineStatic(Object, "getOwnPropertyNames", function getOwnPropertyNames(target) {
      var names = realNames(target);
      if (target !== globalThis) return names;
      env.count("getOwnPropertyNames(window)");
      return inRecordedOrder(names);
    });

    defineStatic(Reflect, "ownKeys", function ownKeys(target) {
      var names = realKeys(target);
      if (target !== globalThis) return names;
      env.count("getOwnPropertyNames(window)");
      return inRecordedOrder(names);
    });
  }

  var linkRecordedChain = function () {
    var snapshotData = env.snapshot;
    if (!snapshotData || !snapshotData.roots || !snapshotData.roots.window || snapshotData.roots.window.k !== "ref") return;

    var record = snapshotData.objects[snapshotData.roots.window.id];
    var target = globalThis;

    for (var step = 0; step < 8 && record && target; step += 1) {
      if (!record.proto || record.proto.k !== "ref") return;

      var next = env.materialize(record.proto.id, "window.[[proto]]");
      if (!next || next === target) return;

      try {
        if (Object.getPrototypeOf(target) !== next) Object.setPrototypeOf(target, next);
      } catch (error) {
        return;
      }

      target = next;
      record = snapshotData.objects[record.proto.id];
    }
  };

  if (globalThis.Node && globalThis.Node.prototype) {
    installFields(globalThis.Node.prototype, NODE_FIELDS);

    try {
      Object.defineProperty(globalThis.Node.prototype, "isConnected", {
        get: asNative(function () {
          var current = this;

          for (var step = 0; current && step < 64; step += 1) {
            if (current === globalThis.document || (env.tree && (current === env.tree.html || current === env.tree.head || current === env.tree.body))) return true;
            current = current.parentNode;
          }

          return false;
        }, "get isConnected"),
        enumerable: true,
        configurable: true,
      });
    } catch (error) {}
  }
  if (globalThis.Element && globalThis.Element.prototype) {
    installFields(globalThis.Element.prototype, ELEMENT_FIELDS);
    installMarkup(globalThis.Element.prototype);

    var reflectAttribute = function (property, attribute) {
      try {
        Object.defineProperty(globalThis.Element.prototype, property, {
          get: asNative(function () {
            var state = nodeState(this);
            if (!state) return "";
            var raw = state.attrs[attribute];
            return raw === undefined ? "" : raw;
          }, "get " + property),
          set: asNative(function (value) {
            if (!nodeState(this)) return;
            setAttr(this, attribute, String(value));
          }, "set " + property),
          enumerable: true,
          configurable: true,
        });
      } catch (error) {}
    };

    reflectAttribute("className", "class");
    reflectAttribute("id", "id");

    try {
      Object.defineProperty(globalThis.HTMLElement && globalThis.HTMLElement.prototype ? globalThis.HTMLElement.prototype : globalThis.Element.prototype, "dataset", {
        get: asNative(function () {
          var element = this;

          return new Proxy({}, {
            get: function (holder, key) {
              if (typeof key !== "string") return undefined;
              var attribute = "data-" + key.replace(/[A-Z]/g, function (letter) { return "-" + letter.toLowerCase(); });
              var raw = attributesOf(element)[attribute];
              return raw === undefined ? undefined : raw;
            },
            set: function (holder, key, value) {
              if (typeof key !== "string") return true;
              var attribute = "data-" + key.replace(/[A-Z]/g, function (letter) { return "-" + letter.toLowerCase(); });
              setAttr(element, attribute, String(value));
              return true;
            },
            has: function (holder, key) {
              if (typeof key !== "string") return false;
              return ("data-" + key.replace(/[A-Z]/g, function (letter) { return "-" + letter.toLowerCase(); })) in attributesOf(element);
            },
            ownKeys: function () {
              return Object.keys(attributesOf(element))
                .filter(function (name) { return name.indexOf("data-") === 0; })
                .map(function (name) { return name.slice(5).replace(/-([a-z])/g, function (all, letter) { return letter.toUpperCase(); }); });
            },
            getOwnPropertyDescriptor: function (holder, key) {
              if (typeof key !== "string") return undefined;
              var attribute = "data-" + key.replace(/[A-Z]/g, function (letter) { return "-" + letter.toLowerCase(); });
              var raw = attributesOf(element)[attribute];
              if (raw === undefined) return undefined;
              return { value: raw, writable: true, enumerable: true, configurable: true };
            },
          });
        }, "get dataset"),
        enumerable: true,
        configurable: true,
      });
    } catch (error) {}
  }
  if (globalThis.HTMLElement && globalThis.HTMLElement.prototype) installFields(globalThis.HTMLElement.prototype, HTML_FIELDS);

  linkRecordedChain();

  if (globalThis.EventTarget && globalThis.EventTarget.prototype) {
    patch(globalThis.EventTarget.prototype, "addEventListener", addListener);
    patch(globalThis.EventTarget.prototype, "removeEventListener", removeListener);
    patch(globalThis.EventTarget.prototype, "dispatchEvent", function dispatchEvent(event) {
      return dispatch(this, event);
    });
  }

  // ---- Documents, markup, cloning and selectors ------------------------------------------------
  //
  // Every document is a node with its own tree: the page's, the ones scripts make (new Document,
  // DOMImplementation, DOMParser) and the inert ones that hold template contents. Markup is read
  // and written by parse5 (the WHATWG parser and serializer), selectors are matched by css-select
  // over the nodes' state, and nodes clone, compare and move between documents as the DOM
  // standard says.
  var documentField;
  var attributeKey;
  var retag;

  (function installDocuments() {
    var HTML_NS = "http://www.w3.org/1999/xhtml";
    var SVG_NS = "http://www.w3.org/2000/svg";
    var MATHML_NS = "http://www.w3.org/1998/Math/MathML";
    var XLINK_NS = "http://www.w3.org/1999/xlink";
    var XML_NS = "http://www.w3.org/XML/1998/namespace";
    var XMLNS_NS = "http://www.w3.org/2000/xmlns/";

    var docProto = Document && Document.prototype;
    var mainState = nodeState(document);
    if (!docProto || !mainState) return;

    mainState.isHTML = true;
    mainState.contentType = "text/html";
    mainState.mode = "no-quirks";
    mainState.scripting = true;
    mainState.main = true;

    var typeError = function (message) { return env.hideFrames(new TypeError(message)); };
    var required = function (args, count, method, iface) {
      if (args.length < count) {
        throw typeError("Failed to execute '" + method + "' on '" + iface + "': " + count + " argument" + (count === 1 ? "" : "s") + " required, but only " + args.length + " present.");
      }
    };

    var stateOf = function (node) { return nodeState(node); };
    var isDocument = function (node) { var state = stateOf(node); return Boolean(state && state.nodeType === 9); };
    var ownerOf = function (node) { var state = stateOf(node); return !state ? document : state.nodeType === 9 ? node : state.ownerDocument || document; };
    var isHTMLDoc = function (doc) { var state = stateOf(doc); return Boolean(state && state.isHTML); };
    var namespaceOf = function (state) { return state.namespaceURI === undefined ? HTML_NS : state.namespaceURI; };
    var isHTMLElement = function (state) { return Boolean(state) && state.nodeType === 1 && namespaceOf(state) === HTML_NS; };

    // ---- Nodes of every kind, for any document ----

    var SVG_INTERFACES = { svg: "SVGSVGElement", tspan: "SVGTSpanElement", textPath: "SVGTextPathElement", mpath: "SVGMPathElement", a: "SVGAElement" };

    var foreignPrototype = function (namespace, local) {
      var holder = null;
      if (namespace === SVG_NS) {
        var name = SVG_INTERFACES[local] ||
          (local.indexOf("fe") === 0 && local.length > 2 ? "SVGFE" + local.slice(2) + "Element" : "SVG" + local.charAt(0).toUpperCase() + local.slice(1) + "Element");
        holder = (globalThis[name] && globalThis[name].prototype) || (globalThis.SVGElement && globalThis.SVGElement.prototype);
      } else if (namespace === MATHML_NS) {
        holder = globalThis.MathMLElement && globalThis.MathMLElement.prototype;
      }
      return holder || (globalThis.Element && globalThis.Element.prototype) || Object.prototype;
    };

    // An element in any namespace, as createElementNS makes it: HTML ones are the DOM's own
    // elements (their interface by tag); others keep their name's case and their namespace.
    var makeElementNS = function (namespace, qualified, owner) {
      var ns = namespace === undefined || namespace === null || namespace === "" ? null : String(namespace);
      var name = String(qualified);
      var colon = name.indexOf(":");
      var prefix = colon === -1 ? null : name.slice(0, colon);
      var local = colon === -1 ? name : name.slice(colon + 1);
      var doc = owner || document;
      var element;
      var state;

      if (ns === HTML_NS) {
        element = makeElement(local, doc);
        state = stateOf(element);
        state.prefix = prefix;
        if (!isHTMLDoc(doc) || local !== local.toLowerCase()) {
          state.localName = local;
          state.tagName = name;
          state.nodeName = name;
        }
        if (isHTMLDoc(doc)) {
          state.tagName = name.toUpperCase();
          state.nodeName = state.tagName;
        }
        return element;
      }

      element = Object.create(foreignPrototype(ns, local));
      elementCount += 1;
      state = {
        tag: local, handle: "element" + elementCount, html: "", frame: undefined, attrs: {}, attrNS: {},
        tagName: name, nodeName: name, localName: local, namespaceURI: ns, prefix: prefix, nodeType: 1,
        children: [], childNodes: [], childElementCount: 0, firstElementChild: null, lastElementChild: null,
        previousElementSibling: null, nextElementSibling: null, attributes: [], style: null, parentNode: null,
        parentElement: null, firstChild: null, lastChild: null, nextSibling: null, previousSibling: null,
        ownerDocument: doc, textContent: "", value: "", className: "", id: "", src: "", width: 0, height: 0,
        offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0,
      };
      state.style = makeStyle(element);
      elementState.set(element, state);
      styleOwners.set(state.style, element);
      return element;
    };

    env.makeElementNS = makeElementNS;

    // An element's tagName (and nodeName) as its node document makes it: an HTML element in an HTML
    // document is upper-cased, anything else keeps its qualified name.
    retag = function (state, owner) {
      var qualified = (state.prefix ? state.prefix + ":" : "") + (state.localName || state.tag);
      state.tagName = namespaceOf(state) === HTML_NS && isHTMLDoc(owner) ? qualified.toUpperCase() : qualified;
      state.nodeName = state.tagName;
    };

    var makeDoctype = function (name, publicId, systemId, owner) {
      var holder = globalThis.DocumentType && globalThis.DocumentType.prototype;
      var node = holder ? Object.create(holder) : {};
      elementState.set(node, {
        nodeType: 10, nodeName: String(name), name: String(name), publicId: String(publicId || ""), systemId: String(systemId || ""),
        parentNode: null, parentElement: null, ownerDocument: owner || document, previousSibling: null, nextSibling: null,
        childNodes: [], attrs: {}, tag: "#doctype",
      });
      return node;
    };

    var DOCTYPE_FIELDS = ["name", "publicId", "systemId"];
    if (globalThis.DocumentType && globalThis.DocumentType.prototype) {
      DOCTYPE_FIELDS.forEach(function (field) {
        patchGetter(globalThis.DocumentType.prototype, field, function () {
          var state = stateOf(this);
          if (!state || state.nodeType !== 10) throw typeError("Illegal invocation");
          return state[field] === undefined ? (field === "name" ? "html" : "") : state[field];
        });
      });
    }

    // A document of `iface` (Document, HTMLDocument, XMLDocument): a node with its own tree.
    var makeDocument = function (iface, fields) {
      var holder = (globalThis[iface] && globalThis[iface].prototype) || docProto;
      var doc = Object.create(holder);
      var state = {
        nodeType: 9, nodeName: "#document", parentNode: null, parentElement: null, ownerDocument: null,
        previousSibling: null, nextSibling: null, childNodes: [], children: [], attrs: {}, tag: "#document",
        isHTML: Boolean(fields.isHTML), contentType: fields.contentType, URL: fields.URL || "about:blank",
        mode: fields.mode || "no-quirks", scripting: false, inert: true,
      };
      elementState.set(doc, state);
      relink(doc);
      return doc;
    };

    env.makeDocument = makeDocument;

    var appendQuietly = function (parent, child) { insertChild(parent, child, null, "appendChild", true); return child; };

    // The inert document a document's template contents belong to (one per document, as Chrome).
    var templateOwners = new WeakMap();
    var templateOwner = function (doc) {
      var state = stateOf(doc);
      if (state && state.templateOwner) return doc;
      var found = templateOwners.get(doc);
      if (!found) {
        found = makeDocument("HTMLDocument", { isHTML: isHTMLDoc(doc), contentType: isHTMLDoc(doc) ? "text/html" : "application/xml" });
        stateOf(found).templateOwner = true;
        templateOwners.set(doc, found);
      }
      return found;
    };

    var templateContent = function (template) {
      var state = stateOf(template);
      if (!state.content) state.content = makeFragment(templateOwner(ownerOf(template)));
      return state.content;
    };

    if (globalThis.HTMLTemplateElement && globalThis.HTMLTemplateElement.prototype) {
      patchGetter(globalThis.HTMLTemplateElement.prototype, "content", function () {
        var state = stateOf(this);
        if (!state || state.tag !== "template") throw typeError("Illegal invocation");
        return templateContent(this);
      });
    }

    // ---- Walking trees ----

    var eachDescendant = function (root, visit) {
      var stack = (stateOf(root) && stateOf(root).childNodes || []).slice().reverse();
      while (stack.length) {
        var node = stack.pop();
        if (visit(node) === false) return;
        var kids = stateOf(node) ? stateOf(node).childNodes : null;
        if (kids) for (var index = kids.length - 1; index >= 0; index -= 1) stack.push(kids[index]);
      }
    };

    var elementsUnder = function (root, test) {
      var found = [];
      eachDescendant(root, function (node) {
        var state = stateOf(node);
        if (state && state.nodeType === 1 && (!test || test(node, state))) found.push(node);
      });
      return found;
    };

    var firstUnder = function (root, test) {
      var found = null;
      eachDescendant(root, function (node) {
        var state = stateOf(node);
        if (state && state.nodeType === 1 && test(node, state)) {
          found = node;
          return false;
        }
      });
      return found;
    };

    var childElement = function (parent, test) {
      var kids = stateOf(parent) ? stateOf(parent).childNodes : [];
      for (var index = 0; index < kids.length; index += 1) {
        var state = stateOf(kids[index]);
        if (state && state.nodeType === 1 && (!test || test(state))) return kids[index];
      }
      return null;
    };

    var htmlTag = function (tag) { return function (state) { return isHTMLElement(state) && state.tag === tag; }; };

    var rootElement = function (doc) { return childElement(doc); };
    var headOf = function (doc) {
      var root = rootElement(doc);
      return root && htmlTag("html")(stateOf(root)) ? childElement(root, htmlTag("head")) : null;
    };
    var bodyOf = function (doc) {
      var root = rootElement(doc);
      return root && htmlTag("html")(stateOf(root)) ? childElement(root, function (state) { return isHTMLElement(state) && (state.tag === "body" || state.tag === "frameset"); }) : null;
    };
    var doctypeOf = function (doc) {
      var kids = stateOf(doc).childNodes;
      for (var index = 0; index < kids.length; index += 1) if (stateOf(kids[index]).nodeType === 10) return kids[index];
      return null;
    };

    var stripAndCollapse = function (text) { return String(text).replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, ""); };

    var titleElementOf = function (doc) {
      var root = rootElement(doc);
      if (!root) return null;
      if (namespaceOf(stateOf(root)) === SVG_NS && stateOf(root).tag === "svg") return childElement(root, function (state) { return namespaceOf(state) === SVG_NS && state.tag === "title"; });
      return firstUnder(doc, function (node, state) { return isHTMLElement(state) && state.tag === "title"; });
    };

    var titleOf = function (doc) {
      var title = titleElementOf(doc);
      return title ? stripAndCollapse(textOf(title)) : "";
    };

    // Live collections a document keeps (one object each, as Chrome's [SameObject] ones).
    var docLists = new WeakMap();
    var docList = function (doc, name, brand, test) {
      var lists = docLists.get(doc);
      if (!lists) {
        lists = {};
        docLists.set(doc, lists);
      }
      if (!lists[name]) lists[name] = makeCollection(brand, function () { return elementsUnder(doc, test); });
      return lists[name];
    };

    var TREE_FIELDS = {
      documentElement: function (doc) { return rootElement(doc); },
      head: function (doc) { return headOf(doc); },
      body: function (doc) { return bodyOf(doc); },
      title: function (doc) { return titleOf(doc); },
      children: function (doc) { return childrenOf(doc); },
      childNodes: function (doc) { return childNodesOf(doc); },
      firstChild: function (doc, state) { return state.firstChild || null; },
      lastChild: function (doc, state) { return state.lastChild || null; },
      firstElementChild: function (doc, state) { return state.firstElementChild || null; },
      lastElementChild: function (doc, state) { return state.lastElementChild || null; },
      childElementCount: function (doc, state) { return state.childElementCount || 0; },
      all: function (doc) { return docList(doc, "all", "HTMLAllCollection", null); },
      forms: function (doc) { return docList(doc, "forms", "HTMLCollection", function (node, state) { return isHTMLElement(state) && state.tag === "form"; }); },
      images: function (doc) { return docList(doc, "images", "HTMLCollection", function (node, state) { return isHTMLElement(state) && state.tag === "img"; }); },
      embeds: function (doc) { return docList(doc, "embeds", "HTMLCollection", function (node, state) { return isHTMLElement(state) && state.tag === "embed"; }); },
      plugins: function (doc) { return docList(doc, "embeds", "HTMLCollection", function (node, state) { return isHTMLElement(state) && state.tag === "embed"; }); },
      scripts: function (doc) { return docList(doc, "scripts", "HTMLCollection", function (node, state) { return isHTMLElement(state) && state.tag === "script"; }); },
      links: function (doc) { return docList(doc, "links", "HTMLCollection", function (node, state) { return isHTMLElement(state) && (state.tag === "a" || state.tag === "area") && "href" in state.attrs; }); },
      anchors: function (doc) { return docList(doc, "anchors", "HTMLCollection", function (node, state) { return isHTMLElement(state) && state.tag === "a" && "name" in state.attrs; }); },
    };

    // What a document no browsing context shows answers (Chrome's for a script-made document).
    var INERT_FIELDS = {
      readyState: function () { return "complete"; },
      hidden: function () { return true; },
      visibilityState: function () { return "hidden"; },
      referrer: function () { return ""; },
      URL: function (doc, state) { return state.URL; },
      documentURI: function (doc, state) { return state.URL; },
      baseURI: function (doc, state) { return state.URL; },
      domain: function () { return documentValues.domain; },
      characterSet: function () { return "UTF-8"; },
      charset: function () { return "UTF-8"; },
      contentType: function (doc, state) { return state.contentType; },
      compatMode: function (doc, state) { return state.mode === "quirks" ? "BackCompat" : "CSS1Compat"; },
      activeElement: function (doc) { return bodyOf(doc) || null; },
      currentScript: function () { return null; },
      defaultView: function () { return null; },
      location: function () { return null; },
      styleSheets: function () { return documentValues.styleSheets; },
      nodeType: function () { return 9; },
      nodeName: function () { return "#document"; },
    };

    documentField = function (doc, key) {
      var state = stateOf(doc);
      if (!state || state.nodeType !== 9) {
        if (doc === document) return documentValues[key];
        throw typeError("Illegal invocation");
      }
      if (TREE_FIELDS[key]) return TREE_FIELDS[key](doc, state);
      if (state.main) return documentValues[key];
      if (INERT_FIELDS[key]) return INERT_FIELDS[key](doc, state);
      return documentValues[key];
    };

    patchGetter(docProto, "doctype", function () {
      if (!isDocument(this)) throw typeError("Illegal invocation");
      return doctypeOf(this);
    });

    (function installTitle() {
      try {
        Object.defineProperty(docProto, "title", {
          get: asNative(function () { return documentField(this, "title"); }, "get title"),
          set: asNative(function (value) {
            var doc = isDocument(this) ? this : document;
            var text = String(value);
            var title = titleElementOf(doc);
            if (!title) {
              var head = headOf(doc);
              if (!head) return;
              title = makeElement("title", doc);
              insertChild(head, title, null, "appendChild", false);
            }
            title.textContent = text;
          }, "set title"),
          enumerable: true,
          configurable: true,
        });
      } catch (error) {}
    })();

    // document.cookie on a document with no browsing context reads empty and keeps nothing.
    (function installInertCookie() {
      var descriptor = Object.getOwnPropertyDescriptor(docProto, "cookie");
      if (!descriptor || !descriptor.get) return;
      try {
        Object.defineProperty(docProto, "cookie", {
          get: asNative(function () { var state = stateOf(this); return state && state.inert ? "" : descriptor.get.call(this); }, "get cookie"),
          set: asNative(function (value) { var state = stateOf(this); if (!(state && state.inert)) descriptor.set.call(this, value); }, "set cookie"),
          enumerable: descriptor.enumerable,
          configurable: true,
        });
      } catch (error) {}
    })();

    // ---- Creating nodes in a document ----

    var validName = function (name) { return VALID_NAME.test(String(name)); };
    var QNAME = /^([^:]+:)?[^:]+$/;

    var checkQualified = function (qualified, method, iface) {
      var text = String(qualified);
      if (!validName(text)) throw domException("Failed to execute '" + method + "' on '" + iface + "': The qualified name provided ('" + text + "') contains the invalid name-start character '" + text.charAt(0) + "'.", "InvalidCharacterError");
      if (!QNAME.test(text)) throw domException("Failed to execute '" + method + "' on '" + iface + "': The qualified name provided ('" + text + "') contains multiple colons.", "InvalidCharacterError");
    };

    var checkNamespace = function (namespace, qualified, method, iface) {
      var ns = namespace === null || namespace === undefined || namespace === "" ? null : String(namespace);
      var text = String(qualified);
      var colon = text.indexOf(":");
      var prefix = colon === -1 ? null : text.slice(0, colon);
      var bad = (prefix !== null && ns === null) || (prefix === "xml" && ns !== XML_NS) ||
        ((prefix === "xmlns" || text === "xmlns") !== (ns === XMLNS_NS));
      if (bad) throw domException("Failed to execute '" + method + "' on '" + iface + "': The namespace URI provided ('" + (ns || "") + "') is not valid for the qualified name provided ('" + text + "').", "NamespaceError");
      return ns;
    };

    patch(docProto, "createElement", function createElement(tag) {
      required(arguments, 1, "createElement", "Document");
      var doc = documentOf(this);
      var name = String(tag);
      if (!validName(name)) {
        throw domException("Failed to execute 'createElement' on 'Document': The tag name provided ('" + name + "') is not a valid name.", "InvalidCharacterError");
      }
      if (isHTMLDoc(doc)) return makeElement(name.toLowerCase(), doc);
      return makeElementNS(stateOf(doc).contentType === "application/xhtml+xml" ? HTML_NS : null, name, doc);
    });

    patch(docProto, "createElementNS", function createElementNS(namespace, qualified) {
      required(arguments, 2, "createElementNS", "Document");
      checkQualified(qualified, "createElementNS", "Document");
      var ns = checkNamespace(namespace, qualified, "createElementNS", "Document");
      return makeElementNS(ns, String(qualified), documentOf(this));
    });

    patch(docProto, "createCDATASection", function createCDATASection(data) {
      required(arguments, 1, "createCDATASection", "Document");
      if (isHTMLDoc(documentOf(this))) throw domException("Failed to execute 'createCDATASection' on 'Document': This operation is not supported for HTML documents.", "NotSupportedError");
      if (String(data).indexOf("]]>") !== -1) throw domException("Failed to execute 'createCDATASection' on 'Document': String cannot contain ']]>' since that is the end delimiter of a CData section.", "InvalidCharacterError");
      var node = makeCharacterData("CDATASection", 4, "#cdata-section", data, documentOf(this));
      return node;
    });

    patch(docProto, "createProcessingInstruction", function createProcessingInstruction(target, data) {
      required(arguments, 2, "createProcessingInstruction", "Document");
      if (!validName(target)) throw domException("Failed to execute 'createProcessingInstruction' on 'Document': The target provided ('" + String(target) + "') is not a valid name.", "InvalidCharacterError");
      if (String(data).indexOf("?>") !== -1) throw domException("Failed to execute 'createProcessingInstruction' on 'Document': The data provided ('" + String(data) + "') contains '?>'.", "InvalidCharacterError");
      var node = makeCharacterData("ProcessingInstruction", 7, String(target), data, documentOf(this));
      stateOf(node).target = String(target);
      return node;
    });

    if (globalThis.ProcessingInstruction && globalThis.ProcessingInstruction.prototype) {
      patchGetter(globalThis.ProcessingInstruction.prototype, "target", function () { var state = stateOf(this); return state ? state.target : undefined; });
    }

    // ---- Finding elements ----

    var byId = function (root, id) {
      var wanted = String(id);
      if (!wanted) return null;
      return firstUnder(root, function (node, state) { return state.attrs.id === wanted; });
    };

    var classTest = function (names) {
      var wanted = String(names).split(/[\t\n\f\r ]+/).filter(Boolean);
      if (!wanted.length) return function () { return false; };
      return function (node, state) {
        var have = String(state.attrs["class"] || "").split(/[\t\n\f\r ]+/);
        for (var index = 0; index < wanted.length; index += 1) if (have.indexOf(wanted[index]) === -1) return false;
        return true;
      };
    };

    var tagTest = function (root, name) {
      var wanted = String(name);
      if (wanted === "*") return function () { return true; };
      var lower = wanted.toLowerCase();
      var html = isHTMLDoc(ownerOf(root));
      return function (node, state) {
        if (html && namespaceOf(state) === HTML_NS) return state.tagName.toLowerCase() === lower;
        return state.tagName === wanted;
      };
    };

    var liveLists = new WeakMap();
    var liveList = function (root, key, brand, test) {
      var lists = liveLists.get(root);
      if (!lists) {
        lists = new Map();
        liveLists.set(root, lists);
      }
      if (!lists.has(key)) lists.set(key, makeCollection(brand, function () { return elementsUnder(root, test); }));
      return lists.get(key);
    };

    var finders = function (holder, iface, withId) {
      if (!holder) return;
      if (withId) {
        patch(holder, "getElementById", function getElementById(id) {
          required(arguments, 1, "getElementById", iface);
          return byId(this, id);
        });
      }
      patch(holder, "getElementsByTagName", function getElementsByTagName(name) {
        required(arguments, 1, "getElementsByTagName", iface);
        return liveList(this, "tag:" + String(name), "HTMLCollection", tagTest(this, name));
      });
      patch(holder, "getElementsByClassName", function getElementsByClassName(names) {
        required(arguments, 1, "getElementsByClassName", iface);
        return liveList(this, "class:" + String(names), "HTMLCollection", classTest(names));
      });
    };

    finders(docProto, "Document", true);
    finders(globalThis.Element && globalThis.Element.prototype, "Element", false);
    if (globalThis.DocumentFragment && globalThis.DocumentFragment.prototype) {
      patch(globalThis.DocumentFragment.prototype, "getElementById", function getElementById(id) {
        required(arguments, 1, "getElementById", "DocumentFragment");
        return byId(this, id);
      });
    }
    patch(docProto, "getElementsByName", function getElementsByName(name) {
      required(arguments, 1, "getElementsByName", "Document");
      var wanted = String(name);
      return liveList(this, "name:" + wanted, "NodeList", function (node, state) { return isHTMLElement(state) && state.attrs.name === wanted; });
    });

    // ---- Selectors (css-select over the nodes' state) ----

    var selectorAdapter = {
      isTag: function (node) { var state = stateOf(node); return Boolean(state && state.nodeType === 1); },
      getChildren: function (node) { var state = stateOf(node); return state && state.childNodes ? state.childNodes : []; },
      getParent: function (node) { var state = stateOf(node); return state ? state.parentNode || null : null; },
      getSiblings: function (node) { var parent = selectorAdapter.getParent(node); return parent ? stateOf(parent).childNodes : [node]; },
      getName: function (node) {
        var state = stateOf(node);
        return isHTMLDoc(ownerOf(node)) ? String(state.localName || state.tag).toLowerCase() : String(state.localName || state.tag);
      },
      getAttributeValue: function (node, name) {
        var state = stateOf(node);
        var key = attributeKey(state, node, name);
        return Object.prototype.hasOwnProperty.call(state.attrs, key) ? state.attrs[key] : undefined;
      },
      hasAttrib: function (node, name) {
        var state = stateOf(node);
        return Object.prototype.hasOwnProperty.call(state.attrs, attributeKey(state, node, name));
      },
      getText: function (node) { return textOf(node); },
      prevElementSibling: function (node) {
        var state = stateOf(node);
        for (var at = state.previousSibling; at; at = stateOf(at).previousSibling) if (stateOf(at).nodeType === 1) return at;
        return null;
      },
      removeSubsets: function (nodes) {
        return nodes.filter(function (node, index) {
          if (nodes.indexOf(node) !== index) return false;
          for (var up = selectorAdapter.getParent(node); up; up = selectorAdapter.getParent(up)) if (nodes.indexOf(up) !== -1) return false;
          return true;
        });
      },
      existsOne: function (test, nodes) {
        for (var index = 0; index < nodes.length; index += 1) {
          var node = nodes[index];
          if (selectorAdapter.isTag(node) && (test(node) || selectorAdapter.existsOne(test, selectorAdapter.getChildren(node)))) return true;
        }
        return false;
      },
      findAll: function (test, nodes) {
        var found = [];
        var stack = nodes.slice().reverse();
        while (stack.length) {
          var node = stack.pop();
          if (!selectorAdapter.isTag(node)) continue;
          if (test(node)) found.push(node);
          var kids = stateOf(node).childNodes;
          for (var index = kids.length - 1; index >= 0; index -= 1) stack.push(kids[index]);
        }
        return found;
      },
      findOne: function (test, nodes) {
        var stack = nodes.slice().reverse();
        while (stack.length) {
          var node = stack.pop();
          if (!selectorAdapter.isTag(node)) continue;
          if (test(node)) return node;
          var kids = stateOf(node).childNodes;
          for (var index = kids.length - 1; index >= 0; index -= 1) stack.push(kids[index]);
        }
        return null;
      },
      equals: function (left, right) { return left === right; },
      isHovered: function () { return false; },
      isVisited: function () { return false; },
      isActive: function () { return false; },
    };

    var formControl = function (state) { return isHTMLElement(state) && (state.tag === "input" || state.tag === "textarea" || state.tag === "select"); };
    var TEXT_INPUTS = { text: 1, search: 1, url: 1, tel: 1, email: 1, password: 1, date: 1, month: 1, week: 1, time: 1, "datetime-local": 1, number: 1 };
    var inputType = function (state) { return String(state.attrs.type || "text").toLowerCase(); };
    var mutable = function (state) {
      if (!isHTMLElement(state)) return false;
      if (state.tag === "textarea") return !("readonly" in state.attrs) && !("disabled" in state.attrs);
      if (state.tag === "input") return Boolean(TEXT_INPUTS[inputType(state)]) && !("readonly" in state.attrs) && !("disabled" in state.attrs);
      return false;
    };

    // Pseudo-classes Chrome has and css-select lacks (or answers differently for a page nobody
    // interacts with).
    var never = function () { return false; };
    var extraPseudos = {
      defined: function (node) { var state = stateOf(node); return !(isHTMLElement(state) && state.tag.indexOf("-") !== -1); },
      "read-only": function (node) { return !mutable(stateOf(node)); },
      "read-write": function (node) { return mutable(stateOf(node)); },
      required: function (node) { var state = stateOf(node); return formControl(state) && "required" in state.attrs; },
      optional: function (node) { var state = stateOf(node); return formControl(state) && !("required" in state.attrs); },
      "placeholder-shown": function (node) { var state = stateOf(node); return formControl(state) && state.tag !== "select" && "placeholder" in state.attrs && !String(state.value || state.attrs.value || ""); },
      focus: never, "focus-visible": never, "focus-within": never, hover: never, active: never, visited: never, target: never,
      fullscreen: never, modal: never, autofill: never, "-webkit-autofill": never, "popover-open": never, open: never,
      playing: never, paused: function (node) { var state = stateOf(node); return isHTMLElement(state) && (state.tag === "video" || state.tag === "audio"); },
      "picture-in-picture": never, "user-invalid": never, "user-valid": never, indeterminate: never, default: never,
      valid: function (node) { return formControl(stateOf(node)) || stateOf(node).tag === "form"; }, invalid: never,
      "in-range": never, "out-of-range": never,
    };

    // css-select prefers its own alias of a name (read-only, required, ...) to a function given for
    // it, so each of these is given as an alias of a private name that only the function answers.
    var selectorPseudos = {};
    Object.keys(extraPseudos).forEach(function (name) {
      selectorPseudos[name] = ":x-wre-" + name;
      selectorPseudos["x-wre-" + name] = extraPseudos[name];
    });

    // The pseudo-classes and -elements Chrome knows: anything else makes the selector invalid.
    var CHROME_PSEUDO_CLASSES = ("active any-link autofill checked default defined dir disabled empty enabled first-child " +
      "first-of-type focus focus-visible focus-within fullscreen has hover in-range indeterminate invalid is lang last-child " +
      "last-of-type link modal not nth-child nth-last-child nth-last-of-type nth-of-type only-child only-of-type open optional " +
      "out-of-range paused picture-in-picture placeholder-shown playing popover-open read-only read-write required root " +
      "scope state target user-invalid user-valid valid visited where -webkit-any -webkit-autofill").split(" ");
    var CHROME_PSEUDO_ELEMENTS = ("after backdrop before cue file-selector-button first-letter first-line grammar-error " +
      "highlight marker part placeholder selection slotted spelling-error target-text view-transition details-content " +
      "picker scroll-marker scroll-button column -webkit-scrollbar -webkit-input-placeholder").split(" ");

    // CSS closes what EOF leaves open ("[a=b" is "[a=b]").
    var closeAtEnd = function (text) {
      var closers = [];
      var quote = null;
      for (var index = 0; index < text.length; index += 1) {
        var ch = text.charAt(index);
        if (ch === "\\") { index += 1; continue; }
        if (quote) { if (ch === quote) quote = null; continue; }
        if (ch === "\"" || ch === "'") quote = ch;
        else if (ch === "[") closers.push("]");
        else if (ch === "(") closers.push(")");
        else if ((ch === "]" || ch === ")") && closers.length && closers[closers.length - 1] === ch) closers.pop();
      }
      return text + (quote || "") + closers.reverse().join("");
    };

    // A CSS identifier (what a type selector names), escapes and non-ASCII included.
    var IDENT = /^-?(?:[_a-zA-Z\u0080-\uFFFF]|\\[\s\S])(?:[_a-zA-Z0-9\u0080-\uFFFF-]|\\[\s\S])*$|^--(?:[_a-zA-Z0-9\u0080-\uFFFF-]|\\[\s\S])*$/;
    var TRAVERSALS = { child: 1, descendant: 1, sibling: 1, adjacent: 1, parent: 1, "column-combinator": 1 };

    var invalidSelector = function (text, method, iface) {
      return domException("Failed to execute '" + method + "' on '" + iface + "': '" + text + "' is not a valid selector.", "SyntaxError");
    };

    // Compiles `text` for matching against `context`'s tree, or says the selector can never match
    // (a valid one with a pseudo-element); throws Chrome's SyntaxError for an invalid one.
    var compileSelector = function (text, context, method, iface) {
      var selector = String(text);
      if (!selector.trim()) {
        if (!selector) throw domException("Failed to execute '" + method + "' on '" + iface + "': The provided selector is empty.", "SyntaxError");
        throw invalidSelector(selector, method, iface);
      }
      var engine = env.selectorEngine();
      var source = closeAtEnd(selector);
      var parsed;
      try {
        parsed = engine.parse(source);
      } catch (error) {
        throw invalidSelector(selector, method, iface);
      }
      var never = false;
      var walk = function (tokens) {
        for (var index = 0; index < tokens.length; index += 1) {
          var token = tokens[index];
          if (token.type === "pseudo-element") {
            if (CHROME_PSEUDO_ELEMENTS.indexOf(String(token.name).toLowerCase()) === -1) throw invalidSelector(selector, method, iface);
            never = true;
          } else if (token.type === "pseudo") {
            if (CHROME_PSEUDO_CLASSES.indexOf(String(token.name).toLowerCase()) === -1) throw invalidSelector(selector, method, iface);
            if (Array.isArray(token.data)) token.data.forEach(walk);
          } else if (token.type === "tag" && !(token.name === "*" || IDENT.test(token.name))) {
            throw invalidSelector(selector, method, iface);
          } else if (token.type === "tag" && token.namespace !== undefined && token.namespace !== null && token.namespace !== "*") {
            throw invalidSelector(selector, method, iface);
          } else if (token.type === "attribute" && token.namespace !== undefined && token.namespace !== null && token.namespace !== "*") {
            throw invalidSelector(selector, method, iface);
          }
        }
      };
      parsed.forEach(walk);
      if (never) return null;
      var dropNamespaces = function (tokens) {
        tokens.forEach(function (token) {
          if (token.namespace === "*") delete token.namespace;
          if (token.type === "pseudo" && Array.isArray(token.data)) token.data.forEach(dropNamespaces);
        });
      };
      parsed.forEach(dropNamespaces);
      if (parsed.some(function (tokens) { return tokens.length && TRAVERSALS[tokens[0].type]; })) throw invalidSelector(selector, method, iface);
      var doc = ownerOf(context);
      var html = isHTMLDoc(doc);
      try {
        return engine.compile(parsed, {
          adapter: selectorAdapter, xmlMode: !html, lowerCaseTags: html, lowerCaseAttributeNames: html, cacheResults: false,
          quirksMode: stateOf(doc).mode === "quirks", pseudos: selectorPseudos, context: context, relativeSelector: false,
        });
      } catch (error) {
        throw invalidSelector(selector, method, iface);
      }
    };

    var querySelectorAll = function (root, text, method, iface) {
      var test = compileSelector(text, root, method, iface);
      if (!test) return [];
      return selectorAdapter.findAll(test, selectorAdapter.getChildren(root));
    };

    var querySelector = function (root, text, method, iface) {
      var test = compileSelector(text, root, method, iface);
      if (!test) return null;
      return selectorAdapter.findOne(test, selectorAdapter.getChildren(root));
    };

    var selectorMethods = function (holder, iface) {
      if (!holder) return;
      patch(holder, "querySelector", function querySelector_(selectors) {
        required(arguments, 1, "querySelector", iface);
        return querySelector(this, selectors, "querySelector", iface);
      });
      patch(holder, "querySelectorAll", function querySelectorAll_(selectors) {
        required(arguments, 1, "querySelectorAll", iface);
        return listOf(querySelectorAll(this, selectors, "querySelectorAll", iface), "NodeList");
      });
    };

    selectorMethods(docProto, "Document");
    selectorMethods(globalThis.Element && globalThis.Element.prototype, "Element");
    selectorMethods(globalThis.DocumentFragment && globalThis.DocumentFragment.prototype, "DocumentFragment");

    var matchesSelector = function (element, text, method) {
      var test = compileSelector(text, element, method, "Element");
      return Boolean(test) && test(element);
    };

    if (globalThis.Element && globalThis.Element.prototype) {
      var elementProto = globalThis.Element.prototype;
      patch(elementProto, "matches", function matches(selectors) {
        required(arguments, 1, "matches", "Element");
        return matchesSelector(this, selectors, "matches");
      });
      patch(elementProto, "webkitMatchesSelector", function webkitMatchesSelector(selectors) {
        required(arguments, 1, "webkitMatchesSelector", "Element");
        return matchesSelector(this, selectors, "webkitMatchesSelector");
      });
      patch(elementProto, "closest", function closest(selectors) {
        required(arguments, 1, "closest", "Element");
        var test = compileSelector(selectors, this, "closest", "Element");
        if (!test) return null;
        for (var at = this; at && selectorAdapter.isTag(at); at = selectorAdapter.getParent(at)) if (test(at)) return at;
        return null;
      });
    }

    env.querySelectorAll = function (root, text) { return querySelectorAll(root, text, "querySelectorAll", "Element"); };

    // ---- Attributes ----

    // The key an attribute name reads under: lower-cased for an HTML element in an HTML document
    // (as getAttribute and setAttribute fold it), as given otherwise.
    attributeKey = function (state, node, name) {
      var text = String(name);
      return isHTMLElement(state) && isHTMLDoc(ownerOf(node)) ? text.toLowerCase() : text;
    };

    var attrNamespace = function (state, key) {
      var held = state.attrNS && state.attrNS[key];
      return held || { namespaceURI: null, prefix: null, localName: key };
    };

    var setAttributeNS = function (node, namespace, qualified, value) {
      var state = stateOf(node);
      var name = String(qualified);
      var colon = name.indexOf(":");
      var prefix = colon === -1 ? null : name.slice(0, colon);
      var local = colon === -1 ? name : name.slice(colon + 1);
      if (!state.attrNS) state.attrNS = {};
      if (namespace) state.attrNS[name] = { namespaceURI: namespace, prefix: prefix, localName: local };
      else delete state.attrNS[name];
      setAttr(node, name, value);
    };

    var attrState = new WeakMap();

    var attrFor = function (element, key) {
      var state = stateOf(element);
      if (!state.attrObjects) state.attrObjects = {};
      var attr = state.attrObjects[key];
      if (!attr) {
        attr = Object.create((globalThis.Attr && globalThis.Attr.prototype) || Object.prototype);
        attrState.set(attr, { element: element, name: key });
        elementState.set(attr, {
          nodeType: 2, nodeName: key, parentNode: null, parentElement: null, ownerDocument: ownerOf(element),
          previousSibling: null, nextSibling: null, childNodes: [], attrs: {}, tag: "#attr", attr: true,
        });
        state.attrObjects[key] = attr;
      }
      return attr;
    };

    var attrsOf = function (element) {
      var state = stateOf(element);
      return Object.keys(state.attrs).map(function (key) { return attrFor(element, key); });
    };

    if (globalThis.Attr && globalThis.Attr.prototype) {
      var attrProto = globalThis.Attr.prototype;
      var attrField = function (attr) {
        var held = attrState.get(attr);
        if (!held) throw typeError("Illegal invocation");
        var owner = held.element && Object.prototype.hasOwnProperty.call(stateOf(held.element).attrs, held.name) ? held.element : null;
        var info = owner ? attrNamespace(stateOf(owner), held.name) : held.info || { namespaceURI: null, prefix: null, localName: held.name };
        return { owner: owner, held: held, info: info, value: owner ? stateOf(owner).attrs[held.name] : held.value || "" };
      };
      patchGetter(attrProto, "name", function () { return attrField(this).held.name; });
      patchGetter(attrProto, "localName", function () { return attrField(this).info.localName; });
      patchGetter(attrProto, "namespaceURI", function () { return attrField(this).info.namespaceURI; });
      patchGetter(attrProto, "prefix", function () { return attrField(this).info.prefix; });
      patchGetter(attrProto, "ownerElement", function () { return attrField(this).owner; });
      patchGetter(attrProto, "specified", function () { attrField(this); return true; });
      try {
        Object.defineProperty(attrProto, "value", {
          get: asNative(function () { return attrField(this).value; }, "get value"),
          set: asNative(function (value) {
            var field = attrField(this);
            if (field.owner) setAttr(field.owner, field.held.name, String(value));
            else field.held.value = String(value);
          }, "set value"),
          enumerable: true,
          configurable: true,
        });
      } catch (error) {}
    }

    var attributeViews = new WeakMap();
    var attributesView = function (element) {
      var view = attributeViews.get(element);
      if (!view) {
        view = makeCollection("NamedNodeMap", function () { return attrsOf(element); }, {
          keys: function () { return Object.keys(stateOf(element).attrs); },
          find: function (list, key) { return Object.prototype.hasOwnProperty.call(stateOf(element).attrs, key) ? attrFor(element, key) : null; },
        });
        attributeViews.set(element, view);
        listOwners.set(view, element);
      }
      return view;
    };

    var listOwners = new WeakMap();

    if (globalThis.NamedNodeMap && globalThis.NamedNodeMap.prototype) {
      var mapProto = globalThis.NamedNodeMap.prototype;
      var ownerFor = function (view) {
        var element = listOwners.get(view);
        if (!element) throw typeError("Illegal invocation");
        return element;
      };
      patchGetter(mapProto, "length", function () { return Object.keys(stateOf(ownerFor(this)).attrs).length; });
      patch(mapProto, "item", function item(index) {
        required(arguments, 1, "item", "NamedNodeMap");
        var element = ownerFor(this);
        var key = Object.keys(stateOf(element).attrs)[Number(index) >>> 0];
        return key === undefined ? null : attrFor(element, key);
      });
      patch(mapProto, "getNamedItem", function getNamedItem(name) {
        required(arguments, 1, "getNamedItem", "NamedNodeMap");
        var element = ownerFor(this);
        var key = attributeKey(stateOf(element), element, name);
        return Object.prototype.hasOwnProperty.call(stateOf(element).attrs, key) ? attrFor(element, key) : null;
      });
      patch(mapProto, "getNamedItemNS", function getNamedItemNS(namespace, local) {
        required(arguments, 2, "getNamedItemNS", "NamedNodeMap");
        var element = ownerFor(this);
        var key = findNS(stateOf(element), namespace, local);
        return key === null ? null : attrFor(element, key);
      });
      patch(mapProto, "removeNamedItem", function removeNamedItem(name) {
        required(arguments, 1, "removeNamedItem", "NamedNodeMap");
        var element = ownerFor(this);
        var key = attributeKey(stateOf(element), element, name);
        if (!Object.prototype.hasOwnProperty.call(stateOf(element).attrs, key)) {
          throw domException("Failed to execute 'removeNamedItem' on 'NamedNodeMap': No item with name '" + String(name) + "' was found.", "NotFoundError");
        }
        var attr = attrFor(element, key);
        var held = attrState.get(attr);
        held.value = stateOf(element).attrs[key];
        held.info = attrNamespace(stateOf(element), key);
        setAttr(element, key, null);
        return attr;
      });
      Object.defineProperty(mapProto, Symbol.iterator, { value: Array.prototype.values, writable: true, enumerable: false, configurable: true });
    }

    var findNS = function (state, namespace, local) {
      var ns = namespace === null || namespace === undefined || namespace === "" ? null : String(namespace);
      var keys = Object.keys(state.attrs);
      for (var index = 0; index < keys.length; index += 1) {
        var info = attrNamespace(state, keys[index]);
        if (info.namespaceURI === ns && info.localName === String(local)) return keys[index];
      }
      return null;
    };

    var VALID_ATTRIBUTE = /^[^\t\n\f\r />"'=\0]+$/;

    if (globalThis.Element && globalThis.Element.prototype) {
      var elementAttrs = globalThis.Element.prototype;
      patchGetter(elementAttrs, "attributes", function () {
        if (!selectorAdapter.isTag(this)) throw typeError("Illegal invocation");
        return attributesView(this);
      });
      patchGetter(elementAttrs, "namespaceURI", function () { var state = stateOf(this); return state ? namespaceOf(state) : null; });
      patchGetter(elementAttrs, "prefix", function () { var state = stateOf(this); return state ? state.prefix || null : null; });
      patchGetter(elementAttrs, "localName", function () { var state = stateOf(this); return state ? state.localName || state.tag : undefined; });
      patch(elementAttrs, "setAttribute", function setAttribute(name, value) {
        required(arguments, 2, "setAttribute", "Element");
        if (!VALID_ATTRIBUTE.test(String(name))) throw domException("Failed to execute 'setAttribute' on 'Element': '" + String(name) + "' is not a valid attribute name.", "InvalidCharacterError");
        setAttr(this, attributeKey(stateOf(this), this, name), String(value));
      });
      patch(elementAttrs, "getAttribute", function getAttribute(name) {
        required(arguments, 1, "getAttribute", "Element");
        var state = stateOf(this);
        if (!state) return null;
        var key = attributeKey(state, this, name);
        return Object.prototype.hasOwnProperty.call(state.attrs, key) ? state.attrs[key] : null;
      });
      patch(elementAttrs, "hasAttribute", function hasAttribute(name) {
        required(arguments, 1, "hasAttribute", "Element");
        var state = stateOf(this);
        return Boolean(state) && Object.prototype.hasOwnProperty.call(state.attrs, attributeKey(state, this, name));
      });
      patch(elementAttrs, "removeAttribute", function removeAttribute(name) {
        required(arguments, 1, "removeAttribute", "Element");
        setAttr(this, attributeKey(stateOf(this), this, name), null);
      });
      patch(elementAttrs, "toggleAttribute", function toggleAttribute(name, force) {
        required(arguments, 1, "toggleAttribute", "Element");
        if (!VALID_ATTRIBUTE.test(String(name))) throw domException("Failed to execute 'toggleAttribute' on 'Element': '" + String(name) + "' is not a valid attribute name.", "InvalidCharacterError");
        var state = stateOf(this);
        var key = attributeKey(state, this, name);
        var has = Object.prototype.hasOwnProperty.call(state.attrs, key);
        if (has && (force === undefined || !force)) { setAttr(this, key, null); return false; }
        if (!has && (force === undefined || force)) { setAttr(this, key, ""); return true; }
        return has;
      });
      patch(elementAttrs, "getAttributeNames", function getAttributeNames() { return Object.keys(stateOf(this).attrs); });
      patch(elementAttrs, "hasAttributes", function hasAttributes() { return Object.keys(stateOf(this).attrs).length > 0; });
      patch(elementAttrs, "getAttributeNode", function getAttributeNode(name) {
        required(arguments, 1, "getAttributeNode", "Element");
        var state = stateOf(this);
        var key = attributeKey(state, this, name);
        return Object.prototype.hasOwnProperty.call(state.attrs, key) ? attrFor(this, key) : null;
      });
      patch(elementAttrs, "setAttributeNS", function setAttributeNS_(namespace, qualified, value) {
        required(arguments, 3, "setAttributeNS", "Element");
        checkQualified(qualified, "setAttributeNS", "Element");
        var ns = checkNamespace(namespace, qualified, "setAttributeNS", "Element");
        var state = stateOf(this);
        var colon = String(qualified).indexOf(":");
        var existing = findNS(state, ns, colon === -1 ? String(qualified) : String(qualified).slice(colon + 1));
        if (existing !== null && existing !== String(qualified)) setAttr(this, existing, null);
        setAttributeNS(this, ns, qualified, String(value));
      });
      patch(elementAttrs, "getAttributeNS", function getAttributeNS(namespace, local) {
        required(arguments, 2, "getAttributeNS", "Element");
        var state = stateOf(this);
        var key = findNS(state, namespace, local);
        return key === null ? null : state.attrs[key];
      });
      patch(elementAttrs, "hasAttributeNS", function hasAttributeNS(namespace, local) {
        required(arguments, 2, "hasAttributeNS", "Element");
        return findNS(stateOf(this), namespace, local) !== null;
      });
      patch(elementAttrs, "removeAttributeNS", function removeAttributeNS(namespace, local) {
        required(arguments, 2, "removeAttributeNS", "Element");
        var key = findNS(stateOf(this), namespace, local);
        if (key !== null) setAttr(this, key, null);
      });
    }

    // ---- Markup: parse5 in, parse5 out ----

    var parser = function () { return env.htmlEngine(); };

    // Builds the sandbox's nodes for parse5's children of `source` under `parent`, owned by `owner`.
    // Scripts the parser makes never run (innerHTML, DOMParser and fragments don't run them).
    // A "<?target data?>" the tokenizer took for a bogus comment: Chrome makes it a processing
    // instruction (unless its target is xml), its data without the closing "?".
    var instructionFrom = function (comment, markup, owner) {
      var at = comment.sourceCodeLocation ? comment.sourceCodeLocation.startOffset : -1;
      if (at < 0 || markup.slice(at, at + 2) !== "<?") return null;
      var match = /^\?([^\t\n\f\r ?>]+)[\t\n\f\r ]*([\s\S]*?)\??$/.exec(comment.data);
      if (!match || match[1].toLowerCase() === "xml") return null;
      var node = makeCharacterData("ProcessingInstruction", 7, match[1], match[2], owner);
      stateOf(node).target = match[1];
      return node;
    };

    var build = function (source, parent, owner, markup) {
      var kids = source.childNodes || [];
      for (var index = 0; index < kids.length; index += 1) {
        var kid = kids[index];
        var made;
        if (kid.nodeName === "#text") made = makeCharacterData("Text", 3, "#text", kid.value, owner);
        else if (kid.nodeName === "#comment") made = instructionFrom(kid, markup, owner) || makeCharacterData("Comment", 8, "#comment", kid.data, owner);
        else if (kid.nodeName === "#documentType") made = makeDoctype(kid.name, kid.publicId, kid.systemId, owner);
        else {
          made = kid.namespaceURI === HTML_NS ? makeElement(kid.tagName, owner) : makeElementNS(kid.namespaceURI, kid.tagName, owner);
          var attrs = kid.attrs || [];
          for (var at = 0; at < attrs.length; at += 1) {
            var attr = attrs[at];
            var qualified = attr.prefix ? attr.prefix + ":" + attr.name : attr.name;
            if (attr.namespace) setAttributeNS(made, attr.namespace, qualified, attr.value);
            else setAttr(made, qualified, attr.value);
          }
          if (kid.namespaceURI === HTML_NS && kid.tagName === "script") stateOf(made).started = true;
          if (kid.namespaceURI === HTML_NS && kid.tagName === "template" && kid.content) build(kid.content, templateContent(made), templateOwner(owner), markup);
          else build(kid, made, owner, markup);
        }
        appendQuietly(parent, made);
      }
    };

    var scriptingOf = function (doc) { var state = stateOf(doc); return Boolean(state && state.scripting); };

    // The nodes `markup` parses to in `context` (an element), owned by the context's document.
    var parseFragment = function (markup, context) {
      var state = stateOf(context);
      var owner = ownerOf(context);
      var engine = parser();
      var tag = state.nodeType === 1 ? state.localName || state.tag : "body";
      var namespace = state.nodeType === 1 ? namespaceOf(state) : HTML_NS;
      var text = String(markup);
      var parsed = engine.parseFragment(engine.defaultTreeAdapter.createElement(tag, namespace, []), text, { scriptingEnabled: scriptingOf(owner), sourceCodeLocationInfo: true });
      var holder = makeFragment(owner);
      build(parsed, holder, owner, text);
      return stateOf(holder).childNodes.slice();
    };

    env.parseFragment = parseFragment;

    env.parseHtml = function (source, host) {
      var nodes = parseFragment(source, host && stateOf(host) && stateOf(host).nodeType === 1 ? host : document.body || document.documentElement);
      for (var index = 0; index < nodes.length; index += 1) appendQuietly(host, nodes[index]);
      return host;
    };

    var parseDocument = function (markup, fields) {
      var engine = parser();
      var text = String(markup);
      var parsed = engine.parse(text, { scriptingEnabled: false, sourceCodeLocationInfo: true });
      var doc = makeDocument("HTMLDocument", { isHTML: true, contentType: "text/html", URL: fields.URL, mode: parsed.mode });
      build(parsed, doc, doc, text);
      return doc;
    };

    env.parseDocument = parseDocument;

    var serialAdapter = {
      getChildNodes: function (node) { return stateOf(node).childNodes; },
      getParentNode: function (node) { return stateOf(node).parentNode; },
      isElementNode: function (node) { return stateOf(node).nodeType === 1; },
      isTextNode: function (node) { var type = stateOf(node).nodeType; return type === 3 || type === 4; },
      isCommentNode: function (node) { var type = stateOf(node).nodeType; return type === 8 || type === 7; },
      isDocumentTypeNode: function (node) { return stateOf(node).nodeType === 10; },
      getTagName: function (node) {
        var state = stateOf(node);
        var ns = namespaceOf(state);
        return ns === HTML_NS || ns === SVG_NS || ns === MATHML_NS ? state.localName || state.tag : state.tagName;
      },
      getNamespaceURI: function (node) { return namespaceOf(stateOf(node)); },
      getAttrList: function (node) {
        var state = stateOf(node);
        return Object.keys(state.attrs).map(function (key) {
          var info = attrNamespace(state, key);
          return { name: info.namespaceURI ? info.localName : key, value: state.attrs[key], namespace: info.namespaceURI || undefined, prefix: info.prefix || undefined };
        });
      },
      getTextNodeContent: function (node) { return stateOf(node).data; },
      getCommentNodeContent: function (node) {
        var state = stateOf(node);
        return state.nodeType === 7 ? PI_MARK + state.target + " " + state.data + PI_MARK : state.data;
      },
      getDocumentTypeNodeName: function (node) { return stateOf(node).name; },
      getTemplateContent: function (node) { return templateContent(node); },
    };

    // A processing instruction serializes as Chrome writes one in HTML ("<?target data?>"); parse5
    // knows none, so it goes through as a comment with marks around it, rewritten after.
    var PI_MARK = "\uFDD0\uFDD1";
    var PI_SERIALIZED = new RegExp("<!--" + PI_MARK + "([\\s\\S]*?)" + PI_MARK + "-->", "g");
    var withInstructions = function (html) { return html.indexOf(PI_MARK) === -1 ? html : html.replace(PI_SERIALIZED, "<?$1?>"); };

    var serializeInner = function (node) {
      return withInstructions(parser().serialize(node, { treeAdapter: serialAdapter, scriptingEnabled: scriptingOf(ownerOf(node)) }));
    };
    var serializeOuter = function (node) {
      var state = stateOf(node);
      if (state.nodeType === 7) return "<?" + state.target + " " + state.data + "?>";
      return withInstructions(parser().serializeOuter(node, { treeAdapter: serialAdapter, scriptingEnabled: scriptingOf(ownerOf(node)) }));
    };

    env.serializeChildren = function (node) { return serializeInner(node); };
    env.serializeNode = function (node) { return serializeOuter(node); };
    serializeChildren = env.serializeChildren;
    serializeNode = env.serializeNode;

    var markupProto = globalThis.Element && globalThis.Element.prototype;
    if (markupProto) {
      try {
        Object.defineProperty(markupProto, "innerHTML", {
          get: asNative(function () {
            var state = stateOf(this);
            if (!state) return "";
            return serializeInner(this);
          }, "get innerHTML"),
          set: asNative(function (value) {
            var state = stateOf(this);
            if (!state) return;
            var markup = value === null ? "" : String(value);
            var target = isHTMLElement(state) && state.tag === "template" ? templateContent(this) : this;
            replaceAll(target, parseFragment(markup, this));
            state.html = "";
            state.layoutSource = markup;
            env.textChanged(this);
          }, "set innerHTML"),
          enumerable: true,
          configurable: true,
        });
        Object.defineProperty(markupProto, "outerHTML", {
          get: asNative(function () {
            var state = stateOf(this);
            return state ? serializeOuter(this) : "";
          }, "get outerHTML"),
          set: asNative(function (value) {
            var state = stateOf(this);
            if (!state || !state.parentNode) return;
            var parent = state.parentNode;
            var parentState = stateOf(parent);
            if (parentState.nodeType === 9) {
              throw domException("Failed to set the 'outerHTML' property on 'Element': This element's parent is a Document, which may not be modified.", "NoModificationAllowedError");
            }
            var context = parentState.nodeType === 11 ? makeElement("body", ownerOf(this)) : parent;
            var nodes = parseFragment(value === null ? "" : String(value), context);
            for (var index = 0; index < nodes.length; index += 1) insertChild(parent, nodes[index], this, "outerHTML", false);
            takeChild(parent, this, false);
          }, "set outerHTML"),
          enumerable: true,
          configurable: true,
        });
      } catch (error) {}

      var POSITIONS = { beforebegin: 1, afterbegin: 1, beforeend: 1, afterend: 1 };
      var positionOf = function (where, method) {
        var position = String(where).toLowerCase();
        if (!POSITIONS[position]) {
          throw domException("Failed to execute '" + method + "' on 'Element': The value provided ('" + String(where) + "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.", "SyntaxError");
        }
        return position;
      };

      // Puts `node` at `position` relative to `element`; false when there is no parent to put it in.
      var insertAdjacent = function (element, position, node, method) {
        var state = stateOf(element);
        if (position === "beforebegin" || position === "afterend") {
          var parent = state.parentNode;
          if (!parent || stateOf(parent).nodeType === 9) return false;
          insertChild(parent, node, position === "beforebegin" ? element : state.nextSibling, method, false, undefined, "Element");
          return true;
        }
        insertChild(element, node, position === "afterbegin" ? state.firstChild : null, method, false, undefined, "Element");
        return true;
      };

      patch(markupProto, "insertAdjacentHTML", function insertAdjacentHTML(where, markup) {
        required(arguments, 2, "insertAdjacentHTML", "Element");
        var position = positionOf(where, "insertAdjacentHTML");
        var state = stateOf(this);
        var context = position === "beforebegin" || position === "afterend" ? state.parentNode : this;
        if (!context || stateOf(context).nodeType === 9) {
          throw domException("Failed to execute 'insertAdjacentHTML' on 'Element': The element has no parent.", "NoModificationAllowedError");
        }
        if (stateOf(context).nodeType !== 1) context = makeElement("body", ownerOf(this));
        var holder = makeFragment(ownerOf(this));
        var nodes = parseFragment(String(markup), context);
        for (var index = 0; index < nodes.length; index += 1) appendQuietly(holder, nodes[index]);
        insertAdjacent(this, position, holder, "insertAdjacentHTML");
      });
      patch(markupProto, "insertAdjacentElement", function insertAdjacentElement(where, element) {
        required(arguments, 2, "insertAdjacentElement", "Element");
        var position = positionOf(where, "insertAdjacentElement");
        if (!selectorAdapter.isTag(element)) throw typeError("Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.");
        return insertAdjacent(this, position, element, "insertAdjacentElement") ? element : null;
      });
      patch(markupProto, "insertAdjacentText", function insertAdjacentText(where, data) {
        required(arguments, 2, "insertAdjacentText", "Element");
        var position = positionOf(where, "insertAdjacentText");
        insertAdjacent(this, position, makeCharacterData("Text", 3, "#text", String(data), ownerOf(this)), "insertAdjacentText");
      });
    }

    // ---- Documents scripts make ----

    var implementations = new WeakMap();
    var implementationOwner = new WeakMap();
    var mainImplementation = null;
    try {
      mainImplementation = document.implementation;
    } catch (error) {}

    var implementationOf = function (doc) {
      if (doc === document && mainImplementation) {
        implementationOwner.set(mainImplementation, document);
        return mainImplementation;
      }
      var found = implementations.get(doc);
      if (!found) {
        found = Object.create((globalThis.DOMImplementation && globalThis.DOMImplementation.prototype) || Object.prototype);
        implementations.set(doc, found);
        implementationOwner.set(found, doc);
      }
      return found;
    };

    patchGetter(docProto, "implementation", function () {
      if (!isDocument(this)) throw typeError("Illegal invocation");
      return implementationOf(this);
    });

    var newHTMLDocument = function (title) {
      var doc = makeDocument("HTMLDocument", { isHTML: true, contentType: "text/html" });
      appendQuietly(doc, makeDoctype("html", "", "", doc));
      var root = appendQuietly(doc, makeElement("html", doc));
      var head = appendQuietly(root, makeElement("head", doc));
      if (title !== undefined) appendQuietly(appendQuietly(head, makeElement("title", doc)), makeCharacterData("Text", 3, "#text", String(title), doc));
      appendQuietly(root, makeElement("body", doc));
      return doc;
    };

    var xmlContentType = function (namespace) {
      return namespace === HTML_NS ? "application/xhtml+xml" : namespace === SVG_NS ? "image/svg+xml" : "application/xml";
    };

    if (globalThis.DOMImplementation && globalThis.DOMImplementation.prototype) {
      var implProto = globalThis.DOMImplementation.prototype;
      var ownerDoc = function (impl) {
        var doc = implementationOwner.get(impl) || (impl === mainImplementation ? document : null);
        if (!doc) throw typeError("Illegal invocation");
        return doc;
      };
      patch(implProto, "createHTMLDocument", function createHTMLDocument(title) {
        ownerDoc(this);
        return newHTMLDocument(arguments.length ? title : undefined);
      });
      patch(implProto, "createDocument", function createDocument(namespace, qualified, doctype) {
        required(arguments, 2, "createDocument", "DOMImplementation");
        ownerDoc(this);
        var ns = namespace === null || namespace === undefined || namespace === "" ? null : String(namespace);
        var name = qualified === null || qualified === undefined ? "" : String(qualified);
        var element = null;
        if (name) {
          checkQualified(name, "createDocument", "DOMImplementation");
          checkNamespace(ns, name, "createDocument", "DOMImplementation");
        }
        var doc = makeDocument("XMLDocument", { isHTML: false, contentType: xmlContentType(ns) });
        if (doctype !== null && doctype !== undefined) {
          if (!stateOf(doctype) || stateOf(doctype).nodeType !== 10) throw typeError("Failed to execute 'createDocument' on 'DOMImplementation': parameter 3 is not of type 'DocumentType'.");
          adopt(doctype, doc);
          appendQuietly(doc, doctype);
        }
        if (name) element = appendQuietly(doc, makeElementNS(ns, name, doc));
        return doc;
      });
      patch(implProto, "createDocumentType", function createDocumentType(name, publicId, systemId) {
        required(arguments, 3, "createDocumentType", "DOMImplementation");
        var text = String(name);
        if (!validName(text)) throw domException("Failed to execute 'createDocumentType' on 'DOMImplementation': The qualified name provided ('" + text + "') contains the invalid name-start character '" + text.charAt(0) + "'.", "InvalidCharacterError");
        return makeDoctype(text, publicId, systemId, ownerDoc(this));
      });
      patch(implProto, "hasFeature", function hasFeature() { return true; });
    }

    var documentShell = installShell("Document", function () {
      return makeDocument("Document", { isHTML: false, contentType: "application/xml" });
    }, 0);
    if (globalThis.HTMLDocument) installShell("HTMLDocument", function () {}, 0, { illegal: true });
    if (globalThis.XMLDocument) installShell("XMLDocument", function () {}, 0, { illegal: true });
    if (documentShell) {
      patch(documentShell, "parseHTMLUnsafe", function parseHTMLUnsafe(markup) {
        required(arguments, 1, "parseHTMLUnsafe", "Document");
        return parseDocument(markup, { URL: "about:blank" });
      });
    }

    // ---- DOMParser and XML ----

    var XML_TYPES = { "text/xml": 1, "application/xml": 1, "application/xhtml+xml": 1, "image/svg+xml": 1 };

    var parserError = function (doc, message) {
      var error = makeElementNS(HTML_NS, "parsererror", doc);
      setAttr(error, "style", "display: block; white-space: pre; border: 2px solid #c77; padding: 0 1em 0 1em; margin: 1em; background-color: #fdd; color: black");
      var heading = appendQuietly(error, makeElementNS(HTML_NS, "h3", doc));
      appendQuietly(heading, makeCharacterData("Text", 3, "#text", "This page contains the following errors:", doc));
      var detail = appendQuietly(error, makeElementNS(HTML_NS, "div", doc));
      setAttr(detail, "style", "font-family:monospace;font-size:12px");
      appendQuietly(detail, makeCharacterData("Text", 3, "#text", message + "\n", doc));
      var after = appendQuietly(error, makeElementNS(HTML_NS, "h3", doc));
      appendQuietly(after, makeCharacterData("Text", 3, "#text", "Below is a rendering of the page up to the first error.", doc));
      return error;
    };

    // An XML document from `markup` (saxes, namespace-aware), or on the first error the part that
    // parsed with Chrome's <parsererror> in front, as libxml's error page reads.
    var parseXml = function (markup, type) {
      var doc = makeDocument("XMLDocument", { isHTML: false, contentType: type });
      var Saxes = env.xmlEngine().SaxesParser;
      var sax = new Saxes({ xmlns: true, position: true });
      var stack = [doc];
      var failed = null;
      var top = function () { return stack[stack.length - 1]; };
      sax.on("doctype", function (text) {
        var match = /^\s*([^\s\[>]+)(?:\s+PUBLIC\s+(["'])(.*?)\2\s+(["'])(.*?)\4|\s+SYSTEM\s+(["'])(.*?)\6)?/.exec(text);
        if (match) appendQuietly(doc, makeDoctype(match[1], match[3] || "", match[5] || match[7] || "", doc));
      });
      sax.on("opentag", function (tag) {
        var name = tag.prefix ? tag.prefix + ":" + tag.local : tag.local;
        var element = makeElementNS(tag.uri || null, name, doc);
        Object.keys(tag.attributes).forEach(function (key) {
          var attr = tag.attributes[key];
          if (attr.uri) setAttributeNS(element, attr.uri, attr.name, attr.value);
          else setAttr(element, attr.name, attr.value);
        });
        appendQuietly(top(), element);
        stack.push(element);
      });
      sax.on("closetag", function () { stack.pop(); });
      sax.on("text", function (text) { if (stack.length > 1) appendQuietly(top(), makeCharacterData("Text", 3, "#text", text, doc)); });
      sax.on("cdata", function (text) { appendQuietly(top(), makeCharacterData("CDATASection", 4, "#cdata-section", text, doc)); });
      sax.on("comment", function (text) { appendQuietly(top(), makeCharacterData("Comment", 8, "#comment", text, doc)); });
      sax.on("processinginstruction", function (pi) {
        if (pi.target === "xml" && stack.length === 1 && !stateOf(doc).childNodes.length) return;
        var node = makeCharacterData("ProcessingInstruction", 7, pi.target, pi.body, doc);
        stateOf(node).target = pi.target;
        appendQuietly(top(), node);
      });
      sax.on("error", function (error) {
        if (!failed) failed = error;
        throw error;
      });
      try {
        sax.write(String(markup)).close();
      } catch (error) {
        if (!failed) failed = error;
      }
      if (failed) {
        var match = /^(?:[^:]*:)?(\d+):(\d+): (.*)$/.exec(String(failed.message));
        var message = match ? "error on line " + match[1] + " at column " + match[2] + ": " + match[3] : String(failed.message);
        var root = rootElement(doc);
        var report = parserError(doc, message);
        if (root) insertChild(root, report, stateOf(root).firstChild, "appendChild", true);
        else appendQuietly(doc, report);
      }
      return doc;
    };

    if (globalThis.DOMParser && globalThis.DOMParser.prototype) {
      installShell("DOMParser", function () { return Object.create(globalThis.DOMParser.prototype); }, 0);
      patch(globalThis.DOMParser.prototype, "parseFromString", function parseFromString(markup, type) {
        required(arguments, 2, "parseFromString", "DOMParser");
        var kind = String(type);
        if (kind === "text/html") return parseDocument(markup, { URL: documentValues.URL });
        if (XML_TYPES[kind]) return parseXml(markup, kind);
        throw typeError("Failed to execute 'parseFromString' on 'DOMParser': The provided value '" + kind + "' is not a valid enum value of type SupportedType.");
      });
    }

    // XMLSerializer: XML serialization of a node (namespace declarations where an element's
    // namespace differs from its parent's, empty elements self-closed, text escaped for XML).
    var escapeXml = function (text, attribute) {
      var out = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return attribute ? out.replace(/"/g, "&quot;").replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;") : out;
    };

    var serializeXml = function (node, inherited) {
      var state = stateOf(node);
      switch (state.nodeType) {
        case 3: return escapeXml(state.data, false);
        case 4: return "<![CDATA[" + state.data + "]]>";
        case 8: return "<!--" + state.data + "-->";
        case 7: return "<?" + state.target + " " + state.data + "?>";
        case 10: {
          var out = "<!DOCTYPE " + state.name;
          if (state.publicId) out += " PUBLIC \"" + state.publicId + "\"";
          else if (state.systemId) out += " SYSTEM";
          if (state.systemId) out += " \"" + state.systemId + "\"";
          return out + ">";
        }
        case 9:
        case 11: return state.childNodes.map(function (kid) { return serializeXml(kid, inherited); }).join("");
        default: {
          var ns = namespaceOf(state);
          var name = state.prefix ? state.prefix + ":" + (state.localName || state.tag) : state.localName || state.tag;
          var text = "<" + name;
          if (ns !== inherited) text += state.prefix ? " xmlns:" + state.prefix + "=\"" + escapeXml(ns || "", true) + "\"" : " xmlns=\"" + escapeXml(ns || "", true) + "\"";
          Object.keys(state.attrs).forEach(function (key) {
            if (key === "xmlns" || key.indexOf("xmlns:") === 0) return;
            text += " " + key + "=\"" + escapeXml(state.attrs[key], true) + "\"";
          });
          var kids = isHTMLElement(state) && state.tag === "template" ? stateOf(templateContent(node)).childNodes : state.childNodes;
          if (!kids.length) return text + (ns === HTML_NS ? (VOID_TAGS[state.tag] ? " />" : "></" + name + ">") : "/>");
          return text + ">" + kids.map(function (kid) { return serializeXml(kid, ns); }).join("") + "</" + name + ">";
        }
      }
    };

    if (globalThis.XMLSerializer && globalThis.XMLSerializer.prototype) {
      installShell("XMLSerializer", function () { return Object.create(globalThis.XMLSerializer.prototype); }, 0);
      patch(globalThis.XMLSerializer.prototype, "serializeToString", function serializeToString(node) {
        required(arguments, 1, "serializeToString", "XMLSerializer");
        if (!stateOf(node)) throw typeError("Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.");
        var parent = stateOf(node).parentNode;
        return serializeXml(node, parent && stateOf(parent).nodeType === 1 ? namespaceOf(stateOf(parent)) : null);
      });
    }

    // ---- Cloning, importing, adopting ----

    var cloneInto = function (node, owner, deep) {
      var state = stateOf(node);
      var copy;
      switch (state.nodeType) {
        case 1:
          copy = namespaceOf(state) === HTML_NS && isHTMLDoc(owner) ? makeElement(state.localName || state.tag, owner) : makeElementNS(namespaceOf(state), state.prefix ? state.prefix + ":" + (state.localName || state.tag) : state.localName || state.tag, owner);
          Object.keys(state.attrs).forEach(function (key) {
            var info = attrNamespace(state, key);
            if (info.namespaceURI) setAttributeNS(copy, info.namespaceURI, key, state.attrs[key]);
            else setAttr(copy, key, state.attrs[key]);
          });
          var copied = stateOf(copy);
          if (isHTMLElement(state) && state.tag === "input") {
            ["value", "checked", "dirtyValue", "dirtyChecked"].forEach(function (field) { if (field in state) copied[field] = state[field]; });
          }
          if (state.started) copied.started = true;
          if (deep && isHTMLElement(state) && state.tag === "template") {
            var source = stateOf(templateContent(node)).childNodes;
            var into = templateContent(copy);
            for (var t = 0; t < source.length; t += 1) appendQuietly(into, cloneInto(source[t], templateOwner(owner), true));
          }
          break;
        case 3: copy = makeCharacterData("Text", 3, "#text", state.data, owner); break;
        case 4: copy = makeCharacterData("CDATASection", 4, "#cdata-section", state.data, owner); break;
        case 7: copy = makeCharacterData("ProcessingInstruction", 7, state.target, state.data, owner); stateOf(copy).target = state.target; break;
        case 8: copy = makeCharacterData("Comment", 8, "#comment", state.data, owner); break;
        case 10: copy = makeDoctype(state.name, state.publicId, state.systemId, owner); break;
        case 11: copy = makeFragment(owner); break;
        case 9:
          copy = makeDocument(Object.prototype.toString.call(node).slice(8, -1), { isHTML: state.isHTML, contentType: state.contentType, URL: state.URL, mode: state.mode });
          owner = copy;
          break;
        default:
          throw domException("Failed to execute 'cloneNode' on 'Node': The node provided cannot be cloned.", "NotSupportedError");
      }
      if (deep && state.nodeType !== 9 || deep && state.nodeType === 9) {
        var kids = state.childNodes || [];
        for (var index = 0; index < kids.length; index += 1) appendQuietly(copy, cloneInto(kids[index], owner, true));
      }
      return copy;
    };

    env.cloneNode = function (node, deep) { return cloneInto(node, ownerOf(node), deep); };

    if (nodePrototype) {
      patch(nodePrototype, "cloneNode", function cloneNode(deep) {
        var state = stateOf(this);
        if (!state) throw typeError("Illegal invocation");
        if (state.attr) throw domException("Failed to execute 'cloneNode' on 'Node': Attr nodes cannot be cloned.", "NotSupportedError");
        return cloneInto(this, state.nodeType === 9 ? this : ownerOf(this), Boolean(deep));
      });
    }

    patch(docProto, "importNode", function importNode(node, deep) {
      required(arguments, 1, "importNode", "Document");
      var state = stateOf(node);
      if (!state) throw typeError("Failed to execute 'importNode' on 'Document': parameter 1 is not of type 'Node'.");
      if (state.nodeType === 9) throw domException("Failed to execute 'importNode' on 'Document': The node provided is a document, which may not be imported.", "NotSupportedError");
      return cloneInto(node, documentOf(this), Boolean(deep));
    });

    patch(docProto, "adoptNode", function adoptNode(node) {
      required(arguments, 1, "adoptNode", "Document");
      var state = stateOf(node);
      if (!state) throw typeError("Failed to execute 'adoptNode' on 'Document': parameter 1 is not of type 'Node'.");
      if (state.nodeType === 9) throw domException("Failed to execute 'adoptNode' on 'Document': The node provided is of type '#document', which may not be adopted.", "NotSupportedError");
      if (state.parentNode) takeChild(state.parentNode, node, false);
      adopt(node, documentOf(this));
      return node;
    });

    // ---- Comparing and normalising ----

    var equalNodes = function (left, right) {
      var a = stateOf(left);
      var b = stateOf(right);
      if (!a || !b || a.nodeType !== b.nodeType) return false;
      switch (a.nodeType) {
        case 1: {
          if (namespaceOf(a) !== namespaceOf(b) || (a.prefix || null) !== (b.prefix || null) || (a.localName || a.tag) !== (b.localName || b.tag)) return false;
          var keys = Object.keys(a.attrs);
          if (keys.length !== Object.keys(b.attrs).length) return false;
          for (var index = 0; index < keys.length; index += 1) if (b.attrs[keys[index]] !== a.attrs[keys[index]]) return false;
          break;
        }
        case 10: if (a.name !== b.name || a.publicId !== b.publicId || a.systemId !== b.systemId) return false; break;
        case 7: if (a.target !== b.target || a.data !== b.data) return false; break;
        case 3: case 4: case 8: if (a.data !== b.data) return false; break;
        default: break;
      }
      var kidsA = a.childNodes || [];
      var kidsB = b.childNodes || [];
      if (kidsA.length !== kidsB.length) return false;
      for (var at = 0; at < kidsA.length; at += 1) if (!equalNodes(kidsA[at], kidsB[at])) return false;
      return true;
    };

    var ancestorsOf = function (node) {
      var chain = [node];
      for (var up = stateOf(node).parentNode; up; up = stateOf(up).parentNode) chain.unshift(up);
      return chain;
    };

    var disconnectedOrder = new WeakMap();
    var orderCount = 0;
    var orderOf = function (node) {
      if (!disconnectedOrder.has(node)) disconnectedOrder.set(node, (orderCount += 1));
      return disconnectedOrder.get(node);
    };

    var comparePosition = function (self, other) {
      if (self === other) return 0;
      var mine = ancestorsOf(self);
      var theirs = ancestorsOf(other);
      if (mine[0] !== theirs[0]) {
        return 1 | 32 | (orderOf(mine[0]) < orderOf(theirs[0]) ? 4 : 2);
      }
      if (theirs.indexOf(self) !== -1) return 16 | 4;
      if (mine.indexOf(other) !== -1) return 8 | 2;
      var depth = 0;
      while (mine[depth] === theirs[depth]) depth += 1;
      var siblings = stateOf(mine[depth - 1]).childNodes;
      return siblings.indexOf(mine[depth]) < siblings.indexOf(theirs[depth]) ? 4 : 2;
    };

    var normalizeNode = function (node) {
      var kids = stateOf(node).childNodes.slice();
      for (var index = 0; index < kids.length; index += 1) {
        var kid = kids[index];
        var state = stateOf(kid);
        if (state.nodeType === 3) {
          if (!state.data) {
            takeChild(node, kid, false);
            continue;
          }
          var text = state.data;
          var next = state.nextSibling;
          while (next && stateOf(next).nodeType === 3) {
            text += stateOf(next).data;
            var gone = next;
            next = stateOf(next).nextSibling;
            takeChild(node, gone, false);
          }
          if (text !== state.data) kid.data = text;
        } else if (state.childNodes && state.childNodes.length) {
          normalizeNode(kid);
        }
      }
    };

    if (nodePrototype) {
      patch(nodePrototype, "isEqualNode", function isEqualNode(other) {
        required(arguments, 1, "isEqualNode", "Node");
        return other !== null && other !== undefined && equalNodes(this, other);
      });
      patch(nodePrototype, "isSameNode", function isSameNode(other) {
        required(arguments, 1, "isSameNode", "Node");
        return this === other;
      });
      patch(nodePrototype, "compareDocumentPosition", function compareDocumentPosition(other) {
        required(arguments, 1, "compareDocumentPosition", "Node");
        if (!stateOf(other)) throw typeError("Failed to execute 'compareDocumentPosition' on 'Node': parameter 1 is not of type 'Node'.");
        return comparePosition(this, other);
      });
      patch(nodePrototype, "normalize", function normalize() { normalizeNode(this); });
      patchGetter(nodePrototype, "isConnected", function () {
        var root = ancestorsOf(this)[0];
        while (stateOf(root).shadow) root = ancestorsOf(stateOf(root).host)[0];
        return stateOf(root).nodeType === 9;
      });
    }

    // ---- Character data ----

    var dataOf = function (node, method) {
      var state = stateOf(node);
      if (!state || (state.nodeType !== 3 && state.nodeType !== 4 && state.nodeType !== 7 && state.nodeType !== 8)) throw typeError("Illegal invocation");
      return state;
    };

    var indexError = function (method, offset, length) {
      return domException("Failed to execute '" + method + "' on 'CharacterData': The offset " + offset + " is greater than the node's length (" + length + ").", "IndexSizeError");
    };

    var characterData = globalThis.CharacterData && globalThis.CharacterData.prototype;
    if (characterData) {
      var replaceData = function (node, method, offset, count, text) {
        var state = dataOf(node, method);
        var at = Number(offset) >>> 0;
        if (at > state.data.length) throw indexError(method, at, state.data.length);
        var end = Math.min(state.data.length, at + (Number(count) >>> 0));
        node.data = state.data.slice(0, at) + text + state.data.slice(end);
      };
      patch(characterData, "appendData", function appendData(text) { required(arguments, 1, "appendData", "CharacterData"); var state = dataOf(this); this.data = state.data + String(text); });
      patch(characterData, "insertData", function insertData(offset, text) { required(arguments, 2, "insertData", "CharacterData"); replaceData(this, "insertData", offset, 0, String(text)); });
      patch(characterData, "deleteData", function deleteData(offset, count) { required(arguments, 2, "deleteData", "CharacterData"); replaceData(this, "deleteData", offset, count, ""); });
      patch(characterData, "replaceData", function replaceData_(offset, count, text) { required(arguments, 3, "replaceData", "CharacterData"); replaceData(this, "replaceData", offset, count, String(text)); });
      patch(characterData, "substringData", function substringData(offset, count) {
        required(arguments, 2, "substringData", "CharacterData");
        var state = dataOf(this);
        var at = Number(offset) >>> 0;
        if (at > state.data.length) throw indexError("substringData", at, state.data.length);
        return state.data.substr(at, Number(count) >>> 0);
      });
    }

    var textProto = globalThis.Text && globalThis.Text.prototype;
    if (textProto) {
      patch(textProto, "splitText", function splitText(offset) {
        required(arguments, 1, "splitText", "Text");
        var state = dataOf(this);
        var at = Number(offset) >>> 0;
        if (at > state.data.length) throw domException("Failed to execute 'splitText' on 'Text': The offset " + at + " is larger than the Text node's length.", "IndexSizeError");
        var rest = makeCharacterData("Text", 3, "#text", state.data.slice(at), ownerOf(this));
        if (state.parentNode) insertChild(state.parentNode, rest, state.nextSibling, "splitText", false);
        this.data = state.data.slice(0, at);
        return rest;
      });
      patchGetter(textProto, "wholeText", function () {
        var state = dataOf(this);
        var text = state.data;
        for (var back = state.previousSibling; back && stateOf(back).nodeType === 3; back = stateOf(back).previousSibling) text = stateOf(back).data + text;
        for (var ahead = state.nextSibling; ahead && stateOf(ahead).nodeType === 3; ahead = stateOf(ahead).nextSibling) text += stateOf(ahead).data;
        return text;
      });
    }

    // ---- Ranges, as far as fragments need them ----

    if (globalThis.Range && globalThis.Range.prototype) {
      var rangeStart = new WeakMap();
      var makeRange = function (doc) {
        var range = Object.create(globalThis.Range.prototype);
        rangeStart.set(range, { container: doc, offset: 0 });
        return range;
      };
      installShell("Range", function () { return makeRange(document); }, 0);
      patch(docProto, "createRange", function createRange() { return makeRange(documentOf(this)); });
      patch(globalThis.Range.prototype, "createContextualFragment", function createContextualFragment(markup) {
        required(arguments, 1, "createContextualFragment", "Range");
        var start = rangeStart.get(this);
        if (!start) throw typeError("Illegal invocation");
        var container = start.container;
        var state = stateOf(container);
        var context = state.nodeType === 1 ? container : state.nodeType === 9 ? bodyOf(container) || rootElement(container) : state.parentNode;
        if (!context || stateOf(context).nodeType !== 1 || (isHTMLElement(stateOf(context)) && stateOf(context).tag === "html" && isHTMLDoc(ownerOf(context)))) {
          context = makeElement("body", ownerOf(container));
        }
        var fragment = makeFragment(ownerOf(container));
        var nodes = parseFragment(String(markup), context);
        for (var index = 0; index < nodes.length; index += 1) appendQuietly(fragment, nodes[index]);
        return fragment;
      });
      patchGetter(globalThis.Range.prototype, "startContainer", function () { var start = rangeStart.get(this); return start ? start.container : null; });
      patchGetter(globalThis.Range.prototype, "startOffset", function () { var start = rangeStart.get(this); return start ? start.offset : 0; });
      patchGetter(globalThis.Range.prototype, "collapsed", function () { return true; });
    }

    var fragmentProto = globalThis.DocumentFragment && globalThis.DocumentFragment.prototype;
    if (fragmentProto) {
      patchGetter(fragmentProto, "children", function () { return childrenOf(this); });
      ["childElementCount", "firstElementChild", "lastElementChild"].forEach(function (field) {
        patchGetter(fragmentProto, field, function () {
          var state = stateOf(this);
          if (!state) throw typeError("Illegal invocation");
          return state[field] === undefined ? (field === "childElementCount" ? 0 : null) : state[field];
        });
      });
    }

    var allProto = globalThis.HTMLAllCollection && globalThis.HTMLAllCollection.prototype;
    if (allProto) {
      patchGetter(allProto, "length", function () { return Number(listLength(this)); });
      patch(allProto, "item", function item(name) {
        var items = listContents(this);
        if (name === undefined) return null;
        var index = Number(name);
        if (String(index >>> 0) === String(name)) return items[index] || null;
        return namedItem(items, String(name));
      });
      patch(allProto, "namedItem", function namedItem_(name) {
        required(arguments, 1, "namedItem", "HTMLAllCollection");
        return namedItem(listContents(this), String(name));
      });
      Object.defineProperty(allProto, Symbol.iterator, { value: Array.prototype.values, writable: true, enumerable: false, configurable: true });
    }


    // ---- Shadow roots ----

    // Elements a shadow root may be attached to (and any valid custom element name).
    var SHADOW_HOSTS = { article: 1, aside: 1, blockquote: 1, body: 1, div: 1, footer: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, main: 1, nav: 1, p: 1, section: 1, span: 1 };
    var CUSTOM_NAME = /^[a-z][.0-9_a-z·À-ÖØ-öø-ͽͿ-῿‌-‍‿-⁀⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�-]*-[.0-9_a-z·À-ÖØ-öø-ͽͿ-῿‌-‍‿-⁀⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�-]*$/;
    var RESERVED_NAMES = { "annotation-xml": 1, "color-profile": 1, "font-face": 1, "font-face-src": 1, "font-face-uri": 1, "font-face-format": 1, "font-face-name": 1, "missing-glyph": 1 };

    var shadowProto = globalThis.ShadowRoot && globalThis.ShadowRoot.prototype;
    if (shadowProto && globalThis.Element) {
      var attachWhere = "Failed to execute 'attachShadow' on 'Element': ";
      patch(globalThis.Element.prototype, "attachShadow", function attachShadow(init) {
        required(arguments, 1, "attachShadow", "Element");
        var host = stateOf(this);
        if (init === null || (typeof init !== "object" && typeof init !== "function")) throw typeError(attachWhere + "The provided value is not of type 'ShadowRootInit'.");
        var mode = init.mode;
        if (mode === undefined) throw typeError(attachWhere + "Failed to read the 'mode' property from 'ShadowRootInit': Required member is undefined.");
        mode = String(mode);
        if (mode !== "open" && mode !== "closed") throw typeError(attachWhere + "Failed to read the 'mode' property from 'ShadowRootInit': The provided value '" + mode + "' is not a valid enum value of type ShadowRootMode.");
        var name = host.localName || host.tag;
        if (!isHTMLElement(host) || !(SHADOW_HOSTS[name] || (CUSTOM_NAME.test(name) && !RESERVED_NAMES[name]))) {
          throw domException(attachWhere + "This element does not support attachShadow", "NotSupportedError");
        }
        if (host.shadowRoot) throw domException(attachWhere + "Shadow root cannot be created on a host which already hosts a shadow tree.", "NotSupportedError");
        var root = Object.create(shadowProto);
        elementState.set(root, {
          tag: "#shadow-root", handle: "shadow", attrs: {}, nodeType: 11, nodeName: "#document-fragment", childNodes: [], children: [],
          childElementCount: 0, firstElementChild: null, lastElementChild: null, firstChild: null, lastChild: null,
          previousSibling: null, nextSibling: null, parentNode: null, parentElement: null, ownerDocument: ownerOf(this),
          shadow: true, host: this, mode: mode, delegatesFocus: Boolean(init.delegatesFocus), clonable: Boolean(init.clonable),
          serializable: Boolean(init.serializable), slotAssignment: init.slotAssignment === "manual" ? "manual" : "named",
        });
        host.shadowRoot = root;
        return root;
      });
      patchGetter(globalThis.Element.prototype, "shadowRoot", function () {
        var state = stateOf(this);
        if (!state) throw typeError("Illegal invocation");
        return state.shadowRoot && stateOf(state.shadowRoot).mode === "open" ? state.shadowRoot : null;
      });
      ["mode", "host", "delegatesFocus", "clonable", "serializable", "slotAssignment"].forEach(function (field) {
        patchGetter(shadowProto, field, function () {
          var state = stateOf(this);
          if (!state || !state.shadow) throw typeError("Illegal invocation");
          return state[field];
        });
      });
      ["activeElement", "fullscreenElement", "pointerLockElement", "pictureInPictureElement"].forEach(function (field) {
        if (Object.getOwnPropertyDescriptor(shadowProto, field)) {
          patchGetter(shadowProto, field, function () { if (!stateOf(this)) throw typeError("Illegal invocation"); return null; });
        }
      });
      var adopted = new WeakMap();
      try {
        var adoptedDescriptor = Object.getOwnPropertyDescriptor(shadowProto, "adoptedStyleSheets");
        if (adoptedDescriptor) {
          Object.defineProperty(shadowProto, "adoptedStyleSheets", {
            get: asNative(function () { if (!stateOf(this)) throw typeError("Illegal invocation"); if (!adopted.has(this)) adopted.set(this, []); return adopted.get(this); }, "get adoptedStyleSheets"),
            set: asNative(function (value) { if (!stateOf(this)) throw typeError("Illegal invocation"); adopted.set(this, Array.from(value)); }, "set adoptedStyleSheets"),
            enumerable: true, configurable: true,
          });
        }
      } catch (error) {}
      try {
        Object.defineProperty(shadowProto, "innerHTML", {
          get: asNative(function () { if (!stateOf(this)) throw typeError("Illegal invocation"); return serializeInner(this); }, "get innerHTML"),
          set: asNative(function (value) {
            var state = stateOf(this);
            if (!state) throw typeError("Illegal invocation");
            replaceAll(this, parseFragment(value === null ? "" : String(value), state.host));
          }, "set innerHTML"),
          enumerable: true, configurable: true,
        });
      } catch (error) {}
      if (globalThis.Node) {
        patch(globalThis.Node.prototype, "getRootNode", function getRootNode(options) {
          var composed = Boolean(options && typeof options === "object" && options.composed);
          var at = this;
          for (;;) {
            var state = stateOf(at);
            if (!state) throw typeError("Illegal invocation");
            if (state.parentNode) { at = state.parentNode; continue; }
            if (composed && state.shadow) { at = state.host; continue; }
            return at;
          }
        });
      }
    }

    // ---- Style sheet lists ----
    //
    // A document's or shadow root's styleSheets: a live StyleSheetList of the sheets its <style>
    // and <link rel=stylesheet> elements carry (the element module gives loaded ones a `sheet`).
    var sheetLists = new WeakMap();
    var styleSheetsOf = function (root) {
      var list = sheetLists.get(root);
      if (!list) {
        list = makeCollection("StyleSheetList", function () {
          return elementsUnder(root, function (node, state) {
            return isHTMLElement(state) && (state.tag === "style" || (state.tag === "link" && /(^|\s)stylesheet(\s|$)/i.test(state.attrs.rel || "")));
          }).map(function (node) { try { return node.sheet; } catch (error) { return null; } }).filter(Boolean);
        });
        sheetLists.set(root, list);
      }
      return list;
    };

    var sheetListProto = globalThis.StyleSheetList && globalThis.StyleSheetList.prototype;
    if (sheetListProto) {
      patchGetter(sheetListProto, "length", function () { return listLength(this); });
      patch(sheetListProto, "item", function item(index) {
        required(arguments, 1, "item", "StyleSheetList");
        return listContents(this)[Number(index) >>> 0] || null;
      });
      Object.defineProperty(sheetListProto, Symbol.iterator, { value: Array.prototype.values, writable: true, enumerable: false, configurable: true });
    }

    TREE_FIELDS.styleSheets = function (doc) { return styleSheetsOf(doc); };
    if (shadowProto) {
      patchGetter(shadowProto, "styleSheets", function () {
        if (!stateOf(this) || !stateOf(this).shadow) throw typeError("Illegal invocation");
        return styleSheetsOf(this);
      });
    }

    // ---- Brand checks ----
    //
    // Chrome's node members refuse a receiver that is not one of its nodes (an object made from a
    // node prototype, the prototype itself) with "Illegal invocation" before anything else, as the
    // sandbox's own members must: they check the node's state, which only real nodes have.
    var brandChecked = function (holderName) {
      var holder = globalThis[holderName] && globalThis[holderName].prototype;
      if (!holder) return;
      Object.getOwnPropertyNames(holder).forEach(function (name) {
        if (name === "constructor") return;
        var descriptor = Object.getOwnPropertyDescriptor(holder, name);
        if (!descriptor || !descriptor.configurable) return;
        if (typeof descriptor.value === "function") {
          var method = descriptor.value;
          var checked = function () {
            if (!stateOf(this)) env.guard(holder, null, holderName + ".prototype." + name);
            return method.apply(this, arguments);
          };
          Object.defineProperty(checked, "length", { value: method.length, configurable: true });
          patch(holder, name, checked);
        } else if (descriptor.get) {
          var getter = descriptor.get;
          var setter = descriptor.set;
          try {
            Object.defineProperty(holder, name, {
              get: asNative(function () {
                if (!stateOf(this)) env.guard(holder, null, holderName + ".prototype." + name);
                return getter.call(this);
              }, "get " + name),
              set: setter ? asNative(function (value) {
                if (!stateOf(this)) env.guard(holder, null, holderName + ".prototype." + name);
                return setter.call(this, value);
              }, "set " + name) : undefined,
              enumerable: descriptor.enumerable,
              configurable: true,
            });
          } catch (error) {}
        }
      });
    };

    ["Node", "Element", "CharacterData", "Text", "DocumentFragment", "ShadowRoot", "Document", "HTMLElement", "Attr", "DocumentType"].forEach(brandChecked);

    env.ownerOf = ownerOf;
    env.isHTMLDocument = isHTMLDoc;
  })();

  // What the platform modules after this one (streams, messaging, elements, platform) build on.
  env.patch = patch;
  env.patchGetter = patchGetter;
  env.asNative = asNative;
  env.installShell = installShell;
  env.utf8Decode = utf8Decode;
  env.protoOf = protoOf;
  env.traits = traits;
  env.refuseUncloneable = refuseUncloneable;

  // The window's own self-references as Chrome's: `window` and `top` unforgeable getters, `self`,
  // `frames` and `parent` replaceable accessors, `document` and `location` unforgeable, and the
  // document's own unforgeable `location`. Run once every module has put its objects in place.
  env.finishWindow = function () {
    var values = {};
    ["window", "self", "frames", "top", "parent"].forEach(function (key) { values[key] = globalThis[key]; });

    var getter = function (key) { return asNative(function () { return values[key]; }, "get " + key); };
    var replaceable = function (key) {
      return asNative(function (value) {
        Object.defineProperty(globalThis, key, { value: value, writable: true, enumerable: true, configurable: true });
      }, "set " + key);
    };

    try {
      Object.defineProperty(globalThis, "window", { get: getter("window"), set: undefined, enumerable: true, configurable: false });
      Object.defineProperty(globalThis, "top", { get: getter("top"), set: undefined, enumerable: true, configurable: false });
      ["self", "frames", "parent"].forEach(function (key) {
        Object.defineProperty(globalThis, key, { get: getter(key), set: replaceable(key), enumerable: true, configurable: true });
      });
    } catch (error) {}

    ["document", "location"].forEach(function (key) {
      try {
        var held = Object.getOwnPropertyDescriptor(globalThis, key);
        if (held && held.configurable) Object.defineProperty(globalThis, key, { get: held.get, set: held.set, enumerable: held.enumerable, configurable: false });
      } catch (error) {}
    });

    try {
      var doc = globalThis.document;
      if (doc && !Object.getOwnPropertyDescriptor(doc, "location")) {
        Object.defineProperty(doc, "location", {
          get: asNative(function () { return globalThis.location; }, "get location"),
          set: asNative(function (value) { globalThis.location.href = value; }, "set location"),
          enumerable: true,
          configurable: false,
        });
      }
    } catch (error) {}
  };
})();
