//! Local HTTP relay for media streams.
//!
//! Xtream streams are plain `http://` URLs without CORS headers, which the
//! webview refuses to read from JavaScript (mpegts.js) and, on an https app
//! origin, refuses to load at all. The relay listens on 127.0.0.1, which
//! browsers treat as a secure origin, builds the upstream URL from the signed-in
//! session, forwards `Range` for seeking, and adds CORS headers.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;

use crate::state::AppState;
use crate::xtream::StreamKind;

pub async fn serve(listener: std::net::TcpListener, state: Arc<AppState>) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(err) => {
            log::error!("stream proxy failed to start: {err}");
            return;
        }
    };
    let app = Router::new()
        .route("/{kind}/{file}", get(relay).options(preflight))
        .with_state(state);
    if let Err(err) = axum::serve(listener, app).await {
        log::error!("stream proxy stopped: {err}");
    }
}

#[derive(Deserialize)]
struct TokenQuery {
    t: String,
}

/// Splits `1234.ts` into `("1234", "ts")`, rejecting anything that is not a
/// numeric id with a short alphanumeric extension.
pub fn parse_file(file: &str) -> Option<(&str, &str)> {
    let (id, ext) = file.split_once('.')?;
    let id_ok = !id.is_empty() && id.chars().all(|c| c.is_ascii_digit());
    let ext_ok = (1..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric());
    (id_ok && ext_ok).then_some((id, ext))
}

async fn relay(
    State(state): State<Arc<AppState>>,
    Path((kind, file)): Path<(String, String)>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> Response {
    if query.t != state.proxy_token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let (Some(kind), Some((id, ext))) = (StreamKind::from_path(&kind), parse_file(&file)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(creds) = state.credentials().await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let mut request = state.http.get(creds.stream_url(kind, id, ext));
    if let Some(range) = headers.get(header::RANGE) {
        request = request.header(header::RANGE, range);
    }
    let upstream = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            log::warn!("upstream request failed: {err}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    let mut response = Response::builder().status(upstream.status());
    if let Some(out) = response.headers_mut() {
        for name in [
            header::CONTENT_TYPE,
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
        ] {
            if let Some(value) = upstream.headers().get(&name) {
                out.insert(name, value.clone());
            }
        }
        apply_cors(out);
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn preflight() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    apply_cors(response.headers_mut());
    response
}

fn apply_cors(headers: &mut HeaderMap) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xtream::Credentials;

    #[test]
    fn parses_valid_file() {
        assert_eq!(parse_file("123.ts"), Some(("123", "ts")));
        assert_eq!(parse_file("9.mkv"), Some(("9", "mkv")));
    }

    #[test]
    fn rejects_traversal_and_junk() {
        assert_eq!(parse_file("../x.ts"), None);
        assert_eq!(parse_file("12.t/s"), None);
        assert_eq!(parse_file("abc.ts"), None);
        assert_eq!(parse_file("12"), None);
    }

    /// Relays through a fake panel, checking the token, URL layout and Range passthrough.
    #[tokio::test]
    async fn relays_streams_from_the_signed_in_panel() {
        let upstream =
            Router::new().route(
                "/movie/{user}/{pass}/{file}",
                get(
                    |Path((user, pass, file)): Path<(String, String, String)>,
                     headers: HeaderMap| async move {
                        let range = headers
                            .get(header::RANGE)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("none")
                            .to_owned();
                        (
                            StatusCode::PARTIAL_CONTENT,
                            [(header::CONTENT_RANGE, "bytes 0-9/100")],
                            format!("{user}:{pass}:{file}:{range}"),
                        )
                    },
                ),
            );
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(upstream_listener, upstream).await.unwrap() });

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let state = Arc::new(AppState::new(listener.local_addr().unwrap().port()));
        *state.session.write().await =
            Some(Credentials::new(&upstream_addr.to_string(), "user", "secret").unwrap());
        tokio::spawn(serve(listener, state.clone()));

        let client = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{}/movie/42.mp4", state.proxy_port);

        let denied = client.get(format!("{base}?t=wrong")).send().await.unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        let response = client
            .get(format!("{base}?t={}", state.proxy_token))
            .header(header::RANGE, "bytes=0-9")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 0-9/100");
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(
            response.text().await.unwrap(),
            "user:secret:42.mp4:bytes=0-9"
        );
    }
}
