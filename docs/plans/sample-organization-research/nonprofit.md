# Nonprofit pack: Fairhaven Community Development Foundation (FCDF)

## 1. Reference organization profile

**Size.** These figures are my judgment for a mid-size community development NGO. No single source gives them.

| Item | Value |
|---|---|
| Staff | 55 (about 20 field-based) |
| Registered volunteers | about 180 (60–90 active in any quarter) |
| Annual budget | USD 3–4M equivalent: about 65% institutional grants, 15% corporate, 20% individual gifts |
| Active grants | 8–10 (2–3 more in the pipeline) |
| Individual donors | about 640 who gave in the last 24 months; about 45 monthly givers |
| Programs / projects | 3 programs (Livelihood, Education Support, Disaster Response and DRR), 8 projects |
| Sites | 16 communities in 2 provinces or districts, plus 1 warehouse |
| People reached per year | about 4,000 households. About 700 are registered individually in the system; the rest are counted as totals in indicator results. |

**How it runs.** Institutional funders pay for projects through grants. Each grant carries a logframe, a budget broken into lines, and set reporting dates. Finance keeps each grant as a separate restricted fund and charges every expense to a budget line. Individual and corporate gifts come in through campaigns. Most are unrestricted, but emergency appeals are restricted.

Field officers register participants with offline mobile forms (KoBoToolbox is the sector default [32]), deliver trainings, services and distributions, and pay field costs from cash advances. They liquidate each advance with receipts. MEAL (monitoring, evaluation, accountability and learning) checks the data and rolls it up into indicator results for donor reports. The board meets quarterly.

**Regional differences.**

- **US.** The donor needs a written acknowledgement for any single gift of $250 or more. A quid-pro-quo gift over $75 needs a disclosure [15].
- **Canada.** An official receipt must carry a serial number, the charity's registration number and the eligible amount [16].
- **UK.** With a Gift Aid declaration, the charity reclaims 25p per £1 [17].
- **Philippines.** Donee-institution status used to require PCNC accreditation first [18]. Executive Order 117 (7 May 2026) made DSWD the only accrediting body for social welfare and development agencies [19].
- **US government funding.** USAID stopped implementing foreign assistance on 1 July 2025, and the State Department took over its active awards [27]. Use generic "bilateral donor" names. 2 CFR 200 rules still apply to US federal awards [21–25].

## 2. Departments

| Department | Purpose | Lead | Staff |
|---|---|---|---|
| Resource Mobilization | Individual and corporate giving, campaigns, acknowledgements | Head of Resource Mobilization | Donor Relations Officer, Individual Giving Officer, Gift Processing Associate, Corporate Partnerships Officer |
| Grants & Partnerships | Proposals, awards, budgets, donor reports, partner due diligence | Grants Manager | Proposal Development Officer, Grants Compliance Officer, Partnerships Officer |
| Programs | Projects, activities, participants, services, distributions | Program Director | Program Managers (Livelihood, Education, Emergency), Project Officers, Community Facilitators, Case Worker |
| MEAL | Indicators, results, data quality, complaints and feedback | MEAL Manager | M&E Officer, Information Management Officer, Accountability Officer |
| Finance & Administration | Fund accounting, advances, payments, audit | Finance Manager | Grants Accountant, Disbursement Officer, Cashier, Admin Officer |
| Procurement & Logistics | Buying, supplier quotes, POs, warehouse | Procurement & Logistics Lead | Procurement Assistant, Warehouse Assistant |
| Volunteer Engagement | Volunteer recruitment, shifts, hours | Volunteer Coordinator | Volunteer Engagement Associate |
| Executive Office | Board, governance, policy | Executive Director | Executive Assistant / Board Secretary |

## 3. Core processes

1. **Prospect to gift to acknowledgement.** The Donor Relations Officer creates the Donor (Prospect) and attaches them to a Campaign. The Gift Processing Associate records the Donation as Pending, then Received, then Posted after the bank deposit reconciles. The associate then sends the acknowledgement: status goes from To Be Acknowledged to Acknowledged (NPSP pattern [10]). A pledge is a parent record, and each payment is a child Donation until the balance reaches zero [8][12]. Records produced: Donor, Donation, Pledge, receipt number.
2. **Proposal to award to report to closeout.** The Proposal Development Officer moves the Grant through Identified, Concept note, Proposal submitted and Under donor review. On award, the Grants Manager sets Awarded – contracting and the Grants Accountant opens the Fund and the Budget Lines. The Grants Compliance Officer schedules the Grant Reports. Funders can require financial reports no more often than quarterly and no less than annually [25]. Final reports are due within 120 days after the period of performance ends, or 90 days for subrecipients [24]. Stage then moves through Closing to Closed. The steps follow IATI activity status (pipeline, implementation, finalisation, closed) [1].
3. **Registration to service to exit.** A Community Facilitator pre-registers the household on a KoBo form. The Information Management Officer imports and de-duplicates it. The Project Officer verifies eligibility, and the participant is Enrolled. Service Records or Distributions follow, and post-distribution monitoring (PDM) verifies a sample. The participant then Exits. Collect only the fields the program needs [30][31].
4. **Activity to indicator result.** The Facilitator completes the Activity and records participant counts by sex. The M&E Officer drafts the quarterly Indicator Result. The MEAL Manager verifies it, and the Grants Manager marks it Reported. The structure follows IATI result → indicator → baseline, target and actual per period [3] and the logframe hierarchy [6].
5. **Request to purchase to payment.** A Project Officer raises a Purchase Request. The Grants Accountant checks the budget, and the Program Manager approves. The Procurement Assistant collects quotes, and a committee evaluates them. The lead issues the PO and the Warehouse Assistant receives the goods. The Disbursement Officer prepares payment, the Finance Manager approves it, and the Cashier releases it. Under 2 CFR 200 since 1 Oct 2025: no quotes are needed up to $15,000, informal quotes are needed up to $350,000, and formal methods apply above that [22][23]. Written procedures and conflict-of-interest standards are required [21]. The EU grant example requires 3 quotes from €60k and open tender from €100k/€300k, depending on type [26].
6. **Cash advance to liquidation.** A Field Officer requests an advance for a training. The Program Manager approves it, the Disbursement Officer releases it, and the officer spends it. The officer then submits Expense Lines with receipts. The Grants Accountant checks them, disallows any without support, and collects the refund or reimburses. The advance closes, and no new advance is released while one is still open. The 30-day and no-new-advance rules come from a Philippine public-sector analog [38]; NGO manuals commonly mirror them (my judgment).

## 4. Modules (30)

Field types: T Text, LT Long text, N Number, I Integer, D Date, DT Date/Time, CB Checkbox, S Select, E Email, U URL, P User. An asterisk (*) marks a required field. Status lists run in lifecycle order; exception states follow the semicolon.

**Resource Mobilization**

1. **Donors.** Name* T; Donor ID* T; Email E; Phone T; Donor type* S (Individual, Household, Staff/Board, Anonymous); Monthly giving S (None, Active, Paused, Lapsed, Closed [11]); Contact preference S (Email, Post, SMS, No solicitation); Relationship manager P; First gift date D; Notes LT. Status* S: Prospect → First-time → Active → Lapsed → Reactivated; Do Not Contact, Deceased.
2. **Campaigns.** Name* T; Code* T; Type* S (Year-end appeal, Emergency appeal, Monthly giving drive, Event, Corporate partnership, Peer-to-peer, Major gifts); Start* D; End D; Goal N; Raised to date N; Owner P. Status* S: Planned → Active → Closed; Cancelled.
3. **Donations.** Gift ID* T; Gift date* D; Amount* N; Payment method* S (Card, Bank transfer, Mobile wallet, Check, Cash, Online platform, Payroll giving [7]); Gift type* S (One-time, Recurring installment, Pledge payment, In-kind, Matching gift [9]); Restriction* S (Unrestricted, Restricted – project, Restricted – emergency appeal, Restricted – time [20]); Formal receipt required CB; Receipt no. T; Acknowledgement* S (To Be Acknowledged → Acknowledged; Email Acknowledgment Not Sent, Do Not Acknowledge [10]); Acknowledged on D. Status* S: Pending → Received → Posted; Failed, Refunded, Cancelled [7].
4. **Pledges.** Pledge ID* T; Pledge date* D; Total amount* N; Installments* I; Frequency* S (Monthly, Quarterly, Semiannual, Annual); First due* D; Amount paid N; Balance due N; Solicitor P. Status* S: Pending → In Progress → Completed; Overdue, Cancelled, Written Off [8][12].

**Grants & Partnerships**

5. **Organizations.** Name* T; Org type* S (Foundation, Corporate, Bilateral/multilateral donor, Government agency, Local implementing partner, Community association); Role* S (Funder, Corporate partner, Implementing partner, Coordination [4]); Contact T; Contact email E; Website U; Due diligence S (Not started, In review, Cleared, Expired, Rejected); MOU end D; Owner P. Status S: Prospect → Active → Inactive.
6. **Grants.** Grant code* T; Title* T; Amount requested N; Amount awarded N; Start D; End D; Next report due D; Indirect rate % N; Cost-share required CB; Grant manager* P; Special conditions LT. Stage* S: Identified → Concept note submitted → Proposal submitted → Under donor review → Awarded – contracting → Active → Closing → Closed; Declined, Withdrawn, Suspended, Terminated [1][14].
7. **Budget Lines.** Line code* T; Description* T; Cost category* S (Personnel, Fringe, Travel, Equipment, Supplies, Contractual, Other direct, Indirect); Approved* N; Actual to date N; Committed N; Burn rate % N; Overspend alert CB. Status S: Open → Closed; Frozen.
8. **Grant Reports.** Title* T; Type* S (Interim narrative, Interim financial, Annual work plan, Final narrative, Final financial, Audit report, Inventory disposition); Period end D; Due* D; Submitted on D; Preparer P; Reviewer P. Status* S: Not started → In preparation → Internal review → Submitted → Accepted; Revision requested, Overdue.

**Programs**

9. **Projects.** Code* T; Name* T; Program area* S (Livelihood, Education support, Disaster response, DRR/Preparedness); Start D; End D; Target beneficiaries I; Budget N; Manager* P; Summary LT. Status* S: Pipeline → Implementation → Finalisation → Closed; Suspended, Cancelled [1].
10. **Sites.** Name* T; Site code* T; Province/State T; Municipality/District T; Site type S (Community, School, Evacuation center, Market, Warehouse); Hazard S (Storm surge, Riverine flood, Landslide, Coastal flood, Low); Est. households I; Access notes LT. Status S: Assessed → Active → Inactive.
11. **Activities.** Code* T; Title* T; Type* S (Training, Community meeting, Distribution, Tutoring session, Assessment, Monitoring visit, Coordination meeting, Drill); Planned date* D; Actual date D; Facilitator P; Female participants I; Male participants I; Notes LT. Status* S: Planned → Scheduled → Ongoing → Completed; Postponed, Cancelled.
12. **Beneficiaries.** Beneficiary ID* T; Full name* T; Sex* S (Female, Male, Prefer not to say); Date of birth D; Household size I; Head of household CB; Vulnerability S (Female-headed HH, Person with disability, Older person, Pregnant/lactating, None recorded); Contact no. T; Consent recorded* CB; Registered by P; Registered on* D. Status* S: Pre-registered → Verified → Active → Exited; Pending consent, Ineligible, Duplicate, Consent withdrawn [30][31].
13. **Enrollments.** Enrollment ID* T; Enrolled on* D; Cohort T; Exit date D; Exit reason S (Graduated, Moved away, Found employment, Lost contact, Declined support); Case officer P. Status* S: Applied → Enrolled → Active → Completed; Dropped out, Transferred, Deferred.
14. **Service Records.** Service type* S (Skills certificate, Starter kit, Seed capital grant, School supplies pack, Tuition subsidy, Tutoring package, Referral, Psychosocial session); Date* D; Quantity I; Value N; Delivered by P; Remarks LT. Status* S: Scheduled → Delivered → Verified; Not delivered, Reversed.
15. **Distributions.** Distribution ID* T; Round* I; Item* S (list in §9); Quantity* I; Unit value N; Date D; Received by proxy CB; Distributed by P. Status* S: Planned → Validated → Distributed → Verified; No-show, Disputed, Cancelled.

**MEAL**

16. **Indicators.** Code* T; Statement* LT; Level* S (Impact, Outcome, Output [3][6]); Unit* S (Number, Percentage, Average); Baseline N; LOP target* N; Frequency S (Monthly, Quarterly, Semiannual, Annual, Endline); Disaggregation S (Sex, Sex & age, None); Means of verification LT; Owner P. Status S: Draft → Approved → Active; Retired.
17. **Indicator Results.** Period* T; Period end* D; Actual* N; Female N; Male N; Period target N; % of target N; Off track CB; Data source S (Attendance sheets, Distribution lists, KoBo survey, Partner report, School records); Verified by P. Status* S: Draft → Submitted → Verified → Reported; Returned for correction.
18. **Feedback Cases.** Case no.* T; Received on* D; Channel* S (Hotline, SMS, Help desk, Suggestion box, Community meeting, Face-to-face); Category* S (Information request, Assistance request, Exclusion complaint, Quality/quantity complaint, Staff/volunteer conduct, Safeguarding/PSEA, Fraud or diversion, Appreciation); Sensitivity* S (Standard, Sensitive, Restricted – safeguarding); Priority S (Low, Medium, High, Critical); Description LT; Assigned to P; Response LT. Status* S: Received → Acknowledged → Under review → Resolved → Closed; Escalated [28].

**Finance & Administration**

19. **Funds.** Fund code* T; Name* T; Restriction class* S (Without donor restrictions, With donor restrictions – purpose, With donor restrictions – time, Perpetual [20]); Source S (Grant, Appeal, Corporate); Budget N; Spent N; Available N; Expiry D. Status* S: Open → Active → Fully spent → Closed; Frozen.
20. **Cash Advances.** Advance no.* T; Purpose* LT; Custodian* P; Amount released* N; Amount liquidated N; Unliquidated balance N; Released on D; Liquidation due* D; Approved by P. Status* S: Requested → Approved → Released → Partially liquidated → Fully liquidated → Closed; Rejected, Overdue, Refund due.
21. **Expense Lines.** Date* D; Payee T; Description* T; Amount* N; Category* S (list in §9); Receipt type S (Official receipt, Invoice, Acknowledgement receipt, Certified no-receipt); Checked by P. Status* S: Submitted → Checked → Approved → Posted; Returned, Disallowed.
22. **Disbursements.** Voucher no.* T; Payee* T; Amount* N; Type* S (Supplier payment, Advance release, Reimbursement, Partner tranche, Payroll, Donor refund); Method S (Bank transfer, Check, Cash, Mobile money); Date D; Prepared by P; Approved by P. Status* S: Draft → For approval → Approved → Released → Cleared; On hold, Voided.

**Procurement & Logistics**

23. **Suppliers.** Name* T; Category* S (Food & NFI, Construction materials, Printing, Trucking, Catering & venue, IT equipment, Consultants); Tax ID T; Email E; Phone T; Exclusion check S (Not checked, Clear, Flagged); Last evaluated D. Status* S: Prospective → Accredited → Active; Suspended, Excluded.
24. **Purchase Requests.** PR no.* T; Description* LT; Requested by* P; Estimated cost* N; Needed by D; Method S (Micro-purchase, RFQ – 3 quotes, Competitive negotiated, Open tender, Single source – justified [22][26]); Approved by P; Justification LT. Status* S: Draft → Submitted → Budget checked → Approved → Sourcing → PO issued → Completed; Returned, Rejected, Cancelled.
25. **Quotations.** Quote ref* T; Amount* N; Delivery days I; Valid until D; Meets specs CB; Rank I. Status* S: Requested → Received → Evaluated → Selected / Not selected; Non-responsive.
26. **Purchase Orders.** PO no.* T; Amount* N; Issued on D; Delivery due D; Delivery site T; Received by P; Receiving notes LT. Status* S: Draft → Issued → Partially received → Received → Invoiced → Paid → Closed; Cancelled.

**Volunteer Engagement**

27. **Volunteers.** Name* T; Email E; Phone T; Skill S (First aid, Tutoring, Repacking, Data encoding, Driving, Photography, Counseling); Background check S (Not required, Pending, Cleared, Expired); Code of conduct signed* CB; Joined D; Coordinator P. Status* S: Applied → Screening → Active → Inactive; Declined, Offboarded.
28. **Volunteer Shifts.** Title* T; Starts* DT; Ends DT; Role S (Repacking, Crowd control, Tutor, Registration encoder, Event staff); Slots I; Filled I; Lead P. Status* S: Open → Full → Completed; Cancelled.
29. **Volunteer Hours.** Date* D; Hours* N; Task T; Approved by P. Status* S: Submitted → Approved; Rejected.

**Executive Office**

30. **Board Meetings.** Title* T; Type* S (Regular board, Special board, Annual members' meeting, Finance & Audit Committee, Program Committee, Governance Committee); Scheduled* DT; Quorum met CB; Agenda LT; Resolutions LT; Minutes S (Draft → Circulated → Approved); Secretary P. Status* S: Scheduled → Held → Minutes approved; Postponed, Cancelled.

## 5. Relationships

| Link | Cardinality | Reason |
|---|---|---|
| Donors → Donations | 1–N | A gift history belongs to one donor |
| Donors → Pledges | 1–N | A donor can make more than one pledge |
| **Pledges → Donations** | 1–N | **Named scenario:** payments settle part of the pledge |
| Campaigns → Donations | 1–N | Primary campaign source [9] |
| Campaigns → Pledges | 1–N | Pledges are made against an appeal |
| Organizations → Donations | 1–N | Corporate gifts |
| Funds → Donations | 1–N | Restricted gifts go to a fund |
| Organizations → Grants | 1–N | The funder of the award |
| **Grants → Funds** | 1–1 | Each award is one restricted fund |
| Grants → Budget Lines | 1–N | The approved budget |
| Grants → Grant Reports | 1–N | Reporting schedule |
| Grants ↔ Projects | N–N | Co-funded projects, multi-project grants |
| Organizations ↔ Projects | N–N | Implementing partners [4] |
| Projects ↔ Sites | N–N | Projects work in several communities |
| Projects → Activities | 1–N | Work plan |
| Sites → Activities | 1–N | Where the activity happens |
| Sites → Beneficiaries | 1–N | Residence |
| Beneficiaries → Enrollments | 1–N | A person can join more than one project |
| Projects → Enrollments | 1–N | Project caseload |
| Enrollments → Service Records | 1–N | Services delivered per participation |
| Beneficiaries → Distributions | 1–N | Entitlement per round |
| Activities → Distributions | 1–N | The distribution event |
| Projects → Indicators | 1–N | Logframe |
| Indicators → Indicator Results | 1–N | Periodic actuals [3] |
| Projects → Feedback Cases | 1–N | Accountability per project |
| Budget Lines → Expense Lines | 1–N | Cost coding |
| **Cash Advances → Expense Lines** | 1–N | Second partial-settlement case (liquidation) |
| **Cash Advances → Disbursements** | 1–1 | One release voucher per advance |
| Budget Lines → Purchase Requests | 1–N | Charge line |
| Purchase Requests → Quotations | 1–N | Competition evidence |
| Suppliers → Quotations | 1–N | Bids |
| Purchase Requests → Purchase Orders | 1–N | Lots |
| Suppliers → Purchase Orders | 1–N | Vendor |
| Purchase Orders → Disbursements | 1–N | Partial or final payment |
| Volunteers → Volunteer Hours | 1–N | Timesheet |
| Volunteer Shifts → Volunteer Hours | 1–N | Hours per shift |
| Activities → Volunteer Shifts | 1–N | Volunteers supporting an event |

## 6. Automations

I assume that "set field" acts on the triggering record and "create record" can target any module.

1. **Donations.** Record created → set Acknowledgement = To Be Acknowledged [10].
2. **Donations.** Threshold crossed: Amount ≥ 250 → set Formal receipt required = true (US $250 rule [15]; set the local threshold per country).
3. **Pledges.** Threshold crossed: Balance due ≤ 0 → set Status = Completed [8].
4. **Grants.** Field changed: Stage. If Stage = Awarded – contracting → create a Funds record (Restriction class = With donor restrictions – purpose, Status = Open).
5. **Budget Lines.** Threshold crossed: Burn rate % ≥ 90 → set Overspend alert = true.
6. **Purchase Requests.** Threshold crossed: Estimated cost > 15,000 → set Method = RFQ – 3 quotes [22].
7. **Purchase Requests.** Threshold crossed: Estimated cost > 350,000 → set Method = Open tender [22].
8. **Cash Advances.** Threshold crossed: Unliquidated balance ≤ 0 → set Status = Fully liquidated.
9. **Beneficiaries.** Record created. If Consent recorded = false → set Status = Pending consent [30].
10. **Feedback Cases.** Record created. If Category = Safeguarding/PSEA → set Sensitivity = Restricted – safeguarding and Priority = Critical [28].
11. **Distributions.** Field changed: Status. If Status = Disputed → create a Feedback Cases record (Category = Quality/quantity complaint, Channel = Help desk).
12. **Schedule, weekly, Friday 15:00** → create a Disbursements record "Weekly payment run" with Status = Draft.

**Model gap.** Conditions compare fields only to fixed values. So OpenSlate cannot express date-relative rules such as "liquidation more than 30 days late" or "report due in 14 days". In the simulation, staff set Overdue by hand, and saved views sort by due date.

## 7. Volumes: 12 months (Oct 2025 – Sep 2026), 6,007 records

| Dept | Module: count |
|---|---|
| Resource Mobilization (1,802) | Donors 640, Campaigns 12, Donations 1,100, Pledges 50 |
| Grants & Partnerships (284) | Organizations 80, Grants 20, Budget Lines 140, Grant Reports 44 |
| Programs (1,964) | Projects 8, Sites 16, Activities 200, Beneficiaries 700, Enrollments 480, Service Records 300, Distributions 260 |
| MEAL (326) | Indicators 56, Indicator Results 200, Feedback Cases 70 |
| Finance (618) | Funds 18, Cash Advances 110, Expense Lines 300, Disbursements 190 |
| Procurement (395) | Suppliers 45, Purchase Requests 100, Quotations 180, Purchase Orders 70 |
| Volunteers (610) | Volunteers 180, Shifts 90, Hours 340 |
| Executive Office (8) | Board Meetings 8 (4 regular, 3 committee, 1 AGM) |

**How the ratios work:**

- **Donations.** About 45 monthly givers × about 9 payments ≈ 400. Pledge payments ≈ 150. About 550 one-time gifts. This gives about 1.7 gifts per donor.
- **Donor churn.** FEP 2025 reports overall retention at 43.3% and donor counts down 3.6% while dollars rose 5% [34]. So about 55% of Donor records should show a Lapsed or First-time pattern.
- **Grants.** About 7 budget lines per grant (about 14 for each active grant) and 2–5 reports per grant.
- **Beneficiaries.** 280 livelihood participants, 220 students and 200 emergency households, each with a record. Wider reach appears only as indicator totals, following IFRC advice to report aggregates to donors [30].
- **Indicators.** About 7 per project × 4 quarters, minus the ones collected annually.
- **Finance and procurement.** About 2.7 expense lines per advance. About 1.8 quotes per PR, because micro-purchases have none. About 0.7 POs per PR.

## 8. Status distribution on 30 Sep 2026

The percentages are my judgment, sized to process timing. For example, a 30-day liquidation cycle leaves about 10–15% of advances open at any date.

| Module | Snapshot | Records that change status later |
|---|---|---|
| Donations | Posted 88%, Received 5%, Pending 3%, Failed 2%, Refunded 1%, Cancelled 1%. Acknowledgement: Acknowledged 85%, To Be 8%, Not Sent 3%, Do Not 4% | 15% |
| Pledges | Completed 40%, In Progress 36%, Overdue 10%, Pending 8%, Cancelled 4%, Written Off 2% | 80% (balance updates) |
| Grants | Active 8, Closing 2, Closed 2, Under review 2, Proposal 1, Concept 1, Identified 1, Declined 2, Withdrawn 1 | 70% |
| Grant Reports | Accepted 60%, Submitted 14%, In prep 9%, Not started 9%, Revision 5%, Overdue 3% | 85% |
| Activities | Completed 70%, Scheduled 12%, Planned 8%, Postponed 6%, Cancelled 4% | 60% |
| Beneficiaries | Active 62%, Exited 15%, Verified 10%, Pre-reg 5%, Ineligible 3%, Pending consent 2%, Duplicate 2%, Withdrawn 1% | 45% |
| Enrollments | Active 45%, Completed 30%, Dropped out 10%, Enrolled 8%, Applied 5%, Transferred 2% | 50% |
| Distributions | Verified 55%, Distributed 30%, Validated 5%, No-show 6%, Disputed 2%, Cancelled 2% | 40% |
| Indicator Results | Reported 60%, Verified 20%, Submitted 10%, Draft 7%, Returned 3% | 75% |
| Feedback Cases | Closed 65%, Resolved 12%, Under review 10%, Acknowledged 6%, Received 4%, Escalated 3% (safeguarding is 3–5% of cases) | 90% |
| Cash Advances | Closed 60%, Fully liquidated 12%, Released 10%, Partial 8%, Overdue 5%, Refund due 3%, Rejected 2% | 95% |
| Expense Lines | Posted 75%, Approved 10%, Checked 5%, Submitted 5%, Returned 3%, Disallowed 2% | 40% |
| Disbursements | Cleared 80%, Released 8%, Approved 4%, For approval 4%, On hold 2%, Voided 2% | 50% |
| Purchase Requests | Completed 70%, PO issued 8%, Sourcing 7%, Approved 4%, Submitted 4%, Cancelled 4%, Rejected 3% | 85% |
| Purchase Orders | Closed 60%, Paid 15%, Received 10%, Issued 8%, Partial 4%, Cancelled 3% | 80% |
| Volunteers / Hours | Active 55%, Inactive 30%, other 15% / Approved 88%, Submitted 9%, Rejected 3% | 25% / 30% |

Reference records (Donors, Sites, Suppliers, Organizations) change status rarely, about 10%. The weighted mean is close to the plan's 40% of records updated.

## 9. Content vocabulary (all names invented)

**Campaigns.** Light a Classroom Year-End Appeal 2025; Typhoon Aldren Emergency Appeal; Back-to-School Kits Drive 2026; Kasama Monthly Givers Circle; Sewing Futures Livelihood Appeal; Harvest Dinner 2026; Run for Resilience 5K; Coastal Schools Rebuild Fund; Holiday Food Pack Match; Scholars' Circle Major Gifts; Employee Payroll Giving – Solace Bank; Birthday Fundraiser Pages; Rainy Season Readiness Appeal; Lent Giving Week.

**Funders / grant codes.** NGF-2025-031 (Northgate Foundation); MRF-ER-26-004 (Meridian Relief Fund); CRT-LIV-2025-12 (Coastal Resilience Trust); SBCF-EDU-26 (Solace Bank Corporate Foundation); BDA-PH-DRR-0917 (bilateral donor); HWF-26-118 (Hollow Wood Family Fund); ECF-2026-07; LGU-MOA-2026-03.

**Project codes.** FCDF-LIV-24-02 Women's Micro-enterprise Recovery; FCDF-EDU-25-01 Learning Recovery Tutoring; FCDF-EDU-25-03 Scholarship Support; FCDF-ER-26-01 Typhoon Aldren Response; FCDF-DRR-25-02 Community Early Warning; FCDF-LIV-25-04 Fisherfolk Gear Replacement; FCDF-WASH-26-01 School Handwashing Stations; FCDF-ER-25-02 Flood Response Brgy Cluster B.

**Activities.** Basic bookkeeping training – Batch 3; Community validation of beneficiary list; Food pack distribution – Round 2; Saturday reading tutoring; Rapid needs assessment – Site 07; Post-distribution monitoring visit; Barangay DRR planning workshop; Evacuation drill with Grade 5; Seed capital orientation; Parent-teacher consultation; Cash-for-work payroll validation; Complaints desk briefing.

**Indicator wording.**

- # of households receiving multipurpose cash, by sex of household head
- % of trained women operating a business 6 months after training
- % of supported learners promoted to the next grade
- Average monthly household income of livelihood participants
- # of hygiene kits distributed
- % of households reporting kit contents met their needs (PDM)
- % of complaints closed within 30 days
- # of communities with a functional early warning committee
- # of volunteers trained in first aid
- % of scholars with ≥85% attendance
- # of learners reached by tutoring, by sex and grade

Use Sphere where relevant, for example the minimum of 15 L water per person per day [29].

**Distribution items.** Food pack (5 kg rice, 6 canned fish, 6 noodles); Hygiene kit (soap, toothpaste, sanitary pads, 20 L jerrycan); Shelter repair kit (10 roofing sheets, 4×6 m tarpaulin, nails, tie wire); Sleeping kit; Kitchen set; Water filter; Solar lamp; Multipurpose cash – tranche 1; School kit; Seeds and tools pack; Fishing gear pack; Dignity kit.

**Donation channels.** Online donation page; Bank transfer; Mobile wallet; Monthly card debit; Check; Cash at event; Payroll giving; Corporate matching; Peer-to-peer page; Crowdfunding page; Major gift meeting; In-kind drop-off.

**Expense categories.** Participant meals and snacks; Venue rental; Fuel and boat hire; Training materials; Facilitator honoraria; Mobile load; Printing; Accommodation; Per diem; Trucking and hauling; Warehouse rental; Bank charges; Audit fees; Office supplies.

**Staff note phrasing:**

- "Donor asked for receipt by email, not post."
- "Liquidation short by 1,250; cashier to collect refund Friday."
- "Hardware store OR is handwritten; asked supplier for a proper official receipt."
- "Three quotes attached. Lowest cannot deliver before the 15th; recommending second."
- "HH not home during validation; revisit Thursday."
- "Name spelled differently on ID; kept ID spelling."
- "Proxy claimed for elderly mother; authorization letter on file."
- "Moved from Round 2 to Round 3 list, was in evacuation center."
- "Funder asked for disaggregation by age for Q2."
- "Budget line 2.3 near ceiling, flag for realignment request."
- "Board approved FY27 budget subject to audit adjustments."

**Caution for the pack.** Livelihood and education staff write "pre-test/post-test" for training assessments. This phrase collides with the plan's marker check. Add it as a pack trade phrase, or use "pre-assessment/post-assessment".

## 10. Board content per quarter (example: Q3, Jul–Sep, typhoon peak)

- **Programs.** Announcements: pre-positioning of 800 food packs complete; Round 2 distribution schedule; school year opening support. Events: distribution days per site, tutoring start, livelihood graduation.
- **Resource Mobilization.** Announcements: Typhoon Aldren appeal launched; appeal totals update; year-end appeal copy review. Events: corporate partner site visit, donor thank-you calls week.
- **Grants.** Announcements: interim financial report submitted; new award signed; realignment approved. Events: report due dates, donor monitoring visit, proposal deadline.
- **Finance.** Announcements: advances outstanding over 30 days list; month-end cut-off; audit engagement letter signed. Events: month-end close, weekly payment run, cash count.
- **Procurement.** Announcements: RFQ for shelter kits open; supplier accreditation renewal. Events: bid opening, delivery inspection.
- **MEAL.** Announcements: PDM results summary; feedback trends. Events: quarterly data review, data quality assessment visit.
- **Volunteers.** Announcements: repacking shifts open; first aid refresher. Events: weekend repacking, volunteer appreciation night.
- **Executive Office.** Announcements: board resolution on reserves policy. Events: Finance & Audit Committee, quarterly board meeting.

## 11. Access patterns and refused actions

**Controls to follow.**

- Documented internal controls and procurement procedures with conflict-of-interest standards [21].
- Separation of requester, approver, buyer and payer.
- Restricted funds reported apart from unrestricted funds [20].
- Beneficiary data on a need-to-know basis. Donors get aggregates, and auditors get beneficiary IDs rather than names wherever possible [30].
- Safeguarding complaints get victim-centred handling [28].

**Groups.**

| Group | Access |
|---|---|
| Programs | Write on Programs. Read on Donations, Funds and Budget Lines. No access to Feedback Cases. |
| MEAL | Manage on MEAL. Read on Programs. |
| Finance | Manage on Finance. Read on Grants and Procurement. |
| Procurement | Write on Procurement. No access to Disbursements. |
| Resource Mobilization | Write on its department. No access to Beneficiaries. |
| Accountability (Accountability Officer and ED only) | Feedback Cases. |
| Guests | External auditor: read on Finance and Procurement during fieldwork (Feb–Mar). Funder grant officer: read on Indicators and Indicator Results only. |

**OpenSlate gaps to state in the pack.** OpenSlate has no field-level or record-level access. So:

- A funder guest sees other funders' results.
- Safeguarding cases must live in a separate module to stay hidden.
- Self-approval (the same user creates and approves) cannot be blocked; the simulation shows separation only by who changes the status.

**Planned refusals:**

1. A Project Officer (Programs, read on Donations) edits a Donation Amount → refused, no write.
2. The Gift Processing Associate edits a Fund's Available balance → refused.
3. The Procurement Assistant sets a Disbursement to Released → module hidden (404).
4. A Community Facilitator opens Feedback Cases → hidden (404).
5. The funder guest edits an Indicator Result Actual → refused (guest is read-only).
6. The external auditor guest sets an Expense Line to Disallowed → refused.
7. The Volunteer Coordinator creates a Beneficiary → refused.
8. A Program Manager raises a Budget Line Approved amount → refused (Finance and Grants only). Donors usually must approve realignments.

## 12. Cadences and seasonality

- **Fiscal year.** Commonly January–December or July–June. US federal funders run October–September.
- **Donor reporting.** Quarterly or semiannual (financial reports no more often than quarterly [25]), plus annual work plans. Final reports are due within 120 days of the period end [24].
- **Year-end giving.** In 2025, 36.1% of revenue came in Q4 and about 18% in December [33]. Simulate donation bursts in late November and December, and an acknowledgement backlog in the first week of January.
- **Disasters.** About 20 tropical cyclones enter the Philippine area each year, and 8–9 cross land. July–October is the peak [36]. An emergency response raises Distributions, Beneficiaries, PRs and advances 3–5× for 6–10 weeks.
- **School year.** School calendars drive Education enrollment (regional).
- **Audit.** Fieldwork runs February–April.
- **Board.** Meets quarterly (my judgment). The average board has 4.1 standing committees [37].
- **Month-end.** Finance closes the books, and advance aging peaks.
- **Volunteer valuation.** For in-kind reporting, a US volunteer hour is valued at $36.14 (2025) [35].

## 13. Sources

1. https://iatistandard.org/en/iati-standard/203/codelists/activitystatus/ IATI activity status codes
2. https://iatistandard.org/en/iati-standard/203/codelists/transactiontype/ IATI transaction types (incoming funds, disbursement, expenditure, pledges)
3. https://iatistandard.org/en/iati-standard/203/activity-standard/iati-activities/iati-activity/result/ IATI result → indicator → baseline/target/actual
4. https://iatistandard.org/en/iati-standard/101/codelists/organisation_role/ IATI roles: Funding, Accountable, Extending, Implementing
5. https://www.oecd.org/en/topics/sub-issues/development-co-operation-evaluation-and-effectiveness/evaluation-criteria.html OECD DAC six evaluation criteria (2019)
6. https://eeas.europa.eu/archives/delegations/fiji/press_corner/all_news/news/2015/20150420_01_en.pdf EU logframe structure
7. https://docs.civicrm.org/user/en/latest/contributions/key-concepts-and-configurations/ CiviCRM contribution statuses and payment methods
8. https://docs.civicrm.org/user/en/latest/pledges/what-you-need-to-know/ CiviCRM pledges: Pending, In Progress, Overdue, installments
9. https://trailhead.salesforce.com/content/learn/modules/donation-management-basics-with-nonprofit-success-pack/create-or-edit-donations NPSP donation record types, campaign source
10. https://trailhead.salesforce.com/content/learn/modules/donation-management-basics-with-nonprofit-success-pack/acknowledge-a-donation NPSP acknowledgement statuses
11. https://trailhead.salesforce.com/content/learn/modules/opportunity-settings-in-nonprofit-success-pack/manage-recurring-donations-npsp NPSP recurring donation statuses (Active, Lapsed, Closed, pause)
12. https://trailhead.salesforce.com/content/learn/modules/nonprofit-cloud-fundraising-operations/create-and-manage-gift-commitments Nonprofit Cloud gift commitments; Canceled and Written Off
13. https://help.bloomerang.com/en/articles/12632727-add-or-edit-recurring-donation-payments Bloomerang Fund, Campaign and Appeal on payments
14. https://www.fluxx.io/blog/government-grant-distribution-workflow-compliance Fluxx workflow stages, pre-award to closeout
15. https://www.irs.gov/pub/irs-pdf/p1771.pdf IRS Pub 1771: $250 acknowledgement, $75 quid pro quo
16. https://www.canada.ca/en/revenue-agency/services/charities-giving/charities/operating-a-registered-charity/issuing-receipts/what-information-must-on-official-donation-receipt-a-registered-charity.html CRA receipt contents
17. https://www.gov.uk/claim-gift-aid HMRC Gift Aid basics
18. https://pcnc.com.ph/accreditation/ PCNC accreditation and BIR donee status
19. https://lawphil.net/executive/execord/eo2026/eo_117_2026.html EO 117 s.2026, DSWD sole accreditor (with https://www.pna.gov.ph/articles/1274921)
20. https://storage.fasb.org/ASU_2016-14.pdf FASB ASU 2016-14: net assets with or without donor restrictions
21. https://www.law.cornell.edu/cfr/text/2/200.318 2 CFR 200.318 procurement standards, conflict of interest
22. https://www.feldesman.com/procurement-rules-just-got-easier-for-grantees/ 2 CFR thresholds from 1 Oct 2025: $15k / $350k
23. https://www.federalregister.gov/documents/2025/08/27/2025-16412/federal-acquisition-regulation-inflation-adjustment-of-acquisition-related-thresholds FAR inflation rule
24. https://www.ecfr.gov/current/title-2/subtitle-A/chapter-II/part-200/subpart-D/subject-group-ECFR682eb6fbfabcde2/section-200.344 Closeout within 120 days (secondary summaries used)
25. https://www.ecfr.gov/current/title-2/subtitle-A/chapter-II/part-200/subpart-D/subject-group-ECFR36520e4111dce32/section-200.328 Financial reporting frequency
26. https://www.migrationpartnershipfacility.eu/storage/files/annex-iv-procurement-by-grant-beneficiaries.pdf EU-funded Annex IV example: thresholds, 3 quotes, no splitting
27. https://www.congress.gov/crs-product/IF10261 CRS: USAID functions moved to State, 1 Jul 2025
28. https://www.corehumanitarianstandard.org/the-standard CHS 2024 nine commitments; Commitment 5 on complaints
29. https://spherestandards.org/wp-content/uploads/Sphere-Handbook-2018-EN.pdf Sphere Handbook 2018
30. https://www.ifrc.org/sites/default/files/2021-11/CVA-Data-Protection-Guidance-final.pdf IFRC CVA data protection: minimization, donor sharing
31. https://www.unhcr.org/registration-guidance/chapter3/define-the-data-set/ UNHCR registration data set
32. https://humanitarian.atlassian.net/wiki/spaces/imtoolbox/pages/3190980609/KoBoToolbox OCHA IM Toolbox on KoBoToolbox
33. https://institute.blackbaud.com/resources/2025-trends-in-giving Blackbaud Institute 2025: Q4 36.1%, December about 18%
34. https://www.donorperfect.com/nonprofit-technology-blog/fundraising-software/afp-fep-q4-2025/ FEP 2025: retention 43.3%, donors −3.6%, dollars +5% (secondary summary of the AFP/FEP report)
35. https://independentsector.org/blog/2026-value-of-volunteer-time-release/ Volunteer hour value $36.14 (2025)
36. https://www.pagasa.dost.gov.ph/climate/tropical-cyclone-information PAGASA: about 20 cyclones/year, peak Jul–Oct
37. https://boardsource.org/resources/structuring-board-committees/ BoardSource: average 4.1 committees
38. https://adminmanual.upd.edu.ph/edition/active/chapter/2-5-3-3-liquidation-of-cash-advances Philippine public-sector liquidation rules (analog only)
