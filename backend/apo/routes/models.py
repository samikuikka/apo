# pyright: reportCallInDefaultInitializer=false

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from ..db import get_session
from ..models.pricing import (
    ModelDefinitionDB,
    ModelDefinitionCreate,
    ModelDefinitionResponse,
    ModelMatchResponse,
)
from ..services.cost_calculation import (
    find_matching_model,
    seed_default_models,
    calculate_cost,
)

router = APIRouter()


@router.get("/api/v1/models", response_model=list[ModelDefinitionResponse])
async def list_models(
    project: str = Query(default="__global__"),
    session: Session = Depends(get_session),
):
    models = session.exec(
        select(ModelDefinitionDB).where(ModelDefinitionDB.project == project)
    ).all()
    return [ModelDefinitionResponse.model_validate(m) for m in models]


@router.post(
    "/api/v1/models", response_model=ModelDefinitionResponse, status_code=201
)
async def create_model(
    request: ModelDefinitionCreate,
    session: Session = Depends(get_session),
):
    model_def = ModelDefinitionDB(
        project=request.project,
        model_name=request.model_name,
        match_pattern=request.match_pattern,
        provider=request.provider,
        input_price=request.input_price,
        output_price=request.output_price,
        cached_input_price=request.cached_input_price,
    )
    session.add(model_def)
    session.commit()
    session.refresh(model_def)
    return ModelDefinitionResponse.model_validate(model_def)


@router.post("/api/v1/models/seed-defaults")
async def seed_defaults(
    project: str = Query(default="__global__"),
    session: Session = Depends(get_session),
):
    created = seed_default_models(session, project)
    return {"created": created, "message": f"Seeded {created} new model definitions"}


@router.get("/api/v1/models/match", response_model=ModelMatchResponse)
async def match_model(
    model: str = Query(...),
    prompt_tokens: int | None = Query(default=None),
    completion_tokens: int | None = Query(default=None),
    project: str = Query(default="__global__"),
    session: Session = Depends(get_session),
):
    model_def = find_matching_model(session, model, project)

    if model_def is None:
        return ModelMatchResponse(matched=False)

    cost = calculate_cost(model_def, prompt_tokens, completion_tokens)

    return ModelMatchResponse(
        matched=True,
        model_name=model_def.model_name,
        provider=model_def.provider,
        input_price=model_def.input_price,
        output_price=model_def.output_price,
        cached_input_price=model_def.cached_input_price,
        calculated_cost=cost,
    )
