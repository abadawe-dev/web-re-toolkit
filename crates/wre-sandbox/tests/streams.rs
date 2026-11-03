//! Streams, encodings, bodies and the network objects as a page uses them, checked against what
//! Chrome 156 answers for the same script.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use wre_live::realm::RealmOptions;
use wre_sandbox::browser::{Answer, CookieStore, Hooks, Request, Transport};
use wre_sandbox::graph::{Graph, GraphPage, GraphProfile, open};

/// Answers every request with a JSON description of it, and a header the page should see.
#[derive(Default)]
struct Echo {
    seen: Mutex<Vec<Request>>,
}

impl Transport for Echo {
    fn send(&self, request: &Request) -> Answer {
        self.seen.lock().unwrap().push(request.clone());
        let body = json!({ "method": request.method, "headers": request.headers }).to_string();
        Answer {
            status: 200,
            body,
            headers: vec![("x-token".into(), "next".into()), ("set-cookie".into(), "secret=1".into())],
            paced: 0.0,
        }
    }
}

struct Jar;

impl CookieStore for Jar {
    fn read(&self) -> String {
        String::new()
    }

    fn write(&self, _assignment: &str) {}
}

fn realm(transport: Arc<Echo>) -> Graph {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let page = GraphPage { url: "https://shop.example/basket".into(), frames: 1, ..GraphPage::default() };
    let hooks = Hooks { transport, cookies: Arc::new(Jar) };
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    open(&profile, &page, hooks, options).expect("the sandbox opened")
}

/// Runs `script` (which settles `__got`) and pumps the realm until it has.
fn settle(script: &str) -> (Value, Arc<Echo>) {
    let echo = Arc::new(Echo::default());
    let mut graph = realm(echo.clone());
    graph.eval(&format!("globalThis.__got = null; {script}"), "https://shop.example/app.js").expect("the page script ran");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        graph.step().expect("the realm steps");
        let got = graph.read("JSON.stringify(__got)").expect("read");
        if got.as_str() != Some("null") || Instant::now() > deadline {
            return (serde_json::from_str(got.as_str().unwrap_or("null")).unwrap_or(Value::Null), echo);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn compression_streams_write_chromes_bytes() {
    let (got, _) = settle(
        r#"
        var s = new CompressionStream('gzip');
        var w = s.writable.getWriter();
        w.write(new Uint8Array([1, 2, 3]));
        w.close();
        new Response(s.readable).arrayBuffer().then(function (b) { __got = Array.from(new Uint8Array(b)); });
        "#,
    );
    assert_eq!(got, json!([31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 99, 100, 98, 6, 0, 29, 128, 188, 85, 3, 0, 0, 0]));

    let (got, _) = settle(
        r#"
        var s = new DecompressionStream('deflate');
        var w = s.writable.getWriter();
        w.write(new Uint8Array([1, 2, 3, 4])).catch(function () {});
        s.readable.getReader().read().then(function () { __got = 'read'; }, function (e) { __got = e.name + ': ' + e.message; });
        "#,
    );
    assert_eq!(got, json!("TypeError: The compressed data was not valid: incorrect header check."));
}

#[test]
fn streams_are_the_pages_own_interfaces() {
    let (got, _) = settle(
        r#"
        var rs = new ReadableStream({ start: function (c) { c.enqueue('a'); c.close(); } });
        var reader = rs.getReader();
        var shape = [Object.getPrototypeOf(rs) === ReadableStream.prototype, Reflect.ownKeys(rs).length, Object.prototype.toString.call(reader), rs.locked];
        var locked;
        try { rs.getReader(); } catch (e) { locked = e.message; }
        reader.read().then(function (r) { __got = shape.concat([Object.keys(r).join(), r.value, locked]); });
        "#,
    );
    assert_eq!(
        got,
        json!([
            true,
            0,
            "[object ReadableStreamDefaultReader]",
            true,
            "done,value",
            "a",
            "Failed to execute 'getReader' on 'ReadableStream': ReadableStreamDefaultReader constructor can only accept readable streams that are not yet locked to a reader"
        ])
    );
}

#[test]
fn xhr_and_fetch_go_through_the_transport() {
    let (got, echo) = settle(
        r#"
        var x = new XMLHttpRequest();
        x.open('POST', '/tl');
        x.setRequestHeader('Content-Type', 'application/octet-stream');
        x.setRequestHeader('Cookie', 'refused');
        x.onload = function () {
          var xhr = [x.status, x.getResponseHeader('x-token'), x.getResponseHeader('set-cookie'), x.readyState];
          fetch('/api', { method: 'POST', body: 'hi', headers: { 'x-kpsdk-ct': 'a' } }).then(function (r) {
            return r.json().then(function (j) { __got = xhr.concat([r.status, r.type, r.headers.get('x-token'), j.method]); });
          });
        };
        x.send(new Uint8Array([7, 8]));
        "#,
    );
    assert_eq!(got, json!([200, "next", null, 4, 200, "basic", "next", "POST"]));

    let seen = echo.seen.lock().unwrap();
    assert_eq!(seen[0].url, "https://shop.example/tl");
    assert_eq!(seen[0].bytes(), Some(vec![7, 8]));
    assert!(!seen[0].headers.contains_key("cookie"), "a forbidden header reached the wire");
    assert_eq!(seen[1].headers.get("content-type").map(String::as_str), Some("text/plain;charset=UTF-8"));
    assert_eq!(seen[1].bytes(), Some(b"hi".to_vec()));
}

#[test]
fn local_urls_and_encodings_answer_as_chrome() {
    let (got, echo) = settle(
        r#"
        Promise.all([
          fetch('data:text/plain;charset=utf-8,hi%20there').then(function (r) { return r.text(); }),
          fetch(URL.createObjectURL(new Blob(['fb'], { type: 'text/x' }))).then(function (r) { return [r.status, r.headers.get('content-type'), r.headers.get('content-length')]; }),
          fetch('ftp:').then(function () { return 'ok'; }, function (e) { return e.message; }),
          new TextDecoder('shift_jis').decode(new Uint8Array([0x82, 0xa0, 0x41])),
          (function () { var d = new TextDecoder(); return d.decode(new Uint8Array([0xe2, 0x82]), { stream: true }) + d.decode(new Uint8Array([0xac])); })(),
          (function () { try { atob('a'); } catch (e) { return e.name; } })(),
        ]).then(function (all) { __got = all; });
        "#,
    );
    assert_eq!(
        got,
        json!(["hi there", [200, "text/x", "2"], "Failed to execute 'fetch' on 'Window': Failed to parse URL from ftp:", "\u{3042}A", "\u{20ac}", "InvalidCharacterError"])
    );
    assert!(echo.seen.lock().unwrap().is_empty(), "a local URL went to the network");
}
