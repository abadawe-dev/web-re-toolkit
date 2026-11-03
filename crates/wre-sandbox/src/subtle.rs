//! The SubtleCrypto operations a page's `crypto.subtle` performs, done with the RustCrypto crates
//! (the realm's JavaScript keeps the keys, algorithms and Chrome's validation; this does the math).
//! Each operation takes and returns raw bytes; a failure is Chrome's `OperationError`.

use aes_gcm::aead::consts::{U12, U13, U14, U15, U16};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{AesGcm, TagSize};
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit, StreamCipher};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha1::Sha1;
use sha2::{Sha256, Sha384, Sha512};

/// Why an operation failed: Chrome rejects with an `OperationError` (bad tag, padding, key size).
#[derive(Debug, PartialEq, Eq)]
pub struct Failed(pub String);

type Outcome = std::result::Result<Vec<u8>, Failed>;

fn failed(message: &str) -> Failed {
    Failed(message.to_string())
}

/// Runs `op` over `args` (bytes already decoded by the caller): `key`, `iv`/`counter`, `data`,
/// `aad`, `hash`, `salt`, `info`, and the numbers `tagLength`, `length`, `iterations`, `bits`.
pub fn run(op: &str, args: &Value, bytes: &dyn Fn(&str) -> Vec<u8>) -> Outcome {
    let number = |name: &str| args.get(name).and_then(Value::as_u64).unwrap_or_default();
    let hash = args.get("hash").and_then(Value::as_str).unwrap_or_default().to_ascii_uppercase();

    match op {
        "aes-gcm-encrypt" | "aes-gcm-decrypt" => {
            let tag = number("tagLength").max(1) as usize / 8;
            aes_gcm_any(op.ends_with("encrypt"), &bytes("key"), &bytes("iv"), &bytes("data"), &bytes("aad"), tag)
        }
        "aes-cbc-encrypt" => cbc_encrypt(&bytes("key"), &bytes("iv"), &bytes("data")),
        "aes-cbc-decrypt" => cbc_decrypt(&bytes("key"), &bytes("iv"), &bytes("data")),
        "aes-ctr" => ctr(&bytes("key"), &bytes("counter"), &bytes("data"), number("length")),
        "hmac" => hmac_of(&hash, &bytes("key"), &bytes("data")),
        "pbkdf2" => pbkdf2_of(&hash, &bytes("key"), &bytes("salt"), number("iterations") as u32, number("bits") as usize / 8),
        "hkdf" => hkdf_of(&hash, &bytes("key"), &bytes("salt"), &bytes("info"), number("bits") as usize / 8),
        op if op.starts_with("ec-") => {
            let curve = args.get("curve").and_then(Value::as_str).unwrap_or_default();
            match curve {
                "P-256" => ec_p256(op, &hash, &bytes),
                "P-384" => ec_p384(op, &hash, &bytes),
                _ => Err(failed("Unsupported namedCurve")),
            }
        }
        other => Err(Failed(format!("unknown operation {other}"))),
    }
}

/// ECDSA and ECDH on a NIST curve: keys travel as the private scalar (`d`) and the uncompressed
/// SEC1 public point (`q`); signatures are r || s, as Web Crypto writes them, signed with fresh
/// randomness as Chrome's are.
macro_rules! ec_curve {
    ($name:ident, $curve:ident) => {
        fn $name(op: &str, hash: &str, bytes: &dyn Fn(&str) -> Vec<u8>) -> Outcome {
            use $curve::ecdsa::signature::hazmat::{PrehashVerifier, RandomizedPrehashSigner};
            use $curve::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey};
            use $curve::{PublicKey, SecretKey};

            let invalid = || Failed("Invalid keyData".into());
            let secret = |name: &str| SecretKey::from_slice(&bytes(name)).map_err(|_| invalid());
            let public = |name: &str| PublicKey::from_sec1_bytes(&bytes(name)).map_err(|_| invalid());
            let point = |key: &PublicKey| key.to_sec1_bytes().to_vec();
            let prehash = || crate::host::digest_of(hash, &bytes("data")).ok_or_else(|| failed("Unrecognized hash"));

            match op {
                "ec-generate" => Ok(<SecretKey as $curve::elliptic_curve::Generate>::generate_from_rng(&mut rand::rng()).to_bytes().to_vec()),
                "ec-public" => Ok(point(&secret("d")?.public_key())),
                "ec-check-public" => Ok(point(&public("q")?)),
                "ec-sign" => {
                    let key = $curve::ecdsa::SigningKey::from(secret("d")?);
                    let signature: $curve::ecdsa::Signature =
                        key.sign_prehash_with_rng(&mut rand::rng(), &prehash()?).map_err(|_| Failed(String::new()))?;
                    Ok(signature.to_bytes().to_vec())
                }
                "ec-verify" => {
                    let key = $curve::ecdsa::VerifyingKey::from(public("q")?);
                    let Ok(signature) = $curve::ecdsa::Signature::from_slice(&bytes("signature")) else { return Ok(vec![0]) };
                    Ok(vec![u8::from(key.verify_prehash(&prehash()?, &signature).is_ok())])
                }
                "ec-derive" => {
                    let shared = $curve::ecdh::diffie_hellman(secret("d")?.to_nonzero_scalar(), public("q")?.as_affine());
                    Ok(shared.raw_secret_bytes().to_vec())
                }
                "ec-spki" => Ok(public("q")?.to_public_key_der().map_err(|_| Failed(String::new()))?.as_bytes().to_vec()),
                "ec-pkcs8" => Ok(secret("d")?.to_pkcs8_der().map_err(|_| Failed(String::new()))?.as_bytes().to_vec()),
                "ec-from-spki" => Ok(point(&PublicKey::from_public_key_der(&bytes("der")).map_err(|_| invalid())?)),
                "ec-from-pkcs8" => Ok(SecretKey::from_pkcs8_der(&bytes("der")).map_err(|_| invalid())?.to_bytes().to_vec()),
                other => Err(Failed(format!("unknown operation {other}"))),
            }
        }
    };
}

ec_curve!(ec_p256, p256);
ec_curve!(ec_p384, p384);

fn aes_gcm_any(encrypt: bool, key: &[u8], iv: &[u8], data: &[u8], aad: &[u8], tag: usize) -> Outcome {
    match tag {
        12 => aes_gcm_tag::<U12>(encrypt, key, iv, data, aad),
        13 => aes_gcm_tag::<U13>(encrypt, key, iv, data, aad),
        14 => aes_gcm_tag::<U14>(encrypt, key, iv, data, aad),
        15 => aes_gcm_tag::<U15>(encrypt, key, iv, data, aad),
        16 => aes_gcm_tag::<U16>(encrypt, key, iv, data, aad),
        _ => Err(failed("The tag length is not supported")),
    }
}

fn aes_gcm_tag<T: TagSize>(encrypt: bool, key: &[u8], iv: &[u8], data: &[u8], aad: &[u8]) -> Outcome {
    match key.len() {
        16 => aes_gcm_with::<aes::Aes128, T>(encrypt, key, iv, data, aad),
        24 => aes_gcm_with::<aes::Aes192, T>(encrypt, key, iv, data, aad),
        32 => aes_gcm_with::<aes::Aes256, T>(encrypt, key, iv, data, aad),
        _ => Err(failed("The key length is not supported")),
    }
}

fn aes_gcm_with<C, T>(encrypt: bool, key: &[u8], iv: &[u8], data: &[u8], aad: &[u8]) -> Outcome
where
    C: aes::cipher::BlockCipherEncrypt + aes::cipher::BlockSizeUser<BlockSize = U16> + KeyInit,
    T: TagSize,
{
    // Chrome takes any nonce length; 96 bits is the one every page uses, the only one handled.
    let cipher = AesGcm::<C, U12, T>::new_from_slice(key).map_err(|_| failed("The key length is not supported"))?;
    let nonce = aes_gcm::Nonce::<U12>::try_from(iv).map_err(|_| failed("The iv length is not supported"))?;
    let payload = Payload { msg: data, aad };
    let out = if encrypt { cipher.encrypt(&nonce, payload) } else { cipher.decrypt(&nonce, payload) };
    out.map_err(|_| Failed(String::new()))
}

fn cbc_encrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Outcome {
    if iv.len() != 16 {
        return Err(failed("The \"iv\" has an unexpected length -- must be 16 bytes"));
    }
    Ok(match key.len() {
        16 => cbc::Encryptor::<aes::Aes128>::new_from_slices(key, iv).map_err(|_| failed("bad key"))?.encrypt_padded_vec::<Pkcs7>(data),
        24 => cbc::Encryptor::<aes::Aes192>::new_from_slices(key, iv).map_err(|_| failed("bad key"))?.encrypt_padded_vec::<Pkcs7>(data),
        32 => cbc::Encryptor::<aes::Aes256>::new_from_slices(key, iv).map_err(|_| failed("bad key"))?.encrypt_padded_vec::<Pkcs7>(data),
        _ => return Err(failed("The key length is not supported")),
    })
}

fn cbc_decrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Outcome {
    if iv.len() != 16 {
        return Err(failed("The \"iv\" has an unexpected length -- must be 16 bytes"));
    }
    let out = match key.len() {
        16 => cbc::Decryptor::<aes::Aes128>::new_from_slices(key, iv).map_err(|_| failed("bad key"))?.decrypt_padded_vec::<Pkcs7>(data),
        24 => cbc::Decryptor::<aes::Aes192>::new_from_slices(key, iv).map_err(|_| failed("bad key"))?.decrypt_padded_vec::<Pkcs7>(data),
        32 => cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv).map_err(|_| failed("bad key"))?.decrypt_padded_vec::<Pkcs7>(data),
        _ => return Err(failed("The key length is not supported")),
    };
    out.map_err(|_| Failed(String::new()))
}

/// AES-CTR with WebCrypto's counter: the low `length` bits of the counter block count. 32, 64 and
/// 128 bits wrap exactly as Chrome's; any other width counts as 128 bits, which differs only after
/// 2^length blocks (more than a page ever encrypts at once).
fn ctr(key: &[u8], counter: &[u8], data: &[u8], length: u64) -> Outcome {
    if counter.len() != 16 {
        return Err(failed("The counter has an unexpected length -- must be 16 bytes"));
    }
    let mut out = data.to_vec();
    macro_rules! with {
        ($flavour:ident) => {
            match key.len() {
                16 => ctr::$flavour::<aes::Aes128>::new_from_slices(key, counter).map_err(|_| failed("bad key"))?.apply_keystream(&mut out),
                24 => ctr::$flavour::<aes::Aes192>::new_from_slices(key, counter).map_err(|_| failed("bad key"))?.apply_keystream(&mut out),
                32 => ctr::$flavour::<aes::Aes256>::new_from_slices(key, counter).map_err(|_| failed("bad key"))?.apply_keystream(&mut out),
                _ => return Err(failed("The key length is not supported")),
            }
        };
    }
    match length {
        32 => with!(Ctr32BE),
        64 => with!(Ctr64BE),
        _ => with!(Ctr128BE),
    }
    Ok(out)
}

fn hmac_of(hash: &str, key: &[u8], data: &[u8]) -> Outcome {
    macro_rules! mac {
        ($digest:ty) => {{
            let mut mac = Hmac::<$digest>::new_from_slice(key).map_err(|_| failed("bad key"))?;
            mac.update(data);
            Ok(mac.finalize().into_bytes().to_vec())
        }};
    }
    match hash {
        "SHA-1" => mac!(Sha1),
        "SHA-256" => mac!(Sha256),
        "SHA-384" => mac!(Sha384),
        "SHA-512" => mac!(Sha512),
        _ => Err(failed("Unrecognized hash")),
    }
}

fn pbkdf2_of(hash: &str, password: &[u8], salt: &[u8], rounds: u32, size: usize) -> Outcome {
    if rounds == 0 {
        return Err(failed("PBKDF2 requires iterations > 0"));
    }
    let mut out = vec![0u8; size];
    match hash {
        "SHA-1" => pbkdf2::pbkdf2_hmac::<Sha1>(password, salt, rounds, &mut out),
        "SHA-256" => pbkdf2::pbkdf2_hmac::<Sha256>(password, salt, rounds, &mut out),
        "SHA-384" => pbkdf2::pbkdf2_hmac::<Sha384>(password, salt, rounds, &mut out),
        "SHA-512" => pbkdf2::pbkdf2_hmac::<Sha512>(password, salt, rounds, &mut out),
        _ => return Err(failed("Unrecognized hash")),
    }
    Ok(out)
}

fn hkdf_of(hash: &str, ikm: &[u8], salt: &[u8], info: &[u8], size: usize) -> Outcome {
    let mut out = vec![0u8; size];
    let expanded = match hash {
        "SHA-1" => hkdf::Hkdf::<Sha1>::new(Some(salt), ikm).expand(info, &mut out),
        "SHA-256" => hkdf::Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, &mut out),
        "SHA-384" => hkdf::Hkdf::<Sha384>::new(Some(salt), ikm).expand(info, &mut out),
        "SHA-512" => hkdf::Hkdf::<Sha512>::new(Some(salt), ikm).expand(info, &mut out),
        _ => return Err(failed("Unrecognized hash")),
    };
    expanded.map_err(|_| Failed(String::new()))?;
    Ok(out)
}

/// A blank (fully transparent) RGBA canvas encoded as Chrome encodes a canvas to PNG: every row
/// "Up"-filtered, deflated at the fastest level. Chromium's zlib packs the stream differently from
/// this one, so the bytes differ from Chrome's; the image, its header and its size class match.
pub fn blank_png(width: u32, height: u32) -> Vec<u8> {
    use std::io::Write as _;

    let mut raw = Vec::with_capacity((width as usize * 4 + 1) * height as usize);
    for _ in 0..height {
        raw.push(2);
        raw.resize(raw.len() + width as usize * 4, 0);
    }
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&raw).expect("writing to memory");
    let compressed = encoder.finish().expect("writing to memory");

    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    for (kind, data) in [(&b"IHDR"[..], &header[..]), (&b"IDAT"[..], &compressed[..]), (&b"IEND"[..], &[][..])] {
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut crc = crc32fast::Hasher::new();
        crc.update(kind);
        crc.update(data);
        png.extend_from_slice(kind);
        png.extend_from_slice(data);
        png.extend_from_slice(&crc.finalize().to_be_bytes());
    }
    png
}

#[cfg(test)]
mod tests {
    use super::*;

    // Values Chrome 156 gave for the same inputs (playground/target/fidelity/platform-chrome.json).
    #[test]
    fn the_symmetric_operations_answer_as_chrome() {
        let hmac = hmac_of("SHA-256", &[1, 2, 3], &[4, 5]).unwrap();
        assert_eq!(&hmac[..4], &[6, 250, 16, 232]);
        let gcm = aes_gcm_any(true, &[0; 16], &[0; 12], &[1, 2, 3], &[], 16).unwrap();
        assert_eq!(gcm.len(), 19);
        assert_eq!(&gcm[..4], &[2, 138, 217, 233]);
        assert_eq!(aes_gcm_any(false, &[0; 16], &[0; 12], &gcm, &[], 16).unwrap(), vec![1, 2, 3]);
        assert_eq!(&cbc_encrypt(&[0; 16], &[0; 16], &[1, 2, 3]).unwrap()[..4], &[193, 179, 146, 124]);
        assert_eq!(ctr(&[0; 16], &[0; 16], &[1, 2, 3], 64).unwrap(), vec![103, 235, 72]);
        assert_eq!(&pbkdf2_of("SHA-256", b"pw", &[0; 8], 1000, 16).unwrap()[..4], &[248, 207, 250, 37]);
        assert_eq!(&hkdf_of("SHA-256", &[7, 7], &[0; 4], &[0; 2], 16).unwrap()[..4], &[5, 214, 198, 40]);
    }

    #[test]
    fn an_ecdsa_signature_verifies_and_varies_as_chrome_s() {
        let d = ec_p256("ec-generate", "", &|_| vec![]).unwrap();
        let q = ec_p256("ec-public", "", &|name| if name == "d" { d.clone() } else { vec![] }).unwrap();
        assert_eq!((d.len(), q.len(), q[0]), (32, 65, 4));
        let sign = || ec_p256("ec-sign", "SHA-256", &|name| match name { "d" => d.clone(), "data" => b"m".to_vec(), _ => vec![] }).unwrap();
        let (first, second) = (sign(), sign());
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
        let verify = |signature: Vec<u8>| {
            ec_p256("ec-verify", "SHA-256", &|name| match name { "q" => q.clone(), "data" => b"m".to_vec(), "signature" => signature.clone(), _ => vec![] }).unwrap()
        };
        assert_eq!(verify(first), vec![1]);
        assert_eq!(verify(vec![0; 64]), vec![0]);
    }
}
