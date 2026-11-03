use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use flate2::read::GzDecoder;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use wre_core::error::{Error, Result};
use wre_live::realm::{Control, Realm, RealmOptions};

use crate::browser::{Hooks, Request};
use crate::install::Misses;

const BRIDGE: &str = include_str!("../assets/graph/bridge.js");
const BOOTSTRAP: &str = include_str!("../assets/graph/bootstrap.js");
const DOM: &str = include_str!("../assets/graph/dom.js");
/// Platform modules on top of the DOM, each one family of browser behaviour.
/// web-streams-polyfill (MIT, vendored unchanged), the WHATWG Streams engine `streams.js` keeps
/// behind the page's own stream interfaces. Evaluated as a CommonJS module, so it leaves no global.
const STREAMS_ENGINE: &str = include_str!("../assets/graph/vendor/web-streams-polyfill-4.3.0.js");
static STREAMS_ENGINE_STEP: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "(function () {{ var exports = {{}}; var module = {{ exports: exports }}; var define;\n{STREAMS_ENGINE}\n;globalThis.__ENV.streamsEngine = exports; }})();"
    )
});
/// parse5 (MIT), css-select (BSD-2-Clause) and saxes (ISC), vendored as bundled CommonJS modules: the WHATWG
/// HTML parser and serializer, and the CSS selector engine the DOM runs on. Each is wrapped in a
/// factory the DOM calls on first use, so a realm that never parses HTML or matches a selector
/// only pays for compiling them.
const HTML_ENGINE: &str = include_str!("../assets/graph/vendor/parse5-8.1.0.js");
const SELECTOR_ENGINE: &str = include_str!("../assets/graph/vendor/css-select-7.0.0.js");
/// saxes (ISC), the XML parser behind DOMParser's XML types.
const XML_ENGINE: &str = include_str!("../assets/graph/vendor/saxes-6.0.0.js");
static DOM_ENGINES_STEP: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "(function () {{ var load = function (body) {{ var cached; return function () {{ if (!cached) {{ var module = {{ exports: {{}} }}; body(module, module.exports); cached = module.exports; }} return cached; }}; }};
         globalThis.__ENV.htmlEngine = load(function (module, exports) {{ var define;\n{HTML_ENGINE}\n}});
         globalThis.__ENV.selectorEngine = load(function (module, exports) {{ var define;\n{SELECTOR_ENGINE}\n}});
         globalThis.__ENV.xmlEngine = load(function (module, exports) {{ var define;\n{XML_ENGINE}\n}}); }})();"
    )
});
const STREAMS: &str = include_str!("../assets/graph/streams.js");
/// Structured clone, message ports and broadcast channels, shared by windows, frames and workers.
const CHANNELS: &str = include_str!("../assets/graph/channels.js");
const MESSAGING: &str = include_str!("../assets/graph/messaging.js");
const ELEMENTS: &str = include_str!("../assets/graph/elements.js");
const PLATFORM: &str = include_str!("../assets/graph/platform.js");
/// What Chrome's build (not the machine) answers to the platform's probes: platform.js's defaults
/// for a profile whose capture predates its own `traits.platform`.
const PLATFORM_DEFAULTS: &str = include_str!("../assets/graph/platform-defaults.json");
static PLATFORM_DEFAULTS_STEP: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| format!("globalThis.__ENV.platformDefaults = {PLATFORM_DEFAULTS};"));
/// Which interfaces Chrome lets a page construct (a Chrome-build fact; see bootstrap.js).
const CONSTRUCTORS: &str = include_str!("../assets/graph/constructors.json");
static CONSTRUCTORS_STEP: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| format!("globalThis.__CONSTRUCTORS = {CONSTRUCTORS};"));
/// The last step: every function the modules replaced takes Chrome's name and length back.
const SEAL_SHAPES: &str = "globalThis.__ENV.sealShapes(); globalThis.__ENV.finishWindow();";
const CONTROL: &str = include_str!("../assets/graph/control.js");
/// A dedicated worker's realm (see worker.js), built from Chrome's worker global as
/// assets/worker-capture.js records it.
const WORKER: &str = include_str!("../assets/graph/worker.js");
const WORKER_SHAPE: &[u8] = include_bytes!("../assets/graph/worker-shape.json.gz");

/// The bundled worker shape, as JSON text (decompressed once).
fn worker_shape() -> &'static str {
    static SHAPE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SHAPE.get_or_init(|| {
        let mut text = String::new();
        GzDecoder::new(WORKER_SHAPE).read_to_string(&mut text).expect("the bundled worker shape is gzipped JSON");
        text
    })
}

include!(concat!(env!("OUT_DIR"), "/bundled_graphs.rs"));

pub const BUNDLED_ID: &str = "macos-chrome-151";

/// The most tasks one [`Graph::step`] runs, so a page that floods its task queue still hands
/// control back to the host.
const MAX_TASKS_PER_STEP: usize = 4096;

pub fn bundled_ids() -> Vec<String> {
    BUNDLED_GRAPHS.iter().map(|(id, _)| (*id).to_string()).collect()
}

pub fn is_bundled(id: &str) -> bool {
    BUNDLED_GRAPHS.iter().any(|(known, _)| *known == id)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Tables {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traits: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shapes: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webgl: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graphics: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<Value>,
}

fn zero_box() -> Value {
    json!({
        "clientWidth": 0,
        "clientHeight": 0,
        "scrollWidth": 0,
        "scrollHeight": 0,
        "offsetWidth": 0,
        "offsetHeight": 0,
    })
}

impl Tables {
    pub fn get(&self, name: &str) -> Option<&Value> {
        match name {
            "traits" => self.traits.as_ref(),
            "layout" => self.layout.as_ref(),
            "style" => self.style.as_ref(),
            "media" => self.media.as_ref(),
            "shapes" => self.shapes.as_ref(),
            "timing" => self.timing.as_ref(),
            "webgl" => self.webgl.as_ref(),
            "graphics" => self.graphics.as_ref(),
            "viewport" => self.viewport.as_ref(),
            _ => None,
        }
    }

    pub fn flattened(&self) -> Self {
        let mut out = self.clone();

        if out.viewport.is_some() {
            out.viewport = Some(json!({
                "view": {
                    "innerWidth": 0,
                    "innerHeight": 0,
                    "visualViewportWidth": 0,
                    "visualViewportHeight": 0,
                },
                "documentElement": zero_box(),
                "body": zero_box(),
            }));
        }

        out
    }

    pub fn present(&self) -> Vec<&'static str> {
        [
            ("traits", self.traits.is_some()),
            ("layout", self.layout.is_some()),
            ("style", self.style.is_some()),
            ("media", self.media.is_some()),
            ("shapes", self.shapes.is_some()),
            ("timing", self.timing.is_some()),
            ("webgl", self.webgl.is_some()),
            ("graphics", self.graphics.is_some()),
            ("viewport", self.viewport.is_some()),
        ]
        .into_iter()
        .filter(|(_, held)| *held)
        .map(|(name, _)| name)
        .collect()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GraphProfile {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub captured_at: String,
    #[serde(default)]
    pub href: String,
    #[serde(default)]
    pub user_agent: String,
    pub snapshot: Value,
    #[serde(default)]
    pub tables: Tables,
}

impl GraphProfile {
    pub fn objects(&self) -> usize {
        self.snapshot
            .get("objects")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default()
    }

    pub fn read(path: impl AsRef<std::path::Path>) -> Result<Self> {
        let path = path.as_ref();
        let raw = std::fs::read(path)
            .map_err(|error| Error::msg(format!("{}: {error}", path.display())))?;

        let mut profile = Self::parse(&raw)
            .map_err(|error| Error::msg(format!("{}: {error}", path.display())))?;

        if profile.id.is_empty() {
            profile.id = profile_id(path);
        }

        Ok(profile)
    }

    pub fn bundled(id: &str) -> Result<Self> {
        let (_, packed) = BUNDLED_GRAPHS
            .iter()
            .find(|(known, _)| *known == id)
            .ok_or_else(|| Error::msg(format!("no bundled graph profile {id}")))?;

        let mut profile = Self::parse(packed)
            .map_err(|error| Error::msg(format!("the bundled graph {id} did not load: {error}")))?;

        if profile.id.is_empty() {
            profile.id = id.to_string();
        }

        Ok(profile)
    }

    /// A profile from its JSON, gzipped or not, as `wre sandbox capture --graph` stores it.
    pub fn parse(raw: &[u8]) -> Result<Self> {
        let text = if raw.starts_with(&[0x1f, 0x8b]) {
            let mut decoded = String::new();
            GzDecoder::new(raw)
                .read_to_string(&mut decoded)
                .map_err(|error| Error::msg(format!("gzip: {error}")))?;
            decoded
        } else {
            String::from_utf8(raw.to_vec())
                .map_err(|error| Error::msg(format!("not utf-8: {error}")))?
        };

        serde_json::from_str(&text).map_err(|error| Error::msg(error.to_string()))
    }
}

fn profile_id(path: &std::path::Path) -> String {
    let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();

    name.strip_suffix(".json.gz")
        .or_else(|| name.strip_suffix(".json"))
        .unwrap_or(&name)
        .to_string()
}

#[derive(Debug, Clone, Default)]
pub struct GraphLibrary {
    paths: Vec<(String, std::path::PathBuf)>,
}

fn safe(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();

    let trimmed = cleaned.trim_matches('-').to_lowercase();

    if trimmed.is_empty() {
        "profile".to_string()
    } else {
        trimmed
    }
}

impl GraphLibrary {
    pub fn load(dir: impl AsRef<std::path::Path>) -> Result<Self> {
        let dir = dir.as_ref();
        let mut paths = Vec::new();

        if dir.is_dir() {
            let listing = std::fs::read_dir(dir)
                .map_err(|error| Error::msg(format!("{}: {error}", dir.display())))?;

            for entry in listing.flatten() {
                let path = entry.path();
                let name = path.file_name().map(|name| name.to_string_lossy().to_string());

                let Some(name) = name else {
                    continue;
                };

                if !name.ends_with(".json") && !name.ends_with(".json.gz") {
                    continue;
                }

                paths.push((profile_id(&path), path));
            }
        }

        paths.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(Self { paths })
    }

    pub fn ids(&self) -> Vec<String> {
        self.paths.iter().map(|(id, _)| id.clone()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    pub fn dir(&self) -> Option<&std::path::Path> {
        self.paths.first().and_then(|(_, path)| path.parent())
    }

    pub fn store(
        dir: impl AsRef<std::path::Path>,
        profile: &GraphProfile,
        force: bool,
    ) -> Result<std::path::PathBuf> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)
            .map_err(|error| Error::msg(format!("{}: {error}", dir.display())))?;

        let path = dir.join(format!("{}.json", safe(&profile.id)));

        if path.exists() && !force {
            return Err(Error::msg(format!(
                "{} is already there; pass --force to replace it",
                path.display()
            )));
        }

        let text = serde_json::to_string(profile)
            .map_err(|error| Error::msg(format!("the graph did not serialise: {error}")))?;

        std::fs::write(&path, text)
            .map_err(|error| Error::msg(format!("{}: {error}", path.display())))?;

        Ok(path)
    }

    pub fn resolve(&self, wanted: Option<&str>) -> Result<GraphProfile> {
        let chosen = match wanted {
            Some(id) => match self.paths.iter().find(|(known, _)| known == id) {
                Some(found) => found,
                None if is_bundled(id) => return GraphProfile::bundled(id),
                None => {
                    let mut known = self.ids();
                    known.extend(bundled_ids());
                    return Err(Error::msg(format!("no graph profile {id}; have {known:?}")));
                }
            },
            None => match self.paths.first() {
                Some(found) => found,
                None => return GraphProfile::bundled(BUNDLED_ID),
            },
        };

        GraphProfile::read(&chosen.1)
    }
}

#[derive(Debug, Clone)]
pub struct GraphPage {
    pub url: String,
    pub referrer: String,
    pub entries: Vec<Value>,
    pub frames: usize,
    pub capture_cipher: bool,
}

impl Default for GraphPage {
    fn default() -> Self {
        Self {
            url: "about:blank".to_string(),
            referrer: String::new(),
            entries: Vec::new(),
            frames: 4,
            capture_cipher: false,
        }
    }
}

pub struct Graph {
    realm: Realm,
    control: Control,
    misses: Misses,
    requests: Arc<Mutex<Vec<Request>>>,
    started: Instant,
    workers: WorkerHosts,
    network: Arc<Network>,
}

/// The realm's network, as a browser's is: each request goes out on its own thread while the
/// page keeps running, and its answer comes back as a task. The host waits on it (`Graph::idle`)
/// rather than sleeping blind, and other threads can wake it (`Graph::waker`).
#[derive(Default)]
struct Network {
    next: std::sync::atomic::AtomicU64,
    in_flight: std::sync::atomic::AtomicUsize,
    /// Bumped whenever an answer arrives or the host is woken; `idle` waits for it to move.
    generation: Mutex<u64>,
    changed: std::sync::Condvar,
}

impl Network {
    fn bump(&self) {
        let mut generation = self.generation.lock().unwrap_or_else(|error| error.into_inner());
        *generation = generation.wrapping_add(1);
        self.changed.notify_all();
    }
}

/// Wakes a realm that is idling (`Graph::idle`), from any thread: for a host that hands the realm
/// work through a channel.
#[derive(Clone)]
pub struct Waker(Arc<Network>);

impl Waker {
    pub fn wake(&self) {
        self.0.bump();
    }
}

/// One realm's answered requests, waiting for its pump to deliver them.
type Inbox = Arc<Mutex<std::collections::VecDeque<(u64, crate::browser::Answer)>>>;

/// What a worker's realm reaches the host through: the page's clock, transport and records.
#[derive(Clone)]
struct WorkerHosts {
    clock: Instant,
    misses: Misses,
    transport: Arc<dyn crate::browser::Transport>,
    recorded: Arc<Mutex<Vec<Request>>>,
}

/// A URL's parts as the WHATWG URL interface reads them, or null when it does not parse.
fn url_parts(input: &str, base: Option<&str>) -> Value {
    let parsed = match base {
        Some(base) => url::Url::parse(base).and_then(|base| base.join(input)),
        None => url::Url::parse(input),
    };
    let Ok(url) = parsed else {
        return Value::Null;
    };
    let host = match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => String::new(),
    };
    json!({
        "href": url.as_str(),
        "origin": url.origin().ascii_serialization(),
        "protocol": format!("{}:", url.scheme()),
        "username": url.username(),
        "password": url.password().unwrap_or_default(),
        "host": host,
        "hostname": url.host_str().unwrap_or_default(),
        "port": url.port().map(|port| port.to_string()).unwrap_or_default(),
        "pathname": url.path(),
        "search": url.query().filter(|query| !query.is_empty()).map(|query| format!("?{query}")).unwrap_or_default(),
        "hash": url.fragment().filter(|fragment| !fragment.is_empty()).map(|fragment| format!("#{fragment}")).unwrap_or_default(),
    })
}

/// The host functions worker.js takes (`__wreW_*`), registered in a worker's realm.
fn install_worker_hosts(realm: &mut Realm, index: usize, hosts: &WorkerHosts) -> Result<()> {
    let clock = hosts.clock;
    realm.register_host_in(index, "__wreW_now", Box::new(move |_args| Ok(json!(clock.elapsed().as_secs_f64() * 1000.0))))?;
    realm.register_host_in(
        index,
        "__wreW_entropy",
        Box::new(|args| {
            let wanted = args.first().and_then(Value::as_u64).unwrap_or_default() as usize;
            let mut bytes = vec![0u8; wanted.min(65_536)];
            rand::rng().fill(&mut bytes[..]);
            Ok(json!(STANDARD.encode(bytes)))
        }),
    )?;
    realm.register_host_in(index, "__wreW_uuid", Box::new(|_args| Ok(json!(uuid()))))?;
    realm.register_host_in(
        index,
        "__wreW_digest",
        Box::new(|args| {
            let algorithm = args.first().and_then(Value::as_str).unwrap_or_default();
            let encoded = args.get(1).and_then(Value::as_str).unwrap_or_default();
            let Ok(bytes) = STANDARD.decode(encoded) else {
                return Ok(Value::Null);
            };
            Ok(match crate::host::digest_of(algorithm, &bytes) {
                Some(out) => json!(STANDARD.encode(out)),
                None => Value::Null,
            })
        }),
    )?;
    let transport = Arc::clone(&hosts.transport);
    let recorded = Arc::clone(&hosts.recorded);
    realm.register_host_in(
        index,
        "__wreW_send",
        Box::new(move |args| {
            let raw = args.first().cloned().unwrap_or(Value::Null);
            let request: Request =
                serde_json::from_value(raw).map_err(|error| Error::msg(format!("a worker sent a bad request: {error}")))?;
            recorded.lock().unwrap_or_else(|error| error.into_inner()).push(request.clone());
            let answer = transport.send(&request);
            serde_json::to_value(answer).map_err(|error| Error::msg(format!("the answer did not serialise: {error}")))
        }),
    )?;
    realm.register_host_in(
        index,
        "__wreW_url",
        Box::new(|args| {
            let input = args.first().and_then(Value::as_str).unwrap_or_default();
            Ok(url_parts(input, args.get(1).and_then(Value::as_str)))
        }),
    )?;
    // A sync access handle's flush is an fsync: on a real disk it takes a fraction of a
    // millisecond or more, never no time at all.
    realm.register_host_in(
        index,
        "__wreW_flush",
        Box::new(|_args| {
            std::thread::sleep(std::time::Duration::from_micros(rand::rng().random_range(350..1400)));
            Ok(Value::Null)
        }),
    )?;
    let watcher = hosts.misses.clone();
    realm.register_host_in(
        index,
        "__wreW_miss",
        Box::new(move |args| {
            if let Some(text) = args.first().and_then(Value::as_str) {
                watcher.record(text);
            }
            Ok(Value::Null)
        }),
    )?;
    Ok(())
}

#[derive(Clone)]
struct Bridges {
    snapshot: String,
    tables: Tables,
    clock: Instant,
    entries: Vec<Value>,
    misses: Misses,
    transport: Arc<dyn crate::browser::Transport>,
    recorded: Arc<Mutex<Vec<Request>>>,
    network: Arc<Network>,
    /// The host's cookie jar, which `document.cookie` reads and writes, as a page's does.
    cookies: Arc<dyn crate::browser::CookieStore>,
}

fn install_hosts(
    realm: &mut Realm,
    frame: Option<usize>,
    shared: &Bridges,
    page: Value,
) -> Result<()> {
    let register = |realm: &mut Realm, name: &str, host: wre_live::realm::HostFn| match frame {
        None => realm.register_host(name, host),
        Some(index) => realm.register_host_in(index, name, host),
    };

    let snapshot = shared.snapshot.clone();
    register(
        realm,
        "__wreGraphSnapshot",
        Box::new(move |_args| Ok(json!(snapshot.clone()))),
    )?;

    let tables = shared.tables.clone();
    register(
        realm,
        "__wreGraphTable",
        Box::new(move |args| {
            let name = args.first().and_then(Value::as_str).unwrap_or_default();

            Ok(match tables.get(name) {
                Some(found) => json!(serde_json::to_string(found).unwrap_or_default()),
                None => Value::Null,
            })
        }),
    )?;

    let clock = shared.clock;
    register(
        realm,
        "__wreGraphNow",
        Box::new(move |_args| Ok(json!(clock.elapsed().as_secs_f64() * 1000.0))),
    )?;

    register(
        realm,
        "__wreGraphEntropy",
        Box::new(|args| {
            let wanted = args.first().and_then(Value::as_u64).unwrap_or_default() as usize;
            let mut bytes = vec![0u8; wanted.min(65_536)];
            rand::rng().fill(&mut bytes[..]);
            Ok(json!(STANDARD.encode(bytes)))
        }),
    )?;

    register(realm, "__wreGraphUuid", Box::new(|_args| Ok(json!(uuid()))))?;

    register(realm, "__wreGraphWorkerShape", Box::new(|_args| Ok(json!(worker_shape()))))?;
    register(
        realm,
        "__wreGraphUrl",
        Box::new(|args| {
            let input = args.first().and_then(Value::as_str).unwrap_or_default();
            Ok(url_parts(input, args.get(1).and_then(Value::as_str)))
        }),
    )?;

    register(realm, "__wreGraphCodec", crate::codec::host())?;

    register(
        realm,
        "__wreGraphDigest",
        Box::new(|args| {
            let algorithm = args.first().and_then(Value::as_str).unwrap_or_default();
            let encoded = args.get(1).and_then(Value::as_str).unwrap_or_default();

            let Ok(bytes) = STANDARD.decode(encoded) else {
                return Ok(Value::Null);
            };

            Ok(match crate::host::digest_of(algorithm, &bytes) {
                Some(out) => json!(STANDARD.encode(out)),
                None => Value::Null,
            })
        }),
    )?;

    // SubtleCrypto's math (`crate::subtle`): bytes travel as base64; the answer is the output's
    // base64, or `{"failed": why}` for Chrome's OperationError.
    register(
        realm,
        "__wreGraphSubtle",
        Box::new(|args| {
            let op = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
            let fields = args.get(1).cloned().unwrap_or(Value::Null);
            let bytes = |name: &str| {
                fields.get(name).and_then(Value::as_str).and_then(|text| STANDARD.decode(text).ok()).unwrap_or_default()
            };

            Ok(match crate::subtle::run(&op, &fields, &bytes) {
                Ok(out) => json!(STANDARD.encode(out)),
                Err(crate::subtle::Failed(why)) => json!({ "failed": why }),
            })
        }),
    )?;

    // A blank canvas's PNG, for sizes the capture holds no Chrome encoding of.
    register(
        realm,
        "__wreGraphBlankPng",
        Box::new(|args| {
            let width = args.first().and_then(Value::as_u64).unwrap_or(1).clamp(1, 32_767) as u32;
            let height = args.get(1).and_then(Value::as_u64).unwrap_or(1).clamp(1, 32_767) as u32;
            Ok(json!(STANDARD.encode(crate::subtle::blank_png(width, height))))
        }),
    )?;

    let entries = shared.entries.clone();
    register(
        realm,
        "__wreGraphEntries",
        Box::new(move |args| {
            let wanted = args.first().and_then(Value::as_str).unwrap_or_default();
            let matching: Vec<&Value> = entries
                .iter()
                .filter(|entry| entry.get("entryType").and_then(Value::as_str) == Some(wanted))
                .collect();

            Ok(json!(
                serde_json::to_string(&matching).unwrap_or_else(|_| "[]".to_string())
            ))
        }),
    )?;

    register(
        realm,
        "__wreGraphPage",
        Box::new(move |_args| Ok(page.clone())),
    )?;

    let support = shared
        .tables
        .media
        .clone()
        .unwrap_or_else(|| json!({ "video": {}, "audio": {} }));
    let watcher = shared.misses.clone();

    register(
        realm,
        "__wreGraphMedia",
        Box::new(move |args| {
            let wanted = args.first().and_then(Value::as_str).unwrap_or_default();

            for family in ["video", "audio"] {
                if let Some(answer) = support.get(family).and_then(|table| table.get(wanted)) {
                    return Ok(answer.clone());
                }
            }

            watcher.record(&format!("canPlayType({wanted})"));
            Ok(json!(""))
        }),
    )?;

    let transport = Arc::clone(&shared.transport);
    let recorded = Arc::clone(&shared.recorded);

    register(
        realm,
        "__wreGraphSend",
        Box::new(move |args| {
            let raw = args.first().cloned().unwrap_or(Value::Null);
            let request: Request = serde_json::from_value(raw)
                .map_err(|error| Error::msg(format!("the sandbox sent a bad request: {error}")))?;

            {
                let mut list = recorded.lock().unwrap_or_else(|error| error.into_inner());
                list.push(request.clone());
            }

            let answer = transport.send(&request);
            serde_json::to_value(answer)
                .map_err(|error| Error::msg(format!("the answer did not serialise: {error}")))
        }),
    )?;

    // Sends a request on its own thread and answers at once with a ticket; the answer arrives in
    // this realm's inbox, which `__wreGraphArrived` empties.
    let inbox: Inbox = Arc::default();
    let transport = Arc::clone(&shared.transport);
    let recorded = Arc::clone(&shared.recorded);
    let network = Arc::clone(&shared.network);
    let posted = Arc::clone(&inbox);
    register(
        realm,
        "__wreGraphSendLater",
        Box::new(move |args| {
            let raw = args.first().cloned().unwrap_or(Value::Null);
            let request: Request = serde_json::from_value(raw)
                .map_err(|error| Error::msg(format!("the sandbox sent a bad request: {error}")))?;

            recorded.lock().unwrap_or_else(|error| error.into_inner()).push(request.clone());

            let ticket = network.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            network.in_flight.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let (transport, network, posted) = (Arc::clone(&transport), Arc::clone(&network), Arc::clone(&posted));
            std::thread::Builder::new()
                .name("wre-request".into())
                .spawn(move || {
                    let answer = transport.send(&request);
                    posted.lock().unwrap_or_else(|error| error.into_inner()).push_back((ticket, answer));
                    network.in_flight.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                    network.bump();
                })
                .map_err(|error| Error::msg(format!("the request could not start: {error}")))?;
            Ok(json!(ticket))
        }),
    )?;

    register(
        realm,
        "__wreGraphArrived",
        Box::new(move |_args| {
            let arrived: Vec<Value> = inbox
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .drain(..)
                .map(|(ticket, answer)| json!([ticket, answer]))
                .collect();
            Ok(Value::Array(arrived))
        }),
    )?;

    let jar = Arc::clone(&shared.cookies);
    register(realm, "__wreGraphCookieRead", Box::new(move |_args| Ok(json!(jar.read()))))?;
    let jar = Arc::clone(&shared.cookies);
    register(
        realm,
        "__wreGraphCookieWrite",
        Box::new(move |args| {
            jar.write(args.first().and_then(Value::as_str).unwrap_or_default());
            Ok(Value::Null)
        }),
    )?;

    let watcher = shared.misses.clone();
    register(
        realm,
        "__wreGraphMiss",
        Box::new(move |args| {
            if let Some(text) = args.first().and_then(Value::as_str) {
                watcher.record(text);
            }
            Ok(Value::Null)
        }),
    )?;

    Ok(())
}

const NATIVE: [(&str, &str); 2] = [
    ("Document.prototype", "createElement"),
    ("Permissions.prototype", "query"),
];

const SOURCES: &str = "globalThis.__SOURCES = new WeakMap(); globalThis.__NODES = new WeakMap();";

/// What every realm of the page shares (bridge.js takes it as `bridge.shared`): worker start
/// requests, broadcast channels, the origin private file system.
const SHARED: &str = "globalThis.__wreShared = { workers: [], broadcast: new Map(), opfs: null };";

const SEED: &str =
    "globalThis.__SNAPSHOT = __wreGraphSnapshot(); delete globalThis.__wreGraphSnapshot;";
const EVALUATE: &str = "__ENV.evaluate = function (source) { return (0, eval)(source); };";

fn install_environment(realm: &mut Realm, frame: Option<usize>, capture: bool) -> Result<()> {
    let steps = [
        (SEED, ""),
        (BRIDGE, ""),
        (CONSTRUCTORS_STEP.as_str(), ""),
        (BOOTSTRAP, ""),
        (TABLES, ""),
        (
            if capture {
                "__ENV.captureCipher = true;"
            } else {
                ""
            },
            "",
        ),
        (DOM_ENGINES_STEP.as_str(), ""),
        (DOM, ""),
        (STREAMS_ENGINE_STEP.as_str(), ""),
        (STREAMS, ""),
        (CHANNELS, ""),
        (MESSAGING, ""),
        (ELEMENTS, ""),
        (PLATFORM_DEFAULTS_STEP.as_str(), ""),
        (PLATFORM, ""),
        (SEAL_SHAPES, ""),
        (EVALUATE, ""),
    ];

    for (source, name) in steps {
        if source.is_empty() {
            continue;
        }

        match frame {
            None => realm.eval_unit(source, name)?,
            Some(index) => realm.eval_unit_in(index, source, name)?,
        }
    }

    let ready = match frame {
        None => realm.eval_json("[typeof globalThis.__ENV, typeof globalThis.__PUMP].join()")?,
        Some(index) => realm.eval_json_in(
            index,
            "[typeof globalThis.__ENV, typeof globalThis.__PUMP].join()",
        )?,
    };

    if ready.as_str() != Some("object,object") {
        return Err(Error::msg(format!(
            "the graph environment did not finish installing: __ENV and __PUMP read {ready}"
        )));
    }

    Ok(())
}

pub fn open(
    profile: &GraphProfile,
    page: &GraphPage,
    hooks: Hooks,
    options: RealmOptions,
) -> Result<Graph> {
    let mut realm = Realm::new(RealmOptions {
        timers: false,
        codecs: false,
        ..options
    })?;
    let misses = Misses::default();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let started = Instant::now();

    let shared = Bridges {
        snapshot: serde_json::to_string(&profile.snapshot)
            .map_err(|error| Error::msg(format!("the graph did not serialise: {error}")))?,
        tables: profile.tables.clone(),
        clock: started,
        entries: page.entries.clone(),
        misses: misses.clone(),
        transport: Arc::clone(&hooks.transport),
        recorded: Arc::clone(&requests),
        network: Arc::new(Network::default()),
        cookies: Arc::clone(&hooks.cookies),
    };

    let framed = Bridges {
        tables: shared.tables.flattened(),
        ..shared.clone()
    };

    realm.eval_unit(SOURCES, "")?;
    realm.eval_unit(SHARED, "")?;

    for slot in 0..page.frames {
        let index = realm.open_frame()?;
        realm.share_into(index, "globalThis.__SOURCES", "__SOURCES")?;
        realm.share_into(index, "globalThis.__NODES", "__NODES")?;
        realm.share_into(index, "globalThis.__wreShared", "__wreShared")?;

        install_hosts(
            &mut realm,
            Some(index),
            &framed,
            json!({ "url": "about:blank", "referrer": page.url }),
        )?;

        realm.eval_unit_in(index, "globalThis.__FRAME = true;", "")?;
        install_environment(&mut realm, Some(index), false)?;

        realm.share_global(index, None, &format!("__wreFrameView{slot}"))?;
        realm.share_value(index, "globalThis.__ENV", &format!("__wreFrameEnv{slot}"))?;
        realm.share_value(index, "globalThis.__PUMP", &format!("__wreFramePump{slot}"))?;
        realm.eval_unit_in(
            index,
            "delete globalThis.__ENV; delete globalThis.__PUMP;",
            "",
        )?;
    }

    realm.set_global("__wreFrameCount", &json!(page.frames))?;

    install_hosts(
        &mut realm,
        None,
        &shared,
        json!({ "url": page.url, "referrer": page.referrer }),
    )?;

    install_environment(&mut realm, None, page.capture_cipher)?;

    for (holder, key) in NATIVE {
        if realm.make_native(holder, key, Some(key)).is_err() {
            misses.record(&format!("{holder}.{key} could not be rebuilt as native"));
        }
    }

    let control = realm.attach(CONTROL, "")?;

    let workers = WorkerHosts {
        clock: started,
        misses: misses.clone(),
        transport: Arc::clone(&hooks.transport),
        recorded: Arc::clone(&requests),
    };

    Ok(Graph {
        realm,
        control,
        misses,
        requests,
        started,
        workers,
        network: Arc::clone(&shared.network),
    })
}

const TABLES: &str = r#"
(function () {
  var read = function (name) {
    var raw = __wreGraphTable(name);
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (error) { return null; }
  };

  var layout = read("layout");
  if (layout) __ENV.layout = layout;

  var timing = read("timing");
  if (timing) __ENV.useTiming(timing);

  var shapes = read("shapes");
  if (shapes) __ENV.shapes = shapes;

  var media = read("media");
  if (media) __ENV.media = media;

  var style = read("style");
  if (style) __ENV.styleShape = style;

  var graphics = read("graphics");
  if (graphics) __ENV.graphicsReplies = graphics;

  var webgl = read("webgl");
  if (webgl) __ENV.webglProfiles = webgl;

  var viewport = read("viewport");
  if (viewport) __ENV.viewport = viewport;

  var traits = read("traits");
  if (traits) __ENV.traits = traits;

  delete globalThis.__wreGraphTable;
})();
"#;

fn uuid() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill(&mut bytes[..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

impl Graph {
    pub fn realm(&mut self) -> &mut Realm {
        &mut self.realm
    }

    pub fn elapsed_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    pub fn run(&mut self, source: &str, name: &str, inline: bool) -> Result<Option<Value>> {
        self.realm
            .invoke(&self.control, "begin", &[json!(name), json!(inline)])?;

        let outcome = self.realm.eval_unit(source, name);

        self.realm.invoke(&self.control, "end", &[])?;

        Ok(match outcome {
            Ok(()) => None,
            Err(error) => Some(json!({ "message": error.to_string() })),
        })
    }

    pub fn make_native(&mut self, holder: &str, key: &str, name: Option<&str>) -> Result<()> {
        self.realm.make_native(holder, key, name)
    }

    pub fn eval(&mut self, source: &str, name: &str) -> Result<()> {
        self.realm.eval_unit(source, name)
    }

    pub fn read(&mut self, expression: &str) -> Result<Value> {
        self.realm
            .invoke(&self.control, "read", &[json!(expression)])
    }

    /// Runs every task that is due now, one at a time, and says how many ran. Each task is its own
    /// call into the realm, so V8 runs the microtasks a task queues before the next task starts, as
    /// a browser's event loop does. Only what is due when the step begins runs (a timer that keeps
    /// rescheduling itself at once waits for the next step), so a step always ends.
    pub fn step(&mut self) -> Result<usize> {
        self.start_workers()?;
        let until = self.started.elapsed().as_secs_f64() * 1000.0;
        let mut ran = 0;

        while ran < MAX_TASKS_PER_STEP {
            let one = self.realm.invoke(&self.control, "step", &[json!(until)])?;
            match one.as_u64().unwrap_or_default() {
                0 => break,
                2 => self.run_inserted_script()?,
                _ => {}
            }
            ran += 1;
        }

        Ok(ran)
    }

    /// Starts a dedicated worker the page (or a worker) asked for whose script is in hand: it gets
    /// a realm of its own, which the realm that made the Worker binds (building the worker's global
    /// and taking over its event loop), then its script runs there as a classic script under its
    /// own URL, an uncaught exception going to the worker's error reporting. One per step: a
    /// worker shares this thread, so a burst of them starts across steps rather than stalling one.
    fn start_workers(&mut self) -> Result<()> {
        loop {
            let job = self.realm.invoke(&self.control, "takeWorker", &[])?;
            if job.is_null() {
                return Ok(());
            }
            let skipped = self.start_worker(job)?;
            if !skipped {
                return Ok(());
            }
        }
    }

    /// Starts one worker; says whether it was skipped (terminated before its realm was bound).
    fn start_worker(&mut self, job: Value) -> Result<bool> {
        let id = job.get("id").cloned().unwrap_or(Value::Null);
        let url = job.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
        let source = job.get("source").and_then(Value::as_str).unwrap_or_default().to_string();

        let index = self.realm.open_frame()?;
        install_worker_hosts(&mut self.realm, index, &self.workers)?;
        self.realm.eval_unit_in(index, CHANNELS, "")?;
        self.realm.eval_unit_in(index, WORKER, "")?;
        self.realm.share_value(index, "globalThis.__WORKER", "__wreWorkerSlot")?;
        let worker = self.realm.attach_in(index, "globalThis.__WORKER", "worker")?;

        if self.realm.invoke(&self.control, "bindWorker", std::slice::from_ref(&id))? != Value::Bool(true) {
            return Ok(true);
        }

        self.realm.run_script_in(index, &source, &url, &worker, "uncaught")?;
        self.realm.invoke(&self.control, "workerStarted", &[id])?;
        Ok(false)
    }

    /// Runs the script element the page inserted that is ready, as a task of its own: under its own
    /// URL (so its stack frames name it, as a browser's do), then tells the page how it went (its
    /// element hears load, an exception reaches window.onerror).
    fn run_inserted_script(&mut self) -> Result<()> {
        let script = self.realm.invoke(&self.control, "script", &[])?;
        let source = script.get("source").and_then(Value::as_str).unwrap_or_default().to_string();
        let url = script.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
        let failure = self.realm.eval_unit(&source, &url).err().map(|error| error.to_string());
        self.realm.invoke(&self.control, "ran", &[json!(failure)])?;
        Ok(())
    }

    /// Waits until the realm has something to do: a network answer arrives, its next timer falls
    /// due, the host is woken ([`Graph::waker`]), or `longest` passes. Returns at once if a task
    /// is due now. A host's loop is `step`, then `idle`.
    pub fn idle(&mut self, longest: std::time::Duration) -> Result<()> {
        let generation = *self.network.generation.lock().unwrap_or_else(|error| error.into_inner());
        let wait = match self.next_due()? {
            Some(due) => due.min(longest),
            None => longest,
        };
        if wait.is_zero() {
            return Ok(());
        }
        let guard = self.network.generation.lock().unwrap_or_else(|error| error.into_inner());
        if *guard != generation {
            return Ok(());
        }
        let _ = self
            .network
            .changed
            .wait_timeout_while(guard, wait, |now| *now == generation)
            .unwrap_or_else(|error| error.into_inner());
        Ok(())
    }

    /// A handle that wakes this realm from [`Graph::idle`], from any thread.
    pub fn waker(&self) -> Waker {
        Waker(Arc::clone(&self.network))
    }

    /// How many of the realm's requests are still on the wire.
    pub fn in_flight(&self) -> usize {
        self.network.in_flight.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// How long until the realm's next task is due (zero if one is due now), or `None` when it has
    /// nothing scheduled: what a host may sleep before stepping again.
    pub fn next_due(&mut self) -> Result<Option<std::time::Duration>> {
        let due = self.realm.invoke(&self.control, "due", &[])?;
        let Some(at) = due.as_f64() else {
            return Ok(if due.is_null() { None } else { Some(std::time::Duration::ZERO) });
        };
        let now = self.started.elapsed().as_secs_f64() * 1000.0;
        Ok(Some(std::time::Duration::from_secs_f64(((at - now).max(0.0)) / 1000.0)))
    }

    pub fn pending(&mut self) -> Result<usize> {
        let waiting = self.realm.invoke(&self.control, "pending", &[])?;
        Ok(waiting.as_u64().unwrap_or_default() as usize)
    }

    pub fn cookies(&mut self) -> Result<String> {
        let value = self.realm.invoke(&self.control, "cookies", &[])?;
        Ok(value.as_str().unwrap_or_default().to_string())
    }

    pub fn calls(&mut self) -> Result<Value> {
        self.realm.invoke(&self.control, "calls", &[])
    }

    pub fn trail(&mut self) -> Result<Value> {
        self.realm.invoke(&self.control, "trail", &[])
    }

    pub fn log(&mut self) -> Result<Value> {
        self.realm.invoke(&self.control, "log", &[])
    }

    pub fn misses(&mut self) -> Vec<String> {
        let mut out = self.misses.all();
        out.extend(self.counted(false));
        out
    }

    pub fn guards(&mut self) -> Vec<String> {
        self.counted(true)
    }

    fn counted(&mut self, illegal: bool) -> Vec<String> {
        let Ok(Value::Object(fields)) = self.realm.invoke(&self.control, "misses", &[]) else {
            return Vec::new();
        };

        fields
            .into_iter()
            .filter(|(name, _)| name.starts_with("illegal:") == illegal)
            .map(|(name, count)| format!("{} x{count}", name.trim_start_matches("illegal:")))
            .collect()
    }

    pub fn requests(&self) -> Vec<Request> {
        let list = self
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        list.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_graph_loads() {
        let profile = GraphProfile::bundled(BUNDLED_ID).expect("bundled graph");

        assert_eq!(profile.id, BUNDLED_ID);
        assert!(profile.objects() > 0);
        assert!(!profile.user_agent.is_empty());
    }

    #[test]
    fn an_empty_library_falls_back_to_the_bundled_graph() {
        let library = GraphLibrary::default();

        assert!(library.is_empty());
        assert_eq!(library.resolve(None).expect("resolve").id, BUNDLED_ID);
        assert_eq!(library.resolve(Some(BUNDLED_ID)).expect("resolve").id, BUNDLED_ID);
        assert!(library.resolve(Some("nothing-like-this")).is_err());
    }
}
