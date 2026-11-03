//! Elements as they live in a page over time, checked against what Chrome 156 does: images decode
//! their sizes and say load or error, inserted scripts run under their own URL, blank frames load
//! during their insertion, media without a decodable source fails with Chrome's MediaError, and
//! observers hear what they watch.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use wre_live::realm::RealmOptions;
use wre_sandbox::browser::{Answer, CookieStore, Hooks, Request, Transport};
use wre_sandbox::graph::{Graph, GraphPage, GraphProfile, open};

/// A small site: `/app.js` reports where its own stack says it runs; anything else is missing.
struct Site;

impl Transport for Site {
    fn send(&self, request: &Request) -> Answer {
        if request.url.ends_with("/app.js") {
            let body = "globalThis.__ran = [document.currentScript && document.currentScript.src, new Error().stack.split('\\n')[1].trim()];";
            return Answer { status: 200, body: body.into(), headers: vec![("content-type".into(), "text/javascript".into())], paced: 0.0 };
        }
        Answer { status: 404, body: "missing".into(), headers: vec![("content-type".into(), "text/html".into())], paced: 0.0 }
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
    let page = GraphPage { url: "https://shop.example/basket".into(), frames: 2, ..GraphPage::default() };
    let hooks = Hooks { transport: Arc::new(Site), cookies: Arc::new(Jar) };
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    open(&profile, &page, hooks, options).expect("the sandbox opened")
}

/// Runs `script`, then the page's tasks until `__done` is set, and reads `__out`.
fn settle(graph: &mut Graph, script: &str) -> Value {
    graph.eval(&format!("globalThis.__done = false; {script}"), "https://shop.example/test.js").expect("the test script ran");
    let deadline = Instant::now() + Duration::from_secs(5);
    while graph.read("__done").unwrap() != json!(true) && Instant::now() < deadline {
        graph.step().expect("the realm steps");
        std::thread::sleep(Duration::from_millis(1));
    }
    graph.read("__out").unwrap()
}

const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP4z8DAwMDAxMAAAA4kAQNgfvhwAAAAAElFTkSuQmCC";

#[test]
fn an_image_loads_its_size_or_fails() {
    let mut graph = page();
    let script = format!(
        r#"
        globalThis.__out = [];
        var good = new Image(), bad = new Image();
        good.onload = function (e) {{ __out.push(['load', e.isTrusted, good.naturalWidth, good.naturalHeight, good.complete]); if (__out.length === 2) __done = true; }};
        bad.onerror = function () {{ __out.push(['error', bad.naturalWidth, bad.complete]); if (__out.length === 2) __done = true; }};
        good.src = {PNG:?};
        bad.src = 'data:,not an image';
        __out.push(good.complete);
        "#
    );
    assert_eq!(settle(&mut graph, &script), json!([false, ["load", true, 2, 3, true], ["error", 0, true]]));
}

#[test]
fn an_inserted_script_runs_under_its_own_url() {
    let mut graph = page();
    let script = r#"
        globalThis.__out = [];
        var s = document.createElement('script');
        s.onload = function () { __out.push('load', __ran[0], __ran[1]); __done = true; };
        s.src = '/app.js';
        document.head.appendChild(s);
        __out.push('appended');
        var missing = document.createElement('script');
        missing.onerror = function (e) { __out.push('missing ' + e.type); };
        missing.src = '/gone.js';
        document.head.appendChild(missing);
    "#;
    // The two fetches race (as on the network); each script says how it went after the insertion.
    let out = settle(&mut graph, script);
    assert_eq!(out[0], json!("appended"));
    let rest: Vec<Value> = out.as_array().unwrap()[1..].to_vec();
    assert!(rest.contains(&json!("missing error")), "{out}");
    let at = rest.iter().position(|item| item == "load").expect("the script loaded");
    assert_eq!(rest[at + 1], json!("https://shop.example/app.js"));
    assert_eq!(rest[at + 2], json!("at https://shop.example/app.js:1:75"));
}

#[test]
fn an_inline_script_runs_as_it_is_inserted() {
    let mut graph = page();
    let out = graph
        .read("(function () { var s = document.createElement('script'); s.textContent = 'globalThis.__inline = document.currentScript === __el'; globalThis.__el = s; document.head.appendChild(s); return __inline; })()")
        .unwrap();
    assert_eq!(out, json!(true));
}

#[test]
fn a_blank_frame_loads_during_its_insertion() {
    let mut graph = page();
    let script = r#"
        globalThis.__out = [];
        var f = document.createElement('iframe');
        f.onload = function () { __out.push('load ' + f.contentWindow.location.href); };
        document.body.appendChild(f);
        __out.push('appended');
        var j = document.createElement('iframe');
        j.onload = function () { __out.push('javascript load'); __done = true; };
        j.src = 'javascript:;';
        document.body.appendChild(j);
    "#;
    assert_eq!(settle(&mut graph, script), json!(["load about:blank", "appended", "javascript load"]));
}

#[test]
fn media_without_a_decodable_source_fails_as_chrome() {
    let mut graph = page();
    let script = r#"
        globalThis.__out = [];
        var v = document.createElement('video');
        __out.push([v.networkState, v.readyState, v.paused, String(v.duration), v.error, v.preload]);
        v.addEventListener('loadstart', function () { __out.push('loadstart'); });
        v.onerror = function () { __out.push([v.error.code, v.error.message, v.networkState]); __done = true; };
        v.src = 'data:video/mp4;base64,AAAA';
    "#;
    assert_eq!(
        settle(&mut graph, script),
        json!([[0, 0, true, "NaN", null, "metadata"], "loadstart", [4, "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed", 3]])
    );
}

#[test]
fn a_mutation_observer_hears_changes_in_a_microtask() {
    let mut graph = page();
    let script = r#"
        globalThis.__out = [];
        var n = document.createElement('div'), a = document.createElement('span'), b = document.createElement('i');
        n.appendChild(a);
        new MutationObserver(function (records) {
          records.forEach(function (r) { __out.push([r.type, r.attributeName, r.oldValue, r.addedNodes.length, r.removedNodes.length, r.previousSibling && r.previousSibling.nodeName]); });
          __done = true;
        }).observe(n, { attributes: true, attributeOldValue: true, childList: true });
        n.id = 'x';
        n.insertBefore(b, a);
        n.removeChild(a);
        __out.push('sync');
    "#;
    assert_eq!(
        settle(&mut graph, script),
        json!(["sync", ["attributes", "id", null, 0, 0, null], ["childList", null, null, 1, 0, null], ["childList", null, null, 0, 1, "I"]])
    );
}

#[test]
fn a_performance_observer_hears_marks() {
    let mut graph = page();
    let script = r#"
        globalThis.__out = [];
        new PerformanceObserver(function (list) {
          var e = list.getEntries()[0];
          __out.push(e.entryType, e.name, Object.prototype.toString.call(e), performance.getEntriesByName('m').length);
          __done = true;
        }).observe({ type: 'mark' });
        performance.mark('m');
    "#;
    assert_eq!(settle(&mut graph, script), json!(["mark", "m", "[object PerformanceMark]", 1]));
}
