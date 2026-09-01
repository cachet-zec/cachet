//! Sighash versioning as specified in [ZIP-246].
//!
//! [ZIP-246]: https://zips.z.cash/zip-0246

use alloc::vec::Vec;

use orchard::sighash_kind::OrchardSighashKind;

#[cfg(zcash_unstable = "nu7")]
use orchard::issuance::sighash_kind::IssueSighashKind;

/// Orchard `SighashInfo` for V0:
/// sighashInfo = (\[sighashVersion\] || associatedData) = (\[0\] || [])
const ORCHARD_SIGHASH_INFO_V0: [u8; 1] = [0];

/// Returns the Orchard sighash info encoding corresponding to the given
/// [`OrchardSighashKind`].
pub(crate) fn orchard_sighash_kind_to_info(kind: &OrchardSighashKind) -> Vec<u8> {
    match kind {
        OrchardSighashKind::AllEffecting => ORCHARD_SIGHASH_INFO_V0.to_vec(),
    }
}

/// Parses an Orchard sighash info encoding and returns the corresponding
/// [`OrchardSighashKind`], if the encoding is recognized.
#[cfg(zcash_unstable = "nu7")]
pub(crate) fn orchard_sighash_kind_from_info(bytes: &[u8]) -> Option<OrchardSighashKind> {
    match bytes {
        // V0 version without associated data
        [0x00] => Some(OrchardSighashKind::AllEffecting),
        _ => None,
    }
}

/// Issuance `SighashInfo` for V0:
/// sighashInfo = (\[sighashVersion\] || associatedData) = (\[0\] || [])
#[cfg(zcash_unstable = "nu7")]
const ISSUE_SIGHASH_INFO_V0: [u8; 1] = [0];

/// Returns the Issuance sighash info encoding corresponding to the given
/// [`IssueSighashKind`].
#[cfg(zcash_unstable = "nu7")]
pub(crate) fn issue_sighash_kind_to_info(kind: &IssueSighashKind) -> Vec<u8> {
    match kind {
        IssueSighashKind::AllEffecting => ISSUE_SIGHASH_INFO_V0.to_vec(),
    }
}

/// Parses an Issuance sighash info encoding and returns the corresponding
/// [`IssueSighashKind`], if the encoding is recognized.
#[cfg(zcash_unstable = "nu7")]
pub(crate) fn issue_sighash_kind_from_info(bytes: &[u8]) -> Option<IssueSighashKind> {
    match bytes {
        // V0 version without associated data
        [0x00] => Some(IssueSighashKind::AllEffecting),
        _ => None,
    }
}

#[cfg(all(test, zcash_unstable = "nu7"))]
mod tests {
    use super::*;

    #[test]
    fn orchard_sighash_info_round_trip() {
        let kinds = [OrchardSighashKind::AllEffecting];

        for kind in kinds {
            // kind -> info -> kind
            let info = orchard_sighash_kind_to_info(&kind);
            let parsed = orchard_sighash_kind_from_info(&info)
                .expect("SighashInfo produced by orchard_sighash_kind_to_info must be parsable.");
            assert_eq!(parsed, kind);
        }
    }

    #[test]
    fn orchard_sighash_info_rejects_invalid_encodings() {
        assert_eq!(orchard_sighash_kind_from_info(&[]), None); // empty
        assert_eq!(orchard_sighash_kind_from_info(&[0x00, 0x00]), None); // extra data
    }

    #[test]
    fn issue_sighash_info_round_trip() {
        let kinds = [IssueSighashKind::AllEffecting];

        for kind in kinds {
            // kind -> info -> kind
            let info = issue_sighash_kind_to_info(&kind);
            let parsed = issue_sighash_kind_from_info(&info)
                .expect("SighashInfo produced by issue_sighash_kind_to_info must be parsable.");
            assert_eq!(parsed, kind);
        }
    }

    #[test]
    fn issue_sighash_info_rejects_invalid_encodings() {
        assert_eq!(issue_sighash_kind_from_info(&[]), None); // empty
        assert_eq!(issue_sighash_kind_from_info(&[0x00, 0x00]), None); // extra data
    }
}
