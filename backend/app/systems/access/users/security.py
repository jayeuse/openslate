"""Fresh person-security admission and bounded provider observations/effects."""

from dataclasses import dataclass, field
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import (
    CurrentIdentity,
    lock_administrator_changes,
    require_fresh_exact_admin,
)
from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.database.organization_scope import session_organization
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    InvalidProviderToken,
    ProviderAccessIdentity,
    ProviderUser,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity.mfa import requires_mfa
from app.systems.access.identity.mfa_observations import (
    commit_bound_observation,
    observation_started_at,
    record_provider_observation,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.session_revocation import revoke_user_sessions
from app.systems.access.users.coordination import (
    advance_token_cutoff,
    shares_another_organization,
)
from app.systems.access.users.membership import (
    bound_organization,
    current_membership,
    is_platform_operator,
    require_current_membership,
)
from app.systems.access.users.models import Membership, User
from app.systems.access.users.schemas import (
    UserMfaResetResponse,
    UserRecoveryResponse,
    UserSecurityResponse,
)
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
    append_security_event,
)
from app.systems.manage.workspace.security_policy import (
    effective_session_expiry,
    load_platform_policy,
    load_workspace_policy,
)


@dataclass(frozen=True)
class Binding:
    user_id: UUID
    provider_id: UUID
    email: str = field(repr=False)


@dataclass(frozen=True)
class Actor:
    user_id: UUID
    session_id: UUID
    claims: ProviderAccessIdentity


def refusal(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def presented_actor(db: Session, identity: CurrentIdentity, request: Request) -> Actor:
    actor_id, session_id = identity.user.id, identity.session_id
    # End authentication reads before a possible JWKS request. The resulting
    # signed claims must still match fresh locked local admission below.
    db.rollback()
    token = (
        request.cookies.get("openslate_access")
        or request.headers.get("Authorization", "").partition(" ")[2]
    )
    try:
        claims = get_supabase_auth_client().verify_access_token(token)
    except InvalidProviderToken as error:
        raise refusal(401, "security_identity_changed",
                      "Your session must be verified again.") from error
    except SupabaseAuthUnavailable as error:
        raise refusal(503, "user_security_unavailable",
                      "Security is unavailable. Try again.") from error
    return Actor(actor_id, session_id, claims)


def checkpoint(
    db: Session,
    actor: Actor,
    target_id: UUID,
    *,
    expected: Binding | None = None,
    mutation: bool = False,
    self_continuation: bool = False,
) -> tuple[Binding, bool]:
    try:
        require_visible_target(db, target_id)
        observed = None
        if not self_continuation:
            db.rollback()
            observed = get_supabase_auth_client().get_admin_user(actor.claims.user_id)
        lock_administrator_changes(db, exclusive=False)
        users = {
            user.id: user
            for user in db.scalars(
                select(User)
                .where(User.id.in_({actor.user_id, target_id}))
                .order_by(User.id)
                .execution_options(populate_existing=True)
                .with_for_update(of=User)
            )
        }
        admin = require_fresh_exact_admin(db, actor.user_id)
        session = db.get(
            IdentitySession, actor.session_id, with_for_update=True, populate_existing=True
        )
        now = utc_now()
        policy = load_platform_policy(db)
        if not self_continuation and (
            session is None
            or session.user_id != admin.id
            or session.revoked_at is not None
            or effective_session_expiry(session, policy) <= now
            or session.provider_user_id != admin.supabase_user_id
            or session.provider_user_id != actor.claims.user_id
            or session.provider_session_id != actor.claims.session_id
            or actor.claims.expires_at <= now
            or (
                admin.tokens_valid_after is not None
                and actor.claims.issued_at < admin.tokens_valid_after
            )
        ):
            raise refusal(401, "security_identity_changed", "Your session must be verified again.")
        if observed is not None:
            if (observed.id != admin.supabase_user_id or observed.email != admin.email
                    or not observed.is_eligible(now=now)):
                raise refusal(401, "security_identity_changed",
                              "Your session must be verified again.")
            if requires_mfa(
                load_workspace_policy(db, org_id=bound_organization(db)),
                require_current_membership(db, admin), observed
            ) and (
                actor.claims.assurance_level != "aal2"
                or not any(
                    factor.factor_type == "totp" and factor.status == "verified"
                    for factor in observed.factors
                )
            ):
                raise refusal(403, "mfa_required",
                              "Complete multi-factor authentication to continue.")
        target = users.get(target_id)
        if target is None or target.is_deleted:
            raise refusal(404, "security_target_missing", "This person is unavailable.")
        require_visible_target(db, target_id)
        if target.supabase_user_id is None:
            raise refusal(409, "security_target_unbound",
                          "This person has no bound sign-in identity.")
        binding = Binding(target.id, target.supabase_user_id, target.email)
        if expected is not None and binding != expected:
            raise refusal(409, "security_binding_changed",
                          "This person's sign-in identity changed. Reload before continuing.")
        # Eligible means an eligible member of this organization, not just an active account.
        eligible = current_membership(db, target) is not None
        if mutation and not eligible:
            raise refusal(409, "security_target_ineligible",
                          "This person is not eligible for this action.")
        if (
            mutation and shares_another_organization(db, target)
            and not is_platform_operator(db, admin.id)
        ):
            # A security reset reaches every organization of the person (owner decision).
            raise refusal(409, "security_target_shared",
                          "This person also belongs to another organization.")
        return binding, eligible
    except InvalidProviderCredentials as error:
        db.rollback()
        raise refusal(401, "security_identity_changed",
                      "Your session must be verified again.") from error
    except (SQLAlchemyError, SupabaseAuthUnavailable) as error:
        db.rollback()
        raise refusal(503, "user_security_unavailable",
                      "Security is unavailable. Try again.") from error
    except HTTPException:
        db.rollback()
        raise


def require_visible_target(db: Session, target_id: UUID) -> None:
    if db.scalar(select(Membership.id).join(User, User.id == Membership.user_id).where(
        Membership.org_id == bound_organization(db), Membership.user_id == target_id,
        Membership.is_deleted.is_(False), User.is_deleted.is_(False),
    )) is None:
        raise refusal(404, "security_target_missing", "This person is unavailable.")


def provider_user(client: SupabaseAuthClient, binding: Binding) -> ProviderUser:
    try:
        user = client.get_admin_user(binding.provider_id)
    except InvalidProviderCredentials as error:
        raise refusal(
            409, "security_binding_changed",
            "This person's sign-in identity changed. Reload before continuing.") from error
    if user.id != binding.provider_id or user.email != binding.email:
        raise refusal(409, "security_binding_changed",
                      "This person's sign-in identity changed. Reload before continuing.")
    return user


def smtp_configured() -> bool:
    settings = get_settings()
    return bool(settings.smtp_host and settings.smtp_port and settings.smtp_admin_email)


def read_security(
    db: Session, identity: CurrentIdentity, request: Request, target_id: UUID
) -> UserSecurityResponse:
    require_fresh_exact_admin(db, identity.user.id)
    require_visible_target(db, target_id)
    actor = presented_actor(db, identity, request)
    binding, _ = checkpoint(db, actor, target_id)
    db.rollback()
    started_at = observation_started_at()
    try:
        observed = provider_user(get_supabase_auth_client(), binding)
    except SupabaseAuthUnavailable as error:
        raise refusal(503, "user_security_unavailable",
                      "Security could not be loaded. Try again.") from error
    _, eligible = checkpoint(db, actor, target_id, expected=binding)
    try:
        record_provider_observation(db, target_id, observed, started_at)
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise refusal(503, "user_security_unavailable",
                      "Security could not be loaded. Try again.") from error
    return UserSecurityResponse(
        user_id=target_id,
        verified_factor_count=sum(factor.status == "verified" for factor in observed.factors),
        target_eligible=eligible and observed.is_eligible(),
        smtp_configured=smtp_configured(),
    )


@dataclass
class Operation:
    actor: Actor
    binding: Binding
    kind: str
    id: UUID = field(default_factory=uuid4)
    email_request: str = "not_attempted"
    local_revocation: str = "not_requested"
    revoked_sessions: int = 0
    factors_cleared: bool | None = None

    def payload(self, outcome: SecurityEventOutcome) -> SecurityEventIngestRequest:
        return SecurityEventIngestRequest(
            event_type=f"identity.{self.kind}",
            outcome=outcome,
            source="access.users",
            operation_id=self.id,
            actor_id=self.actor.user_id,
            subject_id=self.binding.user_id,
            metadata={
                "email_request": self.email_request,
                "local_revocation": self.local_revocation,
                "revoked_sessions": self.revoked_sessions,
                "factors_cleared": self.factors_cleared,
            },
        )

    def failure(self) -> HTTPException:
        return HTTPException(
            503,
            detail={
                "code": "security_action_incomplete",
                "message": (
                    "This action could not be confirmed. "
                    "Reload security and sessions before trying again."
                ),
                "operation_id": str(self.id),
                "email_request": self.email_request,
                "local_revocation": self.local_revocation,
                "factors_cleared": self.factors_cleared,
            },
        )


def commit_event(db: Session, operation: Operation, outcome: SecurityEventOutcome) -> None:
    append_security_event(db, operation.payload(outcome))
    db.commit()


def admit_operation(
    db: Session, identity: CurrentIdentity, request: Request, target_id: UUID, kind: str
) -> Operation:
    actor = presented_actor(db, identity, request)
    binding, _ = checkpoint(db, actor, target_id, mutation=True)
    db.rollback()
    if kind == "mfa_reset" and actor.claims.assurance_level != "aal2":
        denied = Operation(actor, binding, kind)
        try:
            append_committed_security_event(
                denied.payload(SecurityEventOutcome.DENIED), org_id=session_organization(db)
            )
        except SecurityEventPersistenceError as error:
            raise denied.failure() from error
        raise refusal(
            403,
            "security_aal2_required",
            "Verify your own multi-factor sign-in before resetting MFA.",
        )
    if kind == "recovery" and not smtp_configured():
        raise refusal(
            503,
            "security_smtp_unconfigured",
            "Recovery email is not configured. Contact the operator.",
        )
    observed = provider_user(get_supabase_auth_client(), binding)
    if not observed.is_eligible():
        raise refusal(
            409, "security_target_ineligible", "This person is not eligible for this action."
        )
    checkpoint(db, actor, target_id, expected=binding, mutation=True)
    return Operation(actor, binding, kind)


def failed_operation(db: Session, operation: Operation) -> HTTPException:
    db.rollback()
    effected = (
        operation.email_request != "not_attempted" or operation.local_revocation != "not_requested"
    )
    try:
        append_committed_security_event(
            operation.payload(
                SecurityEventOutcome.PARTIAL if effected else SecurityEventOutcome.FAILURE
            ),
            org_id=session_organization(db),
        )
    except SecurityEventPersistenceError:
        pass  # The HTTP outcome remains unavailable even when recording also fails.
    return operation.failure()


def recover_person(
    db: Session, identity: CurrentIdentity, request: Request, target_id: UUID, revoke: bool
) -> UserRecoveryResponse:
    operation: Operation | None = None
    try:
        operation = admit_operation(db, identity, request, target_id, "recovery")
        if revoke:
            revoke_captured(db, operation, attempt=True)
            checkpoint(
                db,
                operation.actor,
                target_id,
                expected=operation.binding,
                mutation=True,
                self_continuation=operation.actor.user_id == target_id,
            )
            db.rollback()
        else:
            commit_event(db, operation, SecurityEventOutcome.ATTEMPT)
        operation.email_request = "unconfirmed"
        get_supabase_auth_client().request_recovery(operation.binding.email)
        operation.email_request = "accepted"
        checkpoint(
            db,
            operation.actor,
            target_id,
            expected=operation.binding,
            mutation=True,
            self_continuation=revoke and operation.actor.user_id == target_id,
        )
        commit_event(db, operation, SecurityEventOutcome.SUCCESS)
    except (SQLAlchemyError, SupabaseAuthUnavailable, HTTPException) as error:
        db.rollback()
        if operation is not None:
            raise failed_operation(db, operation) from error
        if isinstance(error, HTTPException):
            raise
        raise refusal(
            503, "user_security_unavailable", "Security is unavailable. Try again."
        ) from error
    return UserRecoveryResponse(
        operation_id=operation.id,
        user_id=target_id,
        local_revocation="committed" if revoke else "not_requested",
        revoked_sessions=operation.revoked_sessions if revoke else None,
    )


def revoke_captured(db: Session, operation: Operation, *, attempt: bool = False) -> None:
    # Required after an attempted factor effect even if the actor was revoked.
    # Keep the captured profile/provider binding; never sweep a rebound identity.
    lock_administrator_changes(db, exclusive=False)
    target = db.get(User, operation.binding.user_id, with_for_update=True, populate_existing=True)
    if (
        target is None
        or target.supabase_user_id is None
        or Binding(target.id, target.supabase_user_id, target.email) != operation.binding
    ):
        db.rollback()
        raise refusal(409, "security_binding_changed",
                      "This person's sign-in identity changed. Reload before continuing.")
    changed = revoke_user_sessions(db, target.id, except_session_id=None)
    advance_token_cutoff(target)
    operation.local_revocation = "unconfirmed"
    if attempt:
        commit_event(db, operation, SecurityEventOutcome.ATTEMPT)
    else:
        db.commit()
    operation.revoked_sessions += changed
    operation.local_revocation = "committed"


def reset_person_mfa(
    db: Session, identity: CurrentIdentity, request: Request, target_id: UUID
) -> UserMfaResetResponse:
    operation: Operation | None = None
    attempted = False
    cleanup = False
    interrupted: Exception | None = None
    client = get_supabase_auth_client()
    try:
        operation = admit_operation(db, identity, request, target_id, "mfa_reset")
        commit_event(db, operation, SecurityEventOutcome.ATTEMPT)
        factors = client.admin_list_factors(operation.binding.provider_id)
        if len(factors) > 32:
            raise SupabaseAuthUnavailable("Factor inventory exceeds the admitted bound")
        if not factors:
            checkpoint(db, operation.actor, target_id, expected=operation.binding, mutation=True)
            db.rollback()
            cleanup = True
        for factor_id in factors:
            checkpoint(db, operation.actor, target_id, expected=operation.binding, mutation=True)
            db.rollback()
            attempted = cleanup = True
            client.admin_delete_factor(operation.binding.provider_id, factor_id)
    except (SQLAlchemyError, SupabaseAuthUnavailable, HTTPException) as error:
        db.rollback()
        interrupted = error
    if operation is None:
        if isinstance(interrupted, HTTPException):
            raise interrupted
        raise refusal(
            503, "user_security_unavailable", "Security is unavailable. Try again."
        ) from interrupted
    try:
        if cleanup:
            revoke_captured(db, operation)
            started_at = observation_started_at()
            try:
                remaining = client.admin_list_factors(operation.binding.provider_id)
                operation.factors_cleared = not remaining
                # A session accepted while provider confirmation ran must also end.
                revoke_captured(db, operation)
            finally:
                commit_bound_observation(
                    db,
                    target_id,
                    operation.binding.provider_id,
                    False if operation.factors_cleared else None,
                    started_at,
                )
            if not operation.factors_cleared:
                raise SupabaseAuthUnavailable("Factor removal is incomplete")
        if interrupted is not None:
            raise interrupted
        checkpoint(
            db,
            operation.actor,
            target_id,
            expected=operation.binding,
            self_continuation=operation.actor.user_id == target_id and cleanup,
        )
        commit_event(db, operation, SecurityEventOutcome.SUCCESS)
    except (SQLAlchemyError, SupabaseAuthUnavailable, HTTPException) as error:
        if attempted and operation.local_revocation == "not_requested":
            operation.local_revocation = "unconfirmed"
        raise failed_operation(db, operation) from error
    return UserMfaResetResponse(
        operation_id=operation.id, user_id=target_id, revoked_sessions=operation.revoked_sessions
    )
