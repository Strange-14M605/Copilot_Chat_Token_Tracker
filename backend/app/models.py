"""SQLAlchemy models that describe the Copilot usage domain.

The app stores users, product initiatives (PIs), features, and tracked usage
records. These models define the tables and relationships used by the API and
analytics endpoints.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class User(Base):
    """Represents a person or account that consumed Copilot usage."""

    __tablename__ = "users"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow, nullable=False)

    usages: Mapped[list["Usage"]] = relationship(back_populates="user")


class PI(Base):
    """Represents a product initiative or business area tracked in the dashboard."""

    __tablename__ = "pis"

    pi_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow, nullable=False)

    features: Mapped[list["Feature"]] = relationship(back_populates="pi")


class Feature(Base):
    """A feature within a PI that usage events can be associated to."""

    __tablename__ = "features"

    feature_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    pi_id: Mapped[str] = mapped_column(String(36), ForeignKey("pis.pi_id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow, nullable=False)

    __table_args__ = (UniqueConstraint("pi_id", "name", name="uq_feature_pi_name"),)

    pi: Mapped[PI] = relationship(back_populates="features")
    usages: Mapped[list["Usage"]] = relationship(back_populates="feature")


class Usage(Base):
    """One captured Copilot response event, including token and AIU data."""

    __tablename__ = "usage"

    usage_id: Mapped[str] = mapped_column(String(512), primary_key=True, default=lambda: str(uuid.uuid4()))
    conversion_id: Mapped[str] = mapped_column(String(255), nullable=False)
    response_id: Mapped[str] = mapped_column(String(255), nullable=False)

    user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.user_id"), nullable=True)
    feature_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("features.feature_id"), nullable=True)

    input_tokens: Mapped[int] = mapped_column(default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(default=0, nullable=False)
    model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    nano_aiu: Mapped[int] = mapped_column(nullable=False)
    conversation_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    server_request_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow, nullable=False)

    __table_args__ = (UniqueConstraint("conversion_id", "response_id", name="uq_usage_conversion_response"),)

    user: Mapped[User | None] = relationship(back_populates="usages")
    feature: Mapped[Feature | None] = relationship(back_populates="usages")

    @property
    def ai_credits(self) -> float:
        """Return the AI credit value implied by the nano-AIU field."""
        return round(self.nano_aiu / 1_000_000_000, 6)
