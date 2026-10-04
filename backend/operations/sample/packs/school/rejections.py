"""School's planned record and Access requests that must be refused."""

from __future__ import annotations

from operations.sample.packs.types import RejectionCase

FORBIDDEN = "Forbidden"
HIDDEN = "Record not found"
BAD_CREDENTIALS = "Invalid authentication credentials"
INVALID_OPTION_KEY = "openslate:school:invalid-select-option"
INVALID_FIELD_KEY = "openslate:school:unknown-field"

ACTIVITY_CASES = (
    RejectionCase(
        key="teacher_opens_fee_assessment",
        actor_key="internal_academic_03",
        needs=("fee_assessments:000001",),
        expected_status=404,
        expected_detail=HIDDEN,
        operation="read-record",
        target_record_id="fee_assessments:000001",
    ),
    RejectionCase(
        key="teacher_opens_clinic_visit",
        actor_key="internal_academic_03",
        needs=("clinic_visits:000001",),
        expected_status=404,
        expected_detail=HIDDEN,
        operation="read-record",
        target_record_id="clinic_visits:000001",
    ),
    RejectionCase(
        key="cashier_approves_fee_adjustment",
        actor_key="internal_finance_03",
        needs=("fee_adjustments:000002",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="fee_adjustments:000002",
    ),
    RejectionCase(
        key="bursar_records_payment",
        actor_key="internal_finance_04",
        needs=(),
        expected_status=403,
        expected_detail=FORBIDDEN,
        template_record_id="payments:000002",
    ),
    RejectionCase(
        key="guest_auditor_edits_payment",
        actor_key="guest_auditor",
        needs=("payments:000003",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="payments:000003",
    ),
    RejectionCase(
        key="unversioned_payment_edit",
        actor_key="admin",
        needs=("payments:000003",),
        expected_status=428,
        expected_detail="If-Match required",
        operation="unversioned-record-edit",
        target_record_id="payments:000003",
    ),
    RejectionCase(
        key="missing_required_field",
        actor_key="internal_admissions_02",
        needs=(),
        expected_status=422,
        expected_detail="required_field",
        template_record_id="admission_inquiries:000002",
        invalid_field_action="remove",
        field_key="name",
    ),
    RejectionCase(
        key="unknown_select_option",
        actor_key="internal_admissions_02",
        needs=(),
        expected_status=422,
        expected_detail="invalid_field_value",
        template_record_id="admission_inquiries:000002",
        invalid_field_action="invalid-option",
        field_key="status",
    ),
    RejectionCase(
        key="wrong_value_type",
        actor_key="internal_finance_03",
        needs=(),
        expected_status=422,
        expected_detail="invalid_field_value",
        template_record_id="payments:000002",
        invalid_field_action="set",
        field_key="amount",
        field_value="seventeen pounds",
    ),
    RejectionCase(
        key="unknown_field",
        actor_key="internal_admissions_02",
        needs=(),
        expected_status=422,
        expected_detail="unknown_field",
        template_record_id="admission_inquiries:000002",
        invalid_field_action="add-unknown-field",
        field_value="Admissions reserve",
    ),
    RejectionCase(
        key="duplicate_student_class_section",
        actor_key="internal_academic_02",
        needs=("students:000001", "class_sections:000001"),
        expected_status=409,
        expected_detail="Relationship already exists",
        operation="create-relationship",
        relationship_key="student_roster",
        source_record_id="students:000001",
        target_record_id="class_sections:000001",
    ),
    RejectionCase(
        key="second_class_section_report_card_batch",
        actor_key="internal_academic_02",
        needs=("class_sections:000002", "report_card_batches:000001"),
        expected_status=409,
        expected_detail="Target already has a relationship source",
        operation="replace-relationship",
        relationship_key="section_report_cards",
        source_record_id="class_sections:000002",
        target_record_id="report_card_batches:000001",
    ),
    RejectionCase(
        key="stale_group_edit",
        actor_key="admin",
        needs=(),
        expected_status=412,
        expected_detail="Resource changed",
        operation="stale-group-edit",
        group_key="academic-office",
        fallback_description="Academic Office",
    ),
)

CLOSING_CASES = (
    RejectionCase(
        key="stale_post_edit",
        actor_key="internal_academic_lead",
        needs=(),
        expected_status=409,
        expected_detail="stale_post_revision",
        operation="stale-post-edit",
        board_key="department:academic",
        post_key="department:academic:post:03",
    ),
    RejectionCase(
        key="pending_account_sign_in",
        actor_key="internal_pending_01",
        needs=(),
        expected_status=401,
        expected_detail=BAD_CREDENTIALS,
        operation="sign-in",
    ),
    RejectionCase(
        key="disabled_account_sign_in",
        actor_key="internal_disabled_01",
        needs=(),
        expected_status=401,
        expected_detail=BAD_CREDENTIALS,
        operation="sign-in",
    ),
)
