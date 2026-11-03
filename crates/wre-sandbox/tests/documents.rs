//! Documents, markup, selectors and cloning as Chrome 156 answers them: script-made documents
//! that take nodes, the WHATWG parser's tree fix-ups, selectors and their errors, deep clones.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use wre_live::realm::RealmOptions;
use wre_sandbox::browser::{Answer, CookieStore, Hooks, Request, Transport};
use wre_sandbox::graph::{Graph, GraphPage, GraphProfile, open};

struct Quiet;

impl Transport for Quiet {
    fn send(&self, _request: &Request) -> Answer {
        Answer { status: 200, body: String::new(), headers: vec![], paced: 0.0 }
    }
}

struct Jar;

impl CookieStore for Jar {
    fn read(&self) -> String {
        String::new()
    }

    fn write(&self, _assignment: &str) {}
}

fn realm() -> Graph {
    let profile = GraphProfile::bundled(wre_sandbox::graph::BUNDLED_ID).expect("the bundled graph loads");
    let page = GraphPage { url: "https://shop.example/basket".into(), frames: 0, ..GraphPage::default() };
    let hooks = Hooks { transport: Arc::new(Quiet), cookies: Arc::new(Jar) };
    let options = RealmOptions { timeout: Duration::from_secs(30), timers: false, codecs: false, clock_ms: None, random_seed: None, heap_limit_mb: None };
    open(&profile, &page, hooks, options).expect("the sandbox opened")
}

/// Runs `script`, which leaves its answer in `__got`, and reads it back as JSON.
fn answer(script: &str) -> Value {
    let mut graph = realm();
    graph.eval(&format!("globalThis.__got = null; {script}"), "https://shop.example/app.js").expect("the page script ran");
    graph.step().expect("the realm steps");
    let got = graph.read("JSON.stringify(__got)").expect("read");
    serde_json::from_str(got.as_str().unwrap_or("null")).unwrap_or(Value::Null)
}

/// Kasada appends an element to a document it makes itself; Chrome adopts it (and lower-cases
/// its tagName, since that document is not HTML), where the sandbox used to throw.
#[test]
fn a_script_made_document_takes_an_element() {
    let got = answer(
        r#"
        var d = new Document();
        var input = document.createElement('input');
        d.appendChild(input);
        var refused;
        try { d.appendChild(document.createElement('b')); } catch (e) { refused = e.name + ': ' + e.message; }
        __got = [Object.prototype.toString.call(d), input.ownerDocument === d, input.nodeName, d.documentElement === input, refused];
        "#,
    );
    assert_eq!(
        got,
        json!([
            "[object Document]",
            true,
            "input",
            true,
            "HierarchyRequestError: Failed to execute 'appendChild' on 'Node': Only one element on document allowed."
        ])
    );
}

/// innerHTML runs the WHATWG parser: text in a table is foster-parented (Kasada's `jdo`), cells get
/// their implied tbody and tr, entities decode, and serialization escapes as Chrome does.
#[test]
fn markup_parses_and_serializes_as_chrome() {
    let got = answer(
        r#"
        var d = document.createElement('div');
        var out = [];
        d.innerHTML = '123<table></table>'; out.push(d.innerHTML);
        d.innerHTML = '<table><tr><td>1<td>2</table>'; out.push(d.innerHTML);
        d.innerHTML = '<a title="&quot;<x>">&amp;&nbsp;&copy;</a>'; out.push(d.innerHTML);
        d.innerHTML = '<svg viewbox="0 0 1 1"><foreignobject></foreignobject></svg>'; out.push(d.innerHTML, d.firstChild.namespaceURI);
        var t = document.createElement('template'); t.innerHTML = '<p>x</p>'; out.push(t.childNodes.length, t.content.firstChild.nodeName);
        __got = out;
        "#,
    );
    assert_eq!(
        got,
        json!([
            "123<table></table>",
            "<table><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
            "<a title=\"&quot;&lt;x&gt;\">&amp;&nbsp;©</a>",
            "<svg viewBox=\"0 0 1 1\"><foreignObject></foreignObject></svg>",
            "http://www.w3.org/2000/svg",
            0,
            "P"
        ])
    );
}

#[test]
fn selectors_match_and_refuse_as_chrome() {
    let got = answer(
        r#"
        var d = document.createElement('div');
        d.innerHTML = '<ul><li id=a class="x y">1</li><li>2<span title="Hi There">s</span></li></ul><p>q</p>';
        var ids = function (list) { return Array.prototype.map.call(list, function (n) { return n.id || n.nodeName; }).join(); };
        var bad;
        try { d.querySelector('x['); } catch (e) { bad = e.name + ': ' + e.message; }
        var bad2;
        try { d.querySelectorAll(':contains(1)'); } catch (e) { bad2 = e.name; }
        __got = [ids(d.querySelectorAll('ul > li + li')), ids(d.querySelectorAll('li:not(.x)')), ids(d.querySelectorAll('[title="hi there" i]')),
                 ids(d.querySelectorAll(':scope > p')), d.querySelector('#a').matches('ul li.y'), d.querySelector('span').closest('ul').nodeName,
                 d.querySelectorAll('p::before').length, Object.prototype.toString.call(d.querySelectorAll('li')), bad, bad2];
        "#,
    );
    assert_eq!(
        got,
        json!([
            "LI",
            "LI",
            "SPAN",
            "P",
            true,
            "UL",
            0,
            "[object NodeList]",
            "SyntaxError: Failed to execute 'querySelector' on 'Element': 'x[' is not a valid selector.",
            "SyntaxError"
        ])
    );
}

#[test]
fn documents_parse_clone_and_compare() {
    let got = answer(
        r#"
        var html = new DOMParser().parseFromString('<p id=q>hi<b>x</p>', 'text/html');
        var xml = new DOMParser().parseFromString('<a x="1"><b/></a>', 'application/xml');
        var made = document.implementation.createHTMLDocument('T');
        var d = document.createElement('div'); d.innerHTML = '<i a=1>x<!--c--><b>y</b></i>';
        var c = d.cloneNode(true);
        __got = [html.body.innerHTML, html.compatMode, html.getElementById('q').nodeName, Object.prototype.toString.call(xml), xml.documentElement.firstChild.nodeName,
                 made.title, made.documentElement.outerHTML, c.innerHTML, c.firstChild !== d.firstChild, c.isEqualNode(d),
                 d.firstChild.compareDocumentPosition(d), document.importNode(made.body, true).ownerDocument === document];
        "#,
    );
    assert_eq!(
        got,
        json!([
            "<p id=\"q\">hi<b>x</b></p>",
            "BackCompat",
            "P",
            "[object XMLDocument]",
            "b",
            "T",
            "<html><head><title>T</title></head><body></body></html>",
            "<i a=\"1\">x<!--c--><b>y</b></i>",
            true,
            true,
            10,
            true
        ])
    );
}
