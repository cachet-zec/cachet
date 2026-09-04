//! Per-client throttles that never learn who the client is.
//!
//! Two write paths need per-client bounds (metadata uploads and the
//! relay), and PRIVACY.md P2 forbids keeping client addresses anywhere.
//! The reconciliation: the key is `BLAKE2b(salt || address)` with a salt
//! drawn at process start and never written down. The maps hold hashes
//! that cannot be inverted without the salt, the salt dies with the
//! process, entries are pruned as they age, and nothing here is logged.
//! Same privacy class as the rate limiter's key map, one notch stricter.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;

/// Salted, non-invertible identity of a client for the lifetime of the
/// process.
pub type ClientKey = [u8; 32];

/// Metadata uploads one client may make per minute. A browser mint costs
/// seconds of zk proving each, so a human stays an order of magnitude
/// below; a script pushing name-only bundles hits it in one second and
/// bothers nobody else.
pub const UPLOADS_PER_MINUTE_PER_CLIENT: u32 = 60;

/// Relays one client may have in flight. A "client" is an address, and
/// an address can be a whole room behind one NAT (a workshop, a campus,
/// a mobile carrier): eight lets such a room queue on the relay lock as
/// it always did, while an abuser gains nothing - since a node verdict
/// rejects immediately, a slot is only held while a genuine block mines.
pub const RELAYS_IN_FLIGHT_PER_CLIENT: u32 = 8;

/// Relays one client may submit per minute. The in-flight cap bounds
/// concurrency, not rate: a script relaying one proof every half second
/// never has two in flight and was never refused (nine sealed mints in
/// five seconds, observed). A person proves a mint in seconds and then
/// reads the receipt, so ten a minute is an order of magnitude above
/// anyone real, including a room behind one NAT taking turns.
pub const RELAYS_PER_MINUTE_PER_CLIENT: u32 = 10;

/// Above this many tracked clients, stale windows are swept on the next
/// call (a botnet must not make the map the thing that grows).
const PRUNE_ABOVE: usize = 10_000;

pub struct ClientLimits {
    salt: [u8; 32],
    /// Read `X-Forwarded-For` / `X-Real-IP` only when a reverse proxy is
    /// declared (CACHET_TRUST_PROXY); otherwise those are attacker-set.
    pub trust_proxy: bool,
    uploads: Mutex<HashMap<ClientKey, (Instant, u32)>>,
    relays: Mutex<HashMap<ClientKey, u32>>,
    relay_minutes: Mutex<HashMap<ClientKey, (Instant, u32)>>,
}

impl ClientLimits {
    pub fn new(trust_proxy: bool) -> Self {
        Self {
            salt: rand::random(),
            trust_proxy,
            uploads: Mutex::new(HashMap::new()),
            relays: Mutex::new(HashMap::new()),
            relay_minutes: Mutex::new(HashMap::new()),
        }
    }

    /// `CACHET_TRUST_PROXY=1|true` declares a reverse proxy in front.
    pub fn trust_proxy_from_env() -> bool {
        matches!(
            std::env::var("CACHET_TRUST_PROXY").as_deref(),
            Ok("1") | Ok("true")
        )
    }

    /// The salted key for an address. `None` (no connection info, e.g. a
    /// test harness) maps to one shared bucket rather than a rejection.
    pub fn key_for(&self, address: Option<IpAddr>) -> ClientKey {
        let text = address.map(|ip| ip.to_string()).unwrap_or_default();
        let hash = blake2b_simd::Params::new()
            .hash_length(32)
            .key(&self.salt)
            .hash(text.as_bytes());
        let mut key = [0u8; 32];
        key.copy_from_slice(hash.as_bytes());
        key
    }

    /// Reserve one upload in the client's current minute. `false` when the
    /// budget is spent.
    pub fn take_upload(&self, key: ClientKey) -> bool {
        take_in_minute(&self.uploads, key, UPLOADS_PER_MINUTE_PER_CLIENT)
    }

    /// Reserve one relay in the client's current minute. `false` when the
    /// budget is spent. Checked before the in-flight slot, so a refused
    /// request holds nothing.
    pub fn take_relay(&self, key: ClientKey) -> bool {
        take_in_minute(&self.relay_minutes, key, RELAYS_PER_MINUTE_PER_CLIENT)
    }

    /// Reserve a relay slot; released when the returned guard drops.
    pub fn begin_relay(self: &Arc<Self>, key: ClientKey) -> Option<RelaySlot> {
        let mut relays = self
            .relays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let in_flight = relays.entry(key).or_insert(0);
        if *in_flight >= RELAYS_IN_FLIGHT_PER_CLIENT {
            return None;
        }
        *in_flight += 1;
        Some(RelaySlot {
            limits: Arc::clone(self),
            key,
        })
    }
}

/// Count one event in the client's current minute against `budget`.
fn take_in_minute(
    windows: &Mutex<HashMap<ClientKey, (Instant, u32)>>,
    key: ClientKey,
    budget: u32,
) -> bool {
    let mut windows = windows
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    if windows.len() > PRUNE_ABOVE {
        windows.retain(|_, (started, _)| started.elapsed().as_secs() < 60);
    }
    match windows.get_mut(&key) {
        Some((started, count)) if started.elapsed().as_secs() < 60 => {
            if *count >= budget {
                return false;
            }
            *count += 1;
        }
        _ => {
            windows.insert(key, (now, 1));
        }
    }
    true
}

/// One in-flight relay; dropping it frees the slot, whatever the outcome.
pub struct RelaySlot {
    limits: Arc<ClientLimits>,
    key: ClientKey,
}

impl Drop for RelaySlot {
    fn drop(&mut self) {
        let mut relays = self
            .limits
            .relays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(in_flight) = relays.get_mut(&self.key) {
            *in_flight = in_flight.saturating_sub(1);
            if *in_flight == 0 {
                relays.remove(&self.key);
            }
        }
    }
}

/// The caller's salted key, extracted without ever surfacing the address
/// itself. Never rejects: a request with no connection info shares one
/// bucket.
pub struct Client(pub ClientKey);

impl FromRequestParts<crate::AppState> for Client {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        let limits = &state.client_limits;
        let forwarded = if limits.trust_proxy {
            parts
                .headers
                .get("x-forwarded-for")
                .and_then(|value| value.to_str().ok())
                .and_then(|list| list.split(',').next())
                .or_else(|| {
                    parts
                        .headers
                        .get("x-real-ip")
                        .and_then(|value| value.to_str().ok())
                })
                .and_then(|text| text.trim().parse::<IpAddr>().ok())
        } else {
            None
        };
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip());
        Ok(Client(limits.key_for(forwarded.or(peer))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_salted_and_stable_within_a_process() {
        let a = ClientLimits::new(false);
        let b = ClientLimits::new(false);
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        assert_eq!(a.key_for(Some(ip)), a.key_for(Some(ip)));
        assert_ne!(a.key_for(Some(ip)), b.key_for(Some(ip)));
        assert_ne!(a.key_for(Some(ip)), a.key_for(None));
    }

    #[test]
    fn the_upload_budget_is_per_client() {
        let limits = ClientLimits::new(false);
        let alice = limits.key_for(Some("203.0.113.1".parse().unwrap()));
        let bob = limits.key_for(Some("203.0.113.2".parse().unwrap()));
        for _ in 0..UPLOADS_PER_MINUTE_PER_CLIENT {
            assert!(limits.take_upload(alice));
        }
        assert!(!limits.take_upload(alice), "alice spent her minute");
        assert!(limits.take_upload(bob), "bob is unaffected");
    }

    #[test]
    fn the_relay_budget_is_per_client_and_separate_from_slots() {
        let limits = Arc::new(ClientLimits::new(false));
        let alice = limits.key_for(Some("203.0.113.4".parse().unwrap()));
        let bob = limits.key_for(Some("203.0.113.5".parse().unwrap()));
        for _ in 0..RELAYS_PER_MINUTE_PER_CLIENT {
            assert!(limits.take_relay(alice));
            // Each relay settles before the next: never more than one in flight.
            drop(limits.begin_relay(alice).expect("slot free"));
        }
        assert!(!limits.take_relay(alice), "alice spent her minute");
        assert!(
            limits.begin_relay(alice).is_some(),
            "slots are a separate bound"
        );
        assert!(limits.take_relay(bob), "bob is unaffected");
    }

    #[test]
    fn relay_slots_are_released_on_drop() {
        let limits = Arc::new(ClientLimits::new(false));
        let key = limits.key_for(Some("203.0.113.3".parse().unwrap()));
        let mut held: Vec<RelaySlot> = (0..RELAYS_IN_FLIGHT_PER_CLIENT)
            .map(|_| limits.begin_relay(key).expect("slot within the cap"))
            .collect();
        assert!(limits.begin_relay(key).is_none(), "cap reached");
        drop(held.pop());
        let freed = limits.begin_relay(key).expect("slot freed by drop");
        drop(held);
        drop(freed);
        assert!(limits.relays.lock().unwrap().is_empty(), "no residue");
    }
}
