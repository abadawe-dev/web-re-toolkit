// The streams module: WHATWG Streams, compression, text encodings, FileReader, the fetch body
// interfaces (Headers, Request, Response), fetch itself and XMLHttpRequest, as Chrome 156 runs
// them. Evaluated in every window and frame, after dom.js.
//
// Streams run on web-streams-polyfill (vendor/, loaded just before this file as
// `env.streamsEngine`), kept out of sight: the page only ever holds instances of its own captured
// interfaces (ReadableStream.prototype and so on), whose methods are native-looking shells over
// the engine object each instance stands for. Errors the page can see carry Chrome's messages.
(function () {
  var env = globalThis.__ENV;
  if (!env) return;

  var bridge = env.bridge;
  var patch = env.patch;
  var patchGetter = env.patchGetter;
  var asNative = env.asNative;
  var installShell = env.installShell;
  var hide = env.hideFrames;

  var typeError = function (message) { return hide(new TypeError(message)); };
  var rangeError = function (message) { return hide(new RangeError(message)); };
  var domError = function (message, name) { return env.domException(message, name); };
  var isObject = function (value) { return value !== null && (typeof value === "object" || typeof value === "function"); };
  var nativeThen = Promise.prototype.then;
  var resolved = function (value) { return Promise.resolve(value); };
  var rejected = function (error) { return Promise.reject(error); };

  // Bytes of a BufferSource (a copy), or null when the value is not one.
  var bufferBytes = function (value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    return null;
  };

  // A view over a BufferSource without copying, or null.
  var bufferView = function (value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  };

  var joinBytes = env.joinBytes;
  var utf8Encode = env.utf8Encode;
  var utf8Decode = env.decodeUtf8;

  // ---------------------------------------------------------------------------------------------
  // Streams
  // ---------------------------------------------------------------------------------------------

  var E = env.streamsEngine;
  if (!E || typeof globalThis.ReadableStream !== "function") return;

  var KINDS = [
    "ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader",
    "ReadableStreamDefaultController", "ReadableByteStreamController", "ReadableStreamBYOBRequest",
    "WritableStream", "WritableStreamDefaultWriter", "WritableStreamDefaultController",
    "TransformStream", "TransformStreamDefaultController",
  ];

  var protos = {};
  KINDS.forEach(function (kind) { protos[kind] = globalThis[kind] && globalThis[kind].prototype; });

  var engineOf = new WeakMap();
  var shellOf = new WeakMap();

  var kindOf = function (inner) {
    for (var index = 0; index < KINDS.length; index += 1) {
      if (E[KINDS[index]] && inner instanceof E[KINDS[index]]) return KINDS[index];
    }
    return null;
  };

  // The page's object for an engine object (made once, so identity holds).
  var wrap = function (inner) {
    if (!isObject(inner)) return inner;
    var held = shellOf.get(inner);
    if (held) return held;
    var kind = kindOf(inner);
    if (!kind || !protos[kind]) return inner;
    var made = Object.create(protos[kind]);
    engineOf.set(made, inner);
    shellOf.set(inner, made);
    return made;
  };

  // The engine object behind a page object of `kind`, or null.
  var engine = function (value, kind) {
    var inner = isObject(value) ? engineOf.get(value) : undefined;
    return inner && inner instanceof E[kind] ? inner : null;
  };

  var own = function (self, kind) {
    var inner = engine(self, kind);
    if (!inner) throw typeError("Illegal invocation");
    return inner;
  };

  env.streamEngine = engine;
  env.wrapStream = wrap;

  // The engine's rejections the page can see, in Chrome's words.
  var ASYNC_MESSAGES = {
    "Reader was released and can no longer be used to monitor the stream's closedness": "This readable stream reader has been released and cannot be used to monitor the stream's state",
    "Writer was released and can no longer be used to monitor the stream's closedness": "This writable stream writer has been released and cannot be used to monitor the stream's state",
    "the destination writable stream closed before all data could be piped to it": "Destination stream closed",
    "TransformStream terminated": "The transform stream has been terminated",
    "The stream is closing or closed and cannot be written to": "Cannot write to a closing writable stream",
  };

  var translate = function (error, released) {
    if (!(error instanceof TypeError)) return error;
    if (error.message === "Reader was released" && released) return typeError(released);
    var chrome = ASYNC_MESSAGES[error.message];
    return chrome ? typeError(chrome) : error;
  };

  var follow = function (promise, released) {
    return nativeThen.call(promise, undefined, function (error) { throw translate(error, released); });
  };

  // A promise the page reads more than once (`reader.closed`, `writer.ready`): one per engine
  // promise, already marked handled as the spec does.
  var stable = new WeakMap();

  var stablePromise = function (promise) {
    var held = stable.get(promise);
    if (held) return held;
    held = follow(promise);
    nativeThen.call(held, undefined, function () {});
    stable.set(promise, held);
    return held;
  };

  var iterResult = function (value, done) { return { done: done, value: value }; };

  var readResult = function (promise, released) {
    return nativeThen.call(promise, function (result) { return iterResult(result.value, result.done); }, function (error) { throw translate(error, released); });
  };

  // Reads a strategy as Chrome does (highWaterMark, then size), with Chrome's errors.
  var readStrategy = function (strategy, where, bytes) {
    if (strategy === undefined || strategy === null) return { size: undefined, highWaterMark: undefined };
    if (!isObject(strategy)) throw typeError("Failed to construct '" + where + "': The provided value is not of type 'QueuingStrategy'.");

    var mark = strategy.highWaterMark;
    var size = strategy.size;
    var out = {};

    if (size !== undefined) {
      if (typeof size !== "function") throw typeError("Failed to construct '" + where + "': A queuing strategy's size property must be a function");
      if (bytes) throw rangeError("Failed to construct '" + where + "': Cannot create byte stream with size() defined on the strategy");
      out.size = function (chunk) { return size.call(undefined, chunk); };
    }

    if (mark !== undefined) {
      var number = Number(mark);
      if (isNaN(number) || number < 0) throw rangeError("Failed to construct '" + where + "': A queuing strategy's highWaterMark property must be a nonnegative, non-NaN number");
      out.highWaterMark = number;
    }

    return out;
  };

  var member = function (holder, name, where, kind) {
    var value = holder[name];
    if (value !== undefined && typeof value !== "function") throw typeError("Failed to construct '" + where + "': " + kind + "." + name + " must be a function or undefined");
    return value;
  };

  var call = function (method, holder, args) {
    return method === undefined ? undefined : method.apply(holder, args);
  };

  // An underlying source the engine runs, calling the page's own with the page's controller.
  var readSource = function (source) {
    if (!isObject(source)) return { bytes: false, source: undefined };

    var chunkSize = source.autoAllocateChunkSize;
    var cancel = member(source, "cancel", "ReadableStream", "underlyingSource");
    var pull = member(source, "pull", "ReadableStream", "underlyingSource");
    var start = member(source, "start", "ReadableStream", "underlyingSource");
    var type = source.type;
    var bytes = false;

    if (type !== undefined) {
      if (String(type) !== "bytes") throw rangeError("Failed to construct 'ReadableStream': Invalid type is specified");
      bytes = true;
    }

    var made = {
      start: start && function (controller) { return call(start, source, [wrap(controller)]); },
      pull: pull && function (controller) { return call(pull, source, [wrap(controller)]); },
      cancel: cancel && function (reason) { return call(cancel, source, [reason]); },
    };

    if (bytes) made.type = "bytes";

    if (chunkSize !== undefined) {
      var number = Number(chunkSize);
      if (!(number > 0)) throw typeError("Failed to construct 'ReadableStream': autoAllocateChunkSize must be greater than 0");
      made.autoAllocateChunkSize = Math.trunc(number);
    }

    return { bytes: bytes, source: made };
  };

  var isByteStream = function (inner) {
    return inner._readableStreamController instanceof E.ReadableByteStreamController;
  };

  var lockedMessage = function (mode) {
    return (mode === "byob" ? "ReadableStreamBYOBReader" : "ReadableStreamDefaultReader") + " constructor can only accept readable streams that are not yet locked to a reader";
  };

  // A readable stream the platform makes (a blob's, a body's, a transform's side): the page's
  // object for a new engine stream.
  var makeReadable = function (source, strategy) {
    return wrap(new E.ReadableStream(source, strategy));
  };

  env.makeReadable = makeReadable;

  // One chunk of bytes, then the end: a body or blob's stream (a byte stream, as Chrome's).
  var bytesStream = function (bytes) {
    return makeReadable({
      type: "bytes",
      start: function (controller) {
        if (bytes.length) controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
  };

  env.bytesStream = bytesStream;

  var ReadableShell = installShell("ReadableStream", function (args) {
    var read = readSource(args[0]);
    var strategy = readStrategy(args[1], "ReadableStream", read.bytes);
    var inner = new E.ReadableStream(read.source, strategy);
    return wrap(inner);
  }, 0);

  var readableProto = protos.ReadableStream;

  patchGetter(readableProto, "locked", function () { return own(this, "ReadableStream").locked; });

  patch(readableProto, "cancel", function cancel(reason) {
    var inner = engine(this, "ReadableStream");
    if (!inner) return rejected(typeError("Illegal invocation"));
    if (inner.locked) return rejected(typeError("Failed to execute 'cancel' on 'ReadableStream': Cannot cancel a locked stream"));
    return follow(inner.cancel(reason));
  });

  var readerMode = function (options, where) {
    if (options === undefined || options === null) return undefined;
    if (!isObject(options)) throw typeError(where + "The provided value is not of type 'ReadableStreamGetReaderOptions'.");
    var mode = options.mode;
    if (mode === undefined) return undefined;
    if (String(mode) !== "byob") {
      throw typeError(where + "Failed to read the 'mode' property from 'ReadableStreamGetReaderOptions': The provided value '" + String(mode) + "' is not a valid enum value of type ReadableStreamReaderMode.");
    }
    return "byob";
  };

  patch(readableProto, "getReader", function getReader(options) {
    var inner = own(this, "ReadableStream");
    var where = "Failed to execute 'getReader' on 'ReadableStream': ";
    var mode = readerMode(options, where);
    if (mode === "byob" && !isByteStream(inner)) throw typeError(where + "Cannot use a BYOB reader with a non-byte stream");
    if (inner.locked) throw typeError(where + lockedMessage(mode));
    return wrap(mode === "byob" ? inner.getReader({ mode: "byob" }) : inner.getReader());
  });

  patch(readableProto, "tee", function tee() {
    var inner = own(this, "ReadableStream");
    if (inner.locked) throw typeError("Failed to execute 'tee' on 'ReadableStream': " + lockedMessage());
    var branches = inner.tee();
    return [wrap(branches[0]), wrap(branches[1])];
  });

  var pipeOptions = function (options, where) {
    if (options === undefined || options === null) return {};
    if (!isObject(options)) throw typeError(where + "The provided value is not of type 'StreamPipeOptions'.");
    var out = {
      preventAbort: Boolean(options.preventAbort),
      preventCancel: Boolean(options.preventCancel),
      preventClose: Boolean(options.preventClose),
    };
    var signal = options.signal;
    if (signal !== undefined) {
      if (!env.signalState || !isObject(signal) || !env.signalState.has(signal)) {
        throw typeError(where + "Failed to read the 'signal' property from 'StreamPipeOptions': Failed to convert value to 'AbortSignal'.");
      }
      out.signal = signal;
    }
    return out;
  };

  patch(readableProto, "pipeTo", function pipeTo(destination, options) {
    var where = "Failed to execute 'pipeTo' on 'ReadableStream': ";
    var inner = engine(this, "ReadableStream");
    if (!inner) return rejected(typeError("Illegal invocation"));
    if (arguments.length < 1) return rejected(typeError(where + "1 argument required, but only 0 present."));
    var target = engine(destination, "WritableStream");
    if (!target) return rejected(typeError(where + "parameter 1 is not of type 'WritableStream'."));
    var read;
    try {
      read = pipeOptions(options, where);
    } catch (error) {
      return rejected(error);
    }
    if (inner.locked) return rejected(typeError(where + "Cannot pipe a locked stream"));
    if (target.locked) return rejected(typeError(where + "Cannot pipe to a locked stream"));
    return follow(inner.pipeTo(target, read));
  });

  patch(readableProto, "pipeThrough", function pipeThrough(transform, options) {
    var where = "Failed to execute 'pipeThrough' on 'ReadableStream': ";
    var inner = own(this, "ReadableStream");
    if (arguments.length < 1) throw typeError(where + "1 argument required, but only 0 present.");
    if (!isObject(transform)) throw typeError(where + "The provided value is not of type 'ReadableWritablePair'.");
    var readable = transform.readable;
    if (readable === undefined) throw typeError(where + "Failed to read the 'readable' property from 'ReadableWritablePair': Required member is undefined.");
    if (!engine(readable, "ReadableStream")) throw typeError(where + "Failed to read the 'readable' property from 'ReadableWritablePair': Failed to convert value to 'ReadableStream'.");
    var writable = transform.writable;
    if (writable === undefined) throw typeError(where + "Failed to read the 'writable' property from 'ReadableWritablePair': Required member is undefined.");
    var target = engine(writable, "WritableStream");
    if (!target) throw typeError(where + "Failed to read the 'writable' property from 'ReadableWritablePair': Failed to convert value to 'WritableStream'.");
    var read = pipeOptions(options, where);
    if (inner.locked) throw typeError(where + "Cannot pipe a locked stream");
    if (target.locked) throw typeError(where + "parameter 1's 'writable' is locked");
    nativeThen.call(inner.pipeTo(target, read), undefined, function () {});
    return readable;
  });

  // Async iteration: Chrome's iterator objects share one prototype (next, return) whose own
  // prototype is %AsyncIteratorPrototype%, branded "ReadableStream AsyncIterator".
  var iterators = new WeakMap();
  var asyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}).prototype);
  var iteratorProto = Object.create(asyncIteratorPrototype);

  Object.defineProperty(iteratorProto, "next", {
    value: asNative(function next() {
      var inner = iterators.get(this);
      if (!inner) return rejected(typeError("Illegal invocation"));
      return readResult(inner.next());
    }, "next"),
    writable: true, enumerable: true, configurable: true,
  });
  Object.defineProperty(iteratorProto, "return", {
    value: asNative(function (value) {
      var inner = iterators.get(this);
      if (!inner) return rejected(typeError("Illegal invocation"));
      return readResult(inner.return(value));
    }, "return"),
    writable: true, enumerable: true, configurable: true,
  });
  Object.defineProperty(iteratorProto, Symbol.toStringTag, { value: "ReadableStream AsyncIterator", configurable: true });

  var values = function values(options) {
    var inner = own(this, "ReadableStream");
    var preventCancel = false;
    if (options !== undefined && options !== null) {
      if (!isObject(options)) throw typeError("Failed to execute 'values' on 'ReadableStream': The provided value is not of type 'ReadableStreamIteratorOptions'.");
      preventCancel = Boolean(options.preventCancel);
    }
    if (inner.locked) throw typeError("Failed to execute 'values' on 'ReadableStream': " + lockedMessage());
    var made = Object.create(iteratorProto);
    iterators.set(made, inner.values({ preventCancel: preventCancel }));
    return made;
  };

  patch(readableProto, "values", values);
  try {
    Object.defineProperty(readableProto, Symbol.asyncIterator, { value: readableProto.values, writable: true, enumerable: false, configurable: true });
  } catch (error) {}

  // Readers
  var readerShell = function (name, mode) {
    installShell(name, function (args) {
      var where = "Failed to construct '" + name + "': ";
      var inner = engine(args[0], "ReadableStream");
      if (!inner) throw typeError(where + "parameter 1 is not of type 'ReadableStream'.");
      if (mode === "byob" && !isByteStream(inner)) throw typeError(where + "Cannot use a BYOB reader with a non-byte stream");
      if (inner.locked) throw typeError(where + lockedMessage(mode));
      return wrap(mode === "byob" ? inner.getReader({ mode: "byob" }) : inner.getReader());
    }, 1, { required: 1 });

    var proto = protos[name];
    var released = function (inner) { return inner._ownerReadableStream === undefined; };
    var releasing = mode === "byob" ? "Releasing BYOB reader" : "Releasing Default reader";

    patchGetter(proto, "closed", function () {
      var inner = own(this, name);
      return stablePromise(inner.closed);
    });

    patch(proto, "cancel", function cancel(reason) {
      var inner = engine(this, name);
      if (!inner) return rejected(typeError("Illegal invocation"));
      if (released(inner)) return rejected(typeError("Failed to execute 'cancel' on '" + name + "': This readable stream reader has been released and cannot be used to cancel its previous owner stream"));
      return follow(inner.cancel(reason));
    });

    patch(proto, "releaseLock", function releaseLock() {
      var inner = own(this, name);
      inner.releaseLock();
    });

    if (mode === "byob") {
      patch(proto, "read", function read(view, options) {
        var where = "Failed to execute 'read' on '" + name + "': ";
        var inner = engine(this, name);
        if (!inner) return rejected(typeError("Illegal invocation"));
        if (arguments.length < 1) return rejected(typeError(where + "1 argument required, but only 0 present."));
        if (!ArrayBuffer.isView(view)) return rejected(typeError(where + "parameter 1 is not of type 'ArrayBufferView'."));
        if (view.byteLength === 0) return rejected(typeError(where + "This readable stream reader cannot be used to read as the view has byte length equal to 0"));
        if (released(inner)) return rejected(typeError(where + "This readable stream reader has been released and cannot be used to read from its previous owner stream"));
        return readResult(options === undefined ? inner.read(view) : inner.read(view, options), releasing);
      });
    } else {
      patch(proto, "read", function read() {
        var inner = engine(this, name);
        if (!inner) return rejected(typeError("Illegal invocation"));
        if (released(inner)) return rejected(typeError("Failed to execute 'read' on '" + name + "': This readable stream reader has been released and cannot be used to read from its previous owner stream"));
        return readResult(inner.read(), releasing);
      });
    }
  };

  readerShell("ReadableStreamDefaultReader");
  readerShell("ReadableStreamBYOBReader", "byob");

  // Controllers (the page never constructs one).
  ["ReadableStreamDefaultController", "ReadableByteStreamController", "ReadableStreamBYOBRequest", "WritableStreamDefaultController", "TransformStreamDefaultController"].forEach(function (name) {
    installShell(name, function () {}, 0, { illegal: true });
  });

  var streamState = function (controller) {
    var stream = controller._controlledReadableStream || controller._controlledReadableByteStream;
    return stream ? stream._state : "readable";
  };

  (function () {
    var name = "ReadableStreamDefaultController";
    var proto = protos[name];

    patchGetter(proto, "desiredSize", function () { return own(this, name).desiredSize; });

    patch(proto, "close", function close() {
      var inner = own(this, name);
      var where = "Failed to execute 'close' on '" + name + "': ";
      if (inner._closeRequested) throw typeError(where + "Cannot close a readable stream that has already been requested to be closed");
      if (streamState(inner) !== "readable") throw typeError(where + "Cannot close a readable stream that is not readable");
      inner.close();
    });

    patch(proto, "enqueue", function enqueue(chunk) {
      var inner = own(this, name);
      var where = "Failed to execute 'enqueue' on '" + name + "': ";
      var state = streamState(inner);
      if (state === "errored") throw typeError(where + "Cannot enqueue a chunk into an errored readable stream");
      if (inner._closeRequested || state !== "readable") throw typeError(where + "Cannot enqueue a chunk into a readable stream that is closed or has been requested to be closed");
      inner.enqueue(chunk);
    });

    patch(proto, "error", function error(reason) { own(this, name).error(reason); });
  })();

  (function () {
    var name = "ReadableByteStreamController";
    var proto = protos[name];

    patchGetter(proto, "byobRequest", function () { return wrap(own(this, name).byobRequest); });
    patchGetter(proto, "desiredSize", function () { return own(this, name).desiredSize; });

    patch(proto, "close", function close() {
      var inner = own(this, name);
      var where = "Failed to execute 'close' on '" + name + "': ";
      if (inner._closeRequested && streamState(inner) === "readable") throw typeError(where + "Cannot close a readable stream that has already been requested to be closed");
      if (streamState(inner) !== "readable") throw typeError(where + "Cannot close a readable stream that is not readable");
      inner.close();
    });

    patch(proto, "enqueue", function enqueue(chunk) {
      var inner = own(this, name);
      var where = "Failed to execute 'enqueue' on '" + name + "': ";
      if (arguments.length < 1) throw typeError(where + "1 argument required, but only 0 present.");
      if (!ArrayBuffer.isView(chunk)) throw typeError(where + "parameter 1 is not of type 'ArrayBufferView'.");
      if (chunk.byteLength === 0) throw typeError(where + "chunk is empty");
      if (inner._closeRequested) throw typeError(where + "close requested already");
      if (streamState(inner) !== "readable") throw typeError(where + "stream is not readable");
      inner.enqueue(chunk);
    });

    patch(proto, "error", function error(reason) { own(this, name).error(reason); });
  })();

  (function () {
    var name = "ReadableStreamBYOBRequest";
    var proto = protos[name];

    patchGetter(proto, "view", function () { return own(this, name).view; });

    patch(proto, "respond", function respond(written) {
      var inner = own(this, name);
      var where = "Failed to execute 'respond' on '" + name + "': ";
      if (arguments.length < 1) throw typeError(where + "1 argument required, but only 0 present.");
      var view = inner.view;
      if (view === null) throw typeError(where + "This BYOB request has been invalidated");
      var count = Number(written);
      if (count > view.byteLength) throw rangeError(where + "available read buffer is too small for specified number of bytes");
      inner.respond(count);
    });

    patch(proto, "respondWithNewView", function respondWithNewView(view) {
      var inner = own(this, name);
      var where = "Failed to execute 'respondWithNewView' on '" + name + "': ";
      if (arguments.length < 1) throw typeError(where + "1 argument required, but only 0 present.");
      if (!ArrayBuffer.isView(view)) throw typeError(where + "parameter 1 is not of type 'ArrayBufferView'.");
      inner.respondWithNewView(view);
    });
  })();

  // WritableStream
  var readSink = function (sink) {
    if (!isObject(sink)) return undefined;
    var abort = member(sink, "abort", "WritableStream", "underlyingSink");
    var close = member(sink, "close", "WritableStream", "underlyingSink");
    var start = member(sink, "start", "WritableStream", "underlyingSink");
    var type = sink.type;
    var write = member(sink, "write", "WritableStream", "underlyingSink");
    if (type !== undefined) throw rangeError("Failed to construct 'WritableStream': Invalid type is specified");
    return {
      start: start && function (controller) { return call(start, sink, [wrap(controller)]); },
      write: write && function (chunk, controller) { return call(write, sink, [chunk, wrap(controller)]); },
      close: close && function () { return call(close, sink, []); },
      abort: abort && function (reason) { return call(abort, sink, [reason]); },
    };
  };

  var makeWritable = function (sink, strategy) {
    return wrap(new E.WritableStream(sink, strategy));
  };

  env.makeWritable = makeWritable;

  installShell("WritableStream", function (args) {
    var sink = readSink(args[0]);
    var strategy = readStrategy(args[1], "WritableStream", false);
    return wrap(new E.WritableStream(sink, strategy));
  }, 0);

  (function () {
    var name = "WritableStream";
    var proto = protos[name];

    patchGetter(proto, "locked", function () { return own(this, name).locked; });

    patch(proto, "abort", function abort(reason) {
      var inner = engine(this, name);
      if (!inner) return rejected(typeError("Illegal invocation"));
      if (inner.locked) return rejected(typeError("Failed to execute 'abort' on 'WritableStream': Cannot abort a locked stream"));
      return follow(inner.abort(reason));
    });

    patch(proto, "close", function close() {
      var inner = engine(this, name);
      if (!inner) return rejected(typeError("Illegal invocation"));
      if (inner.locked) return rejected(typeError("Failed to execute 'close' on 'WritableStream': Cannot close a locked stream"));
      if (inner._closeRequest !== undefined || inner._inFlightCloseRequest !== undefined) {
        return rejected(typeError("Failed to execute 'close' on 'WritableStream': Cannot close a writable stream that has already been requested to be closed"));
      }
      return follow(inner.close());
    });

    patch(proto, "getWriter", function getWriter() {
      var inner = own(this, name);
      if (inner.locked) throw typeError("Failed to execute 'getWriter' on 'WritableStream': Cannot create writer when WritableStream is locked");
      return wrap(inner.getWriter());
    });
  })();

  (function () {
    var name = "WritableStreamDefaultWriter";
    var proto = protos[name];

    installShell(name, function (args) {
      var where = "Failed to construct '" + name + "': ";
      var inner = engine(args[0], "WritableStream");
      if (!inner) throw typeError(where + "parameter 1 is not of type 'WritableStream'.");
      if (inner.locked) throw typeError(where + "Cannot create writer when WritableStream is locked");
      return wrap(inner.getWriter());
    }, 1, { required: 1 });

    var released = function (inner) { return inner._ownerWritableStream === undefined; };
    var closing = function (inner) {
      var stream = inner._ownerWritableStream;
      return stream && (stream._closeRequest !== undefined || stream._inFlightCloseRequest !== undefined);
    };

    patchGetter(proto, "closed", function () { return stablePromise(own(this, name).closed); });
    patchGetter(proto, "ready", function () { return stablePromise(own(this, name).ready); });

    patchGetter(proto, "desiredSize", function () {
      var inner = own(this, name);
      if (released(inner)) throw typeError("Failed to read the 'desiredSize' property from '" + name + "': This writable stream writer has been released and cannot be used to get the desiredSize");
      return inner.desiredSize;
    });

    patch(proto, "abort", function abort(reason) {
      var inner = engine(this, name);
      if (!inner) return rejected(typeError("Illegal invocation"));
      if (released(inner)) return rejected(typeError("Failed to execute 'abort' on '" + name + "': This writable stream writer has been released and cannot be aborted"));
      return follow(inner.abort(reason));
    });

    patch(proto, "close", function close() {
      var inner = engine(this, name);
      if (!inner) return rejected(typeError("Illegal invocation"));
      if (released(inner)) return rejected(typeError("Failed to execute 'close' on '" + name + "': This writable stream writer has been released and cannot be closed"));
      if (closing(inner)) return rejected(typeError("Failed to execute 'close' on '" + name + "': Cannot close a writable stream that has already been requested to be closed"));
      return follow(inner.close());
    });

    patch(proto, "releaseLock", function releaseLock() { own(this, name).releaseLock(); });

    patch(proto, "write", function write(chunk) {
      var inner = engine(this, name);
      if (!inner) return rejected(typeError("Illegal invocation"));
      if (released(inner)) return rejected(typeError("Failed to execute 'write' on '" + name + "': This writable stream writer has been released and cannot be written to"));
      return follow(arguments.length ? inner.write(chunk) : inner.write());
    });
  })();

  (function () {
    var name = "WritableStreamDefaultController";
    var proto = protos[name];

    patchGetter(proto, "signal", function () { return own(this, name).signal; });
    patch(proto, "error", function error(reason) { own(this, name).error(reason); });
  })();

  // TransformStream
  var readTransformer = function (transformer) {
    if (!isObject(transformer)) return undefined;
    var cancel = member(transformer, "cancel", "TransformStream", "transformer");
    var flush = member(transformer, "flush", "TransformStream", "transformer");
    var readableType = transformer.readableType;
    var start = member(transformer, "start", "TransformStream", "transformer");
    var transform = member(transformer, "transform", "TransformStream", "transformer");
    var writableType = transformer.writableType;
    if (readableType !== undefined) throw rangeError("Failed to construct 'TransformStream': Invalid readableType was specified");
    if (writableType !== undefined) throw rangeError("Failed to construct 'TransformStream': Invalid writableType was specified");
    return {
      start: start && function (controller) { return call(start, transformer, [wrap(controller)]); },
      transform: transform && function (chunk, controller) { return call(transform, transformer, [chunk, wrap(controller)]); },
      flush: flush && function (controller) { return call(flush, transformer, [wrap(controller)]); },
      cancel: cancel && function (reason) { return call(cancel, transformer, [reason]); },
    };
  };

  installShell("TransformStream", function (args) {
    var transformer = readTransformer(args[0]);
    var writable = readStrategy(args[1], "TransformStream", false);
    var readable = readStrategy(args[2], "TransformStream", false);
    return wrap(new E.TransformStream(transformer, writable, readable));
  }, 0);

  (function () {
    var proto = protos.TransformStream;
    patchGetter(proto, "readable", function () { return wrap(own(this, "TransformStream").readable); });
    patchGetter(proto, "writable", function () { return wrap(own(this, "TransformStream").writable); });

    var name = "TransformStreamDefaultController";
    var controller = protos[name];

    patchGetter(controller, "desiredSize", function () { return own(this, name).desiredSize; });
    patch(controller, "enqueue", function enqueue(chunk) {
      var inner = own(this, name);
      var readable = inner._controlledTransformStream && inner._controlledTransformStream._readable;
      var source = readable && readable._readableStreamController;
      if (source && (source._closeRequested || readable._state !== "readable")) {
        throw typeError("Failed to execute 'enqueue' on '" + name + "': Cannot enqueue a chunk into a readable stream that is closed or has been requested to be closed");
      }
      inner.enqueue(chunk);
    });
    patch(controller, "error", function error(reason) { own(this, name).error(reason); });
    patch(controller, "terminate", function terminate() { own(this, name).terminate(); });
  })();

  // A transform the platform runs (compression, text coding): `transform(bytes, enqueue)` and
  // `flush(enqueue)` work on the engine's controller, and a failure errors both sides. A chunk of
  // the wrong type errors the stream and leaves its write pending, as Chrome does.
  var platformTransform = function (transform, flush) {
    var inner = new E.TransformStream({
      transform: function (chunk, controller) {
        try {
          transform(chunk, function (out) { controller.enqueue(out); });
        } catch (error) {
          controller.error(error);
          if (pendingErrors.has(error)) return new Promise(function () {});
          throw error;
        }
      },
      flush: function (controller) {
        try {
          flush(function (out) { controller.enqueue(out); });
        } catch (error) {
          controller.error(error);
          throw error;
        }
      },
    });
    return { readable: wrap(inner.readable), writable: wrap(inner.writable) };
  };

  // Errors whose write stays pending (the stream errors, the write never settles).
  var pendingErrors = new WeakSet();

  var wrongChunk = function () {
    var error = typeError("The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.");
    pendingErrors.add(error);
    return error;
  };

  // A pair (readable, writable) held beside a platform object such as a CompressionStream.
  var pairs = new WeakMap();

  var installPairGetters = function (name) {
    var proto = globalThis[name] && globalThis[name].prototype;
    if (!proto) return;
    patchGetter(proto, "readable", function () {
      var pair = pairs.get(this);
      if (!pair) throw typeError("Illegal invocation");
      return pair.readable;
    });
    patchGetter(proto, "writable", function () {
      var pair = pairs.get(this);
      if (!pair) throw typeError("Illegal invocation");
      return pair.writable;
    });
  };

  // Queuing strategies: their size functions are one shared native-looking function per kind.
  var strategyMarks = new WeakMap();

  var strategyShell = function (name, size) {
    var shared = asNative(size, "size");
    installShell(name, function (args) {
      var init = args[0];
      var where = "Failed to construct '" + name + "': ";
      if (!isObject(init)) throw typeError(where + "The provided value is not of type 'QueuingStrategyInit'.");
      var mark = init.highWaterMark;
      if (mark === undefined) throw typeError(where + "Failed to read the 'highWaterMark' property from 'QueuingStrategyInit': Required member is undefined.");
      var made = Object.create(globalThis[name].prototype);
      strategyMarks.set(made, Number(mark));
      return made;
    }, 1, { required: 1 });
    var proto = globalThis[name].prototype;
    patchGetter(proto, "highWaterMark", function () {
      if (!strategyMarks.has(this)) throw typeError("Illegal invocation");
      return strategyMarks.get(this);
    });
    patchGetter(proto, "size", function () {
      if (!strategyMarks.has(this)) throw typeError("Illegal invocation");
      return shared;
    });
  };

  strategyShell("ByteLengthQueuingStrategy", function (chunk) { return chunk.byteLength; });
  strategyShell("CountQueuingStrategy", function () { return 1; });

  // ---------------------------------------------------------------------------------------------
  // Compression
  // ---------------------------------------------------------------------------------------------

  var compressionShell = function (name, kind) {
    installShell(name, function (args) {
      var format = String(args[0]);
      var opened = bridge.codecOpen(kind, format);
      if (!opened) throw typeError("Failed to construct '" + name + "': Unsupported compression format: '" + format + "'");
      var id = opened.id;
      var finished = false;
      var push = function (bytes, last, enqueue) {
        var answer = bridge.codecPush(id, bytes, last);
        answer.chunks.forEach(enqueue);
        if (last) finished = true;
        if (answer.error) {
          finished = true;
          bridge.codecDrop(id);
          throw typeError(answer.error);
        }
        if (last) bridge.codecDrop(id);
      };
      var pair = platformTransform(function (chunk, enqueue) {
        var bytes = bufferBytes(chunk);
        if (!bytes) throw wrongChunk();
        if (!finished) push(bytes, false, enqueue);
      }, function (enqueue) {
        if (!finished) push(new Uint8Array(0), true, enqueue);
      });
      var made = Object.create(globalThis[name].prototype);
      pairs.set(made, pair);
      return made;
    }, 1, { required: 1 });
    installPairGetters(name);
  };

  compressionShell("CompressionStream", "compress");
  compressionShell("DecompressionStream", "decompress");

  // ---------------------------------------------------------------------------------------------
  // Text encodings
  // ---------------------------------------------------------------------------------------------

  var windowRecord = env.snapshot && env.snapshot.roots && env.snapshot.roots.window && env.snapshot.objects[env.snapshot.roots.window.id];

  // The captured interface for a name the graph left to the realm's own builtins (TextEncoder,
  // TextDecoder): materialised from the capture, so its prototype and members are Chrome's.
  var captured = function (name) {
    var prop = windowRecord && windowRecord.props && windowRecord.props[name];
    if (!prop || !prop.value || prop.value.k !== "ref") return null;
    var made = env.materialize(prop.value.id, "window." + name);
    return typeof made === "function" && made.prototype ? made : null;
  };

  var setGlobal = function (name, value) {
    try {
      Object.defineProperty(globalThis, name, { value: value, writable: true, enumerable: false, configurable: true });
    } catch (error) {}
  };

  // Encodes a string's UTF-16 code units as UTF-8, a lone surrogate as U+FFFD.
  var encodeText = function (text) { return utf8Encode(String(text)); };

  var encoderState = new WeakSet();
  var CapturedEncoder = captured("TextEncoder");

  if (CapturedEncoder) {
    var EncoderShell = installShell("TextEncoder", function () {
      var made = Object.create(CapturedEncoder.prototype);
      encoderState.add(made);
      return made;
    }, 0, { holder: CapturedEncoder });
    setGlobal("TextEncoder", EncoderShell);

    var encoderProto = CapturedEncoder.prototype;
    var ownEncoder = function (self) { if (!encoderState.has(self)) throw typeError("Illegal invocation"); };

    patchGetter(encoderProto, "encoding", function () { ownEncoder(this); return "utf-8"; });
    patch(encoderProto, "encode", function encode(input) {
      ownEncoder(this);
      return encodeText(input === undefined ? "" : input);
    });
    patch(encoderProto, "encodeInto", function encodeInto(source, destination) {
      ownEncoder(this);
      var where = "Failed to execute 'encodeInto' on 'TextEncoder': ";
      if (arguments.length < 2) throw typeError(where + "2 arguments required, but only " + arguments.length + " present.");
      if (!(destination instanceof Uint8Array)) throw typeError(where + "parameter 2 is not of type 'Uint8Array'.");
      var text = String(source);
      var read = 0;
      var written = 0;
      for (var index = 0; index < text.length; ) {
        var code = text.codePointAt(index);
        var units = code > 0xffff ? 2 : 1;
        if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
        var bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        if (written + bytes > destination.length) break;
        var encoded = utf8Encode(String.fromCodePoint(code));
        destination.set(encoded, written);
        written += bytes;
        read += units;
        index += units;
      }
      return { read: read, written: written };
    });
  }

  var decoderState = new WeakMap();

  // A decoder's host handle goes when the page lets the decoder go.
  var decoderHandles = typeof FinalizationRegistry === "function" ? new FinalizationRegistry(function (id) { bridge.codecDrop(id); }) : null;
  var CapturedDecoder = captured("TextDecoder");

  var decoderOptions = function (options, where) {
    if (options === undefined || options === null) return { fatal: false, ignoreBOM: false };
    if (!isObject(options)) throw typeError(where + "The provided value is not of type 'TextDecoderOptions'.");
    return { fatal: Boolean(options.fatal), ignoreBOM: Boolean(options.ignoreBOM) };
  };

  var resolveLabel = function (label, where) {
    var name = label === undefined ? "utf-8" : String(label);
    var encoding = bridge.codecLabel(name);
    if (!encoding) throw rangeError(where + "The encoding label provided ('" + name + "') is invalid.");
    return encoding;
  };

  // A decoder's state: UTF-8 without streaming or fatal checks decodes in the realm; everything
  // else goes to the host's encoding_rs decoder, which keeps partial sequences between calls.
  var openDecoder = function (encoding, fatal, ignoreBOM) {
    return { encoding: encoding, fatal: fatal, ignoreBOM: ignoreBOM, handle: null, streaming: false };
  };

  var hostDecode = function (state, bytes, last) {
    if (state.handle === null) {
      state.handle = bridge.codecOpen("text", state.encoding, state.ignoreBOM).id;
      if (decoderHandles && state.owner) decoderHandles.register(state.owner, state.handle);
    }
    var answer = bridge.codecPush(state.handle, bytes, last, state.fatal);
    if (answer.error) {
      state.streaming = false;
      return null;
    }
    return answer.text;
  };

  var decodeBytes = function (state, bytes, stream) {
    if (!stream && !state.streaming && !state.fatal && state.encoding === "utf-8") {
      var text = utf8Decode(bytes);
      if (!state.ignoreBOM && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return text;
    }
    state.streaming = stream;
    return hostDecode(state, bytes, !stream);
  };

  if (CapturedDecoder) {
    var DecoderShell = installShell("TextDecoder", function (args) {
      var where = "Failed to construct 'TextDecoder': ";
      var encoding = resolveLabel(args[0], where);
      var options = decoderOptions(args[1], where);
      var made = Object.create(CapturedDecoder.prototype);
      var state = openDecoder(encoding, options.fatal, options.ignoreBOM);
      state.owner = made;
      decoderState.set(made, state);
      return made;
    }, 0, { holder: CapturedDecoder });
    setGlobal("TextDecoder", DecoderShell);

    var decoderProto = CapturedDecoder.prototype;
    var ownDecoder = function (self) {
      var state = decoderState.get(self);
      if (!state) throw typeError("Illegal invocation");
      return state;
    };

    patchGetter(decoderProto, "encoding", function () { return ownDecoder(this).encoding; });
    patchGetter(decoderProto, "fatal", function () { return ownDecoder(this).fatal; });
    patchGetter(decoderProto, "ignoreBOM", function () { return ownDecoder(this).ignoreBOM; });

    patch(decoderProto, "decode", function decode(input, options) {
      var state = ownDecoder(this);
      var where = "Failed to execute 'decode' on 'TextDecoder': ";
      var bytes = input === undefined ? new Uint8Array(0) : bufferView(input);
      if (!bytes) throw typeError(where + "parameter 1 is not of type 'ArrayBuffer'.");
      var stream = false;
      if (options !== undefined && options !== null) {
        if (!isObject(options)) throw typeError(where + "The provided value is not of type 'TextDecodeOptions'.");
        stream = Boolean(options.stream);
      }
      var text = decodeBytes(state, bytes, stream);
      if (text === null) throw typeError(where + "The encoded data was not valid.");
      return text;
    });
  }

  env.decodeLabelled = function (bytes, label) {
    var opened = bridge.codecOpen("text-sniff", label || "utf-8");
    var answer = bridge.codecPush(opened.id, bytes, true, false);
    bridge.codecDrop(opened.id);
    return answer.text;
  };

  // TextEncoderStream: a high surrogate at the end of a chunk waits for the next one.
  (function () {
    var name = "TextEncoderStream";
    if (typeof globalThis[name] !== "function") return;
    installShell(name, function () {
      var pending = "";
      var pair = platformTransform(function (chunk, enqueue) {
        var text = pending + String(chunk);
        pending = "";
        var last = text.charCodeAt(text.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          pending = text.slice(-1);
          text = text.slice(0, -1);
        }
        if (text.length) enqueue(encodeText(text));
      }, function (enqueue) {
        if (pending) enqueue(new Uint8Array([0xef, 0xbf, 0xbd]));
      });
      var made = Object.create(globalThis[name].prototype);
      pairs.set(made, pair);
      return made;
    }, 0);
    installPairGetters(name);
    patchGetter(globalThis[name].prototype, "encoding", function () {
      if (!pairs.has(this)) throw typeError("Illegal invocation");
      return "utf-8";
    });
  })();

  (function () {
    var name = "TextDecoderStream";
    if (typeof globalThis[name] !== "function") return;
    var settings = new WeakMap();
    installShell(name, function (args) {
      var where = "Failed to construct '" + name + "': ";
      var encoding = resolveLabel(args[0], where);
      var options = decoderOptions(args[1], where);
      var state = openDecoder(encoding, options.fatal, options.ignoreBOM);
      var invalid = function () { return typeError("The encoded data is not valid."); };
      var pair = platformTransform(function (chunk, enqueue) {
        var bytes = bufferView(chunk);
        if (!bytes) throw wrongChunk();
        var text = hostDecode(state, bytes, false);
        if (text === null) throw invalid();
        if (text.length) enqueue(text);
      }, function (enqueue) {
        var text = hostDecode(state, new Uint8Array(0), true);
        if (text === null) throw invalid();
        if (text.length) enqueue(text);
      });
      var made = Object.create(globalThis[name].prototype);
      state.owner = made;
      pairs.set(made, pair);
      settings.set(made, state);
      return made;
    }, 0);
    installPairGetters(name);
    var proto = globalThis[name].prototype;
    var stateOf = function (self) {
      var state = settings.get(self);
      if (!state) throw typeError("Illegal invocation");
      return state;
    };
    patchGetter(proto, "encoding", function () { return stateOf(this).encoding; });
    patchGetter(proto, "fatal", function () { return stateOf(this).fatal; });
    patchGetter(proto, "ignoreBOM", function () { return stateOf(this).ignoreBOM; });
  })();

  // btoa and atob, with the forgiving-base64 rules and Chrome's errors.
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  patch(globalThis, "btoa", function btoa(data) {
    if (arguments.length < 1) throw typeError("Failed to execute 'btoa' on 'Window': 1 argument required, but only 0 present.");
    var text = String(data);
    var out = "";
    for (var index = 0; index < text.length; index += 3) {
      var a = text.charCodeAt(index);
      var b = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
      var c = index + 2 < text.length ? text.charCodeAt(index + 2) : -1;
      if (a > 255 || b > 255 || c > 255) throw domError("Failed to execute 'btoa' on 'Window': The string to be encoded contains characters outside of the Latin1 range.", "InvalidCharacterError");
      var triple = (a << 16) | ((b < 0 ? 0 : b) << 8) | (c < 0 ? 0 : c);
      out += B64.charAt((triple >> 18) & 63) + B64.charAt((triple >> 12) & 63);
      out += b < 0 ? "=" : B64.charAt((triple >> 6) & 63);
      out += c < 0 ? "=" : B64.charAt(triple & 63);
    }
    return out;
  });

  patch(globalThis, "atob", function atob(data) {
    if (arguments.length < 1) throw typeError("Failed to execute 'atob' on 'Window': 1 argument required, but only 0 present.");
    var bad = function () { return domError("Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded.", "InvalidCharacterError"); };
    var text = String(data).replace(/[\t\n\f\r ]/g, "");
    if (text.length % 4 === 0) text = text.replace(/==?$/, "");
    if (text.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(text)) throw bad();
    var out = "";
    var buffer = 0;
    var bits = 0;
    for (var index = 0; index < text.length; index += 1) {
      buffer = (buffer << 6) | B64.indexOf(text.charAt(index));
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buffer >> bits) & 255);
      }
    }
    return out;
  });

  // ---------------------------------------------------------------------------------------------
  // Blob streams and FileReader
  // ---------------------------------------------------------------------------------------------

  if (globalThis.Blob && globalThis.Blob.prototype) {
    patch(globalThis.Blob.prototype, "stream", function stream() {
      var bytes = env.blobBytes(this);
      if (!bytes) throw typeError("Illegal invocation");
      return bytesStream(bytes);
    });
  }

  var base64Of = function (bytes) {
    var binary = "";
    for (var index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    return globalThis.btoa(binary);
  };

  var latin1Of = function (bytes) {
    var out = "";
    for (var index = 0; index < bytes.length; index += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    return out;
  };

  (function installFileReader() {
    var name = "FileReader";
    if (typeof globalThis[name] !== "function") return;
    var readers = new WeakMap();

    installShell(name, function () {
      var made = Object.create(globalThis[name].prototype);
      readers.set(made, { readyState: 0, result: null, error: null, run: 0 });
      return made;
    }, 0);

    var proto = globalThis[name].prototype;
    var stateOf = function (self) {
      var state = readers.get(self);
      if (!state) throw typeError("Illegal invocation");
      return state;
    };

    var progress = function (reader, type, loaded, total) {
      env.dispatch(reader, env.makeEvent(type, { lengthComputable: true, loaded: loaded, total: total }, "ProgressEvent"));
    };

    var read = function (method, finish) {
      patch(proto, method, function (blob, label) {
        var state = stateOf(this);
        var where = "Failed to execute '" + method + "' on 'FileReader': ";
        if (arguments.length < 1) throw typeError(where + "1 argument required, but only 0 present.");
        var bytes = env.blobBytes(blob);
        if (!bytes) throw typeError(where + "parameter 1 is not of type 'Blob'.");
        if (state.readyState === 1) throw domError(where + "The object is already busy reading Blobs.", "InvalidStateError");
        var type = env.blobTypeOf(blob);
        var reader = this;
        var run = (state.run += 1);
        state.readyState = 1;
        state.result = null;
        state.error = null;
        var size = bytes.length;
        env.later(function () {
          if (state.run !== run) return;
          progress(reader, "loadstart", 0, size);
          env.later(function () {
            if (state.run !== run) return;
            progress(reader, "progress", size, size);
            if (state.run !== run) return;
            state.readyState = 2;
            state.result = finish(bytes, type, label);
            progress(reader, "load", size, size);
            if (state.run === run && state.readyState === 2) progress(reader, "loadend", size, size);
          }, 0);
        }, 0);
      });
    };

    read("readAsArrayBuffer", function (bytes) { return bytes.slice(0).buffer; });
    read("readAsBinaryString", function (bytes) { return latin1Of(bytes); });
    read("readAsText", function (bytes, type, label) { return env.decodeLabelled(bytes, label === undefined ? "utf-8" : String(label)); });
    read("readAsDataURL", function (bytes, type) { return "data:" + (type || "application/octet-stream") + ";base64," + base64Of(bytes); });

    patch(proto, "abort", function abort() {
      var state = stateOf(this);
      if (state.readyState !== 1) return;
      state.run += 1;
      state.readyState = 2;
      state.result = null;
      progress(this, "abort", 0, 0);
      progress(this, "loadend", 0, 0);
    });

    patchGetter(proto, "readyState", function () { return stateOf(this).readyState; });
    patchGetter(proto, "result", function () { return stateOf(this).result; });
    patchGetter(proto, "error", function () { return stateOf(this).error; });
  })();

  // ---------------------------------------------------------------------------------------------
  // Headers, bodies, Request, Response
  // ---------------------------------------------------------------------------------------------

  var TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  var HTTP_SPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g;
  var FORBIDDEN_REQUEST = [
    "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method",
    "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive",
    "origin", "referer", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "via",
  ];

  var forbiddenRequestHeader = function (name) {
    return FORBIDDEN_REQUEST.indexOf(name) !== -1 || name.indexOf("proxy-") === 0 || name.indexOf("sec-") === 0;
  };

  var headerState = new WeakMap();

  var normaliseValue = function (value) { return String(value).replace(HTTP_SPACE, ""); };
  var validValue = function (value) { return !/[\0\r\n]/.test(value); };

  // The header list: [name (lowercase), value] pairs in insertion order, with a guard.
  var headerList = function (headers) { return headerState.get(headers); };

  var appendHeader = function (state, name, value, where) {
    var key = String(name);
    var text = normaliseValue(value);
    if (!TOKEN.test(key)) throw typeError(where + "Invalid name");
    if (!validValue(text) || /[^\x00-\xff]/.test(text)) throw typeError(where + "Invalid value");
    if (state.guard === "immutable") throw typeError(where + "Headers are immutable");
    key = key.toLowerCase();
    if (state.guard === "request" && forbiddenRequestHeader(key)) return;
    for (var index = 0; index < state.list.length; index += 1) {
      if (state.list[index][0] === key && key !== "set-cookie") {
        state.list[index][1] += ", " + text;
        return;
      }
    }
    state.list.push([key, text]);
  };

  var fillHeaders = function (state, init, where) {
    if (init === undefined || init === null) return;
    if (!isObject(init)) throw typeError(where + "The provided value is not of type '(record<ByteString, ByteString> or sequence<sequence<ByteString>>)'.");
    var held = headerState.get(init);
    if (held) {
      held.list.forEach(function (pair) { appendHeader(state, pair[0], pair[1], where); });
      return;
    }
    var iterator = init[Symbol.iterator];
    if (iterator !== undefined && iterator !== null) {
      if (typeof iterator !== "function") throw typeError(where + "The provided value is not of type '(record<ByteString, ByteString> or sequence<sequence<ByteString>>)'.");
      for (var pair of init) {
        if (!isObject(pair)) throw typeError(where + "The provided value cannot be converted to a sequence.");
        var parts = Array.from(pair);
        if (parts.length !== 2) throw typeError(where + "Invalid value");
        appendHeader(state, parts[0], parts[1], where);
      }
      return;
    }
    Object.keys(init).forEach(function (key) { appendHeader(state, key, init[key], where); });
  };

  // Headers as Chrome iterates them: names sorted, each once with its values combined, except
  // set-cookie, whose values stay apart.
  var sortedPairs = function (state) {
    var names = [];
    state.list.forEach(function (pair) { if (names.indexOf(pair[0]) === -1) names.push(pair[0]); });
    names.sort();
    var out = [];
    names.forEach(function (name) {
      if (name === "set-cookie") {
        state.list.forEach(function (pair) { if (pair[0] === name) out.push([name, pair[1]]); });
      } else {
        out.push([name, getHeader(state, name)]);
      }
    });
    return out;
  };

  var getHeader = function (state, name) {
    var values = [];
    state.list.forEach(function (pair) { if (pair[0] === name) values.push(pair[1]); });
    return values.length ? values.join(", ") : null;
  };

  var makeHeaders = function (guard, list) {
    var made = Object.create(globalThis.Headers.prototype);
    headerState.set(made, { guard: guard, list: list || [] });
    return made;
  };

  env.headerPairs = function (headers) {
    var state = headerList(headers);
    return state ? state.list.map(function (pair) { return [pair[0], pair[1]]; }) : null;
  };

  var iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  var headersIteratorProto = Object.create(iteratorPrototype);
  var headerIterators = new WeakMap();

  Object.defineProperty(headersIteratorProto, "next", {
    value: asNative(function next() {
      var held = headerIterators.get(this);
      if (!held) throw typeError("Illegal invocation");
      var pairs = sortedPairs(held.state);
      if (held.index >= pairs.length) return { value: undefined, done: true };
      var pair = pairs[held.index];
      held.index += 1;
      return { value: held.kind === "keys" ? pair[0] : held.kind === "values" ? pair[1] : [pair[0], pair[1]], done: false };
    }, "next"),
    writable: true, enumerable: true, configurable: true,
  });
  Object.defineProperty(headersIteratorProto, Symbol.toStringTag, { value: "Headers Iterator", configurable: true });

  (function installHeaders() {
    if (typeof globalThis.Headers !== "function") return;

    installShell("Headers", function (args) {
      var made = Object.create(globalThis.Headers.prototype);
      var state = { guard: "none", list: [] };
      headerState.set(made, state);
      fillHeaders(state, args[0], "Failed to construct 'Headers': ");
      return made;
    }, 0);

    var proto = globalThis.Headers.prototype;
    var stateOf = function (self) {
      var state = headerState.get(self);
      if (!state) throw typeError("Illegal invocation");
      return state;
    };
    var needs = function (count, given, method) {
      if (given < count) throw typeError("Failed to execute '" + method + "' on 'Headers': " + count + " argument" + (count === 1 ? "" : "s") + " required, but only " + given + " present.");
    };
    var checkName = function (name, method) {
      var key = String(name);
      if (!TOKEN.test(key)) throw typeError("Failed to execute '" + method + "' on 'Headers': Invalid name");
      return key.toLowerCase();
    };

    patch(proto, "append", function append(name, value) {
      needs(2, arguments.length, "append");
      appendHeader(stateOf(this), name, value, "Failed to execute 'append' on 'Headers': ");
    });

    patch(proto, "delete", function (name) {
      var state = stateOf(this);
      needs(1, arguments.length, "delete");
      var key = checkName(name, "delete");
      if (state.guard === "immutable") throw typeError("Failed to execute 'delete' on 'Headers': Headers are immutable");
      state.list = state.list.filter(function (pair) { return pair[0] !== key; });
    });

    patch(proto, "get", function get(name) {
      var state = stateOf(this);
      needs(1, arguments.length, "get");
      return getHeader(state, checkName(name, "get"));
    });

    patch(proto, "getSetCookie", function getSetCookie() {
      var state = stateOf(this);
      return state.list.filter(function (pair) { return pair[0] === "set-cookie"; }).map(function (pair) { return pair[1]; });
    });

    patch(proto, "has", function has(name) {
      var state = stateOf(this);
      needs(1, arguments.length, "has");
      return getHeader(state, checkName(name, "has")) !== null;
    });

    patch(proto, "set", function set(name, value) {
      var state = stateOf(this);
      needs(2, arguments.length, "set");
      var where = "Failed to execute 'set' on 'Headers': ";
      var key = checkName(name, "set");
      var text = normaliseValue(value);
      if (!validValue(text) || /[^\x00-\xff]/.test(text)) throw typeError(where + "Invalid value");
      if (state.guard === "immutable") throw typeError(where + "Headers are immutable");
      if (state.guard === "request" && forbiddenRequestHeader(key)) return;
      var at = -1;
      state.list = state.list.filter(function (pair, index) {
        if (pair[0] !== key) return true;
        if (at === -1) {
          at = index;
          pair[1] = text;
          return true;
        }
        return false;
      });
      if (at === -1) state.list.push([key, text]);
    });

    patch(proto, "forEach", function forEach(callback, thisArg) {
      var state = stateOf(this);
      if (typeof callback !== "function") throw typeError("Failed to execute 'forEach' on 'Headers': The callback provided as parameter 1 is not a function.");
      var pairs = sortedPairs(state);
      for (var index = 0; index < pairs.length; index += 1) callback.call(thisArg, pairs[index][1], pairs[index][0], this);
    });

    ["entries", "keys", "values"].forEach(function (kind) {
      patch(proto, kind, function () {
        var made = Object.create(headersIteratorProto);
        headerIterators.set(made, { state: stateOf(this), kind: kind, index: 0 });
        return made;
      });
    });

    try {
      Object.defineProperty(proto, Symbol.iterator, { value: proto.entries, writable: true, enumerable: false, configurable: true });
    } catch (error) {}
  })();

  // A body: its source bytes (or a stream the page gave) and the stream the page reads, made the
  // first time it is asked for or read.
  var NULL_BODY = [101, 103, 204, 205, 304];

  var extractBody = function (body, keepalive) {
    if (body === null || body === undefined) return null;

    var stream = engine(body, "ReadableStream");
    if (stream) return { bytes: null, stream: body, type: null };

    var bytes = env.blobBytes(body);
    if (bytes) {
      var blobType = env.blobTypeOf(body);
      return { bytes: bytes, stream: null, type: blobType || null };
    }

    var buffer = bufferBytes(body);
    if (buffer) return { bytes: buffer, stream: null, type: null };

    if (globalThis.URLSearchParams && body instanceof globalThis.URLSearchParams) {
      return { bytes: encodeText(body.toString()), stream: null, type: "application/x-www-form-urlencoded;charset=UTF-8" };
    }

    if (globalThis.FormData && body instanceof globalThis.FormData) {
      var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      var boundary = "----WebKitFormBoundary" + String(bridge.random(16)).match(/../g).map(function (pair) { return alphabet.charAt(parseInt(pair, 16) % alphabet.length); }).join("");
      var parts = [];
      body.forEach(function (value, name) {
        var head = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + String(name).replace(/"/g, "%22") + "\"";
        if (env.blobBytes(value)) {
          var filename = value.name === undefined ? "blob" : value.name;
          parts.push(encodeText(head + "; filename=\"" + String(filename).replace(/"/g, "%22") + "\"\r\nContent-Type: " + (env.blobTypeOf(value) || "application/octet-stream") + "\r\n\r\n"));
          parts.push(env.blobBytes(value));
          parts.push(encodeText("\r\n"));
        } else {
          parts.push(encodeText(head + "\r\n\r\n" + String(value) + "\r\n"));
        }
      });
      parts.push(encodeText("--" + boundary + "--\r\n"));
      return { bytes: joinBytes(parts), stream: null, type: "multipart/form-data; boundary=" + boundary };
    }

    var text = String(body);
    return { bytes: encodeText(text), stream: null, type: "text/plain;charset=UTF-8", text: text };
  };

  var bodyStream = function (state) {
    if (!state.body) return null;
    if (!state.body.stream) state.body.stream = bytesStream(state.body.bytes);
    return state.body.stream;
  };

  var bodyUsed = function (state) {
    if (!state.body || !state.body.stream) return false;
    return Boolean(engine(state.body.stream, "ReadableStream")._disturbed);
  };

  var bodyLocked = function (state) {
    return Boolean(state.body && state.body.stream && engine(state.body.stream, "ReadableStream").locked);
  };

  // Reads a body to its end: its bytes, or a rejection in Chrome's words.
  var consume = function (state, where) {
    if (bodyLocked(state)) return rejected(typeError(where + "body stream is locked"));
    if (bodyUsed(state)) return rejected(typeError(where + "body stream already read"));
    if (!state.body) return resolved(new Uint8Array(0));
    var inner = engine(bodyStream(state), "ReadableStream");
    var reader = inner.getReader();
    var chunks = [];
    var pump = function () {
      return nativeThen.call(reader.read(), function (result) {
        if (result.done) {
          reader.releaseLock();
          return joinBytes(chunks);
        }
        var bytes = bufferView(result.value);
        if (!bytes) throw typeError("Failed to fetch");
        chunks.push(new Uint8Array(bytes));
        return pump();
      });
    };
    return pump();
  };

  var contentType = function (state) {
    return getHeader(headerList(state.headers), "content-type");
  };

  var parseUrlEncoded = function (text) {
    var form = new globalThis.FormData();
    new globalThis.URLSearchParams(text).forEach(function (value, name) { form.append(name, value); });
    return form;
  };

  var installBody = function (name, stateOf) {
    var proto = globalThis[name].prototype;
    var where = function (method) { return "Failed to execute '" + method + "' on '" + name + "': "; };
    var reading = function (method, finish) {
      patch(proto, method, function () {
        var state;
        try {
          state = stateOf(this);
        } catch (error) {
          return rejected(error);
        }
        var prefix = where(method);
        return nativeThen.call(consume(state, prefix), function (bytes) { return finish(bytes, state, prefix); });
      });
    };

    patchGetter(proto, "body", function () { return bodyStream(stateOf(this)); });
    patchGetter(proto, "bodyUsed", function () { return bodyUsed(stateOf(this)); });

    reading("arrayBuffer", function (bytes) { return bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice(0).buffer; });
    reading("blob", function (bytes, state) {
      var type = contentType(state);
      return env.makeBlob(bytes, type === null ? "" : type);
    });
    reading("bytes", function (bytes) { return bytes; });
    reading("text", function (bytes) { return utf8Decode(bytes).replace(/^﻿/, ""); });
    reading("json", function (bytes, state, prefix) {
      try {
        return JSON.parse(utf8Decode(bytes).replace(/^﻿/, ""));
      } catch (error) {
        throw hide(new SyntaxError(prefix + error.message));
      }
    });
    reading("formData", function (bytes, state) {
      var type = String(contentType(state) || "").toLowerCase();
      if (type.indexOf("application/x-www-form-urlencoded") === 0) return parseUrlEncoded(utf8Decode(bytes));
      throw typeError("Failed to fetch");
    });

    if (typeof proto.textStream === "function") {
      patch(proto, "textStream", function textStream() {
        var state = stateOf(this);
        var prefix = where("textStream");
        if (bodyLocked(state)) throw typeError(prefix + "body stream is locked");
        if (bodyUsed(state)) throw typeError(prefix + "body stream already read");
        var source = bodyStream(state) || bytesStream(new Uint8Array(0));
        return source.pipeThrough(new globalThis.TextDecoderStream());
      });
    }
  };

  // A body's copy for clone(): a stream tees (this side keeps one branch), bytes are shared.
  var cloneBody = function (state) {
    if (!state.body) return null;
    if (!state.body.stream) return { bytes: state.body.bytes, stream: null, type: state.body.type, text: state.body.text };
    var branches = engine(state.body.stream, "ReadableStream").tee();
    state.body.stream = wrap(branches[0]);
    return { bytes: null, stream: wrap(branches[1]), type: state.body.type };
  };

  // Response
  var responseState = new WeakMap();
  var STATUS_TEXT = /^[\t\x20-\x7e\x80-\xff]*$/;

  var responseOf = function (self) {
    var state = responseState.get(self);
    if (!state) throw typeError("Illegal invocation");
    return state;
  };

  var makeResponse = function (fields) {
    var made = Object.create(globalThis.Response.prototype);
    var state = {
      type: fields.type || "default",
      url: fields.url || "",
      redirected: Boolean(fields.redirected),
      status: fields.status === undefined ? 200 : fields.status,
      statusText: fields.statusText || "",
      headers: makeHeaders(fields.guard || "response", fields.headers),
      body: fields.body || null,
    };
    responseState.set(made, state);
    return made;
  };

  env.makeResponse = makeResponse;

  var readResponseInit = function (init, where) {
    if (init === undefined || init === null) return { status: 200, statusText: "", headers: undefined };
    if (!isObject(init)) throw typeError(where + "The provided value is not of type 'ResponseInit'.");
    var headers = init.headers;
    var status = init.status === undefined ? 200 : Number(init.status) & 0xffff;
    var statusText = init.statusText === undefined ? "" : String(init.statusText);
    if (status < 200 || status > 599) throw rangeError(where + "The status provided (" + status + ") is outside the range [200, 599].");
    if (!STATUS_TEXT.test(statusText)) throw typeError(where + "Invalid statusText");
    return { status: status, statusText: statusText, headers: headers };
  };

  (function installResponse() {
    if (typeof globalThis.Response !== "function") return;

    installShell("Response", function (args) {
      var where = "Failed to construct 'Response': ";
      var body = extractBody(args[0]);
      var init = readResponseInit(args[1], where);
      if (body && NULL_BODY.indexOf(init.status) !== -1) throw typeError(where + "Response with null body status cannot have body");
      var made = makeResponse({ status: init.status, statusText: init.statusText, body: body });
      var state = responseState.get(made);
      fillHeaders(headerList(state.headers), init.headers, where);
      if (body && body.type && getHeader(headerList(state.headers), "content-type") === null) headerList(state.headers).list.push(["content-type", body.type]);
      return made;
    }, 0);

    var Shell = globalThis.Response;
    var proto = Shell.prototype;

    patchGetter(proto, "type", function () { return responseOf(this).type; });
    patchGetter(proto, "url", function () { return responseOf(this).url; });
    patchGetter(proto, "redirected", function () { return responseOf(this).redirected; });
    patchGetter(proto, "status", function () { return responseOf(this).status; });
    patchGetter(proto, "ok", function () { var status = responseOf(this).status; return status >= 200 && status <= 299; });
    patchGetter(proto, "statusText", function () { return responseOf(this).statusText; });
    patchGetter(proto, "headers", function () { return responseOf(this).headers; });

    installBody("Response", responseOf);

    patch(proto, "clone", function clone() {
      var state = responseOf(this);
      if (bodyUsed(state) || bodyLocked(state)) throw typeError("Failed to execute 'clone' on 'Response': Response body is already used");
      var guard = headerList(state.headers).guard;
      return makeResponse({
        type: state.type, url: state.url, redirected: state.redirected, status: state.status, statusText: state.statusText,
        guard: guard, headers: headerList(state.headers).list.map(function (pair) { return [pair[0], pair[1]]; }), body: cloneBody(state),
      });
    });

    patch(Shell, "error", function error() {
      return makeResponse({ type: "error", status: 0, guard: "immutable" });
    });

    patch(Shell, "json", function json(data, init) {
      var where = "Failed to execute 'json' on 'Response': ";
      if (arguments.length < 1) throw typeError(where + "1 argument required, but only 0 present.");
      var text = JSON.stringify(data);
      if (text === undefined) throw typeError(where + "The data is not JSON serializable");
      var read = readResponseInit(init, where);
      if (NULL_BODY.indexOf(read.status) !== -1) throw typeError(where + "Response with null body status cannot have body");
      var made = makeResponse({ status: read.status, statusText: read.statusText, body: { bytes: encodeText(text), stream: null, type: "application/json" } });
      var list = headerList(responseState.get(made).headers);
      fillHeaders(list, read.headers, where);
      if (getHeader(list, "content-type") === null) list.list.push(["content-type", "application/json"]);
      return made;
    });

    patch(Shell, "redirect", function redirect(url, status) {
      var where = "Failed to execute 'redirect' on 'Response': ";
      if (arguments.length < 1) throw typeError(where + "1 argument required, but only 0 present.");
      var href = parseHref(url);
      if (href === null) throw typeError(where + "Failed to parse URL from " + String(url));
      var code = status === undefined ? 302 : Number(status) & 0xffff;
      if ([301, 302, 303, 307, 308].indexOf(code) === -1) throw rangeError(where + "Invalid status code");
      return makeResponse({ status: code, guard: "immutable", headers: [["location", href]] });
    });
  })();

  // Request
  var requestState = new WeakMap();

  var requestOf = function (self) {
    var state = requestState.get(self);
    if (!state) throw typeError("Illegal invocation");
    return state;
  };

  env.requestOf = function (request) { return requestState.get(request) || null; };

  var pageHref = function () {
    try {
      return String(globalThis.location.href);
    } catch (error) {
      return "about:blank";
    }
  };

  // A URL as Chrome parses it for fetch and XHR: the WHATWG parser, except that Chrome takes a
  // space in a host as %20 where the standard refuses it.
  var parseHref = function (input) {
    var text = String(input);
    var hrefOf = function (value) {
      var parsed = bridge.parseUrl(value, pageHref());
      return parsed ? parsed.href : null;
    };
    var href = hrefOf(text);
    if (href === null && / /.test(text)) {
      var mark = "wrespace" + String(bridge.random(4));
      var spaced = hrefOf(text.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i, function (host) { return host.replace(/ /g, mark); }));
      if (spaced !== null) href = spaced.split(mark).join("%20");
    }
    return href;
  };

  var METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"];

  var normaliseMethod = function (method, where) {
    var text = String(method);
    if (!TOKEN.test(text)) throw typeError(where + "'" + text + "' is not a valid HTTP method.");
    var upper = text.toUpperCase();
    if (upper === "CONNECT" || upper === "TRACE" || upper === "TRACK") throw typeError(where + "'" + text + "' HTTP method is unsupported.");
    return METHODS.indexOf(upper) !== -1 ? upper : text;
  };

  var ENUMS = {
    mode: ["same-origin", "no-cors", "cors", "navigate"],
    credentials: ["omit", "same-origin", "include"],
    cache: ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"],
    redirect: ["follow", "error", "manual"],
    duplex: ["half"],
    priority: ["high", "low", "auto"],
    referrerPolicy: ["", "no-referrer", "no-referrer-when-downgrade", "same-origin", "origin", "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url"],
  };

  var ENUM_TYPES = {
    mode: "RequestMode", credentials: "RequestCredentials", cache: "RequestCache", redirect: "RequestRedirect",
    duplex: "RequestDuplex", priority: "RequestPriority", referrerPolicy: "ReferrerPolicy",
  };

  // The RequestInit members, in the order Chrome reads them.
  var INIT_KEYS = [
    "adAuctionHeaders", "attributionReporting", "body", "browsingTopics", "cache", "credentials", "duplex",
    "headers", "integrity", "keepalive", "method", "mode", "priority", "privateToken", "redirect", "referrer",
    "referrerPolicy", "sharedStorageWritable", "signal", "targetAddressSpace",
  ];

  var HAS_CHECKED = { attributionReporting: true };

  var readRequestInit = function (init, where) {
    var out = {};
    if (init === undefined || init === null) return out;
    if (!isObject(init)) throw typeError(where + "The provided value is not of type 'RequestInit'.");
    for (var index = 0; index < INIT_KEYS.length; index += 1) {
      var key = INIT_KEYS[index];
      var value = init[key];
      // The profile's Chrome has Attribution Reporting on, and its binding also asks whether the
      // member is present.
      if (HAS_CHECKED[key]) void (key in init);
      if (value === undefined) continue;
      if (ENUMS[key]) {
        var text = String(value);
        if (ENUMS[key].indexOf(text) === -1) {
          throw typeError(where + "Failed to read the '" + key + "' property from 'RequestInit': The provided value '" + text + "' is not a valid enum value of type " + ENUM_TYPES[key] + ".");
        }
        value = text;
      }
      if (key === "signal" && value !== null && !(env.signalState && isObject(value) && env.signalState.has(value))) {
        throw typeError(where + "Failed to read the 'signal' property from 'RequestInit': Failed to convert value to 'AbortSignal'.");
      }
      out[key] = value;
    }
    return out;
  };

  var buildRequest = function (input, init, where) {
    var source = isObject(input) ? requestState.get(input) : undefined;
    var read = readRequestInit(init, where);
    var href;

    if (source) {
      href = source.url;
    } else {
      href = parseHref(input);
      if (href === null) throw typeError(where + "Failed to parse URL from " + String(input));
      if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(href)) throw typeError(where + "Request cannot be constructed from a URL that includes credentials: " + String(input));
    }

    if (source && (bodyUsed(source) || bodyLocked(source))) {
      throw typeError(where + "Cannot construct a Request with a Request object that has already been used.");
    }

    if (read.mode === "navigate") throw typeError(where + "Cannot construct a Request with a RequestInit whose mode member is set as 'navigate'.");

    var method = read.method !== undefined ? normaliseMethod(read.method, where) : source ? source.method : "GET";
    var state = {
      url: href.replace(/#.*$/, ""),
      method: method,
      mode: read.mode || (source ? source.mode : "cors"),
      credentials: read.credentials || (source ? source.credentials : "same-origin"),
      cache: read.cache || (source ? source.cache : "default"),
      redirect: read.redirect || (source ? source.redirect : "follow"),
      referrer: read.referrer !== undefined ? (String(read.referrer) === "" ? "" : "about:client") : source ? source.referrer : "about:client",
      referrerPolicy: read.referrerPolicy !== undefined ? read.referrerPolicy : source ? source.referrerPolicy : "",
      integrity: read.integrity !== undefined ? String(read.integrity) : source ? source.integrity : "",
      keepalive: read.keepalive !== undefined ? Boolean(read.keepalive) : source ? source.keepalive : false,
      duplex: "half",
      priority: read.priority || (source ? source.priority : "auto"),
      targetAddressSpace: source ? source.targetAddressSpace : "unknown",
      signal: env.makeSignal(),
      headers: makeHeaders("request"),
      body: null,
    };

    var follows = read.signal !== undefined ? read.signal : source ? source.signal : null;
    if (follows) {
      var upstream = env.signalState.get(follows);
      if (upstream.aborted) env.abortSignal(state.signal, upstream.reason);
      else upstream.algorithms.push(function () { env.abortSignal(state.signal, upstream.reason); });
    }

    var list = headerList(state.headers);
    if (read.headers !== undefined) fillHeaders(list, read.headers, where);
    else if (source) headerList(source.headers).list.forEach(function (pair) { list.list.push([pair[0], pair[1]]); });

    var body = read.body !== undefined ? read.body : null;
    if ((body !== null || (source && source.body && read.body === undefined)) && (method === "GET" || method === "HEAD")) {
      throw typeError(where + "Request with GET/HEAD method cannot have body.");
    }

    if (read.body !== undefined && body !== null) {
      state.body = extractBody(body, state.keepalive);
      if (state.body.type && getHeader(list, "content-type") === null) list.list.push(["content-type", state.body.type]);
    } else if (source && source.body && read.body === undefined) {
      state.body = source.body;
      source.body = { bytes: new Uint8Array(0), stream: (function () { var used = bytesStream(new Uint8Array(0)); engine(used, "ReadableStream")._disturbed = true; return used; })(), type: null };
    }

    return state;
  };

  (function installRequest() {
    if (typeof globalThis.Request !== "function") return;

    installShell("Request", function (args) {
      var made = Object.create(globalThis.Request.prototype);
      requestState.set(made, buildRequest(args[0], args[1], "Failed to construct 'Request': "));
      return made;
    }, 1, { required: 1 });

    var proto = globalThis.Request.prototype;
    var fields = ["method", "url", "mode", "credentials", "cache", "redirect", "referrerPolicy", "integrity", "keepalive", "duplex", "signal", "headers", "targetAddressSpace"];
    fields.forEach(function (field) {
      patchGetter(proto, field, function () { return requestOf(this)[field]; });
    });
    patchGetter(proto, "referrer", function () { return requestOf(this).referrer; });
    patchGetter(proto, "destination", function () { requestOf(this); return ""; });
    patchGetter(proto, "isHistoryNavigation", function () { requestOf(this); return false; });
    patchGetter(proto, "isReloadNavigation", function () { requestOf(this); return false; });

    installBody("Request", requestOf);

    patch(proto, "clone", function clone() {
      var state = requestOf(this);
      if (bodyUsed(state) || bodyLocked(state)) throw typeError("Failed to execute 'clone' on 'Request': Request body is already used");
      var made = Object.create(globalThis.Request.prototype);
      var copy = {};
      for (var key in state) copy[key] = state[key];
      copy.headers = makeHeaders("request", headerList(state.headers).list.map(function (pair) { return [pair[0], pair[1]]; }));
      copy.signal = env.makeSignal();
      var upstream = env.signalState.get(state.signal);
      if (upstream.aborted) env.abortSignal(copy.signal, upstream.reason);
      else upstream.algorithms.push(function () { env.abortSignal(copy.signal, upstream.reason); });
      copy.body = cloneBody(state);
      requestState.set(made, copy);
      return made;
    });
  })();

  // ---------------------------------------------------------------------------------------------
  // Local answers: data: and blob: URLs, which never reach the network
  // ---------------------------------------------------------------------------------------------

  var percentDecode = function (text) {
    var bytes = [];
    var raw = utf8Encode(text);
    for (var index = 0; index < raw.length; index += 1) {
      var byte = raw[index];
      if (byte === 0x25 && index + 2 < raw.length) {
        var hex = String.fromCharCode(raw[index + 1], raw[index + 2]);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          index += 2;
          continue;
        }
      }
      bytes.push(byte);
    }
    return Uint8Array.from(bytes);
  };

  var forgivingBase64 = function (bytes) {
    try {
      var binary = globalThis.atob(latin1Of(bytes));
      var out = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
      return out;
    } catch (error) {
      return null;
    }
  };

  // A data: URL's {type, bytes}, or null when it is malformed (as the Fetch standard reads it).
  var readDataUrl = function (href) {
    var rest = href.slice(5).replace(/#.*$/, "");
    var comma = rest.indexOf(",");
    if (comma === -1) return null;
    var head = rest.slice(0, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    var bytes = percentDecode(rest.slice(comma + 1));
    var base64 = /;[\x20]*base64$/i.test(head);
    if (base64) {
      head = head.replace(/;[\x20]*base64$/i, "");
      bytes = forgivingBase64(bytes);
      if (!bytes) return null;
    }
    var type = head.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    if (type.indexOf(";") === 0) type = "text/plain" + type;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+/.test(type)) type = "text/plain;charset=US-ASCII";
    return { type: type, bytes: bytes };
  };

  // What a local (data: or blob:) request answers: {status, statusText, headers, bytes}, or null
  // for a network error; undefined when the URL is not local.
  var localAnswer = function (method, href, rangeHeader) {
    if (/^data:/i.test(href)) {
      var data = readDataUrl(href);
      if (!data) return null;
      return { status: 200, statusText: "OK", headers: [["content-type", data.type]], bytes: data.bytes, local: true };
    }

    if (/^blob:/i.test(href)) {
      if (method !== "GET") return null;
      var blob = env.objectUrls ? env.objectUrls.get(href.replace(/#.*$/, "")) : undefined;
      var bytes = blob ? env.blobBytes(blob) : null;
      if (!bytes) return null;
      var type = env.blobTypeOf(blob);
      var headers = [];
      var status = 200;
      var range = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.replace(/\s/g, ""));
      if (rangeHeader && !range) return null;
      if (range) {
        var size = bytes.length;
        var first = range[1] === "" ? Math.max(size - Number(range[2]), 0) : Number(range[1]);
        var last = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
        if (first > last || first >= size) return null;
        bytes = bytes.slice(first, last + 1);
        status = 206;
        headers.push(["content-length", String(bytes.length)]);
        if (type) headers.push(["content-type", type]);
        headers.push(["content-range", "bytes " + first + "-" + last + "/" + size]);
      } else {
        headers.push(["content-length", String(bytes.length)]);
        if (type) headers.push(["content-type", type]);
      }
      return { status: status, statusText: "OK", headers: headers, bytes: bytes, local: true };
    }

    return undefined;
  };

  var NETWORK = /^https?:/i;

  var originOf = function (href) {
    var match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(href);
    return match ? match[1].toLowerCase() : "null";
  };

  var pageOrigin = function () {
    try {
      return String(globalThis.location.origin).toLowerCase();
    } catch (error) {
      return "null";
    }
  };

  // The headers a network answer gives the page: the transport's [name, value] pairs, without
  // Set-Cookie (a page never sees it).
  var answerHeaders = function (pairs) {
    var out = [];
    (pairs || []).forEach(function (pair) {
      var name = String(pair[0]).toLowerCase();
      if (name === "set-cookie" || name === "set-cookie2") return;
      out.push([name, String(pair[1])]);
    });
    return out;
  };

  var headersObject = function (list) {
    var out = {};
    list.forEach(function (pair) {
      out[pair[0]] = out[pair[0]] === undefined ? pair[1] : out[pair[0]] + ", " + pair[1];
    });
    return out;
  };

  // Sends a request over the realm's transport; `done(answer)` gets {status, headers, text} or
  // null on a network failure, as a task.
  var send = function (method, href, headers, bytes, done) {
    bridge.request(method, href, JSON.stringify(headersObject(headers)), bytes, function (status, headerJson, text) {
      if (!status) {
        done(null);
        return;
      }
      var parsed = {};
      try {
        parsed = JSON.parse(headerJson);
      } catch (error) {}
      done({ status: status, headers: Object.keys(parsed).map(function (name) { return [name, parsed[name]]; }), text: text });
    });
  };

  // What goes on the wire for a request body: its text when the page gave a string (a transport
  // reads it as text), else its bytes.
  var bodyBytes = function (state) {
    if (!state.body) return resolved(null);
    if (state.body.text !== undefined && !state.body.stream) return resolved(state.body.text);
    if (state.body.bytes && !state.body.stream) return resolved(state.body.bytes);
    return consume(state, "");
  };

  // ---------------------------------------------------------------------------------------------
  // fetch
  // ---------------------------------------------------------------------------------------------

  var failedToFetch = function () { return typeError("Failed to fetch"); };

  patch(globalThis, "fetch", function fetch(input, init) {
    var where = "Failed to execute 'fetch' on 'Window': ";
    if (arguments.length < 1) return rejected(typeError(where + "1 argument required, but only 0 present."));

    var state;
    try {
      state = buildRequest(input, init, where);
    } catch (error) {
      return rejected(error);
    }

    var signal = env.signalState.get(state.signal);
    if (signal.aborted) return rejected(signal.reason);

    env.record("fetch", { url: state.url, method: state.method });

    return new Promise(function (resolve, reject) {
      var settled = false;
      var finish = function (value, failed) {
        if (settled) return;
        settled = true;
        if (failed) reject(value);
        else resolve(value);
      };

      signal.algorithms.push(function () { finish(signal.reason, true); });

      var href = state.url;
      var local = localAnswer(state.method, href, getHeader(headerList(state.headers), "range"));

      if (local === null) {
        env.later(function () { finish(failedToFetch(), true); }, 0);
        return;
      }

      if (local !== undefined) {
        env.later(function () {
          finish(makeResponse({
            type: "basic", url: href, status: local.status, statusText: local.statusText, guard: "immutable", headers: local.headers,
            body: { bytes: local.bytes, stream: null, type: null },
          }));
        }, 0);
        return;
      }

      if (!NETWORK.test(href)) {
        env.later(function () { finish(failedToFetch(), true); }, 0);
        return;
      }

      var sameOrigin = originOf(href) === pageOrigin();

      nativeThen.call(bodyBytes(state), function (bytes) {
        if (settled) return;
        send(state.method, href, headerList(state.headers).list, bytes, function (answer) {
          if (!answer) {
            finish(failedToFetch(), true);
            return;
          }
          if (!sameOrigin && state.mode === "no-cors") {
            finish(makeResponse({ type: "opaque", status: 0, guard: "immutable" }));
            return;
          }
          var nullBody = state.method === "HEAD" || NULL_BODY.indexOf(answer.status) !== -1;
          finish(makeResponse({
            type: sameOrigin ? "basic" : "cors", url: href, status: answer.status, statusText: "", guard: "immutable",
            headers: answerHeaders(answer.headers), body: nullBody ? null : { bytes: utf8Encode(answer.text || ""), stream: null, type: null },
          }));
        });
      }, function (error) { finish(error, true); });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // XMLHttpRequest
  // ---------------------------------------------------------------------------------------------

  (function installXhr() {
    var name = "XMLHttpRequest";
    if (typeof globalThis[name] !== "function") return;

    var requests = new WeakMap();
    var uploads = new WeakMap();

    var fresh = function () {
      return {
        readyState: 0, method: "GET", url: "", async: true, headers: [], sendFlag: false, timeout: 0, withCredentials: false,
        responseType: "", mime: null, status: 0, statusText: "", responseURL: "", responseHeaders: [], bytes: null,
        text: "", error: false, run: 0, jsonCache: undefined, bufferCache: null, blobCache: null,
      };
    };

    installShell(name, function () {
      var made = Object.create(globalThis[name].prototype);
      requests.set(made, fresh());
      return made;
    }, 0);

    var proto = globalThis[name].prototype;
    var stateOf = function (self) {
      var state = requests.get(self);
      if (!state) throw typeError("Illegal invocation");
      return state;
    };
    var fire = function (target, type) { env.dispatch(target, env.makeEvent(type)); };
    var progress = function (target, type, loaded, total, computable) {
      env.dispatch(target, env.makeEvent(type, { lengthComputable: Boolean(computable), loaded: loaded, total: total }, "ProgressEvent"));
    };
    var changeState = function (xhr, state, next) {
      state.readyState = next;
      fire(xhr, "readystatechange");
    };

    patch(proto, "open", function open(method, url, async, user, password) {
      var state = stateOf(this);
      var where = "Failed to execute 'open' on 'XMLHttpRequest': ";
      if (arguments.length < 2) throw typeError(where + "2 arguments required, but only " + arguments.length + " present.");
      var text = String(method);
      if (!TOKEN.test(text)) throw domError(where + "'" + text + "' is not a valid HTTP method.", "SyntaxError");
      var upper = text.toUpperCase();
      if (upper === "CONNECT" || upper === "TRACE" || upper === "TRACK") throw domError(where + "'" + text + "' HTTP method is unsupported.", "SecurityError");
      var href = parseHref(url);
      if (href === null) throw domError(where + "Invalid URL", "SyntaxError");
      var asynchronous = arguments.length < 3 ? true : Boolean(async);
      if (!asynchronous && state.timeout) throw domError(where + "Synchronous requests must not set a timeout.", "InvalidAccessError");
      state.run += 1;
      state.method = METHODS.indexOf(upper) !== -1 ? upper : text;
      state.url = href;
      state.async = asynchronous;
      state.headers = [];
      state.sendFlag = false;
      state.status = 0;
      state.statusText = "";
      state.responseURL = "";
      state.responseHeaders = [];
      state.bytes = null;
      state.text = "";
      state.error = false;
      state.jsonCache = undefined;
      state.bufferCache = null;
      state.blobCache = null;
      if (state.readyState !== 1) changeState(this, state, 1);
    });

    patch(proto, "setRequestHeader", function setRequestHeader(header, value) {
      var state = stateOf(this);
      var where = "Failed to execute 'setRequestHeader' on 'XMLHttpRequest': ";
      if (arguments.length < 2) throw typeError(where + "2 arguments required, but only " + arguments.length + " present.");
      if (state.readyState !== 1 || state.sendFlag) throw domError(where + "The object's state must be OPENED.", "InvalidStateError");
      var key = String(header);
      if (!TOKEN.test(key)) throw domError(where + "'" + key + "' is not a valid HTTP header field name.", "SyntaxError");
      var text = normaliseValue(value);
      if (!validValue(text)) throw domError(where + "'" + text + "' is not a valid HTTP header field value.", "SyntaxError");
      var lower = key.toLowerCase();
      if (forbiddenRequestHeader(lower)) return;
      for (var index = 0; index < state.headers.length; index += 1) {
        if (state.headers[index][0] === lower) {
          state.headers[index][1] += ", " + text;
          return;
        }
      }
      state.headers.push([lower, text]);
    });

    var deliver = function (xhr, state, run, answer) {
      if (state.run !== run) return;
      if (!answer) {
        state.error = true;
        state.sendFlag = false;
        changeState(xhr, state, 4);
        if (state.run !== run) return;
        progress(xhr, "error", 0, 0, false);
        progress(xhr, "loadend", 0, 0, false);
        return;
      }
      state.status = answer.status;
      state.statusText = answer.statusText;
      state.responseURL = state.url.replace(/#.*$/, "");
      state.responseHeaders = answer.headers;
      var bytes = answer.bytes;
      var length = getHeader({ list: answer.headers }, "content-length");
      var total = answer.local ? bytes.length : length === null ? 0 : Number(length);
      var computable = answer.local || length !== null;
      changeState(xhr, state, 2);
      if (state.run !== run) return;
      state.bytes = bytes;
      state.text = utf8Decode(bytes);
      changeState(xhr, state, 3);
      if (state.run !== run) return;
      progress(xhr, "progress", bytes.length, total, computable);
      if (state.run !== run) return;
      state.sendFlag = false;
      changeState(xhr, state, 4);
      if (state.run !== run) return;
      progress(xhr, "load", bytes.length, total, computable);
      progress(xhr, "loadend", bytes.length, total, computable);
    };

    patch(proto, "send", function send(body) {
      var state = stateOf(this);
      var where = "Failed to execute 'send' on 'XMLHttpRequest': ";
      if (state.readyState !== 1 || state.sendFlag) throw domError(where + "The object's state must be OPENED.", "InvalidStateError");
      var xhr = this;
      var run = state.run;
      var payload = null;

      if (state.method !== "GET" && state.method !== "HEAD" && body !== undefined && body !== null) {
        var extracted = extractBody(body);
        payload = extracted.text !== undefined ? extracted.text : extracted.bytes || new Uint8Array(0);
        var declared = getHeader({ list: state.headers }, "content-type");
        if (declared === null && extracted.type) state.headers.push(["content-type", extracted.type]);
        else if (declared !== null && typeof body === "string" && /;\s*charset=/i.test(declared)) {
          state.headers.forEach(function (pair) { if (pair[0] === "content-type") pair[1] = pair[1].replace(/(;\s*charset=)[^;]*/i, "$1UTF-8"); });
        }
      }

      env.record("xhr", { method: state.method, url: state.url, headers: headersObject(state.headers), bytes: payload ? payload.length : 0 });

      var local = localAnswer(state.method, state.url, getHeader({ list: state.headers }, "range"));
      var answerOf = function (raw) {
        if (!raw) return null;
        return { status: raw.status, statusText: "", headers: answerHeaders(raw.headers), bytes: utf8Encode(raw.text || "") };
      };

      if (!state.async) {
        state.sendFlag = true;
        var now;
        if (local !== undefined) now = local;
        else if (!NETWORK.test(state.url)) now = null;
        else {
          var raw = bridge.requestNow(state.method, state.url, JSON.stringify(headersObject(state.headers)), payload);
          now = raw && raw.status ? answerOf({ status: raw.status, headers: raw.headers, text: raw.body }) : null;
        }
        if (!now) {
          state.sendFlag = false;
          state.readyState = 4;
          fire(xhr, "readystatechange");
          throw domError(where + "Failed to load '" + state.url + "'.", "NetworkError");
        }
        state.status = now.status;
        state.statusText = now.statusText;
        state.responseURL = state.url.replace(/#.*$/, "");
        state.responseHeaders = now.headers;
        state.bytes = now.bytes;
        state.text = utf8Decode(now.bytes);
        state.sendFlag = false;
        changeState(xhr, state, 4);
        progress(xhr, "load", now.bytes.length, now.bytes.length, true);
        progress(xhr, "loadend", now.bytes.length, now.bytes.length, true);
        return;
      }

      state.sendFlag = true;
      progress(xhr, "loadstart", 0, 0, false);
      if (state.run !== run) return;

      if (state.timeout > 0) {
        env.later(function () {
          if (state.run !== run || state.readyState === 4) return;
          state.run += 1;
          state.error = true;
          state.sendFlag = false;
          changeState(xhr, state, 4);
          progress(xhr, "timeout", 0, 0, false);
          progress(xhr, "loadend", 0, 0, false);
        }, state.timeout);
      }

      if (local !== undefined) {
        env.later(function () { deliver(xhr, state, run, local); }, 0);
        return;
      }

      if (!NETWORK.test(state.url)) {
        env.later(function () { deliver(xhr, state, run, null); }, 0);
        return;
      }

      bridge.request(state.method, state.url, JSON.stringify(headersObject(state.headers)), payload, function (status, headerJson, text) {
        if (!status) {
          deliver(xhr, state, run, null);
          return;
        }
        var parsed = {};
        try {
          parsed = JSON.parse(headerJson);
        } catch (error) {}
        deliver(xhr, state, run, answerOf({ status: status, headers: Object.keys(parsed).map(function (key) { return [key, parsed[key]]; }), text: text }));
      });
    });

    patch(proto, "abort", function abort() {
      var state = stateOf(this);
      var active = (state.readyState === 1 && state.sendFlag) || state.readyState === 2 || state.readyState === 3;
      state.run += 1;
      if (active) {
        state.sendFlag = false;
        state.error = true;
        changeState(this, state, 4);
        progress(this, "abort", 0, 0, false);
        progress(this, "loadend", 0, 0, false);
      }
      if (state.readyState === 4) {
        state.readyState = 0;
        state.status = 0;
        state.statusText = "";
        state.bytes = null;
        state.text = "";
        state.responseHeaders = [];
      }
    });

    patch(proto, "overrideMimeType", function overrideMimeType(mime) {
      var state = stateOf(this);
      if (arguments.length < 1) throw typeError("Failed to execute 'overrideMimeType' on 'XMLHttpRequest': 1 argument required, but only 0 present.");
      if (state.readyState === 3 || state.readyState === 4) {
        throw domError("Failed to execute 'overrideMimeType' on 'XMLHttpRequest': MimeType cannot be overridden when the state is LOADING or DONE.", "InvalidStateError");
      }
      state.mime = String(mime);
    });

    patch(proto, "getResponseHeader", function getResponseHeader(header) {
      var state = stateOf(this);
      if (arguments.length < 1) throw typeError("Failed to execute 'getResponseHeader' on 'XMLHttpRequest': 1 argument required, but only 0 present.");
      if (state.readyState < 2 || state.error) return null;
      return getHeader({ list: state.responseHeaders }, String(header).toLowerCase());
    });

    patch(proto, "getAllResponseHeaders", function getAllResponseHeaders() {
      var state = stateOf(this);
      if (state.readyState < 2 || state.error) return "";
      return sortedPairs({ list: state.responseHeaders }).map(function (pair) { return pair[0] + ": " + pair[1] + "\r\n"; }).join("");
    });

    patchGetter(proto, "readyState", function () { return stateOf(this).readyState; });
    patchGetter(proto, "status", function () { var state = stateOf(this); return state.error ? 0 : state.status; });
    patchGetter(proto, "statusText", function () { var state = stateOf(this); return state.error ? "" : state.statusText; });
    patchGetter(proto, "responseURL", function () { var state = stateOf(this); return state.error ? "" : state.responseURL; });
    patchGetter(proto, "upload", function () {
      stateOf(this);
      var held = uploads.get(this);
      if (!held && globalThis.XMLHttpRequestUpload) {
        held = Object.create(globalThis.XMLHttpRequestUpload.prototype);
        uploads.set(this, held);
      }
      return held;
    });

    var RESPONSE_TYPES = ["", "arraybuffer", "blob", "document", "json", "text"];

    try {
      var typeDescriptor = Object.getOwnPropertyDescriptor(proto, "responseType");
      Object.defineProperty(proto, "responseType", {
        get: asNative(function () { return stateOf(this).responseType; }, "get responseType"),
        set: asNative(function (value) {
          var state = stateOf(this);
          var where = "Failed to set the 'responseType' property on 'XMLHttpRequest': ";
          var text = String(value);
          if (RESPONSE_TYPES.indexOf(text) === -1) return;
          if (state.readyState === 3 || state.readyState === 4) throw domError(where + "The response type cannot be set if the object's state is LOADING or DONE.", "InvalidStateError");
          if (state.readyState === 1 && !state.async) throw domError(where + "The response type cannot be changed for synchronous requests made from a document.", "InvalidAccessError");
          state.responseType = text;
        }, "set responseType"),
        enumerable: typeDescriptor ? typeDescriptor.enumerable : true,
        configurable: true,
      });

      var timeoutDescriptor = Object.getOwnPropertyDescriptor(proto, "timeout");
      Object.defineProperty(proto, "timeout", {
        get: asNative(function () { return stateOf(this).timeout; }, "get timeout"),
        set: asNative(function (value) {
          var state = stateOf(this);
          if (state.readyState === 1 && !state.async) throw domError("Failed to set the 'timeout' property on 'XMLHttpRequest': Timeouts cannot be set for synchronous requests made from a document.", "InvalidAccessError");
          state.timeout = Math.max(0, Math.trunc(Number(value)) || 0) >>> 0;
        }, "set timeout"),
        enumerable: timeoutDescriptor ? timeoutDescriptor.enumerable : true,
        configurable: true,
      });

      var credentialsDescriptor = Object.getOwnPropertyDescriptor(proto, "withCredentials");
      Object.defineProperty(proto, "withCredentials", {
        get: asNative(function () { return stateOf(this).withCredentials; }, "get withCredentials"),
        set: asNative(function (value) {
          var state = stateOf(this);
          if ((state.readyState !== 0 && state.readyState !== 1) || state.sendFlag) {
            throw domError("Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.", "InvalidStateError");
          }
          state.withCredentials = Boolean(value);
        }, "set withCredentials"),
        enumerable: credentialsDescriptor ? credentialsDescriptor.enumerable : true,
        configurable: true,
      });
    } catch (error) {}

    patchGetter(proto, "responseText", function () {
      var state = stateOf(this);
      if (state.responseType !== "" && state.responseType !== "text") {
        throw domError("Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '" + state.responseType + "').", "InvalidStateError");
      }
      return state.readyState < 3 || state.error ? "" : state.text;
    });

    patchGetter(proto, "responseXML", function () {
      var state = stateOf(this);
      if (state.responseType !== "" && state.responseType !== "document") {
        throw domError("Failed to read the 'responseXML' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'document' (was '" + state.responseType + "').", "InvalidStateError");
      }
      return null;
    });

    patchGetter(proto, "response", function () {
      var state = stateOf(this);
      if (state.responseType === "" || state.responseType === "text") return state.readyState < 3 || state.error ? "" : state.text;
      if (state.readyState !== 4 || state.error) return null;
      if (state.responseType === "json") {
        if (state.jsonCache === undefined) {
          try {
            state.jsonCache = JSON.parse(state.text);
          } catch (error) {
            state.jsonCache = null;
          }
        }
        return state.jsonCache;
      }
      if (state.responseType === "arraybuffer") {
        if (!state.bufferCache) state.bufferCache = state.bytes.slice(0).buffer;
        return state.bufferCache;
      }
      if (state.responseType === "blob") {
        if (!state.blobCache) {
          var type = state.mime || getHeader({ list: state.responseHeaders }, "content-type") || "";
          state.blobCache = env.makeBlob(state.bytes.slice(0), type);
        }
        return state.blobCache;
      }
      return null;
    });
  })();
})();
