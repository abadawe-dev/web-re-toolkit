// Messaging that works the same in a window, a frame and a worker: the structured clone (HTML's
// StructuredSerializeWithTransfer / StructuredDeserialize), message ports and broadcast channels.
// Every realm evaluates its own copy, so what a copy builds (Dates, Maps, arrays...) uses that
// realm's intrinsics; a message crosses realms as a serialized record, never as an object.
//
// Evaluating this file leaves `globalThis.__wreChannels`, a factory the realm's own platform code
// (messaging.js in a window or frame, worker.js in a worker) takes and deletes at once:
//
//   var channels = __wreChannels(hooks)
//
// where `hooks` tells it about the realm:
//   later(fn, ms)             queue a task in this realm
//   shared                    the object every realm of the page shares (bridge.shared)
//   origin()                  this realm's origin, as messages carry it
//   isPlatform(value)         whether value is a platform object (not a JS one)
//   brandOf(value)            a platform object's interface name ("Navigator")
//   domException(msg, name)   a DOMException the platform throws
//   blobState(value)          { bytes, type, name?, lastModified? } for a Blob/File, else null
//   makeBlob(bytes, type, file)
//   exceptionState(value)     { name, message } for a DOMException, else null
//   makeDomException(msg, name)
//   makePort()                a new MessagePort object of this realm (state lives here)
//   portEvent(port, record)   deliver a deserialized message at `port` (fires "message")
//   broadcastEvent(channel, data, origin)
//   reportException(error)
(function () {
  var nativeToString = Object.prototype.toString;
  var hasOwn = Object.prototype.hasOwnProperty;
  var getProto = Object.getPrototypeOf;
  var ownKeys = Reflect.ownKeys;
  var describe = Object.getOwnPropertyDescriptor;
  var ArrayBufferProto = ArrayBuffer.prototype;
  var byteLengthOf = describe(ArrayBufferProto, "byteLength").get;
  var detachedOf = describe(ArrayBufferProto, "detached") ? describe(ArrayBufferProto, "detached").get : null;
  var resizableOf = describe(ArrayBufferProto, "resizable") ? describe(ArrayBufferProto, "resizable").get : null;
  var maxByteLengthOf = describe(ArrayBufferProto, "maxByteLength") ? describe(ArrayBufferProto, "maxByteLength").get : null;
  var transferBuffer = ArrayBufferProto.transfer;
  var TypedArray = getProto(Uint8Array);
  var typedName = describe(TypedArray.prototype, Symbol.toStringTag).get;
  var typedBuffer = describe(TypedArray.prototype, "buffer").get;
  var typedOffset = describe(TypedArray.prototype, "byteOffset").get;
  var typedLength = describe(TypedArray.prototype, "length").get;
  var viewBuffer = describe(DataView.prototype, "buffer").get;
  var viewOffset = describe(DataView.prototype, "byteOffset").get;
  var viewLength = describe(DataView.prototype, "byteLength").get;
  var dateValue = Date.prototype.getTime;
  var regexpSource = describe(RegExp.prototype, "source").get;
  var regexpFlags = describe(RegExp.prototype, "flags").get;
  var mapEntries = Map.prototype.entries;
  var setValues = Set.prototype.values;
  var numberValue = Number.prototype.valueOf;
  var stringValue = String.prototype.valueOf;
  var booleanValue = Boolean.prototype.valueOf;
  var bigintValue = BigInt.prototype.valueOf;
  var isArray = Array.isArray;
  var SharedBuffer = typeof SharedArrayBuffer === "function" ? SharedArrayBuffer : null;

  // The typed array kinds this realm has (a page's graph may lack some, as its capture did).
  var VIEWS = {};
  ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
    "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"].forEach(function (name) {
    if (typeof globalThis[name] === "function") VIEWS[name] = globalThis[name];
  });

  var ERRORS = {};
  ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError"].forEach(function (name) {
    if (typeof globalThis[name] === "function") ERRORS[name] = globalThis[name];
  });

  // The brand V8 reads for a JS object (its internal class), not its Symbol.toStringTag.
  var classOf = function (value) {
    try {
      if (isArray(value)) return "Array";
      dateValue.call(value);
      return "Date";
    } catch (notDate) {}

    var probes = [
      ["RegExp", function () { regexpSource.call(value); }],
      ["Map", function () { Map.prototype.has.call(value, undefined); }],
      ["Set", function () { Set.prototype.has.call(value, undefined); }],
      ["ArrayBuffer", function () { byteLengthOf.call(value); }],
      ["DataView", function () { viewBuffer.call(value); }],
      ["TypedArray", function () { if (typedName.call(value) === undefined) throw 0; }],
      ["Number", function () { numberValue.call(value); }],
      ["String", function () { stringValue.call(value); }],
      ["Boolean", function () { booleanValue.call(value); }],
      ["BigInt", function () { bigintValue.call(value); }],
      ["WeakMap", function () { WeakMap.prototype.has.call(value, {}); }],
      ["WeakSet", function () { WeakSet.prototype.has.call(value, {}); }],
      ["Promise", function () { Promise.prototype.then.call(value, undefined, undefined); }],
    ];

    if (SharedBuffer) {
      try {
        describe(SharedBuffer.prototype, "byteLength").get.call(value);
        return "SharedArrayBuffer";
      } catch (notShared) {}
    }

    for (var index = 0; index < probes.length; index += 1) {
      try {
        probes[index][1]();
        return probes[index][0];
      } catch (notIt) {}
    }

    if (typeof WeakRef === "function") {
      try {
        WeakRef.prototype.deref.call(value);
        return "WeakRef";
      } catch (notWeakRef) {}
    }

    if (value instanceof Error || nativeToString.call(value) === "[object Error]") {
      // An Error object (V8's JSError): its own [[ErrorData]] is not observable, so trust the
      // prototype chain and the brand, as a page cannot forge either without also being an Error.
      return "Error";
    }

    return "Object";
  };

  globalThis.__wreChannels = function (hooks) {
    var labelFor = function (value) {
      var kind = typeof value;
      if (kind === "function") return Function.prototype.toString.call(value);
      if (kind === "symbol") return String(value);
      if (value === globalThis || nativeToString.call(value) === "[object Window]") return "#<Window>";
      if (hooks.isPlatform(value)) return hooks.brandOf(value) + " object";
      var brand = classOf(value);
      var name = brand === "Object" ? "Object" : brand;
      try {
        if (brand === "Object" && value.constructor && typeof value.constructor.name === "string" && value.constructor.name) name = value.constructor.name;
      } catch (ignored) {}
      return "#<" + name + ">";
    };

    var refuse = function (value, where, method) {
      throw hooks.domException("Failed to execute '" + method + "' on '" + where + "': " + labelFor(value) + " could not be cloned.", "DataCloneError");
    };

    var detached = function (buffer) {
      if (detachedOf) return detachedOf.call(buffer);
      return false;
    };

    // Reads a transfer list as Web IDL's sequence<object> conversion does, then checks it as
    // StructuredSerializeWithTransfer does: no duplicates, no detached buffers, no source port.
    var readTransfer = function (transfer, where, method, source) {
      if (transfer === undefined) return { buffers: [], ports: [] };
      if (transfer === null || (typeof transfer !== "object" && typeof transfer !== "function") || typeof transfer[Symbol.iterator] !== "function") {
        throw hooks.typeError("Failed to execute '" + method + "' on '" + where + "': The provided value cannot be converted to a sequence.");
      }

      var buffers = [];
      var ports = [];
      var list = Array.from(transfer);

      for (var index = 0; index < list.length; index += 1) {
        var item = list[index];

        if (item !== null && typeof item === "object" && portState.has(item)) {
          if (ports.indexOf(item) !== -1) {
            throw hooks.domException("Failed to execute '" + method + "' on '" + where + "': Message port at index " + index + " is a duplicate of an earlier port.", "DataCloneError");
          }
          if (source !== undefined && item === source) {
            throw hooks.domException("Failed to execute '" + method + "' on '" + where + "': Port at index " + index + " contains the source port.", "DataCloneError");
          }
          var held = portState.get(item);
          if (!held.core || held.core.closedForever) {
            throw hooks.domException("Failed to execute '" + method + "' on '" + where + "': Port at index " + index + " is already neutered.", "DataCloneError");
          }
          ports.push(item);
          continue;
        }

        var isBuffer = false;
        try {
          byteLengthOf.call(item);
          isBuffer = true;
        } catch (notBuffer) {}

        if (isBuffer) {
          if (buffers.indexOf(item) !== -1) {
            throw hooks.domException("Failed to execute '" + method + "' on '" + where + "': ArrayBuffer at index " + index + " is a duplicate of an earlier ArrayBuffer.", "DataCloneError");
          }
          if (detached(item)) {
            throw hooks.domException("Failed to execute '" + method + "' on '" + where + "': ArrayBuffer at index " + index + " is already detached.", "DataCloneError");
          }
          buffers.push(item);
          continue;
        }

        throw hooks.typeError("Failed to execute '" + method + "' on '" + where + "': Value at index " + index + " does not have a transferable type.");
      }

      return { buffers: buffers, ports: ports };
    };

    var bytesOfBuffer = function (buffer, start, length) {
      return new Uint8Array(buffer, start || 0, length === undefined ? byteLengthOf.call(buffer) - (start || 0) : length).slice();
    };

    // StructuredSerializeWithTransfer: the record a message travels as.
    var serialize = function (value, transfer, where, method, source) {
      var moving = readTransfer(transfer, where, method, source);
      var memory = new Map();
      var next = 0;

      moving.buffers.forEach(function (buffer) {
        memory.set(buffer, { t: "ab", id: next++, transferred: true, buffer: buffer });
      });
      moving.ports.forEach(function (port) {
        memory.set(port, { t: "port", id: next++ });
      });

      var walk = function (input) {
        if (input === undefined) return { t: "u" };
        if (input === null) return { t: "l" };

        switch (typeof input) {
          case "boolean": return { t: "b", v: input };
          case "number": return { t: "n", v: input };
          case "string": return { t: "s", v: input };
          case "bigint": return { t: "z", v: input };
          case "symbol":
          case "function":
            refuse(input, where, method);
        }

        if (memory.has(input)) {
          var seen = memory.get(input);
          if (seen.t === "ab" && seen.transferred && !seen.placed) {
            seen.placed = true;
            return seen;
          }
          if (seen.t === "port" && !seen.placed) {
            seen.placed = true;
            return seen;
          }
          return { t: "ref", id: seen.id };
        }

        if (input === globalThis) refuse(input, where, method);

        var blob = hooks.blobState(input);
        if (blob) {
          var node = { t: "blob", id: next++, bytes: blob.bytes, type: blob.type };
          if (blob.name !== undefined) node.file = { name: blob.name, lastModified: blob.lastModified };
          memory.set(input, node);
          return node;
        }

        var exception = hooks.exceptionState(input);
        if (exception) {
          var thrown = { t: "dx", id: next++, name: exception.name, message: exception.message };
          memory.set(input, thrown);
          return thrown;
        }

        if (hooks.isPlatform(input)) {
          var platform = hooks.serializePlatform ? hooks.serializePlatform(input) : null;
          if (!platform) refuse(input, where, method);
          platform.id = next++;
          memory.set(input, platform);
          return platform;
        }

        var brand = classOf(input);
        var out;

        switch (brand) {
          case "Number": out = { t: "w", id: next++, kind: "Number", v: numberValue.call(input) }; break;
          case "String": out = { t: "w", id: next++, kind: "String", v: stringValue.call(input) }; break;
          case "Boolean": out = { t: "w", id: next++, kind: "Boolean", v: booleanValue.call(input) }; break;
          case "BigInt": out = { t: "w", id: next++, kind: "BigInt", v: bigintValue.call(input) }; break;
          case "Date": out = { t: "d", id: next++, v: dateValue.call(input) }; break;
          case "RegExp": out = { t: "r", id: next++, source: regexpSource.call(input), flags: regexpFlags.call(input) }; break;
          case "ArrayBuffer": {
            if (detached(input)) {
              throw hooks.domException("Failed to execute '" + method + "' on '" + where + "': An ArrayBuffer is detached and could not be cloned.", "DataCloneError");
            }
            out = { t: "ab", id: next++, bytes: bytesOfBuffer(input) };
            if (resizableOf && resizableOf.call(input)) out.max = maxByteLengthOf.call(input);
            break;
          }
          case "SharedArrayBuffer":
            throw hooks.domException("Failed to execute '" + method + "' on '" + where + "': #<SharedArrayBuffer> could not be cloned.", "DataCloneError");
          case "TypedArray":
          case "DataView": {
            out = brand === "DataView"
              ? { t: "v", id: next++, kind: "DataView", offset: viewOffset.call(input), length: viewLength.call(input) }
              : { t: "v", id: next++, kind: typedName.call(input), offset: typedOffset.call(input), length: typedLength.call(input) };
            memory.set(input, out);
            out.buffer = walk(brand === "DataView" ? viewBuffer.call(input) : typedBuffer.call(input));
            return out;
          }
          case "Map": {
            out = { t: "m", id: next++, entries: [] };
            memory.set(input, out);
            var pairs = [];
            for (var pair of mapEntries.call(input)) pairs.push(pair);
            for (var at = 0; at < pairs.length; at += 1) out.entries.push([walk(pairs[at][0]), walk(pairs[at][1])]);
            return out;
          }
          case "Set": {
            out = { t: "S", id: next++, values: [] };
            memory.set(input, out);
            var items = [];
            for (var item of setValues.call(input)) items.push(item);
            for (var spot = 0; spot < items.length; spot += 1) out.values.push(walk(items[spot]));
            return out;
          }
          case "Error": {
            out = { t: "e", id: next++ };
            memory.set(input, out);
            var name = input.name;
            out.name = typeof name === "string" && hasOwn.call(ERRORS, name) ? name : "Error";
            var message = describe(input, "message");
            if (message && "value" in message) out.message = String(message.value);
            var stack = describe(input, "stack");
            if (stack) {
              var stackValue = "value" in stack ? stack.value : input.stack;
              if (typeof stackValue === "string") out.stack = stackValue;
            }
            if (describe(input, "cause")) out.cause = walk(input.cause);
            return out;
          }
          case "WeakMap":
          case "WeakSet":
          case "WeakRef":
          case "Promise":
            refuse(input, where, method);
        }

        if (out) {
          memory.set(input, out);
          return out;
        }

        if (brand !== "Array" && brand !== "Object") refuse(input, where, method);

        var proxied = false;
        try {
          proxied = hooks.isProxy ? hooks.isProxy(input) : false;
        } catch (ignored) {}
        if (proxied) refuse(input, where, method);

        out = brand === "Array" ? { t: "a", id: next++, length: input.length, props: [] } : { t: "o", id: next++, props: [] };
        memory.set(input, out);

        var keys = Object.keys(input);
        for (var index = 0; index < keys.length; index += 1) {
          var key = keys[index];
          if (!hasOwn.call(input, key)) continue;
          var entry = describe(input, key);
          if (!entry || !entry.enumerable) continue;
          out.props.push([key, walk(input[key])]);
        }

        return out;
      };

      var root = walk(value);

      // Transferred buffers are detached and their bytes move with the record; transferred ports
      // move their channel end.
      var buffers = [];
      memory.forEach(function (node, original) {
        if (node.t === "ab" && node.transferred) {
          var moved = typeof transferBuffer === "function" ? transferBuffer.call(original) : original.slice(0);
          node.bytes = new Uint8Array(moved).slice();
          node.buffer = undefined;
          buffers.push(node);
        }
      });

      var ports = [];
      moving.ports.forEach(function (port) {
        var node = memory.get(port);
        var held = portState.get(port);
        node.core = held.core;
        detachPort(port);
        ports.push(node);
      });

      return { root: root, ports: ports };
    };

    // StructuredDeserialize, in this realm. `ports` are the MessagePorts it carried, in order.
    var deserialize = function (record) {
      var made = new Map();
      var ports = [];

      var portFor = function (node) {
        if (made.has(node.id)) return made.get(node.id);
        var port = adoptPort(node.core);
        made.set(node.id, port);
        return port;
      };

      var build = function (node) {
        switch (node.t) {
          case "u": return undefined;
          case "l": return null;
          case "b":
          case "n":
          case "s":
          case "z":
            return node.v;
          case "ref":
            return made.get(node.id);
          case "port":
            return portFor(node);
        }

        var out;

        switch (node.t) {
          case "w":
            out = node.kind === "Number" ? new Number(node.v) : node.kind === "String" ? new String(node.v) : node.kind === "Boolean" ? new Boolean(node.v) : Object(node.v);
            break;
          case "d": out = new Date(node.v); break;
          case "r": out = new RegExp(node.source, node.flags); break;
          case "ab": {
            if (node.max !== undefined) {
              out = new ArrayBuffer(node.bytes.length, { maxByteLength: node.max });
            } else {
              out = new ArrayBuffer(node.bytes.length);
            }
            new Uint8Array(out).set(node.bytes);
            break;
          }
          case "blob":
            out = hooks.makeBlob(node.bytes, node.type, node.file);
            break;
          case "dx":
            out = hooks.makeDomException(node.message, node.name);
            break;
          case "platform":
            out = hooks.deserializePlatform(node);
            break;
        }

        if (out !== undefined) {
          made.set(node.id, out);
          return out;
        }

        switch (node.t) {
          case "v": {
            var buffer = build(node.buffer);
            out = node.kind === "DataView" ? new DataView(buffer, node.offset, node.length) : new VIEWS[node.kind](buffer, node.offset, node.length);
            made.set(node.id, out);
            return out;
          }
          case "m": {
            out = new Map();
            made.set(node.id, out);
            node.entries.forEach(function (pair) { out.set(build(pair[0]), build(pair[1])); });
            return out;
          }
          case "S": {
            out = new Set();
            made.set(node.id, out);
            node.values.forEach(function (item) { out.add(build(item)); });
            return out;
          }
          case "e": {
            var Kind = ERRORS[node.name] || Error;
            out = new Kind();
            made.set(node.id, out);
            if (node.message !== undefined) Object.defineProperty(out, "message", { value: node.message, writable: true, enumerable: false, configurable: true });
            if (node.stack !== undefined) Object.defineProperty(out, "stack", { value: node.stack, writable: true, enumerable: false, configurable: true });
            else delete out.stack;
            if (node.cause !== undefined) Object.defineProperty(out, "cause", { value: build(node.cause), writable: true, enumerable: false, configurable: true });
            return out;
          }
          case "a": {
            out = new Array(node.length);
            made.set(node.id, out);
            node.props.forEach(function (prop) { out[prop[0]] = build(prop[1]); });
            return out;
          }
          case "o": {
            out = {};
            made.set(node.id, out);
            node.props.forEach(function (prop) { out[prop[0]] = build(prop[1]); });
            return out;
          }
        }

        throw new TypeError("unknown record " + node.t);
      };

      record.ports.forEach(function (node) { ports.push(portFor(node)); });
      var value = build(record.root);
      return { value: value, ports: ports };
    };

    // Message ports. A port's channel end (its core) is shared by every realm the port has
    // travelled through; the realm holding it wraps it in a MessagePort of its own and receives
    // what its peer sends. Messages wait in the core until the port is started.
    var portState = new WeakMap();

    var realmSide = {
      deliver: function (core) {
        if (core.scheduled || !core.enabled || core.closed || !core.queue.length) return;
        core.scheduled = true;
        hooks.later(function () {
          core.scheduled = false;
          if (!core.enabled || core.closed || !core.queue.length || core.side !== realmSide) return;
          var record = core.queue.shift();
          var port = core.port;
          if (port) {
            var opened;
            try {
              opened = deserialize(record);
            } catch (error) {
              hooks.portError(port);
              opened = null;
            }
            if (opened) hooks.portEvent(port, opened.value, Object.freeze(opened.ports));
          }
          realmSide.deliver(core);
        }, 0);
      },
    };

    var makeCore = function () {
      return { queue: [], enabled: false, closed: false, scheduled: false, peer: null, port: null, side: null };
    };

    var bindCore = function (port, core) {
      core.port = port;
      core.side = realmSide;
      core.enabled = false;
      portState.set(port, { core: core });
      return port;
    };

    var adoptPort = function (core) {
      return bindCore(hooks.makePort(), core);
    };

    var detachPort = function (port) {
      var held = portState.get(port);
      if (held && held.core) {
        held.core.port = null;
        held.core.side = null;
      }
      portState.set(port, { core: null });
    };

    var channel = function () {
      var a = makeCore();
      var b = makeCore();
      a.peer = b;
      b.peer = a;
      return [adoptPort(a), adoptPort(b)];
    };

    var portPost = function (port, message, transfer) {
      var held = portState.get(port);
      var record = serialize(message, transfer, "MessagePort", "postMessage", port);
      if (!held || !held.core) return;
      var peer = held.core.peer;
      if (!peer || peer.closed) return;
      peer.queue.push(record);
      if (peer.side) peer.side.deliver(peer);
    };

    var portStart = function (port) {
      var held = portState.get(port);
      if (!held || !held.core || held.core.closed) return;
      held.core.enabled = true;
      realmSide.deliver(held.core);
    };

    var portClose = function (port) {
      var held = portState.get(port);
      if (!held || !held.core) return;
      held.core.closed = true;
      held.core.queue.length = 0;
      if (held.core.peer) held.core.peer.closed = true;
    };

    var isPort = function (value) {
      return value !== null && typeof value === "object" && portState.has(value);
    };

    // Broadcast channels: every realm of the page shares one registry by channel name; a message
    // reaches each other open channel of that name and origin, as a task in its own realm.
    var registry = hooks.shared.broadcast || (hooks.shared.broadcast = new Map());
    var channelState = new WeakMap();

    var openBroadcast = function (channelObject, name) {
      var entry = { name: String(name), origin: hooks.origin(), closed: false, deliver: null };
      entry.deliver = function (record, origin) {
        hooks.later(function () {
          if (entry.closed) return;
          var opened;
          try {
            opened = deserialize(record);
          } catch (error) {
            hooks.broadcastError(channelObject, origin);
            return;
          }
          hooks.broadcastEvent(channelObject, opened.value, origin);
        }, 0);
      };
      var list = registry.get(entry.name);
      if (!list) {
        list = [];
        registry.set(entry.name, list);
      }
      list.push(entry);
      channelState.set(channelObject, entry);
      return entry;
    };

    var broadcastPost = function (channelObject, message) {
      var entry = channelState.get(channelObject);
      if (entry.closed) {
        throw hooks.domException("Failed to execute 'postMessage' on 'BroadcastChannel': Channel is closed", "InvalidStateError");
      }
      var record = serialize(message, undefined, "BroadcastChannel", "postMessage");
      var list = (registry.get(entry.name) || []).slice();
      for (var index = 0; index < list.length; index += 1) {
        var other = list[index];
        if (other === entry || other.closed || other.origin !== entry.origin) continue;
        other.deliver(record, entry.origin);
      }
    };

    var broadcastClose = function (channelObject) {
      var entry = channelState.get(channelObject);
      if (!entry || entry.closed) return;
      entry.closed = true;
      var list = registry.get(entry.name) || [];
      var at = list.indexOf(entry);
      if (at !== -1) list.splice(at, 1);
    };

    // The origin private file system: one tree of entries for the whole page (windows, frames and
    // workers share it, as one origin's storage), kept in memory. A handle is this realm's object
    // over an entry; `opfs` holds the methods each realm attaches to its own interfaces.
    var handleState = new WeakMap();

    var NOT_FOUND = "A requested file or directory could not be found at the time an operation was processed.";

    var opfsRoot = function () {
      if (!hooks.shared.opfs) hooks.shared.opfs = { kind: "directory", name: "", children: new Map(), parent: null };
      return hooks.shared.opfs;
    };

    var makeHandle = function (entry) {
      var made = hooks.makeHandle(entry.kind);
      handleState.set(made, entry);
      return made;
    };

    var entryOf = function (holder, kind) {
      var entry = handleState.get(holder);
      if (!entry || (kind && entry.kind !== kind)) throw hooks.typeError("Illegal invocation");
      return entry;
    };

    var attached = function (entry) {
      for (var at = entry; at; at = at.parent) if (at === hooks.shared.opfs) return true;
      return false;
    };

    // Promise-returning methods reject (never throw), in this realm.
    var later = function (work) {
      return new Promise(function (resolve, reject) {
        try {
          resolve(work());
        } catch (error) {
          reject(error);
        }
      });
    };

    var checkName = function (name, method, where) {
      var text = String(name);
      if (text === "" || text === "." || text === ".." || text.indexOf("/") !== -1 || text.indexOf("\\") !== -1) {
        throw hooks.typeError("Failed to execute '" + method + "' on '" + where + "': Name is not allowed.");
      }
      return text;
    };

    var childOf = function (dir, name, kind, create, method) {
      if (!attached(dir)) throw hooks.domException(NOT_FOUND, "NotFoundError");
      var text = checkName(name, method, "FileSystemDirectoryHandle");
      var found = dir.children.get(text);
      if (found) {
        if (found.kind !== kind) throw hooks.domException("The path supplied exists, but was not an entry of requested type.", "TypeMismatchError");
        return found;
      }
      if (!create) throw hooks.domException(NOT_FOUND, "NotFoundError");
      var made = kind === "directory"
        ? { kind: "directory", name: text, children: new Map(), parent: dir }
        : { kind: "file", name: text, bytes: new Uint8Array(0), modified: Date.now(), parent: dir, lock: null };
      dir.children.set(text, made);
      return made;
    };

    var locked = function (entry) {
      for (var at = entry; at; at = at.parent) if (at.lock) return true;
      if (entry.kind === "directory") {
        var busy = false;
        entry.children.forEach(function (child) { if (locked(child)) busy = true; });
        return busy;
      }
      return false;
    };

    var iterate = function (dir, pick) {
      var list = [];
      var done = false;
      var iterator = {
        next: function () {
          return later(function () {
            if (!done && !list.length) {
              dir.children.forEach(function (child, name) { list.push([name, child]); });
              done = true;
              list.reverse();
            }
            if (!list.length) return { value: undefined, done: true };
            var item = list.pop();
            return { value: pick(item[0], makeHandle(item[1])), done: false };
          });
        },
      };
      iterator[Symbol.asyncIterator] = function () { return iterator; };
      if (hooks.asyncIteratorProto) Object.setPrototypeOf(iterator, hooks.asyncIteratorProto);
      return iterator;
    };

    var syncState = new WeakMap();

    var syncOf = function (holder, method) {
      var state = syncState.get(holder);
      if (!state) throw hooks.typeError("Illegal invocation");
      if (state.closed) {
        throw hooks.domException("Failed to execute '" + method + "' on 'FileSystemSyncAccessHandle': The access handle was already closed.", "InvalidStateError");
      }
      return state;
    };

    var bytesOf = function (buffer, method) {
      if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
      if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      try {
        byteLengthOf.call(buffer);
        return new Uint8Array(buffer);
      } catch (notBuffer) {}
      throw hooks.typeError("Failed to execute '" + method + "' on 'FileSystemSyncAccessHandle': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.");
    };

    var atOf = function (options) {
      if (options === undefined || options === null || options.at === undefined) return null;
      var at = Number(options.at);
      return isFinite(at) && at >= 0 ? Math.floor(at) : 0;
    };

    var grow = function (entry, size) {
      if (entry.bytes.length >= size) return;
      var bigger = new Uint8Array(size);
      bigger.set(entry.bytes);
      entry.bytes = bigger;
    };

    var opfs = {
      root: function () { return later(function () { return makeHandle(opfsRoot()); }); },
      handle: makeHandle,
      entryOf: function (holder) { return handleState.get(holder) || null; },
      handle_kind: function () { return entryOf(this).kind; },
      handle_name: function () { return entryOf(this).name; },
      isSameEntry: function (other) {
        var entry = entryOf(this);
        return later(function () { return handleState.get(other) === entry; });
      },
      queryPermission: function () { entryOf(this); return later(function () { return "granted"; }); },
      requestPermission: function () { entryOf(this); return later(function () { return "granted"; }); },
      remove: function (options) {
        var entry = entryOf(this);
        var recursive = Boolean(options && options.recursive);
        return later(function () {
          if (!attached(entry) || !entry.parent) throw hooks.domException(NOT_FOUND, "NotFoundError");
          if (entry.kind === "directory" && entry.children.size && !recursive) throw hooks.domException("The object can not be modified in this way.", "InvalidModificationError");
          if (locked(entry)) throw hooks.domException("The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.", "NoModificationAllowedError");
          entry.parent.children.delete(entry.name);
          entry.parent = null;
        });
      },
      getFileHandle: function (name, options) {
        var dir = entryOf(this, "directory");
        var create = Boolean(options && options.create);
        var count = arguments.length;
        return later(function () {
          if (count < 1) throw hooks.typeError("Failed to execute 'getFileHandle' on 'FileSystemDirectoryHandle': 1 argument required, but only 0 present.");
          return makeHandle(childOf(dir, name, "file", create, "getFileHandle"));
        });
      },
      getDirectoryHandle: function (name, options) {
        var dir = entryOf(this, "directory");
        var create = Boolean(options && options.create);
        var count = arguments.length;
        return later(function () {
          if (count < 1) throw hooks.typeError("Failed to execute 'getDirectoryHandle' on 'FileSystemDirectoryHandle': 1 argument required, but only 0 present.");
          return makeHandle(childOf(dir, name, "directory", create, "getDirectoryHandle"));
        });
      },
      removeEntry: function (name, options) {
        var dir = entryOf(this, "directory");
        var recursive = Boolean(options && options.recursive);
        return later(function () {
          var text = checkName(name, "removeEntry", "FileSystemDirectoryHandle");
          if (!attached(dir)) throw hooks.domException(NOT_FOUND, "NotFoundError");
          var found = dir.children.get(text);
          if (!found) throw hooks.domException(NOT_FOUND, "NotFoundError");
          if (found.kind === "directory" && found.children.size && !recursive) throw hooks.domException("The object can not be modified in this way.", "InvalidModificationError");
          if (locked(found)) throw hooks.domException("The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.", "NoModificationAllowedError");
          dir.children.delete(text);
          found.parent = null;
        });
      },
      resolve: function (possibleDescendant) {
        var dir = entryOf(this, "directory");
        return later(function () {
          var target = handleState.get(possibleDescendant);
          if (!target) throw hooks.typeError("Failed to execute 'resolve' on 'FileSystemDirectoryHandle': parameter 1 is not of type 'FileSystemHandle'.");
          var path = [];
          for (var at = target; at; at = at.parent) {
            if (at === dir) return path.reverse();
            path.push(at.name);
          }
          return null;
        });
      },
      entries: function () { return iterate(entryOf(this, "directory"), function (name, handle) { return [name, handle]; }); },
      keys: function () { return iterate(entryOf(this, "directory"), function (name) { return name; }); },
      values: function () { return iterate(entryOf(this, "directory"), function (name, handle) { return handle; }); },
      getFile: function () {
        var entry = entryOf(this, "file");
        return later(function () {
          if (!attached(entry)) throw hooks.domException(NOT_FOUND, "NotFoundError");
          return hooks.makeBlob(entry.bytes.slice(), "", { name: entry.name, lastModified: entry.modified });
        });
      },
      move: function () {
        entryOf(this);
        return later(function () { throw hooks.domException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError"); });
      },
      // createWritable: what is written goes to a scratch copy, committed on close.
      createWritable: function (options) {
        var entry = entryOf(this, "file");
        var keep = Boolean(options && options.keepExistingData);
        return later(function () {
          if (!attached(entry)) throw hooks.domException(NOT_FOUND, "NotFoundError");
          if (entry.lock === "sync") throw hooks.domException("Failed to execute 'createWritable' on 'FileSystemFileHandle': Writable streams cannot be created if there is an open Access Handle associated with the same file.", "NoModificationAllowedError");
          var scratch = { bytes: keep ? entry.bytes.slice() : new Uint8Array(0), cursor: 0, closed: false };
          return hooks.makeWritable(scratch, function commit() {
            entry.bytes = scratch.bytes;
            entry.modified = Date.now();
          });
        });
      },
      // FileSystemWritableFileStream's chunk handling (write/seek/truncate share it).
      writeChunk: function (scratch, chunk) {
        if (chunk !== null && typeof chunk === "object" && !ArrayBuffer.isView(chunk) && !(chunk instanceof ArrayBuffer) && !hooks.blobState(chunk) && "type" in chunk) {
          if (chunk.type === "seek") {
            scratch.cursor = Number(chunk.position) || 0;
            return;
          }
          if (chunk.type === "truncate") {
            var size = Number(chunk.size) || 0;
            var cut = new Uint8Array(size);
            cut.set(scratch.bytes.subarray(0, Math.min(size, scratch.bytes.length)));
            scratch.bytes = cut;
            if (scratch.cursor > size) scratch.cursor = size;
            return;
          }
          if (chunk.position !== undefined && chunk.position !== null) scratch.cursor = Number(chunk.position) || 0;
          chunk = chunk.data;
        }
        var blob = hooks.blobState(chunk);
        var bytes = blob ? blob.bytes : typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new TextEncoder().encode(String(chunk));
        var end = scratch.cursor + bytes.length;
        if (end > scratch.bytes.length) {
          var bigger = new Uint8Array(end);
          bigger.set(scratch.bytes);
          scratch.bytes = bigger;
        }
        scratch.bytes.set(bytes, scratch.cursor);
        scratch.cursor = end;
      },
      // Dedicated workers only: a synchronous handle that holds the file's lock until closed.
      createSyncAccessHandle: function () {
        var entry = entryOf(this, "file");
        return later(function () {
          if (!attached(entry)) throw hooks.domException(NOT_FOUND, "NotFoundError");
          if (entry.lock) {
            throw hooks.domException("Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.", "NoModificationAllowedError");
          }
          entry.lock = "sync";
          var made = hooks.makeSyncHandle();
          syncState.set(made, { entry: entry, closed: false });
          return made;
        });
      },
      sync_read: function (buffer, options) {
        var state = syncOf(this, "read");
        var target = bytesOf(buffer, "read");
        var at = atOf(options);
        var from = at === null ? 0 : at;
        var count = Math.max(0, Math.min(target.length, state.entry.bytes.length - from));
        target.set(state.entry.bytes.subarray(from, from + count));
        return count;
      },
      sync_write: function (buffer, options) {
        var state = syncOf(this, "write");
        var source = bytesOf(buffer, "write");
        var at = atOf(options);
        var from = at === null ? 0 : at;
        grow(state.entry, from + source.length);
        state.entry.bytes.set(source, from);
        state.entry.modified = Date.now();
        return source.length;
      },
      sync_truncate: function (size) {
        var state = syncOf(this, "truncate");
        var length = Math.max(0, Math.floor(Number(size)) || 0);
        var cut = new Uint8Array(length);
        cut.set(state.entry.bytes.subarray(0, Math.min(length, state.entry.bytes.length)));
        state.entry.bytes = cut;
        state.entry.modified = Date.now();
      },
      sync_getSize: function () { return syncOf(this, "getSize").entry.bytes.length; },
      // A flush is a real disk's fsync: it takes time (hooks.flush waits it out).
      sync_flush: function () {
        syncOf(this, "flush");
        hooks.flush();
      },
      sync_close: function () {
        var state = syncState.get(this);
        if (!state) throw hooks.typeError("Illegal invocation");
        if (state.closed) return;
        state.closed = true;
        state.entry.lock = null;
      },
    };

    return {
      serialize: serialize,
      deserialize: deserialize,
      // structuredClone(value, { transfer }) in this realm.
      clone: function (value, transfer, where) {
        return deserialize(serialize(value, transfer, where || "Window", "structuredClone")).value;
      },
      readTransfer: readTransfer,
      labelFor: labelFor,
      channel: channel,
      isPort: isPort,
      portPost: portPost,
      portStart: portStart,
      portClose: portClose,
      openBroadcast: openBroadcast,
      broadcastPost: broadcastPost,
      broadcastClose: broadcastClose,
      broadcastState: function (channelObject) { return channelState.get(channelObject) || null; },
      opfs: opfs,
      // Hooks a realm can only give once its interfaces exist (the file system's handle makers).
      useHooks: function (more) {
        for (var key in more) hooks[key] = more[key];
      },
    };
  };
})();
