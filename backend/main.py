from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(
    title="Copilot AI Credit Tracker",
    description="Backend API for tracking GitHub Copilot AI credit usage",
    version="0.1.0",
)


class CopilotUsage(BaseModel):
    model: str = Field(..., examples=["gpt-6-luna"])
    input_tokens: int = Field(..., examples=[28665])
    output_tokens: int = Field(..., examples=[12])
    cache_read_input_tokens: int = Field(..., examples=[17948])
    nano_aiu: int = Field(..., examples=[152503000])
    conversation_id: str = Field(
        ...,
        examples=["3d2d736c-f1fd-4ada-917f-59ce8592bc2a"]
    )


@app.get("/")
def root():
    return {
        "message": "Copilot AI Credit Tracker API",
        "docs": "/docs"
    }


@app.post("/api/v1/copilot/usage")
def record_usage(usage: CopilotUsage):
    return {
        "status": "success",
        "message": "Copilot usage recorded",
        "data": usage.model_dump()
    }