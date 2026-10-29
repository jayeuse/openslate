from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse, Response

from app.core.config import get_settings
from app.core.config.development import is_relaxed_development
from app.core.config.environment import environment_inputs
from app.core.config.instance import (
    assert_database_url,
    assert_instance_target,
    instance_identity_for_process,
    instance_target_for_process,
)
from app.core.config.provider_instance import assert_provider_instance
from app.core.config.settings import DOTENV_PATH
from app.core.database import model_registry  # noqa: F401
from app.core.database.session import dispose_database_resources, get_engine
from app.core.middleware.file_transfers import FileDispatchMiddleware
from app.core.middleware.trusted_hosts import ExactTrustedHostMiddleware
from app.core.observability import configure_observability_logging, log_event
from app.core.readiness import (
    dispose_readiness_resources,
    get_readiness_snapshot,
)
from app.core.static_site import StaticSite
from app.request_middleware import install_request_middleware
from app.systems.access.auth.aggregate_router import router as auth_router
from app.systems.access.auth.mfa_router import router as mfa_router
from app.systems.access.identity.provider_signout_worker import ProviderSignoutWorker
from app.systems.access.policy.configuration_router import router as access_policy_router
from app.systems.boards.access_preview_router import router as board_access_preview_router
from app.systems.boards.activity_router import router as board_activity_router
from app.systems.boards.attachment_router import router as board_attachments_router
from app.systems.boards.calendar_source_router import router as calendar_sources_router
from app.systems.boards.card_activity_router import router as board_card_activity_router
from app.systems.boards.card_batch_router import router as board_card_batch_router
from app.systems.boards.card_router import router as board_cards_router
from app.systems.boards.checklist_router import router as board_checklist_router
from app.systems.boards.cross_board_occurrence_router import (
    router as board_occurrences_router,
)
from app.systems.boards.due_card_router import router as board_due_cards_router
from app.systems.boards.event_author_router import router as board_event_authors_router
from app.systems.boards.event_router import router as board_events_router
from app.systems.boards.group_router import router as board_groups_router
from app.systems.boards.label_router import router as board_labels_router
from app.systems.boards.lifecycle_router import router as board_lifecycle_router
from app.systems.boards.post_author_router import router as board_post_authors_router
from app.systems.boards.post_manage_state_router import router as board_post_manage_router
from app.systems.boards.post_revision_router import router as board_post_revisions_router
from app.systems.boards.post_router import router as board_posts_router
from app.systems.boards.record_link_router import router as board_record_links_router
from app.systems.boards.router import router as boards_router
from app.systems.boards.stage_router import router as board_stages_router
from app.systems.comms.jobs.worker import scheduling_worker as comms_scheduler
from app.systems.comms.realtime.publisher import install_publication
from app.systems.comms.router import router as comms_router
from app.systems.manage.audit.router import internal_security_events_router, security_events_router
from app.systems.manage.audit.router import router as audit_router
from app.systems.manage.backups.router import router as backups_router
from app.systems.manage.jobs.router import router as jobs_router
from app.systems.manage.workspace.router import router as workspace_router
from app.systems.manage.workspace.security_router import router as workspace_security_router
from app.systems.openview.charts.router import router as charts_router
from app.systems.openview.dashboards.router import router as dashboards_router
from app.systems.openview.reports.router import router as reports_router
from app.systems.openview.reports.schedule_router import router as report_schedule_router
from app.systems.openview.views.router import router as views_router
from app.systems.platform.events.hub import (
    EventHub,
    PostgresInvalidationListener,
    subscriber_capacity,
)
from app.systems.platform.events.publisher import InvalidationPublisher
from app.systems.platform.events.router import router as events_router
from app.systems.platform.files.board_router import router as board_files_router
from app.systems.platform.files.lifecycle_router import router as file_lifecycle_router
from app.systems.platform.files.router import router as files_router
from app.systems.platform.realtime.router import router as realtime_router
from app.systems.platform.scheduling.notification_router import router as notifications_router
from app.systems.platform.search.router import router as search_router
from app.systems.sandbox.departments.router import router as departments_router
from app.systems.sandbox.designs.router import router as sandbox_designs_router
from app.systems.sandbox.fields.router import router as fields_router
from app.systems.sandbox.lifecycle.router import router as lifecycle_router
from app.systems.sandbox.modules.router import router as modules_router
from app.systems.sandbox.publications.router import router as sandbox_publications_router
from app.systems.sandbox.record_triggers.router import router as sandbox_record_triggers_router
from app.systems.sandbox.record_triggers.worker import TriggerWorker
from app.systems.sandbox.records.batch_router import router as record_batch_router
from app.systems.sandbox.records.import_router import router as record_import_router
from app.systems.sandbox.records.query_router import router as record_queries_router
from app.systems.sandbox.records.router import router as records_router
from app.systems.sandbox.relationships.router import router as relationships_router
from app.systems.sandbox.test_runs.router import router as sandbox_test_runs_router


@asynccontextmanager
async def application_lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_observability_logging()
    target = instance_target_for_process(get_settings().database_url, "openslate_runtime")
    if target is not None:
        settings = get_settings()
        assert_database_url(settings.database_url, target, expected_user="openslate_runtime")
        with get_engine().connect() as connection:
            assert_instance_target(connection, target, expected_user="openslate_runtime")
        assert_provider_instance(
            environment_inputs(DOTENV_PATH),
            database_url=settings.database_url,
            expected_user="openslate_runtime",
        )
    app.state.events_listener.start()
    invalidation_publisher = getattr(app.state, "invalidation_publisher", None)
    if invalidation_publisher is not None:
        invalidation_publisher.start()
    app.state.trigger_worker.start()
    app.state.comms_publisher.start()
    report_worker = getattr(app.state, "report_scheduling_worker", None)
    signout_worker = getattr(app.state, "provider_signout_worker", None)
    try:
        if signout_worker is not None:
            signout_worker.start()
        if report_worker is not None:
            report_worker.start()
        yield
    finally:
        signout_stopped = signout_worker.stop() if signout_worker is not None else True
        report_stopped = report_worker.stop() if report_worker is not None else True
        comms_stopped = app.state.comms_publisher.stop() if report_stopped else False
        trigger_stopped = app.state.trigger_worker.stop()
        if invalidation_publisher is not None:
            invalidation_publisher.stop()
        app.state.events_listener.stop()
        if trigger_stopped and report_stopped and signout_stopped and comms_stopped:
            dispose_readiness_resources()
            dispose_database_resources()
        else:
            if not signout_stopped:
                log_event(
                    "operational_attention",
                    reason_code="provider_signout_shutdown_incomplete",
                    upstream="supabase-auth",
                )
            if not trigger_stopped:
                log_event(
                    "operational_attention",
                    reason_code="sandbox_trigger_shutdown_incomplete",
                    upstream="sandbox-triggers",
                )
            if not report_stopped:
                log_event(
                    "operational_attention",
                    reason_code="report_scheduling_shutdown_incomplete",
                    upstream="report-scheduling",
                )


def create_app() -> FastAPI:
    settings = get_settings()
    configure_observability_logging()
    development = settings.environment in {"development", "test"}
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        lifespan=application_lifespan,
        docs_url="/api/docs" if development else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if development else None,
    )
    static_site = (
        StaticSite.load(settings.web_assets_root) if settings.web_assets_root is not None else None
    )
    app.state.static_site = static_site
    events_hub = EventHub(max_subscribers=subscriber_capacity(settings.server_max_concurrency))
    app.state.events_hub = events_hub
    app.state.events_listener = PostgresInvalidationListener(events_hub)
    app.state.invalidation_publisher = InvalidationPublisher()
    app.state.trigger_worker = TriggerWorker(settings)
    app.state.provider_signout_worker = ProviderSignoutWorker(settings)
    relaxed_development = is_relaxed_development(settings)
    if not relaxed_development:
        app.add_middleware(
            ExactTrustedHostMiddleware,
            allowed_hosts=_trusted_hosts(settings.public_origin, environment=settings.environment),
            read_only_host_paths={
                host: (
                    "/api/auth/email-templates/invite.html",
                    "/api/auth/email-templates/recovery.html",
                    "/api/auth/email-templates/email-change.html",
                )
                for host in ("api", "host.docker.internal")
            },
        )
    app.add_middleware(FileDispatchMiddleware)
    install_request_middleware(app, settings, relaxed_development=relaxed_development)

    app.include_router(auth_router, prefix="/api")
    app.include_router(mfa_router, prefix="/api")
    app.include_router(access_policy_router, prefix="/api")
    app.include_router(departments_router, prefix="/api")
    app.include_router(sandbox_designs_router, prefix="/api")
    app.include_router(sandbox_publications_router, prefix="/api")
    app.include_router(sandbox_record_triggers_router, prefix="/api")
    app.include_router(sandbox_test_runs_router, prefix="/api")
    app.include_router(modules_router, prefix="/api")
    app.include_router(fields_router, prefix="/api")
    app.include_router(record_batch_router, prefix="/api")
    app.include_router(record_import_router, prefix="/api")
    app.include_router(record_queries_router, prefix="/api")
    app.include_router(records_router, prefix="/api")
    app.include_router(board_access_preview_router, prefix="/api")
    app.include_router(board_activity_router, prefix="/api")
    app.include_router(board_groups_router, prefix="/api")
    app.include_router(board_lifecycle_router, prefix="/api")
    app.include_router(board_event_authors_router, prefix="/api")
    app.include_router(board_occurrences_router, prefix="/api")
    app.include_router(board_due_cards_router, prefix="/api")
    app.include_router(calendar_sources_router, prefix="/api")
    app.include_router(board_events_router, prefix="/api")
    app.include_router(board_record_links_router, prefix="/api")
    app.include_router(board_stages_router, prefix="/api")
    app.include_router(board_labels_router, prefix="/api")
    app.include_router(board_card_batch_router, prefix="/api")
    app.include_router(board_cards_router, prefix="/api")
    app.include_router(board_checklist_router, prefix="/api")
    app.include_router(board_card_activity_router, prefix="/api")
    app.include_router(board_post_authors_router, prefix="/api")
    app.include_router(board_post_manage_router, prefix="/api")
    app.include_router(board_post_revisions_router, prefix="/api")
    app.include_router(board_posts_router, prefix="/api")
    app.include_router(board_attachments_router, prefix="/api")
    app.include_router(board_files_router, prefix="/api")
    app.include_router(boards_router, prefix="/api")
    app.include_router(comms_router, prefix="/api")
    app.include_router(charts_router, prefix="/api")
    app.include_router(dashboards_router, prefix="/api")
    app.include_router(reports_router, prefix="/api")
    app.include_router(report_schedule_router, prefix="/api")
    app.include_router(views_router, prefix="/api")
    app.include_router(notifications_router, prefix="/api")
    app.include_router(search_router, prefix="/api")
    app.include_router(workspace_router, prefix="/api")
    app.include_router(workspace_security_router, prefix="/api")
    app.include_router(backups_router, prefix="/api")
    app.include_router(jobs_router, prefix="/api")
    app.include_router(files_router, prefix="/api")
    app.include_router(events_router, prefix="/api")
    app.include_router(realtime_router, prefix="/api")
    app.include_router(file_lifecycle_router, prefix="/api")
    app.include_router(relationships_router, prefix="/api")
    app.include_router(lifecycle_router, prefix="/api")
    app.include_router(audit_router, prefix="/api")
    app.include_router(security_events_router, prefix="/api")
    app.include_router(internal_security_events_router, prefix="/api")

    @app.get("/api/health", tags=["system"])
    def health(response: Response) -> dict[str, str]:
        identity = instance_identity_for_process()
        if identity is not None:
            response.headers["X-OpenSlate-Instance"] = identity
        return {"status": "ok", "service": "openslate-api"}

    @app.get("/api/ready", tags=["system"])
    def ready() -> JSONResponse:
        snapshot = get_readiness_snapshot()
        return JSONResponse(
            status_code=200 if snapshot["status"] == "ready" else 503,
            content=snapshot,
            headers={"Cache-Control": "no-store"},
        )

    @app.exception_handler(StarletteHTTPException)
    async def route_not_found(request: Request, error: StarletteHTTPException) -> Response:
        if error.status_code != 404:
            return await http_exception_handler(request, error)
        path = request.url.path
        if path == "/api" or path.startswith("/api/"):
            return JSONResponse(
                status_code=404,
                content={"detail": error.detail},
                headers=error.headers,
            )
        if static_site is not None:
            if request.method in {"GET", "HEAD"}:
                return static_site.response_for(path)
            if path in static_site.pages:
                return Response(status_code=405, headers={"Allow": "GET, HEAD"})
        return await http_exception_handler(request, error)

    install_publication(app, settings)
    app.state.report_scheduling_worker = comms_scheduler(settings, app.state.comms_publisher.submit)
    return app


def _trusted_hosts(public_origin: str, *, environment: str) -> list[str]:
    host = urlsplit(public_origin).hostname
    assert host is not None
    allowed = [host, "localhost", "127.0.0.1", "::1"]
    if environment == "test":
        allowed.append("testserver")
    return allowed


app = create_app()
