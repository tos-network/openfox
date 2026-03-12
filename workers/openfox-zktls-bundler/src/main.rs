use openfox_worker_contracts::{run_worker, WorkerCliError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const WORKER_NAME: &str = "zktls.bundle";

#[derive(Debug, Deserialize)]
struct ZkTlsBundleRequest {
    request: NewsFetchRequest,
    capture: CaptureResult,
    #[serde(default)]
    options: BundleOptions,
    #[serde(default)]
    context: BundleContext,
}

#[derive(Debug, Deserialize)]
struct NewsFetchRequest {
    source_url: String,
    #[serde(default)]
    publisher_hint: Option<String>,
    #[serde(default)]
    headline_hint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureResult {
    canonical_url: String,
    http_status: u16,
    content_type: String,
    article_sha256: String,
    #[serde(default)]
    article_text: Option<String>,
    #[serde(default)]
    headline: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleOptions {
    #[serde(default)]
    source_policy_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleContext {
    #[serde(default)]
    fetched_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ZkTlsBundleResult {
    format: String,
    bundle_sha256: String,
    bundle: Value,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("0x{}", hex::encode(hasher.finalize()))
}

fn build_bundle(request: ZkTlsBundleRequest) -> Result<ZkTlsBundleResult, WorkerCliError> {
    let fetched_at = request.context.fetched_at.unwrap_or_default();
    let bundle = json!({
        "version": 1,
        "backend": "rust_fixture_zktls_v0",
        "fetched_at": fetched_at,
        "source_url": request.request.source_url,
        "canonical_url": request.capture.canonical_url,
        "source_policy_id": request.options.source_policy_id.unwrap_or_else(|| "news.fetch".to_string()),
        "publisher_hint": request.request.publisher_hint,
        "headline_hint": request.request.headline_hint,
        "http_status": request.capture.http_status,
        "content_type": request.capture.content_type,
        "article_sha256": request.capture.article_sha256,
        "headline": request.capture.headline,
        "publisher": request.capture.publisher,
        "article_preview": request.capture.article_text,
    });
    let encoded =
        serde_json::to_vec(&bundle).map_err(|error| WorkerCliError::Internal(error.to_string()))?;
    Ok(ZkTlsBundleResult {
        format: "zktls_bundle_v1".into(),
        bundle_sha256: sha256_hex(&encoded),
        bundle,
    })
}

fn main() {
    std::process::exit(run_worker::<ZkTlsBundleRequest, ZkTlsBundleResult, _>(
        WORKER_NAME,
        build_bundle,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_deterministic_bundle_hash() {
        let result = build_bundle(ZkTlsBundleRequest {
            request: NewsFetchRequest {
                source_url: "https://news.example/story".into(),
                publisher_hint: Some("Example".into()),
                headline_hint: None,
            },
            capture: CaptureResult {
                canonical_url: "https://news.example/story".into(),
                http_status: 200,
                content_type: "text/html".into(),
                article_sha256: format!("0x{}", "a".repeat(64)),
                article_text: Some("hello".into()),
                headline: Some("Headline".into()),
                publisher: Some("Example".into()),
            },
            options: BundleOptions {
                source_policy_id: Some("major-news-headline-v1".into()),
            },
            context: BundleContext {
                fetched_at: Some(1772841600),
            },
        })
        .unwrap();

        assert_eq!(result.format, "zktls_bundle_v1");
        assert!(result.bundle_sha256.starts_with("0x"));
        assert_eq!(
            result.bundle["source_policy_id"],
            Value::String("major-news-headline-v1".into())
        );
        assert_eq!(
            result.bundle["article_sha256"],
            Value::String(format!("0x{}", "a".repeat(64)))
        );
    }
}
