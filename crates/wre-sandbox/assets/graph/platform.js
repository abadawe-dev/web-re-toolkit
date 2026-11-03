// The platform module: the promise-returning APIs a page probes (user-agent hints, media
// capabilities, key systems, WebGPU, WebAuthn, storage, locks, devices, AI models, crypto,
// IndexedDB, caches, cookies), speech voices, WebRTC and Web Audio, answering as the captured
// Chrome did. Its answers come from the capture (traits.platform, recorded by capture-graph.html's
// platform facts); what follows from Chrome's own rules (validation, defaults) is computed.
// Evaluated in every window and frame, after dom.js.
(function () {
  var env = globalThis.__ENV;
  if (!env || typeof env.patch !== "function") return;

  var patch = env.patch;
  var patchGetter = env.patchGetter;
  var asNative = env.asNative;
  var traits = env.traits || {};
  // The capture's own answers, over what the Chrome build answers anywhere (platform-defaults.json,
  // for profiles captured before these facts were recorded).
  var facts = {};
  var defaults = env.platformDefaults || {};
  delete env.platformDefaults;
  Object.keys(defaults).forEach(function (key) { facts[key] = defaults[key]; });
  Object.keys(traits.platform || {}).forEach(function (key) { facts[key] = traits.platform[key]; });
  var bridge = env.bridge;

  var protoOf = function (value) {
    try {
      return value ? Object.getPrototypeOf(value) : null;
    } catch (error) {
      return null;
    }
  };

  var hasOwn = function (holder, key) {
    return Object.prototype.hasOwnProperty.call(holder, key);
  };

  var typeError = function (message) {
    return env.hideFrames(new TypeError(message));
  };

  var domError = function (message, name) {
    return env.domException(message, name);
  };

  // The answer to a call Chrome resolves from the browser process: it settles as a later task.
  var answer = function (make) {
    return new Promise(function (resolve, reject) {
      env.later(function () {
        try {
          resolve(make());
        } catch (error) {
          reject(error);
        }
      }, 0);
    });
  };

  var copy = function (value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  };

  // A platform object of `iface`, its attributes read from `fields` through the prototype's own
  // getters (the captured accessors read env.overrides), with no own properties, as Chrome's.
  var instance = function (iface, fields) {
    var holder = globalThis[iface];
    var made = Object.create(holder && holder.prototype ? holder.prototype : Object.prototype);
    env.overrides.set(made, fields || {});
    return made;
  };

  var fieldsOf = function (made) {
    return env.overrides.get(made);
  };

  // Accessor attributes defined afresh on a prototype (getter and, if given, setter), reading and
  // writing the instance's fields: for attributes a page sets (an oscillator's type, ...).
  var defineAttribute = function (proto, name, get, set) {
    if (!proto) return;
    var previous = Object.getOwnPropertyDescriptor(proto, name);

    try {
      Object.defineProperty(proto, name, {
        get: asNative(function () {
          var fields = fieldsOf(this);
          if (!fields) throw typeError("Illegal invocation");
          return get ? get.call(this, fields) : fields[name];
        }, "get " + name),
        set: set === false ? undefined : asNative(function (value) {
          var fields = fieldsOf(this);
          if (!fields) throw typeError("Illegal invocation");
          if (set) set.call(this, fields, value);
          else fields[name] = value;
        }, "set " + name),
        enumerable: previous ? previous.enumerable : true,
        configurable: true,
      });
    } catch (error) {}
  };

  var randomBytes = function (count) {
    var bytes = new Uint8Array(count);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  };

  var randomUuid = function () {
    return globalThis.crypto.randomUUID();
  };

  var enumOf = function (value, allowed, where, type) {
    var text = String(value);
    if (allowed.indexOf(text) === -1) throw typeError(where + "The provided value '" + text + "' is not a valid enum value of type " + type + ".");
    return text;
  };

  var sequenceOf = function (value, where) {
    if (value === null || value === undefined || typeof value[Symbol.iterator] !== "function" || typeof value === "string") {
      throw typeError(where + "The provided value cannot be converted to a sequence.");
    }
    return Array.from(value);
  };

  var required = function (args, count, method, iface) {
    if (args.length < count) {
      throw typeError("Failed to execute '" + method + "' on '" + iface + "': " + count + " argument" + (count === 1 ? "" : "s") + " required, but only " + args.length + " present.");
    }
  };

  // A promise-returning operation: Chrome turns a thrown argument error into a rejection.
  var promising = function (implementation) {
    return function () {
      try {
        return implementation.apply(this, arguments);
      } catch (error) {
        return Promise.reject(error);
      }
    };
  };

  var navigatorProto = protoOf(globalThis.navigator);

  // ---- User-agent client hints ----------------------------------------------------------------

  (function installUserAgentData() {
    var data = globalThis.NavigatorUAData && globalThis.NavigatorUAData.prototype;
    var hints = facts.highEntropy || traits.highEntropy;
    if (!data || !hints) return;

    var HINTS = ["architecture", "bitness", "formFactors", "fullVersionList", "model", "platformVersion", "uaFullVersion", "wow64"];
    var brands = function () { return copy(hints.brands); };

    patchGetter(data, "brands", function () { return brands(); });
    patchGetter(data, "mobile", function () { return Boolean(hints.mobile); });
    patchGetter(data, "platform", function () { return String(hints.platform); });

    patch(data, "getHighEntropyValues", promising(function getHighEntropyValues(wanted) {
      required(arguments, 1, "getHighEntropyValues", "NavigatorUAData");
      var asked = sequenceOf(wanted, "Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': ").map(String);

      return answer(function () {
        var values = { brands: brands(), mobile: Boolean(hints.mobile), platform: String(hints.platform) };
        HINTS.forEach(function (hint) {
          if (asked.indexOf(hint) !== -1 && hasOwn(hints, hint)) values[hint] = copy(hints[hint]);
        });
        var sorted = {};
        Object.keys(values).sort().forEach(function (key) { sorted[key] = values[key]; });
        return sorted;
      });
    }));

    patch(data, "toJSON", function toJSON() {
      return { brands: brands(), mobile: Boolean(hints.mobile), platform: String(hints.platform) };
    });
  })();

  // ---- Media capabilities -----------------------------------------------------------------------

  var canPlay = function (contentType) {
    var table = traits && env.media ? env.media : null;
    var kind = /^audio\//i.test(contentType) ? "audio" : "video";
    if (table && table[kind] && hasOwn(table[kind], contentType)) return table[kind][contentType];
    var other = kind === "audio" ? "video" : "audio";
    if (table && table[other] && hasOwn(table[other], contentType)) return table[other][contentType];
    var element = globalThis.document.createElement(kind);
    return element.canPlayType(contentType);
  };

  var WEBRTC_CODECS = { "video/vp8": [true, true, false], "video/vp9": [true, true, false], "video/h264": [true, true, false], "video/av1": [true, true, false],
    "audio/opus": [true, true, true], "audio/pcmu": [true, true, true], "audio/pcma": [true, true, true], "audio/g722": [true, true, true], "audio/isac": [false, false, false] };

  // A media configuration's answer: the one Chrome gave for it in the capture, else by Chrome's
  // rule (a file or media source decodes what canPlayType calls "probably"; audio decodes
  // power-efficiently, video in software here does not).
  var mediaAnswer = function (table, type, kind, contentType) {
    var key = type + "|" + kind + "|" + contentType;
    var recorded = table && table[key];
    if (Array.isArray(recorded)) return recorded;
    if (type === "webrtc") {
      var codec = WEBRTC_CODECS[String(contentType).toLowerCase().split(";")[0].trim()];
      return codec || [false, false, false];
    }
    var supported = canPlay(contentType) === "probably";
    return [supported, supported, supported && kind === "audio"];
  };

  var readMediaConfiguration = function (config, method, dictionary, types, typeName) {
    var where = "Failed to execute '" + method + "' on 'MediaCapabilities': ";
    if (config === undefined || config === null) {
      throw typeError(where + "Failed to read the 'type' property from '" + dictionary + "': Required member is undefined.");
    }
    if (typeof config !== "object" && typeof config !== "function") {
      throw typeError(where + "The provided value is not of type '" + dictionary + "'.");
    }

    var member = function (holder, name, inside, needed) {
      var value = holder[name];
      if (value === undefined && needed) {
        throw typeError(where + inside + "Failed to read the '" + name + "' property from '" + needed + "': Required member is undefined.");
      }
      return value;
    };

    var read = { audio: null, video: null, type: null };
    var audio = config.audio;

    if (audio !== undefined) {
      var inAudio = "Failed to read the 'audio' property from 'MediaConfiguration': ";
      if (audio === null || typeof audio !== "object") throw typeError(where + inAudio + "The provided value is not of type 'AudioConfiguration'.");
      void audio.bitrate;
      void audio.channels;
      read.audio = { contentType: String(member(audio, "contentType", inAudio, "AudioConfiguration")) };
      void audio.samplerate;
      void audio.spatialRendering;
    }

    var video = config.video;

    if (video !== undefined) {
      var inVideo = "Failed to read the 'video' property from 'MediaConfiguration': ";
      if (video === null || typeof video !== "object") throw typeError(where + inVideo + "The provided value is not of type 'VideoConfiguration'.");
      member(video, "bitrate", inVideo, "VideoConfiguration");
      void video.colorGamut;
      var contentType = member(video, "contentType", inVideo, "VideoConfiguration");
      member(video, "framerate", inVideo, "VideoConfiguration");
      void video.hasAlphaChannel;
      void video.hdrMetadataType;
      member(video, "height", inVideo, "VideoConfiguration");
      void video.scalabilityMode;
      void video.spatialScalability;
      void video.transferFunction;
      member(video, "width", inVideo, "VideoConfiguration");
      read.video = { contentType: String(contentType) };
    }

    void config.keySystemConfiguration;
    var type = config.type;
    if (type === undefined) throw typeError(where + "Failed to read the 'type' property from '" + dictionary + "': Required member is undefined.");
    read.type = enumOf(type, types, where, typeName);

    if (!read.audio && !read.video) throw typeError(where + "The configuration dictionary has neither |video| nor |audio| specified.");
    return read;
  };

  var mediaResult = function (table, read) {
    var parts = [];
    if (read.video) parts.push(mediaAnswer(table, read.type, "video", read.video.contentType));
    if (read.audio) parts.push(mediaAnswer(table, read.type, "audio", read.audio.contentType));
    var all = function (index) { return parts.every(function (part) { return part[index]; }); };
    return { powerEfficient: all(2), smooth: all(1), supported: all(0) };
  };

  (function installMediaCapabilities() {
    var capabilities = globalThis.MediaCapabilities && globalThis.MediaCapabilities.prototype;
    if (!capabilities) return;

    patch(capabilities, "decodingInfo", promising(function decodingInfo(config) {
      required(arguments, 1, "decodingInfo", "MediaCapabilities");
      var read = readMediaConfiguration(config, "decodingInfo", "MediaDecodingConfiguration", ["file", "media-source", "webrtc"], "MediaDecodingType");
      return answer(function () {
        var result = mediaResult(facts.decoding, read);
        result.keySystemAccess = null;
        return result;
      });
    }));

    patch(capabilities, "encodingInfo", promising(function encodingInfo(config) {
      required(arguments, 1, "encodingInfo", "MediaCapabilities");
      var read = readMediaConfiguration(config, "encodingInfo", "MediaEncodingConfiguration", ["webrtc"], "MediaEncodingType");
      return answer(function () { return mediaResult(facts.encoding, read); });
    }));
  })();

  // ---- Encrypted media --------------------------------------------------------------------------

  (function installKeySystems() {
    if (!navigatorProto || typeof globalThis.navigator.requestMediaKeySystemAccess !== "function") return;
    var systems = facts.keySystems || {};
    var accessProto = globalThis.MediaKeySystemAccess && globalThis.MediaKeySystemAccess.prototype;
    var keysProto = globalThis.MediaKeys && globalThis.MediaKeys.prototype;
    var configurations = new WeakMap();

    var INIT_TYPES = ["cenc", "keyids", "webm"];

    var capabilitiesOf = function (list) {
      if (list === undefined) return [];
      return Array.from(list).map(function (one) {
        return { contentType: String(one.contentType === undefined ? "" : one.contentType), encryptionScheme: one.encryptionScheme === undefined ? null : one.encryptionScheme, robustness: String(one.robustness === undefined ? "" : one.robustness) };
      }).filter(function (one) { return canPlay(one.contentType) === "probably"; });
    };

    // The first of the page's configurations this key system can play, as Chrome chooses it.
    var choose = function (system, configs) {
      var recorded = systems[system] && systems[system].configuration;

      for (var index = 0; index < configs.length; index += 1) {
        var config = configs[index] || {};
        var initDataTypes = config.initDataTypes === undefined ? [] : Array.from(config.initDataTypes).map(String).filter(function (type) { return INIT_TYPES.indexOf(type) !== -1; });
        if (config.initDataTypes !== undefined && !initDataTypes.length) continue;
        var video = capabilitiesOf(config.videoCapabilities);
        var audio = capabilitiesOf(config.audioCapabilities);
        if (config.videoCapabilities !== undefined && Array.from(config.videoCapabilities).length && !video.length) continue;
        if (config.audioCapabilities !== undefined && Array.from(config.audioCapabilities).length && !audio.length) continue;
        if (!video.length && !audio.length) continue;

        return {
          audioCapabilities: audio,
          distinctiveIdentifier: recorded ? recorded.distinctiveIdentifier : "not-allowed",
          initDataTypes: initDataTypes,
          label: config.label === undefined ? "" : String(config.label),
          persistentState: recorded ? recorded.persistentState : "not-allowed",
          sessionTypes: recorded ? copy(recorded.sessionTypes) : ["temporary"],
          videoCapabilities: video,
        };
      }

      return null;
    };

    if (accessProto) {
      patch(accessProto, "getConfiguration", function getConfiguration() {
        var held = configurations.get(this);
        if (!held) throw typeError("Illegal invocation");
        return copy(held);
      });
      patch(accessProto, "createMediaKeys", function createMediaKeys() {
        if (!configurations.get(this)) return Promise.reject(typeError("Illegal invocation"));
        return answer(function () { return instance("MediaKeys", {}); });
      });
    }

    if (keysProto) {
      patch(keysProto, "setServerCertificate", promising(function setServerCertificate() {
        required(arguments, 1, "setServerCertificate", "MediaKeys");
        return answer(function () { return false; });
      }));
      patch(keysProto, "getStatusForPolicy", promising(function getStatusForPolicy() {
        return answer(function () { return "usable"; });
      }));
    }

    patch(navigatorProto, "requestMediaKeySystemAccess", promising(function requestMediaKeySystemAccess(system, configs) {
      required(arguments, 2, "requestMediaKeySystemAccess", "Navigator");
      var where = "Failed to execute 'requestMediaKeySystemAccess' on 'Navigator': ";
      var name = String(system);
      var list = sequenceOf(configs, where);
      if (!name) throw typeError(where + "The keySystem parameter is empty.");
      if (!list.length) throw typeError(where + "The supportedConfigurations parameter is empty.");

      return answer(function () {
        var chosen = systems[name] && systems[name].granted ? choose(name, list) : null;
        if (!chosen) throw domError("Unsupported keySystem or supportedConfigurations.", "NotSupportedError");
        var access = instance("MediaKeySystemAccess", { keySystem: name });
        configurations.set(access, chosen);
        return access;
      });
    }));
  })();

  // ---- WebGPU -----------------------------------------------------------------------------------

  (function installGpu() {
    var gpuProto = globalThis.GPU && globalThis.GPU.prototype;
    var gpu = facts.gpu;
    if (!gpuProto || !gpu) return;

    patch(gpuProto, "requestAdapter", promising(function requestAdapter() {
      return answer(function () { return null; });
    }));
    // The swap-chain format is the OS's: Chrome prefers RGBA on Linux and Android, BGRA elsewhere.
    var recorded = traits.platform && traits.platform.gpu;
    var format = recorded ? gpu.format : /^(Linux|Android)/.test(String(globalThis.navigator.platform)) ? "rgba8unorm" : "bgra8unorm";
    patch(gpuProto, "getPreferredCanvasFormat", function getPreferredCanvasFormat() { return format; });

    var featuresProto = globalThis.WGSLLanguageFeatures && globalThis.WGSLLanguageFeatures.prototype;
    if (featuresProto && gpu.wgsl) {
      var features = instance("WGSLLanguageFeatures", { size: gpu.wgsl.length });
      var list = gpu.wgsl.slice();
      var iterate = function () { return list.slice()[Symbol.iterator](); };
      patch(featuresProto, "has", function has(name) { return list.indexOf(String(name)) !== -1; });
      patch(featuresProto, "values", function values() { return iterate(); });
      patch(featuresProto, "keys", function keys() { return iterate(); });
      patch(featuresProto, "entries", function entries() { return list.map(function (name) { return [name, name]; })[Symbol.iterator](); });
      patch(featuresProto, "forEach", function forEach(callback, self) {
        list.forEach(function (name) { callback.call(self, name, name, features); });
      });
      patchGetter(featuresProto, "size", function () { return list.length; });
      patchGetter(gpuProto, "wgslLanguageFeatures", function () { return features; });
    }
  })();

  // ---- WebAuthn and credentials -------------------------------------------------------------------

  (function installCredentials() {
    var webauthn = facts.webauthn;
    var Public = globalThis.PublicKeyCredential;

    if (Public && webauthn) {
      patch(Public, "isUserVerifyingPlatformAuthenticatorAvailable", function isUserVerifyingPlatformAuthenticatorAvailable() {
        return answer(function () { return Boolean(webauthn.uvpa); });
      });
      if (typeof Public.isConditionalMediationAvailable === "function") {
        patch(Public, "isConditionalMediationAvailable", function isConditionalMediationAvailable() {
          return answer(function () { return Boolean(webauthn.conditional); });
        });
      }
      if (typeof Public.getClientCapabilities === "function") {
        patch(Public, "getClientCapabilities", function getClientCapabilities() {
          return answer(function () { return copy(webauthn.capabilities); });
        });
      }
    }

    var container = globalThis.CredentialsContainer && globalThis.CredentialsContainer.prototype;
    if (container) {
      // Without a saved password or a passkey prompt answered, Chrome settles a get with null.
      patch(container, "get", promising(function get() {
        return answer(function () { return null; });
      }));
      patch(container, "preventSilentAccess", function preventSilentAccess() {
        return answer(function () { return undefined; });
      });
      patch(container, "store", promising(function store(credential) {
        required(arguments, 1, "store", "CredentialsContainer");
        return answer(function () { return credential; });
      }));
    }
  })();

  // ---- Service workers, storage --------------------------------------------------------------------

  (function installServiceWorker() {
    var container = globalThis.ServiceWorkerContainer && globalThis.ServiceWorkerContainer.prototype;
    if (!container) return;

    var ready = new Promise(function () {});

    patch(container, "getRegistration", promising(function getRegistration() {
      return answer(function () { return undefined; });
    }));
    patch(container, "getRegistrations", function getRegistrations() {
      return answer(function () { return []; });
    });
    patchGetter(container, "ready", function () { return ready; });
    patchGetter(container, "controller", function () { return null; });
  })();

  (function installStorage() {
    var manager = globalThis.StorageManager && globalThis.StorageManager.prototype;
    // A fresh origin's answers (the quota, a share of the disk, as the older captures assumed)
    // where the capture recorded none.
    var storage = facts.storage || { quota: 3221225472, usage: 0, usageDetails: {}, persisted: false, storageAccess: true, persist: true };

    if (manager) {
      var persisted = Boolean(storage.persisted);
      patch(manager, "estimate", function estimate() {
        return answer(function () { return { quota: storage.quota, usage: storage.usage, usageDetails: copy(storage.usageDetails) }; });
      });
      patch(manager, "persisted", function persisted_() {
        return answer(function () { return persisted; });
      });
      patch(manager, "persist", function persist() {
        return answer(function () {
          if (storage.persist) persisted = true;
          return Boolean(storage.persist);
        });
      });
    }

    var documentProto = globalThis.Document && globalThis.Document.prototype;
    if (documentProto) {
      if (typeof globalThis.document.hasStorageAccess === "function") {
        patch(documentProto, "hasStorageAccess", function hasStorageAccess() {
          return answer(function () { return Boolean(storage.storageAccess); });
        });
      }
      if (typeof globalThis.document.requestStorageAccess === "function") {
        patch(documentProto, "requestStorageAccess", function requestStorageAccess() {
          return answer(function () { return undefined; });
        });
      }
    }
  })();

  // ---- Clipboard, wake lock, locks --------------------------------------------------------------

  (function installClipboard() {
    var clipboard = globalThis.Clipboard && globalThis.Clipboard.prototype;
    if (!clipboard) return;

    // The page never holds focus (document.hasFocus() is false), so Chrome refuses every access.
    ["read", "readText", "write", "writeText"].forEach(function (method) {
      if (typeof clipboard[method] !== "function") return;
      patch(clipboard, method, function () {
        if ((method === "write" || method === "writeText") && arguments.length < 1) {
          return Promise.reject(typeError("Failed to execute '" + method + "' on 'Clipboard': 1 argument required, but only 0 present."));
        }
        return Promise.reject(domError("Failed to execute '" + method + "' on 'Clipboard': Document is not focused.", "NotAllowedError"));
      });
    });
  })();

  (function installWakeLock() {
    var wakeLock = globalThis.WakeLock && globalThis.WakeLock.prototype;
    var sentinelProto = globalThis.WakeLockSentinel && globalThis.WakeLockSentinel.prototype;
    if (!wakeLock || !sentinelProto) return;

    patch(wakeLock, "request", promising(function request(type) {
      var kind = enumOf(type === undefined ? "screen" : type, ["screen"], "Failed to execute 'request' on 'WakeLock': ", "WakeLockType");
      // Chrome grants a screen lock only to the foreground page; this one never holds focus.
      if (globalThis.document.visibilityState !== "visible" || !globalThis.document.hasFocus()) {
        throw domError("Failed to execute 'request' on 'WakeLock': The requesting page is not visible", "NotAllowedError");
      }
      return answer(function () { return instance("WakeLockSentinel", { released: false, type: kind, onrelease: null }); });
    }));

    patch(sentinelProto, "release", function release() {
      var fields = fieldsOf(this);
      if (!fields) return Promise.reject(typeError("Illegal invocation"));
      var sentinel = this;
      return answer(function () {
        if (!fields.released) {
          fields.released = true;
          env.dispatch(sentinel, env.makeEvent("release"));
        }
        return undefined;
      });
    });
  })();

  (function installLocks() {
    var manager = globalThis.LockManager && globalThis.LockManager.prototype;
    if (!manager) return;

    var clientId = randomUuid();
    var held = [];
    var waiting = [];

    var grantable = function (entry) {
      return held.every(function (lock) { return lock.name !== entry.name || (lock.mode === "shared" && entry.mode === "shared"); }) &&
        waiting.every(function (other) { return other === entry || other.name !== entry.name || waiting.indexOf(other) > waiting.indexOf(entry); });
    };

    var pump = function () {
      for (var index = 0; index < waiting.length; index += 1) {
        var entry = waiting[index];
        if (grantable(entry)) {
          waiting.splice(index, 1);
          index -= 1;
          grant(entry);
        }
      }
    };

    var grant = function (entry) {
      held.push(entry);
      var lock = instance("Lock", { name: entry.name, mode: entry.mode });
      env.later(function () {
        var outcome;
        try {
          outcome = Promise.resolve(entry.callback(lock));
        } catch (error) {
          outcome = Promise.reject(error);
        }
        outcome.then(function (value) {
          held.splice(held.indexOf(entry), 1);
          entry.resolve(value);
          pump();
        }, function (error) {
          held.splice(held.indexOf(entry), 1);
          entry.reject(error);
          pump();
        });
      }, 0);
    };

    patch(manager, "request", promising(function request(name, options, callback) {
      required(arguments, 2, "request", "LockManager");
      if (callback === undefined) {
        callback = options;
        options = {};
      }
      if (typeof callback !== "function") throw typeError("Failed to execute 'request' on 'LockManager': parameter 3 is not of type 'Function'.");
      options = options || {};
      var text = String(name);
      if (text.charAt(0) === "-") throw domError("Failed to execute 'request' on 'LockManager': Names cannot start with '-'.", "NotSupportedError");
      var mode = enumOf(options.mode === undefined ? "exclusive" : options.mode, ["shared", "exclusive"], "Failed to execute 'request' on 'LockManager': Failed to read the 'mode' property from 'LockOptions': ", "LockMode");

      return new Promise(function (resolve, reject) {
        var entry = { name: text, mode: mode, callback: callback, resolve: resolve, reject: reject, clientId: clientId };
        waiting.push(entry);

        if (options.ifAvailable && !grantable(entry)) {
          waiting.splice(waiting.indexOf(entry), 1);
          env.later(function () {
            Promise.resolve().then(function () { return callback(null); }).then(resolve, reject);
          }, 0);
          return;
        }

        if (options.signal && env.signalState && env.signalState.has(options.signal)) {
          var state = env.signalState.get(options.signal);
          if (state.aborted) {
            waiting.splice(waiting.indexOf(entry), 1);
            reject(state.reason);
            return;
          }
          state.algorithms.push(function () {
            var at = waiting.indexOf(entry);
            if (at !== -1) {
              waiting.splice(at, 1);
              reject(state.reason);
            }
          });
        }

        pump();
      });
    }));

    patch(manager, "query", function query() {
      var describe = function (entry) { return { clientId: entry.clientId, mode: entry.mode, name: entry.name }; };
      var snapshot = { held: held.map(describe), pending: waiting.map(describe) };
      return answer(function () { return snapshot; });
    });
  })();

  // ---- Devices, XR, gamepads, installed apps, payments ----------------------------------------------

  (function installDevices() {
    ["HID:getDevices", "USB:getDevices", "Serial:getPorts"].forEach(function (pair) {
      var parts = pair.split(":");
      var proto = globalThis[parts[0]] && globalThis[parts[0]].prototype;
      if (!proto || typeof proto[parts[1]] !== "function") return;
      patch(proto, parts[1], function () { return answer(function () { return []; }); });
      var request = parts[0] === "Serial" ? "requestPort" : "requestDevice";
      if (typeof proto[request] === "function") {
        patch(proto, request, function () {
          return Promise.reject(domError("Failed to execute '" + request + "' on '" + parts[0] + "': Must be handling a user gesture to show a permission request.", "SecurityError"));
        });
      }
    });

    var xr = globalThis.XRSystem && globalThis.XRSystem.prototype;
    if (xr) {
      patch(xr, "isSessionSupported", promising(function isSessionSupported(mode) {
        required(arguments, 1, "isSessionSupported", "XRSystem");
        var kind = enumOf(mode, ["inline", "immersive-vr", "immersive-ar"], "Failed to execute 'isSessionSupported' on 'XRSystem': ", "XRSessionMode");
        return answer(function () { return kind === "inline" ? facts.xrInline !== false : Boolean(facts.xr); });
      }));
    }

    if (navigatorProto && typeof globalThis.navigator.getGamepads === "function" && facts.gamepads) {
      patch(navigatorProto, "getGamepads", function getGamepads() {
        var pads = [];
        for (var index = 0; index < facts.gamepads.length; index += 1) pads.push(null);
        return pads;
      });
    }

    if (navigatorProto && typeof globalThis.navigator.getInstalledRelatedApps === "function") {
      patch(navigatorProto, "getInstalledRelatedApps", function getInstalledRelatedApps() {
        return answer(function () { return []; });
      });
    }

    var payment = globalThis.PaymentRequest && globalThis.PaymentRequest.prototype;
    if (payment && facts.paymentRequest !== undefined) {
      patch(payment, "canMakePayment", function canMakePayment() {
        return answer(function () { return facts.paymentRequest === true; });
      });
      if (typeof payment.hasEnrolledInstrument === "function") {
        patch(payment, "hasEnrolledInstrument", function hasEnrolledInstrument() {
          return answer(function () { return false; });
        });
      }
    }
  })();

  // ---- MediaRecorder, notifications, AI models ------------------------------------------------------

  (function installMediaRecorder() {
    var Recorder = globalThis.MediaRecorder;
    var table = facts.mediaRecorder;
    if (!Recorder || !table) return;

    var normalise = function (type) { return String(type).toLowerCase().replace(/\s+/g, ""); };
    var known = {};
    Object.keys(table).forEach(function (type) { known[normalise(type)] = table[type]; });

    // Codecs a container records with, as the capture answered for each alone.
    var codecsFor = function (container) {
      var allowed = {};
      Object.keys(known).forEach(function (type) {
        var parts = type.split(";codecs=");
        if (parts[0] === container && parts.length === 2 && known[type] === true) {
          parts[1].replace(/"/g, "").split(",").forEach(function (codec) { allowed[codec] = true; });
        }
      });
      return allowed;
    };

    patch(Recorder, "isTypeSupported", function isTypeSupported(type) {
      required(arguments, 1, "isTypeSupported", "MediaRecorder");
      var text = normalise(type);
      if (hasOwn(known, text)) return known[text];
      var parts = text.split(";codecs=");
      if (!hasOwn(known, parts[0]) || !known[parts[0]]) return false;
      if (parts.length === 1) return true;
      var allowed = codecsFor(parts[0]);
      return parts[1].replace(/"/g, "").split(",").every(function (codec) {
        return allowed[codec] || Object.keys(allowed).some(function (known) { return codec.indexOf(known + ".") === 0; });
      });
    });
  })();

  (function installNotification() {
    var Notification = globalThis.Notification;
    if (!Notification || !facts.notification) return;
    patchGetter(Notification, "permission", function () { return facts.notification[0]; });
    patchGetter(Notification, "maxActions", function () { return facts.notification[1]; });
    // Chrome shows its permission prompt and waits for the user, who never answers here: the
    // promise (and the callback) stay pending, as in a headed Chrome nobody is clicking. (Headless
    // Chrome answers "denied" at once, a known tell.)
    patch(Notification, "requestPermission", function requestPermission() {
      return new Promise(function () {});
    });
  })();

  (function installAi() {
    // Chrome 156's answers on Linux without a downloaded model, where the capture recorded none.
    var models = facts.ai || { LanguageDetector: "available", Translator: "downloadable", Summarizer: "downloadable", LanguageModel: "downloadable" };

    Object.keys(models).forEach(function (key) {
      var name = key.split(":")[0];
      var Api = globalThis[name];
      if (key !== name || !Api || typeof Api.availability !== "function" || models[name] === "absent") return;

      patch(Api, "availability", promising(function availability(options) {
        var pair = options && options.sourceLanguage && options.targetLanguage ? name + ":" + options.sourceLanguage + "-" + options.targetLanguage : null;
        var said = pair && hasOwn(models, pair) ? models[pair] : models[name];
        return answer(function () {
          if (said && typeof said === "object") throw domError(said.rejected ? said.rejected[1] : "", said.rejected ? said.rejected[0] : "NotSupportedError");
          return said;
        });
      }));

      if (typeof Api.create === "function") {
        patch(Api, "create", function create() {
          return Promise.reject(domError("Requires a user gesture when availability is \"downloading\" or \"downloadable\".", "NotAllowedError"));
        });
      }
    });
  })();

  // ---- Permissions ------------------------------------------------------------------------------

  (function installPermissions() {
    var permissions = globalThis.Permissions && globalThis.Permissions.prototype;
    if (!permissions) return;

    // Chrome's answers on a fresh origin, where the capture recorded none.
    var states = { accelerometer: "granted", "background-sync": "granted", "clipboard-write": "granted", gyroscope: "granted", magnetometer: "granted",
      "payment-handler": "granted", "screen-wake-lock": "granted", "storage-access": "granted", "keyboard-lock": "granted", "pointer-lock": "granted" };
    (facts.permissionsSample || []).forEach(function (pair) { states[pair[0]] = pair[1]; });

    var NAMES = ["accelerometer", "ambient-light-sensor", "background-fetch", "background-sync", "bluetooth", "camera", "captured-surface-control", "clipboard-read", "clipboard-write",
      "display-capture", "fullscreen", "geolocation", "gyroscope", "idle-detection", "keyboard-lock", "local-fonts", "local-network-access", "magnetometer", "microphone", "midi", "nfc",
      "notifications", "payment-handler", "periodic-background-sync", "persistent-storage", "pointer-lock", "push", "screen-wake-lock", "speaker-selection", "storage-access",
      "system-wake-lock", "top-level-storage-access", "web-app-installation", "window-management", "window-placement", "loopback-network", "local-network"];

    patch(permissions, "query", promising(function query(descriptor) {
      required(arguments, 1, "query", "Permissions");
      var where = "Failed to execute 'query' on 'Permissions': ";
      if (descriptor === null || typeof descriptor !== "object") throw typeError(where + "The provided value is not of type 'PermissionDescriptor'.");
      var raw = descriptor.name;
      if (raw === undefined) throw typeError(where + "Failed to read the 'name' property from 'PermissionDescriptor': Required member is undefined.");
      var name = enumOf(raw, NAMES, where + "Failed to read the 'name' property from 'PermissionDescriptor': ", "PermissionName");
      var state = states[name];

      if (name === "push" && descriptor.userVisibleOnly) state = "prompt";
      if (name === "midi" && descriptor.sysex) state = "prompt";

      if (state === undefined) state = name === "window-placement" ? states["window-management"] : "prompt";

      if (/^rejected /.test(state)) {
        var match = /^rejected (\w+): (.*)$/.exec(state);
        if (match[1] === "TypeError") throw typeError(match[2]);
        throw domError(match[2], match[1]);
      }

      return answer(function () { return instance("PermissionStatus", { name: name, state: state, onchange: null }); });
    }));
  })();

  // ---- Canvas blobs, ImageBitmap ------------------------------------------------------------------

  var dataUrlBytes = function (url) {
    var match = /^data:([^;,]*)(;base64)?,(.*)$/.exec(String(url));
    if (!match) return null;
    var text = match[2] ? globalThis.atob(match[3]) : decodeURIComponent(match[3]);
    var bytes = new Uint8Array(text.length);
    for (var index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 255;
    return { type: match[1], bytes: bytes };
  };

  // An untouched canvas as Chrome encodes it to `type` (PNG for any type it cannot encode): the
  // capture's bytes for that size, else a PNG built on the host and, for JPEG and WebP, the
  // recorded default-size image (300x150, the canvas a page gets) with this size in its header.
  var ENCODABLE = { "image/png": true, "image/jpeg": true, "image/webp": true };
  var blanks = facts.blankCanvas || {};

  var withSize = function (url, type, width, height) {
    var encoded = dataUrlBytes(url);
    var bytes = encoded.bytes.slice(0);
    if (type === "image/jpeg") {
      for (var at = 2; at + 9 < bytes.length; ) {
        var marker = bytes[at + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          bytes[at + 5] = height >> 8;
          bytes[at + 6] = height & 255;
          bytes[at + 7] = width >> 8;
          bytes[at + 8] = width & 255;
          break;
        }
        at += 2 + (bytes[at + 2] << 8 | bytes[at + 3]);
      }
    } else if (bytes.length > 30) {
      var w = width - 1;
      var h = height - 1;
      bytes[24] = w & 255; bytes[25] = (w >> 8) & 255; bytes[26] = (w >> 16) & 255;
      bytes[27] = h & 255; bytes[28] = (h >> 8) & 255; bytes[29] = (h >> 16) & 255;
    }
    var text = "";
    for (var index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
    return "data:" + type + ";base64," + globalThis.btoa(text);
  };

  env.blankCanvas = function (width, height, type) {
    var asked = type === undefined ? "image/png" : String(type).toLowerCase();
    var kind = ENCODABLE[asked] ? asked : "image/png";
    var key = width + "x" + height + " " + kind;
    if (hasOwn(blanks, key)) return blanks[key];
    if (kind !== "image/png" && hasOwn(blanks, "300x150 " + kind)) return withSize(blanks["300x150 " + kind], kind, width, height);
    return "data:image/png;base64," + bridge.blankPng(width, height);
  };

  (function installCanvasBlobs() {
    var canvas = globalThis.HTMLCanvasElement && globalThis.HTMLCanvasElement.prototype;
    if (!canvas) return;

    // toBlob encodes what toDataURL would, delivered as a later task (null for an empty canvas).
    patch(canvas, "toBlob", function toBlob(callback, type, quality) {
      required(arguments, 1, "toBlob", "HTMLCanvasElement");
      if (typeof callback !== "function") throw typeError("Failed to execute 'toBlob' on 'HTMLCanvasElement': parameter 1 is not of type 'BlobCallback'.");
      var element = this;
      var empty = !(Number(element.width) > 0 && Number(element.height) > 0);
      var encoded = empty ? null : dataUrlBytes(element.toDataURL(type === undefined ? "image/png" : type, quality));
      env.later(function () {
        callback(encoded && encoded.bytes.length ? env.makeBlob(encoded.bytes, encoded.type) : null);
      }, 0);
    });

    var offscreen = globalThis.OffscreenCanvas && globalThis.OffscreenCanvas.prototype;
    if (offscreen) {
      patch(offscreen, "convertToBlob", function convertToBlob() {
        return Promise.reject(domError("Failed to execute 'convertToBlob' on 'OffscreenCanvas': The OffscreenCanvas has no rendering context.", "InvalidStateError"));
      });
    }
  })();

  // The pixel size an encoded image declares (PNG, GIF, JPEG, WebP, BMP), or null.
  var encodedSize = function (bytes) {
    var at = function (index) { return bytes[index] || 0; };
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
      return [(at(16) << 24 | at(17) << 16 | at(18) << 8 | at(19)) >>> 0, (at(20) << 24 | at(21) << 16 | at(22) << 8 | at(23)) >>> 0];
    }
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return [at(6) | at(7) << 8, at(8) | at(9) << 8];
    if (at(0) === 0x42 && at(1) === 0x4d) return [(at(18) | at(19) << 8 | at(20) << 16 | at(21) << 24) >>> 0, Math.abs(at(22) | at(23) << 8 | at(24) << 16 | at(25) << 24)];
    if (at(0) === 0x52 && at(1) === 0x49 && at(8) === 0x57 && at(9) === 0x45) {
      if (at(12) === 0x56 && at(13) === 0x50 && at(14) === 0x38 && at(15) === 0x20) return [(at(26) | at(27) << 8) & 0x3fff, (at(28) | at(29) << 8) & 0x3fff];
      if (at(15) === 0x4c) return [1 + ((at(22) << 8 | at(21)) & 0x3fff), 1 + (((at(24) << 16 | at(23) << 8 | at(22)) >> 6) & 0x3fff)];
      if (at(15) === 0x58) return [1 + (at(24) | at(25) << 8 | at(26) << 16), 1 + (at(27) | at(28) << 8 | at(29) << 16)];
    }
    if (at(0) === 0xff && at(1) === 0xd8) {
      var index = 2;
      while (index + 9 < bytes.length) {
        if (at(index) !== 0xff) return null;
        var marker = at(index + 1);
        var length = at(index + 2) << 8 | at(index + 3);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return [at(index + 7) << 8 | at(index + 8), at(index + 5) << 8 | at(index + 6)];
        }
        index += 2 + length;
      }
    }
    return null;
  };

  env.encodedSize = encodedSize;

  // ImageData as Chrome makes it: its pixels an own, read-only `data` property (V8 keeps it on the
  // object), its width, height, colour space and format read through the prototype.
  var makeImageData = function (data, width, height, colorSpace) {
    var made = instance("ImageData", { width: width, height: height, data: data, colorSpace: colorSpace || "srgb", pixelFormat: "rgba-unorm8" });
    Object.defineProperty(made, "data", { value: data, writable: false, enumerable: true, configurable: true });
    return made;
  };

  env.makeImageData = makeImageData;

  (function installImageData() {
    if (!globalThis.ImageData) return;
    var where = "Failed to construct 'ImageData': ";
    var dimension = function (value, which) {
      var number = Math.trunc(Number(value));
      if (!number || !isFinite(number) || number < 0) throw domError(where + "The source " + which + " is zero or not a number.", "IndexSizeError");
      return number;
    };
    var spaceOf = function (settings) {
      if (settings === undefined || settings === null) return "srgb";
      return settings.colorSpace === undefined ? "srgb" : enumOf(settings.colorSpace, ["srgb", "display-p3"], where + "Failed to read the 'colorSpace' property from 'ImageDataSettings': ", "PredefinedColorSpace");
    };
    env.installShell("ImageData", function (args) {
      if (args[0] instanceof Uint8ClampedArray) {
        var data = args[0];
        if (!data.length || data.length % 4) throw domError(where + "The input data length is not a multiple of 4.", "InvalidStateError");
        var width = dimension(args[1], "width");
        if ((data.length / 4) % width) throw domError(where + "The input data length is not a multiple of (4 * width).", "IndexSizeError");
        var height = data.length / 4 / width;
        if (args[2] !== undefined && Number(args[2]) !== height) throw domError(where + "The input data length is not equal to (4 * width * height).", "IndexSizeError");
        return makeImageData(data, width, height, spaceOf(args[3]));
      }
      if (args.length < 2) throw typeError(where + "2 arguments required, but only " + args.length + " present.");
      var w = dimension(args[0], "width");
      var h = dimension(args[1], "height");
      return makeImageData(new Uint8ClampedArray(w * h * 4), w, h, spaceOf(args[2]));
    }, 2, { required: 1 });
  })();

  (function installImageBitmap() {
    if (typeof globalThis.createImageBitmap !== "function" || !globalThis.ImageBitmap) return;
    var bitmapProto = globalThis.ImageBitmap.prototype;
    var SOURCES = ["Blob", "HTMLCanvasElement", "HTMLImageElement", "HTMLVideoElement", "ImageBitmap", "ImageData", "OffscreenCanvas", "SVGImageElement", "VideoFrame"];
    var where = "Failed to execute 'createImageBitmap' on 'Window': ";

    var sizeOf = function (source) {
      var is = function (name) { return globalThis[name] && source instanceof globalThis[name]; };
      if (is("Blob")) {
        var size = encodedSize(env.blobBytes(source) || new Uint8Array(0));
        if (!size) throw domError("The source image could not be decoded.", "InvalidStateError");
        return size;
      }
      if (is("HTMLImageElement") || is("SVGImageElement")) {
        if (!source.naturalWidth) throw domError(where + "The image element contains no image data.", "InvalidStateError");
        return [source.naturalWidth, source.naturalHeight];
      }
      if (is("HTMLVideoElement")) {
        if (!source.videoWidth) throw domError(where + "The provided element has not retrieved data.", "InvalidStateError");
        return [source.videoWidth, source.videoHeight];
      }
      if (is("ImageBitmap") && !source.width) throw domError(where + "The image source is detached", "InvalidStateError");
      return [Number(source.width) || 0, Number(source.height) || 0];
    };

    patch(globalThis, "createImageBitmap", promising(function createImageBitmap(source, sx, sy, sw, sh) {
      required(arguments, 1, "createImageBitmap", "Window");
      var known = source !== null && typeof source === "object" && SOURCES.some(function (name) { return globalThis[name] && source instanceof globalThis[name]; });
      if (!known) throw typeError(where + "The provided value is not of type '(" + SOURCES.join(" or ") + ")'.");
      if (arguments.length >= 5) {
        if (!Number(sw)) throw domError(where + "The crop rect width is 0.", "IndexSizeError");
        if (!Number(sh)) throw domError(where + "The crop rect height is 0.", "IndexSizeError");
      }
      var size = arguments.length >= 5 ? [Math.abs(Math.trunc(sw)), Math.abs(Math.trunc(sh))] : sizeOf(source);
      if (!size[0] || !size[1]) throw domError(where + "The source image width is 0.", "InvalidStateError");
      return answer(function () { return instance("ImageBitmap", { width: size[0], height: size[1] }); });
    }));

    patch(bitmapProto, "close", function close() {
      var fields = fieldsOf(this);
      if (!fields) throw typeError("Illegal invocation");
      fields.width = 0;
      fields.height = 0;
    });
  })();

  // ---- SubtleCrypto -----------------------------------------------------------------------------

  (function installSubtle() {
    var subtle = globalThis.SubtleCrypto && globalThis.SubtleCrypto.prototype;
    if (!subtle || typeof bridge.subtle !== "function") return;

    var keys = new WeakMap();
    var HASHES = { "SHA-1": 512, "SHA-256": 512, "SHA-384": 1024, "SHA-512": 1024 };
    var NAMES = ["AES-GCM", "AES-CBC", "AES-CTR", "AES-KW", "HMAC", "PBKDF2", "HKDF", "SHA-1", "SHA-256", "SHA-384", "SHA-512",
      "ECDSA", "ECDH", "RSA-OAEP", "RSA-PSS", "RSASSA-PKCS1-v1_5", "Ed25519", "X25519"];
    var SUPPORTED = {
      generateKey: ["AES-GCM", "AES-CBC", "AES-CTR", "HMAC", "ECDSA", "ECDH"],
      importKey: ["AES-GCM", "AES-CBC", "AES-CTR", "HMAC", "PBKDF2", "HKDF", "ECDSA", "ECDH"],
      encrypt: ["AES-GCM", "AES-CBC", "AES-CTR"],
      decrypt: ["AES-GCM", "AES-CBC", "AES-CTR"],
      sign: ["HMAC", "ECDSA"],
      verify: ["HMAC", "ECDSA"],
      deriveBits: ["PBKDF2", "HKDF", "ECDH"],
      digest: ["SHA-1", "SHA-256", "SHA-384", "SHA-512"],
    };
    var USAGES = {
      "AES-GCM": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
      "AES-CBC": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
      "AES-CTR": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
      HMAC: ["sign", "verify"],
      PBKDF2: ["deriveBits", "deriveKey"],
      HKDF: ["deriveBits", "deriveKey"],
      ECDSA: ["sign", "verify"],
      ECDH: ["deriveBits", "deriveKey"],
    };
    var CURVES = { "P-256": 32, "P-384": 48 };

    var bufferOf = function (value, method, position) {
      if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      throw typeError("Failed to execute '" + method + "' on 'SubtleCrypto': parameter " + position + " is not of type '(ArrayBuffer or ArrayBufferView)'.");
    };

    var memberBuffer = function (value, method, member) {
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return bufferOf(value, method, 1);
      throw typeError("Failed to execute '" + method + "' on 'SubtleCrypto': " + member + ": Not a BufferSource");
    };

    var canonical = function (name) {
      var upper = String(name).toUpperCase();
      for (var index = 0; index < NAMES.length; index += 1) if (NAMES[index].toUpperCase() === upper) return NAMES[index];
      return null;
    };

    // An algorithm as Web Crypto normalises it for `op`: its canonical name and its parameters.
    var normalise = function (algorithm, op) {
      var where = "Failed to execute '" + op + "' on 'SubtleCrypto': ";
      var spec = typeof algorithm === "string" ? { name: algorithm } : algorithm;
      if (spec === null || typeof spec !== "object") throw typeError(where + "Algorithm: Not an object");
      if (typeof spec.name !== "string") throw typeError(where + "Algorithm: name: Missing or not a string");
      var name = canonical(spec.name);
      if (!name) throw domError(where + "Algorithm: Unrecognized name", "NotSupportedError");
      var allowed = SUPPORTED[op === "deriveKey" ? "deriveBits" : op === "wrapKey" ? "encrypt" : op === "unwrapKey" ? "decrypt" : op] || [];
      if (allowed.indexOf(name) === -1) throw domError(where + "Algorithm: Unrecognized name", "NotSupportedError");
      var out = { name: name };
      for (var key in spec) if (key !== "name") out[key] = spec[key];
      if (out.hash !== undefined) out.hash = normaliseHash(out.hash, op);
      return out;
    };

    var normaliseHash = function (hash, op) {
      var where = "Failed to execute '" + op + "' on 'SubtleCrypto': ";
      var spec = typeof hash === "string" ? { name: hash } : hash;
      if (spec === null || typeof spec !== "object" || typeof spec.name !== "string") throw typeError(where + "Algorithm: hash: Missing or not an AlgorithmIdentifier");
      var name = canonical(spec.name);
      if (!name || !HASHES[name]) throw domError(where + "Algorithm: hash: Unrecognized name", "NotSupportedError");
      return { name: name };
    };

    var makeKey = function (bytes, algorithm, extractable, usages, type) {
      var shown = { name: algorithm.name };
      if (algorithm.name.indexOf("AES-") === 0) shown.length = bytes.length * 8;
      if (algorithm.name === "HMAC") {
        shown.hash = { name: algorithm.hash.name };
        shown.length = bytes.length * 8;
      }
      var key = instance("CryptoKey", { type: type || "secret", extractable: Boolean(extractable), algorithm: shown, usages: usages.slice() });
      keys.set(key, { bytes: bytes, algorithm: shown });
      return key;
    };

    var checkUsages = function (name, usages, op) {
      var list = sequenceOf(usages, "Failed to execute '" + op + "' on 'SubtleCrypto': ").map(String);
      var allowed = USAGES[name] || [];
      var sorted = [];
      ["encrypt", "decrypt", "sign", "verify", "deriveKey", "deriveBits", "wrapKey", "unwrapKey"].forEach(function (usage) {
        if (list.indexOf(usage) !== -1) sorted.push(usage);
      });
      list.forEach(function (usage) {
        if (["encrypt", "decrypt", "sign", "verify", "deriveKey", "deriveBits", "wrapKey", "unwrapKey"].indexOf(usage) === -1) {
          throw typeError("Failed to execute '" + op + "' on 'SubtleCrypto': The provided value '" + usage + "' is not a valid enum value of type KeyUsage.");
        }
        if (allowed.indexOf(usage) === -1) throw domError("Cannot create a key using the specified key usages.", "SyntaxError");
      });
      return sorted;
    };

    var heldKey = function (key, op, algorithm, usage) {
      var held = key !== null && typeof key === "object" ? keys.get(key) : null;
      if (!held) throw typeError("Failed to execute '" + op + "' on 'SubtleCrypto': parameter 2 is not of type 'CryptoKey'.");
      if (held.algorithm.name !== algorithm.name) throw domError("key.algorithm does not match that of operation", "InvalidAccessError");
      if (fieldsOf(key).usages.indexOf(usage) === -1) throw domError("key.usages does not permit this operation", "InvalidAccessError");
      return held;
    };

    var run = function (op, fields) {
      var out = bridge.subtle(op, fields);
      if (out && out.failed !== undefined) throw domError(out.failed, "OperationError");
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    };

    var base64url = function (bytes) {
      var text = "";
      for (var index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
      return globalThis.btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };

    var fromBase64url = function (text) {
      var plain = globalThis.atob(String(text).replace(/-/g, "+").replace(/_/g, "/"));
      var bytes = new Uint8Array(plain.length);
      for (var index = 0; index < plain.length; index += 1) bytes[index] = plain.charCodeAt(index);
      return bytes;
    };

    var jwkAlg = function (algorithm, bits) {
      if (algorithm.name === "HMAC") return "HS" + algorithm.hash.name.slice(4);
      return "A" + bits + algorithm.name.slice(4);
    };

    var aesLength = function (bits, error) {
      if (bits === 192) throw domError("192-bit AES keys are not supported", "OperationError");
      if (bits !== 128 && bits !== 256) throw domError(error, "OperationError");
    };

    var importRaw = function (format, data, algorithm, extractable, usages, op) {
      var name = algorithm.name;
      var bytes;

      if (format === "raw") {
        bytes = bufferOf(data, op, 2);
      } else if (format === "jwk") {
        if (data === null || typeof data !== "object") throw typeError("Failed to execute '" + op + "' on 'SubtleCrypto': Key data must be an object for JWK import");
        if (data.kty !== "oct") throw domError("The JWK \"kty\" member was not \"oct\"", "DataError");
        bytes = fromBase64url(data.k);
      } else {
        throw domError("Failed to execute '" + op + "' on 'SubtleCrypto': Unsupported import key format for algorithm", "NotSupportedError");
      }

      if (name.indexOf("AES-") === 0 && [16, 32].indexOf(bytes.length) === -1) {
        throw domError(bytes.length === 24 ? "192-bit AES keys are not supported" : "AES key data must be 128 or 256 bits", bytes.length === 24 ? "OperationError" : "DataError");
      }
      if ((name === "PBKDF2" || name === "HKDF") && extractable) throw domError("Failed to execute '" + op + "' on 'SubtleCrypto': " + name + " keys must not be extractable", "SyntaxError");
      if (name === "HMAC" && !algorithm.hash) throw typeError("Failed to execute '" + op + "' on 'SubtleCrypto': HmacImportParams: hash: Missing or not an AlgorithmIdentifier");
      if (name === "HMAC" && !bytes.length) throw domError("HMAC key data must not be empty", "DataError");

      var granted = checkUsages(name, usages, op);
      if (!granted.length && name !== "PBKDF2" && name !== "HKDF") throw domError("Usages cannot be empty when creating a key.", "SyntaxError");
      return makeKey(bytes, algorithm, extractable, granted);
    };

    var curveOf = function (spec, op, dictionary) {
      if (typeof spec.namedCurve !== "string") throw typeError("Failed to execute '" + op + "' on 'SubtleCrypto': " + dictionary + ": namedCurve: Missing or not a string");
      if (!CURVES[spec.namedCurve]) throw domError("Failed to execute '" + op + "' on 'SubtleCrypto': Unrecognized namedCurve", "NotSupportedError");
      return spec.namedCurve;
    };

    var makeEcKey = function (type, d, q, algorithm, extractable, usages) {
      var shown = { name: algorithm.name, namedCurve: algorithm.namedCurve };
      var key = instance("CryptoKey", { type: type, extractable: Boolean(extractable), algorithm: shown, usages: usages.slice() });
      keys.set(key, { type: type, d: d, q: q, algorithm: shown });
      return key;
    };

    var ecUsages = function (name, granted, type) {
      if (name === "ECDH") return type === "public" ? [] : granted;
      return granted.filter(function (usage) { return usage === (type === "public" ? "verify" : "sign"); });
    };

    var bytesOf = function (buffer) { return new Uint8Array(buffer); };

    var ecImport = function (format, data, spec, extractable, usages, op) {
      var curve = curveOf(spec, op, "EcKeyImportParams");
      var granted = checkUsages(spec.name, usages, op);
      var private_;
      var d = null;
      var q;
      if (format === "raw" || format === "raw-public") {
        q = bytesOf(run("ec-check-public", { curve: curve, q: bufferOf(data, op, 2) }));
        private_ = false;
      } else if (format === "spki") {
        q = bytesOf(run("ec-from-spki", { curve: curve, der: bufferOf(data, op, 2) }));
        private_ = false;
      } else if (format === "pkcs8") {
        d = bytesOf(run("ec-from-pkcs8", { curve: curve, der: bufferOf(data, op, 2) }));
        q = bytesOf(run("ec-public", { curve: curve, d: d }));
        private_ = true;
      } else if (format === "jwk") {
        if (data === null || typeof data !== "object") throw typeError("Failed to execute '" + op + "' on 'SubtleCrypto': Key data must be an object for JWK import");
        if (data.kty !== "EC") throw domError("The JWK \"kty\" member was not \"EC\"", "DataError");
        if (data.crv !== curve) throw domError("The JWK's \"crv\" member specifies a different curve than requested", "DataError");
        q = bytesOf(run("ec-check-public", { curve: curve, q: env.joinBytes([new Uint8Array([4]), fromBase64url(data.x), fromBase64url(data.y)]) }));
        if (data.d !== undefined) {
          d = fromBase64url(data.d);
          private_ = true;
        } else {
          private_ = false;
        }
      } else {
        throw domError("Failed to execute '" + op + "' on 'SubtleCrypto': Unsupported import key format for algorithm", "NotSupportedError");
      }
      var type = private_ ? "private" : "public";
      var allowed = spec.name === "ECDH" ? (private_ ? ["deriveKey", "deriveBits"] : []) : [private_ ? "sign" : "verify"];
      granted.forEach(function (usage) {
        if (allowed.indexOf(usage) === -1) throw domError("Cannot create a key using the specified key usages.", "SyntaxError");
      });
      if (private_ && !granted.length) throw domError("Usages cannot be empty when creating a key.", "SyntaxError");
      return makeEcKey(type, d, q, { name: spec.name, namedCurve: curve }, extractable, granted);
    };

    patch(subtle, "generateKey", promising(function generateKey(algorithm, extractable, usages) {
      required(arguments, 3, "generateKey", "SubtleCrypto");
      var spec = normalise(algorithm, "generateKey");
      if (spec.name === "ECDSA" || spec.name === "ECDH") {
        var curve = curveOf(spec, "generateKey", "EcKeyGenParams");
        var asked = checkUsages(spec.name, usages, "generateKey");
        if (!ecUsages(spec.name, asked, "private").length) throw domError("Usages cannot be empty when creating a key.", "SyntaxError");
        return answer(function () {
          var d = bytesOf(run("ec-generate", { curve: curve }));
          var q = bytesOf(run("ec-public", { curve: curve, d: d }));
          var shown = { name: spec.name, namedCurve: curve };
          return { privateKey: makeEcKey("private", d, q, shown, extractable, ecUsages(spec.name, asked, "private")), publicKey: makeEcKey("public", null, q, shown, true, ecUsages(spec.name, asked, "public")) };
        });
      }
      var granted = checkUsages(spec.name, usages, "generateKey");
      if (!granted.length) throw domError("Usages cannot be empty when creating a key.", "SyntaxError");
      var bits;
      if (spec.name === "HMAC") {
        if (!spec.hash) throw typeError("Failed to execute 'generateKey' on 'SubtleCrypto': HmacKeyGenParams: hash: Missing or not an AlgorithmIdentifier");
        bits = spec.length === undefined ? HASHES[spec.hash.name] : Number(spec.length);
      } else {
        if (spec.length === undefined) throw typeError("Failed to execute 'generateKey' on 'SubtleCrypto': AesKeyGenParams: length: Missing required property");
        bits = Number(spec.length);
        aesLength(bits, "AES key length must be 128 or 256 bits");
      }
      return answer(function () { return makeKey(randomBytes(Math.ceil(bits / 8)), spec, extractable, granted); });
    }));

    patch(subtle, "importKey", promising(function importKey(format, data, algorithm, extractable, usages) {
      required(arguments, 5, "importKey", "SubtleCrypto");
      var kind = enumOf(format, ["raw", "pkcs8", "spki", "jwk", "raw-public", "raw-private", "raw-seed", "raw-secret"], "Failed to execute 'importKey' on 'SubtleCrypto': ", "KeyFormat");
      var spec = normalise(algorithm, "importKey");
      var key = spec.name === "ECDSA" || spec.name === "ECDH" ? ecImport(kind, data, spec, extractable, usages, "importKey") : importRaw(kind === "raw-secret" ? "raw" : kind, data, spec, extractable, usages, "importKey");
      return answer(function () { return key; });
    }));

    var exportOf = function (format, key, op) {
      var held = key !== null && typeof key === "object" ? keys.get(key) : null;
      if (!held) throw typeError("Failed to execute '" + op + "' on 'SubtleCrypto': parameter 2 is not of type 'CryptoKey'.");
      if (!fieldsOf(key).extractable) throw domError("key is not extractable", "InvalidAccessError");
      if (held.q) {
        var curve = held.algorithm.namedCurve;
        var size = CURVES[curve];
        if ((format === "raw" || format === "raw-public" || format === "spki") && held.type !== "public") throw domError("Failed to execute '" + op + "' on 'SubtleCrypto': key is not a public key", "InvalidAccessError");
        if (format === "pkcs8" && held.type !== "private") throw domError("Failed to execute '" + op + "' on 'SubtleCrypto': key is not a private key", "InvalidAccessError");
        if (format === "raw" || format === "raw-public") return held.q.slice(0).buffer;
        if (format === "spki") return run("ec-spki", { curve: curve, q: held.q });
        if (format === "pkcs8") return run("ec-pkcs8", { curve: curve, d: held.d });
        if (format === "jwk") {
          var jwk = { crv: curve };
          if (held.d) jwk.d = base64url(held.d);
          jwk.ext = true;
          jwk.key_ops = fieldsOf(key).usages.slice();
          jwk.kty = "EC";
          jwk.x = base64url(held.q.subarray(1, 1 + size));
          jwk.y = base64url(held.q.subarray(1 + size));
          return jwk;
        }
      }
      if (format === "raw") return held.bytes.slice(0).buffer;
      if (format === "jwk") {
        return { alg: jwkAlg(held.algorithm, held.bytes.length * 8), ext: true, k: base64url(held.bytes), key_ops: fieldsOf(key).usages.slice(), kty: "oct" };
      }
      throw domError("Failed to execute '" + op + "' on 'SubtleCrypto': Unsupported export key format for algorithm", "NotSupportedError");
    };

    patch(subtle, "exportKey", promising(function exportKey(format, key) {
      required(arguments, 2, "exportKey", "SubtleCrypto");
      var kind = enumOf(format, ["raw", "pkcs8", "spki", "jwk", "raw-public", "raw-private", "raw-seed", "raw-secret"], "Failed to execute 'exportKey' on 'SubtleCrypto': ", "KeyFormat");
      var out = exportOf(kind === "raw-secret" ? "raw" : kind, key, "exportKey");
      return answer(function () { return out; });
    }));

    var cipher = function (op, spec, held, data) {
      var where = "Failed to execute '" + op + "' on 'SubtleCrypto': ";
      if (spec.name === "AES-GCM") {
        if (spec.iv === undefined) throw typeError(where + "AesGcmParams: iv: Missing required property");
        var tag = spec.tagLength === undefined ? 128 : Number(spec.tagLength);
        if ([32, 64, 96, 104, 112, 120, 128].indexOf(tag) === -1) throw domError(where + "The tag length is invalid: Must be 32, 64, 96, 104, 112, 120, or 128 bits (actual length is " + tag + ")", "OperationError");
        return { op: op === "encrypt" ? "aes-gcm-encrypt" : "aes-gcm-decrypt", key: held.bytes, iv: memberBuffer(spec.iv, op, "AesGcmParams: iv"), data: data,
          aad: spec.additionalData === undefined ? new Uint8Array(0) : memberBuffer(spec.additionalData, op, "AesGcmParams: additionalData"), tagLength: tag };
      }
      if (spec.name === "AES-CBC") {
        if (spec.iv === undefined) throw typeError(where + "AesCbcParams: iv: Missing required property");
        var iv = memberBuffer(spec.iv, op, "AesCbcParams: iv");
        if (iv.length !== 16) throw domError(where + "The \"iv\" has an unexpected length -- must be 16 bytes", "OperationError");
        return { op: op === "encrypt" ? "aes-cbc-encrypt" : "aes-cbc-decrypt", key: held.bytes, iv: iv, data: data };
      }
      if (spec.counter === undefined) throw typeError(where + "AesCtrParams: counter: Missing required property");
      if (spec.length === undefined) throw typeError(where + "AesCtrParams: length: Missing required property");
      var counter = memberBuffer(spec.counter, op, "AesCtrParams: counter");
      var length = Number(spec.length);
      if (counter.length !== 16) throw domError(where + "The counter has an unexpected length -- must be 16 bytes", "OperationError");
      if (!(length >= 1 && length <= 128)) throw domError(where + "The counter length must be between 1 and 128", "OperationError");
      return { op: "aes-ctr", key: held.bytes, counter: counter, data: data, length: length };
    };

    ["encrypt", "decrypt"].forEach(function (op) {
      patch(subtle, op, promising(function (algorithm, key, data) {
        required(arguments, 3, op, "SubtleCrypto");
        var spec = normalise(algorithm, op);
        var bytes = bufferOf(data, op, 3);
        var held = heldKey(key, op, spec, op);
        var job = cipher(op, spec, held, bytes);
        return answer(function () { return run(job.op, job); });
      }));
    });

    patch(subtle, "sign", promising(function sign(algorithm, key, data) {
      required(arguments, 3, "sign", "SubtleCrypto");
      var spec = normalise(algorithm, "sign");
      var bytes = bufferOf(data, "sign", 3);
      var held = heldKey(key, "sign", spec, "sign");
      if (spec.name === "ECDSA") {
        if (!spec.hash) throw typeError("Failed to execute 'sign' on 'SubtleCrypto': EcdsaParams: hash: Missing or not an AlgorithmIdentifier");
        return answer(function () { return run("ec-sign", { curve: held.algorithm.namedCurve, hash: spec.hash.name, d: held.d, data: bytes }); });
      }
      return answer(function () { return run("hmac", { hash: held.algorithm.hash.name, key: held.bytes, data: bytes }); });
    }));

    patch(subtle, "verify", promising(function verify(algorithm, key, signature, data) {
      required(arguments, 4, "verify", "SubtleCrypto");
      var spec = normalise(algorithm, "verify");
      var expected = bufferOf(signature, "verify", 3);
      var bytes = bufferOf(data, "verify", 4);
      var held = heldKey(key, "verify", spec, "verify");
      if (spec.name === "ECDSA") {
        if (!spec.hash) throw typeError("Failed to execute 'verify' on 'SubtleCrypto': EcdsaParams: hash: Missing or not an AlgorithmIdentifier");
        return answer(function () { return new Uint8Array(run("ec-verify", { curve: held.algorithm.namedCurve, hash: spec.hash.name, q: held.q, data: bytes, signature: expected }))[0] === 1; });
      }
      return answer(function () {
        var mac = new Uint8Array(run("hmac", { hash: held.algorithm.hash.name, key: held.bytes, data: bytes }));
        if (mac.length !== expected.length) return false;
        var difference = 0;
        for (var index = 0; index < mac.length; index += 1) difference |= mac[index] ^ expected[index];
        return difference === 0;
      });
    }));

    var derive = function (op, spec, held, bits) {
      var where = "Failed to execute '" + op + "' on 'SubtleCrypto': ";
      if (spec.name === "ECDH") {
        var peer = spec.public !== null && typeof spec.public === "object" ? keys.get(spec.public) : null;
        if (!peer) throw typeError(where + "EcdhKeyDeriveParams: public: Must be a CryptoKey");
        if (peer.type !== "public") throw domError(where + "The public parameter for ECDH key derivation is not a public EC key", "InvalidAccessError");
        if (peer.algorithm.name !== "ECDH" || peer.algorithm.namedCurve !== held.algorithm.namedCurve) throw domError(where + "The public parameter for ECDH key derivation must be for ECDH", "InvalidAccessError");
        var size = CURVES[held.algorithm.namedCurve] * 8;
        if (bits !== null && bits > size) throw domError(where + "Length specified for ECDH key derivation is too large. Maximum allowed is " + size + " bits", "OperationError");
        return { op: "ec-derive", curve: held.algorithm.namedCurve, d: held.d, q: peer.q, cut: bits === null ? size : bits };
      }
      if (bits === null || bits === undefined || bits % 8 !== 0) throw domError(where + "The length provided for " + spec.name + " is not a multiple of 8.", "OperationError");
      if (!spec.hash) throw typeError(where + (spec.name === "PBKDF2" ? "Pbkdf2Params" : "HkdfParams") + ": hash: Missing or not an AlgorithmIdentifier");
      if (spec.salt === undefined) throw typeError(where + (spec.name === "PBKDF2" ? "Pbkdf2Params" : "HkdfParams") + ": salt: Missing required property");
      if (spec.name === "PBKDF2") {
        if (spec.iterations === undefined) throw typeError(where + "Pbkdf2Params: iterations: Missing required property");
        if (!Number(spec.iterations)) throw domError(where + "PBKDF2 requires iterations > 0", "OperationError");
        return { op: "pbkdf2", hash: spec.hash.name, key: held.bytes, salt: memberBuffer(spec.salt, op, "Pbkdf2Params: salt"), iterations: Number(spec.iterations), bits: bits };
      }
      if (spec.info === undefined) throw typeError(where + "HkdfParams: info: Missing required property");
      return { op: "hkdf", hash: spec.hash.name, key: held.bytes, salt: memberBuffer(spec.salt, op, "HkdfParams: salt"), info: memberBuffer(spec.info, op, "HkdfParams: info"), bits: bits };
    };

    patch(subtle, "deriveBits", promising(function deriveBits(algorithm, key, length) {
      required(arguments, 2, "deriveBits", "SubtleCrypto");
      var spec = normalise(algorithm, "deriveBits");
      var held = heldKey(key, "deriveBits", spec, "deriveBits");
      var job = derive("deriveBits", spec, held, length === undefined || length === null ? null : Number(length));
      return answer(function () {
        var out = run(job.op, job);
        return job.cut === undefined ? out : out.slice(0, Math.ceil(job.cut / 8));
      });
    }));

    patch(subtle, "deriveKey", promising(function deriveKey(algorithm, key, derived, extractable, usages) {
      required(arguments, 5, "deriveKey", "SubtleCrypto");
      var spec = normalise(algorithm, "deriveKey");
      var target = normalise(derived, "importKey");
      var held = heldKey(key, "deriveKey", spec, "deriveKey");
      var bits = target.name === "HMAC" ? (target.length === undefined ? HASHES[target.hash.name] : Number(target.length)) : Number(target.length);
      if (target.name.indexOf("AES-") === 0) aesLength(bits, "AES key length must be 128 or 256 bits");
      var job = derive("deriveKey", spec, held, bits);
      return answer(function () {
        return importRaw("raw", run(job.op, job), target, extractable, usages, "deriveKey");
      });
    }));

    patch(subtle, "wrapKey", promising(function wrapKey(format, key, wrapping, algorithm) {
      required(arguments, 4, "wrapKey", "SubtleCrypto");
      var spec = normalise(algorithm, "wrapKey");
      var held = heldKey(wrapping, "wrapKey", spec, "wrapKey");
      var exported = exportOf(format, key, "wrapKey");
      var bytes = format === "jwk" ? env.utf8Encode(JSON.stringify(exported)) : new Uint8Array(exported);
      var job = cipher("encrypt", spec, held, bytes);
      return answer(function () { return run(job.op, job); });
    }));

    patch(subtle, "unwrapKey", promising(function unwrapKey(format, wrapped, unwrapping, algorithm, unwrappedAlgorithm, extractable, usages) {
      required(arguments, 7, "unwrapKey", "SubtleCrypto");
      var spec = normalise(algorithm, "unwrapKey");
      var target = normalise(unwrappedAlgorithm, "importKey");
      var held = heldKey(unwrapping, "unwrapKey", spec, "unwrapKey");
      var job = cipher("decrypt", spec, held, bufferOf(wrapped, "unwrapKey", 2));
      return answer(function () {
        var plain = run(job.op, job);
        var data = format === "jwk" ? JSON.parse(env.utf8Decode(new Uint8Array(plain))) : plain;
        return importRaw(format, data, target, extractable, usages, "unwrapKey");
      });
    }));
  })();

  // ---- IndexedDB (in memory, per realm) -------------------------------------------------------------

  // Key order: arrays above binary above strings above dates above numbers.
  var keyRank = function (key) {
    if (Array.isArray(key)) return 4;
    if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) return 3;
    if (typeof key === "string") return 2;
    if (key instanceof Date) return 1;
    return 0;
  };

  var validKey = function (key, depth) {
    if (typeof key === "number") return !isNaN(key);
    if (typeof key === "string") return true;
    if (key instanceof Date) return !isNaN(key.getTime());
    if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) return true;
    if (Array.isArray(key) && (depth || 0) < 32) return key.every(function (item) { return validKey(item, (depth || 0) + 1); });
    return false;
  };

  var compareKeys = function (left, right) {
    var a = keyRank(left);
    var b = keyRank(right);
    if (a !== b) return a > b ? 1 : -1;
    if (a === 4) {
      for (var index = 0; index < Math.min(left.length, right.length); index += 1) {
        var inner = compareKeys(left[index], right[index]);
        if (inner) return inner;
      }
      return left.length === right.length ? 0 : left.length > right.length ? 1 : -1;
    }
    if (a === 3) {
      var x = new Uint8Array(left.buffer || left, left.byteOffset || 0, left.byteLength);
      var y = new Uint8Array(right.buffer || right, right.byteOffset || 0, right.byteLength);
      for (var at = 0; at < Math.min(x.length, y.length); at += 1) if (x[at] !== y[at]) return x[at] > y[at] ? 1 : -1;
      return x.length === y.length ? 0 : x.length > y.length ? 1 : -1;
    }
    var l = a === 1 ? left.getTime() : left;
    var r = a === 1 ? right.getTime() : right;
    return l === r ? 0 : l > r ? 1 : -1;
  };

  // A structured clone of a stored value (the types a record holds).
  var cloneValue = function (value, seen) {
    if (value === null || typeof value !== "object") {
      if (typeof value === "function" || typeof value === "symbol") throw domError("Failed to execute 'put' on 'IDBObjectStore': " + String(value) + " could not be cloned.", "DataCloneError");
      return value;
    }
    seen = seen || new Map();
    if (seen.has(value)) return seen.get(value);
    var out;
    if (value instanceof Date) out = new Date(value.getTime());
    else if (value instanceof RegExp) out = new RegExp(value.source, value.flags);
    else if (value instanceof ArrayBuffer) out = value.slice(0);
    else if (ArrayBuffer.isView(value)) out = new value.constructor(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    else if (env.blobBytes(value)) out = value;
    else if (value instanceof Map) {
      out = new Map();
      seen.set(value, out);
      value.forEach(function (item, key) { out.set(cloneValue(key, seen), cloneValue(item, seen)); });
      return out;
    } else if (value instanceof Set) {
      out = new Set();
      seen.set(value, out);
      value.forEach(function (item) { out.add(cloneValue(item, seen)); });
      return out;
    } else {
      out = Array.isArray(value) ? [] : {};
      seen.set(value, out);
      Object.keys(value).forEach(function (key) { out[key] = cloneValue(value[key], seen); });
      return out;
    }
    seen.set(value, out);
    return out;
  };

  var stringList = function (items) {
    var list = instance("DOMStringList", { length: items.length });
    items.forEach(function (item, index) {
      Object.defineProperty(list, String(index), { value: item, writable: false, enumerable: true, configurable: true });
    });
    return list;
  };

  (function installIndexedDb() {
    var factoryProto = globalThis.IDBFactory && globalThis.IDBFactory.prototype;
    if (!factoryProto) return;

    var listProto = globalThis.DOMStringList && globalThis.DOMStringList.prototype;
    if (listProto) {
      patch(listProto, "item", function item(index) { return this[index] === undefined ? null : this[index]; });
      patch(listProto, "contains", function contains(text) {
        for (var index = 0; index < fieldsOf(this).length; index += 1) if (this[index] === String(text)) return true;
        return false;
      });
    }

    var databases = new Map();
    var stores = new WeakMap();
    var where = function (method, iface) { return "Failed to execute '" + method + "' on '" + iface + "': "; };

    var keyRange = function (query, method, iface) {
      if (query === undefined || query === null) return null;
      var held = ranges.get(query);
      if (held) return held;
      if (!validKey(query)) throw domError(where(method, iface) + "The parameter is not a valid key.", "DataError");
      return { lower: query, upper: query, lowerOpen: false, upperOpen: false };
    };

    var inRange = function (range, key) {
      if (!range) return true;
      if (range.lower !== undefined) {
        var low = compareKeys(key, range.lower);
        if (low < 0 || (low === 0 && range.lowerOpen)) return false;
      }
      if (range.upper !== undefined) {
        var high = compareKeys(key, range.upper);
        if (high > 0 || (high === 0 && range.upperOpen)) return false;
      }
      return true;
    };

    var ranges = new WeakMap();
    var Range = globalThis.IDBKeyRange;
    if (Range) {
      var makeRange = function (lower, upper, lowerOpen, upperOpen) {
        var made = instance("IDBKeyRange", { lower: lower, upper: upper, lowerOpen: Boolean(lowerOpen), upperOpen: Boolean(upperOpen) });
        ranges.set(made, fieldsOf(made));
        return made;
      };
      var checked = function (key, method) {
        if (!validKey(key)) throw domError(where(method, "IDBKeyRange") + "The parameter is not a valid key.", "DataError");
        return key;
      };
      patch(Range, "only", function only(key) { checked(key, "only"); return makeRange(key, key, false, false); });
      patch(Range, "lowerBound", function lowerBound(key, open) { return makeRange(checked(key, "lowerBound"), undefined, open, true); });
      patch(Range, "upperBound", function upperBound(key, open) { return makeRange(undefined, checked(key, "upperBound"), true, open); });
      patch(Range, "bound", function bound(lower, upper, lowerOpen, upperOpen) {
        checked(lower, "bound");
        checked(upper, "bound");
        if (compareKeys(lower, upper) > 0) throw domError(where("bound", "IDBKeyRange") + "The lower key is greater than the upper key.", "DataError");
        return makeRange(lower, upper, lowerOpen, upperOpen);
      });
      patch(Range.prototype, "includes", function includes(key) {
        if (!validKey(key)) throw domError(where("includes", "IDBKeyRange") + "The parameter is not a valid key.", "DataError");
        return inRange(ranges.get(this), key);
      });
    }

    var keyAt = function (value, path) {
      if (Array.isArray(path)) return path.map(function (one) { return keyAt(value, one); });
      if (path === "") return value;
      var current = value;
      var parts = String(path).split(".");
      for (var index = 0; index < parts.length; index += 1) {
        if (current === null || typeof current !== "object" || !(parts[index] in current)) return undefined;
        current = current[parts[index]];
      }
      return current;
    };

    var find = function (records, key) {
      for (var index = 0; index < records.length; index += 1) if (compareKeys(records[index].key, key) === 0) return index;
      return -1;
    };

    var insert = function (records, record) {
      var at = 0;
      while (at < records.length && compareKeys(records[at].key, record.key) < 0) at += 1;
      records.splice(at, 0, record);
    };

    // A request: its result and error set when its transaction runs it, then success or error.
    var makeRequest = function (iface, source, transaction) {
      return instance(iface || "IDBRequest", { result: undefined, error: null, source: source || null, transaction: transaction || null, readyState: "pending", onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null });
    };

    var succeed = function (request, result, type, extra) {
      var fields = fieldsOf(request);
      fields.result = result;
      fields.readyState = "done";
      env.dispatch(request, extra ? env.makeEvent(type || "success", extra, "IDBVersionChangeEvent") : env.makeEvent(type || "success"));
    };

    var fail = function (request, error) {
      var fields = fieldsOf(request);
      fields.error = error;
      fields.readyState = "done";
      var event = env.makeEvent("error", { bubbles: true, cancelable: true });
      var proceed = env.dispatch(request, event);
      var transaction = fields.transaction;
      if (transaction && proceed) abortTransaction(transaction, error);
    };

    // A transaction runs its requests in order, each as a task; once none is left it commits.
    var schedule = function (transaction) {
      var state = fieldsOf(transaction).state;
      if (state.scheduled || state.finished) return;
      state.scheduled = true;
      env.later(function () {
        state.scheduled = false;
        if (state.finished) return;
        var next = state.queue.shift();
        if (next) {
          state.active = true;
          try {
            next();
          } finally {
            state.active = false;
          }
          schedule(transaction);
          return;
        }
        finishTransaction(transaction);
      }, 0);
    };

    var finishTransaction = function (transaction) {
      var fields = fieldsOf(transaction);
      if (fields.state.finished) return;
      fields.state.finished = true;
      fields.state.database.pending.splice(fields.state.database.pending.indexOf(transaction), 1);
      env.dispatch(transaction, env.makeEvent("complete"));
      if (fields.state.done) fields.state.done();
    };

    var abortTransaction = function (transaction, error) {
      var fields = fieldsOf(transaction);
      if (fields.state.finished) return;
      fields.state.finished = true;
      fields.error = error || null;
      fields.state.rollback();
      env.dispatch(transaction, env.makeEvent("abort", { bubbles: true }));
      if (fields.state.done) fields.state.done(true);
    };

    var enqueue = function (transaction, request, work) {
      var state = fieldsOf(transaction).state;
      if (state.finished) throw domError(where("get", "IDBObjectStore") + "The transaction has finished.", "TransactionInactiveError");
      state.queue.push(function () {
        try {
          succeed(request, work());
        } catch (error) {
          if (error && error.name && /Error$/.test(error.name)) fail(request, error);
          else throw error;
        }
      });
      schedule(transaction);
      return request;
    };

    var makeStore = function (transaction, name) {
      var fields = fieldsOf(transaction);
      var data = fields.state.database.data.stores.get(name);
      var store = instance("IDBObjectStore", { name: name, keyPath: data.keyPath, autoIncrement: data.autoIncrement, transaction: transaction, indexNames: stringList(Array.from(data.indexes.keys()).sort()) });
      stores.set(store, { data: data, transaction: transaction });
      return store;
    };

    var storeOf = function (store, method) {
      var held = stores.get(store);
      if (!held) throw typeError("Illegal invocation");
      if (fieldsOf(held.transaction).state.finished) throw domError(where(method, "IDBObjectStore") + "The transaction has finished.", "TransactionInactiveError");
      return held;
    };

    var writable = function (held, method) {
      if (fieldsOf(held.transaction).mode === "readonly") throw domError(where(method, "IDBObjectStore") + "The transaction is read-only.", "ReadOnlyError");
    };

    var storeProto = globalThis.IDBObjectStore && globalThis.IDBObjectStore.prototype;

    var write = function (method, overwrite) {
      return function (value, key) {
        required(arguments, 1, method, "IDBObjectStore");
        var held = storeOf(this, method);
        writable(held, method);
        var data = held.data;
        var stored = cloneValue(value);
        var recordKey = key;
        if (data.keyPath !== null) {
          if (key !== undefined) throw domError(where(method, "IDBObjectStore") + "The object store uses in-line keys and the key parameter was provided.", "DataError");
          recordKey = keyAt(stored, data.keyPath);
          if (recordKey === undefined && data.autoIncrement) {
            recordKey = data.counter;
            if (typeof data.keyPath === "string") stored[data.keyPath] = recordKey;
          }
        } else if (recordKey === undefined && data.autoIncrement) {
          recordKey = data.counter;
        }
        if (recordKey === undefined) throw domError(where(method, "IDBObjectStore") + "The object store uses out-of-line keys and has no key generator and the key parameter was not provided.", "DataError");
        if (!validKey(recordKey)) throw domError(where(method, "IDBObjectStore") + "Evaluating the object store's key path yielded a value that is not a valid key.", "DataError");
        var request = makeRequest("IDBRequest", this, held.transaction);
        return enqueue(held.transaction, request, function () {
          var at = find(data.records, recordKey);
          if (at !== -1 && !overwrite) throw domError("Key already exists in the object store.", "ConstraintError");
          if (at !== -1) data.records.splice(at, 1);
          insert(data.records, { key: recordKey, value: stored });
          if (typeof recordKey === "number" && recordKey >= data.counter) data.counter = Math.floor(recordKey) + 1;
          return recordKey;
        });
      };
    };

    var selected = function (records, query, method, iface) {
      var range = keyRange(query, method, iface);
      return records.filter(function (record) { return inRange(range, record.key); });
    };

    var reading = function (iface, method, compute) {
      return function (query, count) {
        var held = iface === "IDBIndex" ? indexOf(this, method) : storeOf(this, method);
        var records = iface === "IDBIndex" ? indexRecords(held) : held.data.records;
        var chosen = selected(records, query, method, iface);
        var request = makeRequest("IDBRequest", this, held.transaction);
        return enqueue(held.transaction, request, function () { return compute(chosen, count); });
      };
    };

    var firstValue = function (chosen) { return chosen.length ? cloneValue(chosen[0].value) : undefined; };
    var firstKey = function (chosen) { return chosen.length ? chosen[0].key : undefined; };
    var limited = function (chosen, count) { return count ? chosen.slice(0, Number(count)) : chosen; };

    var cursorProto = globalThis.IDBCursor && globalThis.IDBCursor.prototype;
    var cursors = new WeakMap();

    var openCursor = function (iface, method, withValue) {
      return function (query, direction) {
        var held = iface === "IDBIndex" ? indexOf(this, method) : storeOf(this, method);
        var order = enumOf(direction === undefined ? "next" : direction, ["next", "nextunique", "prev", "prevunique"], where(method, iface), "IDBCursorDirection");
        var records = selected(iface === "IDBIndex" ? indexRecords(held) : held.data.records, query, method, iface);
        if (order.indexOf("prev") === 0) records = records.slice().reverse();
        var request = makeRequest("IDBRequest", this, held.transaction);
        var source = this;
        var position = -1;
        var cursor = instance(withValue ? "IDBCursorWithValue" : "IDBCursor", { source: source, direction: order, key: undefined, primaryKey: undefined, value: undefined, request: request });
        var step = function (by) {
          position += by;
          var record = records[position];
          var fields = fieldsOf(cursor);
          if (!record) return null;
          fields.key = record.key;
          fields.primaryKey = record.primary !== undefined ? record.primary : record.key;
          if (withValue) fields.value = cloneValue(record.value);
          return cursor;
        };
        cursors.set(cursor, {
          advance: function (by) {
            fieldsOf(request).readyState = "pending";
            enqueue(held.transaction, request, function () { return step(by); });
          },
          held: held,
        });
        return enqueue(held.transaction, request, function () { return step(1); });
      };
    };

    if (cursorProto) {
      var cursorOf = function (cursor) {
        var state = cursors.get(cursor);
        if (!state) throw typeError("Illegal invocation");
        return state;
      };
      patch(cursorProto, "continue", function continue_() { cursorOf(this).advance(1); });
      patch(cursorProto, "advance", function advance(count) {
        if (!(Number(count) > 0)) throw typeError(where("advance", "IDBCursor") + "A count argument with value 0 (zero) was supplied, must be greater than 0.");
        cursorOf(this).advance(Number(count));
      });
      patch(cursorProto, "delete", function delete_() {
        var state = cursorOf(this);
        return state.held.data ? globalThis.IDBObjectStore.prototype.delete.call(fieldsOf(this).source, fieldsOf(this).primaryKey) : undefined;
      });
      patch(cursorProto, "update", function update(value) {
        var state = cursorOf(this);
        var store = fieldsOf(this).source;
        var data = state.held.data;
        return data.keyPath !== null ? store.put(value) : store.put(value, fieldsOf(this).primaryKey);
      });
    }

    var indexes = new WeakMap();
    var indexOf = function (index, method) {
      var held = indexes.get(index);
      if (!held) throw typeError("Illegal invocation");
      if (fieldsOf(held.transaction).state.finished) throw domError(where(method, "IDBIndex") + "The transaction has finished.", "TransactionInactiveError");
      return held;
    };
    var indexRecords = function (held) {
      var out = [];
      held.store.records.forEach(function (record) {
        var key = keyAt(record.value, held.index.keyPath);
        var keysOf = held.index.multiEntry && Array.isArray(key) ? key : [key];
        keysOf.forEach(function (one) {
          if (validKey(one)) out.push({ key: one, primary: record.key, value: record.value });
        });
      });
      return out.sort(function (a, b) { return compareKeys(a.key, b.key) || compareKeys(a.primary, b.primary); });
    };

    if (storeProto) {
      patch(storeProto, "put", write("put", true));
      patch(storeProto, "add", write("add", false));
      patch(storeProto, "get", reading("IDBObjectStore", "get", firstValue));
      patch(storeProto, "getKey", reading("IDBObjectStore", "getKey", firstKey));
      patch(storeProto, "getAll", reading("IDBObjectStore", "getAll", function (chosen, count) { return limited(chosen, count).map(function (record) { return cloneValue(record.value); }); }));
      patch(storeProto, "getAllKeys", reading("IDBObjectStore", "getAllKeys", function (chosen, count) { return limited(chosen, count).map(function (record) { return record.key; }); }));
      patch(storeProto, "count", reading("IDBObjectStore", "count", function (chosen) { return chosen.length; }));
      patch(storeProto, "openCursor", openCursor("IDBObjectStore", "openCursor", true));
      patch(storeProto, "openKeyCursor", openCursor("IDBObjectStore", "openKeyCursor", false));
      patch(storeProto, "delete", function delete_(query) {
        required(arguments, 1, "delete", "IDBObjectStore");
        var held = storeOf(this, "delete");
        writable(held, "delete");
        var range = keyRange(query, "delete", "IDBObjectStore");
        return enqueue(held.transaction, makeRequest("IDBRequest", this, held.transaction), function () {
          held.data.records = held.data.records.filter(function (record) { return !inRange(range, record.key); });
          return undefined;
        });
      });
      patch(storeProto, "clear", function clear() {
        var held = storeOf(this, "clear");
        writable(held, "clear");
        return enqueue(held.transaction, makeRequest("IDBRequest", this, held.transaction), function () {
          held.data.records = [];
          return undefined;
        });
      });
      patch(storeProto, "createIndex", function createIndex(name, keyPath, options) {
        required(arguments, 2, "createIndex", "IDBObjectStore");
        var held = storeOf(this, "createIndex");
        if (fieldsOf(held.transaction).mode !== "versionchange") throw domError(where("createIndex", "IDBObjectStore") + "The database is not running a version change transaction.", "InvalidStateError");
        if (held.data.indexes.has(String(name))) throw domError(where("createIndex", "IDBObjectStore") + "An index with the specified name already exists.", "ConstraintError");
        held.data.indexes.set(String(name), { keyPath: keyPath, unique: Boolean(options && options.unique), multiEntry: Boolean(options && options.multiEntry) });
        fieldsOf(this).indexNames = stringList(Array.from(held.data.indexes.keys()).sort());
        return this.index(name);
      });
      patch(storeProto, "index", function index(name) {
        var held = storeOf(this, "index");
        var found = held.data.indexes.get(String(name));
        if (!found) throw domError(where("index", "IDBObjectStore") + "The specified index was not found.", "NotFoundError");
        var made = instance("IDBIndex", { name: String(name), keyPath: found.keyPath, unique: found.unique, multiEntry: found.multiEntry, objectStore: this });
        indexes.set(made, { index: found, store: held.data, transaction: held.transaction });
        return made;
      });
      patch(storeProto, "deleteIndex", function deleteIndex(name) {
        var held = storeOf(this, "deleteIndex");
        if (!held.data.indexes.delete(String(name))) throw domError(where("deleteIndex", "IDBObjectStore") + "The specified index was not found.", "NotFoundError");
        fieldsOf(this).indexNames = stringList(Array.from(held.data.indexes.keys()).sort());
      });
    }

    var indexProto = globalThis.IDBIndex && globalThis.IDBIndex.prototype;
    if (indexProto) {
      patch(indexProto, "get", reading("IDBIndex", "get", firstValue));
      patch(indexProto, "getKey", reading("IDBIndex", "getKey", function (chosen) { return chosen.length ? chosen[0].primary : undefined; }));
      patch(indexProto, "getAll", reading("IDBIndex", "getAll", function (chosen, count) { return limited(chosen, count).map(function (record) { return cloneValue(record.value); }); }));
      patch(indexProto, "getAllKeys", reading("IDBIndex", "getAllKeys", function (chosen, count) { return limited(chosen, count).map(function (record) { return record.primary; }); }));
      patch(indexProto, "count", reading("IDBIndex", "count", function (chosen) { return chosen.length; }));
      patch(indexProto, "openCursor", openCursor("IDBIndex", "openCursor", true));
      patch(indexProto, "openKeyCursor", openCursor("IDBIndex", "openKeyCursor", false));
    }

    var connections = new WeakMap();

    var makeTransaction = function (database, names, mode) {
      var connection = connections.get(database);
      var snapshot = new Map();
      connection.data.stores.forEach(function (store, name) {
        snapshot.set(name, { records: store.records.slice(), counter: store.counter, indexes: new Map(store.indexes) });
      });
      var transaction = instance("IDBTransaction", { db: database, mode: mode, durability: "default", error: null, objectStoreNames: stringList(names.slice().sort()), oncomplete: null, onerror: null, onabort: null,
        state: { queue: [], scheduled: false, finished: false, active: false, database: connection, done: null, names: names,
          rollback: function () {
            snapshot.forEach(function (saved, name) {
              var store = connection.data.stores.get(name);
              if (store) {
                store.records = saved.records;
                store.counter = saved.counter;
                store.indexes = saved.indexes;
              }
            });
          } } });
      connection.pending.push(transaction);
      return transaction;
    };

    var transactionProto = globalThis.IDBTransaction && globalThis.IDBTransaction.prototype;
    if (transactionProto) {
      patch(transactionProto, "objectStore", function objectStore(name) {
        var fields = fieldsOf(this);
        if (!fields) throw typeError("Illegal invocation");
        if (fields.state.finished) throw domError(where("objectStore", "IDBTransaction") + "The transaction has finished.", "InvalidStateError");
        if (fields.state.names.indexOf(String(name)) === -1 || !fields.state.database.data.stores.has(String(name))) {
          throw domError(where("objectStore", "IDBTransaction") + "The specified object store was not found.", "NotFoundError");
        }
        return makeStore(this, String(name));
      });
      patch(transactionProto, "abort", function abort() {
        var fields = fieldsOf(this);
        if (fields.state.finished) throw domError(where("abort", "IDBTransaction") + "The transaction has already been committed or aborted.", "InvalidStateError");
        abortTransaction(this, null);
      });
      patch(transactionProto, "commit", function commit() {
        schedule(this);
      });
    }

    var databaseProto = globalThis.IDBDatabase && globalThis.IDBDatabase.prototype;
    if (databaseProto) {
      var storeNames = function (connection) { return stringList(Array.from(connection.data.stores.keys()).sort()); };
      patchGetter(databaseProto, "objectStoreNames", function () { return storeNames(connections.get(this)); });
      patch(databaseProto, "createObjectStore", function createObjectStore(name, options) {
        required(arguments, 1, "createObjectStore", "IDBDatabase");
        var connection = connections.get(this);
        if (!connection.upgrading) throw domError(where("createObjectStore", "IDBDatabase") + "The database is not running a version change transaction.", "InvalidStateError");
        var text = String(name);
        if (connection.data.stores.has(text)) throw domError(where("createObjectStore", "IDBDatabase") + "An object store with the specified name already exists.", "ConstraintError");
        var keyPath = options && options.keyPath !== undefined ? options.keyPath : null;
        var autoIncrement = Boolean(options && options.autoIncrement);
        if (autoIncrement && (keyPath === "" || Array.isArray(keyPath))) throw domError(where("createObjectStore", "IDBDatabase") + "The autoIncrement option was set but the keyPath option was empty or an array.", "InvalidAccessError");
        connection.data.stores.set(text, { keyPath: keyPath, autoIncrement: autoIncrement, records: [], counter: 1, indexes: new Map() });
        fieldsOf(connection.upgrading).state.names.push(text);
        return makeStore(connection.upgrading, text);
      });
      patch(databaseProto, "deleteObjectStore", function deleteObjectStore(name) {
        var connection = connections.get(this);
        if (!connection.upgrading) throw domError(where("deleteObjectStore", "IDBDatabase") + "The database is not running a version change transaction.", "InvalidStateError");
        if (!connection.data.stores.delete(String(name))) throw domError(where("deleteObjectStore", "IDBDatabase") + "The specified object store was not found.", "NotFoundError");
      });
      patch(databaseProto, "transaction", function transaction(names, mode, options) {
        required(arguments, 1, "transaction", "IDBDatabase");
        var connection = connections.get(this);
        if (connection.closed) throw domError(where("transaction", "IDBDatabase") + "The database connection is closing.", "InvalidStateError");
        var list = typeof names === "string" ? [names] : sequenceOf(names, where("transaction", "IDBDatabase")).map(String);
        if (!list.length) throw domError(where("transaction", "IDBDatabase") + "The storeNames parameter was empty.", "InvalidAccessError");
        list.forEach(function (name) {
          if (!connection.data.stores.has(name)) throw domError(where("transaction", "IDBDatabase") + "One of the specified object stores was not found.", "NotFoundError");
        });
        var kind = enumOf(mode === undefined ? "readonly" : mode, ["readonly", "readwrite", "versionchange"], where("transaction", "IDBDatabase"), "IDBTransactionMode");
        if (kind === "versionchange") throw typeError(where("transaction", "IDBDatabase") + "The mode provided ('versionchange') is not one of 'readonly' or 'readwrite'.");
        var made = makeTransaction(this, list, kind);
        if (options && options.durability) fieldsOf(made).durability = String(options.durability);
        schedule(made);
        return made;
      });
      patch(databaseProto, "close", function close() {
        connections.get(this).closed = true;
      });
    }

    var openRequests = function (name, version, request) {
      var entry = databases.get(name);
      var old = entry ? entry.version : 0;
      var wanted = version === undefined ? old || 1 : version;
      if (wanted < old) {
        fail(request, domError("The requested version (" + wanted + ") is less than the existing version (" + old + ").", "VersionError"));
        return;
      }
      if (!entry) {
        entry = { version: 0, stores: new Map() };
        databases.set(name, entry);
      }
      var database = instance("IDBDatabase", { name: name, version: wanted, onabort: null, onclose: null, onerror: null, onversionchange: null });
      var connection = { data: entry, pending: [], upgrading: null, closed: false };
      connections.set(database, connection);

      if (wanted === old) {
        succeed(request, database);
        return;
      }

      var upgrade = makeTransaction(database, Array.from(entry.stores.keys()), "versionchange");
      connection.upgrading = upgrade;
      var fields = fieldsOf(request);
      fields.transaction = upgrade;
      fields.result = database;
      fields.readyState = "done";
      entry.version = wanted;
      fieldsOf(upgrade).state.done = function (aborted) {
        connection.upgrading = null;
        fields.transaction = null;
        if (aborted) {
          entry.version = old;
          if (!old) databases.delete(name);
          fail(request, domError("Version change transaction was aborted in upgradeneeded event handler.", "AbortError"));
          return;
        }
        succeed(request, database);
      };
      fieldsOf(upgrade).state.active = true;
      try {
        env.dispatch(request, env.makeEvent("upgradeneeded", { oldVersion: old, newVersion: wanted, dataLoss: "none", dataLossMessage: "" }, "IDBVersionChangeEvent"));
      } finally {
        fieldsOf(upgrade).state.active = false;
      }
      schedule(upgrade);
    };

    patch(factoryProto, "open", function open(name, version) {
      required(arguments, 1, "open", "IDBFactory");
      if (version !== undefined && !(Number(version) >= 1)) throw typeError(where("open", "IDBFactory") + "The version provided must not be 0.");
      var request = makeRequest("IDBOpenDBRequest", null, null);
      var text = String(name);
      env.later(function () { openRequests(text, version === undefined ? undefined : Math.trunc(Number(version)), request); }, 0);
      return request;
    });

    patch(factoryProto, "deleteDatabase", function deleteDatabase(name) {
      required(arguments, 1, "deleteDatabase", "IDBFactory");
      var request = makeRequest("IDBOpenDBRequest", null, null);
      var text = String(name);
      env.later(function () {
        var entry = databases.get(text);
        databases.delete(text);
        succeed(request, undefined, "success", { oldVersion: entry ? entry.version : 0, newVersion: null, dataLoss: "none", dataLossMessage: "" });
      }, 0);
      return request;
    });

    patch(factoryProto, "databases", function databases_() {
      return answer(function () {
        var out = [];
        databases.forEach(function (entry, name) { out.push({ name: name, version: entry.version }); });
        return out;
      });
    });

    patch(factoryProto, "cmp", function cmp(first, second) {
      required(arguments, 2, "cmp", "IDBFactory");
      if (!validKey(first) || !validKey(second)) throw domError(where("cmp", "IDBFactory") + "The parameter is not a valid key.", "DataError");
      return compareKeys(first, second);
    });
  })();

  // ---- Cache Storage ----------------------------------------------------------------------------

  (function installCaches() {
    var storageProto = globalThis.CacheStorage && globalThis.CacheStorage.prototype;
    var cacheProto = globalThis.Cache && globalThis.Cache.prototype;
    if (!storageProto || !cacheProto) return;

    var named = new Map();
    var entries = new WeakMap();

    var urlOf = function (request) {
      var raw = request !== null && typeof request === "object" && "url" in request ? request.url : String(request);
      return new globalThis.URL(raw, globalThis.location.href).href.replace(/#.*$/, "");
    };

    var cacheOf = function (cache) {
      var held = entries.get(cache);
      if (!held) throw typeError("Illegal invocation");
      return held;
    };

    var served = function (response) {
      return response && typeof response.clone === "function" ? response.clone() : response;
    };

    patch(storageProto, "open", function open(name) {
      var text = String(name);
      return answer(function () {
        if (!named.has(text)) {
          var cache = instance("Cache", {});
          entries.set(cache, new Map());
          named.set(text, cache);
        }
        return named.get(text);
      });
    });
    patch(storageProto, "has", function has(name) { return answer(function () { return named.has(String(name)); }); });
    patch(storageProto, "delete", function delete_(name) { return answer(function () { return named.delete(String(name)); }); });
    patch(storageProto, "keys", function keys() { return answer(function () { return Array.from(named.keys()); }); });
    patch(storageProto, "match", function match(request) {
      var url = urlOf(request);
      return answer(function () {
        var found;
        named.forEach(function (cache) {
          if (found === undefined && entries.get(cache).has(url)) found = served(entries.get(cache).get(url));
        });
        return found;
      });
    });

    patch(cacheProto, "put", promising(function put(request, response) {
      required(arguments, 2, "put", "Cache");
      var held = cacheOf(this);
      var url = urlOf(request);
      if (!/^https?:/.test(url)) throw typeError("Failed to execute 'put' on 'Cache': Request scheme '" + url.split(":")[0] + "' is unsupported");
      return answer(function () { held.set(url, response); return undefined; });
    }));
    patch(cacheProto, "add", promising(function add(request) {
      var cache = this;
      cacheOf(cache);
      return globalThis.fetch(request).then(function (response) {
        if (!response.ok) throw typeError("Failed to execute 'add' on 'Cache': Request failed");
        return cache.put(request, response);
      });
    }));
    patch(cacheProto, "addAll", promising(function addAll(requests) {
      var cache = this;
      return Promise.all(sequenceOf(requests, "Failed to execute 'addAll' on 'Cache': ").map(function (request) { return cache.add(request); })).then(function () { return undefined; });
    }));
    patch(cacheProto, "match", function match(request) {
      var held = cacheOf(this);
      var url = urlOf(request);
      return answer(function () { return held.has(url) ? served(held.get(url)) : undefined; });
    });
    patch(cacheProto, "matchAll", function matchAll(request) {
      var held = cacheOf(this);
      var url = request === undefined ? null : urlOf(request);
      return answer(function () {
        var out = [];
        held.forEach(function (response, key) { if (url === null || key === url) out.push(served(response)); });
        return out;
      });
    });
    patch(cacheProto, "delete", function delete_(request) {
      var held = cacheOf(this);
      var url = urlOf(request);
      return answer(function () { return held.delete(url); });
    });
    patch(cacheProto, "keys", function keys() {
      var held = cacheOf(this);
      return answer(function () { return Array.from(held.keys()).map(function (url) { return new globalThis.Request(url); }); });
    });
  })();

  // ---- Cookie Store -----------------------------------------------------------------------------

  (function installCookieStore() {
    var storeProto = globalThis.CookieStore && globalThis.CookieStore.prototype;
    if (!storeProto) return;

    // Attributes of the cookies set through the Cookie Store (the jar keeps only name=value).
    var attributes = new Map();

    var jar = function () {
      var out = [];
      String(globalThis.document.cookie || "").split(/;\s*/).forEach(function (pair) {
        if (!pair) return;
        var at = pair.indexOf("=");
        var name = at === -1 ? "" : pair.slice(0, at);
        var value = at === -1 ? pair : pair.slice(at + 1);
        var extra = attributes.get(name) || {};
        out.push({ domain: extra.domain === undefined ? null : extra.domain, expires: extra.expires === undefined ? null : extra.expires, name: name, partitioned: Boolean(extra.partitioned),
          path: extra.path || "/", sameSite: extra.sameSite || "strict", secure: true, value: value });
      });
      return out;
    };

    var queryOf = function (args, method) {
      var first = args[0];
      if (first === undefined) return {};
      if (first !== null && typeof first === "object") return { name: first.name === undefined ? undefined : String(first.name), url: first.url };
      return { name: String(first) };
    };

    var store = function () { return globalThis.cookieStore; };

    var changed = function (list, deleted) {
      env.later(function () {
        env.dispatch(store(), env.makeEvent("change", { changed: deleted ? [] : list, deleted: deleted ? list : [] }, "CookieChangeEvent"));
      }, 0);
    };

    patch(storeProto, "get", function get() {
      var query = queryOf(arguments, "get");
      return answer(function () {
        var found = jar().filter(function (cookie) { return query.name === undefined || cookie.name === query.name; });
        return found.length ? found[0] : null;
      });
    });
    patch(storeProto, "getAll", function getAll() {
      var query = queryOf(arguments, "getAll");
      return answer(function () { return jar().filter(function (cookie) { return query.name === undefined || cookie.name === query.name; }); });
    });
    patch(storeProto, "set", promising(function set(name, value) {
      required(arguments, 1, "set", "CookieStore");
      var options = name !== null && typeof name === "object" ? name : { name: name, value: value };
      if (arguments.length === 1 && (name === null || typeof name !== "object")) {
        throw typeError("Failed to execute 'set' on 'CookieStore': The provided value is not of type 'CookieInit'.");
      }
      var text = String(options.name === undefined ? "" : options.name);
      var content = String(options.value === undefined ? "" : options.value);
      var sameSite = options.sameSite === undefined ? "strict" : enumOf(options.sameSite, ["strict", "lax", "none"], "Failed to execute 'set' on 'CookieStore': Failed to read the 'sameSite' property from 'CookieInit': ", "CookieSameSite");
      if (!text && !content) throw typeError("Failed to execute 'set' on 'CookieStore': Cookie name and value both cannot be empty.");
      var expires = options.expires === undefined || options.expires === null ? null : Number(options.expires);
      return answer(function () {
        if (expires !== null && expires < Date.now()) {
          globalThis.document.cookie = text + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=" + (options.path || "/");
          attributes.delete(text);
          return undefined;
        }
        attributes.set(text, { domain: options.domain === undefined ? undefined : options.domain, expires: expires === null ? undefined : expires, path: options.path || "/", sameSite: sameSite, partitioned: Boolean(options.partitioned) });
        globalThis.document.cookie = text + "=" + content + "; path=" + (options.path || "/") + "; secure; samesite=" + sameSite;
        changed(jar().filter(function (cookie) { return cookie.name === text; }), false);
        return undefined;
      });
    }));
    patch(storeProto, "delete", promising(function delete_(name) {
      required(arguments, 1, "delete", "CookieStore");
      var options = name !== null && typeof name === "object" ? name : { name: name };
      var text = String(options.name);
      return answer(function () {
        var gone = jar().filter(function (cookie) { return cookie.name === text; });
        globalThis.document.cookie = text + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=" + (options.path || "/");
        attributes.delete(text);
        if (gone.length) changed(gone.map(function (cookie) { return { name: cookie.name, value: undefined, path: cookie.path }; }), true);
        return undefined;
      });
    }));
  })();

  // ---- Battery, media devices ---------------------------------------------------------------------

  (function installBattery() {
    var battery = traits.battery;
    if (!navigatorProto || typeof globalThis.navigator.getBattery !== "function" || !battery || !globalThis.BatteryManager) return;

    var manager = null;
    var infinite = function (value) { return value === "Infinity" || value === undefined || value === null ? Infinity : value; };

    patch(navigatorProto, "getBattery", function getBattery() {
      if (!manager) {
        manager = instance("BatteryManager", { charging: battery.charging, chargingTime: infinite(battery.chargingTime),
          dischargingTime: infinite(battery.dischargingTime), level: battery.level, onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null });
      }
      var made = manager;
      return answer(function () { return made; });
    });
  })();

  (function installMediaDevices() {
    var devicesProto = globalThis.MediaDevices && globalThis.MediaDevices.prototype;
    var infoProto = globalThis.MediaDeviceInfo && globalThis.MediaDeviceInfo.prototype;
    // Without a permission Chrome lists one of each kind, unnamed.
    var listed = facts.devices || [
      { kind: "audioinput", deviceId: "", label: "", groupId: "", brand: "[object InputDeviceInfo]" },
      { kind: "videoinput", deviceId: "", label: "", groupId: "", brand: "[object InputDeviceInfo]" },
      { kind: "audiooutput", deviceId: "", label: "", groupId: "", brand: "[object MediaDeviceInfo]" },
    ];
    if (!devicesProto || !infoProto) return;

    patch(infoProto, "toJSON", function toJSON() {
      var fields = fieldsOf(this);
      if (!fields) throw typeError("Illegal invocation");
      return { deviceId: fields.deviceId, kind: fields.kind, label: fields.label, groupId: fields.groupId };
    });

    if (globalThis.InputDeviceInfo && globalThis.InputDeviceInfo.prototype) {
      patch(globalThis.InputDeviceInfo.prototype, "getCapabilities", function getCapabilities() { return {}; });
    }

    patch(devicesProto, "enumerateDevices", function enumerateDevices() {
      return answer(function () {
        return listed.map(function (device) {
          var iface = /InputDeviceInfo/.test(device.brand) ? "InputDeviceInfo" : "MediaDeviceInfo";
          return instance(iface, { deviceId: device.deviceId, kind: device.kind, label: device.label, groupId: device.groupId });
        });
      });
    });
  })();

  // ---- Speech synthesis -------------------------------------------------------------------------

  (function installSpeech() {
    var synthesisProto = globalThis.SpeechSynthesis && globalThis.SpeechSynthesis.prototype;
    var recorded = (facts.voices && facts.voices.list) || [];
    if (!synthesisProto) return;

    // Chrome fetches the voice list the first time a page asks, so the first getVoices() is empty
    // and "voiceschanged" fires once the list arrives.
    var voices = null;
    var loading = false;
    var queue = [];
    var state = { speaking: false, paused: false };

    var load = function (synthesis) {
      if (voices || loading) return;
      loading = true;
      env.later(function () {
        voices = recorded.map(function (voice) {
          return instance("SpeechSynthesisVoice", { name: voice[0], lang: voice[1], localService: voice[2], default: voice[3], voiceURI: voice[4] });
        });
        env.dispatch(synthesis, env.makeEvent("voiceschanged"));
      }, (facts.voices && facts.voices.delay) || 15);
    };

    patch(synthesisProto, "getVoices", function getVoices() {
      load(this);
      return voices ? voices.slice() : [];
    });

    patchGetter(synthesisProto, "speaking", function () { return state.speaking; });
    patchGetter(synthesisProto, "pending", function () { return queue.length > (state.speaking ? 1 : 0); });
    patchGetter(synthesisProto, "paused", function () { return state.paused; });

    var utteranceEvent = function (type, utterance, extra) {
      var fields = { charIndex: 0, charLength: 0, elapsedTime: 0, name: "", utterance: utterance };
      for (var key in extra || {}) fields[key] = extra[key];
      return env.makeEvent(type, fields, type === "error" ? "SpeechSynthesisErrorEvent" : "SpeechSynthesisEvent");
    };

    var next = function () {
      if (state.speaking || !queue.length) return;
      var utterance = queue[0];
      var text = String(fieldsOf(utterance).text || "");
      state.speaking = true;
      env.later(function () {
        if (queue[0] !== utterance) return;
        env.dispatch(utterance, utteranceEvent("start", utterance));
        env.later(function () {
          if (queue[0] !== utterance) return;
          queue.shift();
          state.speaking = false;
          env.dispatch(utterance, utteranceEvent("end", utterance, { elapsedTime: text.length * 60, charIndex: text.length }));
          next();
        }, Math.max(200, text.length * 60));
      }, 0);
    };

    patch(synthesisProto, "speak", function speak(utterance) {
      required(arguments, 1, "speak", "SpeechSynthesis");
      if (!globalThis.SpeechSynthesisUtterance || !(utterance instanceof globalThis.SpeechSynthesisUtterance)) {
        throw typeError("Failed to execute 'speak' on 'SpeechSynthesis': parameter 1 is not of type 'SpeechSynthesisUtterance'.");
      }
      queue.push(utterance);
      next();
    });
    patch(synthesisProto, "cancel", function cancel() {
      var dropped = queue.splice(0);
      dropped.forEach(function (utterance, index) {
        env.later(function () { env.dispatch(utterance, utteranceEvent("error", utterance, { error: index === 0 && state.speaking ? "interrupted" : "canceled" })); }, 0);
      });
      state.speaking = false;
      state.paused = false;
    });
    patch(synthesisProto, "pause", function pause() { if (state.speaking) state.paused = true; });
    patch(synthesisProto, "resume", function resume() { state.paused = false; });

    var Utterance = globalThis.SpeechSynthesisUtterance;
    if (Utterance && Utterance.prototype) {
      var utteranceProto = Utterance.prototype;
      env.installShell("SpeechSynthesisUtterance", function (args) {
        return instance("SpeechSynthesisUtterance", { text: args[0] === undefined ? "" : String(args[0]), lang: "", voice: null, volume: 1, rate: 1, pitch: 1,
          onstart: null, onend: null, onerror: null, onpause: null, onresume: null, onmark: null, onboundary: null });
      }, 0);
      defineAttribute(utteranceProto, "text", null, function (fields, value) { fields.text = String(value); });
      defineAttribute(utteranceProto, "lang", null, function (fields, value) { fields.lang = String(value); });
      defineAttribute(utteranceProto, "voice", null, function (fields, value) {
        if (value !== null && !(value instanceof globalThis.SpeechSynthesisVoice)) throw typeError("Failed to set the 'voice' property on 'SpeechSynthesisUtterance': The provided value is not of type 'SpeechSynthesisVoice'.");
        fields.voice = value;
      });
      ["volume", "rate", "pitch"].forEach(function (name) {
        defineAttribute(utteranceProto, name, null, function (fields, value) {
          var number = Number(value);
          if (!isFinite(number)) throw typeError("Failed to set the '" + name + "' property on 'SpeechSynthesisUtterance': The provided float value is non-finite.");
          fields[name] = Math.fround(number);
        });
      });
    }
  })();

  // ---- WebRTC -----------------------------------------------------------------------------------

  (function installWebRtc() {
    var Connection = globalThis.RTCPeerConnection;
    var data = facts.webrtcData || {};
    var recordedMedia = traits.webrtc && traits.webrtc.offerSdp;
    if (!Connection || (!data.offerSdp && !recordedMedia)) return;

    var connectionProto = Connection.prototype;
    var states = new WeakMap();
    var hexDigits = "0123456789ABCDEF";
    var ICE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    var pick = function (alphabet, count) {
      var bytes = randomBytes(count);
      var out = "";
      for (var index = 0; index < count; index += 1) out += alphabet.charAt(bytes[index] % alphabet.length);
      return out;
    };

    var randomInt = function (low, high) {
      var bytes = randomBytes(4);
      var value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
      return low + (value % (high - low + 1));
    };

    // The media sections of the captured offers, keyed by kind (audio, video, application).
    var sections = {};
    var collect = function (sdp) {
      if (!sdp) return;
      String(sdp).split(/(?=^m=)/m).forEach(function (part) {
        var kind = /^m=(\w+)/.exec(part);
        if (kind && !sections[kind[1]]) sections[kind[1]] = part;
      });
    };
    collect(data.offerSdp);
    collect(recordedMedia);

    // The host this browser hides its address behind (one mDNS name for the page's lifetime).
    var mdnsName = randomUuid() + ".local";

    var stateOf = function (connection) {
      var state = states.get(connection);
      if (!state) throw typeError("Illegal invocation");
      return state;
    };

    var fire = function (target, type, fields, iface) {
      env.dispatch(target, env.makeEvent(type, fields, iface));
    };

    var setSignaling = function (connection, state, value) {
      if (state.signaling === value) return;
      state.signaling = value;
      fire(connection, "signalingstatechange");
    };

    // An offer as Chrome writes one for what the connection carries: receive-only audio and video
    // when asked, and the data channel section once a channel exists.
    var offerSdp = function (state, options) {
      var kinds = [];
      var wantAudio = state.audio || (options && (options.offerToReceiveAudio === true || Number(options.offerToReceiveAudio) > 0));
      var wantVideo = state.video || (options && (options.offerToReceiveVideo === true || Number(options.offerToReceiveVideo) > 0));
      if (wantAudio) {
        kinds.push("audio");
        state.audio = true;
      }
      if (wantVideo) {
        kinds.push("video");
        state.video = true;
      }
      if (state.channels.length) kinds.push("application");

      var lines = "v=0\r\no=- " + state.session + " " + state.version + " IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
      if (kinds.length) lines += "a=group:BUNDLE " + kinds.map(function (kind, index) { return index; }).join(" ") + "\r\n";
      lines += "a=extmap-allow-mixed\r\na=msid-semantic: WMS\r\n";
      kinds.forEach(function (kind, index) {
        lines += String(sections[kind] || "")
          .replace(/a=mid:[^\r\n]*/, "a=mid:" + index)
          .replace(/a=ice-ufrag:[^\r\n]*/g, "a=ice-ufrag:" + state.ufrag)
          .replace(/a=ice-pwd:[^\r\n]*/g, "a=ice-pwd:" + state.pwd)
          .replace(/a=fingerprint:sha-256 [^\r\n]*/g, "a=fingerprint:sha-256 " + state.fingerprint);
      });
      state.mids = kinds.length;
      return lines;
    };

    var describe = function (type, sdp) {
      return instance("RTCSessionDescription", { type: type, sdp: sdp });
    };

    var descriptionProto = globalThis.RTCSessionDescription && globalThis.RTCSessionDescription.prototype;
    if (descriptionProto) {
      patch(descriptionProto, "toJSON", function toJSON() {
        var fields = fieldsOf(this);
        if (!fields) throw typeError("Illegal invocation");
        return { type: fields.type, sdp: fields.sdp };
      });
      env.installShell("RTCSessionDescription", function (args) {
        var init = args[0] || {};
        return describe(enumOf(init.type === undefined ? "" : init.type, ["", "offer", "pranswer", "answer", "rollback"], "Failed to construct 'RTCSessionDescription': Failed to read the 'type' property from 'RTCSessionDescriptionInit': ", "RTCSdpType"), init.sdp === undefined ? "" : String(init.sdp));
      }, 0);
    }

    var candidateFields = function (line, mid, index, ufrag) {
      var parts = String(line).replace(/^candidate:/, "").split(" ");
      var named = {};
      for (var at = 6; at + 1 < parts.length; at += 2) named[parts[at]] = parts[at + 1];
      return {
        candidate: line, sdpMid: mid, sdpMLineIndex: index, foundation: parts[0] || null, component: parts[1] === "2" ? "rtcp" : parts[1] ? "rtp" : null,
        priority: parts[3] ? Number(parts[3]) : null, address: parts[4] || null, protocol: parts[2] ? parts[2].toLowerCase() : null, port: parts[5] ? Number(parts[5]) : null,
        type: named.typ || null, tcpType: named.tcptype || null, relatedAddress: named.raddr || null, relatedPort: named.rport ? Number(named.rport) : null,
        usernameFragment: named.ufrag || ufrag || null, relayProtocol: null, url: null,
      };
    };

    var candidateProto = globalThis.RTCIceCandidate && globalThis.RTCIceCandidate.prototype;
    if (candidateProto) {
      patch(candidateProto, "toJSON", function toJSON() {
        var fields = fieldsOf(this);
        if (!fields) throw typeError("Illegal invocation");
        return { candidate: fields.candidate, sdpMid: fields.sdpMid, sdpMLineIndex: fields.sdpMLineIndex, usernameFragment: fields.usernameFragment };
      });
      env.installShell("RTCIceCandidate", function (args) {
        var init = args[0] || {};
        if (init.sdpMid === undefined && init.sdpMLineIndex === undefined || init.sdpMid === null && init.sdpMLineIndex === null) {
          throw typeError("Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null.");
        }
        return instance("RTCIceCandidate", candidateFields(init.candidate === undefined ? "" : String(init.candidate), init.sdpMid === undefined ? null : init.sdpMid,
          init.sdpMLineIndex === undefined ? null : init.sdpMLineIndex, init.usernameFragment));
      }, 0);
    }

    // Host candidate gathering, as Chrome runs it with no ICE servers: "gathering", one mDNS host
    // candidate per media section, then "complete" and the end-of-candidates event.
    var gather = function (connection, state) {
      if (state.gathering || !state.mids) return;
      state.gathering = true;
      var timeline = data.timeline || [];
      var when = function (label, fallback) {
        for (var index = 0; index < timeline.length; index += 1) if (timeline[index][0] === label) return timeline[index][1];
        return fallback;
      };
      var foundation = String(randomInt(100000000, 4294967295));

      env.later(function () {
        if (state.closed) return;
        state.iceGathering = "gathering";
        fire(connection, "icegatheringstatechange");
      }, when("state gathering", 3));

      env.later(function () {
        if (state.closed) return;
        for (var mid = 0; mid < state.mids; mid += 1) {
          var port = randomInt(32768, 60999);
          var line = "candidate:" + foundation + " 1 udp 2113937151 " + mdnsName + " " + port + " typ host generation 0 ufrag " + state.ufrag + " network-cost 999";
          state.candidates.push({ mid: mid, line: "a=candidate:" + foundation + " 1 udp 2113937151 " + mdnsName + " " + port + " typ host generation 0 network-cost 999" });
          fire(connection, "icecandidate", { candidate: instance("RTCIceCandidate", candidateFields(line, String(mid), mid, state.ufrag)), url: null }, "RTCPeerConnectionIceEvent");
        }
      }, when("candidate", 9));

      env.later(function () {
        if (state.closed) return;
        state.iceGathering = "complete";
        fire(connection, "icegatheringstatechange");
        fire(connection, "icecandidate", { candidate: null, url: null }, "RTCPeerConnectionIceEvent");
      }, when("state complete", 120));
    };

    // The local description with what gathering found so far, as Chrome reports it.
    var localNow = function (state) {
      if (!state.local) return null;
      var fields = fieldsOf(state.local);
      if (!state.candidates.length) return state.local;
      var mid = -1;
      var sdp = fields.sdp.split("\r\n").map(function (line) {
        if (/^m=/.test(line)) mid += 1;
        if (/^c=IN IP4/.test(line) && mid >= 0) {
          var found = state.candidates.filter(function (candidate) { return candidate.mid === mid; }).map(function (candidate) { return candidate.line; });
          return [line].concat(found).join("\r\n");
        }
        return line;
      }).join("\r\n");
      return describe(fields.type, sdp);
    };

    var Shell = env.installShell("RTCPeerConnection", function (args) {
      var configuration = args[0];
      if (configuration !== undefined && configuration !== null && typeof configuration !== "object") {
        throw typeError("Failed to construct 'RTCPeerConnection': The provided value is not of type 'RTCConfiguration'.");
      }
      var made = Object.create(connectionProto);
      var fingerprint = [];
      var bytes = randomBytes(32);
      for (var index = 0; index < 32; index += 1) fingerprint.push(hexDigits.charAt(bytes[index] >> 4) + hexDigits.charAt(bytes[index] & 15));
      var session = String(randomInt(1, 9));
      for (var digit = 1; digit < 19; digit += 1) session += String(randomInt(0, 9));
      states.set(made, {
        configuration: configuration || {}, session: session, version: 2, ufrag: pick(ICE, 4), pwd: pick(ICE, 24), fingerprint: fingerprint.join(":"),
        channels: [], audio: false, video: false, signaling: "stable", iceGathering: "new", iceConnection: "new", connection: "new", closed: false,
        local: null, remote: null, candidates: [], mids: 0, gathering: false, negotiation: false,
      });
      return made;
    }, 0);

    if (Shell && globalThis.webkitRTCPeerConnection === Connection) {
      var alias = Object.getOwnPropertyDescriptor(globalThis, "webkitRTCPeerConnection");
      Object.defineProperty(globalThis, "webkitRTCPeerConnection", { value: Shell, writable: true, enumerable: alias ? alias.enumerable : false, configurable: true });
    }

    var reader = function (name, read) {
      patchGetter(connectionProto, name, function () { return read(stateOf(this)); });
    };

    reader("localDescription", function (state) { return localNow(state); });
    reader("currentLocalDescription", function (state) { return state.signaling === "stable" ? localNow(state) : null; });
    reader("pendingLocalDescription", function (state) { return state.signaling === "stable" ? null : localNow(state); });
    reader("remoteDescription", function (state) { return state.remote; });
    reader("currentRemoteDescription", function (state) { return state.signaling === "stable" ? state.remote : null; });
    reader("pendingRemoteDescription", function (state) { return state.signaling === "stable" ? null : state.remote; });
    reader("signalingState", function (state) { return state.signaling; });
    reader("iceGatheringState", function (state) { return state.iceGathering; });
    reader("iceConnectionState", function (state) { return state.iceConnection; });
    reader("connectionState", function (state) { return state.connection; });
    reader("canTrickleIceCandidates", function () { return null; });
    reader("sctp", function () { return null; });

    var closedError = function (method) {
      return domError("Failed to execute '" + method + "' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError");
    };

    var channelDefaults = data.dataChannel || facts.dataChannel || {};
    var channelProto = globalThis.RTCDataChannel && globalThis.RTCDataChannel.prototype;
    var channels = new WeakMap();

    patch(connectionProto, "createDataChannel", function createDataChannel(label, options) {
      required(arguments, 1, "createDataChannel", "RTCPeerConnection");
      var state = stateOf(this);
      if (state.closed) throw closedError("createDataChannel");
      var init = options || {};
      if (init.maxPacketLifeTime !== undefined && init.maxRetransmits !== undefined) {
        throw typeError("Failed to execute 'createDataChannel' on 'RTCPeerConnection': RTCDataChannelInit can not have both maxRetransmits and maxPacketLifeTime");
      }
      var channel = instance("RTCDataChannel", {
        label: String(label), ordered: init.ordered === undefined ? true : Boolean(init.ordered), maxPacketLifeTime: init.maxPacketLifeTime === undefined ? null : Number(init.maxPacketLifeTime),
        maxRetransmits: init.maxRetransmits === undefined ? null : Number(init.maxRetransmits), protocol: init.protocol === undefined ? "" : String(init.protocol),
        negotiated: Boolean(init.negotiated), id: init.negotiated && init.id !== undefined ? Number(init.id) : null, readyState: "connecting", bufferedAmount: 0,
        bufferedAmountLowThreshold: 0, binaryType: channelDefaults.binaryType || "arraybuffer", reliable: init.maxPacketLifeTime === undefined && init.maxRetransmits === undefined,
        onopen: null, onclose: null, onclosing: null, onerror: null, onmessage: null, onbufferedamountlow: null,
      });
      channels.set(channel, this);
      var first = !state.channels.length;
      state.channels.push(channel);
      var connection = this;
      if (first && !init.negotiated) {
        env.later(function () { if (!state.closed) fire(connection, "negotiationneeded"); }, 0);
      }
      return channel;
    });

    if (channelProto) {
      defineAttribute(channelProto, "binaryType", null, function (fields, value) {
        var text = String(value);
        if (text !== "blob" && text !== "arraybuffer") throw domError("Failed to set the 'binaryType' property on 'RTCDataChannel': Unknown binary type : " + text, "SyntaxError");
        fields.binaryType = text;
      });
      defineAttribute(channelProto, "bufferedAmountLowThreshold", null, function (fields, value) { fields.bufferedAmountLowThreshold = Number(value) >>> 0; });
      patch(channelProto, "send", function send() {
        required(arguments, 1, "send", "RTCDataChannel");
        throw domError("Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'", "InvalidStateError");
      });
      patch(channelProto, "close", function close() {
        var fields = fieldsOf(this);
        if (!fields) throw typeError("Illegal invocation");
        if (fields.readyState === "closed" || fields.readyState === "closing") return;
        var channel = this;
        fields.readyState = "closing";
        env.later(function () {
          fields.readyState = "closed";
          fire(channel, "close");
        }, 0);
      });
    }

    patch(connectionProto, "createOffer", promising(function createOffer(options) {
      var state = stateOf(this);
      if (state.closed) throw closedError("createOffer");
      var sdp = offerSdp(state, typeof options === "object" ? options : null);
      return answer(function () { return { sdp: sdp, type: "offer" }; });
    }));

    patch(connectionProto, "createAnswer", promising(function createAnswer() {
      var state = stateOf(this);
      if (state.closed) throw closedError("createAnswer");
      if (state.signaling !== "have-remote-offer") {
        throw domError("Failed to execute 'createAnswer' on 'RTCPeerConnection': PeerConnection cannot create an answer in a state other than have-remote-offer or have-local-pranswer.", "InvalidStateError");
      }
      return answer(function () { return { sdp: offerSdp(state, null), type: "answer" }; });
    }));

    patch(connectionProto, "setLocalDescription", promising(function setLocalDescription(description) {
      var state = stateOf(this);
      var connection = this;
      if (state.closed) throw closedError("setLocalDescription");
      var type = description && description.type !== undefined ? String(description.type) : state.signaling === "have-remote-offer" ? "answer" : "offer";
      var sdp = description && description.sdp ? String(description.sdp) : offerSdp(state, null);
      return answer(function () {
        state.local = describe(type, sdp);
        state.candidates = [];
        setSignaling(connection, state, type === "offer" ? "have-local-offer" : "stable");
        gather(connection, state);
        return undefined;
      });
    }));

    patch(connectionProto, "setRemoteDescription", promising(function setRemoteDescription(description) {
      required(arguments, 1, "setRemoteDescription", "RTCPeerConnection");
      var state = stateOf(this);
      var connection = this;
      if (state.closed) throw closedError("setRemoteDescription");
      var type = description && description.type !== undefined ? String(description.type) : "";
      var sdp = description && description.sdp !== undefined ? String(description.sdp) : "";
      if (!/^v=0/.test(sdp)) {
        return Promise.reject(domError("Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': Failed to parse SessionDescription. " + sdp.split("\n")[0] + " Expect line: v=", "OperationError"));
      }
      return answer(function () {
        state.remote = describe(type, sdp);
        setSignaling(connection, state, type === "offer" ? "have-remote-offer" : "stable");
        return undefined;
      });
    }));

    patch(connectionProto, "addIceCandidate", promising(function addIceCandidate() {
      var state = stateOf(this);
      if (!state.remote) return Promise.reject(domError("Failed to execute 'addIceCandidate' on 'RTCPeerConnection': The remote description was null", "InvalidStateError"));
      return answer(function () { return undefined; });
    }));

    var statsProto = globalThis.RTCStatsReport && globalThis.RTCStatsReport.prototype;
    var reports = new WeakMap();
    if (statsProto) {
      var mapOf = function (report) {
        var held = reports.get(report);
        if (!held) throw typeError("Illegal invocation");
        return held;
      };
      patch(statsProto, "get", function get(key) { return mapOf(this).get(String(key)); });
      patch(statsProto, "has", function has(key) { return mapOf(this).has(String(key)); });
      patch(statsProto, "forEach", function forEach(callback, self) {
        var report = this;
        mapOf(report).forEach(function (value, key) { callback.call(self, value, key, report); });
      });
      patch(statsProto, "keys", function keys() { return mapOf(this).keys(); });
      patch(statsProto, "values", function values() { return mapOf(this).values(); });
      patch(statsProto, "entries", function entries() { return mapOf(this).entries(); });
      patchGetter(statsProto, "size", function () { return mapOf(this).size; });
    }

    patch(connectionProto, "getStats", function getStats() {
      var state = stateOf(this);
      return answer(function () {
        var report = instance("RTCStatsReport", {});
        var held = new Map();
        held.set("P", { id: "P", timestamp: globalThis.performance.timeOrigin + globalThis.performance.now(), type: "peer-connection", dataChannelsClosed: 0, dataChannelsOpened: 0 });
        if (state.closed) held.clear();
        reports.set(report, held);
        return report;
      });
    });

    patch(connectionProto, "getSenders", function getSenders() { stateOf(this); return []; });
    patch(connectionProto, "getReceivers", function getReceivers() { stateOf(this); return []; });
    patch(connectionProto, "getTransceivers", function getTransceivers() { stateOf(this); return []; });

    patch(connectionProto, "getConfiguration", function getConfiguration() {
      var state = stateOf(this);
      var out = copy(traits.webrtc && traits.webrtc.configuration ? traits.webrtc.configuration : {});
      var given = state.configuration;
      ["bundlePolicy", "iceTransportPolicy", "rtcpMuxPolicy", "iceCandidatePoolSize"].forEach(function (key) {
        if (given[key] !== undefined) out[key] = given[key];
      });
      if (given.iceServers !== undefined) out.iceServers = copy(Array.from(given.iceServers));
      return out;
    });

    patch(connectionProto, "setConfiguration", function setConfiguration(configuration) {
      var state = stateOf(this);
      if (state.closed) throw closedError("setConfiguration");
      if (configuration) state.configuration = configuration;
    });

    patch(connectionProto, "restartIce", function restartIce() { stateOf(this); });

    patch(connectionProto, "close", function close() {
      var state = stateOf(this);
      if (state.closed) return;
      state.closed = true;
      state.signaling = "closed";
      state.iceConnection = "closed";
      state.connection = "closed";
      state.channels.forEach(function (channel) {
        var fields = fieldsOf(channel);
        env.later(function () {
          if (fields.readyState === "closed") return;
          fields.readyState = "closed";
          fire(channel, "close");
        }, 0);
      });
    });
  })();

  // ---- Web Audio --------------------------------------------------------------------------------

  (function installAudio() {
    var Base = globalThis.BaseAudioContext;
    var Realtime = globalThis.AudioContext;
    var Offline = globalThis.OfflineAudioContext;
    if (!Base || !Realtime || !Offline) return;

    var realtimeFacts = facts.audioContext || {};
    var durations = traits.durations || {};
    var contexts = new WeakMap();
    var buffers = new WeakMap();
    var FLOAT_MAX = 3.4028234663852886e38;

    var contextOf = function (context) {
      var state = contexts.get(context);
      if (!state) throw typeError("Illegal invocation");
      return state;
    };

    var fire = function (target, type, fields, iface) {
      env.dispatch(target, env.makeEvent(type, fields, iface));
    };

    // ---- AudioParam

    var paramProto = globalThis.AudioParam && globalThis.AudioParam.prototype;

    var makeParam = function (value, min, max, rate) {
      var param = instance("AudioParam", { value: Math.fround(value), defaultValue: Math.fround(value), minValue: Math.fround(min), maxValue: Math.fround(max), automationRate: rate || "a-rate", events: [] });
      return param;
    };

    if (paramProto) {
      defineAttribute(paramProto, "value", null, function (fields, value) {
        var number = Number(value);
        if (!isFinite(number)) throw typeError("Failed to set the 'value' property on 'AudioParam': The provided float value is non-finite.");
        fields.value = Math.fround(Math.min(Math.max(number, fields.minValue), fields.maxValue));
      });
      ["defaultValue", "minValue", "maxValue"].forEach(function (name) { defineAttribute(paramProto, name, null, false); });
      defineAttribute(paramProto, "automationRate", null, function (fields, value) {
        fields.automationRate = enumOf(value, ["a-rate", "k-rate"], "Failed to set the 'automationRate' property on 'AudioParam': ", "AutomationRate");
      });

      var timed = function (method, count, check) {
        patch(paramProto, method, function () {
          var fields = fieldsOf(this);
          if (!fields) throw typeError("Illegal invocation");
          required(arguments, count, method, "AudioParam");
          for (var index = 0; index < count; index += 1) {
            if (!isFinite(Number(arguments[index]))) throw typeError("Failed to execute '" + method + "' on 'AudioParam': The provided float value is non-finite.");
          }
          if (check) check.apply(null, arguments);
          fields.events.push([method].concat(Array.prototype.slice.call(arguments)));
          return this;
        });
      };
      var nonNegative = function (method, at) {
        return function () {
          var time = Number(arguments[at]);
          if (time < 0) throw domError("Failed to execute '" + method + "' on 'AudioParam': Time must be a finite non-negative number: " + time, "RangeError");
        };
      };
      timed("setValueAtTime", 2, nonNegative("setValueAtTime", 1));
      timed("linearRampToValueAtTime", 2, nonNegative("linearRampToValueAtTime", 1));
      timed("exponentialRampToValueAtTime", 2, function (value, time) {
        if (Number(value) === 0) throw domError("Failed to execute 'exponentialRampToValueAtTime' on 'AudioParam': The float target value provided (0) should not be in the range (-1.40130e-45, 1.40130e-45).", "RangeError");
        nonNegative("exponentialRampToValueAtTime", 1)(value, time);
      });
      timed("setTargetAtTime", 3, nonNegative("setTargetAtTime", 1));
      timed("cancelScheduledValues", 1, nonNegative("cancelScheduledValues", 0));
      timed("cancelAndHoldAtTime", 1, nonNegative("cancelAndHoldAtTime", 0));
      patch(paramProto, "setValueCurveAtTime", function setValueCurveAtTime(values, time, duration) {
        var fields = fieldsOf(this);
        if (!fields) throw typeError("Illegal invocation");
        required(arguments, 3, "setValueCurveAtTime", "AudioParam");
        fields.events.push(["setValueCurveAtTime", Array.from(values), time, duration]);
        return this;
      });
    }

    // ---- AudioBuffer

    var makeBuffer = function (channels, length, rate) {
      var buffer = instance("AudioBuffer", { numberOfChannels: channels, length: length, sampleRate: rate, duration: length / rate });
      var data = [];
      for (var index = 0; index < channels; index += 1) data.push(new Float32Array(length));
      buffers.set(buffer, data);
      return buffer;
    };

    var checkBuffer = function (where, channels, length, rate) {
      if (!(channels >= 1 && channels <= 32)) throw domError(where + "The number of channels provided (" + channels + ") is outside the range [1, 32].", "NotSupportedError");
      if (!(length >= 1)) throw domError(where + "The number of frames provided (" + length + ") is less than the minimum bound (1).", "NotSupportedError");
      if (!(rate >= 3000 && rate <= 768000)) throw domError(where + "The sampleRate provided (" + rate + ") is outside the range [3000, 768000].", "NotSupportedError");
    };

    var bufferProto = globalThis.AudioBuffer && globalThis.AudioBuffer.prototype;
    if (bufferProto) {
      var channelsOf = function (buffer, method) {
        var held = buffers.get(buffer);
        if (!held) throw typeError("Illegal invocation");
        return held;
      };
      var channelIndex = function (held, index, method) {
        var at = Number(index) >>> 0;
        if (at >= held.length) throw domError("Failed to execute '" + method + "' on 'AudioBuffer': channel index (" + at + ") exceeds number of channels (" + held.length + ")", "IndexSizeError");
        return at;
      };
      patch(bufferProto, "getChannelData", function getChannelData(index) {
        required(arguments, 1, "getChannelData", "AudioBuffer");
        var held = channelsOf(this);
        return held[channelIndex(held, index, "getChannelData")];
      });
      patch(bufferProto, "copyFromChannel", function copyFromChannel(destination, index, start) {
        required(arguments, 2, "copyFromChannel", "AudioBuffer");
        var held = channelsOf(this);
        var source = held[channelIndex(held, index, "copyFromChannel")];
        var from = Number(start) >>> 0;
        destination.set(source.subarray(from, from + destination.length));
      });
      patch(bufferProto, "copyToChannel", function copyToChannel(source, index, start) {
        required(arguments, 2, "copyToChannel", "AudioBuffer");
        var held = channelsOf(this);
        var target = held[channelIndex(held, index, "copyToChannel")];
        var from = Number(start) >>> 0;
        target.set(source.subarray(0, Math.max(0, target.length - from)), from);
      });
      env.installShell("AudioBuffer", function (args) {
        var options = args[0];
        var where = "Failed to construct 'AudioBuffer': ";
        if (options === null || typeof options !== "object") throw typeError(where + "The provided value is not of type 'AudioBufferOptions'.");
        if (options.length === undefined) throw typeError(where + "Failed to read the 'length' property from 'AudioBufferOptions': Required member is undefined.");
        if (options.sampleRate === undefined) throw typeError(where + "Failed to read the 'sampleRate' property from 'AudioBufferOptions': Required member is undefined.");
        var channels = options.numberOfChannels === undefined ? 1 : Number(options.numberOfChannels);
        checkBuffer(where, channels, Number(options.length), Number(options.sampleRate));
        return makeBuffer(channels, Number(options.length), Number(options.sampleRate));
      }, 1, { required: 1 });
    }

    // ---- Nodes

    var nodeProto = globalThis.AudioNode && globalThis.AudioNode.prototype;
    var graphs = new WeakMap();

    // What each node kind is born with: inputs, outputs, channel handling, its params as
    // [default, min, max] (a function of the sample rate where Chrome's bound is the Nyquist
    // frequency), and its other attributes.
    var KINDS = {
      OscillatorNode: { inputs: 0, outputs: 1, count: 2, mode: "max", params: { frequency: function (n) { return [440, -n, n]; }, detune: [0, -153600, 153600] }, fields: { type: "sine", onended: null }, source: true },
      GainNode: { inputs: 1, outputs: 1, count: 2, mode: "max", params: { gain: [1, -FLOAT_MAX, FLOAT_MAX] } },
      DynamicsCompressorNode: { inputs: 1, outputs: 1, count: 2, mode: "clamped-max", params: { threshold: [-24, -100, 0], knee: [30, 0, 40], ratio: [12, 1, 20], attack: [0.003, 0, 1], release: [0.25, 0, 1] }, fields: { reduction: 0 } },
      AnalyserNode: { inputs: 1, outputs: 1, count: 2, mode: "max", fields: { fftSize: 2048, frequencyBinCount: 1024, minDecibels: -100, maxDecibels: -30, smoothingTimeConstant: 0.8 } },
      BiquadFilterNode: { inputs: 1, outputs: 1, count: 2, mode: "max", params: { frequency: function (n) { return [350, 0, n]; }, detune: [0, -153600, 153600], Q: [1, -FLOAT_MAX, FLOAT_MAX], gain: [0, -FLOAT_MAX, 1541.273681640625] }, fields: { type: "lowpass" } },
      AudioBufferSourceNode: { inputs: 0, outputs: 1, count: 2, mode: "max", params: { playbackRate: [1, -FLOAT_MAX, FLOAT_MAX], detune: [0, -FLOAT_MAX, FLOAT_MAX] }, fields: { buffer: null, loop: false, loopStart: 0, loopEnd: 0, onended: null }, source: true },
      ConstantSourceNode: { inputs: 0, outputs: 1, count: 2, mode: "max", params: { offset: [1, -FLOAT_MAX, FLOAT_MAX] }, fields: { onended: null }, source: true },
      StereoPannerNode: { inputs: 1, outputs: 1, count: 2, mode: "clamped-max", params: { pan: [0, -1, 1] } },
      DelayNode: { inputs: 1, outputs: 1, count: 2, mode: "max", params: { delayTime: [0, 0, 1] } },
      WaveShaperNode: { inputs: 1, outputs: 1, count: 2, mode: "max", fields: { curve: null, oversample: "none" } },
      ConvolverNode: { inputs: 1, outputs: 1, count: 2, mode: "clamped-max", fields: { buffer: null, normalize: true } },
      ChannelMergerNode: { inputs: 6, outputs: 1, count: 1, mode: "explicit" },
      ChannelSplitterNode: { inputs: 1, outputs: 6, count: 6, mode: "explicit", interpretation: "discrete" },
      ScriptProcessorNode: { inputs: 1, outputs: 1, count: 2, mode: "explicit", fields: { bufferSize: 4096, onaudioprocess: null } },
      PannerNode: { inputs: 1, outputs: 1, count: 2, mode: "clamped-max", params: { positionX: [0, -FLOAT_MAX, FLOAT_MAX], positionY: [0, -FLOAT_MAX, FLOAT_MAX], positionZ: [0, -FLOAT_MAX, FLOAT_MAX], orientationX: [1, -FLOAT_MAX, FLOAT_MAX], orientationY: [0, -FLOAT_MAX, FLOAT_MAX], orientationZ: [0, -FLOAT_MAX, FLOAT_MAX] },
        fields: { panningModel: "equalpower", distanceModel: "inverse", refDistance: 1, maxDistance: 10000, rolloffFactor: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 } },
      MediaElementAudioSourceNode: { inputs: 0, outputs: 1, count: 2, mode: "max", fields: { mediaElement: null } },
      MediaStreamAudioSourceNode: { inputs: 0, outputs: 1, count: 2, mode: "max", fields: { mediaStream: null } },
      MediaStreamAudioDestinationNode: { inputs: 1, outputs: 0, count: 2, mode: "explicit", fields: { stream: null } },
      IIRFilterNode: { inputs: 1, outputs: 1, count: 2, mode: "max" },
    };

    var makeNode = function (context, kind, extra) {
      var spec = KINDS[kind];
      var state = contextOf(context);
      var fields = { context: context, numberOfInputs: spec.inputs, numberOfOutputs: spec.outputs, channelCount: spec.count, channelCountMode: spec.mode, channelInterpretation: spec.interpretation || "speakers" };
      var params = spec.params || {};
      Object.keys(params).forEach(function (name) {
        var range = typeof params[name] === "function" ? params[name](state.sampleRate / 2) : params[name];
        fields[name] = makeParam(range[0], range[1], range[2], kind === "DynamicsCompressorNode" ? "k-rate" : "a-rate");
      });
      var own = spec.fields || {};
      Object.keys(own).forEach(function (name) { fields[name] = own[name]; });
      for (var key in extra || {}) fields[key] = extra[key];
      var node = instance(kind, fields);
      graphs.set(node, { kind: kind, outputs: [], started: false, stopped: false });
      return node;
    };

    var graphOf = function (node) {
      var held = graphs.get(node);
      if (!held) throw typeError("Illegal invocation");
      return held;
    };

    if (nodeProto) {
      ["context", "numberOfInputs", "numberOfOutputs"].forEach(function (name) { defineAttribute(nodeProto, name, null, false); });
      defineAttribute(nodeProto, "channelCount", null, function (fields, value) {
        var count = Number(value) >>> 0;
        if (count < 1 || count > 32) throw domError("Failed to set the 'channelCount' property on 'AudioNode': The channel count provided (" + count + ") is outside the range [1, 32].", "NotSupportedError");
        fields.channelCount = count;
      });
      defineAttribute(nodeProto, "channelCountMode", null, function (fields, value) {
        fields.channelCountMode = enumOf(value, ["max", "clamped-max", "explicit"], "Failed to set the 'channelCountMode' property on 'AudioNode': ", "ChannelCountMode");
      });
      defineAttribute(nodeProto, "channelInterpretation", null, function (fields, value) {
        fields.channelInterpretation = enumOf(value, ["speakers", "discrete"], "Failed to set the 'channelInterpretation' property on 'AudioNode': ", "ChannelInterpretation");
      });

      patch(nodeProto, "connect", function connect(destination) {
        required(arguments, 1, "connect", "AudioNode");
        var held = graphOf(this);
        var toNode = destination !== null && typeof destination === "object" && graphs.has(destination);
        var toParam = destination !== null && typeof destination === "object" && paramProto && destination instanceof globalThis.AudioParam;
        if (!toNode && !toParam) throw typeError("Failed to execute 'connect' on 'AudioNode': Overload resolution failed.");
        if (toNode && fieldsOf(destination).context !== fieldsOf(this).context) {
          throw domError("Failed to execute 'connect' on 'AudioNode': cannot connect to an AudioNode belonging to a different audio context.", "InvalidAccessError");
        }
        if (toNode && !fieldsOf(destination).numberOfInputs) {
          throw domError("Failed to execute 'connect' on 'AudioNode': input index (0) exceeds number of inputs (0).", "IndexSizeError");
        }
        if (held.outputs.indexOf(destination) === -1) held.outputs.push(destination);
        return toNode ? destination : undefined;
      });
      patch(nodeProto, "disconnect", function disconnect(destination) {
        var held = graphOf(this);
        if (destination === undefined) held.outputs = [];
        else {
          var at = held.outputs.indexOf(destination);
          if (at === -1) throw domError("Failed to execute 'disconnect' on 'AudioNode': the given destination is not connected.", "InvalidAccessError");
          held.outputs.splice(at, 1);
        }
      });
    }

    var defineKind = function (kind) {
      var holder = globalThis[kind];
      var proto = holder && holder.prototype;
      if (!proto) return;
      var spec = KINDS[kind];
      Object.keys(spec.params || {}).forEach(function (name) { defineAttribute(proto, name, null, false); });
      Object.keys(spec.fields || {}).forEach(function (name) {
        if (/^on/.test(name)) return;
        defineAttribute(proto, name, null, name === "reduction" || name === "frequencyBinCount" || name === "bufferSize" || name === "stream" || name === "mediaElement" || name === "mediaStream" ? false : null);
      });
    };

    Object.keys(KINDS).forEach(defineKind);

    var oscillatorProto = globalThis.OscillatorNode && globalThis.OscillatorNode.prototype;
    if (oscillatorProto) {
      defineAttribute(oscillatorProto, "type", null, function (fields, value) {
        var kind = enumOf(value, ["sine", "square", "sawtooth", "triangle", "custom"], "Failed to set the 'type' property on 'OscillatorNode': ", "OscillatorType");
        if (kind === "custom") throw domError("Failed to set the 'type' property on 'OscillatorNode': 'type' cannot be set directly to 'custom'.  Use setPeriodicWave() to create a custom Oscillator type.", "InvalidStateError");
        fields.type = kind;
      });
      patch(oscillatorProto, "setPeriodicWave", function setPeriodicWave() { fieldsOf(this).type = "custom"; });
    }

    var analyserProto = globalThis.AnalyserNode && globalThis.AnalyserNode.prototype;
    if (analyserProto) {
      defineAttribute(analyserProto, "fftSize", null, function (fields, value) {
        var size = Number(value) >>> 0;
        if (size < 32 || size > 32768 || (size & (size - 1))) {
          throw domError("Failed to set the 'fftSize' property on 'AnalyserNode': The value provided (" + size + ") is not a power of two" + (size < 32 || size > 32768 ? " or is outside the range [32, 32768]." : "."), "IndexSizeError");
        }
        fields.fftSize = size;
        fields.frequencyBinCount = size / 2;
      });
      var silent = function (fill) {
        return function (array) {
          required(arguments, 1, this === undefined ? "" : "get", "AnalyserNode");
          for (var index = 0; index < array.length; index += 1) array[index] = fill(fieldsOf(this));
        };
      };
      patch(analyserProto, "getFloatFrequencyData", silent(function () { return -Infinity; }));
      patch(analyserProto, "getByteFrequencyData", silent(function () { return 0; }));
      patch(analyserProto, "getFloatTimeDomainData", silent(function () { return 0; }));
      patch(analyserProto, "getByteTimeDomainData", silent(function () { return 128; }));
    }

    var scheduledProto = globalThis.AudioScheduledSourceNode && globalThis.AudioScheduledSourceNode.prototype;
    if (scheduledProto) {
      patch(scheduledProto, "start", function start(when) {
        var held = graphOf(this);
        if (held.started) throw domError("Failed to execute 'start' on 'AudioScheduledSourceNode': cannot call start more than once.", "InvalidStateError");
        if (Number(when) < 0) throw domError("Failed to execute 'start' on 'AudioScheduledSourceNode': The start time provided (" + Number(when) + ") is less than the minimum bound (0).", "RangeError");
        held.started = true;
      });
      patch(scheduledProto, "stop", function stop() {
        var held = graphOf(this);
        if (!held.started) throw domError("Failed to execute 'stop' on 'AudioScheduledSourceNode': cannot call stop without calling start first.", "InvalidStateError");
        held.stopped = true;
      });
    }

    var bufferSourceProto = globalThis.AudioBufferSourceNode && globalThis.AudioBufferSourceNode.prototype;
    if (bufferSourceProto) {
      defineAttribute(bufferSourceProto, "buffer", null, function (fields, value) {
        if (value !== null && !buffers.has(value)) throw typeError("Failed to set the 'buffer' property on 'AudioBufferSourceNode': The provided value is not of type 'AudioBuffer'.");
        if (fields.buffer && value !== null) throw domError("Failed to set the 'buffer' property on 'AudioBufferSourceNode': Cannot set buffer to non-null after it has been already been set to a non-null buffer", "InvalidStateError");
        fields.buffer = value;
      });
    }

    // ---- Contexts

    var makeContext = function (proto, offline, channels, length, rate) {
      var context = Object.create(proto);
      var state = { offline: offline, sampleRate: rate, length: length, channels: channels, state: "suspended", rendering: null, worklet: null, sources: [] };
      contexts.set(context, state);
      state.destination = makeDestination(context, offline ? channels : realtimeFacts.maxChannelCount || 2, offline ? channels : realtimeFacts.channelCount || 2);
      var listener = instance("AudioListener", {});
      var listenerFields = fieldsOf(listener);
      [["positionX", 0], ["positionY", 0], ["positionZ", 0], ["forwardX", 0], ["forwardY", 0], ["forwardZ", -1], ["upX", 0], ["upY", 1], ["upZ", 0]].forEach(function (pair) {
        listenerFields[pair[0]] = makeParam(pair[1], -FLOAT_MAX, FLOAT_MAX);
      });
      state.listener = listener;
      return context;
    };

    var makeDestination = function (context, max, count) {
      var fields = { context: context, numberOfInputs: 1, numberOfOutputs: 0, channelCount: count, channelCountMode: "explicit", channelInterpretation: "speakers", maxChannelCount: max };
      var node = instance("AudioDestinationNode", fields);
      graphs.set(node, { kind: "AudioDestinationNode", outputs: [], started: false, stopped: false });
      return node;
    };

    var destinationProto = globalThis.AudioDestinationNode && globalThis.AudioDestinationNode.prototype;
    if (destinationProto) defineAttribute(destinationProto, "maxChannelCount", null, false);
    var listenerProto = globalThis.AudioListener && globalThis.AudioListener.prototype;
    if (listenerProto) {
      ["positionX", "positionY", "positionZ", "forwardX", "forwardY", "forwardZ", "upX", "upY", "upZ"].forEach(function (name) { defineAttribute(listenerProto, name, null, false); });
      patch(listenerProto, "setPosition", function setPosition() {});
      patch(listenerProto, "setOrientation", function setOrientation() {});
    }

    var baseProto = Base.prototype;
    var base = function (name, read) { patchGetter(baseProto, name, function () { return read(contextOf(this), this); }); };

    base("destination", function (state) { return state.destination; });
    base("sampleRate", function (state) { return state.sampleRate; });
    base("listener", function (state) { return state.listener; });
    base("state", function (state) { return state.state; });
    base("currentTime", function (state) {
      if (state.offline) return state.state === "closed" ? state.length / state.sampleRate : 0;
      return 0;
    });
    base("audioWorklet", function (state) {
      if (!state.worklet) state.worklet = instance("AudioWorklet", {});
      return state.worklet;
    });

    var workletProto = globalThis.Worklet && globalThis.Worklet.prototype;
    if (workletProto) {
      patch(workletProto, "addModule", promising(function addModule(url) {
        required(arguments, 1, "addModule", "Worklet");
        var target = new globalThis.URL(String(url), globalThis.location.href);
        return answer(function () {
          if (!/^(https?|data|blob):$/.test(target.protocol)) throw domError("Failed to execute 'addModule' on 'Worklet': Unable to load a worklet's module.", "AbortError");
          return undefined;
        });
      }));
    }

    var factory = function (method, kind, extra) {
      patch(baseProto, method, function () {
        var state = contextOf(this);
        return makeNode(this, kind, extra ? extra.apply(null, [state].concat(Array.prototype.slice.call(arguments))) : null);
      });
    };

    factory("createOscillator", "OscillatorNode");
    factory("createGain", "GainNode");
    factory("createDynamicsCompressor", "DynamicsCompressorNode");
    factory("createAnalyser", "AnalyserNode");
    factory("createBiquadFilter", "BiquadFilterNode");
    factory("createBufferSource", "AudioBufferSourceNode");
    factory("createConstantSource", "ConstantSourceNode");
    factory("createStereoPanner", "StereoPannerNode");
    factory("createWaveShaper", "WaveShaperNode");
    factory("createConvolver", "ConvolverNode");
    factory("createPanner", "PannerNode");
    factory("createDelay", "DelayNode", function (state, max) {
      var limit = max === undefined ? 1 : Number(max);
      if (!(limit > 0 && limit < 180)) throw domError("Failed to execute 'createDelay' on 'BaseAudioContext': The max delay time provided (" + limit + ") is outside the range (0, 180).", "NotSupportedError");
      return { delayTime: makeParam(0, 0, limit) };
    });
    factory("createChannelMerger", "ChannelMergerNode", function (state, inputs) {
      var count = inputs === undefined ? 6 : Number(inputs);
      if (!(count >= 1 && count <= 32)) throw domError("Failed to execute 'createChannelMerger' on 'BaseAudioContext': The number of inputs provided (" + count + ") is outside the range [1, 32].", "IndexSizeError");
      return { numberOfInputs: count };
    });
    factory("createChannelSplitter", "ChannelSplitterNode", function (state, outputs) {
      var count = outputs === undefined ? 6 : Number(outputs);
      if (!(count >= 1 && count <= 32)) throw domError("Failed to execute 'createChannelSplitter' on 'BaseAudioContext': The number of outputs provided (" + count + ") is outside the range [1, 32].", "IndexSizeError");
      return { numberOfOutputs: count, channelCount: count };
    });
    factory("createScriptProcessor", "ScriptProcessorNode", function (state, size, inputs, outputs) {
      var buffer = size === undefined || Number(size) === 0 ? 2048 : Number(size);
      if ([256, 512, 1024, 2048, 4096, 8192, 16384].indexOf(buffer) === -1) {
        throw domError("Failed to execute 'createScriptProcessor' on 'BaseAudioContext': buffer size (" + buffer + ") must be 0 or a power of two between 256 and 16384.", "IndexSizeError");
      }
      return { bufferSize: buffer, numberOfInputs: 1, numberOfOutputs: 1, channelCount: inputs === undefined ? 2 : Number(inputs) };
    });
    factory("createIIRFilter", "IIRFilterNode");

    patch(baseProto, "createBuffer", function createBuffer(channels, length, rate) {
      required(arguments, 3, "createBuffer", "BaseAudioContext");
      contextOf(this);
      checkBuffer("Failed to execute 'createBuffer' on 'BaseAudioContext': ", Number(channels), Number(length), Number(rate));
      return makeBuffer(Number(channels), Number(length), Number(rate));
    });

    patch(baseProto, "createPeriodicWave", function createPeriodicWave(real, imag) {
      required(arguments, 2, "createPeriodicWave", "BaseAudioContext");
      contextOf(this);
      if (real.length !== imag.length) throw domError("Failed to execute 'createPeriodicWave' on 'BaseAudioContext': length of real array (" + real.length + ") and length of imaginary array (" + imag.length + ") must match.", "IndexSizeError");
      return instance("PeriodicWave", {});
    });

    // Decoding: a WAVE file of PCM samples decodes; anything else is Chrome's EncodingError.
    var decodeWave = function (bytes, rate) {
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var text = function (at) { return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]); };
      if (bytes.length < 44 || text(0) !== "RIFF" || text(8) !== "WAVE") return null;
      var at = 12;
      var format = null;
      while (at + 8 <= bytes.length) {
        var id = text(at);
        var size = view.getUint32(at + 4, true);
        if (id === "fmt ") format = { tag: view.getUint16(at + 8, true), channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
        if (id === "data" && format && format.tag === 1 && (format.bits === 16 || format.bits === 8)) {
          var width = format.bits / 8;
          var frames = Math.floor(Math.min(size, bytes.length - at - 8) / (width * format.channels));
          if (!frames || !format.channels) return null;
          var out = makeBuffer(format.channels, Math.round(frames * rate / format.rate), rate);
          var data = buffers.get(out);
          for (var channel = 0; channel < format.channels; channel += 1) {
            for (var frame = 0; frame < data[channel].length; frame += 1) {
              var source = Math.min(frames - 1, Math.floor(frame * format.rate / rate));
              var offset = at + 8 + (source * format.channels + channel) * width;
              data[channel][frame] = width === 2 ? view.getInt16(offset, true) / 32768 : (bytes[offset] - 128) / 128;
            }
          }
          return out;
        }
        at += 8 + size + (size & 1);
      }
      return null;
    };

    patch(baseProto, "decodeAudioData", function decodeAudioData(audio, success, failure) {
      if (arguments.length < 1) return Promise.reject(typeError("Failed to execute 'decodeAudioData' on 'BaseAudioContext': 1 argument required, but only 0 present."));
      var state = contextOf(this);
      if (!(audio instanceof ArrayBuffer)) return Promise.reject(typeError("Failed to execute 'decodeAudioData' on 'BaseAudioContext': parameter 1 is not of type 'ArrayBuffer'."));
      var bytes = new Uint8Array(audio.slice(0));
      return new Promise(function (resolve, reject) {
        env.later(function () {
          var decoded = decodeWave(bytes, state.sampleRate);
          if (decoded) {
            if (typeof success === "function") success(decoded);
            resolve(decoded);
            return;
          }
          var error = domError("Unable to decode audio data", "EncodingError");
          if (typeof failure === "function") failure(error);
          reject(error);
        }, 0);
      });
    });

    // ---- Rendering

    var recordedSamples = null;
    var recordedChannel = function () {
      if (recordedSamples) return recordedSamples;
      if (!traits.audio || !traits.audio.channel) return null;
      var binary = globalThis.atob(traits.audio.channel);
      var bytes = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      recordedSamples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      return recordedSamples;
    };

    // The started sources whose output reaches the destination.
    var audibleSources = function (destination, context) {
      var found = [];
      var reaches = function (node, seen) {
        if (node === destination) return true;
        if (seen.indexOf(node) !== -1 || !graphs.has(node)) return false;
        seen.push(node);
        return graphs.get(node).outputs.some(function (next) { return reaches(next, seen); });
      };
      var visit = function (node) {
        var held = graphs.get(node);
        if (held && KINDS[held.kind] && KINDS[held.kind].source && held.started && reaches(node, [])) found.push(node);
      };
      // Every node made in this context is reachable through the graph table only by walking it,
      // so the context keeps its sources as they are made (see makeNode's caller below).
      contextOf(context).sources.forEach(visit);
      return found;
    };

    var synthesise = function (target, source, rate) {
      var fields = fieldsOf(source);
      var held = graphs.get(source);
      if (held.kind === "OscillatorNode") {
        var frequency = fields.frequency ? fieldsOf(fields.frequency).value : 440;
        fieldsOf(fields.frequency).events.forEach(function (event) { if (event[0] === "setValueAtTime" && Number(event[2]) === 0) frequency = Number(event[1]); });
        for (var index = 0; index < target.length; index += 1) {
          var phase = (index * frequency / rate) % 1;
          var value = fields.type === "square" ? (phase < 0.5 ? 1 : -1) : fields.type === "sawtooth" ? 2 * phase - 1 : fields.type === "triangle" ? 1 - 4 * Math.abs(Math.round(phase - 0.25) - (phase - 0.25)) : Math.sin(2 * Math.PI * phase);
          target[index] += value;
        }
      } else if (held.kind === "ConstantSourceNode") {
        var offset = fieldsOf(fields.offset).value;
        for (var at = 0; at < target.length; at += 1) target[at] += offset;
      } else if (held.kind === "AudioBufferSourceNode" && fields.buffer) {
        var data = buffers.get(fields.buffer)[0];
        for (var frame = 0; frame < target.length && frame < data.length; frame += 1) target[frame] += data[frame];
      }
    };

    // What an offline render produces: silence unless a started source reaches the destination;
    // the oscillator fingerprint the capture recorded (Chrome's own samples at its sample rate,
    // cut to the requested length, its steady tail repeated past the recording) when an
    // oscillator does; otherwise the sources' plain waveforms.
    var render = function (context, state) {
      var out = makeBuffer(state.channels, state.length, state.sampleRate);
      var channels = buffers.get(out);
      var sources = audibleSources(state.destination, context);
      if (!sources.length) return out;
      var recorded = recordedChannel();
      var recordedRate = traits.audio ? traits.audio.sampleRate : null;
      var oscillator = sources.some(function (source) { return graphs.get(source).kind === "OscillatorNode"; });
      var first = channels[0];

      if (oscillator && recorded && recordedRate === state.sampleRate) {
        var period = 441;
        for (var index = 0; index < first.length; index += 1) {
          first[index] = index < recorded.length ? recorded[index] : recorded[recorded.length - period + ((index - recorded.length) % period)];
        }
      } else {
        sources.forEach(function (source) { synthesise(first, source, state.sampleRate); });
      }

      for (var channel = 1; channel < channels.length; channel += 1) channels[channel].set(first);
      return out;
    };

    var setState = function (context, state, value) {
      if (state.state === value) return;
      state.state = value;
      fire(context, "statechange");
    };

    var offlineProto = Offline.prototype;
    patchGetter(offlineProto, "length", function () { return contextOf(this).length; });

    patch(offlineProto, "startRendering", function startRendering() {
      var state = contextOf(this);
      var context = this;
      if (state.rendering || state.state === "closed") {
        return Promise.reject(domError("Failed to execute 'startRendering' on 'OfflineAudioContext': " + (state.state === "closed" ? "cannot call startRendering on an OfflineAudioContext in a stopped state." : "cannot startRendering when an OfflineAudioContext is running"), "InvalidStateError"));
      }
      state.rendering = true;
      state.state = "running";
      env.later(function () { fire(context, "statechange"); }, 0);
      return new Promise(function (resolve) {
        env.later(function () {
          env.spend(durations.audio || 0);
          var rendered = render(context, state);
          setState(context, state, "closed");
          fire(context, "complete", { renderedBuffer: rendered }, "OfflineAudioCompletionEvent");
          resolve(rendered);
        }, Math.max(1, Math.round((durations.audio || 6) * state.length / 44100)));
      });
    });

    patch(offlineProto, "suspend", promising(function suspend(when) {
      required(arguments, 1, "suspend", "OfflineAudioContext");
      contextOf(this);
      return answer(function () { return undefined; });
    }));
    patch(offlineProto, "resume", function resume() {
      var state = contextOf(this);
      if (!state.rendering) return Promise.reject(domError("Failed to execute 'resume' on 'OfflineAudioContext': cannot resume an offline context that has not started", "InvalidStateError"));
      return answer(function () { return undefined; });
    });

    var realtimeProto = Realtime.prototype;
    var realtime = function (name, read) { patchGetter(realtimeProto, name, function () { return read(contextOf(this)); }); };
    realtime("baseLatency", function () { return realtimeFacts.baseLatency; });
    realtime("outputLatency", function () { return 0; });
    if ("sinkId" in realtimeProto) realtime("sinkId", function () { return realtimeFacts.sinkId === undefined ? "" : realtimeFacts.sinkId; });

    // With no user gesture the page's audio stays suspended: resume() waits for one that never
    // comes, as Chrome's autoplay policy holds it.
    patch(realtimeProto, "resume", function resume() {
      var state = contextOf(this);
      if (state.state === "closed") return Promise.reject(domError("Failed to execute 'resume' on 'AudioContext': Cannot resume a closed AudioContext.", "InvalidStateError"));
      return new Promise(function () {});
    });
    patch(realtimeProto, "suspend", function suspend() {
      var state = contextOf(this);
      if (state.state === "closed") return Promise.reject(domError("Failed to execute 'suspend' on 'AudioContext': Cannot suspend a closed AudioContext.", "InvalidStateError"));
      return answer(function () { return undefined; });
    });
    patch(realtimeProto, "close", function close() {
      var state = contextOf(this);
      var context = this;
      if (state.state === "closed") return Promise.reject(domError("Failed to execute 'close' on 'AudioContext': Cannot close a closed AudioContext.", "InvalidStateError"));
      return answer(function () {
        state.state = "closed";
        env.later(function () { fire(context, "statechange"); }, 0);
        return undefined;
      });
    });
    patch(realtimeProto, "getOutputTimestamp", function getOutputTimestamp() {
      contextOf(this);
      return { contextTime: 0, performanceTime: 0 };
    });
    ["createMediaElementSource:MediaElementAudioSourceNode:mediaElement", "createMediaStreamSource:MediaStreamAudioSourceNode:mediaStream"].forEach(function (triple) {
      var parts = triple.split(":");
      if (typeof realtimeProto[parts[0]] !== "function") return;
      patch(realtimeProto, parts[0], function (input) {
        required(arguments, 1, parts[0], "AudioContext");
        var extra = {};
        extra[parts[2]] = input;
        return makeNode(this, parts[1], extra);
      });
    });
    if (typeof realtimeProto.createMediaStreamDestination === "function") {
      patch(realtimeProto, "createMediaStreamDestination", function createMediaStreamDestination() {
        return makeNode(this, "MediaStreamAudioDestinationNode", { stream: globalThis.MediaStream ? new globalThis.MediaStream() : null });
      });
    }

    // Sources are remembered per context, to find what reaches the destination at render time.
    var made = makeNode;
    makeNode = function (context, kind, extra) {
      var node = made(context, kind, extra);
      if (KINDS[kind].source) contextOf(context).sources.push(node);
      return node;
    };

    env.installShell("AudioContext", function (args) {
      var options = args[0] === undefined ? {} : args[0];
      if (options === null || typeof options !== "object") throw typeError("Failed to construct 'AudioContext': The provided value is not of type 'AudioContextOptions'.");
      var rate = options.sampleRate === undefined ? realtimeFacts.sampleRate || 48000 : Number(options.sampleRate);
      if (!(rate >= 3000 && rate <= 768000)) throw domError("Failed to construct 'AudioContext': The hardware sample rate provided (" + rate + ") is outside the range [3000, 768000].", "NotSupportedError");
      return makeContext(realtimeProto, false, 2, 0, rate);
    }, 0);

    env.installShell("OfflineAudioContext", function (args) {
      var where = "Failed to construct 'OfflineAudioContext': ";
      var channels;
      var length;
      var rate;
      if (args.length === 1 && args[0] !== null && typeof args[0] === "object") {
        var options = args[0];
        if (options.length === undefined) throw typeError(where + "Failed to read the 'length' property from 'OfflineAudioContextOptions': Required member is undefined.");
        if (options.sampleRate === undefined) throw typeError(where + "Failed to read the 'sampleRate' property from 'OfflineAudioContextOptions': Required member is undefined.");
        channels = options.numberOfChannels === undefined ? 1 : Number(options.numberOfChannels);
        length = Number(options.length);
        rate = Number(options.sampleRate);
      } else {
        if (args.length === 0) throw typeError(where + "1 argument required, but only 0 present.");
        if (args.length < 3) throw typeError(where + "3 arguments required, but only " + args.length + " present.");
        channels = Number(args[0]);
        length = Number(args[1]);
        rate = Number(args[2]);
      }
      channels = Math.trunc(channels) || 0;
      length = Math.trunc(length) || 0;
      checkBuffer(where, channels, length, rate);
      return makeContext(offlineProto, true, channels, length, rate);
    }, 1, { required: 0 });

    // The node constructors (new GainNode(context, options)) make what the factories make.
    Object.keys(KINDS).forEach(function (kind) {
      if (!globalThis[kind] || kind === "MediaStreamAudioDestinationNode") return;
      env.installShell(kind, function (args) {
        var context = args[0];
        if (!contexts.has(context)) throw typeError("Failed to construct '" + kind + "': parameter 1 is not of type 'BaseAudioContext'.");
        var node = makeNode(context, kind);
        var options = args[1] || {};
        var fields = fieldsOf(node);
        Object.keys(options).forEach(function (key) {
          if (fields[key] && paramProto && fields[key] instanceof globalThis.AudioParam) fieldsOf(fields[key]).value = Math.fround(Number(options[key]));
          else if (hasOwn(fields, key)) node[key] = options[key];
        });
        return node;
      }, 1, { required: 1 });
    });
  })();

  // The capture's platform facts, for the modules that answer from them.
  env.platformFacts = facts;
})();
