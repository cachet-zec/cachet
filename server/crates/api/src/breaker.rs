//! The instance's own circuit breaker for the write paths.
//!
//! Per-client budgets stop one address; they stop nothing once an
//! attacker has many. This counts every relay that reaches the node,
//! whoever sent it, over a five-minute window. Past a threshold that no
//! group of people reaches (a browser mint costs seconds of proving),
//! the instance pauses its relay and uploads for a while and reopens on
//! its own. The operator is notified and can resume early from the admin
//! surface. Memory only, like the throttles: a restart is an operator
//! action and reopens the instance.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Relays per window that trip the breaker by default: forty in five
/// minutes is eight a minute sustained, several times what a room of
/// people proving in their browsers produces.
pub const DEFAULT_RELAYS_PER_WINDOW: u32 = 40;
/// The counting window.
pub const WINDOW: Duration = Duration::from_secs(5 * 60);
/// How long a tripped breaker holds the instance paused by default.
pub const DEFAULT_PAUSE: Duration = Duration::from_secs(30 * 60);

pub struct Breaker {
    /// Zero disables the breaker.
    threshold: u32,
    pause_for: Duration,
    hits: Mutex<VecDeque<Instant>>,
    tripped: Mutex<Option<Trip>>,
}

#[derive(Debug, Clone)]
pub struct Trip {
    pub until: Instant,
    pub relays: u32,
    /// Unix seconds, for the admin surface.
    pub since_unix: u64,
    pub until_unix: u64,
}

impl Breaker {
    pub fn new(threshold: u32, pause_for: Duration) -> Self {
        Self {
            threshold,
            pause_for,
            hits: Mutex::new(VecDeque::new()),
            tripped: Mutex::new(None),
        }
    }

    /// `CACHET_RELAY_BREAKER` (relays per five minutes, default 40, `0`
    /// disables) and `CACHET_RELAY_BREAKER_PAUSE_SECS` (default 1800).
    pub fn from_env() -> Self {
        let threshold = std::env::var("CACHET_RELAY_BREAKER")
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(DEFAULT_RELAYS_PER_WINDOW);
        let pause_for = std::env::var("CACHET_RELAY_BREAKER_PAUSE_SECS")
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_PAUSE);
        Self::new(threshold, pause_for)
    }

    pub fn threshold(&self) -> u32 {
        self.threshold
    }

    /// Count one relay that reached the node. Returns the trip when this
    /// relay is the one that exceeds the threshold.
    pub fn record(&self) -> Option<Trip> {
        if self.threshold == 0 {
            return None;
        }
        let now = Instant::now();
        let mut hits = self
            .hits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while hits
            .front()
            .is_some_and(|first| now.duration_since(*first) > WINDOW)
        {
            hits.pop_front();
        }
        hits.push_back(now);
        if hits.len() as u32 <= self.threshold {
            return None;
        }
        let relays = hits.len() as u32;
        hits.clear();
        let unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        let trip = Trip {
            until: now + self.pause_for,
            relays,
            since_unix: unix,
            until_unix: unix + self.pause_for.as_secs(),
        };
        *self
            .tripped
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(trip.clone());
        Some(trip)
    }

    /// The trip holding the instance paused right now, if any. An expired
    /// trip is cleared here, so reopening needs no timer.
    pub fn tripped(&self) -> Option<Trip> {
        let mut tripped = self
            .tripped
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*tripped {
            Some(trip) if Instant::now() < trip.until => Some(trip.clone()),
            Some(_) => {
                *tripped = None;
                None
            }
            None => None,
        }
    }

    /// The operator resumed: drop the trip and the window.
    pub fn reset(&self) {
        *self
            .tripped
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.hits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trips_past_the_threshold_and_holds_for_the_pause() {
        let breaker = Breaker::new(2, Duration::from_secs(60));
        assert!(breaker.record().is_none());
        assert!(breaker.record().is_none());
        let trip = breaker.record().expect("third relay trips");
        assert_eq!(trip.relays, 3);
        assert!(breaker.tripped().is_some(), "held for the pause");
        breaker.reset();
        assert!(breaker.tripped().is_none(), "operator resume clears it");
        assert!(breaker.record().is_none(), "the window restarts too");
    }

    #[test]
    fn an_expired_trip_reopens_on_its_own() {
        let breaker = Breaker::new(1, Duration::from_millis(1));
        breaker.record();
        assert!(breaker.record().is_some());
        std::thread::sleep(Duration::from_millis(5));
        assert!(breaker.tripped().is_none(), "expired trips clear lazily");
    }

    #[test]
    fn zero_disables_the_breaker() {
        let breaker = Breaker::new(0, Duration::from_secs(60));
        for _ in 0..1_000 {
            assert!(breaker.record().is_none());
        }
        assert!(breaker.tripped().is_none());
    }
}
