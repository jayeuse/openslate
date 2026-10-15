from datetime import date, datetime

from operations.sample.packs import get_pack
from tests.operations.sample.sample_datasets import sample_dataset


def test_school_pack_exposes_the_approved_standard_record_budget() -> None:
    pack = get_pack("school")

    assert pack.identity.key == "school"
    assert len(pack.catalog.modules) == 24
    assert sum(pack.catalog.counts_by_profile["standard"].values()) == 6_183


def test_school_offline_dates_keep_finance_and_enrolment_events_ordered() -> None:
    dataset = sample_dataset(pack="school")
    records = {record.logical_id: record for record in dataset.records}
    design = dataset.document["design"]
    assert isinstance(design, dict)
    modules = design["modules"]
    assert isinstance(modules, list)
    fields = {field["id"]: field for module in modules for field in module["fields"]}

    def value(logical_id: str, field_key: str) -> str:
        module_key = logical_id.split(":", maxsplit=1)[0]
        field_id = dataset.field_ids[module_key][field_key]
        return str(records[logical_id].data[field_id])

    def status_label(logical_id: str) -> str:
        module_key = logical_id.split(":", maxsplit=1)[0]
        field_id = dataset.field_ids[module_key]["status"]
        config = fields[field_id]["config"]
        return next(
            option["label"]
            for option in config["options"]
            if option["id"] == records[logical_id].data[field_id]
        )

    def related_record_date(value_: str) -> date:
        return datetime.fromisoformat(value_).date()

    anchor = dataset.anchor_date
    past_due_ids = [
        record.logical_id
        for record in dataset.records
        if record.module_key == "fee_assessments" and status_label(record.logical_id) == "Past due"
    ]
    assert past_due_ids
    assert all(
        date.fromisoformat(value(logical_id, "next_due_date")) < anchor
        for logical_id in past_due_ids
    )
    assert all(
        date.fromisoformat(value(record.logical_id, "payment_date")) <= anchor
        for record in dataset.records
        if record.module_key == "payments"
    )

    for edge in dataset.edges:
        if edge.relationship_id != dataset.relationship_ids["inquiry_applications"]:
            continue
        inquiry_id = edge.source_record_id
        application_id = edge.target_record_id
        assert date.fromisoformat(value(inquiry_id, "inquiry_date")) <= date.fromisoformat(
            value(application_id, "submitted_on")
        )
    for record in dataset.records:
        if record.module_key != "applications":
            continue
        assert date.fromisoformat(value(record.logical_id, "submitted_on")) <= date.fromisoformat(
            value(record.logical_id, "entrance_test_on")
        )

    clinic_arrival = related_record_date(value("clinic_visits:000001", "time_in"))
    attendance_follow_up = date.fromisoformat(
        value("attendance_exceptions:000006", "activity_date")
    )
    assert clinic_arrival <= attendance_follow_up <= anchor
