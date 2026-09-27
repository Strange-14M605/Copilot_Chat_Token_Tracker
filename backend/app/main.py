"""FastAPI application for tracking Copilot usage and dashboard analytics.

This module exposes the public API used by the VS Code extension, dashboard, and
admin tooling. It stores users, product initiatives, features, and ingestion
records, then exposes aggregate metrics for reporting.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Response, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import SessionLocal, init_db
from app.models import Feature, PI, Usage, User
from app.schemas import (
    FeatureCreate,
    FeatureRead,
    OverviewResponse,
    PICreate,
    PIRead,
    UsageCreate,
    UsageRead,
    UserCreate,
    UserRead,
    UserSummary,
)

app = FastAPI(
    title="Copilot AI Credit Tracker",
    description="Backend API for tracking GitHub Copilot AI credit usage",
    version="0.1.0",
)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

init_db()


def get_db() -> Session:
    """Yield a database session for each request and ensure it is closed afterwards."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def calculate_ai_credits(nano_aiu: int) -> float:
    """Convert nano-AIU values into AI credits using the business rule."""
    return round(nano_aiu / 1_000_000_000, 6)


def build_usage_id(conversation_id: str | None, response_id: str) -> str:
    """Create a stable, unique usage identifier from the conversation and response IDs."""
    if conversation_id:
        return f"{conversation_id}:{response_id}"
    return response_id


def usage_read(usage: Usage) -> UsageRead:
    """Serialize a stored usage row using the API response shape."""
    return UsageRead(
        usage_id=usage.usage_id,
        user_id=usage.user_id,
        feature_id=usage.feature_id,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        model=usage.model,
        created_at=usage.created_at,
        ai_credits=calculate_ai_credits(usage.nano_aiu),
    )


@app.on_event("startup")
def startup() -> None:
    """Create the schema when the application boots up."""
    init_db()


@app.get("/")
def root() -> dict[str, Any]:
    """Return the API metadata and a pointer to the Swagger docs."""
    return {"message": "Copilot AI Credit Tracker API", "docs": "/docs"}


@app.get("/dashboard", include_in_schema=False)
def dashboard() -> FileResponse:
    """Serve the browser dashboard without changing the API root response."""
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/users", response_model=list[UserRead])
def get_users(db: Session = Depends(get_db)) -> list[UserRead]:
    """List all tracked users in reverse-chronological creation order."""
    return db.execute(select(User).order_by(User.created_at.desc())).scalars().all()


@app.post("/user", response_model=UserRead, status_code=status.HTTP_201_CREATED)
@app.post("/users", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def create_user(user: UserCreate, db: Session = Depends(get_db)) -> User:
    """Create a user record for a Copilot consumer or team member."""
    existing = db.execute(select(User).where(User.username == user.username)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User already exists")

    db_user = User(username=user.username)
    db.add(db_user)
    try:
        db.commit()
        db.refresh(db_user)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User already exists") from exc
    return db_user


@app.get("/pis", response_model=list[PIRead])
def get_pis(db: Session = Depends(get_db)) -> list[PI]:
    return db.execute(select(PI).order_by(PI.created_at.desc())).scalars().all()


@app.post("/pis", response_model=PIRead, status_code=status.HTTP_201_CREATED)
def create_pi(pi: PICreate, db: Session = Depends(get_db)) -> PI:
    db_pi = PI(name=pi.name, description=pi.description)
    db.add(db_pi)
    try:
        db.commit()
        db.refresh(db_pi)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="PI already exists") from exc
    return db_pi


@app.get("/features", response_model=list[FeatureRead])
def get_features(db: Session = Depends(get_db)) -> list[Feature]:
    return db.execute(select(Feature).order_by(Feature.created_at.desc())).scalars().all()


@app.post("/features", response_model=FeatureRead, status_code=status.HTTP_201_CREATED)
def create_feature(feature: FeatureCreate, db: Session = Depends(get_db)) -> Feature:
    pi = db.get(PI, feature.pi_id)
    if not pi:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PI not found")

    db_feature = Feature(pi_id=feature.pi_id, name=feature.name, description=feature.description)
    db.add(db_feature)
    try:
        db.commit()
        db.refresh(db_feature)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Feature already exists for PI") from exc
    return db_feature


@app.get("/usage", response_model=list[UsageRead])
def get_usage(
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=1000),
) -> list[Usage]:
    return db.execute(select(Usage).order_by(Usage.created_at.desc()).limit(limit)).scalars().all()


@app.post("/usage", response_model=UsageRead, status_code=status.HTTP_201_CREATED)
def create_usage(usage: UsageCreate, response: Response, db: Session = Depends(get_db)) -> UsageRead:
    if usage.user_id:
        user = db.get(User, usage.user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if usage.feature_id:
        feature = db.get(Feature, usage.feature_id)
        if not feature:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feature not found")

    usage_id = build_usage_id(usage.conversation_id, usage.response_id)

    existing = db.execute(
        select(Usage).where(
            Usage.conversion_id == usage.conversion_id,
            Usage.response_id == usage.response_id,
        )
    ).scalar_one_or_none()
    if existing:
        response.status_code = status.HTTP_200_OK
        return usage_read(existing)

    db_usage = Usage(
        usage_id=usage_id,
        conversion_id=usage.conversion_id,
        response_id=usage.response_id,
        user_id=usage.user_id,
        feature_id=usage.feature_id,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        model=usage.model,
        nano_aiu=usage.nano_aiu,
        conversation_id=usage.conversation_id,
        server_request_id=usage.server_request_id,
    )
    db.add(db_usage)
    try:
        db.commit()
        db.refresh(db_usage)
    except IntegrityError as exc:
        db.rollback()
        existing = db.execute(
            select(Usage).where(
                Usage.conversion_id == usage.conversion_id,
                Usage.response_id == usage.response_id,
            )
        ).scalar_one_or_none()
        if existing:
            response.status_code = status.HTTP_200_OK
            return usage_read(existing)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Usage could not be stored") from exc

    return usage_read(db_usage)


@app.get("/analytics/overview", response_model=OverviewResponse)
def analytics_overview(db: Session = Depends(get_db)) -> dict[str, Any]:
    total_q = db.query(func.count(Usage.usage_id)).scalar() or 0
    total_tokens_q = db.query(func.coalesce(func.sum(Usage.input_tokens + Usage.output_tokens), 0)).scalar() or 0
    total_ai_credits_q = db.query(func.coalesce(func.sum(Usage.nano_aiu), 0)).scalar() or 0

    rows = db.execute(
        select(
            PI.pi_id,
            PI.name,
            func.coalesce(func.sum(Usage.nano_aiu), 0).label("total_nano_aiu"),
            func.coalesce(func.sum(Usage.input_tokens + Usage.output_tokens), 0).label("total_tokens"),
            func.count(Usage.usage_id).label("total_queries"),
        )
        .select_from(PI)
        .join(Feature, Feature.pi_id == PI.pi_id)
        .join(Usage, Usage.feature_id == Feature.feature_id, isouter=True)
        .group_by(PI.pi_id, PI.name)
        .order_by(func.sum(Usage.nano_aiu).desc())
    ).all()

    by_pi = [
        {
            "pi_id": row[0],
            "name": row[1],
            "ai_credits": round((row[2] or 0) / 1_000_000_000, 6),
            "total_tokens": int(row[3] or 0),
            "total_queries": int(row[4] or 0),
        }
        for row in rows
    ]

    return {
        "total_ai_credits": round((total_ai_credits_q or 0) / 1_000_000_000, 6),
        "total_tokens": int(total_tokens_q or 0),
        "total_queries": int(total_q or 0),
        "by_pi": by_pi,
    }


@app.get("/analytics/pi/{pi_id}", response_model=list[FeatureRead])
def analytics_pi(pi_id: str, db: Session = Depends(get_db)) -> list[Feature]:
    features = db.execute(select(Feature).where(Feature.pi_id == pi_id).order_by(Feature.created_at.desc())).scalars().all()
    if not features:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PI not found")
    return features


@app.get("/analytics/feature/{feature_id}")
def analytics_feature(feature_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    feature = db.get(Feature, feature_id)
    if not feature:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feature not found")

    total_usage = db.execute(
        select(
            func.count(Usage.usage_id),
            func.coalesce(func.sum(Usage.input_tokens + Usage.output_tokens), 0),
            func.coalesce(func.sum(Usage.nano_aiu), 0),
        ).where(Usage.feature_id == feature_id)
    ).one()

    user_rows = db.execute(
        select(
            User.user_id,
            User.username,
            func.coalesce(func.sum(Usage.nano_aiu), 0).label("user_nano_aiu"),
            func.coalesce(func.sum(Usage.input_tokens + Usage.output_tokens), 0).label("user_tokens"),
            func.count(Usage.usage_id).label("user_queries"),
        )
        .select_from(User)
        .join(Usage, Usage.user_id == User.user_id, isouter=True)
        .where((Usage.feature_id == feature_id) | (Usage.feature_id.is_(None)))
        .group_by(User.user_id, User.username)
        .order_by(func.sum(Usage.nano_aiu).desc())
    ).all()

    models = db.execute(
        select(
            Usage.model,
            func.count(Usage.usage_id).label("queries"),
            func.coalesce(func.sum(Usage.nano_aiu), 0).label("nano_total"),
        )
        .where(Usage.feature_id == feature_id)
        .group_by(Usage.model)
        .order_by(func.count(Usage.usage_id).desc())
    ).all()

    return {
        "feature": {"feature_id": feature.feature_id, "pi_id": feature.pi_id, "name": feature.name},
        "metrics": {
            "ai_credits": round((total_usage[2] or 0) / 1_000_000_000, 6),
            "total_tokens": int(total_usage[1] or 0),
            "queries": int(total_usage[0] or 0),
        },
        "users": [
            {
                "user_id": row[0],
                "username": row[1],
                "ai_credits": round((row[2] or 0) / 1_000_000_000, 6),
                "total_tokens": int(row[3] or 0),
                "total_queries": int(row[4] or 0),
            }
            for row in user_rows
        ],
        "models": [
            {"model": row[0], "queries": int(row[1]), "ai_credits": round((row[2] or 0) / 1_000_000_000, 6)}
            for row in models
        ],
    }


@app.get("/analytics/feature/{feature_id}/users", response_model=list[UserSummary])
def feature_users(feature_id: str, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    feature = db.get(Feature, feature_id)
    if not feature:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feature not found")

    rows = db.execute(
        select(
            User.user_id,
            User.username,
            func.coalesce(func.sum(Usage.nano_aiu), 0).label("nano_total"),
            func.coalesce(func.sum(Usage.input_tokens + Usage.output_tokens), 0).label("total_tokens"),
            func.count(Usage.usage_id).label("queries"),
        )
        .select_from(User)
        .join(Usage, Usage.user_id == User.user_id, isouter=True)
        .where(Usage.feature_id == feature_id)
        .group_by(User.user_id, User.username)
        .order_by(func.sum(Usage.nano_aiu).desc())
    ).all()

    return [
        {
            "user_id": row[0],
            "username": row[1],
            "ai_credits": round((row[2] or 0) / 1_000_000_000, 6),
            "total_tokens": int(row[3] or 0),
            "total_queries": int(row[4] or 0),
        }
        for row in rows
    ]


@app.get("/analytics/models")
def most_used_models(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = db.execute(
        select(
            Usage.model,
            func.count(Usage.usage_id).label("queries"),
            func.coalesce(func.sum(Usage.nano_aiu), 0).label("nano_total"),
        )
        .where(Usage.model.is_not(None))
        .group_by(Usage.model)
        .order_by(func.count(Usage.usage_id).desc())
    ).all()

    return [
        {"model": row[0], "queries": int(row[1]), "ai_credits": round((row[2] or 0) / 1_000_000_000, 6)}
        for row in rows
    ]
