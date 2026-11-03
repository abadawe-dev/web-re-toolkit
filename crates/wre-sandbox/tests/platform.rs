//! The platform's promise-returning APIs, speech, WebRTC and Web Audio answer as Chrome's do
//! (values from Chrome 156; see playground notes in the platform module's header).

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use wre_live::realm::RealmOptions;
use wre_sandbox::browser::Hooks;
use wre_sandbox::graph::{Graph, GraphPage, GraphProfile, open};

fn realm() -> Graph {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let page = GraphPage { url: "https://shop.example/".into(), ..GraphPage::default() };
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    open(&profile, &page, Hooks::default(), options).expect("the sandbox opened")
}

/// Runs `script`, which settles `__done` with its answer, and steps the realm until it does.
fn settle(graph: &mut Graph, script: &str) -> Value {
    graph.eval(&format!("globalThis.__done = undefined; {script}"), "https://shop.example/app.js").expect("the script ran");
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        graph.step().expect("the realm steps");
        let done = graph.read("globalThis.__done === undefined ? null : JSON.stringify(__done)").unwrap();
        if let Some(text) = done.as_str() {
            return serde_json::from_str(text).expect("a JSON answer");
        }
        assert!(Instant::now() < deadline, "the script never settled");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn promise_returning_apis_answer_with_promises() {
    let mut graph = realm();
    let answer = settle(&mut graph, r#"
        var calls = [
            function () { return navigator.userAgentData.getHighEntropyValues(['bitness']); },
            function () { return navigator.mediaCapabilities.decodingInfo({ type: 'file', audio: { contentType: 'audio/mpeg' } }); },
            function () { return navigator.storage.estimate(); },
            function () { return navigator.serviceWorker.getRegistrations(); },
            function () { return document.hasStorageAccess(); },
            function () { return navigator.locks.query(); },
            function () { return navigator.getBattery(); },
            function () { return navigator.mediaDevices.enumerateDevices(); },
            function () { return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); },
        ];
        Promise.all(calls.map(function (call) { var made = call(); return made instanceof Promise ? made.then(function () { return 'settled'; }, function (e) { return 'rejected ' + e.name; }) : 'not a promise'; }))
            .then(function (all) { __done = all; });
    "#);
    assert_eq!(answer, json!(["settled", "settled", "settled", "settled", "settled", "settled", "settled", "settled", "settled"]));
}

#[test]
fn high_entropy_hints_answer_only_what_was_asked() {
    let mut graph = realm();
    let answer = settle(&mut graph, r#"
        Promise.all([
            navigator.userAgentData.getHighEntropyValues(['bitness', 'nonsense']).then(function (v) { return Object.keys(v); }),
            navigator.userAgentData.getHighEntropyValues().then(null, function (e) { return e.message; }),
        ]).then(function (all) { __done = all; });
    "#);
    assert_eq!(
        answer,
        json!([["bitness", "brands", "mobile", "platform"], "Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': 1 argument required, but only 0 present."])
    );
}

#[test]
fn an_offline_render_honours_its_length_and_runs_its_states() {
    let mut graph = realm();
    let answer = settle(&mut graph, r#"
        var c = new OfflineAudioContext({ numberOfChannels: 2, length: 300, sampleRate: 22050 });
        var states = [c.state];
        var p = c.startRendering();
        states.push(c.state);
        p.then(function (b) {
            var bad; try { new OfflineAudioContext(1, 0, 44100); } catch (e) { bad = e.name; }
            var o = c.createOscillator();
            __done = [b.length, b.sampleRate, b.numberOfChannels, b.getChannelData(1) === b.getChannelData(1), states.concat(c.state), bad,
                Object.prototype.toString.call(o), Object.getOwnPropertyNames(o).length, c.createDynamicsCompressor().attack.value];
        });
    "#);
    assert_eq!(answer, json!([300, 22050, 2, true, ["suspended", "running", "closed"], "NotSupportedError", "[object OscillatorNode]", 0, 0.003000000026077032]));
}

#[test]
fn each_audio_context_keeps_its_own_state() {
    let mut graph = realm();
    let answer = settle(&mut graph, "var a = new AudioContext(), b = new AudioContext(); a.close().then(function () { __done = [a.state, b.state]; });");
    assert_eq!(answer, json!(["closed", "suspended"]));
}

#[test]
fn webrtc_gathers_one_mdns_host_candidate_then_completes() {
    let mut graph = realm();
    let answer = settle(&mut graph, r#"
        var pc = new RTCPeerConnection(), seen = [];
        pc.createDataChannel('x');
        pc.onicegatheringstatechange = function () { seen.push(pc.iceGatheringState); };
        pc.onicecandidate = function (e) {
            if (e.candidate) { seen.push(/^candidate:\d+ 1 udp 2113937151 [0-9a-f-]{36}\.local \d+ typ host generation 0 ufrag \S{4} network-cost 999$/.test(e.candidate.candidate)); return; }
            seen.push(/a=candidate:/.test(pc.localDescription.sdp), Object.prototype.toString.call(e));
            __done = seen;
        };
        pc.createOffer().then(function (offer) { seen.push(Object.keys(offer).join()); return pc.setLocalDescription(offer); });
    "#);
    assert_eq!(answer, json!(["sdp,type", "gathering", true, "complete", true, "[object RTCPeerConnectionIceEvent]"]));
}

#[test]
fn subtle_crypto_signs_and_derives_as_chrome() {
    let mut graph = realm();
    let answer = settle(&mut graph, r#"
        var hmac = crypto.subtle.importKey('raw', new Uint8Array([1, 2, 3]), { name: 'HMAC', hash: 'SHA-256' }, true, ['sign'])
            .then(function (k) { return crypto.subtle.sign('HMAC', k, new Uint8Array([4, 5])); })
            .then(function (s) { return Array.from(new Uint8Array(s).slice(0, 4)); });
        var ec = crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']).then(function (p) {
            var data = new Uint8Array([9]);
            return crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, p.privateKey, data).then(function (s) {
                return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, p.publicKey, s, data);
            });
        });
        var bad = crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', false, ['sign']).then(null, function (e) { return e.name; });
        Promise.all([hmac, ec, bad]).then(function (all) { __done = all; });
    "#);
    assert_eq!(answer, json!([[6, 250, 16, 232], true, "SyntaxError"]));
}

#[test]
fn indexeddb_stores_and_reads_back() {
    let mut graph = realm();
    let answer = settle(&mut graph, r#"
        var r = indexedDB.open('store', 2);
        r.onupgradeneeded = function () { r.result.createObjectStore('s', { keyPath: 'id' }); };
        r.onsuccess = function () {
            var db = r.result, tx = db.transaction('s', 'readwrite');
            tx.objectStore('s').put({ id: 1, v: 'a' });
            tx.oncomplete = function () {
                var g = db.transaction('s').objectStore('s').get(1);
                g.onsuccess = function () { __done = [g.result.v, db.version, db.objectStoreNames.length, Object.prototype.toString.call(db)]; };
            };
        };
    "#);
    assert_eq!(answer, json!(["a", 2, 1, "[object IDBDatabase]"]));
}

#[test]
fn voices_arrive_after_the_first_ask() {
    let mut graph = realm();
    let answer = settle(&mut graph, r#"
        var first = speechSynthesis.getVoices().length;
        speechSynthesis.onvoiceschanged = function (e) { __done = [first, e.type, e.isTrusted, Array.isArray(speechSynthesis.getVoices())]; };
    "#);
    assert_eq!(answer, json!([0, "voiceschanged", true, true]));
}

#[test]
fn a_canvas_encodes_to_the_type_it_was_asked_for() {
    let mut graph = realm();
    let answer = settle(&mut graph, r#"
        var c = document.createElement('canvas');
        var heads = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'].map(function (t) { return c.toDataURL(t).split(',')[0]; });
        var empty = document.createElement('canvas'); empty.width = 0;
        c.toBlob(function (b) { __done = heads.concat([b.type, b.size > 0, empty.toDataURL()]); });
    "#);
    assert_eq!(answer, json!(["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64", "data:image/png;base64", "image/png", true, "data:,"]));
}
