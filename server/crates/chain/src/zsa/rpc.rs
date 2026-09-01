//! Minimal async JSON-RPC client for the (OrchardZSA) Zebra node.
//!
//! Only the five methods the backend needs; every call maps transport
//! failures to [`ChainError::Unavailable`] and node-side errors to
//! [`ChainError::Rejected`].

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::ChainError;

pub struct NodeRpc {
    http: reqwest::Client,
    url: String,
}

/// Subset of the `getblocktemplate` response required to assemble a block
/// proposal (regtest has proof-of-work disabled, so no real mining occurs).
#[derive(Debug, Deserialize)]
pub struct BlockTemplate {
    pub version: u32,
    #[serde(rename = "previousblockhash")]
    pub previous_block_hash: String,
    #[serde(rename = "curtime")]
    pub cur_time: u32,
    pub bits: String,
    pub height: u32,
    #[serde(rename = "coinbasetxn")]
    pub coinbase_txn: TransactionTemplate,
    #[serde(rename = "defaultroots")]
    pub default_roots: DefaultRoots,
}

#[derive(Debug, Deserialize)]
pub struct TransactionTemplate {
    /// Hex-encoded serialized coinbase transaction provided by the node.
    pub data: String,
}

#[derive(Debug, Deserialize)]
pub struct DefaultRoots {
    #[serde(rename = "merkleroot")]
    pub merkle_root: String,
    #[serde(rename = "chainhistoryroot")]
    pub chain_history_root: String,
}

/// `getblock` at verbosity 1: the block's hash and transaction ids.
#[derive(Debug, Deserialize)]
pub struct BlockSummary {
    /// Block hash (hex, display order) — used to detect chain resets when
    /// validating the index checkpoint.
    pub hash: String,
    #[serde(rename = "tx")]
    pub tx_ids: Vec<String>,
}

impl NodeRpc {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            url: url.into(),
        }
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<T, ChainError> {
        let body = json!({
            "jsonrpc": "1.0",
            "id": "cachet",
            "method": method,
            "params": params,
        });

        let response: Value = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(|error| ChainError::Unavailable {
                reason: format!("node RPC transport ({method}): {error}"),
            })?
            .json()
            .await
            .map_err(|error| ChainError::Unavailable {
                reason: format!("node RPC returned non-JSON ({method}): {error}"),
            })?;

        if let Some(error) = response.get("error").filter(|value| !value.is_null()) {
            return Err(ChainError::Rejected {
                reason: format!("node rejected {method}: {error}"),
            });
        }
        serde_json::from_value(response.get("result").cloned().unwrap_or(Value::Null)).map_err(
            |error| ChainError::Unavailable {
                reason: format!("unexpected {method} result shape: {error}"),
            },
        )
    }

    pub async fn block_template(&self) -> Result<BlockTemplate, ChainError> {
        self.call("getblocktemplate", json!([])).await
    }

    pub async fn block_summary(&self, height: u64) -> Result<BlockSummary, ChainError> {
        self.call("getblock", json!([height.to_string(), 1])).await
    }

    /// Raw transaction hex (verbosity 0).
    pub async fn raw_transaction(&self, txid: &str) -> Result<String, ChainError> {
        self.call("getrawtransaction", json!([txid, 0])).await
    }

    /// Submit a block. Returns the node's textual verdict, if any.
    ///
    /// zcashd semantics say null = accepted, but the ZSA Zebra fork has been
    /// observed returning strings on accepted blocks too — callers must
    /// confirm acceptance by watching the chain tip advance, not by parsing
    /// this string.
    pub async fn submit_block(&self, block_hex: String) -> Result<Option<String>, ChainError> {
        let result: Option<Value> = self.call("submitblock", json!([block_hex])).await?;
        Ok(result.and_then(|value| match value {
            Value::Null => None,
            Value::String(text) => Some(text),
            other => Some(other.to_string()),
        }))
    }
}
