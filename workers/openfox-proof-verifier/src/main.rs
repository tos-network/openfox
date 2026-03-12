use openfox_worker_contracts::{run_worker, WorkerCliError};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;

const WORKER_NAME: &str = "proofverify.verify";
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_MAX_FETCH_BYTES: usize = 262_144;

#[derive(Debug, Deserialize, Serialize)]
struct ProofVerifyRequestEnvelope {
    request: ProofVerifyRequest,
    #[serde(default)]
    options: ProofVerifyOptions,
}

#[derive(Debug, Deserialize, Serialize)]
struct ProofVerifyRequest {
    #[serde(default)]
    subject_url: Option<String>,
    #[serde(default)]
    subject_sha256: Option<String>,
    #[serde(default)]
    proof_bundle_url: Option<String>,
    #[serde(default)]
    proof_bundle_sha256: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofVerifyOptions {
    #[serde(default)]
    request_timeout_ms: Option<u64>,
    #[serde(default)]
    max_fetch_bytes: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofVerifyResult {
    verdict: String,
    summary: String,
    metadata: Value,
    verifier_receipt_sha256: String,
}

#[derive(Debug, Clone)]
struct CheckEntry {
    label: &'static str,
    ok: bool,
    actual: String,
    expected: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("0x{}", hex::encode(hasher.finalize()))
}

fn fetch_bounded(
    client: &Client,
    url: &str,
    max_bytes: usize,
) -> Result<(String, String, u16, Value), WorkerCliError> {
    let response = client
        .get(url)
        .send()
        .map_err(|error| WorkerCliError::Internal(error.to_string()))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response
        .bytes()
        .map_err(|error| WorkerCliError::Internal(error.to_string()))?;
    if bytes.len() > max_bytes {
        return Err(WorkerCliError::InvalidEnvelope(format!(
            "fetched body exceeds max_fetch_bytes ({max_bytes})"
        )));
    }
    let parsed = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    Ok((sha256_hex(&bytes), content_type, status, parsed))
}

fn extract_referenced_hash(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(Value::String(candidate)) = map.get(*key) {
                    if candidate.starts_with("0x") && candidate.len() == 66 {
                        return Some(candidate.to_lowercase());
                    }
                }
            }
            for nested_key in ["metadata", "bundle", "result"] {
                if let Some(nested) = map.get(nested_key) {
                    if let Some(found) = extract_referenced_hash(nested, keys) {
                        return Some(found);
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn build_result(request: ProofVerifyRequestEnvelope) -> Result<ProofVerifyResult, WorkerCliError> {
    let timeout_ms = request
        .options
        .request_timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    let max_fetch_bytes = request
        .options
        .max_fetch_bytes
        .unwrap_or(DEFAULT_MAX_FETCH_BYTES);
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| WorkerCliError::Internal(error.to_string()))?;

    let mut checks: Vec<CheckEntry> = Vec::new();
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        "verifier_backend".into(),
        Value::String("rust_fixture_proof_verifier_v0".into()),
    );

    if let Some(subject_url) = request.request.subject_url.as_deref() {
        let (subject_sha, content_type, status, _) =
            fetch_bounded(&client, subject_url, max_fetch_bytes)?;
        metadata.insert(
            "subject".into(),
            serde_json::json!({
                "canonical_url": subject_url,
                "status": status,
                "content_type": content_type,
                "sha256": subject_sha,
            }),
        );
        if let Some(expected) = request.request.subject_sha256.as_deref() {
            checks.push(CheckEntry {
                label: "subject_sha256",
                ok: subject_sha.eq_ignore_ascii_case(expected),
                actual: subject_sha,
                expected: expected.to_string(),
            });
        }
    } else if let Some(subject_sha) = request.request.subject_sha256.as_deref() {
        metadata.insert(
            "subject".into(),
            serde_json::json!({ "declared_sha256": subject_sha }),
        );
    }

    if let Some(bundle_url) = request.request.proof_bundle_url.as_deref() {
        let (bundle_body_sha, content_type, status, parsed) =
            fetch_bounded(&client, bundle_url, max_fetch_bytes)?;
        let referenced_subject_sha = extract_referenced_hash(
            &parsed,
            &[
                "article_sha256",
                "subject_sha256",
                "content_sha256",
                "body_sha256",
            ],
        );
        let referenced_bundle_sha = extract_referenced_hash(
            &parsed,
            &[
                "zktls_bundle_sha256",
                "proof_bundle_sha256",
                "bundle_sha256",
            ],
        );
        metadata.insert(
            "bundle".into(),
            serde_json::json!({
                "canonical_url": bundle_url,
                "status": status,
                "content_type": content_type,
                "sha256": bundle_body_sha,
                "declared_bundle_sha256": referenced_bundle_sha,
                "referenced_subject_sha256": referenced_subject_sha,
            }),
        );
        if let Some(expected) = request.request.proof_bundle_sha256.as_deref() {
            let actual = referenced_bundle_sha.unwrap_or_else(|| bundle_body_sha.clone());
            checks.push(CheckEntry {
                label: "proof_bundle_sha256",
                ok: actual.eq_ignore_ascii_case(expected),
                actual,
                expected: expected.to_string(),
            });
        }
        if let (Some(expected), Some(actual)) = (
            request.request.subject_sha256.as_deref(),
            referenced_subject_sha.clone(),
        ) {
            checks.push(CheckEntry {
                label: "bundle_subject_sha256",
                ok: actual.eq_ignore_ascii_case(expected),
                actual,
                expected: expected.to_string(),
            });
        }
    } else if let Some(bundle_sha) = request.request.proof_bundle_sha256.as_deref() {
        metadata.insert(
            "bundle".into(),
            serde_json::json!({ "declared_sha256": bundle_sha }),
        );
    }

    let verifier_class = if request.request.proof_bundle_url.is_some()
        || request.request.proof_bundle_sha256.is_some()
    {
        "bundle_integrity_verification"
    } else {
        "structural_verification"
    };
    metadata.insert(
        "verifier_class".into(),
        Value::String(verifier_class.into()),
    );

    let verdict = if checks.is_empty() {
        "inconclusive"
    } else if checks.iter().all(|entry| entry.ok) {
        "valid"
    } else {
        "invalid"
    };

    let summary = match verdict {
        "valid" => format!(
            "Verified {} proof check{} successfully.",
            checks.len(),
            if checks.len() == 1 { "" } else { "s" }
        ),
        "invalid" => {
            let invalid_count = checks.iter().filter(|entry| !entry.ok).count();
            format!(
                "Verification failed for {} check{}.",
                invalid_count,
                if invalid_count == 1 { "" } else { "s" }
            )
        }
        _ => "No comparable hashes were available, so the result is inconclusive.".into(),
    };

    metadata.insert(
        "checks".into(),
        Value::Array(
            checks
                .iter()
                .map(|entry| {
                    serde_json::json!({
                        "label": entry.label,
                        "ok": entry.ok,
                        "actual": entry.actual,
                        "expected": entry.expected,
                    })
                })
                .collect(),
        ),
    );

    let metadata_value = Value::Object(metadata);
    let verifier_receipt_sha256 = sha256_hex(
        serde_json::to_vec(&serde_json::json!({
            "request": request.request,
            "verdict": verdict,
            "metadata": metadata_value.clone(),
        }))
        .map_err(|error| WorkerCliError::Internal(error.to_string()))?
        .as_slice(),
    );

    Ok(ProofVerifyResult {
        verdict: verdict.into(),
        summary,
        metadata: metadata_value,
        verifier_receipt_sha256,
    })
}

fn main() {
    std::process::exit(
        run_worker::<ProofVerifyRequestEnvelope, ProofVerifyResult, _>(WORKER_NAME, build_result),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_referenced_hashes_recursively() {
        let parsed = serde_json::json!({
            "metadata": {
                "bundle": {
                    "article_sha256": format!("0x{}", "a".repeat(64))
                }
            }
        });
        assert_eq!(
            extract_referenced_hash(&parsed, &["article_sha256"]),
            Some(format!("0x{}", "a".repeat(64)))
        );
    }

    #[test]
    fn reports_inconclusive_without_comparable_hashes() {
        let result = build_result(ProofVerifyRequestEnvelope {
            request: ProofVerifyRequest {
                subject_url: None,
                subject_sha256: Some(format!("0x{}", "a".repeat(64))),
                proof_bundle_url: None,
                proof_bundle_sha256: None,
            },
            options: ProofVerifyOptions::default(),
        })
        .unwrap();

        assert_eq!(result.verdict, "inconclusive");
        assert_eq!(
            result.metadata["verifier_class"],
            Value::String("structural_verification".into())
        );
    }
}
