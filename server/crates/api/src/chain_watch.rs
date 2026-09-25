//! One Discord line when the chain does something the operator wants to
//! hear about, and never a second one while it goes on: the node stops
//! answering for a while, the node is back, the chain went backwards (a
//! reset). Fed by the background sync loop, which already sees all three.
//! Without a webhook it only logs.

use std::sync::Arc;
use std::time::{Duration, Instant};

use cachet_chain::ChainBackend;

/// How long the node has to stay unreachable before it is worth a ping.
/// The public testnet's node flaps for a minute now and then; that is not
/// an outage, and the log has it.
pub const OUTAGE_AFTER: Duration = Duration::from_secs(5 * 60);

pub struct ChainWatch {
    webhook: Option<Arc<str>>,
    failing_since: Option<Instant>,
    outage_told: bool,
    /// The highest tip seen so far; a tip below it is a reset.
    high_tip: Option<u64>,
}

impl ChainWatch {
    pub fn new(webhook: Option<Arc<str>>) -> Self {
        Self {
            webhook,
            failing_since: None,
            outage_told: false,
            high_tip: None,
        }
    }

    /// A sync attempt failed with `error`.
    pub async fn sync_failed(&mut self, error: &str) {
        let since = *self.failing_since.get_or_insert_with(Instant::now);
        if !self.outage_told && since.elapsed() >= OUTAGE_AFTER {
            self.outage_told = true;
            let minutes = since.elapsed().as_secs() / 60;
            self.tell(format!(
                "⚠️ Node unreachable for {minutes} min. The registry answers from its index; \
                 nothing relayed confirms until it is back.\n`{error}`"
            ))
            .await;
        }
    }

    /// A sync attempt succeeded; `chain` tells the tip it reached.
    pub async fn sync_ok(&mut self, chain: &dyn ChainBackend) {
        if self.outage_told {
            self.tell("✅ Node back.".to_owned()).await;
        }
        self.failing_since = None;
        self.outage_told = false;

        let Ok(info) = chain.chain_info().await else {
            return;
        };
        let tip = info.tip_height;
        match self.high_tip {
            Some(high) if tip < high => {
                self.tell(format!(
                    "🔁 Chain reset: the tip went from #{high} to #{tip}. The index rebuilt \
                     itself; what was sealed here is listed under /continuity and can be \
                     minted again with the same seed. Consider pausing mints until blocks flow."
                ))
                .await;
                self.high_tip = Some(tip);
            }
            Some(high) if tip > high => self.high_tip = Some(tip),
            Some(_) => {}
            None => self.high_tip = Some(tip),
        }
    }

    async fn tell(&self, content: String) {
        tracing::warn!(%content, "chain watch");
        let Some(webhook) = &self.webhook else {
            return;
        };
        let sent = reqwest::Client::new()
            .post(webhook.as_ref())
            .json(&serde_json::json!({ "content": content }))
            .timeout(Duration::from_secs(5))
            .send()
            .await;
        if let Err(error) = sent {
            // The URL is the webhook's secret: never in the log.
            let error = error.without_url();
            tracing::warn!(%error, "chain watch webhook delivery failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cachet_chain::memory::InMemoryChain;

    #[tokio::test]
    async fn a_lower_tip_is_a_reset_and_the_mark_follows_it() {
        let chain = InMemoryChain::default();
        let mut watch = ChainWatch::new(None);
        watch.high_tip = Some(4744);
        watch.sync_ok(&chain).await;
        // The in-memory chain starts far below 4744: a reset.
        let tip = chain.chain_info().await.unwrap().tip_height;
        assert!(tip < 4744);
        assert_eq!(watch.high_tip, Some(tip));
        // The same tip again is not a second reset.
        watch.sync_ok(&chain).await;
        assert_eq!(watch.high_tip, Some(tip));
    }

    #[tokio::test]
    async fn an_outage_is_told_after_the_grace_and_cleared_when_back() {
        let chain = InMemoryChain::default();
        let mut watch = ChainWatch::new(None);
        watch.sync_failed("node RPC transport").await;
        assert!(!watch.outage_told, "a first failure is not an outage");
        // As if the first failure had been a while ago.
        watch.failing_since = Some(Instant::now() - OUTAGE_AFTER - Duration::from_secs(1));
        watch.sync_failed("node RPC transport").await;
        assert!(watch.outage_told);
        watch.sync_ok(&chain).await;
        assert!(!watch.outage_told);
        assert!(watch.failing_since.is_none());
    }
}
