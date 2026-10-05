//! SHA-256 workflow checksum, ported from `reference/n8n/packages/workflow/src/workflow-checksum.ts`.
//!
//! The reference builds a payload from a 9-field whitelist (`name`, `description`, `nodes`,
//! `connections`, `settings`, `meta`, `pinData`, `isArchived`, `activeVersionId`) — skipping
//! fields that are `undefined` but keeping explicit `null`s — then sorts every object key
//! recursively (`sortObjectKeys`; arrays keep their order), serialises with `JSON.stringify`
//! and hashes the UTF-8 bytes as lowercase hex.
//!
//! In Rust the sorting comes for free: `serde_json::Value` objects are `BTreeMap`s, so
//! serialising the payload sorts keys at every nesting level. Divergence to be aware of:
//! JavaScript sorts keys by UTF-16 code units, Rust by UTF-8 bytes — identical for ASCII
//! (all fixture data), different only for astral-plane keys.

use serde_json::{Map, Value};

pub const CHECKSUM_FIELDS: [&str; 9] = [
    "name",
    "description",
    "nodes",
    "connections",
    "settings",
    "meta",
    "pinData",
    "isArchived",
    "activeVersionId",
];

/// Snapshot of the fields the checksum is computed over — the entity/API shape, where
/// `nodes` is an **array** (the aggregate keeps a name-keyed map; see `lib.rs`).
pub fn checksum_payload(snapshot: &Value) -> Value {
    let mut payload = Map::new();
    if let Some(object) = snapshot.as_object() {
        for field in CHECKSUM_FIELDS {
            // `value !== undefined`: an absent key is skipped, an explicit null is kept.
            if let Some(value) = object.get(field) {
                payload.insert(field.to_string(), value.clone());
            }
        }
    }
    Value::Object(payload)
}

pub fn calculate_workflow_checksum(snapshot: &Value) -> String {
    let serialized = serde_json::to_string(&checksum_payload(snapshot))
        .expect("a serde_json::Value always serialises");
    sha256_hex(serialized.as_bytes())
}

pub fn sha256_hex(input: &[u8]) -> String {
    let digest = sha256(input);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256(input: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let mut message = input.to_vec();
    let bit_len = (input.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (index, slot) in w.iter_mut().take(16).enumerate() {
            let start = index * 4;
            *slot = u32::from_be_bytes([
                chunk[start],
                chunk[start + 1],
                chunk[start + 2],
                chunk[start + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }

        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);

        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (index, word) in h.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"The quick brown fox jumps over the lazy dog"),
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
        );
    }

    #[test]
    fn payload_skips_absent_fields_and_keeps_nulls() {
        let snapshot = serde_json::json!({
            "name": "x",
            "description": null,
            "id": "not-whitelisted",
            "staticData": {"lastId": 7}
        });
        let payload = checksum_payload(&snapshot);
        assert_eq!(payload["name"], "x");
        assert!(payload.get("description").is_some());
        assert!(payload.get("id").is_none());
        assert!(payload.get("staticData").is_none());
    }
}
