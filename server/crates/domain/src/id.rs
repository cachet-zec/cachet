//! Opaque 32-byte identifiers, serialized as lowercase hex.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::DomainError;

/// Implements a 32-byte, hex-serialized newtype identifier.
///
/// Both identifiers in this module share the exact same shape; the macro keeps
/// them distinct types so an `AssetId` can never be passed where a `TxId` is
/// expected.
macro_rules! hex_id {
    ($(#[$doc:meta])* $name:ident, $kind:literal) => {
        $(#[$doc])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name([u8; 32]);

        impl $name {
            pub const fn from_bytes(bytes: [u8; 32]) -> Self {
                Self(bytes)
            }

            pub const fn as_bytes(&self) -> &[u8; 32] {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&hex::encode(self.0))
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!($kind, "({})"), self)
            }
        }

        impl FromStr for $name {
            type Err = DomainError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                let mut bytes = [0u8; 32];
                hex::decode_to_slice(s, &mut bytes).map_err(|_| DomainError::InvalidId {
                    kind: $kind,
                    expected: 64,
                })?;
                Ok(Self(bytes))
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.to_string())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let s = String::deserialize(deserializer)?;
                s.parse().map_err(serde::de::Error::custom)
            }
        }
    };
}

hex_id!(
    /// Identifies a ZSA asset.
    ///
    /// On-chain this is the OrchardZSA `AssetBase`: a 32-byte encoding derived
    /// from the issuer's validating key and the asset description hash
    /// (ZIP 227). The domain treats it as opaque.
    AssetId,
    "AssetId"
);

hex_id!(
    /// A Zcash transaction id (32 bytes).
    TxId,
    "TxId"
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_hex() {
        let id = AssetId::from_bytes([0xab; 32]);
        let parsed: AssetId = id.to_string().parse().unwrap();
        assert_eq!(id, parsed);
    }

    #[test]
    fn rejects_wrong_length_and_non_hex() {
        assert!("abcd".parse::<AssetId>().is_err());
        assert!("zz".repeat(32).parse::<AssetId>().is_err());
    }

    #[test]
    fn serializes_as_hex_string() {
        let id = TxId::from_bytes([0x01; 32]);
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{}\"", "01".repeat(32)));
    }
}
