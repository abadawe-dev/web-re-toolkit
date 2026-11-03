// The elements module: what elements do over time, as Chrome does it. Images, scripts, links,
// frames and media load as tasks and say so with load or error; the performance timeline holds
// real entries; Mutation, Performance, Resize and Intersection observers hear what they watch.
// Built on dom.js's tree hooks (env.nodeInserted, env.attributeChanged, env.queueMutation) and
// evaluated in every window and frame after it.
(function () {
  var env = globalThis.__ENV;
  if (!env) return;

  var bridge = env.bridge;
  var patch = env.patch;
  var patchGetter = env.patchGetter;
  var asNative = env.asNative;
  var nodeState = env.nodeState;
  var makeEvent = env.makeEvent;
  var dispatch = env.dispatch;
  var later = env.later;
  var domException = env.domException;

  var hasOwn = function (holder, key) { return Object.prototype.hasOwnProperty.call(holder, key); };
  var protoOf = function (name) { return globalThis[name] && globalThis[name].prototype ? globalThis[name].prototype : null; };
  var tagOf = function (node) { var state = nodeState(node); return state && state.nodeType === 1 ? state.tag : null; };
  var attr = function (node, name) { var state = nodeState(node); return state && hasOwn(state.attrs, name) ? state.attrs[name] : null; };

  // Accessors on an interface prototype, as Chrome's: a getter (and setter) that refuse a receiver
  // that is not one of its objects.
  var accessor = function (proto, name, get, set) {
    if (!proto) return;
    patchGetter(proto, name, get);
    if (!set) return;
    try {
      var held = Object.getOwnPropertyDescriptor(proto, name);
      Object.defineProperty(proto, name, { get: held.get, set: asNative(set, "set " + name), enumerable: held.enumerable, configurable: true });
    } catch (error) {}
  };

  // State kept beside objects this module makes (records, entries, errors, time ranges): the
  // prototype's getters read it.
  var fieldsOf = new WeakMap();

  var stateGetter = function (proto, names) {
    if (!proto) return;
    names.forEach(function (name) {
      patchGetter(proto, name, function () {
        var held = fieldsOf.get(this);
        if (!held) throw env.hideFrames(new TypeError("Illegal invocation"));
        return held[name];
      });
    });
  };

  var made = function (iface, fields) {
    var object = Object.create(protoOf(iface) || Object.prototype);
    fieldsOf.set(object, fields);
    return object;
  };

  // A URL resolved against `node`'s base URL (its document's <base>, else the document URL), or
  // null when it does not parse.
  var resolve = function (url, node) {
    var base = globalThis.location.href;
    try {
      base = node ? node.baseURI : globalThis.document.baseURI;
    } catch (error) {}
    var parsed = bridge.parseUrl(String(url), base);
    return parsed ? parsed.href : null;
  };

  // ---------------------------------------------------------------------------------------------
  // Resources: what a URL holds, read as the element's own fetch would read it. data: and blob:
  // URLs are read here; http(s) goes out through the host's transport. `done` hears
  // { ok, bytes (Uint8Array), type, status } as a task, never synchronously.

  var dataUrl = function (url) {
    var match = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(url);
    if (!match) return null;

    var type = (match[1] || "text/plain;charset=US-ASCII").trim().toLowerCase();
    var body = match[3];
    var bytes;

    if (match[2]) {
      var clean = decodeURIComponent(body).replace(/[\t\n\f\r ]/g, "");
      var binary;
      try {
        binary = globalThis.atob(clean);
      } catch (error) {
        return null;
      }
      bytes = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 255;
    } else {
      var text;
      try {
        text = decodeURIComponent(body);
      } catch (error) {
        text = body;
      }
      bytes = new Uint8Array(text.length);
      var latin = true;
      for (var at = 0; at < text.length; at += 1) {
        if (text.charCodeAt(at) > 255) latin = false;
        bytes[at] = text.charCodeAt(at) & 255;
      }
      if (!latin) bytes = env.utf8Encode(text);
    }

    return { ok: true, bytes: bytes, type: type.split(";")[0].trim(), status: 200 };
  };

  var load = function (url, accept, done) {
    var absolute = resolve(url);
    var settle = function (result) { later(function () { done(result); }, 0); };
    var failed = { ok: false, bytes: new Uint8Array(0), type: "", status: 0 };

    if (!absolute) return settle(failed);

    if (/^data:/i.test(absolute)) return settle(dataUrl(absolute) || failed);

    if (/^blob:/i.test(absolute)) {
      var held = env.objectUrls ? env.objectUrls.get(absolute) : undefined;
      var bytes = held !== undefined ? env.blobBytes(held) : null;
      if (!bytes) return settle(held !== undefined ? { ok: false, object: held, bytes: new Uint8Array(0), type: "", status: 0 } : failed);
      return settle({ ok: true, bytes: bytes, type: (env.blobTypeOf(held) || "").split(";")[0], status: 200 });
    }

    if (!/^https?:/i.test(absolute)) return settle(failed);

    bridge.request("GET", absolute, JSON.stringify({ accept: accept }), null, function (status, headerJson, text) {
      var headers = {};
      try {
        headers = JSON.parse(headerJson) || {};
      } catch (error) {}
      var type = String(headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      var body = String(text || "");
      var bytes = new Uint8Array(body.length);
      for (var index = 0; index < body.length; index += 1) bytes[index] = body.charCodeAt(index) & 255;
      done({ ok: status >= 200 && status < 300, bytes: bytes, text: body, type: type, status: status });
    });
  };

  env.loadResource = load;

  // ---------------------------------------------------------------------------------------------
  // Image sizes, read from the image's own header as Chrome's decoders find them; null when the
  // bytes are no image Chrome decodes (it sniffs the format; SVG only when served as SVG).

  var u16 = function (b, at, little) { return little ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1]; };
  var u32 = function (b, at, little) { return little ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 16777216 : b[at] * 16777216 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]); };
  var starts = function (b, text, at) {
    for (var index = 0; index < text.length; index += 1) if (b[(at || 0) + index] !== text.charCodeAt(index)) return false;
    return true;
  };

  var svgSize = function (bytes) {
    var text = env.decodeUtf8(bytes);
    var open = /<svg\b([^>]*?)(\/?)>/i.exec(text);
    if (!open) return null;
    var attrs = open[1];
    if (!/\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(attrs)) return null;
    if (!open[2] && !/<\/svg\s*>\s*$/i.test(text.trim())) return null;

    var length = function (name) {
      var found = new RegExp("\\b" + name + "\\s*=\\s*[\"']\\s*([0-9.]+)(px)?\\s*[\"']").exec(attrs);
      return found ? Math.round(Number(found[1])) : null;
    };

    var width = length("width");
    var height = length("height");
    var view = /\bviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/.exec(attrs);

    if (width !== null && height !== null) return { width: width, height: height };
    if (view && (width !== null || height !== null)) {
      var ratio = Number(view[1]) / Number(view[2]);
      return width !== null ? { width: width, height: Math.round(width / ratio) } : { width: Math.round(height * ratio), height: height };
    }
    return { width: width === null ? 300 : width, height: height === null ? 150 : height };
  };

  var imageSize = function (bytes, type) {
    var b = bytes;
    if (b.length >= 24 && starts(b, "\x89PNG\r\n\x1a\n") && starts(b, "IHDR", 12)) return { width: u32(b, 16), height: u32(b, 20) };
    if (b.length >= 10 && (starts(b, "GIF87a") || starts(b, "GIF89a"))) return { width: u16(b, 6, true), height: u16(b, 8, true) };
    if (b.length >= 26 && starts(b, "BM")) return { width: Math.abs(u32(b, 18, true) | 0), height: Math.abs(u32(b, 22, true) | 0) };
    if (b.length >= 30 && starts(b, "RIFF") && starts(b, "WEBP", 8)) {
      if (starts(b, "VP8 ", 12) && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: u16(b, 26, true) & 0x3fff, height: u16(b, 28, true) & 0x3fff };
      if (starts(b, "VP8L", 12) && b[20] === 0x2f) {
        var bits = u32(b, 21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (starts(b, "VP8X", 12)) return { width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
      return null;
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      var at = 2;
      while (at + 9 < b.length) {
        if (b[at] !== 0xff) return null;
        var marker = b[at + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          at += 2;
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: u16(b, at + 7), height: u16(b, at + 5) };
        }
        at += 2 + u16(b, at + 2);
      }
      return null;
    }
    if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { width: b[6] || 256, height: b[7] || 256 };
    if (type === "image/svg+xml") return svgSize(bytes);
    return null;
  };

  // ---------------------------------------------------------------------------------------------
  // Images. Changing src (or srcset) starts a new request, replacing the one in flight; it
  // settles as a task: the sizes come in and the image hears load, or it hears error.

  var imageState = new WeakMap();

  var imageOf = function (node) {
    var found = imageState.get(node);
    if (!found) {
      found = { pending: false, generation: 0, width: 0, height: 0, current: "", broken: false, waiting: [] };
      imageState.set(node, found);
    }
    return found;
  };

  // The srcset candidates, as the HTML standard splits them (a URL is a run without spaces, so a
  // data: URL keeps its commas; a trailing comma ends a candidate), each with its density.
  var srcsetCandidates = function (text) {
    var out = [];
    var at = 0;
    var input = String(text);

    while (at < input.length) {
      while (at < input.length && /[\s,]/.test(input.charAt(at))) at += 1;
      if (at >= input.length) break;
      var start = at;
      while (at < input.length && !/\s/.test(input.charAt(at))) at += 1;
      var url = input.slice(start, at);
      var descriptors = "";
      if (/,+$/.test(url)) {
        url = url.replace(/,+$/, "");
      } else {
        var from = at;
        while (at < input.length && input.charAt(at) !== ",") at += 1;
        descriptors = input.slice(from, at).trim();
      }
      var density = /^([0-9.]+)x$/.exec(descriptors);
      out.push({ url: url, density: density ? Number(density[1]) : 1 });
    }

    return out;
  };

  var chosenSource = function (node) {
    var srcset = attr(node, "srcset");
    if (srcset !== null && srcset.trim()) {
      var wanted = Number(globalThis.devicePixelRatio) || 1;
      var candidates = srcsetCandidates(srcset);
      var src = attr(node, "src");
      if (src !== null && src !== "" && !candidates.some(function (one) { return one.density === 1; })) candidates.push({ url: src, density: 1 });
      candidates.sort(function (left, right) { return left.density - right.density; });
      var pick = candidates.filter(function (one) { return one.density >= wanted; })[0] || candidates[candidates.length - 1];
      if (pick) return pick.url;
    }
    return attr(node, "src");
  };

  var settleDecodes = function (image) {
    var waiting = image.waiting;
    image.waiting = [];
    waiting.forEach(function (pair) {
      if (image.broken) pair[1](domException("The source image cannot be decoded.", "EncodingError"));
      else pair[0](undefined);
    });
  };

  var updateImage = function (node) {
    var image = imageOf(node);
    var source = chosenSource(node);
    var generation = (image.generation += 1);

    if (source === null || source === "") {
      image.pending = false;
      image.width = 0;
      image.height = 0;
      image.current = "";
      image.broken = source === "";
      if (source === "") {
        later(function () {
          if (image.generation !== generation) return;
          dispatch(node, makeEvent("error"));
          settleDecodes(image);
        }, 0);
      } else {
        settleDecodes(image);
      }
      return;
    }

    var absolute = resolve(source);
    image.pending = true;

    load(source, "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", function (result) {
      if (image.generation !== generation) return;
      var size = result.ok ? imageSize(result.bytes, result.type) : null;
      image.pending = false;
      image.current = absolute || "";
      image.broken = !size;
      image.width = size ? size.width : 0;
      image.height = size ? size.height : 0;
      dispatch(node, makeEvent(size ? "load" : "error"));
      settleDecodes(image);
    });
  };

  (function installImage() {
    var proto = protoOf("HTMLImageElement");
    if (!proto) return;

    var dimension = function (field) {
      return function () {
        var state = nodeState(this);
        if (!state) throw env.hideFrames(new TypeError("Illegal invocation"));
        var given = state.attrs[field];
        if (given !== undefined) {
          var parsed = parseInt(given, 10);
          if (isFinite(parsed) && parsed >= 0) return parsed;
        }
        return imageOf(this)[field];
      };
    };

    accessor(proto, "width", dimension("width"), function (value) { env.setAttr(this, "width", String(Number(value) >>> 0)); });
    accessor(proto, "height", dimension("height"), function (value) { env.setAttr(this, "height", String(Number(value) >>> 0)); });
    patchGetter(proto, "naturalWidth", function () { return imageOf(this).width; });
    patchGetter(proto, "naturalHeight", function () { return imageOf(this).height; });
    patchGetter(proto, "complete", function () {
      var image = imageOf(this);
      return !image.pending;
    });
    patchGetter(proto, "currentSrc", function () { return imageOf(this).current; });
    patchGetter(proto, "x", function () { return 0; });
    patchGetter(proto, "y", function () { return 0; });

    var enumerated = function (name, values, fallback) {
      accessor(proto, name, function () {
        var raw = attr(this, name.toLowerCase());
        var lower = raw === null ? null : raw.toLowerCase();
        return lower !== null && values.indexOf(lower) !== -1 ? lower : fallback;
      }, function (value) { env.setAttr(this, name.toLowerCase(), String(value)); });
    };

    enumerated("loading", ["lazy", "eager"], "auto");
    enumerated("decoding", ["sync", "async"], "auto");
    enumerated("fetchPriority", ["high", "low"], "auto");

    patch(proto, "decode", function decode() {
      var image = imageOf(this);
      var node = this;
      return new Promise(function (resolved, rejected) {
        if (image.pending) {
          image.waiting.push([resolved, rejected]);
          return;
        }
        if (image.broken || !image.current || chosenSource(node) === null) {
          later(function () { rejected(domException("The source image cannot be decoded.", "EncodingError")); }, 0);
          return;
        }
        later(function () { resolved(undefined); }, 0);
      });
    });
  })();

  // ---------------------------------------------------------------------------------------------
  // URL attributes read back resolved against the document, as Chrome's reflected URLs are
  // (getAttribute keeps the text as given).

  var urlReflect = function (iface, name, whenAbsent) {
    var proto = protoOf(iface);
    if (!proto) return;
    accessor(proto, name, function () {
      var raw = attr(this, name.toLowerCase());
      if (raw === null) return whenAbsent ? whenAbsent(this) : "";
      var absolute = resolve(raw, this);
      return absolute === null ? raw : absolute;
    }, function (value) { env.setAttr(this, name.toLowerCase(), String(value)); });
  };

  urlReflect("HTMLImageElement", "src");
  urlReflect("HTMLScriptElement", "src");
  urlReflect("HTMLMediaElement", "src");
  urlReflect("HTMLIFrameElement", "src");
  urlReflect("HTMLLinkElement", "href");
  urlReflect("HTMLVideoElement", "poster");
  urlReflect("HTMLEmbedElement", "src");
  urlReflect("HTMLSourceElement", "src");
  urlReflect("HTMLTrackElement", "src");
  urlReflect("HTMLInputElement", "src");
  urlReflect("HTMLObjectElement", "data");
  urlReflect("HTMLQuoteElement", "cite");
  urlReflect("HTMLModElement", "cite");
  // A form with no action submits to its document's URL.
  urlReflect("HTMLFormElement", "action", function (form) {
    var doc = form.ownerDocument || globalThis.document;
    return doc.URL;
  });

  // <base href> resolves against the document's URL itself (its fallback base), not against the
  // base it sets.
  (function installBaseHref() {
    var proto = protoOf("HTMLBaseElement");
    if (!proto) return;
    accessor(proto, "href", function () {
      var raw = attr(this, "href");
      var doc = this.ownerDocument || globalThis.document;
      var url = doc.URL === "about:blank" && globalThis.document !== doc ? "about:blank" : doc.URL;
      if (raw === null) return url;
      var parsed = bridge.parseUrl(raw, url);
      return parsed ? parsed.href : raw;
    }, function (value) { env.setAttr(this, "href", String(value)); });
  })();

  // <a> and <area>: HTMLHyperlinkElementUtils, the href and its parts read from the resolved URL,
  // each setter rewriting href. An absent href reads "" (protocol ":"), and one that does not
  // parse reads back as written, its parts empty.
  (function installHyperlinks() {
    var parsedOf = function (link) {
      var raw = attr(link, "href");
      if (raw === null) return { raw: null, url: null };
      var base = link.baseURI;
      return { raw: raw, url: bridge.parseUrl(raw, base) };
    };

    var compose = function (url) {
      var auth = url.username ? url.username + (url.password ? ":" + url.password : "") + "@" : "";
      var hierarchical = url.host !== "" || /^(https?|ftp|wss?|file):$/.test(url.protocol);
      return url.protocol + (hierarchical ? "//" + auth + url.host : "") + url.pathname + url.search + url.hash;
    };

    var PARTS = ["protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"];

    ["HTMLAnchorElement", "HTMLAreaElement"].forEach(function (iface) {
      var proto = protoOf(iface);
      if (!proto) return;

      accessor(proto, "href", function () {
        var held = parsedOf(this);
        if (held.raw === null) return "";
        return held.url ? held.url.href : held.raw;
      }, function (value) { env.setAttr(this, "href", String(value)); });

      accessor(proto, "origin", function () {
        var held = parsedOf(this);
        return held.url ? held.url.origin : "";
      });

      PARTS.forEach(function (part) {
        accessor(proto, part, function () {
          var held = parsedOf(this);
          if (!held.url) return part === "protocol" ? ":" : "";
          return held.url[part];
        }, function (value) {
          var held = parsedOf(this);
          if (!held.url) return;
          var url = {};
          for (var key in held.url) url[key] = held.url[key];
          var text = String(value);
          if (part === "protocol") url.protocol = text.replace(/:.*$/, "") + ":";
          else if (part === "host") url.host = text;
          else if (part === "hostname") url.host = text + (url.port ? ":" + url.port : "");
          else if (part === "port") url.host = url.hostname + (text ? ":" + text : "");
          else if (part === "pathname") url.pathname = text.charAt(0) === "/" ? text : "/" + text;
          else if (part === "search") url.search = text === "" ? "" : text.charAt(0) === "?" ? text : "?" + text;
          else if (part === "hash") url.hash = text === "" ? "" : text.charAt(0) === "#" ? text : "#" + text;
          else url[part] = text;
          var next = bridge.parseUrl(compose(url), null);
          if (next) env.setAttr(this, "href", next.href);
        });
      });

      if (typeof proto.toString === "function") {
        env.patch(proto, "toString", function toString() {
          var held = parsedOf(this);
          if (held.raw === null) return "";
          return held.url ? held.url.href : held.raw;
        });
      }
    });
  })();

  var crossOrigin = function (iface) {
    var proto = protoOf(iface);
    if (!proto) return;
    accessor(proto, "crossOrigin", function () {
      var raw = attr(this, "crossorigin");
      if (raw === null) return null;
      return raw.toLowerCase() === "use-credentials" ? "use-credentials" : "anonymous";
    }, function (value) { env.setAttr(this, "crossorigin", value === null ? null : String(value)); });
  };

  ["HTMLImageElement", "HTMLScriptElement", "HTMLLinkElement", "HTMLMediaElement"].forEach(crossOrigin);

  (function installGlobalAttributes() {
    var proto = protoOf("HTMLElement");
    if (!proto) return;
    ["title", "lang", "accessKey"].forEach(function (name) {
      if (!(name in proto)) return;
      accessor(proto, name, function () {
        var raw = attr(this, name.toLowerCase());
        return raw === null ? "" : raw;
      }, function (value) { env.setAttr(this, name.toLowerCase(), String(value)); });
    });
    accessor(proto, "dir", function () {
      var raw = attr(this, "dir");
      return raw !== null && ["ltr", "rtl", "auto"].indexOf(raw.toLowerCase()) !== -1 ? raw.toLowerCase() : "";
    }, function (value) { env.setAttr(this, "dir", String(value)); });
  })();

  // ---------------------------------------------------------------------------------------------
  // Scripts. A script element runs once, when it first meets the document: an inline one at once,
  // one with src once fetched (as a task; the host evaluates it under its own URL in a window,
  // the frame evaluates it in a frame), then it hears load. An unfetchable one hears error. Types
  // other than JavaScript never run; module scripts are not supported here and never run.

  var JS_TYPES = [
    "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
    "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
    "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
    "text/x-ecmascript", "text/x-javascript",
  ];

  var classicScript = function (node) {
    var type = attr(node, "type");
    var language = attr(node, "language");
    if (type === null || type === "") {
      if (language === null || language === "") return true;
      return JS_TYPES.indexOf("text/" + language.trim().toLowerCase()) !== -1;
    }
    return JS_TYPES.indexOf(type.trim().toLowerCase()) !== -1;
  };

  var ready = [];
  var running = null;

  env.scriptReady = function () { return ready.length > 0; };

  env.takeScript = function () {
    running = ready.shift();
    env.beginScript(running.url, false, running.node);
    return { source: running.source, url: running.url };
  };

  env.scriptRan = function (failure) {
    var done = running;
    running = null;
    env.endScript();
    if (failure !== null) reportFailure(failure, done.url);
    dispatch(done.node, makeEvent("load"));
  };

  var reportFailure = function (failure, url) {
    var where = /\((?:at )?([^()]*?):(\d+):(\d+)\)\s*$/.exec(failure) || /:(\d+):(\d+)/.exec(failure);
    var message = String(failure).split("\n")[0].replace(/ \(at [^)]*\)$/, "");
    if (message.indexOf(url + ": ") === 0) message = message.slice(url.length + 2);
    dispatch(globalThis, makeEvent("error", {
      message: "Uncaught " + message,
      filename: url,
      lineno: where ? Number(where[where.length - 2]) : 0,
      colno: where ? Number(where[where.length - 1]) : 0,
      error: null,
      cancelable: true,
    }, "ErrorEvent"));
  };

  // Runs a script's text in this realm now, with the element current (an inline script, or a
  // fetched one in a frame, where the host cannot evaluate under a URL).
  var runHere = function (node, source, url) {
    env.beginScript(url, true, node);
    try {
      env.evaluate(String(source));
    } catch (error) {
      env.reportException(error);
    } finally {
      env.endScript();
    }
  };

  var prepareScript = function (node) {
    var state = nodeState(node);
    if (!state || state.started) return;

    var src = attr(node, "src");
    if (src === null && !env.textOf(node)) return;

    state.started = true;
    if (!classicScript(node)) return;

    if (src === null) {
      runHere(node, env.textOf(node), globalThis.location.href);
      return;
    }

    var absolute = resolve(src);

    if (src === "" || absolute === null) {
      later(function () { dispatch(node, makeEvent("error")); }, 0);
      return;
    }

    load(absolute, "*/*", function (result) {
      if (!result.ok) {
        dispatch(node, makeEvent("error"));
        return;
      }
      var source = result.text !== undefined ? result.text : env.decodeUtf8(result.bytes);
      if (env.isFrame) {
        runHere(node, source, absolute);
        dispatch(node, makeEvent("load"));
        return;
      }
      ready.push({ node: node, source: source, url: absolute });
    });
  };

  (function installScript() {
    var proto = protoOf("HTMLScriptElement");
    if (!proto) return;

    accessor(proto, "async", function () {
      var state = nodeState(this);
      if (!state) throw env.hideFrames(new TypeError("Illegal invocation"));
      return state.forceAsync !== false || attr(this, "async") !== null;
    }, function (value) {
      var state = nodeState(this);
      if (!state) return;
      state.forceAsync = false;
      env.setAttr(this, "async", value ? "" : null);
    });

    // Chrome gives script elements their own text accessors (for Trusted Types); they read and
    // write the element's text as Node's do.
    var nodeText = Object.getOwnPropertyDescriptor(protoOf("Node"), "textContent");
    ["text", "textContent", "innerText"].forEach(function (name) {
      if (name !== "text" && !hasOwn(proto, name)) return;
      accessor(proto, name, function () { return env.textOf(this); }, function (value) { nodeText.set.call(this, value); });
    });
    patchGetter(proto, "blocking", function () { return env.tokenList(this, "blocking", ["render"]); });
    accessor(proto, "fetchPriority", function () {
      var raw = attr(this, "fetchpriority");
      return raw !== null && ["high", "low"].indexOf(raw.toLowerCase()) !== -1 ? raw.toLowerCase() : "auto";
    }, function (value) { env.setAttr(this, "fetchpriority", String(value)); });
  })();

  // ---------------------------------------------------------------------------------------------
  // Links: a stylesheet or preload in the document fetches its href and hears load or error; a
  // loaded stylesheet has a sheet.

  var linkState = new WeakMap();

  var LINK_TOKENS = [
    "alternate", "canonical", "compression-dictionary", "dns-prefetch", "expect", "icon", "manifest",
    "modulepreload", "next", "pingback", "preconnect", "prefetch", "preload", "search", "stylesheet",
  ];

  var linkRels = function (node) {
    return String(attr(node, "rel") || "").toLowerCase().split(/\s+/).filter(Boolean);
  };

  var processLink = function (node) {
    var href = attr(node, "href");
    var rels = linkRels(node);
    var loads = rels.indexOf("stylesheet") !== -1 || rels.indexOf("preload") !== -1 || rels.indexOf("modulepreload") !== -1;
    if (!loads || href === null || href === "") return;

    var held = { generation: ((linkState.get(node) || {}).generation || 0) + 1, sheet: null };
    linkState.set(node, held);

    load(href, rels.indexOf("stylesheet") !== -1 ? "text/css,*/*;q=0.1" : "*/*", function (result) {
      if ((linkState.get(node) || {}).generation !== held.generation) return;
      if (result.ok && rels.indexOf("stylesheet") !== -1) held.sheet = Object.create(protoOf("CSSStyleSheet") || Object.prototype);
      dispatch(node, makeEvent(result.ok ? "load" : "error"));
    });
  };

  (function installLink() {
    var proto = protoOf("HTMLLinkElement");
    if (!proto) return;
    patchGetter(proto, "sheet", function () {
      var held = linkState.get(this);
      return held && held.sheet ? held.sheet : null;
    });

    patchGetter(proto, "relList", function () { return env.tokenList(this, "rel", LINK_TOKENS); });
    patchGetter(proto, "blocking", function () { return env.tokenList(this, "blocking", ["render"]); });
  })();

  // ---------------------------------------------------------------------------------------------
  // Frames. An iframe meeting the document with nothing to load (no src, or about:blank) has its
  // blank document loaded at once: the frame's window and the element hear load before the
  // insertion returns. srcdoc loads its markup as about:srcdoc, a data: URL an opaque document,
  // each as a task. http(s) documents are loaded by dom.js's navigateFrame.

  var frameOpaque = new WeakMap();

  var frameLoaded = function (node) {
    var state = nodeState(node);
    if (!state || !state.frame) return;
    if (typeof bridge.frameLoaded === "function") bridge.frameLoaded(state.frame);
    dispatch(node, makeEvent("load"));
  };

  var bodyOfMarkup = function (markup) {
    var text = String(markup);
    var found = /<body[^>]*>([\s\S]*?)(<\/body>|$)/i.exec(text);
    if (found) return found[1];
    return text.replace(/<!doctype[^>]*>/i, "").replace(/<\/?(html|head)[^>]*>/gi, "").replace(/<title>[\s\S]*?<\/title>/i, "");
  };

  var processFrame = function (node, inserted) {
    var state = nodeState(node);
    if (!state || !state.frame) return;

    var view = state.frame;
    var srcdoc = attr(node, "srcdoc");
    var src = attr(node, "src");
    frameOpaque.delete(node);

    if (srcdoc !== null) {
      var generation = (state.frameGeneration = (state.frameGeneration || 0) + 1);
      later(function () {
        if (state.frameGeneration !== generation || state.frame !== view) return;
        if (typeof bridge.relocateFrame === "function") bridge.relocateFrame(view, "about:srcdoc");
        bridge.runInFrame(view, "document.body.innerHTML = " + JSON.stringify(bodyOfMarkup(srcdoc)) + ";", "about:srcdoc", true);
        frameLoaded(node);
      }, 0);
      return;
    }

    // A blank document (no src, or exactly about:blank) loads during the insertion itself; set
    // later, it loads as a task. about:blank with a query or fragment never fires load.
    if (src === null || src === "" || /^about:blank$/i.test(src)) {
      if (inserted) frameLoaded(node);
      else later(function () { if (state.frame === view) frameLoaded(node); }, 0);
      return;
    }

    if (/^about:blank[?#]/i.test(src)) return;

    // A javascript: URL runs in the frame's blank document; a string it gives becomes the document.
    if (/^javascript:/i.test(src)) {
      var code;
      try {
        code = decodeURIComponent(src.slice(11));
      } catch (error) {
        code = src.slice(11);
      }
      later(function () {
        if (state.frame !== view) return;
        bridge.runInFrame(view, "(function () { var given = (0, eval)(" + JSON.stringify(code) + "); if (typeof given === 'string') document.body.innerHTML = given; })();", "about:blank", true);
        frameLoaded(node);
      }, 0);
      return;
    }

    if (/^about:/i.test(src)) {
      later(function () {
        if (state.frame !== view) return;
        if (typeof bridge.relocateFrame === "function") bridge.relocateFrame(view, src.toLowerCase());
        frameLoaded(node);
      }, 0);
      return;
    }

    if (/^data:/i.test(src)) {
      frameOpaque.set(node, true);
      later(function () { if (state.frame === view) dispatch(node, makeEvent("load")); }, 0);
    }
  };

  (function installFrames() {
    var proto = protoOf("HTMLIFrameElement");
    if (!proto) return;

    accessor(proto, "srcdoc", function () {
      var raw = attr(this, "srcdoc");
      return raw === null ? "" : raw;
    }, function (value) { env.setAttr(this, "srcdoc", String(value)); });

    env.opaqueFrame = function (node) { return frameOpaque.get(node) === true; };

    var SANDBOX_TOKENS = [
      "allow-downloads", "allow-forms", "allow-modals", "allow-orientation-lock", "allow-pointer-lock",
      "allow-popups", "allow-popups-to-escape-sandbox", "allow-presentation", "allow-same-origin",
      "allow-scripts", "allow-storage-access-by-user-activation", "allow-top-navigation",
      "allow-top-navigation-by-user-activation", "allow-top-navigation-to-custom-protocols",
    ];
    patchGetter(proto, "sandbox", function () { return env.tokenList(this, "sandbox", SANDBOX_TOKENS); });

    accessor(proto, "loading", function () {
      var raw = attr(this, "loading");
      return raw !== null && ["lazy", "eager"].indexOf(raw.toLowerCase()) !== -1 ? raw.toLowerCase() : "auto";
    }, function (value) { env.setAttr(this, "loading", String(value)); });
  })();

  // ---------------------------------------------------------------------------------------------
  // Media elements. Their state starts empty; a src (or load()) runs the load algorithm: loadstart,
  // then, as nothing here decodes media, error with Chrome's MediaError for what the source was.
  // A MediaSource behind a blob: URL opens instead. play() without a user's gesture is refused
  // unless muted, as Chrome's autoplay policy does.

  var mediaState = new WeakMap();

  var mediaOf = function (node) {
    var found = mediaState.get(node);
    if (!found) {
      found = {
        networkState: 0, readyState: 0, paused: true, ended: false, seeking: false, currentTime: 0,
        duration: NaN, currentSrc: "", error: null, volume: 1, muted: null, playbackRate: 1,
        defaultPlaybackRate: 1, preservesPitch: true, srcObject: null, sinkId: "", generation: 0,
        plays: [], source: null,
      };
      mediaState.set(node, found);
    }
    return found;
  };

  var timeRanges = function () { return made("TimeRanges", { length: 0 }); };

  var mediaError = function (code, message) { return made("MediaError", { code: code, message: message }); };

  var fireMedia = function (node, type) { dispatch(node, makeEvent(type)); };

  var rejectPlays = function (media, error) {
    var waiting = media.plays;
    media.plays = [];
    waiting.forEach(function (pair) { pair[1](error); });
  };

  var mediaFailed = function (node, media, message) {
    media.error = mediaError(4, message);
    media.networkState = 3;
    fireMedia(node, "error");
    rejectPlays(media, domException("Failed to load because no supported source was found.", "NotSupportedError"));
  };

  var MEDIA_TYPES = /^(video|audio)\/|^application\/(ogg|octet-stream|x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)$/;

  var mediaLoad = function (node) {
    var media = mediaOf(node);
    var generation = (media.generation += 1);

    if (media.networkState !== 0) {
      if (media.networkState === 1 || media.networkState === 2) later(function () { if (media.generation === generation) fireMedia(node, "abort"); }, 0);
      media.networkState = 0;
      media.readyState = 0;
      media.error = null;
      media.currentSrc = "";
      media.duration = NaN;
      media.currentTime = 0;
      media.paused = true;
      later(function () { if (media.generation === generation) fireMedia(node, "emptied"); }, 0);
    }

    var src = attr(node, "src");
    if (src === null) return;

    media.networkState = 2;

    later(function () {
      if (media.generation !== generation) return;
      fireMedia(node, "loadstart");

      if (src === "") {
        media.currentSrc = "";
        mediaFailed(node, media, "MEDIA_ELEMENT_ERROR: Empty src attribute");
        return;
      }

      var absolute = resolve(src);
      media.currentSrc = absolute || "";

      load(src, "*/*", function (result) {
        if (media.generation !== generation) return;
        var source = result.object;

        if (source && sourceState.has(source)) {
          openSource(source, node);
          return;
        }

        if (!result.ok) return mediaFailed(node, media, "MEDIA_ELEMENT_ERROR: Format error");
        if (result.type && !MEDIA_TYPES.test(result.type)) return mediaFailed(node, media, "MEDIA_ELEMENT_ERROR: Unable to load URL due to content type");
        mediaFailed(node, media, "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed");
      });
    }, 0);
  };

  (function installMedia() {
    var proto = protoOf("HTMLMediaElement");
    if (!proto) return;

    var own = function (node) {
      if (!nodeState(node)) throw env.hideFrames(new TypeError("Illegal invocation"));
      return mediaOf(node);
    };

    ["networkState", "readyState", "paused", "ended", "seeking", "duration", "currentSrc", "error", "srcObject", "sinkId", "preservesPitch"].forEach(function (name) {
      patchGetter(proto, name, function () { return own(this)[name]; });
    });

    accessor(proto, "currentTime", function () { return own(this).currentTime; }, function (value) { own(this).currentTime = Number(value) || 0; });
    accessor(proto, "volume", function () { return own(this).volume; }, function (value) {
      var number = Number(value);
      if (!(number >= 0 && number <= 1)) {
        throw domException("Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (" + String(number) + ") is outside the range [0, 1].", "IndexSizeError");
      }
      own(this).volume = number;
      fireMedia(this, "volumechange");
    });
    accessor(proto, "muted", function () {
      var media = own(this);
      return media.muted === null ? attr(this, "muted") !== null : media.muted;
    }, function (value) {
      own(this).muted = Boolean(value);
    });
    accessor(proto, "defaultMuted", function () { return attr(this, "muted") !== null; }, function (value) { env.setAttr(this, "muted", value ? "" : null); });
    accessor(proto, "playbackRate", function () { return own(this).playbackRate; }, function (value) { own(this).playbackRate = Number(value); });
    accessor(proto, "defaultPlaybackRate", function () { return own(this).defaultPlaybackRate; }, function (value) { own(this).defaultPlaybackRate = Number(value); });
    accessor(proto, "preservesPitch", function () { return own(this).preservesPitch; }, function (value) { own(this).preservesPitch = Boolean(value); });
    accessor(proto, "srcObject", function () { return own(this).srcObject; }, function (value) { own(this).srcObject = value === undefined ? null : value; });
    accessor(proto, "preload", function () {
      var raw = attr(this, "preload");
      var lower = raw === null ? null : raw.toLowerCase();
      if (lower === "none" || lower === "metadata" || lower === "auto") return lower;
      if (lower === "") return "auto";
      return "metadata";
    }, function (value) { env.setAttr(this, "preload", String(value)); });
    accessor(proto, "disableRemotePlayback", function () { return attr(this, "disableremoteplayback") !== null; }, function (value) { env.setAttr(this, "disableremoteplayback", value ? "" : null); });

    ["buffered", "played", "seekable"].forEach(function (name) {
      patchGetter(proto, name, function () { own(this); return timeRanges(); });
    });

    var trackLists = new WeakMap();
    patchGetter(proto, "textTracks", function () {
      own(this);
      var list = trackLists.get(this);
      if (!list) {
        list = made("TextTrackList", { length: 0 });
        trackLists.set(this, list);
      }
      return list;
    });
    patchGetter(proto, "mediaKeys", function () { own(this); return null; });

    patch(proto, "load", function load() {
      own(this);
      rejectPlays(mediaOf(this), domException("The play() request was interrupted by a new load request. https://goo.gl/LdLk22", "AbortError"));
      mediaLoad(this);
    });

    patch(proto, "pause", function pause() {
      var media = own(this);
      if (!media.paused) {
        media.paused = true;
        var node = this;
        later(function () { fireMedia(node, "pause"); }, 0);
        rejectPlays(media, domException("The play() request was interrupted by a call to pause(). https://goo.gl/LdLk22", "AbortError"));
      }
    });

    patch(proto, "play", function play() {
      var media = own(this);
      var node = this;
      var muted = media.muted === null ? attr(this, "muted") !== null : media.muted;

      if (!muted) {
        return Promise.reject(domException("play() failed because the user didn't interact with the document first. https://goo.gl/xX8pDD", "NotAllowedError"));
      }

      if (media.error && fieldsOf.get(media.error).code === 4) {
        return Promise.reject(domException("The element has no supported sources.", "NotSupportedError"));
      }

      return new Promise(function (resolved, rejected) {
        if (media.paused) {
          media.paused = false;
          later(function () { fireMedia(node, "play"); }, 0);
        }
        media.plays.push([resolved, rejected]);
        if (media.networkState === 0 && attr(node, "src") !== null) mediaLoad(node);
      });
    });

    var videoProto = protoOf("HTMLVideoElement");
    if (videoProto) {
      patchGetter(videoProto, "videoWidth", function () { own(this); return 0; });
      patchGetter(videoProto, "videoHeight", function () { own(this); return 0; });
    }
  })();

  stateGetter(protoOf("MediaError"), ["code", "message"]);

  (function installTimeRanges() {
    var proto = protoOf("TimeRanges");
    if (!proto) return;
    stateGetter(proto, ["length"]);
    ["start", "end"].forEach(function (name) {
      patch(proto, name, function (index) {
        var held = fieldsOf.get(this);
        if (!held) throw env.hideFrames(new TypeError("Illegal invocation"));
        throw domException("Failed to execute '" + name + "' on 'TimeRanges': The index provided (" + (Number(index) >>> 0) + ") is greater than or equal to the maximum bound (0).", "IndexSizeError");
      });
    });
  })();

  stateGetter(protoOf("TextTrackList"), ["length"]);

  // MediaSource: closed until a media element opens it through its object URL.
  var sourceState = new WeakMap();

  var SOURCE_CONTAINERS = { "video/mp4": 1, "audio/mp4": 1, "video/webm": 1, "audio/webm": 1, "video/mp2t": 1, "audio/mpeg": 1, "audio/aac": 1, "audio/flac": 1 };
  var SOURCE_CODECS = /^(avc1|avc3|mp4a|vp8|vp9|vp09|av01|opus|vorbis|flac|mp3|mp4v)(\.|$)/i;

  var sourceSupported = function (type) {
    var text = String(type);
    var main = text.split(";")[0].trim().toLowerCase();
    if (!SOURCE_CONTAINERS[main]) return false;
    var codecs = /codecs\s*=\s*"?([^"]*)"?/i.exec(text);
    if (!codecs) return true;
    return codecs[1].split(",").every(function (codec) { return SOURCE_CODECS.test(codec.trim()); });
  };

  var openSource = function (source, node) {
    var held = sourceState.get(source);
    if (held.readyState !== "closed") return;
    held.readyState = "open";
    held.media = node;
    dispatch(source, makeEvent("sourceopen"));
  };

  (function installMediaSource() {
    var Original = globalThis.MediaSource;
    if (typeof Original !== "function") return;

    var Shell = env.installShell("MediaSource", function (args, target) {
      var object = Object.create(target.prototype);
      sourceState.set(object, {
        readyState: "closed",
        duration: NaN,
        buffers: env.listOf([], "SourceBufferList"),
        active: env.listOf([], "SourceBufferList"),
        media: null,
      });
      return object;
    }, 0);
    if (!Shell) return;

    var own = function (holder) {
      var held = sourceState.get(holder);
      if (!held) throw env.hideFrames(new TypeError("Illegal invocation"));
      return held;
    };

    patchGetter(Shell.prototype, "readyState", function () { return own(this).readyState; });
    patchGetter(Shell.prototype, "duration", function () { return own(this).duration; });
    patchGetter(Shell.prototype, "sourceBuffers", function () { return own(this).buffers; });
    patchGetter(Shell.prototype, "activeSourceBuffers", function () { return own(this).active; });
    patch(Shell, "isTypeSupported", function isTypeSupported(type) { return sourceSupported(type); });
    if (hasOwn(Original, "canConstructInDedicatedWorker") || "canConstructInDedicatedWorker" in Original) {
      patchGetter(Shell, "canConstructInDedicatedWorker", function () { return true; });
    }
    patch(Shell.prototype, "addSourceBuffer", function addSourceBuffer(type) {
      var held = own(this);
      if (!sourceSupported(type)) {
        throw domException("Failed to execute 'addSourceBuffer' on 'MediaSource': The type provided ('" + String(type) + "') is unsupported.", "NotSupportedError");
      }
      if (held.readyState !== "open") {
        throw domException("Failed to execute 'addSourceBuffer' on 'MediaSource': The MediaSource's readyState is not 'open'.", "InvalidStateError");
      }
      return Object.create(protoOf("SourceBuffer") || Object.prototype);
    });
    patch(Shell.prototype, "endOfStream", function endOfStream() {
      var held = own(this);
      if (held.readyState !== "open") {
        throw domException("Failed to execute 'endOfStream' on 'MediaSource': The MediaSource's readyState is not 'open'.", "InvalidStateError");
      }
      held.readyState = "ended";
      dispatch(this, makeEvent("sourceended"));
    });
  })();

  // ---------------------------------------------------------------------------------------------
  // Mutation observers: records queue per observer and reach it in a microtask, as Chrome
  // delivers them; an observer watching a node's subtree hears its descendants too.

  var registrations = new WeakMap();
  var observerState = new WeakMap();
  var notifyQueued = false;
  var pendingObservers = [];

  var recordFields = ["type", "target", "addedNodes", "removedNodes", "previousSibling", "nextSibling", "attributeName", "attributeNamespace", "oldValue"];
  stateGetter(protoOf("MutationRecord"), recordFields);

  var deliver = function () {
    notifyQueued = false;
    var observers = pendingObservers;
    pendingObservers = [];

    observers.forEach(function (observer) {
      var held = observerState.get(observer);
      var records = held.records;
      held.records = [];
      if (!records.length) return;
      try {
        held.callback.call(observer, records, observer);
      } catch (error) {
        env.reportException(error);
      }
    });
  };

  env.queueMutation = function (change) {
    var interested = new Map();

    for (var node = change.target, depth = 0; node && depth < 512; depth += 1) {
      var list = registrations.get(node);

      if (list) {
        for (var index = 0; index < list.length; index += 1) {
          var registration = list[index];
          var options = registration.options;
          if (node !== change.target && !options.subtree) continue;
          if (change.type === "attributes" && !options.attributes) continue;
          if (change.type === "attributes" && options.attributeFilter && options.attributeFilter.indexOf(change.attributeName) === -1) continue;
          if (change.type === "characterData" && !options.characterData) continue;
          if (change.type === "childList" && !options.childList) continue;

          var wantsOld = (change.type === "attributes" && options.attributeOldValue) || (change.type === "characterData" && options.characterDataOldValue);
          if (!interested.has(registration.observer) || wantsOld) interested.set(registration.observer, wantsOld);
        }
      }

      var state = nodeState(node);
      node = state ? state.parentNode : null;
    }

    interested.forEach(function (wantsOld, observer) {
      var record = made("MutationRecord", {
        type: change.type,
        target: change.target,
        addedNodes: env.listOf(change.addedNodes || [], "NodeList"),
        removedNodes: env.listOf(change.removedNodes || [], "NodeList"),
        previousSibling: change.previousSibling || null,
        nextSibling: change.nextSibling || null,
        attributeName: change.type === "attributes" ? change.attributeName : null,
        attributeNamespace: change.type === "attributes" ? change.attributeNamespace : null,
        oldValue: wantsOld ? change.oldValue : null,
      });

      observerState.get(observer).records.push(record);
      if (pendingObservers.indexOf(observer) === -1) pendingObservers.push(observer);
    });

    if (interested.size && !notifyQueued) {
      notifyQueued = true;
      Promise.resolve().then(deliver);
    }
  };

  (function installMutationObserver() {
    var Shell = env.installShell("MutationObserver", function (args, target) {
      if (typeof args[0] !== "function") {
        throw env.hideFrames(new TypeError("Failed to construct 'MutationObserver': parameter 1 is not of type 'MutationCallback'."));
      }
      var object = Object.create(target.prototype);
      observerState.set(object, { callback: args[0], records: [], nodes: [] });
      return object;
    }, 1, { required: 1 });
    if (!Shell) return;

    if (typeof globalThis.WebKitMutationObserver === "function") {
      Object.defineProperty(globalThis, "WebKitMutationObserver", { value: Shell, writable: true, enumerable: false, configurable: true });
    }

    var own = function (holder) {
      var held = observerState.get(holder);
      if (!held) throw env.hideFrames(new TypeError("Illegal invocation"));
      return held;
    };

    var fail = function (text) {
      throw env.hideFrames(new TypeError("Failed to execute 'observe' on 'MutationObserver': " + text));
    };

    patch(Shell.prototype, "observe", function observe(target, given) {
      var held = own(this);
      if (arguments.length < 1) fail("1 argument required, but only 0 present.");
      if (!nodeState(target)) fail("parameter 1 is not of type 'Node'.");

      var init = given === undefined || given === null ? {} : given;
      var options = {
        childList: Boolean(init.childList),
        attributes: init.attributes === undefined ? undefined : Boolean(init.attributes),
        characterData: init.characterData === undefined ? undefined : Boolean(init.characterData),
        subtree: Boolean(init.subtree),
        attributeOldValue: init.attributeOldValue === undefined ? undefined : Boolean(init.attributeOldValue),
        characterDataOldValue: init.characterDataOldValue === undefined ? undefined : Boolean(init.characterDataOldValue),
        attributeFilter: init.attributeFilter === undefined ? undefined : Array.from(init.attributeFilter, String),
      };

      if ((options.attributeOldValue !== undefined || options.attributeFilter !== undefined) && options.attributes === undefined) options.attributes = true;
      if (options.characterDataOldValue !== undefined && options.characterData === undefined) options.characterData = true;
      options.attributes = Boolean(options.attributes);
      options.characterData = Boolean(options.characterData);

      if (!options.childList && !options.attributes && !options.characterData) {
        fail("The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.");
      }
      if (options.attributeOldValue && !options.attributes) {
        fail("The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.");
      }
      if (options.attributeFilter && !options.attributes) {
        fail("The options object may only set 'attributeFilter' when 'attributes' is true or not present.");
      }
      if (options.characterDataOldValue && !options.characterData) {
        fail("The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.");
      }

      var list = registrations.get(target);
      if (!list) {
        list = [];
        registrations.set(target, list);
      }

      for (var index = 0; index < list.length; index += 1) {
        if (list[index].observer === this) {
          list[index].options = options;
          return undefined;
        }
      }

      list.push({ observer: this, options: options });
      held.nodes.push(target);
      return undefined;
    });

    patch(Shell.prototype, "disconnect", function disconnect() {
      var held = own(this);
      var observer = this;
      held.nodes.forEach(function (node) {
        var list = registrations.get(node) || [];
        for (var index = list.length - 1; index >= 0; index -= 1) if (list[index].observer === observer) list.splice(index, 1);
      });
      held.nodes = [];
      held.records = [];
      return undefined;
    });

    patch(Shell.prototype, "takeRecords", function takeRecords() {
      var held = own(this);
      var records = held.records;
      held.records = [];
      return records;
    });
  })();

  // ---------------------------------------------------------------------------------------------
  // The performance timeline: the host's navigation, resource and visibility entries as Chrome's
  // entry objects, and the marks and measures the page makes; observers hear new entries as a
  // task, and earlier ones too when they ask for buffered.

  var ENTRY_INTERFACES = {
    navigation: "PerformanceNavigationTiming",
    resource: "PerformanceResourceTiming",
    mark: "PerformanceMark",
    measure: "PerformanceMeasure",
    paint: "PerformancePaintTiming",
    "visibility-state": "VisibilityStateEntry",
    "largest-contentful-paint": "LargestContentfulPaint",
    "layout-shift": "LayoutShift",
    longtask: "PerformanceLongTaskTiming",
    "first-input": "PerformanceEventTiming",
    event: "PerformanceEventTiming",
    element: "PerformanceElementTiming",
    "long-animation-frame": "PerformanceLongAnimationFrameTiming",
  };

  var timeline = [];
  var entryFields = new WeakMap();

  // A getter for `name` on the prototype in the entry's chain that declares it (Chrome's shape), or
  // on its own interface when none does. Which prototypes have which getters is kept beside them.
  var declared = new WeakMap();

  var declareEntryField = function (proto, name) {
    var holder = proto;
    while (holder && holder !== Object.prototype) {
      if (hasOwn(holder, name)) break;
      holder = Object.getPrototypeOf(holder);
    }
    if (!holder || holder === Object.prototype) holder = proto;
    var marks = declared.get(holder);
    if (!marks) {
      marks = Object.create(null);
      declared.set(holder, marks);
    }
    if (marks[name]) return;
    marks[name] = true;
    patchGetter(holder, name, function () {
      var held = entryFields.get(this);
      if (!held) throw env.hideFrames(new TypeError("Illegal invocation"));
      return held[name];
    });
  };

  // The prototypes of an entry's interface, base first (PerformanceEntry, then e.g.
  // PerformanceResourceTiming, then PerformanceNavigationTiming).
  var chainOf = function (proto) {
    var chain = [];
    for (var at = proto; at && at !== Object.prototype; at = Object.getPrototypeOf(at)) chain.unshift(at);
    return chain;
  };

  // What Chrome holds in a field no capture or page gave: by the field's kind.
  var FIELD_DEFAULTS = {
    name: "", entryType: "", initiatorType: "", deliveryType: "", nextHopProtocol: "", renderBlockingStatus: "non-blocking",
    contentType: "", contentEncoding: "", workerMatchedSourceType: "", workerFinalSourceType: "", type: "navigate",
    serverTiming: [], notRestoredReasons: null, confidence: null, detail: null, responseStatus: 0,
  };

  var defaultFor = function (name) {
    if (name in FIELD_DEFAULTS) {
      var value = FIELD_DEFAULTS[name];
      return Array.isArray(value) ? value.slice() : value;
    }
    return 0;
  };

  // The order Chrome's toJSON writes an interface's own fields in (its WebIDL serializer order,
  // which is not the order of the prototype's properties), read from Chrome 156.
  var JSON_ORDER = {
    PerformanceEntry: ["name", "entryType", "startTime", "duration", "navigationId"],
    PerformanceResourceTiming: [
      "initiatorType", "deliveryType", "nextHopProtocol", "renderBlockingStatus", "contentType", "contentEncoding",
      "workerStart", "workerRouterEvaluationStart", "workerCacheLookupStart", "workerMatchedSourceType",
      "workerFinalSourceType", "redirectStart", "redirectEnd", "fetchStart", "domainLookupStart", "domainLookupEnd",
      "connectStart", "secureConnectionStart", "connectEnd", "requestStart", "responseStart",
      "firstInterimResponseStart", "finalResponseHeadersStart", "responseEnd", "transferSize", "encodedBodySize",
      "decodedBodySize", "responseStatus", "serverTiming",
    ],
    PerformanceNavigationTiming: [
      "unloadEventStart", "unloadEventEnd", "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd",
      "domComplete", "loadEventStart", "loadEventEnd", "type", "redirectCount", "activationStart", "criticalCHRestart",
      "notRestoredReasons", "confidence",
    ],
  };

  // Every field an entry's interface chain declares (base interface first), in the order Chrome's
  // toJSON serialises them.
  var entryFieldNames = function (proto) {
    var names = [];
    chainOf(proto).forEach(function (holder) {
      var own = Object.getOwnPropertyNames(holder).filter(function (name) {
        var descriptor = Object.getOwnPropertyDescriptor(holder, name);
        return descriptor && descriptor.get && names.indexOf(name) === -1;
      });
      var iface = holder.constructor && holder.constructor.name;
      var order = JSON_ORDER[iface];
      if (order) {
        order.forEach(function (name) { if (own.indexOf(name) !== -1) names.push(name); });
        own.forEach(function (name) { if (order.indexOf(name) === -1) names.push(name); });
      } else {
        own.forEach(function (name) { names.push(name); });
      }
    });
    return names;
  };

  var NUMBER_DEFAULTS = ["startTime", "duration"];

  var makeEntry = function (fields) {
    var iface = ENTRY_INTERFACES[fields.entryType] || "PerformanceEntry";
    var proto = protoOf(iface) || protoOf("PerformanceEntry") || Object.prototype;
    var entry = Object.create(proto);
    var held = {};

    for (var key in fields) held[key] = fields[key];
    NUMBER_DEFAULTS.forEach(function (key) { if (typeof held[key] !== "number") held[key] = 0; });
    entryFieldNames(proto).forEach(function (name) { if (!(name in held)) held[name] = defaultFor(name); });
    if (fields.entryType === "mark" || fields.entryType === "measure") {
      if (!("detail" in held)) held.detail = null;
    }

    entryFields.set(entry, held);
    for (var name in held) declareEntryField(proto, name);
    return entry;
  };

  var hostEntries = function (type) {
    try {
      return JSON.parse(bridge.entries(String(type))) || [];
    } catch (error) {
      return [];
    }
  };

  var seeded = false;

  var seed = function () {
    if (seeded) return;
    seeded = true;
    ["navigation", "resource", "visibility-state", "paint"].forEach(function (type) {
      hostEntries(type).forEach(function (fields) { timeline.push(makeEntry(fields)); });
    });
  };

  var entriesWhere = function (test) {
    seed();
    return timeline.filter(test).sort(function (left, right) { return entryFields.get(left).startTime - entryFields.get(right).startTime; });
  };

  var perfObservers = [];

  var addEntry = function (entry) {
    timeline.push(entry);
    var type = entryFields.get(entry).entryType;

    perfObservers.forEach(function (observer) {
      var held = perfState.get(observer);
      if (held.types.indexOf(type) === -1) return;
      held.buffer.push(entry);
      if (!held.queued) {
        held.queued = true;
        later(function () { flushPerf(observer); }, 0);
      }
    });
  };

  var perfState = new WeakMap();

  var entryList = function (entries) {
    var list = made("PerformanceObserverEntryList", {});
    listEntries.set(list, entries);
    return list;
  };

  var listEntries = new WeakMap();

  var flushPerf = function (observer) {
    var held = perfState.get(observer);
    held.queued = false;
    if (!held.buffer.length || perfObservers.indexOf(observer) === -1) return;
    var entries = held.buffer;
    held.buffer = [];
    try {
      held.callback.call(observer, entryList(entries), observer, { droppedEntriesCount: 0 });
    } catch (error) {
      env.reportException(error);
    }
  };

  (function installTimeline() {
    var performance = globalThis.performance;
    var proto = performance && Object.getPrototypeOf(performance);
    if (!proto) return;

    var nameOf = function (entry) { return entryFields.get(entry).name; };
    var typeOf = function (entry) { return entryFields.get(entry).entryType; };

    patch(proto, "getEntries", function getEntries() { return entriesWhere(function () { return true; }); });
    patch(proto, "getEntriesByType", function getEntriesByType(type) {
      return entriesWhere(function (entry) { return typeOf(entry) === String(type); });
    });
    patch(proto, "getEntriesByName", function getEntriesByName(name, type) {
      return entriesWhere(function (entry) { return nameOf(entry) === String(name) && (type === undefined || typeOf(entry) === String(type)); });
    });

    var navigationTiming = function (name) {
      var nav = entriesWhere(function (entry) { return typeOf(entry) === "navigation"; })[0];
      var held = nav ? entryFields.get(nav) : null;
      return held && typeof held[name] === "number" ? held[name] : null;
    };

    var timeOf = function (mark, method) {
      if (typeof mark === "number") return mark;
      var found = entriesWhere(function (entry) { return typeOf(entry) === "mark" && nameOf(entry) === String(mark); });
      if (found.length) return entryFields.get(found[found.length - 1]).startTime;
      var timing = navigationTiming(String(mark));
      if (timing !== null) return timing;
      throw domException("Failed to execute '" + method + "' on 'Performance': The mark '" + String(mark) + "' does not exist.", "SyntaxError");
    };

    patch(proto, "mark", function mark(name, options) {
      if (arguments.length < 1) throw env.hideFrames(new TypeError("Failed to execute 'mark' on 'Performance': 1 argument required, but only 0 present."));
      var start = options && options.startTime !== undefined ? Number(options.startTime) : env.clock();
      var entry = makeEntry({ name: String(name), entryType: "mark", startTime: start, duration: 0, detail: options && options.detail !== undefined ? options.detail : null });
      addEntry(entry);
      return entry;
    });

    patch(proto, "measure", function measure(name, start, end) {
      if (arguments.length < 1) throw env.hideFrames(new TypeError("Failed to execute 'measure' on 'Performance': 1 argument required, but only 0 present."));
      var detail = null;
      var from = 0;
      var to = env.clock();
      if (start && typeof start === "object") {
        detail = start.detail !== undefined ? start.detail : null;
        if (start.start !== undefined) from = timeOf(start.start, "measure");
        if (start.end !== undefined) to = timeOf(start.end, "measure");
        if (start.duration !== undefined) {
          if (start.start !== undefined) to = from + Number(start.duration);
          else from = to - Number(start.duration);
        }
      } else {
        if (start !== undefined) from = timeOf(start, "measure");
        if (end !== undefined) to = timeOf(end, "measure");
      }
      var entry = makeEntry({ name: String(name), entryType: "measure", startTime: from, duration: to - from, detail: detail });
      addEntry(entry);
      return entry;
    });

    var clear = function (type) {
      return function (name) {
        seed();
        for (var index = timeline.length - 1; index >= 0; index -= 1) {
          var held = entryFields.get(timeline[index]);
          if (held.entryType === type && (name === undefined || held.name === String(name))) timeline.splice(index, 1);
        }
      };
    };

    patch(proto, "clearMarks", asNative(clear("mark"), "clearMarks"));
    patch(proto, "clearMeasures", asNative(clear("measure"), "clearMeasures"));
    patch(proto, "clearResourceTimings", function clearResourceTimings() { clear("resource")(); });

    // Each entry interface has its own toJSON in Chrome; each serialises the fields its chain
    // declares, in their order.
    var entryToJSON = function toJSON() {
      var held = entryFields.get(this);
      if (!held) throw env.hideFrames(new TypeError("Illegal invocation"));
      var out = {};
      var entry = this;
      entryFieldNames(Object.getPrototypeOf(this)).forEach(function (name) {
        var value = entry[name];
        if (typeof value === "function") return;
        out[name] = Array.isArray(value) ? value.map(function (item) { return item && typeof item.toJSON === "function" ? item.toJSON() : item; }) : value;
      });
      return out;
    };

    var jsonHolders = ["PerformanceEntry"];
    for (var entryType in ENTRY_INTERFACES) if (jsonHolders.indexOf(ENTRY_INTERFACES[entryType]) === -1) jsonHolders.push(ENTRY_INTERFACES[entryType]);
    jsonHolders.forEach(function (iface) {
      var holder = protoOf(iface);
      if (holder && hasOwn(holder, "toJSON")) patch(holder, "toJSON", entryToJSON);
    });

    var listProto = protoOf("PerformanceObserverEntryList");
    if (listProto) {
      var listed = function (holder) {
        var found = listEntries.get(holder);
        if (!found) throw env.hideFrames(new TypeError("Illegal invocation"));
        return found;
      };
      patch(listProto, "getEntries", function getEntries() { return listed(this).slice(); });
      patch(listProto, "getEntriesByType", function getEntriesByType(type) { return listed(this).filter(function (entry) { return typeOf(entry) === String(type); }); });
      patch(listProto, "getEntriesByName", function getEntriesByName(name, type) {
        return listed(this).filter(function (entry) { return nameOf(entry) === String(name) && (type === undefined || typeOf(entry) === String(type)); });
      });
    }
  })();

  env.addPerformanceEntry = function (fields) { addEntry(makeEntry(fields)); };

  (function installPerformanceObserver() {
    var Original = globalThis.PerformanceObserver;
    if (typeof Original !== "function") return;
    var supported = (function () {
      try {
        var listed = Original.supportedEntryTypes;
        return Array.isArray(listed) && listed.length ? listed.slice() : Object.keys(ENTRY_INTERFACES).sort();
      } catch (error) {
        return Object.keys(ENTRY_INTERFACES).sort();
      }
    })();

    var Shell = env.installShell("PerformanceObserver", function (args, target) {
      if (typeof args[0] !== "function") {
        throw env.hideFrames(new TypeError("Failed to construct 'PerformanceObserver': parameter 1 is not of type 'PerformanceObserverCallback'."));
      }
      var object = Object.create(target.prototype);
      perfState.set(object, { callback: args[0], types: [], buffer: [], queued: false, mode: null });
      return object;
    }, 1, { required: 1 });
    if (!Shell) return;

    var frozen = Object.freeze(supported.slice());
    patchGetter(Shell, "supportedEntryTypes", function () { return frozen; });

    var own = function (holder) {
      var held = perfState.get(holder);
      if (!held) throw env.hideFrames(new TypeError("Illegal invocation"));
      return held;
    };

    patch(Shell.prototype, "observe", function observe(options) {
      var held = own(this);
      var init = options || {};
      var fail = function (text, kind) {
        if (kind) throw domException("Failed to execute 'observe' on 'PerformanceObserver': " + text, kind);
        throw env.hideFrames(new TypeError("Failed to execute 'observe' on 'PerformanceObserver': " + text));
      };

      if (init.entryTypes === undefined && init.type === undefined) fail("An observe() call must include either entryTypes or type arguments.");
      if (init.entryTypes !== undefined && init.type !== undefined) fail("An observe() call must not include both entryTypes and type arguments.");

      var asked = init.entryTypes !== undefined ? Array.from(init.entryTypes, String) : [String(init.type)];
      var mode = init.entryTypes !== undefined ? "multiple" : "single";
      if (held.mode && held.mode !== mode) {
        fail("You cannot call observe() with a different mode than the first one.", "InvalidModificationError");
      }
      held.mode = mode;

      var types = asked.filter(function (type) { return supported.indexOf(type) !== -1; });
      if (!types.length) return undefined;

      types.forEach(function (type) { if (held.types.indexOf(type) === -1) held.types.push(type); });
      if (perfObservers.indexOf(this) === -1) perfObservers.push(this);

      if (mode === "single" && init.buffered) {
        var observer = this;
        var earlier = entriesWhere(function (entry) { return entryFields.get(entry).entryType === types[0]; });
        if (earlier.length) {
          Array.prototype.push.apply(held.buffer, earlier);
          if (!held.queued) {
            held.queued = true;
            later(function () { flushPerf(observer); }, 0);
          }
        }
      }

      return undefined;
    });

    patch(Shell.prototype, "disconnect", function disconnect() {
      var held = own(this);
      var at = perfObservers.indexOf(this);
      if (at !== -1) perfObservers.splice(at, 1);
      held.buffer = [];
      held.types = [];
      return undefined;
    });

    patch(Shell.prototype, "takeRecords", function takeRecords() {
      var held = own(this);
      var taken = held.buffer;
      held.buffer = [];
      return taken;
    });
  })();

  // ---------------------------------------------------------------------------------------------
  // Resize and intersection observers: each target observed gets an initial observation at the
  // next rendering opportunity (a frame), from the layout the sandbox has, as a visible page has.

  var FRAME_MS = 16;

  var boxOf = function (node) {
    return env.boxOf ? env.boxOf(node) : { x: 0, y: 0, width: 0, height: 0 };
  };

  var rect = function (box) {
    return env.makeRect ? env.makeRect(box) : box;
  };

  var observerOf = function (name, construct, methods) {
    var held = new WeakMap();
    var Shell = env.installShell(name, function (args, target) {
      if (typeof args[0] !== "function") {
        throw env.hideFrames(new TypeError("Failed to construct '" + name + "': parameter 1 is not of type '" + name.replace("Observer", "ObserverCallback") + "'."));
      }
      var object = Object.create(target.prototype);
      held.set(object, construct(args));
      return object;
    }, 1, { required: 1 });
    if (!Shell) return null;

    var own = function (holder) {
      var found = held.get(holder);
      if (!found) throw env.hideFrames(new TypeError("Illegal invocation"));
      return found;
    };

    for (var key in methods) {
      (function (method, body) {
        patch(Shell.prototype, method, asNative(function () { return body.apply(this, [own(this)].concat(Array.prototype.slice.call(arguments))); }, method));
      })(key, methods[key]);
    }

    return { Shell: Shell, own: own };
  };

  var resizeObserver = observerOf("ResizeObserver", function (args) {
    return { callback: args[0], targets: [], queued: false };
  }, {
    observe: function (held, target) {
      if (!nodeState(target)) throw env.hideFrames(new TypeError("Failed to execute 'observe' on 'ResizeObserver': parameter 1 is not of type 'Element'."));
      if (held.targets.indexOf(target) !== -1) return undefined;
      held.targets.push(target);
      var observer = this;
      held.fresh = (held.fresh || []).concat([target]);
      if (!held.queued) {
        held.queued = true;
        later(function () {
          held.queued = false;
          var fresh = (held.fresh || []).filter(function (node) { return held.targets.indexOf(node) !== -1; });
          held.fresh = [];
          if (!fresh.length) return;
          var entries = fresh.map(function (node) {
            var box = boxOf(node);
            var size = function () { return made("ResizeObserverSize", { inlineSize: box.width, blockSize: box.height }); };
            return made("ResizeObserverEntry", {
              target: node,
              contentRect: rect({ x: 0, y: 0, width: box.width, height: box.height }),
              borderBoxSize: Object.freeze([size()]),
              contentBoxSize: Object.freeze([size()]),
              devicePixelContentBoxSize: Object.freeze([made("ResizeObserverSize", { inlineSize: box.width * (globalThis.devicePixelRatio || 1), blockSize: box.height * (globalThis.devicePixelRatio || 1) })]),
            });
          });
          try {
            held.callback.call(observer, entries, observer);
          } catch (error) {
            env.reportException(error);
          }
        }, FRAME_MS);
      }
      return undefined;
    },
    unobserve: function (held, target) {
      var at = held.targets.indexOf(target);
      if (at !== -1) held.targets.splice(at, 1);
      return undefined;
    },
    disconnect: function (held) {
      held.targets = [];
      return undefined;
    },
  });

  stateGetter(protoOf("ResizeObserverEntry"), ["target", "contentRect", "borderBoxSize", "contentBoxSize", "devicePixelContentBoxSize"]);
  stateGetter(protoOf("ResizeObserverSize"), ["inlineSize", "blockSize"]);

  var parseMargin = function (text) {
    var parts = String(text === undefined ? "0px" : text).trim().split(/\s+/);
    if (parts.length === 1) parts = [parts[0], parts[0], parts[0], parts[0]];
    if (parts.length === 2) parts = [parts[0], parts[1], parts[0], parts[1]];
    if (parts.length === 3) parts = [parts[0], parts[1], parts[2], parts[1]];
    return parts.map(function (part) { return /^-?[0-9.]+$/.test(part) ? part + "px" : part; }).join(" ");
  };

  var intersectionObserver = observerOf("IntersectionObserver", function (args) {
    var options = args[1] || {};
    var thresholds = options.threshold === undefined ? [0] : [].concat(options.threshold).map(Number).sort(function (a, b) { return a - b; });
    return {
      callback: args[0],
      targets: [],
      queued: false,
      root: options.root === undefined ? null : options.root,
      rootMargin: parseMargin(options.rootMargin),
      scrollMargin: parseMargin(options.scrollMargin),
      thresholds: Object.freeze(thresholds),
      delay: Number(options.delay) || 0,
      trackVisibility: Boolean(options.trackVisibility),
    };
  }, {
    observe: function (held, target) {
      if (!nodeState(target)) throw env.hideFrames(new TypeError("Failed to execute 'observe' on 'IntersectionObserver': parameter 1 is not of type 'Element'."));
      if (held.targets.indexOf(target) !== -1) return undefined;
      held.targets.push(target);
      var observer = this;
      held.fresh = (held.fresh || []).concat([target]);
      if (!held.queued) {
        held.queued = true;
        later(function () {
          held.queued = false;
          var fresh = (held.fresh || []).filter(function (node) { return held.targets.indexOf(node) !== -1; });
          held.fresh = [];
          if (!fresh.length) return;
          var view = { x: 0, y: 0, width: Number(globalThis.innerWidth) || 0, height: Number(globalThis.innerHeight) || 0 };
          var entries = fresh.map(function (node) {
            var box = boxOf(node);
            var left = Math.max(box.x, view.x);
            var top = Math.max(box.y, view.y);
            var right = Math.min(box.x + box.width, view.x + view.width);
            var bottom = Math.min(box.y + box.height, view.y + view.height);
            var seen = right >= left && bottom >= top && env.connected(node);
            var area = box.width * box.height;
            var visible = seen ? Math.max(0, right - left) * Math.max(0, bottom - top) : 0;
            return made("IntersectionObserverEntry", {
              target: node,
              time: env.clock(),
              rootBounds: rect(view),
              boundingClientRect: rect(box),
              intersectionRect: rect(seen ? { x: left, y: top, width: right - left, height: bottom - top } : { x: 0, y: 0, width: 0, height: 0 }),
              isIntersecting: seen,
              isVisible: false,
              intersectionRatio: seen ? (area ? visible / area : 1) : 0,
            });
          });
          try {
            held.callback.call(observer, entries, observer);
          } catch (error) {
            env.reportException(error);
          }
        }, FRAME_MS);
      }
      return undefined;
    },
    unobserve: function (held, target) {
      var at = held.targets.indexOf(target);
      if (at !== -1) held.targets.splice(at, 1);
      return undefined;
    },
    disconnect: function (held) {
      held.targets = [];
      return undefined;
    },
    takeRecords: function () {
      return [];
    },
  });

  if (intersectionObserver) {
    ["root", "rootMargin", "scrollMargin", "thresholds", "delay", "trackVisibility"].forEach(function (name) {
      patchGetter(intersectionObserver.Shell.prototype, name, function () { return intersectionObserver.own(this)[name]; });
    });
  }

  stateGetter(protoOf("IntersectionObserverEntry"), ["target", "time", "rootBounds", "boundingClientRect", "intersectionRect", "isIntersecting", "isVisible", "intersectionRatio"]);

  // ---------------------------------------------------------------------------------------------
  // Fonts. A FontFace loads as a task: local() names resolve against the fonts this machine has
  // (the profile's `localFonts`, full and PostScript names); url() sources go through the
  // transport and load only real font data. A failed load rejects with Chrome's NetworkError.

  var localFonts = (env.traits && env.traits.localFonts) || [];
  var knownLocal = {};
  localFonts.forEach(function (name) { knownLocal[String(name).toLowerCase()] = true; });

  var faceState = new WeakMap();

  var FONT_MAGIC = ["wOF2", "wOFF", "OTTO", "true", "\x00\x01\x00\x00", "ttcf"];

  var fontSources = function (text) {
    var out = [];
    var pattern = /(local|url)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
    var found;
    while ((found = pattern.exec(String(text)))) out.push({ kind: found[1].toLowerCase(), value: (found[2] !== undefined ? found[2] : found[3] !== undefined ? found[3] : found[4]).trim() });
    return out;
  };

  var loadFace = function (face) {
    var held = faceState.get(face);
    if (held.status !== "unloaded") return held.loaded;
    held.status = "loading";

    var settle = function (ok) {
      held.status = ok ? "loaded" : "error";
      if (ok) held.resolve(face);
      else held.reject(domException("A network error occurred.", "NetworkError"));
    };

    if (held.data) {
      later(function () { settle(FONT_MAGIC.some(function (magic) { var b = held.data; return b.length >= 4 && magic.split("").every(function (ch, at) { return b[at] === ch.charCodeAt(0); }); })); }, 0);
      return held.loaded;
    }

    // local() names are looked up at once (Chrome settles a face with only local sources before
    // load() returns); url() sources are fetched.
    var sources = fontSources(held.source);
    var next = function (index) {
      if (index >= sources.length) return settle(false);
      var source = sources[index];
      if (source.kind === "local") {
        if (knownLocal[source.value.toLowerCase()]) return settle(true);
        return next(index + 1);
      }
      load(source.value, "*/*", function (result) {
        var b = result.bytes;
        var real = result.ok && FONT_MAGIC.some(function (magic) { return b.length >= 4 && magic.split("").every(function (ch, at) { return b[at] === ch.charCodeAt(0); }); });
        if (real) settle(true);
        else next(index + 1);
      });
    };

    next(0);
    return held.loaded;
  };

  (function installFontFace() {
    var proto = protoOf("FontFace");
    if (!proto) return;

    var Shell = env.installShell("FontFace", function (args, target) {
      var object = Object.create(target.prototype);
      var descriptors = args[2] || {};
      var held = {
        family: String(args[0]),
        source: typeof args[1] === "string" ? args[1] : "",
        data: typeof args[1] === "string" ? null : (args[1] instanceof ArrayBuffer ? new Uint8Array(args[1]) : ArrayBuffer.isView(args[1]) ? new Uint8Array(args[1].buffer, args[1].byteOffset, args[1].byteLength) : new Uint8Array(0)),
        status: "unloaded",
        style: descriptors.style === undefined ? "normal" : String(descriptors.style),
        weight: descriptors.weight === undefined ? "normal" : String(descriptors.weight),
        stretch: descriptors.stretch === undefined ? "normal" : String(descriptors.stretch),
        unicodeRange: descriptors.unicodeRange === undefined ? "U+0-10FFFF" : String(descriptors.unicodeRange),
        variant: descriptors.variant === undefined ? "normal" : String(descriptors.variant),
        featureSettings: descriptors.featureSettings === undefined ? "normal" : String(descriptors.featureSettings),
        variationSettings: descriptors.variationSettings === undefined ? "normal" : String(descriptors.variationSettings),
        display: descriptors.display === undefined ? "auto" : String(descriptors.display),
        ascentOverride: descriptors.ascentOverride === undefined ? "normal" : String(descriptors.ascentOverride),
        descentOverride: descriptors.descentOverride === undefined ? "normal" : String(descriptors.descentOverride),
        lineGapOverride: descriptors.lineGapOverride === undefined ? "normal" : String(descriptors.lineGapOverride),
      };
      held.loaded = new Promise(function (resolved, rejected) { held.resolve = resolved; held.reject = rejected; });
      held.loaded.catch(function () {});
      faceState.set(object, held);
      if (held.data) loadFace(object);
      return object;
    }, 2, { required: 2 });
    if (!Shell) return;

    var own = function (holder) {
      var held = faceState.get(holder);
      if (!held) throw env.hideFrames(new TypeError("Illegal invocation"));
      return held;
    };

    ["family", "style", "weight", "stretch", "unicodeRange", "variant", "featureSettings", "variationSettings", "display", "ascentOverride", "descentOverride", "lineGapOverride"].forEach(function (name) {
      accessor(Shell.prototype, name, function () { return own(this)[name]; }, function (value) { own(this)[name] = String(value); });
    });
    patchGetter(Shell.prototype, "status", function () { return own(this).status; });
    patchGetter(Shell.prototype, "loaded", function () { return own(this).loaded; });
    patch(Shell.prototype, "load", function load() { own(this); return loadFace(this); });
  })();

  (function installFontSet() {
    var proto = protoOf("FontFaceSet");
    if (!proto) return;

    var facesOf = function (holder) {
      var list = [];
      try {
        list = Array.from(holder.values());
      } catch (error) {}
      return list;
    };

    var matching = function (holder, font) {
      var family = /(?:^|\s)(?:"([^"]+)"|'([^']+)'|([^\s,"']+))\s*(?:,|$)/.exec(String(font).replace(/^.*?\d+(?:\.\d+)?(px|pt|em|rem|%)\s*(\/\s*\S+\s*)?/, ""));
      var name = family ? (family[1] || family[2] || family[3]).toLowerCase() : "";
      return facesOf(holder).filter(function (face) { return faceState.has(face) && faceState.get(face).family.toLowerCase() === name; });
    };

    patch(proto, "check", function check(font) {
      if (arguments.length < 1) throw env.hideFrames(new TypeError("Failed to execute 'check' on 'FontFaceSet': 1 argument required, but only 0 present."));
      var faces = matching(this, font);
      return faces.every(function (face) { return faceState.get(face).status === "loaded"; });
    });
    patch(proto, "load", function load(font) {
      var faces = matching(this, font);
      return Promise.all(faces.map(function (face) { return loadFace(face); }));
    });
    patchGetter(proto, "status", function () {
      return facesOf(this).some(function (face) { return faceState.has(face) && faceState.get(face).status === "loading"; }) ? "loading" : "loaded";
    });
  })();

  // ---------------------------------------------------------------------------------------------
  // The hooks dom.js calls as the tree changes.

  var walk = function (node, visit) {
    visit(node);
    var state = nodeState(node);
    var kids = state && Array.isArray(state.childNodes) ? state.childNodes.slice() : [];
    for (var index = 0; index < kids.length; index += 1) walk(kids[index], visit);
  };

  env.nodeInserted = function (node) {
    walk(node, function (each) {
      var tag = tagOf(each);
      if (tag === "script") prepareScript(each);
      else if (tag === "link") processLink(each);
      else if (tag === "iframe") processFrame(each, true);
    });
  };

  var previousAttributeChanged = env.attributeChanged;

  env.attributeChanged = function (node, key, old, value) {
    previousAttributeChanged(node, key, old, value);
    var tag = tagOf(node);

    if (tag === "img" && (key === "src" || key === "srcset")) updateImage(node);
    else if ((tag === "video" || tag === "audio") && key === "src") mediaLoad(node);
    else if (tag === "script" && key === "src" && env.connected(node)) prepareScript(node);
    else if (tag === "link" && (key === "href" || key === "rel") && env.connected(node)) processLink(node);
    else if (tag === "iframe" && (key === "srcdoc" || key === "src") && nodeState(node).frame) processFrame(node, false);
  };
})();
