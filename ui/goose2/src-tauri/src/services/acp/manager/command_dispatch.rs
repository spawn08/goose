use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use agent_client_protocol::{Agent, ClientSideConnection, ExtRequest, ForkSessionRequest};
use serde_json::value::RawValue;
use tokio::sync::{mpsc, Mutex};

use super::dispatcher::SessionEventDispatcher;
use super::session_ops::{
    cancel_session_inner, list_sessions_inner, load_session_inner, prepare_session_inner,
    resolve_goose_session_id, send_prompt_inner, set_model_inner, AcpSessionInfo, ManagerState,
    PrepareSessionInput,
};
use super::{
    call_ext_method, AcpReadResourceContent, AcpToolInfo, GooseProvidersResponse, ManagerCommand,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadResourceExtResponse {
    result: ReadResourceResultValue,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadResourceResultValue {
    contents: Vec<ReadResourceContentValue>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadResourceContentValue {
    uri: String,
    text: Option<String>,
    blob: Option<String>,
    mime_type: Option<String>,
    #[serde(rename = "_meta")]
    meta: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetToolsExtResponse {
    tools: Vec<GetToolsValue>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetToolsValue {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    parameters: Vec<String>,
    permission: Option<String>,
    input_schema: Option<serde_json::Value>,
    #[serde(rename = "_meta")]
    meta: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct ExtValueResponse {
    result: serde_json::Value,
}

pub(super) async fn dispatch_commands(
    mut command_rx: mpsc::UnboundedReceiver<ManagerCommand>,
    connection: Arc<ClientSideConnection>,
    dispatcher: Arc<SessionEventDispatcher>,
) {
    let state = Arc::new(Mutex::new(ManagerState {
        sessions: HashMap::new(),
        op_locks: HashMap::new(),
        pending_cancels: HashSet::new(),
        preparing_sessions: HashSet::new(),
    }));

    while let Some(command) = command_rx.recv().await {
        match command {
            ManagerCommand::ListProviders { response } => {
                let connection = Arc::clone(&connection);
                tokio::task::spawn_local(async move {
                    let result = async {
                        let params = RawValue::from_string("{}".to_string()).map_err(|error| {
                            format!("Failed to build ACP request body: {error}")
                        })?;
                        let response_value = connection
                            .ext_method(ExtRequest::new("goose/providers/list", params.into()))
                            .await
                            .map_err(|error| {
                                format!("Failed to list providers via Goose ACP: {error:?}")
                            })?;
                        let parsed: GooseProvidersResponse =
                            serde_json::from_str(response_value.0.get()).map_err(|error| {
                                format!("Failed to decode Goose provider list: {error}")
                            })?;
                        Ok::<_, String>(parsed.providers)
                    }
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::ListSessions { response } => {
                let connection = Arc::clone(&connection);
                tokio::task::spawn_local(async move {
                    let result = list_sessions_inner(&connection).await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::LoadSession {
                local_session_id,
                goose_session_id,
                working_dir,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let dispatcher = dispatcher.clone();
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result = load_session_inner(
                        &connection,
                        &dispatcher,
                        &state,
                        &local_session_id,
                        &goose_session_id,
                        working_dir,
                    )
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::PrepareSession {
                composite_key,
                local_session_id,
                provider_id,
                working_dir,
                existing_agent_session_id,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let dispatcher = dispatcher.clone();
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result = prepare_session_inner(
                        &connection,
                        &dispatcher,
                        &state,
                        PrepareSessionInput {
                            composite_key,
                            local_session_id,
                            provider_id,
                            working_dir,
                            existing_agent_session_id,
                        },
                    )
                    .await
                    .map(|_| ());
                    let _ = response.send(result);
                });
            }
            ManagerCommand::SendPrompt {
                composite_key,
                local_session_id,
                provider_id,
                working_dir,
                existing_agent_session_id,
                assistant_message_id,
                writer,
                prompt,
                images,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let dispatcher = dispatcher.clone();
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result = send_prompt_inner(
                        &connection,
                        &dispatcher,
                        &state,
                        composite_key,
                        local_session_id,
                        provider_id,
                        working_dir,
                        existing_agent_session_id,
                        assistant_message_id,
                        writer,
                        prompt,
                        images,
                    )
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::CancelSession {
                composite_key,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let dispatcher = dispatcher.clone();
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result =
                        cancel_session_inner(&connection, &dispatcher, &state, &composite_key)
                            .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::ExportSession {
                session_id,
                response,
            } => {
                let connection = Arc::clone(&connection);
                tokio::task::spawn_local(async move {
                    let result = async {
                        let raw = call_ext_method(
                            &connection,
                            "goose/session/export",
                            serde_json::json!({ "sessionId": session_id }),
                        )
                        .await?;
                        // Backend returns { "data": "<json string>" }
                        let resp: serde_json::Value = serde_json::from_str(&raw)
                            .map_err(|e| format!("Failed to decode export response: {e}"))?;
                        resp.get("data")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .ok_or_else(|| "Export response missing 'data' field".to_string())
                    }
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::ImportSession { json, response } => {
                let connection = Arc::clone(&connection);
                tokio::task::spawn_local(async move {
                    let result = async {
                        let raw = call_ext_method(
                            &connection,
                            "goose/session/import",
                            serde_json::json!({ "data": json }),
                        )
                        .await?;
                        serde_json::from_str(&raw)
                            .map_err(|e| format!("Failed to decode import response: {e}"))
                    }
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::ForkSession {
                session_id,
                response,
            } => {
                let connection = Arc::clone(&connection);
                tokio::task::spawn_local(async move {
                    let result = async {
                        let req = ForkSessionRequest::new(
                            session_id,
                            std::env::current_dir().unwrap_or_default(),
                        );
                        let resp = connection
                            .fork_session(req)
                            .await
                            .map_err(|e| format!("session/fork failed: {e:?}"))?;
                        let message_count = resp
                            .meta
                            .as_ref()
                            .and_then(|m| m.get("messageCount"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                        let title = resp
                            .meta
                            .as_ref()
                            .and_then(|m| m.get("title"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        Ok(AcpSessionInfo {
                            session_id: resp.session_id.to_string(),
                            title,
                            updated_at: None,
                            message_count,
                        })
                    }
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::SetModel {
                local_session_id,
                model_id,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let dispatcher = dispatcher.clone();
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result = set_model_inner(
                        &connection,
                        &dispatcher,
                        &state,
                        &local_session_id,
                        &model_id,
                    )
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::ReadResource {
                local_session_id,
                uri,
                extension_name,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result = async {
                        let goose_session_id = {
                            let guard = state.lock().await;
                            resolve_goose_session_id(&guard.sessions, &local_session_id)
                                .unwrap_or_else(|| local_session_id.clone())
                        };
                        let raw = call_ext_method(
                            &connection,
                            "goose/resource/read",
                            serde_json::json!({
                                "sessionId": goose_session_id,
                                "uri": uri,
                                "extensionName": extension_name,
                            }),
                        )
                        .await?;
                        let parsed: ReadResourceExtResponse = serde_json::from_str(&raw)
                            .map_err(|error| {
                                format!("Failed to decode read resource response: {error}")
                            })?;
                        let content = parsed
                            .result
                            .contents
                            .into_iter()
                            .find(|content| content.text.is_some() || content.blob.is_some())
                            .ok_or_else(|| {
                                "Read resource response did not include a supported resource payload"
                                    .to_string()
                            })?;
                        Ok(AcpReadResourceContent {
                            uri: content.uri,
                            text: content.text,
                            blob: content.blob,
                            mime_type: content.mime_type,
                            meta: content.meta,
                        })
                    }
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::GetTools {
                local_session_id,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result = async {
                        let goose_session_id = {
                            let guard = state.lock().await;
                            resolve_goose_session_id(&guard.sessions, &local_session_id)
                                .unwrap_or_else(|| local_session_id.clone())
                        };
                        let raw = call_ext_method(
                            &connection,
                            "goose/tools",
                            serde_json::json!({
                                "sessionId": goose_session_id,
                            }),
                        )
                        .await?;
                        let parsed: GetToolsExtResponse =
                            serde_json::from_str(&raw).map_err(|error| {
                                format!("Failed to decode get tools response: {error}")
                            })?;
                        Ok(parsed
                            .tools
                            .into_iter()
                            .map(|tool| AcpToolInfo {
                                name: tool.name,
                                description: tool.description,
                                parameters: tool.parameters,
                                permission: tool.permission,
                                input_schema: tool.input_schema,
                                meta: tool.meta,
                            })
                            .collect())
                    }
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::CallTool {
                local_session_id,
                extension_name,
                name,
                arguments,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result = async {
                        let goose_session_id = {
                            let guard = state.lock().await;
                            resolve_goose_session_id(&guard.sessions, &local_session_id)
                                .unwrap_or_else(|| local_session_id.clone())
                        };
                        let raw = call_ext_method(
                            &connection,
                            "goose/tools/call",
                            serde_json::json!({
                                "sessionId": goose_session_id,
                                "name": format!("{extension_name}__{name}"),
                                "arguments": arguments,
                            }),
                        )
                        .await?;
                        let parsed: ExtValueResponse =
                            serde_json::from_str(&raw).map_err(|error| {
                                format!("Failed to decode call tool response: {error}")
                            })?;
                        Ok(parsed.result)
                    }
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::ListResources {
                local_session_id,
                extension_name,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result = async {
                        let goose_session_id = {
                            let guard = state.lock().await;
                            resolve_goose_session_id(&guard.sessions, &local_session_id)
                                .unwrap_or_else(|| local_session_id.clone())
                        };
                        let raw = call_ext_method(
                            &connection,
                            "goose/resources/list",
                            serde_json::json!({
                                "sessionId": goose_session_id,
                                "extensionName": extension_name,
                            }),
                        )
                        .await?;
                        let parsed: ExtValueResponse =
                            serde_json::from_str(&raw).map_err(|error| {
                                format!("Failed to decode list resources response: {error}")
                            })?;
                        Ok(parsed.result)
                    }
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::ListResourceTemplates {
                local_session_id,
                extension_name,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result = async {
                        let goose_session_id = {
                            let guard = state.lock().await;
                            resolve_goose_session_id(&guard.sessions, &local_session_id)
                                .unwrap_or_else(|| local_session_id.clone())
                        };
                        let raw = call_ext_method(
                            &connection,
                            "goose/resources/templates/list",
                            serde_json::json!({
                                "sessionId": goose_session_id,
                                "extensionName": extension_name,
                            }),
                        )
                        .await?;
                        let parsed: ExtValueResponse =
                            serde_json::from_str(&raw).map_err(|error| {
                                format!(
                                    "Failed to decode list resource templates response: {error}"
                                )
                            })?;
                        Ok(parsed.result)
                    }
                    .await;
                    let _ = response.send(result);
                });
            }
            ManagerCommand::ListPrompts {
                local_session_id,
                extension_name,
                response,
            } => {
                let connection = Arc::clone(&connection);
                let state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let result = async {
                        let goose_session_id = {
                            let guard = state.lock().await;
                            resolve_goose_session_id(&guard.sessions, &local_session_id)
                                .unwrap_or_else(|| local_session_id.clone())
                        };
                        let raw = call_ext_method(
                            &connection,
                            "goose/prompts/list",
                            serde_json::json!({
                                "sessionId": goose_session_id,
                                "extensionName": extension_name,
                            }),
                        )
                        .await?;
                        let parsed: ExtValueResponse =
                            serde_json::from_str(&raw).map_err(|error| {
                                format!("Failed to decode list prompts response: {error}")
                            })?;
                        Ok(parsed.result)
                    }
                    .await;
                    let _ = response.send(result);
                });
            }
        }
    }
}
