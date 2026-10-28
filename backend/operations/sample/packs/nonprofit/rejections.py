"""The foundation's planned record and Access requests that must be refused (plan: Refusals)."""

from __future__ import annotations

from operations.sample.packs.nonprofit.people import (
    DISABLED_KEY,
    FACILITATOR_KEY,
    FUNDER_GUEST_KEY,
    GIFT_PROCESSOR_KEY,
    PENDING_KEY,
    PROCUREMENT_ASSISTANT_KEY,
    PROGRAM_MANAGER_KEY,
    PROJECT_OFFICER_KEY,
)
from operations.sample.packs.types import RejectionCase

FORBIDDEN = "Forbidden"
HIDDEN = "Record not found"
BAD_CREDENTIALS = "Invalid authentication credentials"
INVALID_OPTION_KEY = "openslate:nonprofit:invalid-select-option"
INVALID_FIELD_KEY = "openslate:nonprofit:unknown-field"
_DONOR_CLERK = "internal_resource_mobilization_02"

ACTIVITY_CASES = (
    RejectionCase(
        key="project_officer_edits_donation",
        actor_key=PROJECT_OFFICER_KEY,
        needs=("donations:000002",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="donations:000002",
    ),
    RejectionCase(
        key="facilitator_opens_feedback_case",
        actor_key=FACILITATOR_KEY,
        needs=("feedback_cases:000002",),
        expected_status=404,
        expected_detail=HIDDEN,
        operation="read-record",
        target_record_id="feedback_cases:000002",
    ),
    RejectionCase(
        key="procurement_assistant_opens_disbursement",
        actor_key=PROCUREMENT_ASSISTANT_KEY,
        needs=("disbursements:000001",),
        expected_status=404,
        expected_detail=HIDDEN,
        operation="read-record",
        target_record_id="disbursements:000001",
    ),
    RejectionCase(
        key="funder_guest_edits_indicator_result",
        actor_key=FUNDER_GUEST_KEY,
        needs=("indicator_results:000001",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="indicator_results:000001",
    ),
    RejectionCase(
        key="program_manager_edits_budget_line",
        actor_key=PROGRAM_MANAGER_KEY,
        needs=("budget_lines:000001",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="budget_lines:000001",
    ),
    RejectionCase(
        key="unversioned_donation_edit",
        actor_key="admin",
        needs=("donations:000003",),
        expected_status=428,
        expected_detail="If-Match required",
        operation="unversioned-record-edit",
        target_record_id="donations:000003",
    ),
    RejectionCase(
        key="missing_required_field",
        actor_key=_DONOR_CLERK,
        needs=(),
        expected_status=422,
        expected_detail="required_field",
        template_record_id="donors:000002",
        invalid_field_action="remove",
        field_key="name",
    ),
    RejectionCase(
        key="unknown_select_option",
        actor_key=_DONOR_CLERK,
        needs=(),
        expected_status=422,
        expected_detail="invalid_field_value",
        template_record_id="donors:000002",
        invalid_field_action="invalid-option",
        field_key="status",
    ),
    RejectionCase(
        key="wrong_value_type",
        actor_key=GIFT_PROCESSOR_KEY,
        needs=(),
        expected_status=422,
        expected_detail="invalid_field_value",
        template_record_id="donations:000002",
        invalid_field_action="set",
        field_key="amount",
        field_value="five thousand pesos",
    ),
    RejectionCase(
        key="unknown_field",
        actor_key=_DONOR_CLERK,
        needs=(),
        expected_status=422,
        expected_detail="unknown_field",
        template_record_id="donors:000002",
        invalid_field_action="add-unknown-field",
        field_value="Alumni chapter",
    ),
    RejectionCase(
        key="duplicate_indicator_project",
        actor_key="internal_meal_02",
        needs=("indicators:000001", "projects:000001"),
        expected_status=409,
        expected_detail="Relationship already exists",
        operation="create-relationship",
        relationship_key="indicator_project",
        source_record_id="indicators:000001",
        target_record_id="projects:000001",
    ),
    RejectionCase(
        key="second_fund_for_grant",
        actor_key="internal_finance_02",
        needs=("funds:000001", "funds:000002", "grant_awards:000003"),
        expected_status=409,
        expected_detail="Target already has a relationship source",
        operation="replace-relationship",
        relationship_key="fund_grant",
        source_record_id="funds:000002",
        target_record_id="grant_awards:000003",
    ),
    RejectionCase(
        key="stale_group_edit",
        actor_key="admin",
        needs=(),
        expected_status=412,
        expected_detail="Resource changed",
        operation="stale-group-edit",
        group_key="programs-team",
        fallback_description="Programs",
    ),
)

CLOSING_CASES = (
    RejectionCase(
        key="stale_post_edit",
        actor_key="internal_programs_lead",
        needs=(),
        expected_status=409,
        expected_detail="stale_post_revision",
        operation="stale-post-edit",
        board_key="department:programs",
        post_key="department:programs:post:03",
    ),
    RejectionCase(
        key="pending_account_sign_in",
        actor_key=PENDING_KEY,
        needs=(),
        expected_status=401,
        expected_detail=BAD_CREDENTIALS,
        operation="sign-in",
    ),
    RejectionCase(
        key="disabled_account_sign_in",
        actor_key=DISABLED_KEY,
        needs=(),
        expected_status=401,
        expected_detail=BAD_CREDENTIALS,
        operation="sign-in",
    ),
)
