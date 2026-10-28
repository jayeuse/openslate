"""The sauce plant's planned record and Access requests that must be refused.

Each refusal crosses a separated duty (research §11): QA releases lots and sets
dispositions, accounts payable owns supplier invoices, the planner owns production orders,
and a guest auditor only reads.
"""

from __future__ import annotations

from operations.sample.packs.manufacturer.people import (
    AR_CLERK_KEY,
    BUYER_KEY,
    CS_REP_KEY,
    DISABLED_KEY,
    FILLER_OPERATOR_KEY,
    GUEST_AUDITOR_KEY,
    PENDING_KEY,
    SHIFT_SUPERVISOR_KEY,
)
from operations.sample.packs.types import RejectionCase

FORBIDDEN = "Forbidden"
HIDDEN = "Record not found"
BAD_CREDENTIALS = "Invalid authentication credentials"
INVALID_OPTION_KEY = "openslate:manufacturer:invalid-select-option"
INVALID_FIELD_KEY = "openslate:manufacturer:unknown-field"
_CS_DESK = "internal_sales_04"

ACTIVITY_CASES = (
    RejectionCase(
        key="filler_operator_releases_lot",
        actor_key=FILLER_OPERATOR_KEY,
        needs=("finished_goods_lots:000002",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="finished_goods_lots:000002",
    ),
    RejectionCase(
        key="shift_supervisor_sets_disposition",
        actor_key=SHIFT_SUPERVISOR_KEY,
        needs=("ncrs:000003",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="ncrs:000003",
    ),
    RejectionCase(
        key="buyer_edits_supplier_invoice",
        actor_key=BUYER_KEY,
        needs=("supplier_invoices:000002",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="supplier_invoices:000002",
    ),
    RejectionCase(
        key="cs_rep_moves_production_due_date",
        actor_key=CS_REP_KEY,
        needs=("production_orders:000002",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="production_orders:000002",
    ),
    RejectionCase(
        key="guest_auditor_edits_capa",
        actor_key=GUEST_AUDITOR_KEY,
        needs=("capas:000001",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="capas:000001",
    ),
    RejectionCase(
        key="guest_auditor_opens_customer_invoice",
        actor_key=GUEST_AUDITOR_KEY,
        needs=("customer_invoices:000002",),
        expected_status=404,
        expected_detail=HIDDEN,
        operation="read-record",
        target_record_id="customer_invoices:000002",
    ),
    RejectionCase(
        key="unversioned_lot_edit",
        actor_key="admin",
        needs=("material_lots:000003",),
        expected_status=428,
        expected_detail="If-Match required",
        operation="unversioned-record-edit",
        target_record_id="material_lots:000003",
    ),
    RejectionCase(
        key="missing_required_field",
        actor_key=_CS_DESK,
        needs=(),
        expected_status=422,
        expected_detail="required_field",
        template_record_id="customers:000002",
        invalid_field_action="remove",
        field_key="name",
    ),
    RejectionCase(
        key="unknown_select_option",
        actor_key=_CS_DESK,
        needs=(),
        expected_status=422,
        expected_detail="invalid_field_value",
        template_record_id="customers:000002",
        invalid_field_action="invalid-option",
        field_key="status",
    ),
    RejectionCase(
        key="wrong_value_type",
        actor_key=AR_CLERK_KEY,
        needs=(),
        expected_status=422,
        expected_detail="invalid_field_value",
        template_record_id="customer_payments:000002",
        invalid_field_action="set",
        field_key="amount",
        field_value="nine thousand dollars",
    ),
    RejectionCase(
        key="unknown_field",
        actor_key=_CS_DESK,
        needs=(),
        expected_status=422,
        expected_detail="unknown_field",
        template_record_id="customers:000002",
        invalid_field_action="add-unknown-field",
        field_value="Dock door 3",
    ),
    RejectionCase(
        key="duplicate_order_line",
        actor_key="internal_sales_02",
        needs=("sales_orders:000001", "sales_order_lines:000001"),
        expected_status=409,
        expected_detail="Relationship already exists",
        operation="create-relationship",
        relationship_key="order_lines",
        source_record_id="sales_orders:000001",
        target_record_id="sales_order_lines:000001",
    ),
    RejectionCase(
        key="second_work_order_for_breakdown",
        actor_key="internal_maintenance_02",
        needs=("maintenance_work_orders:000002", "downtime_events:000001"),
        expected_status=409,
        expected_detail="Target already has a relationship source",
        operation="replace-relationship",
        relationship_key="work_order_downtime",
        source_record_id="maintenance_work_orders:000002",
        target_record_id="downtime_events:000001",
    ),
    RejectionCase(
        key="stale_group_edit",
        actor_key="admin",
        needs=(),
        expected_status=412,
        expected_detail="Resource changed",
        operation="stale-group-edit",
        group_key="warehouse-team",
        fallback_description="Warehouse and Logistics",
    ),
)

CLOSING_CASES = (
    RejectionCase(
        key="stale_post_edit",
        actor_key="internal_manufacturing_lead",
        needs=(),
        expected_status=409,
        expected_detail="stale_post_revision",
        operation="stale-post-edit",
        board_key="department:manufacturing",
        post_key="department:manufacturing:post:03",
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
