(function () {
  var env = globalThis.__ENV;
  var pump = globalThis.__PUMP;

  delete globalThis.__ENV;
  delete globalThis.__PUMP;

  var json = function (value) {
    try {
      return JSON.parse(env.rawStringify(value));
    } catch (error) {
      return null;
    }
  };

  return {
    // 2 when a script the page inserted is ready to run (the host evaluates it under its own URL,
    // see `script` and `ran`), else whether one task ran.
    step: function (until) {
      if (env.scriptReady && env.scriptReady()) return 2;
      return pump.step(env, until);
    },

    // The inserted script that is ready to run, now current: { source, url }.
    script: function () {
      return env.takeScript();
    },

    // The host ran it: `failure` is what it threw (null if it ran to the end).
    ran: function (failure) {
      env.scriptRan(failure === null || failure === undefined ? null : String(failure));
    },

    due: function () {
      return env.scriptReady && env.scriptReady() ? 0 : pump.due();
    },

    // Dedicated workers: the host takes a start request, opens a realm for it, has the page bind
    // it, runs its script, then says it started (see Graph::start_workers).
    takeWorker: function () {
      return env.bridge.takeWorker();
    },

    bindWorker: function (id) {
      return env.bridge.bindWorker(id);
    },

    workerStarted: function (id) {
      env.bridge.workerStarted(id);
    },

    pending: function () {
      return pump.pending() + (env.scriptReady && env.scriptReady() ? 1 : 0);
    },

    begin: function (name, inline) {
      env.beginScript(String(name || ""), Boolean(inline));
    },

    end: function () {
      env.endScript();
    },

    read: function (expression) {
      try {
        return env.evaluate("(" + String(expression) + ")");
      } catch (error) {
        return "THREW " + String(error && error.message);
      }
    },

    cookies: function () {
      return typeof env.cookies === "function" ? env.cookies() : "";
    },

    calls: function () {
      return json(env.calls);
    },

    trail: function () {
      return json(env.trail);
    },

    misses: function () {
      return json(env.misses);
    },

    log: function () {
      return json(env.log);
    },

    layoutMisses: function () {
      return typeof env.layoutMisses === "function" ? json(env.layoutMisses()) : [];
    }
  };
})()
