"""The city government's planned record and Access requests that must be refused.

Each refusal crosses an office boundary of public finance (research §11): assessment,
collection, recording and custody are separate signatures.
"""

from __future__ import annotations

from operations.sample.packs.local_government.people import (
    ACCOUNTANT_KEY,
    COLLECTOR_KEY,
    COUNCIL_CLERK_KEY,
    DISABLED_KEY,
    DISBURSING_KEY,
    GUEST_AUDITOR_KEY,
    LICENSING_OFFICER_KEY,
    PENDING_KEY,
)
from operations.sample.packs.types import RejectionCase

FORBIDDEN = "Forbidden"
HIDDEN_MODULE = "Module not found"
HIDDEN = "Record not found"
BAD_CREDENTIALS = "Invalid authentication credentials"
INVALID_OPTION_KEY = "openslate:local-government:invalid-select-option"
INVALID_FIELD_KEY = "openslate:local-government:unknown-field"
_FRONT_DESK = "internal_bplo_03"

ACTIVITY_CASES = (
    RejectionCase(
        key="licensing_officer_creates_voucher",
        actor_key=LICENSING_OFFICER_KEY,
        needs=(),
        expected_status=404,
        expected_detail=HIDDEN_MODULE,
        template_record_id="disbursement_vouchers:000002",
    ),
    RejectionCase(
        key="collector_lowers_order_of_payment",
        actor_key=COLLECTOR_KEY,
        needs=("payment_orders:000002",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="payment_orders:000002",
    ),
    RejectionCase(
        key="accountant_releases_payment",
        actor_key=ACCOUNTANT_KEY,
        needs=("payment_releases:000002",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="payment_releases:000002",
    ),
    RejectionCase(
        key="council_clerk_opens_civil_registry",
        actor_key=COUNCIL_CLERK_KEY,
        needs=("civil_registry:000001",),
        expected_status=404,
        expected_detail=HIDDEN,
        operation="read-record",
        target_record_id="civil_registry:000001",
    ),
    RejectionCase(
        key="state_auditor_disallows_voucher",
        actor_key=GUEST_AUDITOR_KEY,
        needs=("disbursement_vouchers:000002",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="disbursement_vouchers:000002",
    ),
    RejectionCase(
        key="unversioned_receipt_edit",
        actor_key="admin",
        needs=("official_receipts:000003",),
        expected_status=428,
        expected_detail="If-Match required",
        operation="unversioned-record-edit",
        target_record_id="official_receipts:000003",
    ),
    RejectionCase(
        key="missing_required_field",
        actor_key=_FRONT_DESK,
        needs=(),
        expected_status=422,
        expected_detail="required_field",
        template_record_id="business_establishments:000002",
        invalid_field_action="remove",
        field_key="name",
    ),
    RejectionCase(
        key="unknown_select_option",
        actor_key=_FRONT_DESK,
        needs=(),
        expected_status=422,
        expected_detail="invalid_field_value",
        template_record_id="business_establishments:000002",
        invalid_field_action="invalid-option",
        field_key="status",
    ),
    RejectionCase(
        key="wrong_value_type",
        actor_key=COLLECTOR_KEY,
        needs=(),
        expected_status=422,
        expected_detail="invalid_field_value",
        template_record_id="official_receipts:000002",
        invalid_field_action="set",
        field_key="amount",
        field_value="eight thousand pesos",
    ),
    RejectionCase(
        key="unknown_field",
        actor_key=_FRONT_DESK,
        needs=(),
        expected_status=422,
        expected_detail="unknown_field",
        template_record_id="business_establishments:000002",
        invalid_field_action="add-unknown-field",
        field_value="Window 3 queue number",
    ),
    RejectionCase(
        key="duplicate_request_work_order",
        actor_key="internal_public_works_03",
        needs=("service_requests:000001", "work_orders:000001"),
        expected_status=409,
        expected_detail="Relationship already exists",
        operation="create-relationship",
        relationship_key="request_work_orders",
        source_record_id="service_requests:000001",
        target_record_id="work_orders:000001",
    ),
    RejectionCase(
        key="second_release_for_voucher",
        actor_key=DISBURSING_KEY,
        needs=("payment_releases:000002", "disbursement_vouchers:000001"),
        expected_status=409,
        expected_detail="Target already has a relationship source",
        operation="replace-relationship",
        relationship_key="release_voucher",
        source_record_id="payment_releases:000002",
        target_record_id="disbursement_vouchers:000001",
    ),
    RejectionCase(
        key="stale_group_edit",
        actor_key="admin",
        needs=(),
        expected_status=412,
        expected_detail="Resource changed",
        operation="stale-group-edit",
        group_key="public-works",
        fallback_description="Engineering and Public Works",
    ),
)

CLOSING_CASES = (
    RejectionCase(
        key="stale_post_edit",
        actor_key="internal_public_works_lead",
        needs=(),
        expected_status=409,
        expected_detail="stale_post_revision",
        operation="stale-post-edit",
        board_key="department:public_works",
        post_key="department:public_works:post:03",
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
