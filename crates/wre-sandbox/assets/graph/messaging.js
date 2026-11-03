// Messaging in a window or frame, as Chrome runs it: structuredClone and postMessage with a real
// structured clone, MessageChannel and MessagePort, BroadcastChannel, the task scheduler
// (scheduler.postTask, TaskController), dedicated workers and the origin private file system.
// The realm-agnostic parts (the clone itself, port and broadcast plumbing) come from channels.js;
// worker.js uses the same parts inside a worker. Evaluated in every window and frame after dom.js.
(function () {
  var env = globalThis.__ENV;
  var factory = globalThis.__wreChannels;
  delete globalThis.__wreChannels;
  if (!env || typeof factory !== "function") return;

  var bridge = env.bridge;
  var shared = bridge.shared;
  var patch = env.patch;
  var patchGetter = env.patchGetter;
  var asNative = env.asNative;
  var hideFrames = env.hideFrames;

  var typeError = function (message) {
    return hideFrames(new TypeError(message));
  };

  var required = function (count, given, method, where) {
    if (given < count) {
      throw typeError("Failed to execute '" + method + "' on '" + where + "': " + count + " argument" + (count === 1 ? "" : "s") + " required, but only " + given + " present.");
    }
  };

  // This realm's origin. A frame on about:blank (or srcdoc) has the origin of the window that
  // made it, as Chrome gives it.
  var originOf = function () {
    try {
      var origin = String(globalThis.location.origin);
      if (origin === "null" && /^about:/.test(String(globalThis.location.href)) && bridge.referrer()) {
        var made = env.parseUrlText ? env.parseUrlText(bridge.referrer()) : null;
        if (made && made.origin) return made.origin;
      }
      return origin;
    } catch (error) {
      return "null";
    }
  };

  // The JavaScript intrinsics' prototypes: never a platform interface, whatever the graph made of
  // them (the capture records Object.prototype among its objects).
  var INTRINSIC = new Set();
  ["Object", "Function", "Array", "Number", "Boolean", "String", "Symbol", "Date", "Promise", "RegExp", "Error",
    "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "ArrayBuffer", "DataView",
    "Map", "Set", "WeakMap", "WeakSet", "BigInt"].forEach(function (name) {
    var holder = globalThis[name];
    if (typeof holder === "function" && holder.prototype) INTRINSIC.add(holder.prototype);
  });
  INTRINSIC.add(Object.getPrototypeOf(Uint8Array.prototype));

  // A platform object: one whose prototype chain holds an interface the capture recorded, or an
  // interface the sandbox itself presents as native.
  var isPlatform = function (value) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
    var current = value;
    for (var depth = 0; current && !INTRINSIC.has(current) && depth < 32; depth += 1) {
      if (env.isHost(current)) return true;
      try {
        var own = Object.getOwnPropertyDescriptor(current, "constructor");
        if (own && typeof own.value === "function" && env.sources.has(own.value) && own.value.prototype === current) return true;
      } catch (error) {}
      try {
        current = Object.getPrototypeOf(current);
      } catch (error) {
        return false;
      }
    }
    return false;
  };

  var brandOf = function (value) {
    var tag = Object.prototype.toString.call(value).slice(8, -1);
    return tag === "Object" && value.constructor && value.constructor.name ? value.constructor.name : tag;
  };

  var blobState = function (value) {
    var bytes = env.blobBytes ? env.blobBytes(value) : null;
    if (!bytes) return null;
    var state = { bytes: bytes, type: env.blobTypeOf(value) };
    if (globalThis.File && value instanceof globalThis.File) {
      state.name = value.name;
      state.lastModified = value.lastModified;
    }
    return state;
  };

  var messageEvent = function (target, type, fields) {
    var event = env.makeEvent(type, {
      data: fields.data === undefined ? null : fields.data,
      origin: fields.origin === undefined ? "" : fields.origin,
      lastEventId: "",
      source: fields.source === undefined ? null : fields.source,
      ports: fields.ports || Object.freeze([]),
    }, "MessageEvent");
    env.dispatch(target, event);
  };

  // Geometry and pixel objects travel by their public fields.
  var PLATFORM_CLONES = {
    ImageData: function (value) { return { width: value.width, height: value.height, data: new Uint8ClampedArray(value.data), colorSpace: value.colorSpace }; },
    DOMPoint: function (value) { return { x: value.x, y: value.y, z: value.z, w: value.w }; },
    DOMPointReadOnly: function (value) { return { x: value.x, y: value.y, z: value.z, w: value.w }; },
    DOMRect: function (value) { return { x: value.x, y: value.y, width: value.width, height: value.height }; },
    DOMRectReadOnly: function (value) { return { x: value.x, y: value.y, width: value.width, height: value.height }; },
  };

  var channels = factory({
    later: function (callback, ms) { env.later(callback, ms || 0); },
    shared: shared,
    origin: originOf,
    isPlatform: isPlatform,
    brandOf: brandOf,
    typeError: typeError,
    domException: function (message, name) { return env.domException(message, name); },
    blobState: blobState,
    makeBlob: function (bytes, type, file) { return env.makeBlob(bytes, type, file); },
    exceptionState: function (value) {
      var state = env.exceptionState && env.exceptionState.get(value);
      return state ? { name: state.name, message: state.message } : null;
    },
    makeDomException: function (message, name) { return new globalThis.DOMException(message, name); },
    serializePlatform: function (value) {
      var kind = brandOf(value);
      var read = PLATFORM_CLONES[kind];
      if (!read || typeof globalThis[kind] !== "function") return null;
      try {
        return { t: "platform", kind: kind, fields: read(value) };
      } catch (error) {
        return null;
      }
    },
    deserializePlatform: function (node) {
      var fields = node.fields;
      switch (node.kind) {
        case "ImageData": return new globalThis.ImageData(fields.data, fields.width, fields.height, { colorSpace: fields.colorSpace || "srgb" });
        case "DOMPoint":
        case "DOMPointReadOnly": return new globalThis[node.kind](fields.x, fields.y, fields.z, fields.w);
        default: return new globalThis[node.kind](fields.x, fields.y, fields.width, fields.height);
      }
    },
    makePort: function () { return Object.create(globalThis.MessagePort.prototype); },
    portEvent: function (port, data, ports) { messageEvent(port, "message", { data: data, ports: ports }); },
    portError: function (port) { messageEvent(port, "messageerror", {}); },
    broadcastEvent: function (channel, data, origin) { messageEvent(channel, "message", { data: data, origin: origin }); },
    broadcastError: function (channel, origin) { messageEvent(channel, "messageerror", { origin: origin }); },
  });

  env.channels = channels;

  // Event handler attributes this module owns (onmessage on ports, channels, workers...): each
  // holds its value per object and keeps its place among the listeners, as dom.js's do.
  var handlers = new WeakMap();

  var defineHandler = function (proto, name, onSet) {
    if (!proto) return;
    var type = name.slice(2);
    try {
      Object.defineProperty(proto, name, {
        get: asNative(function () {
          var own = handlers.get(this);
          return own && own[name] !== undefined ? own[name] : null;
        }, "get " + name),
        set: asNative(function (value) {
          var own = handlers.get(this);
          if (!own) {
            own = {};
            handlers.set(this, own);
          }
          own[name] = typeof value === "function" || (value !== null && typeof value === "object") ? value : null;
          env.handlerSet(this, type, own[name]);
          if (onSet) onSet(this, own[name]);
        }, "set " + name),
        enumerable: true,
        configurable: true,
      });
    } catch (error) {}
  };

  env.defineHandler = defineHandler;

  // Reads postMessage's (message, transfer) or (message, options) as Web IDL picks the overload.
  var transferOf = function (second, where) {
    if (second === undefined || second === null) return undefined;
    if (typeof second === "object" && typeof second[Symbol.iterator] === "function") return second;
    if (typeof second === "object" || typeof second === "function") return second.transfer;
    throw typeError("Failed to execute 'postMessage' on '" + where + "': The provided value cannot be converted to a sequence.");
  };

  // structuredClone(value, { transfer }).
  if (typeof globalThis.structuredClone === "function") {
    patch(globalThis, "structuredClone", function structuredClone(value, options) {
      required(1, arguments.length, "structuredClone", "Window");
      var transfer = options === undefined || options === null ? undefined : options.transfer;
      return channels.deserialize(channels.serialize(value, transfer, "Window", "structuredClone")).value;
    });
  }

  // window.postMessage(message, targetOrigin, transfer) and (message, { targetOrigin, transfer }).
  var readTarget = function (targetOrigin) {
    var origin = targetOrigin === undefined ? "/" : String(targetOrigin);
    if (origin === "*" || origin === "/") return origin;
    var parsed = env.parseUrlText ? env.parseUrlText(origin) : null;
    if (!parsed || !parsed.origin || parsed.origin === "null") {
      throw env.domException("Failed to execute 'postMessage' on 'Window': Invalid target origin '" + origin + "' in a call to 'postMessage'.", "SyntaxError");
    }
    return parsed.origin;
  };

  var readPost = function (args) {
    required(1, args.length, "postMessage", "Window");
    var second = args[1];
    if (second !== null && (typeof second === "object" || typeof second === "function")) {
      return { targetOrigin: readTarget(second.targetOrigin), transfer: second.transfer };
    }
    return { targetOrigin: readTarget(second === undefined ? "/" : second), transfer: args[2] };
  };

  // A message posted to this window, from `origin` and `source`: delivered as its own task.
  var receive = function (record, origin, source, targetOrigin) {
    env.later(function () {
      if (targetOrigin !== "*" && targetOrigin !== "/" && targetOrigin !== originOf()) return;
      var opened;
      try {
        opened = channels.deserialize(record);
      } catch (error) {
        messageEvent(globalThis, "messageerror", { origin: origin, source: source });
        return;
      }
      messageEvent(globalThis, "message", { data: opened.value, origin: origin, source: source, ports: Object.freeze(opened.ports) });
    }, 0);
  };

  patch(globalThis, "postMessage", function postMessage(message) {
    var read = readPost(arguments);
    var record = channels.serialize(message, read.transfer, "Window", "postMessage");
    env.record("selfMessage", { message: typeof message === "string" ? message : "[object]", origin: read.targetOrigin });
    receive(record, originOf(), globalThis, read.targetOrigin === "/" ? originOf() : read.targetOrigin);
  });

  // Messages arriving from elsewhere (a frame this window embeds, another frame): already plain
  // values in this realm's terms.
  env.deliverMessage = function (message, origin, source) {
    try {
      messageEvent(globalThis, "message", {
        data: message,
        origin: origin === "*" ? originOf() : origin,
        source: source === undefined ? null : source,
      });
    } catch (error) {
      env.record("messageError", { message: String(error && error.message) });
    }
  };

  env.receiveMessage = receive;

  // The frames this window embeds post to it through here.
  if (typeof bridge.adoptFrames === "function") {
    bridge.adoptFrames(function (record, origin, source, targetOrigin) {
      if (record && record.root) receive(record, origin, source, targetOrigin || "*");
      else env.later(function () { env.deliverMessage(record, origin, source); }, 0);
    });
  }

  // In a frame, `parent` is the window embedding it: its postMessage carries the clone there.
  var parentWindow = globalThis.parent;
  if (parentWindow && parentWindow !== globalThis) {
    patch(parentWindow, "postMessage", function postMessage(message) {
      var read = readPost(arguments);
      var record = channels.serialize(message, read.transfer, "Window", "postMessage");
      env.record("postMessage", { message: typeof message === "string" ? message : "[object]", origin: read.targetOrigin });
      if (typeof env.toEmbedder === "function") env.toEmbedder(record, originOf(), globalThis, read.targetOrigin === "/" ? originOf() : read.targetOrigin);
    });
  }

  // MessageChannel and MessagePort.
  var channelPorts = new WeakMap();

  if (typeof globalThis.MessageChannel === "function" && typeof globalThis.MessagePort === "function") {
    env.installShell("MessageChannel", function () {
      var made = Object.create(globalThis.MessageChannel.prototype);
      channelPorts.set(made, channels.channel());
      return made;
    }, 0);

    var portsOf = function (holder) {
      var pair = channelPorts.get(holder);
      if (!pair) throw typeError("Illegal invocation");
      return pair;
    };

    patchGetter(globalThis.MessageChannel.prototype, "port1", function () { return portsOf(this)[0]; });
    patchGetter(globalThis.MessageChannel.prototype, "port2", function () { return portsOf(this)[1]; });

    env.installShell("MessagePort", function () { return null; }, 0, { illegal: true });

    var portProto = globalThis.MessagePort.prototype;

    var checkPort = function (port) {
      if (!channels.isPort(port)) throw typeError("Illegal invocation");
    };

    patch(portProto, "postMessage", function postMessage(message, transfer) {
      checkPort(this);
      required(1, arguments.length, "postMessage", "MessagePort");
      channels.portPost(this, message, transferOf(transfer, "MessagePort"));
    });
    patch(portProto, "start", function start() {
      checkPort(this);
      channels.portStart(this);
    });
    patch(portProto, "close", function close() {
      checkPort(this);
      channels.portClose(this);
    });

    // Setting onmessage starts the port (addEventListener does not; that needs start()).
    defineHandler(portProto, "onmessage", function (port, value) {
      if (value) channels.portStart(port);
    });
    defineHandler(portProto, "onmessageerror");
  }

  // BroadcastChannel.
  if (typeof globalThis.BroadcastChannel === "function") {
    env.installShell("BroadcastChannel", function (args) {
      var made = Object.create(globalThis.BroadcastChannel.prototype);
      channels.openBroadcast(made, args[0]);
      return made;
    }, 1, { required: 1 });

    var broadcastProto = globalThis.BroadcastChannel.prototype;

    var entryOf = function (holder) {
      var entry = channels.broadcastState(holder);
      if (!entry) throw typeError("Illegal invocation");
      return entry;
    };

    patchGetter(broadcastProto, "name", function () { return entryOf(this).name; });
    patch(broadcastProto, "postMessage", function postMessage(message) {
      entryOf(this);
      required(1, arguments.length, "postMessage", "BroadcastChannel");
      channels.broadcastPost(this, message);
    });
    patch(broadcastProto, "close", function close() {
      entryOf(this);
      channels.broadcastClose(this);
    });
    defineHandler(broadcastProto, "onmessage");
    defineHandler(broadcastProto, "onmessageerror");
  }

  // The prioritized task scheduler: scheduler.postTask/yield and TaskController/TaskSignal.
  (function installScheduler() {
    var Scheduler = globalThis.Scheduler;
    var Controller = globalThis.TaskController;
    var Signal = globalThis.TaskSignal;
    if (typeof Scheduler !== "function" || !globalThis.scheduler) return;

    var PRIORITIES = ["user-blocking", "user-visible", "background"];
    // Continuations (scheduler.yield) run ahead of tasks of their priority.
    var RANK = { "user-blocking-continuation": 0, "user-blocking": 1, "user-visible-continuation": 2, "user-visible": 3, "background-continuation": 4, "background": 5 };
    var queue = [];
    var sequence = 0;
    var taskState = new WeakMap();

    // Each queued task has one runner task; one taken out by an abort leaves its runner idle.
    var idleRunners = 0;

    var runOne = function () {
      if (idleRunners > 0) {
        idleRunners -= 1;
        return;
      }
      if (!queue.length) return;
      var best = 0;
      for (var index = 1; index < queue.length; index += 1) {
        var a = queue[index];
        var b = queue[best];
        if (RANK[a.rank()] < RANK[b.rank()] || (RANK[a.rank()] === RANK[b.rank()] && a.order < b.order)) best = index;
      }
      var task = queue.splice(best, 1)[0];
      task.run();
    };

    var enqueue = function (task, delay) {
      var start = function () {
        if (task.cancelled) return;
        task.order = sequence++;
        queue.push(task);
        env.later(runOne, 0);
      };
      if (delay > 0) env.later(start, delay);
      else start();
    };

    var readPriority = function (value, method) {
      var text = String(value);
      if (PRIORITIES.indexOf(text) === -1) {
        throw typeError("Failed to execute '" + method + "' on 'Scheduler': Failed to read the 'priority' property from 'SchedulerPostTaskOptions': The provided value '" + text + "' is not a valid enum value of type TaskPriority.");
      }
      return text;
    };

    var signalPriority = function (signal) {
      var held = signal && taskState.get(signal);
      return held ? held.priority : null;
    };

    patch(Scheduler.prototype, "postTask", function postTask(callback, options) {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (typeof callback !== "function") {
          reject(typeError("Failed to execute 'postTask' on 'Scheduler': parameter 1 is not of type 'Function'."));
          return;
        }
        var opts = options === undefined || options === null ? {} : options;
        var fixed = opts.priority === undefined ? null : readPriority(opts.priority, "postTask");
        var signal = opts.signal;
        var delay = Math.max(0, Number(opts.delay) || 0);
        var abortState = signal && env.signalState.get(signal);

        if (abortState && abortState.aborted) {
          reject(abortState.reason);
          return;
        }

        var task = {
          cancelled: false,
          rank: function () { return fixed || signalPriority(signal) || "user-visible"; },
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

        if (abortState) {
          abortState.algorithms.push(function () {
            if (task.cancelled) return;
            task.cancelled = true;
            var at = queue.indexOf(task);
            if (at !== -1) {
              queue.splice(at, 1);
              idleRunners += 1;
            }
            reject(abortState.reason);
          });
        }

        void self;
        enqueue(task, delay);
      });
    });

    patch(Scheduler.prototype, "yield", function () {
      return new Promise(function (resolve) {
        enqueue({ cancelled: false, rank: function () { return "user-visible-continuation"; }, run: function () { resolve(undefined); } }, 0);
      });
    });

    if (typeof Controller !== "function" || typeof Signal !== "function" || !env.abortControllers) return;

    var makeTaskSignal = function (priority) {
      var signal = env.makeSignal();
      Object.setPrototypeOf(signal, Signal.prototype);
      taskState.set(signal, { priority: priority, changing: false });
      return signal;
    };

    env.installShell("TaskController", function (args) {
      var init = args[0];
      var priority = init === undefined || init === null || init.priority === undefined ? "user-visible" : String(init.priority);
      if (PRIORITIES.indexOf(priority) === -1) {
        throw typeError("Failed to construct 'TaskController': Failed to read the 'priority' property from 'TaskControllerInit': The provided value '" + priority + "' is not a valid enum value of type TaskPriority.");
      }
      var made = Object.create(Controller.prototype);
      env.abortControllers.set(made, makeTaskSignal(priority));
      return made;
    }, 0);

    patch(Controller.prototype, "setPriority", function setPriority(priority) {
      var signal = env.abortControllers.get(this);
      var held = signal && taskState.get(signal);
      if (!held) throw typeError("Illegal invocation");
      required(1, arguments.length, "setPriority", "TaskController");
      var next = String(priority);
      if (PRIORITIES.indexOf(next) === -1) {
        throw typeError("Failed to execute 'setPriority' on 'TaskController': The provided value '" + next + "' is not a valid enum value of type TaskPriority.");
      }
      if (held.changing) throw env.domException("Failed to execute 'setPriority' on 'TaskController': Cannot change the priority of a TaskSignal while a prioritychange event is being dispatched.", "NotAllowedError");
      if (held.priority === next) return;
      var previous = held.priority;
      held.priority = next;
      held.changing = true;
      try {
        env.dispatch(signal, env.makeEvent("prioritychange", { previousPriority: previous }, "TaskPriorityChangeEvent"));
      } finally {
        held.changing = false;
      }
    });

    patchGetter(Signal.prototype, "priority", function () {
      var held = taskState.get(this);
      if (!held) throw typeError("Illegal invocation");
      return held.priority;
    });
    defineHandler(Signal.prototype, "onprioritychange");

    var SignalShell = env.installShell("TaskSignal", function () { return null; }, 0, { illegal: true });

    if (SignalShell) {
      patch(SignalShell, "any", function any(signals, init) {
        required(1, arguments.length, "any", "TaskSignal");
        var source = init && init.priority !== undefined ? init.priority : undefined;
        var priority = typeof source === "string" ? readPriority(source, "any") : source && taskState.has(source) ? taskState.get(source).priority : "user-visible";
        var made = makeTaskSignal(priority);
        var list = Array.from(signals);
        for (var index = 0; index < list.length; index += 1) {
          var state = env.signalState.get(list[index]);
          if (state && state.aborted) {
            env.abortSignal(made, state.reason);
            return made;
          }
        }
        list.forEach(function (input) {
          var state = env.signalState.get(input);
          if (state) state.algorithms.push(function () { env.abortSignal(made, state.reason); });
        });
        return made;
      });
    }

    if (typeof globalThis.TaskPriorityChangeEvent === "function") {
      env.installShell("TaskPriorityChangeEvent", function (args) {
        var init = args[1];
        if (init === undefined || init === null || init.previousPriority === undefined) {
          throw typeError("Failed to construct 'TaskPriorityChangeEvent': Failed to read the 'previousPriority' property from 'TaskPriorityChangeEventInit': Required member is undefined.");
        }
        return env.createEvent("TaskPriorityChangeEvent", args[0], init, false);
      }, 2, { required: 2 });
    }
  })();

  // Dedicated workers. Constructing one checks its URL and takes its script (a blob: URL's bytes
  // at once, as Chrome does, so revoking the URL afterwards is harmless); the host then opens the
  // worker's own realm between tasks (Graph::start_workers), which this realm binds and pumps.
  var DATA_URL = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i;

  var decodeDataUrl = function (href) {
    var match = DATA_URL.exec(href);
    if (!match) return null;
    if (match[2]) {
      try {
        return globalThis.atob(decodeURIComponent(match[3]).replace(/\s/g, ""));
      } catch (error) {
        return null;
      }
    }
    try {
      return env.decodeUtf8(env.utf8Encode(decodeURIComponent(match[3])));
    } catch (error) {
      return null;
    }
  };

  var latin1Bytes = function (text) {
    var bytes = new Uint8Array(text.length);
    for (var index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 255;
    return bytes;
  };

  // What a worker's realm reads from the page: its navigator, client hints, storage, origin.
  var workerFacts = function (href, name, origin) {
    var navigator = globalThis.navigator;
    var data = navigator.userAgentData;
    var traits = env.traits || {};
    var read = function (field) {
      try {
        return navigator[field];
      } catch (error) {
        return undefined;
      }
    };
    return {
      url: href,
      name: name,
      origin: origin,
      parentSecure: Boolean(globalThis.isSecureContext),
      originTime: Date.now(),
      navigator: {
        hardwareConcurrency: read("hardwareConcurrency"),
        appCodeName: read("appCodeName"),
        appName: read("appName"),
        appVersion: read("appVersion"),
        platform: read("platform"),
        product: read("product"),
        userAgent: read("userAgent"),
        language: read("language"),
        languages: Array.prototype.slice.call(read("languages") || []),
        onLine: read("onLine"),
        deviceMemory: read("deviceMemory"),
      },
      uaData: {
        brands: data ? Array.prototype.map.call(data.brands, function (item) { return { brand: item.brand, version: item.version }; }) : [],
        mobile: data ? Boolean(data.mobile) : false,
        platform: data ? String(data.platform) : "",
        highEntropy: traits.highEntropy || null,
      },
      estimate: function () { return navigator.storage.estimate(); },
    };
  };

  (function installWorker() {
    var Worker = globalThis.Worker;
    if (typeof Worker !== "function") return;

    var workerState = new WeakMap();

    var stateOf = function (holder) {
      var state = workerState.get(holder);
      if (!state) throw typeError("Illegal invocation");
      return state;
    };

    env.installShell("Worker", function (args) {
      var given = args[0];
      var options = args[1] === undefined || args[1] === null ? {} : args[1];
      var ours = originOf();
      var parsed = bridge.parseUrl(String(given), globalThis.location.href);
      if (!parsed) throw env.domException("Failed to construct 'Worker': '" + String(given) + "' is not a valid URL.", "SyntaxError");
      var href = parsed.href;
      var scheme = parsed.protocol;
      var blobOrigin = scheme === "blob:" ? parsed.origin : null;
      var allowed = scheme === "data:" || (scheme === "blob:" ? blobOrigin === ours : (scheme === "http:" || scheme === "https:") && parsed.origin === ours);
      if (!allowed) {
        throw env.domException("Failed to construct 'Worker': Script at '" + href + "' cannot be accessed from origin '" + ours + "'.", "SecurityError");
      }

      var made = Object.create(Worker.prototype);
      var state = { control: null, pending: [], dead: false };
      workerState.set(made, state);

      var fail = function () {
        env.later(function () {
          if (!state.dead) env.dispatch(made, env.makeEvent("error", {}));
        }, 0);
      };

      var request = {
        id: shared.nextWorker = (shared.nextWorker || 0) + 1,
        ready: false,
        cancelled: false,
        url: href,
        source: null,
        bind: function (slot, kit) {
          if (state.dead) return null;
          var facts = workerFacts(href, options.name === undefined ? "" : String(options.name), scheme === "data:" ? "null" : ours);
          state.control = slot.bind(facts, kit, {
            message: function (record) {
              env.later(function () {
                if (state.dead) return;
                var opened;
                try {
                  opened = channels.deserialize(record);
                } catch (error) {
                  messageEvent(made, "messageerror", {});
                  return;
                }
                messageEvent(made, "message", { data: opened.value, ports: Object.freeze(opened.ports) });
              }, 0);
            },
            error: function (info) {
              env.later(function () {
                if (state.dead) return;
                env.dispatch(made, env.makeEvent("error", {
                  message: info.message, filename: info.filename, lineno: info.lineno, colno: info.colno, error: null, cancelable: true,
                }, "ErrorEvent"));
              }, 0);
            },
            closed: function () {
              state.dead = true;
              if (state.control) bridge.releaseWorker(state.control);
            },
          });
          bridge.adoptWorker(state.control);
          return state.control;
        },
        started: function () {
          if (!state.control) return;
          state.control.started();
          state.pending.forEach(function (record) { state.control.post(record); });
          state.pending = [];
        },
      };
      state.request = request;

      if (scheme === "blob:") {
        var blob = env.objectUrls ? env.objectUrls.get(href) : null;
        var bytes = blob ? env.blobBytes(blob) : null;
        if (!bytes) {
          fail();
          return made;
        }
        request.source = env.decodeUtf8(bytes);
        request.ready = true;
      } else if (scheme === "data:") {
        var text = decodeDataUrl(href);
        if (text === null) {
          fail();
          return made;
        }
        request.source = /;base64,/i.test(href) ? env.decodeUtf8(latin1Bytes(text)) : text;
        request.ready = true;
      } else {
        bridge.request("GET", href, JSON.stringify({ accept: "*/*" }), null, function (status, headers, body) {
          if (state.dead) return;
          if (status < 200 || status > 299) {
            request.cancelled = true;
            env.dispatch(made, env.makeEvent("error", {}));
            return;
          }
          request.source = body;
          request.ready = true;
        });
      }

      shared.workers.push(request);
      return made;
    }, 1, { required: 1 });

    var proto = Worker.prototype;

    patch(proto, "postMessage", function postMessage(message, transfer) {
      var state = stateOf(this);
      required(1, arguments.length, "postMessage", "Worker");
      var record = channels.serialize(message, transferOf(transfer, "Worker"), "Worker", "postMessage");
      if (state.dead) return;
      if (state.control) state.control.post(record);
      else state.pending.push(record);
    });

    patch(proto, "terminate", function terminate() {
      var state = stateOf(this);
      if (state.dead) return;
      state.dead = true;
      state.request.cancelled = true;
      if (state.control) {
        state.control.terminate();
        bridge.releaseWorker(state.control);
      }
    });

    defineHandler(proto, "onmessage");
    defineHandler(proto, "onerror");
  })();

  // The origin private file system: navigator.storage.getDirectory() and its handles (the
  // entries themselves live in channels.js, shared with workers). A window has no sync access
  // handles; FileSystemWritableFileStream writes to a scratch copy committed on close.
  (function installFileSystem() {
    var Storage = globalThis.StorageManager;
    var Directory = globalThis.FileSystemDirectoryHandle;
    var FileHandle = globalThis.FileSystemFileHandle;
    var Handle = globalThis.FileSystemHandle;
    var Writable = globalThis.FileSystemWritableFileStream;
    if (typeof Storage !== "function" || typeof Directory !== "function" || typeof FileHandle !== "function") return;

    var opfs = channels.opfs;

    channels.useHooks({
      makeHandle: function (kind) { return Object.create((kind === "directory" ? Directory : FileHandle).prototype); },
      // A file's writable stream is a WritableStream (streams.js) whose sink writes the scratch copy.
      makeWritable: function (scratch, commit) {
        var made = new globalThis.WritableStream({
          write: function (chunk) { opfs.writeChunk(scratch, chunk); },
          close: function () {
            scratch.closed = true;
            commit();
          },
          abort: function () { scratch.closed = true; },
        });
        Object.setPrototypeOf(made, Writable.prototype);
        return made;
      },
      asyncIteratorProto: Object.getPrototypeOf(Object.getPrototypeOf((async function* () {})())),
    });

    patch(Storage.prototype, "getDirectory", function getDirectory() { return opfs.root(); });

    patchGetter(Handle.prototype, "kind", function () { return opfs.handle_kind.call(this); });
    patchGetter(Handle.prototype, "name", function () { return opfs.handle_name.call(this); });
    ["isSameEntry", "queryPermission", "requestPermission", "remove"].forEach(function (name) {
      if (typeof Handle.prototype[name] === "function") patch(Handle.prototype, name, opfs[name]);
    });
    ["getFileHandle", "getDirectoryHandle", "removeEntry", "resolve", "entries", "keys", "values"].forEach(function (name) {
      patch(Directory.prototype, name, opfs[name]);
    });
    try {
      Object.defineProperty(Directory.prototype, Symbol.asyncIterator, { value: Directory.prototype.entries, writable: true, enumerable: false, configurable: true });
    } catch (error) {}
    ["getFile", "createWritable", "move"].forEach(function (name) {
      if (typeof FileHandle.prototype[name] === "function") patch(FileHandle.prototype, name, opfs[name]);
    });

    // write/seek/truncate go through the stream as a writer would, so they queue behind earlier
    // writes and fail once the stream is closed or locked.
    if (typeof Writable === "function") {
      var through = function (stream, chunk) {
        var writer = globalThis.WritableStream.prototype.getWriter.call(stream);
        try {
          return writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
      };
      patch(Writable.prototype, "write", function write(data) { return through(this, data); });
      patch(Writable.prototype, "seek", function seek(position) { return through(this, { type: "seek", position: position }); });
      patch(Writable.prototype, "truncate", function truncate(size) { return through(this, { type: "truncate", size: size }); });
    }
  })();
})();
