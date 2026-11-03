//! Byte codecs the graph realm's streams and encodings stand on, as one host function
//! (`__wreGraphCodec`): compression and decompression as Chrome's CompressionStream and
//! DecompressionStream run them (zlib, so the bytes and the error messages are zlib's), and text
//! decoding in every WHATWG encoding (encoding_rs), each a stateful handle the page's stream feeds.
//!
//! Bytes cross the bridge as base64 strings.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use encoding_rs::{CoderResult, Decoder, DecoderResult, Encoding};
use flate2::{Compress, Compression, Crc, Decompress, FlushCompress, FlushDecompress, Status};
use serde_json::{Value, json};

use wre_core::error::{Error, Result};

/// Chrome's gzip member header: no flags, mtime 0, XFL 0 (zlib's default level), OS 3 (Unix,
/// the captured Chrome's): written here rather than by zlib, whose OS byte is the build host's.
const GZIP_HEADER: [u8; 10] = [0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0x03];

/// The output buffer Chrome's compression transformers use: each full one is a chunk.
const BUFFER: usize = 65536;

enum Format {
    Gzip,
    Deflate,
    DeflateRaw,
}

impl Format {
    fn parse(name: &str) -> Option<Format> {
        match name {
            "gzip" => Some(Format::Gzip),
            "deflate" => Some(Format::Deflate),
            "deflate-raw" => Some(Format::DeflateRaw),
            _ => None,
        }
    }
}

struct Compressor {
    zlib: Compress,
    gzip: Option<Crc>,
    started: bool,
}

struct Decompressor {
    zlib: Decompress,
    ended: bool,
}

struct TextDecoder {
    encoding: &'static Encoding,
    ignore_bom: bool,
    decoder: Decoder,
    sniff: bool,
}

impl TextDecoder {
    fn fresh(encoding: &'static Encoding, ignore_bom: bool) -> Decoder {
        if ignore_bom { encoding.new_decoder_without_bom_handling() } else { encoding.new_decoder_with_bom_removal() }
    }
}

enum Handle {
    Compress(Compressor),
    Decompress(Decompressor),
    Text(TextDecoder),
}

#[derive(Default)]
struct Codecs {
    handles: Mutex<HashMap<u64, Handle>>,
    next: AtomicU64,
}

/// The `__wreGraphCodec(op, ...)` host function for one realm (each realm keeps its own handles).
pub fn host() -> wre_live::realm::HostFn {
    let codecs = Codecs::default();
    Box::new(move |args| codecs.call(args))
}

fn text_arg(args: &[Value], at: usize) -> String {
    args.get(at).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn bytes_arg(args: &[Value], at: usize) -> Result<Vec<u8>> {
    STANDARD.decode(args.get(at).and_then(Value::as_str).unwrap_or_default()).map_err(|error| Error::msg(format!("codec bytes were not base64: {error}")))
}

fn flag(args: &[Value], at: usize) -> bool {
    args.get(at).and_then(Value::as_bool).unwrap_or(false)
}

/// The WHATWG encoding a label names, or none: "replacement" is no encoding a decoder may use.
fn encoding_for(label: &str) -> Option<&'static Encoding> {
    Encoding::for_label(label.trim().as_bytes()).filter(|encoding| *encoding != encoding_rs::REPLACEMENT)
}

fn canonical(encoding: &'static Encoding) -> String {
    encoding.name().to_ascii_lowercase()
}

impl Codecs {
    fn call(&self, args: &[Value]) -> Result<Value> {
        let op = text_arg(args, 0);

        match op.as_str() {
            "label" => Ok(encoding_for(&text_arg(args, 1)).map_or(Value::Null, |encoding| json!(canonical(encoding)))),
            "open" => self.open(&text_arg(args, 1), &text_arg(args, 2), flag(args, 3)),
            "push" => {
                let id = args.get(1).and_then(Value::as_u64).unwrap_or_default();
                let input = bytes_arg(args, 2)?;
                self.push(id, &input, flag(args, 3), flag(args, 4))
            }
            "drop" => {
                let id = args.get(1).and_then(Value::as_u64).unwrap_or_default();
                self.lock().remove(&id);
                Ok(Value::Null)
            }
            other => Err(Error::msg(format!("unknown codec operation {other}"))),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Handle>> {
        self.handles.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Opens a handle: `compress`/`decompress` take a format name, `text` an encoding label (and
    /// whether to keep a BOM). Answers `{id, encoding}`, or null for a format or label the
    /// browser does not know.
    fn open(&self, kind: &str, name: &str, ignore_bom: bool) -> Result<Value> {
        let (handle, encoding) = match kind {
            "compress" => {
                let Some(format) = Format::parse(name) else { return Ok(Value::Null) };
                let level = Compression::new(6);
                let zlib = match format {
                    Format::Deflate => Compress::new(level, true),
                    Format::Gzip | Format::DeflateRaw => Compress::new(level, false),
                };
                (Handle::Compress(Compressor { zlib, gzip: matches!(format, Format::Gzip).then(Crc::new), started: false }), Value::Null)
            }
            "decompress" => {
                let Some(format) = Format::parse(name) else { return Ok(Value::Null) };
                let zlib = match format {
                    Format::Gzip => Decompress::new_gzip(15),
                    Format::Deflate => Decompress::new(true),
                    Format::DeflateRaw => Decompress::new(false),
                };
                (Handle::Decompress(Decompressor { zlib, ended: false }), Value::Null)
            }
            "text" => {
                let Some(encoding) = encoding_for(name) else { return Ok(Value::Null) };
                let decoder = TextDecoder::fresh(encoding, ignore_bom);
                (Handle::Text(TextDecoder { encoding, ignore_bom, decoder, sniff: false }), json!(canonical(encoding)))
            }
            // FileReader's decode: a BOM picks the encoding over the label.
            "text-sniff" => {
                let encoding = encoding_for(name).unwrap_or(encoding_rs::UTF_8);
                let decoder = encoding.new_decoder();
                (Handle::Text(TextDecoder { encoding, ignore_bom: false, decoder, sniff: true }), json!(canonical(encoding)))
            }
            other => return Err(Error::msg(format!("unknown codec kind {other}"))),
        };

        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.lock().insert(id, handle);
        Ok(json!({ "id": id, "encoding": encoding }))
    }

    /// Feeds a handle. Compression and decompression answer `{chunks: [base64], error}` (`last`
    /// finishes the stream); text answers `{text, error}` (`last` ends the decode and resets the
    /// decoder; `fatal` makes malformed input an error rather than U+FFFD).
    fn push(&self, id: u64, input: &[u8], last: bool, fatal: bool) -> Result<Value> {
        let mut handles = self.lock();
        let Some(handle) = handles.get_mut(&id) else { return Err(Error::msg(format!("no codec handle {id}"))) };

        match handle {
            Handle::Compress(state) => Ok(compress(state, input, last)),
            Handle::Decompress(state) => Ok(decompress(state, input, last)),
            Handle::Text(state) => Ok(decode(state, input, last, fatal)),
        }
    }
}

fn encoded(chunks: Vec<Vec<u8>>) -> Value {
    Value::Array(chunks.into_iter().map(|chunk| json!(STANDARD.encode(chunk))).collect())
}

/// Deflates as Chrome's DeflateTransformer: zlib with no flush per chunk written, a finish at
/// close, and each output buffer zlib fills (or the last, partly filled) enqueued as one chunk.
fn compress(state: &mut Compressor, input: &[u8], last: bool) -> Value {
    let flush = if last { FlushCompress::Finish } else { FlushCompress::None };
    let mut chunks = Vec::new();
    let mut prefix = Vec::new();

    if !state.started {
        state.started = true;
        if state.gzip.is_some() {
            prefix.extend_from_slice(&GZIP_HEADER);
        }
    }

    if let Some(crc) = state.gzip.as_mut() {
        crc.update(input);
    }

    let mut offset = 0;

    loop {
        let mut out = Vec::with_capacity(BUFFER);
        out.extend_from_slice(&prefix);
        prefix.clear();
        let before_in = state.zlib.total_in();
        let before_out = state.zlib.total_out();
        let room = BUFFER.saturating_sub(out.len()).max(1);
        let mut buffer = vec![0u8; room];
        let status = state.zlib.compress(&input[offset..], &mut buffer, flush);
        offset += (state.zlib.total_in() - before_in) as usize;
        let produced = (state.zlib.total_out() - before_out) as usize;
        out.extend_from_slice(&buffer[..produced]);

        let full = produced == room;
        let finished = matches!(status, Ok(Status::StreamEnd));

        if finished {
            if let Some(crc) = state.gzip.as_ref() {
                out.extend_from_slice(&crc.sum().to_le_bytes());
                out.extend_from_slice(&crc.amount().to_le_bytes());
            }
        }

        if !out.is_empty() {
            chunks.push(out);
        }

        if status.is_err() || finished || (!last && !full && offset >= input.len()) {
            break;
        }
    }

    json!({ "chunks": encoded(chunks), "error": Value::Null })
}

/// Inflates as Chrome's InflateTransformer: each full 64 KiB output buffer is a chunk; zlib's
/// own message names a malformed stream, input after the stream's end is junk, and a close
/// before the end is truncation.
fn decompress(state: &mut Decompressor, input: &[u8], last: bool) -> Value {
    let mut chunks = Vec::new();
    let mut offset = 0;

    if state.ended && !input.is_empty() {
        return json!({ "chunks": [], "error": "Junk found after end of compressed data." });
    }

    while offset < input.len() && !state.ended {
        let before_in = state.zlib.total_in();
        let before_out = state.zlib.total_out();
        let mut buffer = vec![0u8; BUFFER];
        let status = state.zlib.decompress(&input[offset..], &mut buffer, FlushDecompress::None);
        offset += (state.zlib.total_in() - before_in) as usize;
        let produced = (state.zlib.total_out() - before_out) as usize;
        buffer.truncate(produced);

        match status {
            Err(error) => {
                if !buffer.is_empty() {
                    chunks.push(buffer);
                }
                let reason = error.message().unwrap_or("invalid data").to_string();
                return json!({ "chunks": encoded(chunks), "error": format!("The compressed data was not valid: {reason}.") });
            }
            Ok(Status::StreamEnd) => state.ended = true,
            Ok(_) => {}
        }

        if !buffer.is_empty() {
            chunks.push(buffer);
        } else if produced == 0 && state.zlib.total_in() == before_in {
            break;
        }
    }

    if state.ended && offset < input.len() {
        return json!({ "chunks": encoded(chunks), "error": "Junk found after end of compressed data." });
    }

    if last && !state.ended {
        return json!({ "chunks": encoded(chunks), "error": "Compressed input was truncated." });
    }

    json!({ "chunks": encoded(chunks), "error": Value::Null })
}

fn decode(state: &mut TextDecoder, input: &[u8], last: bool, fatal: bool) -> Value {
    let mut text = String::with_capacity(state.decoder.max_utf8_buffer_length(input.len()).unwrap_or(input.len() * 3 + 4));
    let mut malformed = false;

    if fatal {
        let (result, _) = state.decoder.decode_to_string_without_replacement(input, &mut text, last);
        malformed = matches!(result, DecoderResult::Malformed(_, _));
    } else {
        let (result, _, _) = state.decoder.decode_to_string(input, &mut text, last);
        debug_assert!(matches!(result, CoderResult::InputEmpty));
    }

    if last || malformed {
        state.decoder = if state.sniff { state.encoding.new_decoder() } else { TextDecoder::fresh(state.encoding, state.ignore_bom) };
    }

    if malformed {
        return json!({ "text": "", "error": true });
    }

    json!({ "text": text, "error": false })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(codecs: &Codecs, kind: &str, format: &str, parts: &[&[u8]]) -> (Vec<Vec<u8>>, Value) {
        let id = codecs.open(kind, format, false).unwrap()["id"].as_u64().unwrap();
        let mut chunks = Vec::new();
        let mut error = Value::Null;
        for (index, part) in parts.iter().enumerate() {
            let answer = codecs.push(id, part, index + 1 == parts.len(), false).unwrap();
            for chunk in answer["chunks"].as_array().unwrap() {
                chunks.push(STANDARD.decode(chunk.as_str().unwrap()).unwrap());
            }
            if !answer["error"].is_null() {
                error = answer["error"].clone();
                break;
            }
        }
        (chunks, error)
    }

    /// Chrome 156's own CompressionStream output for the same input.
    #[test]
    fn gzip_matches_chrome() {
        let codecs = Codecs::default();
        let (chunks, _) = run(&codecs, "compress", "gzip", &[&[1, 2, 3], &[]]);
        assert_eq!(chunks.concat(), vec![31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 99, 100, 98, 6, 0, 29, 128, 188, 85, 3, 0, 0, 0]);
        let (chunks, _) = run(&codecs, "compress", "deflate", &[b"hello hello hello", &[]]);
        assert_eq!(chunks.concat(), vec![120, 156, 203, 72, 205, 201, 201, 87, 200, 64, 144, 0, 58, 46, 6, 125]);
    }

    #[test]
    fn malformed_and_truncated_input_name_zlib_reasons() {
        let codecs = Codecs::default();
        let (_, error) = run(&codecs, "decompress", "deflate", &[&[1, 2, 3, 4]]);
        assert_eq!(error, json!("The compressed data was not valid: incorrect header check."));
        let (_, error) = run(&codecs, "decompress", "deflate", &[&[120, 156, 203, 72], &[]]);
        assert_eq!(error, json!("Compressed input was truncated."));
    }

    #[test]
    fn decodes_legacy_encodings() {
        let codecs = Codecs::default();
        let id = codecs.open("text", "shift_jis", false).unwrap()["id"].as_u64().unwrap();
        assert_eq!(codecs.push(id, &[0x82, 0xa0, 0x41], true, false).unwrap()["text"], json!("\u{3042}A"));
        assert!(codecs.open("text", "replacement", false).unwrap().is_null());
    }
}
