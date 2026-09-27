"""Smoke tests for the Copilot usage API.

These tests validate the core contract: root response, object creation, usage
ingestion, and the aggregate overview analytics response.
"""

import os
import tempfile

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.NamedTemporaryFile(suffix='.db', delete=False).name}"

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_root_endpoint():
    """The health/info endpoint should return the API metadata."""
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["message"] == "Copilot AI Credit Tracker API"


def test_dashboard_and_static_assets_are_served():
    """The browser dashboard should be available without replacing the API root."""
    dashboard = client.get("/dashboard")
    assert dashboard.status_code == 200
    assert "Copilot Ledger" in dashboard.text

    stylesheet = client.get("/static/styles.css")
    assert stylesheet.status_code == 200
    assert "--green" in stylesheet.text


def test_create_user_and_feature_and_usage():
    """A user, PI, feature, and usage event should be created successfully."""
    create_user = client.post("/users", json={"username": "alice"})
    assert create_user.status_code == 201
    user = create_user.json()
    assert user["username"] == "alice"

    create_pi = client.post("/pis", json={"name": "Copilot Coding", "description": "Core coding workloads"})
    assert create_pi.status_code == 201
    pi = create_pi.json()

    create_feature = client.post(
        "/features",
        json={"pi_id": pi["pi_id"], "name": "Agent Mode", "description": "AI editing"},
    )
    assert create_feature.status_code == 201
    feature = create_feature.json()

    usage_payload = {
        "conversion_id": "conv-01",
        "response_id": "resp-01",
        "user_id": user["user_id"],
        "feature_id": feature["feature_id"],
        "input_tokens": 1200,
        "output_tokens": 50,
        "model": "mai-code-1.1-flash",
        "nano_aiu": 2_500_000_000,
        "conversation_id": "conv-uuid-1",
        "server_request_id": "server-1",
    }

    response = client.post("/usage", json=usage_payload)
    assert response.status_code == 201
    payload = response.json()
    assert payload["usage_id"] == "conv-uuid-1:resp-01"
    assert payload["model"] == "mai-code-1.1-flash"
    assert payload["ai_credits"] == 2.5
    assert "conversion_id" not in payload
    assert "response_id" not in payload
    assert "nano_aiu" not in payload

    replay = client.post("/usage", json=usage_payload)
    assert replay.status_code == 200
    assert replay.json()["usage_id"] == payload["usage_id"]
    assert replay.json()["ai_credits"] == payload["ai_credits"]


def test_singular_user_registration_alias():
    """The extension can register through the singular `/user` endpoint."""
    response = client.post("/user", json={"username": "extension-user"})
    assert response.status_code == 201
    assert response.json()["username"] == "extension-user"


def test_analytics_overview():
    """Overview analytics should include totals and per-PI rollups."""
    user_response = client.post("/users", json={"username": "bob"})
    assert user_response.status_code == 201
    user = user_response.json()

    pi_response = client.post("/pis", json={"name": "Docs", "description": "Documentation support"})
    assert pi_response.status_code == 201
    pi = pi_response.json()

    feature_response = client.post(
        "/features",
        json={"pi_id": pi["pi_id"], "name": "Summarization", "description": "Docs summary"},
    )
    assert feature_response.status_code == 201
    feature = feature_response.json()

    client.post(
        "/usage",
        json={
            "conversion_id": "conv-02",
            "response_id": "resp-02",
            "user_id": user["user_id"],
            "feature_id": feature["feature_id"],
            "input_tokens": 1000,
            "output_tokens": 100,
            "model": "gpt-5",
            "nano_aiu": 1_000_000_000,
        },
    )

    overview = client.get("/analytics/overview")
    assert overview.status_code == 200
    body = overview.json()
    assert body["total_ai_credits"] >= 3.5
    assert body["total_queries"] >= 2
    assert len(body["by_pi"]) >= 1
