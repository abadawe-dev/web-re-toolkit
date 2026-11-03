//! The realm's network as a browser's: requests are on the wire concurrently while the page keeps
//! running, and their answers come back as tasks.

use std::sync::Arc;
use std::time::{Duration, Instant};

use wre_live::realm::RealmOptions;
use wre_sandbox::browser::{Answer, CookieStore, Hooks, Request, Transport};
use wre_sandbox::graph::{GraphPage, GraphProfile, open};

/// Answers every request after `delay`, with the path it was asked for.
struct Slow {
    delay: Duration,
}

impl Transport for Slow {
    fn send(&self, request: &Request) -> Answer {
        std::thread::sleep(self.delay);
        Answer { status: 200, body: request.url.rsplit('/').next().unwrap_or_default().to_string(), headers: vec![], paced: 0.0 }
    }
}

struct Jar;

impl CookieStore for Jar {
    fn read(&self) -> String {
        String::new()
    }

    fn write(&self, _assignment: &str) {}
}

#[test]
fn requests_overlap_and_the_page_runs_while_they_are_out() {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let page = GraphPage { url: "https://shop.example/basket".into(), frames: 0, ..GraphPage::default() };
    let hooks = Hooks { transport: Arc::new(Slow { delay: Duration::from_millis(300) }), cookies: Arc::new(Jar) };
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    let mut graph = open(&profile, &page, hooks, options).expect("the sandbox opened");

    graph
        .eval(
            r#"
            globalThis.__got = [];
            var ticks = 0;
            var timer = setInterval(function () { ticks += 1; }, 20);
            Promise.all([fetch('/a'), fetch('/b'), fetch('/c')].map(function (p) { return p.then(function (r) { return r.text(); }); }))
              .then(function (all) { clearInterval(timer); __got = [all.join(), ticks > 5]; });
            "#,
            "https://shop.example/app.js",
        )
        .expect("the page script ran");

    let started = Instant::now();
    let deadline = started + Duration::from_secs(5);
    while graph.read("__got.length").unwrap().as_u64() != Some(2) && Instant::now() < deadline {
        graph.step().expect("the realm steps");
        graph.idle(Duration::from_millis(50)).expect("the realm idles");
    }

    assert_eq!(graph.read("__got").unwrap(), serde_json::json!(["a,b,c", true]), "the answers, and the timer kept running meanwhile");
    // Three 300 ms requests at once take about 300 ms, not 900.
    assert!(started.elapsed() < Duration::from_millis(800), "the requests did not overlap: {:?}", started.elapsed());
    assert_eq!(graph.in_flight(), 0);
}

#[test]
fn idle_wakes_when_an_answer_arrives_or_the_host_wakes_it() {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let page = GraphPage { url: "https://shop.example/basket".into(), frames: 0, ..GraphPage::default() };
    let hooks = Hooks { transport: Arc::new(Slow { delay: Duration::from_millis(100) }), cookies: Arc::new(Jar) };
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    let mut graph = open(&profile, &page, hooks, options).expect("the sandbox opened");

    graph.eval("fetch('/x');", "https://shop.example/app.js").expect("the page script ran");
    let started = Instant::now();
    graph.idle(Duration::from_secs(5)).expect("the realm idles");
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(80) && waited < Duration::from_secs(1), "idle did not wake on the answer: {waited:?}");

    let waker = graph.waker();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        waker.wake();
    });
    graph.step().expect("the realm steps");
    let started = Instant::now();
    graph.idle(Duration::from_secs(5)).expect("the realm idles");
    assert!(started.elapsed() < Duration::from_secs(1), "idle did not wake on the host's wake: {:?}", started.elapsed());
}
