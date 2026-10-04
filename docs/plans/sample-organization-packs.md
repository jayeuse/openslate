# Sample organization packs: research-based design

Status: **Harbor and School pack data are implemented; other packs remain proposed.** School has offline admission checks; its live Small run and user check are pending. This document supplies the shared rules and the designs for pending packs in [ui-equivalent-sample-data-plan.md](ui-equivalent-sample-data-plan.md#proposed-run-sizes-and-organization-packs). Each implemented pack's data files in `backend/operations/sample/packs/<key>/` are its source of truth.

The research behind it is seven sourced reports, one per organization type, in [sample-organization-research/](sample-organization-research/): `field-service.md`, `fmcg-distributor.md`, `manufacturer.md`, `school.md`, `clinic.md`, `nonprofit.md` and `local-government.md`. Each report gives the full field lists, Select options, status paths, relationship reasons, volume ratios, status mixes, vocabulary, Board content and numbered sources. Figures that a report marks as judgment are not sourced. This document keeps only the decisions; a report is removed when its pack data files replace it.

## Rules for every pack

1. **The record budget counts operational records only.** A Standard run has 5,000 to 7,000 records. Relationship edges, trigger runs, history updates, Board items and OpenView items are counted separately, as the Harbor plan output already does (`operational_records` and `record_relationship_edges`).
2. **Each pack has a maximum of 24 modules.** The research proposes 26 to 30 modules for each organization. The cap keeps the run time near the Harbor Small and Standard runs. It still shows each end-to-end chain. The deferred modules are listed for each pack below.
3. **Each pack declares its simulated span and its sampling scope.** The spans differ: one grading period for a school, one quarter for a clinic, one year for a nonprofit. Front-line records are a sample; master data and back-office records are closer to full volume. The manifest records the span and the scope, because dashboard totals show a scaled sample, not the size of a real organization. Correct ratios between modules matter more than absolute totals.
4. **Dates follow the span and the season; timestamps do not.** Record date fields (invoice date, visit date, due date) use the anchor date, the span and the pack's seasonality. `created_at` stays the real run time.
5. **Automations are set-field rules on the same module.** The engine facts below explain why. When the research proposes an automation that creates a follow-up record, the pack converts it into two parts:
   - A set-field rule that flags the source record, for example `Collection stage = 61–90 final notice`.
   - A planned human step: the responsible person creates the follow-up record in a later work session.

   This also reads more naturally in the audit log, because a named person creates each record.
6. **Counters change in history steps, not every day.** The research uses fields such as Days pending, Days past due and Expiry band that a real system updates daily. The simulation sets such a field in one or two history steps, to a value that crosses the rule's threshold. The threshold rule then fires once, as it would after many daily updates.
7. **Separation of duties uses module boundaries.** Each approval or certification lives in the module of the office that owns it. Planned refusals are always across a module or department boundary. Relationship writers need write access to the source module and read access to the target module. If the record creator lacks that access, an eligible colleague links the records in a separate short session. The plan, journal and audit checks name that writer. Inside one module, the data shows separation with `Requested by` and `Approved by` fields; the API does not refuse a same-person approval there (see product gaps).
8. **Sensitive records get their own module.** Safeguarding cases, guidance notes, clinic visits and civil registry entries are in modules that the wide groups cannot read. A guest sees every row of a module it can read, so guests get read access only to modules that are safe to show in full.
9. **Each pack has one named scenario** in which a child record settles part of a parent amount. Board links and verification read it from the pack.
10. **Each pack adds its own trade phrases to the marker check.** The check blocks the words `sample`, `test`, `demo`, `dummy`, `fake`, `placeholder`, `lorem`, `ipsum`, `scenario` and `synthetic` in generated content. Real work in these fields uses "test" and "sample", so each pack lists the exact phrases it allows, and the check still blocks the words everywhere else.

    Correct: `Unit test 2 — Year 8 Science, Set 2` in the school pack. Wrong: `Test record 12 for class 8`.

11. **A link to a record in another department is a relationship.** A relationship can connect modules in two departments. When a record names a record that the organization keeps in another department, the pack models a relationship, not a typed code. The record that names the other record is the source. It links itself after both records exist. The person who links needs write access to the source module and read access to the target module, so the pack gives that read access to the groups that write the source module. Keep a typed code only when it repeats a relationship that the department already has. The relationship lists in the research reports are input; each pack checks every relationship against its department mapping and its access groups.

    Correct: a Fee Assessment has a Student relationship to the student record in the Academic Office. Wrong: a Fee Assessment has a Student number text field that repeats the code of that student record.

## Engine facts that shape the packs

These facts come from the source code, not from the research reports. Several reports assumed otherwise.

| Fact | Source |
| --- | --- |
| Trigger events: record created, field changed, threshold crossed, and schedule (daily, or weekly on one weekday) | `backend/app/systems/sandbox/designs/schemas.py` (`TriggerEvent`, `ScheduleTrigger`) |
| Condition operators `= != > >= < <=`; a group is `all` or `any`, with up to 20 conditions | `schemas.py` (`TriggerCondition`, `ConditionGroup`) |
| A condition or action value can be a literal or **another field on the same record**, so "Qty on hand < Reorder point" is possible | `schemas.py` (`TriggerValue`, `FieldReferenceValue`) |
| A trigger can have up to 20 actions | `schemas.py` (`TriggerDocument.actions`) |
| Only **Set field** actions publish. Create record, notification, channel message and assign task are refused at publication. | `backend/app/systems/sandbox/publications/rules.py` (`trigger_action_unsupported`); `record_triggers/models.py` check constraint `kind = 'set-field'` |
| Conditions and Set field targets must use the trigger's own module | `rules.py` (`trigger_cross_module_reference`) |
| No value means "today", so no rule can compare a date with the current date | `schemas.py` (`TriggerValue` has only `literal` and `field-reference`) |
| Access is per department or module (read, write, manage); a guest is capped at read | `backend/app/systems/access/policy/scope.py` |
| Changing a relationship needs source-module write and target-module read | `backend/app/systems/sandbox/relationships/access.py` (`require_link_change`) |

## Pack summaries

The counts below are the proposed Standard counts. The Small profile is about one fifth. The totals were checked with a script.

### School (`school`)

- **Organization:** a private K–12 day school, 834 students in 39 homerooms, 110 staff.
- **Span:** one grading period, about 10 teaching weeks, plus enrolment before it and the report-card week after it.
- **Scope decisions:**
  - Attendance holds exceptions only: absences and late arrivals. Real schools record it this way ("negative attendance"; Ed-Fi, DepEd SF2).
  - Per-student scores are not records. Assessments, grade posting, report-card batches, alerts and grade changes are records.
- **Departments (7):** Admissions; Academic Office (registrar and academics); Student Affairs; Health Services; Finance (Bursar); Facilities; Human Resources.
- **Modules (24, 6,183 records):**

  | Module | Records | Module | Records | Module | Records |
  | --- | --- | --- | --- | --- | --- |
  | Admission Inquiry | 220 | Academic Alert | 150 | Fee Item | 26 |
  | Application | 80 | Grade Change Request | 18 | Fee Assessment | 834 |
  | Student | 834 | Behavior Incident | 90 | Payment | 1,027 |
  | Attendance Exception | 1,026 | Guidance Case | 65 | Fee Adjustment | 140 |
  | Course | 50 | Parent Contact Log | 240 | Collection Case | 70 |
  | Class Section | 178 | Clinic Visit | 290 | Room | 70 |
  | Assessment | 356 | Health Alert | 100 | Maintenance Request | 130 |
  | Report Card Batch | 39 | Activity | 40 | Staff Leave | 110 |

- **Deferred:** Enrollment Change, Library Case, Room Booking, Purchase Request.
- **Chains:**
  1. Inquiry, application, student.
  2. Fee assessment, payment, collection case.
  3. Assessment, alert, report card.
  4. Incident, parent contact, guidance.
  5. Request, repair.
- **Named scenario:** a Fee Assessment that a Payment settles in part.
- **Key relationships:** Student and Class Section many-to-many is the class roster, about 5,800 edges. Do not link Fee Item to Fee Assessment for each fee line; that relationship alone adds about 5,000 edges. Keep the fee lines as text.
- **Refusals:**
  - A teacher opens a Fee Assessment and gets 404.
  - A teacher opens a Clinic Visit and gets 404.
  - The cashier approves a Fee Adjustment and gets 403.
  - The bursar records a Payment and gets 403.
  - A guest auditor edits a Payment and gets 403.
- **Trade phrases:** unit test, end-of-term test, test paper, entrance test, sample essay.
- **Department mapping (rule 11):** the roster (Student and Class Section) must be in one department. Put Student, Course, Class Section, Assessment, Report Card Batch, Academic Alert, Grade Change Request and Attendance Exception in one Academic Office department (registrar and academics together), and keep Admissions separate. Fee Assessment, Clinic Visit, Behavior Incident and Guidance Case link to the student record through a Student relationship.
- **UK vocabulary:** year groups (Reception, Year 1 to Year 13), form groups and teaching sets, three terms with half-terms, DfE attendance codes, £ amounts, UK spelling (enrolment, behaviour). The research report also gives Philippine and US terms; do not mix them in.

### Clinic (`clinic`)

- **Organization:** a multi-specialty outpatient clinic with 12 physicians and 3 nurse practitioners or physician assistants, about 70 staff, a lab and a dispensary.
- **Span:** one quarter, including flu season.
- **Scope decision:** clinical records are about a 3% sample of real traffic, about 8 encounters a working day. Operational records (lab QC, temperature logs, maintenance) are full volume.
- **Statuses:** use FHIR R4 status values. Claims use workflow states on top of FHIR, with X12 claim adjustment reason codes for denials.
- **Clinical content:** short chief complaints and dispositions only. No treatment instructions.
- **Departments (7):** Patient Access; Clinical Services; Laboratory; Pharmacy; Revenue Cycle; Operations and Supply; Quality and Compliance.
- **Modules (24, 6,072 records):**

  | Module | Records | Module | Records | Module | Records |
  | --- | --- | --- | --- | --- | --- |
  | Patient | 462 | Specimen | 200 | Claim | 375 |
  | Coverage | 360 | Lab Result | 247 | Claim Response | 360 |
  | Payer | 12 | Lab QC Run | 192 | Supplier | 24 |
  | Appointment | 620 | Dispense | 289 | Purchase Request | 70 |
  | Payment | 552 | Pharmacy Item | 140 | Purchase Order | 52 |
  | Encounter | 536 | Stock Lot | 210 | Equipment | 65 |
  | Order | 295 | Temperature Log | 256 | Maintenance Work Order | 85 |
  | Prescription | 482 | Incident Report | 28 | Staff Credential | 160 |

- **Deferred:** Referral, Goods Receipt (tracked as a Purchase Order status), Infection Control Audit.
- **Chains:**
  1. Appointment, encounter.
  2. Order, specimen, result.
  3. Prescription, dispense.
  4. Encounter, claim, response, payment.
  5. Fridge excursion, incident.
- **Named scenario:** a Claim that a payer Payment settles in part.
- **Refusals:**
  - Front desk opens a Lab Result and gets 404.
  - A claims specialist edits an Encounter and gets 403.
  - A nurse finalizes a Lab Result and gets 403.
  - A storekeeper opens a Patient and gets 404.
  - A guest surveyor edits a Staff Credential and gets 403.
- **Trade phrases:** rapid test, lab test, QC run, proficiency testing, specimen, sample collection, test result.

### Nonprofit (`nonprofit`)

- **Organization:** a community development foundation with 55 staff and about 180 volunteers. It runs three programs: livelihood, education support, and disaster response.
- **Span:** 12 months, including a year-end appeal and a typhoon response.
- **Scope decision:** beneficiaries who receive direct services are records. The wider reach is only in indicator totals, as humanitarian data protection guidance advises.
- **Departments (8):** Resource Mobilization; Grants and Partnerships; Programs; MEAL; Finance; Procurement and Logistics; Volunteer Engagement; Executive Office.
- **Modules (24, 5,859 records):**

  | Module | Records | Module | Records | Module | Records |
  | --- | --- | --- | --- | --- | --- |
  | Donor | 640 | Project | 8 | Fund | 18 |
  | Campaign | 12 | Site | 16 | Cash Advance | 110 |
  | Donation | 1,500 | Activity | 300 | Expense Line | 400 |
  | Pledge | 60 | Beneficiary | 900 | Disbursement | 190 |
  | Organization | 80 | Assistance Delivered | 700 | Supplier | 45 |
  | Grant | 20 | Indicator | 56 | Purchase Request | 100 |
  | Budget Line | 140 | Indicator Result | 200 | Purchase Order | 70 |
  | Grant Report | 44 | Feedback Case | 70 | Volunteer | 180 |

  Assistance Delivered joins the research's Service Records and Distributions into one module.
- **Deferred:** Enrollments (replaced by a many-to-many relationship between Beneficiary and Project), Quotations (a count field on the Purchase Request), Volunteer Shifts, Volunteer Hours, Board Meetings.
- **Chains:**
  1. Donor, gift, acknowledgement.
  2. Proposal, award, report, closeout.
  3. Registration, assistance, exit.
  4. Activity, indicator result.
  5. Cash advance, liquidation.
- **Named scenario:** a Pledge that Donations settle in part. A second case uses the same pattern: a Cash Advance that Expense Lines liquidate in part.
- **Refusals:**
  - A project officer edits a Donation amount and gets 403.
  - A community facilitator opens a Feedback Case and gets 404, because safeguarding cases are restricted.
  - The procurement assistant releases a Disbursement and gets 404.
  - A funder guest edits an Indicator Result and gets 403.
  - A program manager changes a Budget Line amount and gets 403.
- **Trade phrases:** pre-assessment, post-assessment, pilot test, sample survey, test run of the early warning system.

### Local government (`local-government`)

- **Organization:** a city government for about 100,000 people, with about 250 staff in the offices covered here.
- **Span:** one calendar year, with the January permit renewal peak and the rainy-season drainage peak.
- **Scope decision:** civil registry entries hold no personal names.
- **Departments (7):** Business Permits and Licensing; Building Official; Engineering and Public Works; Treasury; Budget and Accounting; Procurement and General Services; City Clerk, Records and Council.
- **Modules (24, 5,767 records):**

  | Module | Records | Module | Records | Module | Records |
  | --- | --- | --- | --- | --- | --- |
  | Business Establishment | 300 | Order of Payment | 520 | Purchase Request | 110 |
  | Business Permit Application | 360 | Official Receipt | 500 | Procurement Project | 80 |
  | Business Inspection | 110 | Collection Deposit Report | 240 | Bid | 190 |
  | Enforcement Notice | 30 | Payment Release | 250 | Purchase Order | 72 |
  | Building Permit Application | 110 | Appropriation | 110 | Inspection and Acceptance Report | 75 |
  | Building Inspection | 220 | Obligation Request | 280 | Communication | 450 |
  | Service Request | 900 | Disbursement Voucher | 265 | Legislative Measure | 70 |
  | Work Order | 300 | Supplier | 55 | Civil Registry Entry | 170 |

- **Deferred:** Occupancy Certificate (a Building Permit status), Council Session, Property and Fleet Asset, Plantilla Position, Personnel Action, Leave Application.
- **Chains:**
  1. Application, assessment, payment, permit.
  2. Request, work order, fix.
  3. Purchase request, bidding, award, delivery, payment.
  4. Obligation, voucher, payment release.
  5. Ordinance through three readings.
- **Named scenario:** an Order of Payment that Official Receipts settle in part (quarterly business tax installments).
- **Refusals:**
  - A licensing officer creates a Disbursement Voucher and gets 403.
  - A collector lowers an Order of Payment and gets 403.
  - The accountant releases a Payment Release and gets 403.
  - A council clerk opens a Civil Registry Entry and gets 404.
  - A guest state auditor disallows a voucher and gets 403.

### FMCG distributor (`fmcg-distributor`)

- **Organization:** a regional distributor for 12 principals with about 1,100 SKUs, about 120 staff, and about 4,200 outlets. The research report calls it "Harborline Trading". That name conflicts with Harbor and must change.
- **Span:** one quarter.
- **Scope decision:** front-line records (visits, orders, invoices) are a 1:50 sample. Back-office records are a 1:2 to 1:6 sample.
- **Departments (7):** Sales; Key Accounts and Trade Marketing; Purchasing and Principal Relations; Warehouse and Inventory; Logistics; Credit and Collections; Accounting and Claims.
- **Modules (24, 5,895 records):**

  | Module | Records | Module | Records | Module | Records |
  | --- | --- | --- | --- | --- | --- |
  | Outlet | 440 | Principal | 12 | Return | 90 |
  | Beat | 18 | Product | 300 | Delivery Trip | 17 |
  | Store Visit | 840 | Purchase Order | 55 | Vehicle | 16 |
  | Sales Order | 340 | PO Line | 330 | Sales Invoice | 555 |
  | Sales Order Line | 1,560 | Goods Receipt | 62 | Collection Receipt | 455 |
  | Route Tour | 12 | Stock Lot | 300 | Credit Review | 30 |
  | Trade Promotion | 60 | Stock Count | 180 | Collection Follow-up | 70 |
  | Stock Adjustment | 45 | Principal Invoice | 60 | Principal Claim | 48 |

- **Deferred:** Display Agreement, and Return Line (a reason code on the Return).
- **Chains:**
  1. Pre-sell order to cash.
  2. Van sales tour to settlement.
  3. Procure to pay with principals.
  4. Trade promotion to claim.
  5. Bad order to principal recovery.
- **Named scenario:** a Sales Invoice that Collection Receipts settle in part.
- **Refusals:**
  - A van salesman edits an invoice amount and gets 403.
  - A pre-seller approves a Credit Review and gets 403.
  - A purchasing officer clears a price variance on a Principal Invoice and gets 403.
  - A driver edits a Collection Receipt and gets 404.
  - A principal guest edits a Trade Promotion and gets 403.

### Manufacturer (`manufacturer`)

- **Organization:** a plant with 165 staff that makes shelf-stable sauces and condiments. Its lines are four kettles, three fillers and one dry-blend line. Most products are acidified foods, which have a legal pH limit.
- **Span:** 6 weeks at full plant volume, including one month-end.
- **Scope decision:** pH, Brix and viscosity are fields on the Batch Record, not separate records.
- **Departments (7):** Sales and Customer Service; Planning and Purchasing; Warehouse and Logistics; Production; Quality and Food Safety; Maintenance; Finance.
- **Modules (24, 5,885 records):**

  | Module | Records | Module | Records | Module | Records |
  | --- | --- | --- | --- | --- | --- |
  | Customer | 60 | Supplier | 40 | Downtime Event | 346 |
  | Sales Order | 300 | Purchase Order | 180 | Finished Goods Lot | 265 |
  | Sales Order Line | 1,300 | Material Lot | 240 | Food Safety Log | 640 |
  | Product | 45 | Shipment | 310 | Nonconformance Report | 35 |
  | Material | 120 | Work Center | 8 | CAPA | 7 |
  | Bill of Materials | 45 | Production Order | 190 | Equipment | 70 |
  | Batch Record | 480 | Maintenance Work Order | 236 | Customer Invoice | 310 |
  | Shift Production Report | 233 | Supplier Invoice | 165 | Customer Payment | 260 |

- **Customer Payment:** the research has no payment module. This pack adds Customer Payment so that the named scenario has a child record.
- **Deferred:**
  - BOM Lines: the formula is a long-text field on the Bill of Materials.
  - Incoming Inspection: its result is a Material Lot status.
  - Customer Complaint: it becomes an NCR source.
  - Also deferred: Supplier Approval, Controlled Document, Cycle Count, Production Cost Variance.
- **Chains:**
  1. Order to cash.
  2. Plan to produce, with positive release.
  3. Procure to pay.
  4. NCR to CAPA.
  5. Breakdown to maintenance.
- **Named scenario:** a Customer Invoice that Customer Payments settle in part.
- **Refusals:**
  - A filler operator releases a Finished Goods Lot and gets 403.
  - A shift supervisor sets an NCR disposition and gets 403.
  - A buyer edits a Supplier Invoice and gets 403.
  - A customer service rep moves a Production Order due date and gets 403.
  - A guest auditor edits a CAPA and gets 403.
- **Trade phrases:** metal detector test, pH retest, test kitchen, retain sample, sample size, trial run.

### Harbor (`harbor`) and the field-service research

Harbor is extracted into the pack interface **unchanged**, and the saved golden master proves this. The field-service research confirms the Harbor model: sales, service contracts, requests, work orders, maintenance plans, parts, purchasing and finance. It proposes these additions:

- Service Appointments: return visits, where the first-time fix rate is about 75–87%.
- Refrigerant Log Entries.
- Warranty Claims.
- Installation Projects with Change Orders.
- Collection Activity.
- Supplier Bills.

These are a later Harbor revision with a new golden master. They are not part of the extraction.

## Automation conversions

For each pack, about half of the automations in the research publish as they are. These are rules that set a field on the same record. Examples:

- Priority = High when a request type is drainage.
- Status = Pending approval when a total is 500,000 or more.
- Status = QA hold when the pH rises above 4.40.
- Overspend alert = true when the burn rate is 90% or more.

The other half create a follow-up record. Rule 5 converts each of those into a flag and a planned human step. Examples:

| Research rule | Pack rule | Planned human step |
| --- | --- | --- |
| Invoice 60 days past due creates a collection activity | Collection stage = Final notice | The collections officer logs a Collection Case |
| Encounter finished creates a draft claim | Billing status = Ready to claim | A claims specialist creates the Claim |
| Grant awarded creates a restricted fund | Fund setup = Pending | The grants accountant creates the Fund |
| Rejected incoming lot creates an NCR | Lot status = Rejected, NCR required = true | A QA technician opens the NCR |

A weekly schedule rule can set a field on all matching records, for example "flag open work orders older than a set value" through a stored counter. A schedule rule cannot create a record.

## Countries

Decided with the user on 2026-09-30. Each pack sets its locale and time zone through the workspace API.

| Pack | Country | Reason | Alternatives |
| --- | --- | --- | --- |
| harbor | Philippines (current) | Golden master; no change | — |
| school | United Kingdom (England) | The DfE attendance codes and termly fees are well sourced | Philippines (DepEd), United States |
| clinic | United States | FHIR, CARC denial codes and E/M visit codes are well sourced | Philippines (PhilHealth and HMO) |
| nonprofit | Philippines | Typhoon season, DSWD accreditation and research sources | Kenya (needs new research on seasons and receipts) |
| local-government | Philippines | Primary law texts read: RA 11032, RA 12009, the Local Government Code | United States (state rules vary) |
| fmcg-distributor | Philippines | Sari-sari channel, bad orders, invoice rule RR 7-2024 | India (GST e-way bills), Kenya |
| manufacturer | United States | FDA acidified-food and preventive-control rules | United Kingdom or EU (BRCGS, Article 18 traceability) |

## Product gaps found by the research

| Gap | Effect on the packs | Where it shows |
| --- | --- | --- |
| Create record, notification and assign task actions do not publish | Follow-up records come from planned human steps | All packs |
| No "today" value in trigger conditions | Due-date and aging rules need a stored counter | All packs |
| No status-transition permission inside a module | A writer can approve their own request; the data shows this only in fields | All packs; six of seven reports |
| No record-level or field-level access | A guest sees every row of a readable module; a sensitive field needs its own module | Clinic, nonprofit, school, FMCG |
| No formula field | Balances, variances and percentages are stored values that people or the simulation set | All packs |
| The six Sandbox organization templates are all business types | School, clinic, nonprofit and government have no template | Sandbox |

## Order of work

Decided with the user on 2026-09-30. All six new packs are built, one at a time; each gets a live Small run, a check in the app and a guarded reset before the next pack starts.

1. School.
2. Harden the shared engine and add admin/reorganization phases for Harbor and School. The plan chooses actors and targets from each pack's phase data. It preserves the 24-module operational distribution and adds one empty module for the close/reopen flow. Only a newly planned project Board is purged. Offline checks and independent review precede live acceptance for both packs.
3. Clinic, after Harbor and School pass those phases live.
4. Nonprofit.
5. Local government.
6. FMCG distributor.
7. Manufacturer.
8. The Harbor field-service revision, with a new golden master.
