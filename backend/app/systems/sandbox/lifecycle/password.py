"""Provider password verification used only for lifecycle step-up checks."""

from typing import Protocol
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity import rate_limits
from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.workspace.security_policy import load_workspace_policy
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleInvalidCredentials,
    LifecyclePasswordRateLimited,
    LifecyclePasswordServiceUnavailable,
)


class PasswordGrantClient(Protocol):
    def verify_password(self, email: str, password: str) -> UUID:
        """Verify credentials and return the local identity."""


class ProviderPasswordGrantClient:
    """Verify a provider password without admitting its temporary session."""

    def __init__(
        self,
        db: Session,
        *,
        client: SupabaseAuthClient | None = None,
        enforce_rate_limit: bool = True,
    ) -> None:
        self._db = db
        self._client = client or get_supabase_auth_client()
        self._enforce_rate_limit = enforce_rate_limit

    def verify_password(self, email: str, password: str) -> UUID:
        timestamp = utc_now()
        fingerprint = None
        bucket = None
        policy = None

        def record_failure() -> None:
            if fingerprint is not None:
                rate_limits.record_attempt(
                    self._db,
                    fingerprint,
                    bucket,
                    timestamp,
                    policy=policy,
                    login=True,
                    identifier=email,
                )
                self._db.commit()

        try:
            if self._enforce_rate_limit:
                policy = load_workspace_policy(self._db)
                rate_limits.cleanup_expired_buckets(now_value=timestamp)
                fingerprint = rate_limits.login_fingerprint(email, None)
                bucket = rate_limits.lock_bucket(self._db, fingerprint)
                if (
                    rate_limits.login_retry_after(
                        self._db, bucket, timestamp, policy, identifier=email
                    )
                    is not None
                ):
                    raise LifecyclePasswordRateLimited("Password verification is rate limited")
            tokens = self._client.password_grant(email, password)
        except InvalidProviderCredentials as error:
            record_failure()
            raise LifecycleInvalidCredentials("The supplied password is invalid") from error
        except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
            self._db.rollback()
            raise LifecyclePasswordServiceUnavailable("Password service unavailable") from error
        try:
            provider_user = self._client.get_user(tokens.access_token)
            if (
                provider_user.id != tokens.user_id
                or provider_user.email != email
                or not provider_user.is_eligible()
            ):
                raise LifecycleInvalidCredentials("The supplied password is invalid")
            local = self._db.scalar(select(User).where(User.supabase_user_id == provider_user.id))
            if (
                local is None
                or local.email != email
                or local.status != UserStatus.ACTIVE.value
                or not is_identity_eligible(local)
                or not is_established_user(local)
            ):
                raise LifecycleInvalidCredentials("The supplied password is invalid")
            if bucket is not None:
                self._db.delete(bucket)
            if self._enforce_rate_limit:
                rate_limits.clear_login_account_budget(self._db, email)
            self._db.commit()
            return local.id
        except InvalidProviderCredentials as error:
            record_failure()
            raise LifecycleInvalidCredentials("The supplied password is invalid") from error
        except LifecycleInvalidCredentials:
            record_failure()
            raise
        except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
            raise LifecyclePasswordServiceUnavailable("Password service unavailable") from error
        finally:
            try:
                self._client.sign_out(tokens.access_token, scope="local")
            except (InvalidProviderCredentials, SupabaseAuthUnavailable):
                pass


__all__ = ["PasswordGrantClient", "ProviderPasswordGrantClient"]
