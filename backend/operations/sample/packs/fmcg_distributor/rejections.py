"""Distributor record and Access requests that must be refused (plan: Refusals)."""

from __future__ import annotations

from operations.sample.packs.fmcg_distributor.people import (
    CASHIER_KEY,
    CREDIT_ANALYST_KEY,
    DISABLED_KEY,
    DRIVER_KEY,
    GUEST_PRINCIPAL_KEY,
    PENDING_KEY,
    PRE_SELLER_KEY,
    PURCHASING_OFFICER_KEY,
    SUPERVISOR_KEY,
    VAN_SALESMAN_KEY,
)
from operations.sample.packs.types import RejectionCase

FORBIDDEN = "Forbidden"
HIDDEN = "Record not found"
BAD_CREDENTIALS = "Invalid authentication credentials"
INVALID_OPTION_KEY = "openslate:fmcg-distributor:invalid-select-option"
INVALID_FIELD_KEY = "openslate:fmcg-distributor:unknown-field"

ACTIVITY_CASES = (
    # Cash custody stays apart from receivables: the van salesman reads invoices only.
    RejectionCase(
        key="van_salesman_edits_invoice_amount",
        actor_key=VAN_SALESMAN_KEY,
        needs=("sales_invoices:000002",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="sales_invoices:000002",
    ),
    RejectionCase(
        key="pre_seller_approves_credit_review",
        actor_key=PRE_SELLER_KEY,
        needs=("credit_reviews:000001",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="credit_reviews:000001",
    ),
    RejectionCase(
        key="purchasing_officer_clears_price_variance",
        actor_key=PURCHASING_OFFICER_KEY,
        needs=("principal_invoices:000002",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="principal_invoices:000002",
    ),
    # A driver cannot read Credit and Collections, so opening the receipt is the refusal.
    RejectionCase(
        key="driver_opens_collection_receipt",
        actor_key=DRIVER_KEY,
        needs=("collection_receipts:000001",),
        expected_status=404,
        expected_detail=HIDDEN,
        operation="read-record",
        target_record_id="collection_receipts:000001",
    ),
    RejectionCase(
        key="principal_guest_edits_trade_promotion",
        actor_key=GUEST_PRINCIPAL_KEY,
        needs=("trade_promotions:000001",),
        expected_status=403,
        expected_detail=FORBIDDEN,
        operation="edit-record",
        target_record_id="trade_promotions:000001",
    ),
    RejectionCase(
        key="unversioned_receipt_edit",
        actor_key="admin",
        needs=("collection_receipts:000003",),
        expected_status=428,
        expected_detail="If-Match required",
        operation="unversioned-record-edit",
        target_record_id="collection_receipts:000003",
    ),
    RejectionCase(
        key="missing_required_field",
        actor_key=SUPERVISOR_KEY,
        needs=(),
        expected_status=422,
        expected_detail="required_field",
        template_record_id="outlets:000002",
        invalid_field_action="remove",
        field_key="name",
    ),
    RejectionCase(
        key="unknown_select_option",
        actor_key=SUPERVISOR_KEY,
        needs=(),
        expected_status=422,
        expected_detail="invalid_field_value",
        template_record_id="outlets:000002",
        invalid_field_action="invalid-option",
        field_key="status",
    ),
    RejectionCase(
        key="wrong_value_type",
        actor_key=CASHIER_KEY,
        needs=(),
        expected_status=422,
        expected_detail="invalid_field_value",
        template_record_id="collection_receipts:000002",
        invalid_field_action="set",
        field_key="amount",
        field_value="five thousand pesos",
    ),
    RejectionCase(
        key="unknown_field",
        actor_key=SUPERVISOR_KEY,
        needs=(),
        expected_status=422,
        expected_detail="unknown_field",
        template_record_id="outlets:000002",
        invalid_field_action="add-unknown-field",
        field_value="Route reserve",
    ),
    RejectionCase(
        key="duplicate_invoice_receipt",
        actor_key=CREDIT_ANALYST_KEY,
        needs=("sales_invoices:000001", "collection_receipts:000001"),
        expected_status=409,
        expected_detail="Relationship already exists",
        operation="create-relationship",
        relationship_key="invoice_receipts",
        source_record_id="sales_invoices:000001",
        target_record_id="collection_receipts:000001",
    ),
    RejectionCase(
        key="second_order_for_visit",
        actor_key=SUPERVISOR_KEY,
        needs=("sales_orders:000002", "store_visits:000001"),
        expected_status=409,
        expected_detail="Target already has a relationship source",
        operation="replace-relationship",
        relationship_key="order_visit",
        source_record_id="sales_orders:000002",
        target_record_id="store_visits:000001",
    ),
    RejectionCase(
        key="stale_group_edit",
        actor_key="admin",
        needs=(),
        expected_status=412,
        expected_detail="Resource changed",
        operation="stale-group-edit",
        group_key="sales-team",
        fallback_description="Sales",
    ),
)

CLOSING_CASES = (
    RejectionCase(
        key="stale_post_edit",
        actor_key="internal_sales_lead",
        needs=(),
        expected_status=409,
        expected_detail="stale_post_revision",
        operation="stale-post-edit",
        board_key="department:sales",
        post_key="department:sales:post:03",
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
