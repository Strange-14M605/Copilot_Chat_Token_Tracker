"""Database configuration and initialization for the Copilot usage API.

This module creates the SQLAlchemy engine, exposes a shared session factory, and
ensures the schema exists before the app serves requests.
"""

from __future__ import annotations

import os

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

DEFAULT_DATABASE_URL = "sqlite:///./copilot_usage.db"
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL)

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def init_db() -> None:
    """Create all application tables if they do not already exist."""
    from app.models import Feature, PI, Usage, User

    Base.metadata.create_all(bind=engine)

    if engine.dialect.name == "postgresql":
        usage_columns = inspect(engine).get_columns("usage")
        usage_id_column = next(column for column in usage_columns if column["name"] == "usage_id")
        current_length = getattr(usage_id_column["type"], "length", None)
        if current_length is not None and current_length < 512:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE usage ALTER COLUMN usage_id TYPE VARCHAR(512)"))

    with SessionLocal() as session:
        session.execute(text("SELECT 1"))
        session.commit()
