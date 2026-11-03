//! Messaging as Chrome runs it: dedicated workers that really run (in a realm of their own, with a
//! worker's global), the structured clone, message ports and the origin private file system.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use wre_live::realm::RealmOptions;
use wre_sandbox::browser::{Answer, CookieStore, Hooks, Request, Transport};
use wre_sandbox::graph::{Graph, GraphPage, GraphProfile, open};

struct Quiet;

impl Transport for Quiet {
    fn send(&self, _request: &Request) -> Answer {
        Answer { status: 404, body: String::new(), headers: vec![], paced: 0.0 }
    }
}

struct Jar;

impl CookieStore for Jar {
    fn read(&self) -> String {
        String::new()
    }

    fn write(&self, _assignment: &str) {}
}

fn page() -> Graph {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let page = GraphPage { url: "https://shop.example/basket".into(), frames: 1, ..GraphPage::default() };
    let hooks = Hooks { transport: Arc::new(Quiet), cookies: Arc::new(Jar) };
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    open(&profile, &page, hooks, options).expect("the sandbox opened")
}

/// Runs `script`, then pumps the page until `globalThis.__done` is set, and reads it.
fn settle(graph: &mut Graph, script: &str) -> Value {
    graph.eval(script, "https://shop.example/app.js").expect("the page script ran");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        graph.step().expect("the realm steps");
        let done = graph.read("globalThis.__done === undefined ? null : globalThis.__done").expect("readable");
        if !done.is_null() {
            return done;
        }
        assert!(Instant::now() < deadline, "the page never settled");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// Kasada's interrogation starts this worker twice: it must run and answer with the language its
/// navigator reports, the window's.
#[test]
fn a_worker_runs_and_answers_with_its_navigator() {
    let mut graph = page();
    let done = settle(
        &mut graph,
        r#"
        var worker = new Worker(URL.createObjectURL(new Blob(['onmessage=function(){postMessage(navigator.language)}'], { type: 'text/javascript' })));
        worker.onmessage = function (event) {
          globalThis.__done = [event.data === navigator.language, Object.prototype.toString.call(event), event.origin, event.source];
        };
        worker.postMessage(0);
        "#,
    );
    assert_eq!(done, json!([true, "[object MessageEvent]", "", null]));
}

/// A worker's global is Chrome's: its prototype chain, its natives, what it lacks.
#[test]
fn a_worker_global_looks_like_chromes() {
    let mut graph = page();
    let done = settle(
        &mut graph,
        r#"
        var source = 'var p = Object.getPrototypeOf(self), chain = []; while (p) { chain.push(p.constructor.name); p = Object.getPrototypeOf(p); }'
          + 'postMessage([chain, String(postMessage), typeof document, typeof SharedArrayBuffer, Object.prototype.toString.call(navigator), location.protocol, self.toString()])';
        var worker = new Worker(URL.createObjectURL(new Blob([source])));
        worker.onmessage = function (event) { globalThis.__done = event.data; };
        "#,
    );
    assert_eq!(
        done,
        json!([
            ["DedicatedWorkerGlobalScope", "WorkerGlobalScope", "EventTarget", "Object"],
            "function postMessage() { [native code] }",
            "undefined",
            "undefined",
            "[object WorkerNavigator]",
            "blob:",
            "[object DedicatedWorkerGlobalScope]"
        ])
    );
}

/// Kasada times an OPFS sync access handle's flush in a worker: a real disk's flush takes a
/// tenth of a millisecond or more, so Chrome answers false; an instant one gives a VM away.
#[test]
fn a_sync_access_flush_takes_a_disks_time() {
    let mut graph = page();
    let done = settle(
        &mut graph,
        r#"
        var source = "(async()=>{try{const d=await navigator.storage.getDirectory(),f=await(await d.getFileHandle('_',{create:1})).createSyncAccessHandle(),b=new Uint8Array(1);let m=1/0,s,i=0;for(;i<3;i++){f.write(b);s=performance.now();f.flush();m=Math.min(m,performance.now()-s)}f.close();postMessage(m<.1)}catch{postMessage('failed')}})()";
        var worker = new Worker(URL.createObjectURL(new Blob([source])));
        worker.onmessage = function (event) { globalThis.__done = [event.data]; };
        "#,
    );
    assert_eq!(done, json!([false]));
}

/// An exception a worker's script throws reaches the Worker as an ErrorEvent, where V8 says it
/// was thrown.
#[test]
fn a_worker_error_reaches_the_worker_object() {
    let mut graph = page();
    let done = settle(
        &mut graph,
        r#"
        var worker = new Worker(URL.createObjectURL(new Blob(['var x = 1;\nthrow new Error("boom")'])));
        worker.onerror = function (event) {
          event.preventDefault();
          globalThis.__done = [Object.prototype.toString.call(event), event.message, event.lineno, event.colno, event.filename.slice(0, 5)];
        };
        "#,
    );
    assert_eq!(done, json!(["[object ErrorEvent]", "Uncaught Error: boom", 2, 1, "blob:"]));
}

/// structuredClone copies (cycles, Maps, Dates, errors, typed arrays over one buffer) and refuses
/// what Chrome refuses, with Chrome's words.
#[test]
fn structured_clone_copies_as_chrome_does() {
    let mut graph = page();
    let done = settle(
        &mut graph,
        r#"
        var buffer = new ArrayBuffer(4);
        var input = { m: new Map([[1, 'a']]), d: new Date(5), e: new RangeError('bad'), v: new Uint8Array(buffer, 1), w: new Uint16Array(buffer) };
        input.self = input;
        var copy = structuredClone(input);
        var refused;
        try { structuredClone({ f: function () {} }); } catch (error) { refused = [error.name, error.message]; }
        globalThis.__done = [copy !== input, copy.self === copy, copy.m.get(1), copy.d.getTime(), copy.e instanceof RangeError,
          copy.v.buffer === copy.w.buffer, copy.v.byteOffset, refused];
        "#,
    );
    assert_eq!(
        done,
        json!([
            true,
            true,
            "a",
            5,
            true,
            true,
            1,
            ["DataCloneError", "Failed to execute 'structuredClone' on 'Window': function () {} could not be cloned."]
        ])
    );
}

/// A port carried into a worker keeps its channel: the worker answers through it.
#[test]
fn a_message_port_reaches_a_worker() {
    let mut graph = page();
    let done = settle(
        &mut graph,
        r#"
        var channel = new MessageChannel();
        var worker = new Worker(URL.createObjectURL(new Blob(['onmessage=function(e){ e.ports[0].postMessage("via port") }'])));
        channel.port1.onmessage = function (event) { globalThis.__done = [event.data]; };
        worker.postMessage('p', [channel.port2]);
        "#,
    );
    assert_eq!(done, json!(["via port"]));
}
