//! Asset metadata: the bridge between the 512-byte on-chain description
//! and rich off-chain metadata.
//!
//! Model (v1):
//! - A **metadata bundle** is a JSON document (name, long description,
//!   optional embedded image as a data URI, optional external URL). It is
//!   stored content-addressed by the SHA-256 of its canonical bytes.
//! - The **chain description** — the string committed (as a hash) into the
//!   asset id at issuance — is a compact JSON envelope carrying the display
//!   name and the bundle hash: `{"v":1,"name":"…","sha256":"…"}`.
//!
//! Because the chain description is immutable and participates in the asset
//! id derivation, the bundle is cryptographically bound to the asset
//! forever: anyone can re-hash a served bundle and compare. No registry has
//! to be trusted for integrity — only for availability.

use serde::{Deserialize, Serialize};

use crate::DomainError;

/// Maximum display-name length in bytes (fits comfortably in the 512-byte
/// chain description alongside the envelope and hash).
pub const MAX_NAME_BYTES: usize = 120;
/// Maximum long-description length in bytes.
pub const MAX_LONG_DESCRIPTION_BYTES: usize = 4_096;
/// Maximum embedded image size in bytes (as a data URI, base64 included).
pub const MAX_IMAGE_DATA_URI_BYTES: usize = 400_000;

/// Image mime types the registry accepts. SVG is deliberately excluded:
/// it can embed scripts and the console renders these images.
const ALLOWED_IMAGE_PREFIXES: [&str; 4] = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/webp;base64,",
    "data:image/gif;base64,",
];

/// A validated metadata bundle, ready for canonical serialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataBundle {
    /// Format version; always 1 for now.
    pub v: u32,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_data_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_url: Option<String>,
}

impl MetadataBundle {
    pub fn new(
        name: impl Into<String>,
        description: Option<String>,
        image_data_uri: Option<String>,
        external_url: Option<String>,
    ) -> Result<Self, DomainError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(DomainError::InvalidMetadata {
                reason: "name must not be empty",
            });
        }
        if name.len() > MAX_NAME_BYTES {
            return Err(DomainError::InvalidMetadata {
                reason: "name exceeds 120 bytes",
            });
        }
        if let Some(description) = &description {
            if description.len() > MAX_LONG_DESCRIPTION_BYTES {
                return Err(DomainError::InvalidMetadata {
                    reason: "description exceeds 4096 bytes",
                });
            }
        }
        if let Some(image) = &image_data_uri {
            if image.len() > MAX_IMAGE_DATA_URI_BYTES {
                return Err(DomainError::InvalidMetadata {
                    reason: "image exceeds 400000 bytes",
                });
            }
            if !ALLOWED_IMAGE_PREFIXES
                .iter()
                .any(|prefix| image.starts_with(prefix))
            {
                return Err(DomainError::InvalidMetadata {
                    reason: "image must be a png/jpeg/webp/gif base64 data URI",
                });
            }
        }
        if let Some(url) = &external_url {
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err(DomainError::InvalidMetadata {
                    reason: "external_url must be http(s)",
                });
            }
        }
        Ok(Self {
            v: 1,
            name,
            description,
            image_data_uri,
            external_url,
        })
    }

    /// The exact bytes that get stored and hashed. Serde's field order is
    /// declaration order, so this is deterministic for a given bundle.
    pub fn to_canonical_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("bundle serialization cannot fail")
    }

    /// Decode the raw image bytes and mime type from the embedded data URI.
    pub fn image_parts(&self) -> Option<(&'static str, Vec<u8>)> {
        use base64::Engine;
        let uri = self.image_data_uri.as_deref()?;
        let (mime, prefix) = ALLOWED_IMAGE_PREFIXES.iter().find_map(|prefix| {
            uri.starts_with(prefix).then(|| {
                let mime = prefix
                    .trim_start_matches("data:")
                    .trim_end_matches(";base64,");
                (mime, *prefix)
            })
        })?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&uri[prefix.len()..])
            .ok()?;
        Some((mime, bytes))
    }
}

/// The compact on-chain description envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainDescription {
    pub v: u32,
    pub name: String,
    /// SHA-256 of the metadata bundle's canonical bytes, hex-encoded.
    pub sha256: String,
}

impl ChainDescription {
    /// Build the description string to commit at issuance.
    pub fn compose(name: &str, bundle_sha256_hex: &str) -> Result<String, DomainError> {
        let envelope = Self {
            v: 1,
            name: name.to_owned(),
            sha256: bundle_sha256_hex.to_owned(),
        };
        let text = serde_json::to_string(&envelope).expect("envelope serialization cannot fail");
        // Guaranteed by MAX_NAME_BYTES, but the chain rule is the law.
        if text.len() > crate::asset::MAX_ASSET_DESCRIPTION_BYTES {
            return Err(DomainError::InvalidMetadata {
                reason: "composed chain description exceeds 512 bytes",
            });
        }
        Ok(text)
    }

    /// Try to read a chain description as a v1 metadata envelope. Plain
    /// free-text descriptions (or foreign formats) return `None`.
    pub fn parse(description: &str) -> Option<Self> {
        let envelope: Self = serde_json::from_str(description).ok()?;
        (envelope.v == 1 && envelope.sha256.len() == 64).then_some(envelope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_and_parse_round_trip() {
        let text = ChainDescription::compose("Zcon Ticket", &"ab".repeat(32)).unwrap();
        assert!(text.len() <= crate::asset::MAX_ASSET_DESCRIPTION_BYTES);
        let parsed = ChainDescription::parse(&text).unwrap();
        assert_eq!(parsed.name, "Zcon Ticket");
        assert_eq!(parsed.sha256, "ab".repeat(32));
    }

    #[test]
    fn plain_text_descriptions_are_not_envelopes() {
        assert!(ChainDescription::parse("just a plain description").is_none());
    }

    #[test]
    fn bundle_rejects_svg_images() {
        let result = MetadataBundle::new(
            "X",
            None,
            Some("data:image/svg+xml;base64,AAAA".to_owned()),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn bundle_accepts_png_and_decodes_image() {
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G']);
        let bundle = MetadataBundle::new(
            "X",
            Some("desc".into()),
            Some(format!("data:image/png;base64,{png}")),
            Some("https://example.com".into()),
        )
        .unwrap();
        let (mime, bytes) = bundle.image_parts().unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, [0x89, b'P', b'N', b'G']);
    }

    #[test]
    fn canonical_bytes_are_stable() {
        let bundle = MetadataBundle::new("Stable", None, None, None).unwrap();
        assert_eq!(bundle.to_canonical_bytes(), bundle.to_canonical_bytes());
    }
}
