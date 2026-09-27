"""Request and response models used by the FastAPI routes.

These schemas define the public contract for creating users, PIs, features, usage
records, and analytics responses. They also help convert SQLAlchemy objects into
JSON-friendly payloads for the dashboard and extension clients.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class UserCreate(BaseModel):
    """Input payload for creating a user record."""

    username: str = Field(..., min_length=1, max_length=255)


class UserRead(UserCreate):
    """Serialized user row returned by the API."""

    model_config = ConfigDict(from_attributes=True)
    user_id: str
    created_at: datetime


class PICreate(BaseModel):
    """Input payload for creating a product initiative."""

    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None


class PIRead(PICreate):
    """Serialized PI row returned by the API."""

    model_config = ConfigDict(from_attributes=True)
    pi_id: str
    created_at: datetime


class FeatureCreate(BaseModel):
    """Input payload for attaching a feature to a PI."""

    pi_id: str
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None


class FeatureRead(FeatureCreate):
    """Serialized feature record returned by the API."""

    model_config = ConfigDict(from_attributes=True)
    feature_id: str
    created_at: datetime


class UsageCreate(BaseModel):
    """Input payload sent when a Copilot usage event is ingested."""

    conversion_id: str
    response_id: str
    user_id: Optional[str] = None
    feature_id: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0
    model: Optional[str] = None
    nano_aiu: int = 0
    conversation_id: Optional[str] = None
    server_request_id: Optional[str] = None


class UsageRead(BaseModel):
    """Usage record returned after creation, stripped to the dashboard-friendly shape."""

    model_config = ConfigDict(from_attributes=True)
    usage_id: str
    user_id: Optional[str] = None
    feature_id: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0
    model: Optional[str] = None
    created_at: datetime
    ai_credits: float


class OverviewRow(BaseModel):
    """Per-PI summary in the overview analytics response."""

    pi_id: str
    name: str
    ai_credits: float
    total_tokens: int
    total_queries: int


class OverviewResponse(BaseModel):
    """High-level aggregated totals for the dashboard home view."""

    total_ai_credits: float
    total_tokens: int
    total_queries: int
    by_pi: list[OverviewRow]


class FeatureSummary(BaseModel):
    """Summary of a feature-level analytics view."""

    feature_id: str
    name: str
    ai_credits: float
    total_tokens: int
    total_queries: int


class UserSummary(BaseModel):
    """Aggregate usage metrics for one user within a feature or PI."""

    user_id: str
    username: str
    ai_credits: float
    total_tokens: int
    total_queries: int


class ModelSummary(BaseModel):
    """A model breakdown, such as prompt count and AI credits used."""

    model: str
    queries: int
    ai_credits: float


class UsageRecord(BaseModel):
    """A plain usage record representation used in API responses."""

    usage_id: str
    conversion_id: str
    response_id: str
    user_id: Optional[str]
    feature_id: Optional[str]
    input_tokens: int
    output_tokens: int
    model: Optional[str]
    nano_aiu: int
    created_at: datetime
    ai_credits: float
