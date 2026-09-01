//! Read-side support for ZMD-1, ZecBit's metadata convention for ZSA
//! asset descriptions (<https://zecbit.io> whitepaper, chapter 7).
//!
//! Cachet issues under its own envelope format (see [`crate::metadata`]),
//! but the registry is neutral infrastructure: it recognizes foreign
//! conventions so assets issued elsewhere display safely. Parsing follows
//! the published ZMD-1 grammar strictly — reject, never repair.
//!
//! Display rule (shared with ZIP 227's anti-phishing guidance): the raw
//! descriptor is never shown as a name; the canonical short form is
//! `<collection-slug> #<index>` — a machine identifier drawn from a
//! homoglyph-free alphabet, safe to display as-is.

/// Maximum descriptor length in bytes, per the ZMD-1 spec (tighter than
/// the 512-byte ZIP 227 bound).
const MAX_DESCRIPTOR_BYTES: usize = 256;

/// Which ZMD-1 form a descriptor uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zmd1Form {
    /// `zmd1|<collection>|<index>` — commits to identity only; metadata is
    /// authenticated by the creator's ongoing signature, not the chain.
    Minimal,
    /// `zmd1|<collection>|<index>|<manifest-cid>|<content-hash>` — the
    /// chain commits (transitively) to the entire manifest.
    Full,
}

/// A parsed ZMD-1 asset descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Zmd1Descriptor {
    pub collection: String,
    pub index: u32,
    pub form: Zmd1Form,
    /// CIDv1 (base32, multibase `b`) of the manifest (full form).
    pub manifest_cid: Option<String>,
    /// BLAKE2b-256 of the canonical manifest, lowercase hex (full form).
    pub content_hash: Option<String>,
}

impl Zmd1Descriptor {
    /// Parse a chain description as a ZMD-1 descriptor. Returns `None` for
    /// anything outside the grammar — such strings are simply not ZMD-1.
    pub fn parse(description: &str) -> Option<Self> {
        if description.len() > MAX_DESCRIPTOR_BYTES {
            return None;
        }
        let fields: Vec<&str> = description.split('|').collect();
        let (form, expected_len) = match fields.len() {
            3 => (Zmd1Form::Minimal, 3),
            5 => (Zmd1Form::Full, 5),
            _ => return None,
        };
        debug_assert_eq!(fields.len(), expected_len);

        if fields[0] != "zmd1" {
            return None; // exact, case-sensitive tag (zmd2 etc. are not ours)
        }
        let collection = parse_slug(fields[1])?;
        let index = parse_index(fields[2])?;

        let (manifest_cid, content_hash) = if form == Zmd1Form::Full {
            (
                Some(parse_cid(fields[3])?.to_owned()),
                Some(parse_content_hash(fields[4])?),
            )
        } else {
            (None, None)
        };

        Some(Self {
            collection: collection.to_owned(),
            index,
            form,
            manifest_cid,
            content_hash,
        })
    }

    /// Canonical display name: `<slug> #<index>`. Safe to render — the slug
    /// alphabet excludes uppercase, whitespace and non-ASCII by grammar.
    pub fn display_name(&self) -> String {
        format!("{} #{}", self.collection, self.index)
    }
}

/// 1–64 chars of `[a-z0-9-]`; no leading/trailing hyphen, no `--`.
fn parse_slug(slug: &str) -> Option<&str> {
    if slug.is_empty() || slug.len() > 64 {
        return None;
    }
    let bytes = slug.as_bytes();
    let edge_ok = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    if !edge_ok(bytes[0]) || !edge_ok(bytes[bytes.len() - 1]) {
        return None;
    }
    if !bytes.iter().all(|&b| edge_ok(b) || b == b'-') || slug.contains("--") {
        return None;
    }
    Some(slug)
}

/// Decimal, no leading zeros, fits u32.
fn parse_index(index: &str) -> Option<u32> {
    if index.is_empty() || index.len() > 10 {
        return None;
    }
    if index != "0" && index.starts_with('0') {
        return None;
    }
    if !index.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    index.parse().ok()
}

/// CIDv1, base32 lowercase, multibase prefix `b`.
fn parse_cid(cid: &str) -> Option<&str> {
    if cid.is_empty() || cid.len() > 112 || !cid.starts_with('b') {
        return None;
    }
    cid.bytes()
        .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
        .then_some(cid)
}

/// 64 lowercase hex chars.
fn parse_content_hash(hash: &str) -> Option<String> {
    (hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then(|| hash.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_zecbit_genesis_minimal_form() {
        let descriptor = Zmd1Descriptor::parse("zmd1|zecbit-genesis|1").unwrap();
        assert_eq!(descriptor.collection, "zecbit-genesis");
        assert_eq!(descriptor.index, 1);
        assert_eq!(descriptor.form, Zmd1Form::Minimal);
        assert_eq!(descriptor.display_name(), "zecbit-genesis #1");
    }

    #[test]
    fn parses_the_full_form() {
        let descriptor = Zmd1Descriptor::parse(&format!(
            "zmd1|pallas-wanderers|42|bafkreid4d4gqtzs3gtjmnip6qjwupuysl6tmbcefvhixmyyljjhw2i5eo5m|{}",
            "7c".repeat(32)
        ))
        .unwrap();
        assert_eq!(descriptor.form, Zmd1Form::Full);
        assert_eq!(
            descriptor.content_hash.as_deref(),
            Some("7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c")
        );
    }

    #[test]
    fn rejects_malformed_descriptors() {
        for bad in [
            "zmd2|collection|1",        // wrong tag
            "ZMD1|collection|1",        // case-sensitive
            "zmd1|Collection|1",        // uppercase slug
            "zmd1|-edge|1",             // leading hyphen
            "zmd1|dou--ble|1",          // double hyphen
            "zmd1|ok|01",               // leading zero index
            "zmd1|ok|4294967296",       // index > u32
            "zmd1|ok",                  // 2 fields
            "zmd1|ok|1|cid",            // 4 fields
            "zmd1|ok|1|Qmlegacy|aa",    // CIDv0
            "just a plain description", // not zmd1 at all
        ] {
            assert!(Zmd1Descriptor::parse(bad).is_none(), "accepted: {bad}");
        }
    }
}
