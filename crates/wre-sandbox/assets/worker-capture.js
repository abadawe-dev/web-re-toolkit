// Records a dedicated worker's global surface in Chrome, for assets/graph/worker-shape.json.gz:
// run it inside a worker (new Worker(URL.createObjectURL(new Blob([source])))) and save what it
// posts. Each property is [key, kind, flags, ...extra], flags bit 1 enumerable, 2 configurable,
// 4 writable; kinds: "f" function (length, name, constructible), "a" accessor (getter, setter),
// "n"/"s"/"b" a number/string/boolean (value), "u" undefined, "l" null, "o" an object (brand).
(function () {
  var flags = function (d) { return (d.enumerable ? 1 : 0) | (d.configurable ? 2 : 0) | (d.writable ? 4 : 0); };
  var native = function (fn) { try { return /\[native code\]/.test(Function.prototype.toString.call(fn)); } catch (e) { return false; } };
  var entry = function (key, d) {
    var name = typeof key === "symbol" ? "@@" + String(key).slice(7, -1) : key;
    if (d.get || d.set) return [name, "a", flags(d), d.get ? 1 : 0, d.set ? 1 : 0];
    var v = d.value;
    switch (typeof v) {
      case "function": return [name, "f", flags(d), v.length, v.name, Object.getOwnPropertyNames(v).indexOf("prototype") !== -1 && native(v) ? 1 : 0];
      case "number": return [name, "n", flags(d), isFinite(v) ? v : String(v)];
      case "string": return [name, "s", flags(d), v];
      case "boolean": return [name, "b", flags(d), v];
      case "undefined": return [name, "u", flags(d)];
      default: return v === null ? [name, "l", flags(d)] : [name, "o", flags(d), Object.prototype.toString.call(v)];
    }
  };
  var props = function (obj) {
    return Reflect.ownKeys(obj).map(function (k) { return entry(k, Object.getOwnPropertyDescriptor(obj, k)); });
  };
  var shape = { chain: [], global: props(self), interfaces: {}, namespaces: {}, objects: {} };
  for (var p = Object.getPrototypeOf(self); p; p = Object.getPrototypeOf(p)) shape.chain.push(p.constructor.name);
  Object.getOwnPropertyNames(self).forEach(function (n) {
    var d = Object.getOwnPropertyDescriptor(self, n);
    var v = d.value;
    if (typeof v === "function" && v.prototype && native(v) && /^[A-Z]/.test(n)) {
      var parent = Object.getPrototypeOf(v.prototype);
      var ctorParent = Object.getPrototypeOf(v);
      shape.interfaces[n] = {
        l: v.length,
        p: parent && parent.constructor ? parent.constructor.name : null,
        c: ctorParent === Function.prototype ? null : ctorParent.name,
        s: props(v),
        m: props(v.prototype),
      };
    } else if (v && typeof v === "object" && n !== "globalThis") {
      shape.namespaces[n] = props(v);
    }
  });
  // Interfaces a worker does not expose but whose prototypes others inherit (CSSSkewX's
  // CSSTransformComponent): recorded beside the exposed ones, never installed as globals.
  shape.hidden = {};
  Object.keys(shape.interfaces).forEach(function (n) {
    for (var proto = Object.getPrototypeOf(self[n].prototype); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      var ctor = proto.constructor;
      var name = ctor && ctor.name;
      if (!name || shape.interfaces[name] || shape.hidden[name] || Object.getOwnPropertyDescriptor(self, name)) continue;
      var parent = Object.getPrototypeOf(proto);
      var ctorParent = Object.getPrototypeOf(ctor);
      shape.hidden[name] = {
        l: ctor.length,
        p: parent && parent.constructor ? parent.constructor.name : null,
        c: ctorParent === Function.prototype ? null : ctorParent.name,
        s: props(ctor),
        m: props(proto),
      };
    }
  });
  ["navigator", "location", "performance", "crypto", "scheduler", "indexedDB", "caches", "fonts", "trustedTypes"].forEach(function (n) {
    var o = self[n];
    shape.objects[n] = o === undefined || o === null ? null : Object.getPrototypeOf(o).constructor.name;
  });
  postMessage(JSON.stringify(shape));
})();
