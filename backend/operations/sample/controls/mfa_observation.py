"""Private synchronous observation at the owned MFA lifecycle boundaries."""

from collections.abc import Callable, Mapping, Sequence
from types import MappingProxyType
from typing import Any, Literal, cast

from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import SamplePhaseActionError

type MfaObservationStage = Literal["before_reset", "after_revocation"]
type MfaObserver = Callable[[MfaObservationStage, Mapping[str, object]], object]
type MfaObservation = Callable[[MfaObservationStage, Sequence[str], Sequence[str]], None]


def configure_mfa_observer(
    private_values: Mapping[str, Any], action: PhaseAction, identities: Mapping[str, str]
) -> MfaObservation:
    callback = private_values.get("mfa_observer")
    if "mfa_observer" in private_values and not callable(callback):
        raise SamplePhaseActionError(
            "Configured MFA acceptance observer is unavailable", step="mfa_observer_setup"
        )
    observer = cast(MfaObserver | None, callback)
    owned = {
        "action_key": action.key,
        "owner_id": identities["admin"],
        "actor_id": identities[action.actor_key],
        "target_id": identities[action.target_key],
    }

    def observe(
        stage: MfaObservationStage, actor_sessions: Sequence[str], target_sessions: Sequence[str]
    ) -> None:
        if observer is None:
            return  # Ordinary offline runs do not claim provider observation.
        payload = MappingProxyType(
            {
                **owned,
                "actor_session_ids": tuple(actor_sessions),
                "target_session_ids": tuple(target_sessions),
            }
        )
        try:
            observer(stage, payload)
            return
        except Exception:
            pass
        # Raise outside the handler so no private exception remains in the chain.
        raise SamplePhaseActionError(
            "MFA acceptance observer did not confirm its boundary", step=f"mfa_observer:{stage}"
        ) from None

    return observe
