use anyhow::Result;
use async_stream::try_stream;
use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::{StreamExt, TryStreamExt};
use std::io;
use tokio::pin;
use tokio_util::codec::{FramedRead, LinesCodec};
use tokio_util::io::StreamReader;

use super::api_client::{ApiClient, AuthMethod, AuthProvider};
use super::azureauth::{AuthError, AzureAuth};
use super::base::{ConfigKey, MessageStream, Provider, ProviderDef, ProviderMetadata};
use super::errors::ProviderError;
use super::formats::openai::create_request;
use super::formats::openai_responses::{
    create_responses_request, responses_api_to_streaming_message,
};
use super::openai_compatible::{
    handle_response_openai_compat, handle_status_openai_compat, stream_openai_compat,
};
use super::retry::ProviderRetry;
use super::utils::{ImageFormat, RequestLog};
use crate::conversation::message::Message;
use crate::model::ModelConfig;
use rmcp::model::Tool;

const AZURE_PROVIDER_NAME: &str = "azure_openai";
pub const AZURE_DEFAULT_MODEL: &str = "gpt-4o";
pub const AZURE_DOC_URL: &str =
    "https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models";
pub const AZURE_DEFAULT_API_VERSION: &str = "2024-10-21";
const AZURE_RESPONSES_API_VERSION: &str = "2025-04-01-preview";
pub const AZURE_OPENAI_KNOWN_MODELS: &[&str] = &[
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4",
    "gpt-5.1-codex",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
];

struct AzureAuthProvider {
    auth: AzureAuth,
}

#[async_trait]
impl AuthProvider for AzureAuthProvider {
    async fn get_auth_header(&self) -> Result<(String, String)> {
        let auth_token = self
            .auth
            .get_token()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get authentication token: {}", e))?;

        match self.auth.credential_type() {
            super::azureauth::AzureCredentials::ApiKey(_) => {
                Ok(("api-key".to_string(), auth_token.token_value))
            }
            super::azureauth::AzureCredentials::DefaultCredential => Ok((
                "Authorization".to_string(),
                format!("Bearer {}", auth_token.token_value),
            )),
        }
    }
}

fn is_responses_api_model(model_name: &str) -> bool {
    let lower = model_name.to_ascii_lowercase();
    lower.contains("codex") || lower.starts_with("o1") || lower.starts_with("o3")
}

#[derive(Debug)]
pub struct AzureOpenAiProvider {
    chat_api_client: ApiClient,
    responses_api_client: Option<ApiClient>,
    deployment_name: String,
    model: ModelConfig,
    use_responses_api: bool,
}

impl ProviderDef for AzureOpenAiProvider {
    type Provider = Self;

    fn metadata() -> ProviderMetadata {
        ProviderMetadata::new(
            AZURE_PROVIDER_NAME,
            "Azure OpenAI",
            "Models through Azure OpenAI Service (uses Azure credential chain by default). Supports Chat Completions and Responses API (for codex models).",
            "gpt-4o",
            AZURE_OPENAI_KNOWN_MODELS.to_vec(),
            AZURE_DOC_URL,
            vec![
                ConfigKey::new("AZURE_OPENAI_ENDPOINT", true, false, None, true),
                ConfigKey::new("AZURE_OPENAI_DEPLOYMENT_NAME", true, false, None, true),
                ConfigKey::new(
                    "AZURE_OPENAI_API_VERSION",
                    true,
                    false,
                    Some("2024-10-21"),
                    false,
                ),
                ConfigKey::new("AZURE_OPENAI_API_KEY", false, true, Some(""), true),
            ],
        )
    }

    fn from_env(
        model: ModelConfig,
        _extensions: Vec<crate::config::ExtensionConfig>,
    ) -> BoxFuture<'static, Result<Self::Provider>> {
        Box::pin(async move {
            let config = crate::config::Config::global();
            let endpoint: String = config.get_param("AZURE_OPENAI_ENDPOINT")?;
            let deployment_name: String = config.get_param("AZURE_OPENAI_DEPLOYMENT_NAME")?;
            let api_version: String = config
                .get_param("AZURE_OPENAI_API_VERSION")
                .unwrap_or_else(|_| AZURE_DEFAULT_API_VERSION.to_string());

            let api_key = config
                .get_secret("AZURE_OPENAI_API_KEY")
                .ok()
                .filter(|key: &String| !key.is_empty());

            let use_responses = is_responses_api_model(&deployment_name)
                || is_responses_api_model(&model.model_name);

            let host = format!("{}/openai", endpoint.trim_end_matches('/'));

            let chat_api_version = if use_responses && api_version.starts_with("2025-") {
                AZURE_DEFAULT_API_VERSION.to_string()
            } else {
                api_version.clone()
            };

            let auth_chat = AzureAuth::new(api_key.clone()).map_err(|e| match e {
                AuthError::Credentials(msg) => anyhow::anyhow!("Credentials error: {}", msg),
                AuthError::TokenExchange(msg) => anyhow::anyhow!("Token exchange error: {}", msg),
            })?;
            let chat_api_client = ApiClient::new(
                host.clone(),
                AuthMethod::Custom(Box::new(AzureAuthProvider { auth: auth_chat })),
            )?
            .with_query(vec![("api-version".to_string(), chat_api_version)]);

            let responses_api_client = if use_responses {
                let responses_api_version = if api_version.starts_with("2025-") {
                    api_version
                } else {
                    AZURE_RESPONSES_API_VERSION.to_string()
                };

                let auth_responses = AzureAuth::new(api_key).map_err(|e| match e {
                    AuthError::Credentials(msg) => anyhow::anyhow!("Credentials error: {}", msg),
                    AuthError::TokenExchange(msg) => {
                        anyhow::anyhow!("Token exchange error: {}", msg)
                    }
                })?;
                let client = ApiClient::new(
                    host,
                    AuthMethod::Custom(Box::new(AzureAuthProvider {
                        auth: auth_responses,
                    })),
                )?
                .with_query(vec![("api-version".to_string(), responses_api_version)]);
                Some(client)
            } else {
                None
            };

            tracing::info!(
                "Azure OpenAI provider initialized: deployment={}, use_responses_api={}",
                deployment_name,
                use_responses,
            );

            Ok(Self {
                chat_api_client,
                responses_api_client,
                deployment_name,
                model,
                use_responses_api: use_responses,
            })
        })
    }
}

#[async_trait]
impl Provider for AzureOpenAiProvider {
    fn get_name(&self) -> &str {
        AZURE_PROVIDER_NAME
    }

    fn get_model_config(&self) -> ModelConfig {
        self.model.clone()
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        if let Ok(response) = self.chat_api_client.response_get(None, "models").await {
            if let Ok(json) = handle_response_openai_compat(response).await {
                if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
                    let mut models: Vec<String> = arr
                        .iter()
                        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(str::to_string))
                        .collect();
                    models.sort();
                    return Ok(models);
                }
            }
        }
        Ok(AZURE_OPENAI_KNOWN_MODELS
            .iter()
            .map(|s| s.to_string())
            .collect())
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        session_id: &str,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        if self.use_responses_api {
            self.stream_responses(model_config, session_id, system, messages, tools)
                .await
        } else {
            self.stream_chat_completions(model_config, session_id, system, messages, tools)
                .await
        }
    }
}

impl AzureOpenAiProvider {
    async fn stream_chat_completions(
        &self,
        model_config: &ModelConfig,
        session_id: &str,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let payload = create_request(
            model_config,
            system,
            messages,
            tools,
            &ImageFormat::OpenAi,
            true,
        )
        .map_err(|e| ProviderError::RequestFailed(format!("Failed to create request: {}", e)))?;

        let mut log = RequestLog::start(model_config, &payload)?;
        let completions_path = format!("deployments/{}/chat/completions", self.deployment_name);

        let response = self
            .with_retry(|| async {
                let resp = self
                    .chat_api_client
                    .response_post(Some(session_id), &completions_path, &payload)
                    .await?;
                handle_status_openai_compat(resp).await
            })
            .await
            .inspect_err(|e| {
                let _ = log.error(e);
            })?;

        stream_openai_compat(response, log)
    }

    async fn stream_responses(
        &self,
        model_config: &ModelConfig,
        session_id: &str,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let api_client = self.responses_api_client.as_ref().ok_or_else(|| {
            ProviderError::RequestFailed("Responses API client not configured".to_string())
        })?;

        let mut payload = create_responses_request(model_config, system, messages, tools)?;
        payload["stream"] = serde_json::Value::Bool(true);

        let mut log = RequestLog::start(model_config, &payload)?;

        // Azure supports two URL patterns for the Responses API:
        // 1. /openai/deployments/{deployment}/responses (deployment-specific)
        // 2. /openai/responses (model name in the request body)
        // Try deployment-specific first; fall back to the non-deployment path on 404.
        let deployment_path = format!("deployments/{}/responses", self.deployment_name);

        let response = self
            .with_retry(|| async {
                let payload_clone = payload.clone();
                let resp = api_client
                    .response_post(Some(session_id), &deployment_path, &payload_clone)
                    .await?;
                handle_status_openai_compat(resp).await
            })
            .await;

        let response = match response {
            Ok(r) => r,
            Err(ProviderError::RequestFailed(ref msg)) if msg.contains("404") => {
                tracing::info!(
                    "Deployment-specific responses path returned 404, falling back to /openai/responses"
                );
                self.with_retry(|| async {
                    let payload_clone = payload.clone();
                    let resp = api_client
                        .response_post(Some(session_id), "responses", &payload_clone)
                        .await?;
                    handle_status_openai_compat(resp).await
                })
                .await
                .inspect_err(|e| {
                    let _ = log.error(e);
                })?
            }
            Err(e) => {
                let _ = log.error(&e);
                return Err(e);
            }
        };

        let stream = response.bytes_stream().map_err(io::Error::other);

        Ok(Box::pin(try_stream! {
            let stream_reader = StreamReader::new(stream);
            let framed = FramedRead::new(stream_reader, LinesCodec::new())
                .map_err(anyhow::Error::from);

            let message_stream = responses_api_to_streaming_message(framed);
            pin!(message_stream);
            while let Some(message) = message_stream.next().await {
                let (message, usage) = message.map_err(|e|
                    ProviderError::RequestFailed(format!("Stream decode error: {}", e))
                )?;
                log.write(&message, usage.as_ref().map(|f| f.usage).as_ref())?;
                yield (message, usage);
            }
        }))
    }
}

// Keep the old type alias for backward compatibility with init.rs registration
pub type AzureProvider = AzureOpenAiProvider;
