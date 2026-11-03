//! A page as its scripts live in it over time: same-origin frames that load, run under their own
//! URL and message the window embedding them; timers that keep their delays; handlers that stick.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use wre_live::realm::RealmOptions;
use wre_sandbox::browser::{Answer, CookieStore, Hooks, Request, Transport};
use wre_sandbox::graph::{GraphPage, GraphProfile, open};

/// Serves the one document the frame loads: it reports where it thinks it is, as Kasada's `/fp`
/// frame reports its token.
struct Site;

impl Transport for Site {
    fn send(&self, request: &Request) -> Answer {
        let body = if request.url.ends_with("/frame") {
            "<html><body><script>parent.postMessage('from ' + location.href, '*');</script></body></html>".to_string()
        } else {
            String::new()
        };
        Answer { status: 200, body, headers: vec![("content-type".into(), "text/html".into())], paced: 0.0 }
    }
}

#[derive(Default)]
struct Jar;

impl CookieStore for Jar {
    fn read(&self) -> String {
        String::new()
    }

    fn write(&self, _assignment: &str) {}
}

#[test]
fn a_frame_messages_the_window_that_embeds_it() {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let page = GraphPage { url: "https://shop.example/basket".into(), frames: 1, ..GraphPage::default() };
    let hooks = Hooks { transport: Arc::new(Site), cookies: Arc::new(Jar) };
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    let mut graph = open(&profile, &page, hooks, options).expect("the sandbox opened");

    let open_frame = r#"
        globalThis.__got = [];
        window.addEventListener('message', function (event) {
          __got.push([event.data, event.origin, event.source === __frame.contentWindow]);
        });
        globalThis.__frame = document.createElement('iframe');
        __frame.onload = function () { __got.push('loaded'); };
        __frame.src = '/frame';
        document.body.appendChild(__frame);
        __frame.contentWindow;
    "#;
    graph.eval(open_frame, "https://shop.example/app.js").expect("the page script ran");
    let deadline = Instant::now() + Duration::from_secs(5);
    while graph.read("__got.length").unwrap().as_u64() < Some(2) && Instant::now() < deadline {
        graph.step().expect("the realm steps");
    }
    // The message the frame's script posts arrives, then the iframe's load (as in Chrome, where the
    // message task was queued first).
    assert_eq!(graph.read("__got").unwrap(), json!([["from https://shop.example/frame", "https://shop.example", true], "loaded"]));

    // A frame taken out gives its realm back: with one spare, a second iframe still gets a window.
    graph.eval("document.body.removeChild(__frame); globalThis.__second = document.createElement('iframe'); document.body.appendChild(__second);", "https://shop.example/app.js").expect("ran");
    assert_eq!(graph.read("__second.contentWindow !== null").unwrap(), json!(true));
}

#[test]
fn the_time_origin_is_now_not_the_captures() {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    let mut graph = open(&profile, &GraphPage::default(), Hooks::default(), options).expect("the sandbox opened");
    let skew = graph.read("Math.abs(performance.timeOrigin + performance.now() - Date.now())").unwrap();
    assert!(skew.as_f64().is_some_and(|ms| ms < 1000.0), "timeOrigin + now() strays from Date.now() by {skew} ms");
    let source = graph.read("Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Performance.prototype, 'timeOrigin').get)").unwrap();
    assert_eq!(source, json!("function get timeOrigin() { [native code] }"));
}

#[test]
fn an_event_handler_attribute_holds_its_handler() {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    let mut graph = open(&profile, &GraphPage::default(), Hooks::default(), options).expect("the sandbox opened");
    let read = |graph: &mut wre_sandbox::graph::Graph, script: &str| graph.read(script).unwrap();
    assert_eq!(read(&mut graph, "(function () { var a = document.createElement('img'); var b = document.createElement('img'); var f = function () {}; a.onload = f; return [a.onload === f, b.onload, (a.onload = 'x', a.onload)]; })()"), json!([true, null, null]));
}

#[test]
fn timers_keep_their_delays_and_intervals_repeat() {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    let mut graph = open(&profile, &GraphPage::default(), Hooks::default(), options).expect("the sandbox opened");
    let script = r#"
        globalThis.__ticks = 0; globalThis.__late = false; globalThis.__soon = false;
        setTimeout(function () { __late = true; }, 77760000);
        setTimeout(function () { __soon = true; }, "20");
        globalThis.__every = setInterval(function () { __ticks += 1; if (__ticks === 3) clearInterval(__every); }, 5);
    "#;
    graph.eval(script, "https://example.test/app.js").expect("ran");
    let until = Instant::now() + Duration::from_millis(300);
    while Instant::now() < until {
        graph.step().expect("the realm steps");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(graph.read("[__ticks, __soon, __late]").unwrap(), json!([3, true, false]));
}

/// A host jar that holds one cookie the server set and records what the page writes.
#[derive(Default)]
struct Recorded {
    written: std::sync::Mutex<Vec<String>>,
}

impl CookieStore for Recorded {
    fn read(&self) -> String {
        let mut cookies = vec!["server=1".to_string()];
        cookies.extend(self.written.lock().unwrap().iter().map(|written| written.split(';').next().unwrap_or_default().to_string()));
        cookies.join("; ")
    }

    fn write(&self, assignment: &str) {
        self.written.lock().unwrap().push(assignment.to_string());
    }
}

#[test]
fn document_cookie_is_the_hosts_jar() {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let page = GraphPage { url: "https://shop.example/basket".into(), frames: 1, ..GraphPage::default() };
    let jar = Arc::new(Recorded::default());
    let hooks = Hooks { transport: Arc::new(Site), cookies: jar.clone() };
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    let mut graph = open(&profile, &page, hooks, options).expect("the sandbox opened");

    graph
        .eval("globalThis.__seen = document.cookie; document.cookie = 'page=2; path=/; max-age=60';", "https://shop.example/app.js")
        .expect("the page script ran");

    assert_eq!(graph.read("__seen").unwrap(), json!("server=1"), "the page sees what the server set");
    assert_eq!(jar.written.lock().unwrap().as_slice(), ["page=2; path=/; max-age=60"], "the assignment reached the jar whole");
    assert_eq!(graph.read("document.cookie").unwrap(), json!("server=1; page=2"));
    assert_eq!(graph.read("new Document().cookie").unwrap(), json!(""), "a document a script made has no cookies");
}
